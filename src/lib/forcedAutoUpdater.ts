import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { updateStrings } from "../components/layout/updateStrings";
import { useUpdateAvailabilityStore } from "../stores/updateAvailabilityStore";
import { hasWindowRole } from "./windowContext";

export type UpdatePhase = "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "error" | "skipped";
export type UpdateSource = "manual" | "startup" | "interval" | "resume" | "online";

export interface UpdateStatusSnapshot {
  phase: UpdatePhase;
  message: string;
  source?: UpdateSource;
  version?: string;
  error?: unknown;
  updatedAt: number;
}

export interface UpdateCheckResult {
  phase: UpdatePhase;
  updateInstalled: boolean;
  version?: string;
  error?: unknown;
  skipped?: boolean;
}

interface RunUpdateCheckOptions {
  source?: UpdateSource;
  onStatus?: (status: UpdateStatusSnapshot) => void;
}

const MIN_AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1_000;
let currentStatus: UpdateStatusSnapshot = { phase: "idle", message: "", updatedAt: Date.now() };
let currentTask: Promise<UpdateCheckResult> | null = null;
let currentTaskSource: UpdateSource | null = null;
let installTask: Promise<UpdateCheckResult> | null = null;
let availableUpdate: Update | null = null;
const installedUpdates = new WeakSet<Update>();
let lastAutoCheckAt: number | null = null;
const statusListeners = new Set<(status: UpdateStatusSnapshot) => void>();

function setStatus(status: Omit<UpdateStatusSnapshot, "updatedAt">): void {
  currentStatus = { ...status, updatedAt: Date.now() };
  for (const listener of statusListeners) listener(currentStatus);
}

function skipped(source: UpdateSource, message: string): UpdateCheckResult {
  setStatus({ phase: "skipped", source, message });
  return { phase: "skipped", updateInstalled: false, skipped: true };
}

async function canUseUpdater(): Promise<boolean> {
  if (!hasWindowRole()) return false;
  try {
    const profile = await invoke<string | null>("get_test_profile");
    return profile === null && hasWindowRole();
  } catch {
    return false;
  }
}

function releaseUpdate(update: Update | null): void {
  if (update) void update.close().catch(() => {});
}

async function executeAvailabilityCheck(source: UpdateSource): Promise<UpdateCheckResult> {
  const automatic = source !== "manual";
  if (automatic && import.meta.env.DEV) return skipped(source, updateStrings.developmentSkipped);
  if (!await canUseUpdater()) return skipped(source, updateStrings.unavailable);
  const now = Date.now();
  const throttled = source === "online" || source === "resume";
  if (throttled && lastAutoCheckAt !== null && now - lastAutoCheckAt < MIN_AUTO_CHECK_INTERVAL_MS) {
    return skipped(source, updateStrings.recentlyChecked);
  }
  const previousAutoCheckAt = lastAutoCheckAt;
  if (automatic) lastAutoCheckAt = now;
  setStatus({ phase: "checking", source, message: updateStrings.checking });

  try {
    const update = await check();
    if (!hasWindowRole()) {
      releaseUpdate(update);
      return skipped(source, updateStrings.unavailable);
    }
    releaseUpdate(availableUpdate);
    availableUpdate = update;
    if (!update) {
      useUpdateAvailabilityStore.setState({ state: "none", version: "", currentVersion: "", message: "" });
      setStatus({ phase: "latest", source, message: updateStrings.latest });
      return { phase: "latest", updateInstalled: false };
    }
    const version = String(update.version);
    useUpdateAvailabilityStore.setState({
      state: "available", version, currentVersion: String(update.currentVersion), message: "",
    });
    setStatus({ phase: "available", source, version, message: "" });
    return { phase: "available", updateInstalled: false, version };
  } catch (error) {
    if (automatic) lastAutoCheckAt = previousAutoCheckAt;
    console.warn("[updater] Update check failed", error);
    // Automatic failures leave display data untouched and retry on schedule.
    setStatus({ phase: "error", source, message: updateStrings.checkError, error });
    return { phase: "error", updateInstalled: false, error };
  }
}

export async function checkForUpdateAvailability(options: RunUpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const source = options.source ?? "manual";
  if (installTask) return await installTask;
  if (source === "manual" && currentTask && currentTaskSource !== "manual") {
    // Manual checks always make their own unthrottled request after automatic work.
    if (currentStatus.phase === "checking") options.onStatus?.(currentStatus);
    await currentTask;
    if (installTask) return await installTask;
  }
  const listener = options.onStatus;
  if (listener) statusListeners.add(listener);
  try {
    if (!currentTask) {
      currentTaskSource = source;
      currentTask = executeAvailabilityCheck(source).finally(() => {
        currentTask = null;
        currentTaskSource = null;
      });
    } else if (listener && currentStatus.phase === "checking") {
      listener(currentStatus);
    }
    return await currentTask;
  } finally {
    if (listener) statusListeners.delete(listener);
  }
}

// Keep the existing settings entry point, now limited to discovery.
export function runUpdateCheck(options: RunUpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  return checkForUpdateAvailability(options);
}

export async function installAvailableUpdate(): Promise<UpdateCheckResult> {
  if (installTask) return await installTask;
  installTask = (async (): Promise<UpdateCheckResult> => {
    // An overlapping discovery must finish before its retained handle is used.
    await currentTask;
    const update = availableUpdate;
    if (!update || !await canUseUpdater()) return skipped("manual", updateStrings.unavailable);
    const version = String(update.version);
    useUpdateAvailabilityStore.setState({ state: "installing", message: "" });
    setStatus({ phase: "downloading", source: "manual", version, message: updateStrings.downloading(version) });
    try {
      if (!installedUpdates.has(update)) {
        await update.downloadAndInstall();
        installedUpdates.add(update);
      }
      setStatus({ phase: "ready", source: "manual", version, message: updateStrings.restarting(version) });
      await relaunch();
      return { phase: "ready", updateInstalled: true, version };
    } catch (error) {
      console.warn("[updater] Update installation or restart failed", error);
      useUpdateAvailabilityStore.setState({ state: "error", message: updateStrings.installError });
      setStatus({ phase: "error", source: "manual", version, message: updateStrings.installError, error });
      return { phase: "error", updateInstalled: false, version, error };
    }
  })().finally(() => { installTask = null; });
  return await installTask;
}

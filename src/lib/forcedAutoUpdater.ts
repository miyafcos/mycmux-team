import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export type UpdatePhase = "idle" | "checking" | "latest" | "downloading" | "ready" | "error" | "skipped";
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
  force?: boolean;
  onStatus?: (status: UpdateStatusSnapshot) => void;
}

const MIN_AUTO_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const AUTO_UPDATE_FAILURE_BACKOFF_MS = 2 * 60 * 1_000;

let currentStatus: UpdateStatusSnapshot = {
  phase: "idle",
  message: "",
  updatedAt: Date.now(),
};
let currentTask: Promise<UpdateCheckResult> | null = null;
let lastAutoCheckAt = 0;
let lastAutoFailureAt = 0;

const statusListeners = new Set<(status: UpdateStatusSnapshot) => void>();

function subscribeUpdateStatus(listener: (status: UpdateStatusSnapshot) => void): () => void {
  statusListeners.add(listener);
  listener(currentStatus);
  return () => statusListeners.delete(listener);
}

function setStatus(status: Omit<UpdateStatusSnapshot, "updatedAt">): void {
  currentStatus = {
    ...status,
    updatedAt: Date.now(),
  };
  for (const listener of statusListeners) {
    listener(currentStatus);
  }
}

function shouldSkipAutoCheck(now: number, force: boolean): boolean {
  if (force) return false;
  if (lastAutoCheckAt && now - lastAutoCheckAt < MIN_AUTO_CHECK_INTERVAL_MS) return true;
  if (lastAutoFailureAt && now - lastAutoFailureAt < AUTO_UPDATE_FAILURE_BACKOFF_MS) return true;
  return false;
}

function resultFromSkipped(source: UpdateSource, message: string): UpdateCheckResult {
  setStatus({ phase: "skipped", source, message });
  return { phase: "skipped", updateInstalled: false, skipped: true };
}

async function executeUpdateCheck(source: UpdateSource): Promise<UpdateCheckResult> {
  const automatic = source !== "manual";
  if (automatic) {
    lastAutoCheckAt = Date.now();
  }

  setStatus({ phase: "checking", source, message: "更新を確認中..." });

  try {
    const update = await check();
    if (!update) {
      setStatus({ phase: "latest", source, message: "最新版です" });
      return { phase: "latest", updateInstalled: false };
    }

    const version = String(update.version);
    setStatus({ phase: "downloading", source, version, message: `v${version} を取得・インストール中...` });
    await update.downloadAndInstall();
    setStatus({ phase: "ready", source, version, message: `v${version} をインストールしました。再起動します...` });
    await relaunch();
    return { phase: "ready", updateInstalled: true, version };
  } catch (error) {
    if (automatic) {
      lastAutoFailureAt = Date.now();
    }
    console.warn("[updater] Update check/install failed:", error);
    setStatus({ phase: "error", source, message: "更新に失敗しました", error });
    return { phase: "error", updateInstalled: false, error };
  }
}

export async function runUpdateCheck(options: RunUpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const source = options.source ?? "manual";
  const automatic = source !== "manual";
  const unsubscribe = options.onStatus ? subscribeUpdateStatus(options.onStatus) : undefined;

  try {
    if (currentTask) {
      return await currentTask;
    }

    if (automatic && import.meta.env.DEV) {
      return resultFromSkipped(source, "開発中のため自動更新をスキップしました");
    }

    const now = Date.now();
    if (automatic && shouldSkipAutoCheck(now, options.force === true)) {
      return resultFromSkipped(source, "直近で確認済みです");
    }

    currentTask = executeUpdateCheck(source).finally(() => {
      currentTask = null;
    });
    return await currentTask;
  } finally {
    unsubscribe?.();
  }
}

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LAUNCHABLE_AGENTS } from "../lib/agentCatalog";
import { hasUnresolvedAgentServices, type AgentServiceDetection } from "../lib/agentServiceVisibility";
import { isMainWindow } from "../lib/windowContext";
import { useSettingsStore } from "./settingsStore";

interface DetectionState {
  detection: AgentServiceDetection;
  refresh: () => Promise<void>;
}
let pending: { promise: Promise<void>; generation: number } | null = null;
let startupRequested = false;
let pathReadyGeneration = 0;
type DetectionReply = { status: "waiting-for-path" } | { status: "success"; installed: Record<string, boolean> };

export const useAgentServiceDetectionStore = create<DetectionState>((set) => ({
  detection: { status: "idle" },
  refresh: () => {
    if (pending) return pending.promise;
    set({ detection: { status: "detecting" } });
    pending = { generation: pathReadyGeneration, promise: Promise.resolve().then(() => invoke<DetectionReply>("detect_agent_services")).then((reply) => {
      if (reply?.status === "waiting-for-path") {
        set({ detection: { status: "waiting-for-path" } });
        return;
      }
      if (reply?.status !== "success" || !LAUNCHABLE_AGENTS.every(({ target }) => typeof reply.installed?.[target] === "boolean")) {
        throw new Error("incomplete agent service detection");
      }
      const detection = { status: "success" as const, installed: reply.installed };
      // Read the settings on completion: an operator may have toggled a row
      // while the file probe was pending.
      useSettingsStore.getState().initializeDetectedAgentServices(detection);
      set({ detection });
    }).catch(() => { set({ detection: { status: "failed" } }); }).finally(() => { pending = null; }) };
    return pending.promise;
  },
}));

export function detectAgentServicesOnStartup(): Promise<void> | undefined {
  if (startupRequested || !isMainWindow()) return;
  startupRequested = true;
  if (hasUnresolvedAgentServices(useSettingsStore.getState().agentServiceVisibility)) {
    const generation = pending?.generation ?? pathReadyGeneration;
    return useAgentServiceDetectionStore.getState().refresh().then(() => {
      if (useAgentServiceDetectionStore.getState().detection.status === "waiting-for-path") {
        startupRequested = false;
        // A shared probe retains its generation even if this caller starts after readiness.
        if (generation !== pathReadyGeneration) return detectAgentServicesOnStartup();
      }
    });
  }
}

/** Subscribe before probing so readiness cannot be lost between those two steps. */
export function startAgentServiceDetectionOnStartup(): () => void {
  if (!isMainWindow()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen("agent-service-path-ready", () => {
    pathReadyGeneration++;
    void detectAgentServicesOnStartup();
  }).then((remove) => {
    if (disposed) { remove(); return; }
    unlisten = remove;
    void detectAgentServicesOnStartup();
  }).catch(() => { if (!disposed) void detectAgentServicesOnStartup(); });
  return () => { disposed = true; unlisten?.(); };
}

import type { PaneMetadata } from "../stores/paneMetadataStore";
import type { DispatchEntry } from "./ipc";

export type EffectiveStatus = "waiting" | "working" | "idle";

const BACKEND_OUTPUT_ACTIVE_WINDOW_MS = 15_000;

const SHELL_LEAVES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "dash",
  "ksh",
]);

export function isShellProcess(processName?: string): boolean | undefined {
  if (!processName) return undefined;
  const leaf = processName.toLowerCase().replace(/\.exe$/, "");
  return SHELL_LEAVES.has(leaf);
}

export function deriveEffectiveStatus(meta?: PaneMetadata): EffectiveStatus {
  if (meta?.agentStatus === "waiting") return "waiting";
  if (meta?.processIsShell === false) return "working";
  return "idle";
}

export function deriveDisplayStatus(meta?: PaneMetadata): EffectiveStatus {
  if (meta?.agentStatus === "waiting") return "waiting";
  const backendOutputRecent = meta?.backendLastOutputAt !== undefined
    && Date.now() - meta.backendLastOutputAt <= BACKEND_OUTPUT_ACTIVE_WINDOW_MS;
  if (meta?.processIsShell === false
    && (meta.outputActive || meta.workingPatternVisible || backendOutputRecent)) {
    return "working";
  }
  return "idle";
}

const dispatchStateLabels: Record<DispatchEntry["liveState"], string> = {
  CLOSED: "終了済み",
  DONE: "完了",
  DONE_NEEDS_REVIEW: "完了・未確認",
  ASK: "判断待ち",
  NO_LOG: "ログ未作成",
  RUNNING: "実行中",
  RATE_LIMITED: "レート制限で待機中",
  STALL: "停止",
};

export function dispatchStateLabel(state: DispatchEntry["liveState"]): string {
  return dispatchStateLabels[state];
}

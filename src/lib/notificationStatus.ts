import type { PaneMetadata } from "../stores/paneMetadataStoreCompat";

export type EffectiveStatus = "waiting" | "working" | "idle";

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

import { LAUNCHABLE_AGENTS } from "./agentCatalog";

export type AgentServiceDetection =
  | { status: "idle" | "detecting" | "waiting-for-path" | "failed" }
  | { status: "success"; installed: Record<string, boolean> };

export function isAgentServiceVisible(
  target: string,
  saved: Record<string, boolean>,
  detection: AgentServiceDetection = { status: "idle" },
): boolean {
  if (Object.prototype.hasOwnProperty.call(saved, target)) return saved[target];
  if (target === "claude" || target === "codex") return true;
  return detection.status === "success" ? detection.installed[target] === true : true;
}

export function hasUnresolvedAgentServices(saved: Record<string, boolean>): boolean {
  return LAUNCHABLE_AGENTS.some(({ target }) => !Object.prototype.hasOwnProperty.call(saved, target));
}

/** A null result means no persistence, including a repeated successful probe. */
export function initializeAgentServiceVisibility(
  saved: Record<string, boolean>,
  detection: AgentServiceDetection,
  mainWindow: boolean,
): Record<string, boolean> | null {
  if (!mainWindow || detection.status !== "success" || !hasUnresolvedAgentServices(saved)) return null;
  const next = { ...saved };
  for (const { target } of LAUNCHABLE_AGENTS) {
    if (!Object.prototype.hasOwnProperty.call(saved, target)) {
      next[target] = isAgentServiceVisible(target, saved, detection);
    }
  }
  return next;
}

export function normalizeAgentServiceVisibility(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, visible]) => typeof visible === "boolean"));
}

/** AI-log copy keeps its historical order/names; recorded data is untouched. */
export function ailogServiceNames(visible: (target: string) => boolean, longNames = false): string[] {
  return [
    { target: "claude", short: "Claude", long: "Claude Code" },
    { target: "codex", short: "Codex", long: "Codex" },
    { target: "grok", short: "Grok", long: "Grok" },
  ].filter(({ target }) => visible(target)).map((name) => longNames ? name.long : name.short);
}

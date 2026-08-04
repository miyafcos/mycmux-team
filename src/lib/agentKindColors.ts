import type { AgentSessionKind } from "../types";

export interface AgentKindColor {
  fg: string;
  bg: string;
}

export const AGENT_KIND_ORDER = ["claude", "codex", "claude-codex"] as const satisfies readonly AgentSessionKind[];

export const KIND_COLORS: Record<AgentSessionKind, AgentKindColor> = {
  "claude": { fg: "#f0a878", bg: "rgba(255, 138, 61, 0.10)" },
  "codex": { fg: "#8ab8e8", bg: "rgba(94, 158, 255, 0.10)" },
  "claude-codex": { fg: "#7dcc97", bg: "rgba(74, 222, 128, 0.10)" },
};

export function agentKindColor(kind: string | undefined): AgentKindColor | undefined {
  if (kind === "claude" || kind === "codex" || kind === "claude-codex") {
    return KIND_COLORS[kind];
  }
  return undefined;
}

export function distinctAgentKinds(
  kinds: readonly (string | undefined)[],
): AgentSessionKind[] {
  return AGENT_KIND_ORDER.filter((kind) => kinds.includes(kind));
}

import type { AgentSessionKind } from "../types";
import type { DisplayAgentKind } from "./agentDisplayKind";

export interface AgentKindColor {
  fg: string;
  bg: string;
}

export const AGENT_KIND_ORDER = ["claude", "codex", "claude-codex", "grok"] as const satisfies readonly AgentSessionKind[];

export const KIND_COLORS: Record<DisplayAgentKind, AgentKindColor> = {
  "claude": { fg: "#f0a878", bg: "rgba(255, 138, 61, 0.10)" },
  "codex": { fg: "#8ab8e8", bg: "rgba(94, 158, 255, 0.10)" },
  "claude-codex": { fg: "#7dcc97", bg: "rgba(74, 222, 128, 0.10)" },
  "grok": { fg: "#f38ba8", bg: "rgba(243, 139, 168, 0.10)" },
  "antigravity": { fg: "#4285f4", bg: "rgba(66, 133, 244, 0.10)" },
};

export function agentKindColor(kind: string | null | undefined): AgentKindColor | undefined {
  if (kind === "claude" || kind === "codex" || kind === "claude-codex" || kind === "grok" || kind === "antigravity") {
    return KIND_COLORS[kind];
  }
  return undefined;
}

export function distinctAgentKinds(
  kinds: readonly (string | undefined)[],
): AgentSessionKind[] {
  return AGENT_KIND_ORDER.filter((kind) => kinds.includes(kind));
}

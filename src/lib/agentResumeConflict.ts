import type { Pane, PaneTab, Workspace } from "../types";

export interface AgentSessionAlreadyRunning {
  kind: string;
  agentSessionId: string;
  ownerSessionId: string;
}

export const AGENT_SESSION_ALREADY_RUNNING_PREFIX = "AGENT_SESSION_ALREADY_RUNNING:";
export const AGENT_SESSION_ALREADY_RUNNING_NOTICE = "\r\n\x1b[33m[この会話は別のペインで動いているため、ここでは起動しませんでした]\x1b[0m\r\n";

export function parseAgentSessionAlreadyRunning(error: unknown): AgentSessionAlreadyRunning | null {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : null;
  if (!message?.startsWith(AGENT_SESSION_ALREADY_RUNNING_PREFIX)) return null;
  try {
    const payload: unknown = JSON.parse(message.slice(AGENT_SESSION_ALREADY_RUNNING_PREFIX.length));
    if (!payload || typeof payload !== "object") return null;
    const { kind, agentSessionId, ownerSessionId } = payload as Record<string, unknown>;
    if (typeof kind !== "string" || !["claude", "codex", "grok", "claude-codex"].includes(kind.toLowerCase())
      || typeof agentSessionId !== "string" || !agentSessionId.trim()
      || typeof ownerSessionId !== "string" || !ownerSessionId.trim()) return null;
    return { kind, agentSessionId, ownerSessionId };
  } catch {
    return null;
  }
}

export function findAgentSessionOwner(
  workspaces: readonly Workspace[],
  ownerSessionId: string,
): { workspace: Workspace; pane: Pane; tab: PaneTab } | null {
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((candidate) => candidate.sessionId === ownerSessionId);
      if (tab) return { workspace, pane, tab };
    }
  }
  return null;
}

export function agentSessionAlreadyRunningNotice(hiddenOwnerSessionId?: string): string {
  if (!hiddenOwnerSessionId) return AGENT_SESSION_ALREADY_RUNNING_NOTICE;
  return AGENT_SESSION_ALREADY_RUNNING_NOTICE.replace("]\x1b[0m", ` (画面に無いセッション ${hiddenOwnerSessionId.slice(0, 8)} で動いています)]\x1b[0m`);
}

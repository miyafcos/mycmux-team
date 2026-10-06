export interface AgentRestoreChoice {
  kind: string;
  agentSessionId: string;
  candidates: string[];
}

export function parseAgentRestoreChoice(error: unknown): AgentRestoreChoice | null {
  const prefix = "AGENT_RESTORE_CHOICE_REQUIRED:";
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (!message.startsWith(prefix)) return null;
  try {
    const value = JSON.parse(message.slice(prefix.length));
    if (!value || !["claude", "claude-codex"].includes(value.kind)
      || typeof value.agentSessionId !== "string" || !value.agentSessionId.trim()
      || !Array.isArray(value.candidates) || !value.candidates.every((id: unknown) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))) return null;
    return { kind: value.kind, agentSessionId: value.agentSessionId, candidates: [...new Set<string>(value.candidates)] };
  } catch { return null; }
}

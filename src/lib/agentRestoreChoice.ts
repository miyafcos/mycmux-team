export interface AgentRestoreCandidate {
  agentSessionId: string;
  title: string;
  lastWrittenAt: number | null;
}

export interface AgentRestoreChoice {
  kind: string;
  agentSessionId: string;
  candidates: string[];
  candidateDetails?: AgentRestoreCandidate[];
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
    const candidates = [...new Set<string>(value.candidates)];
    const candidateDetails = Array.isArray(value.candidateDetails) ? value.candidateDetails.filter((item: unknown): item is AgentRestoreCandidate => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<AgentRestoreCandidate>;
      return typeof candidate.agentSessionId === "string" && candidates.includes(candidate.agentSessionId)
        && typeof candidate.title === "string" && candidate.title.trim().length > 0
        && (candidate.lastWrittenAt === null || (typeof candidate.lastWrittenAt === "number" && Number.isFinite(candidate.lastWrittenAt) && candidate.lastWrittenAt > 0));
    }) : undefined;
    return { kind: value.kind, agentSessionId: value.agentSessionId, candidates, ...(candidateDetails ? { candidateDetails } : {}) };
  } catch { return null; }
}

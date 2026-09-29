import { logicalSessionId, type LogicalSessionId } from "./logicalSessionId";

/**
 * A current, sendable dashboard tab. `logicalSessionId` is deliberately the
 * stable tab id here; `sessionId` remains a runtime identity and must match
 * again before writing anything to a PTY.
 */
export interface MentionCandidateInput {
  logicalSessionId: string;
  sessionId: string;
  label: string;
  workspaceName: string;
  statusLabel: string;
  isWorking: boolean;
}

export interface MentionCandidate {
  kind: "session";
  logicalSessionId: LogicalSessionId;
  sessionId: string;
  label: string;
  workspaceName: string;
  statusLabel: string;
  isWorking: boolean;
}

export interface WorkingAllMentionCandidate {
  kind: "working-all";
  label: string;
  statusLabel: string;
}

export type MentionMenuCandidate = MentionCandidate | WorkingAllMentionCandidate;

/** The stored node is the source of routing truth; visible text never is. */
export type MentionToken =
  | {
      kind: "session";
      logicalSessionId: LogicalSessionId;
      sessionId: string;
      labelSnapshot: string;
    }
  | {
      kind: "working-all";
      labelSnapshot: string;
    };

export interface MentionRecipient {
  logicalSessionId: LogicalSessionId;
  sessionId: string;
  label: string;
  workspaceName: string;
  statusLabel: string;
}

export interface MentionMissingTarget {
  token: MentionToken;
  reason: "missing" | "session-changed" | "no-working-sessions";
}

export interface MentionResolution {
  recipients: MentionRecipient[];
  missing: MentionMissingTarget[];
}

export const WORKING_ALL_LABEL = "動いてる全員";

/** Build a deterministic menu: all-working first, then workspace/tab order. */
export function buildMentionCandidates(inputs: readonly MentionCandidateInput[]): MentionMenuCandidate[] {
  const seen = new Set<string>();
  const sessions: MentionCandidate[] = [];
  for (const input of inputs) {
    if (!input.logicalSessionId || !input.sessionId || seen.has(input.logicalSessionId)) continue;
    seen.add(input.logicalSessionId);
    sessions.push({
      kind: "session",
      logicalSessionId: logicalSessionId(input.logicalSessionId),
      sessionId: input.sessionId,
      label: input.label,
      workspaceName: input.workspaceName,
      statusLabel: input.statusLabel,
      isWorking: input.isWorking,
    });
  }
  return [{ kind: "working-all", label: WORKING_ALL_LABEL, statusLabel: "作業中の全セッション" }, ...sessions];
}

/** Filter only the UI menu. It never decides the dispatch recipients. */
export function filterMentionCandidates(candidates: readonly MentionMenuCandidate[], query: string): MentionMenuCandidate[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...candidates];
  return candidates.filter((candidate) => {
    const searchable = candidate.kind === "working-all"
      ? `${candidate.label}\n${candidate.statusLabel}`
      : `${candidate.label}\n${candidate.workspaceName}\n${candidate.statusLabel}`;
    return searchable.toLocaleLowerCase().includes(normalized);
  });
}

export function mentionTokenFromCandidate(candidate: MentionMenuCandidate): MentionToken {
  return candidate.kind === "working-all"
    ? { kind: "working-all", labelSnapshot: candidate.label }
    : {
        kind: "session",
        logicalSessionId: candidate.logicalSessionId,
        sessionId: candidate.sessionId,
        labelSnapshot: candidate.label,
      };
}

/**
 * Resolve visible token labels from current state. A renamed tab follows its
 * label; an absent or replaced runtime session is explicitly invalid.
 */
export function describeMentionToken(token: MentionToken, candidates: readonly MentionMenuCandidate[]): {
  label: string;
  valid: boolean;
  statusLabel: string | null;
} {
  if (token.kind === "working-all") {
    const hasWorking = candidates.some((candidate) => candidate.kind === "session" && candidate.isWorking);
    return { label: token.labelSnapshot, valid: hasWorking, statusLabel: hasWorking ? "作業中の全セッション" : null };
  }
  const current = candidates.find((candidate): candidate is MentionCandidate => (
    candidate.kind === "session" && candidate.logicalSessionId === token.logicalSessionId
  ));
  if (!current || current.sessionId !== token.sessionId) {
    return { label: token.labelSnapshot, valid: false, statusLabel: null };
  }
  return { label: current.label, valid: true, statusLabel: current.statusLabel };
}

/**
 * Resolve structured nodes immediately before GO. Session id equality is
 * intentionally required: a deleted/replaced tab is never redirected.
 */
export function resolveMentionRecipients(tokens: readonly MentionToken[], candidates: readonly MentionMenuCandidate[]): MentionResolution {
  const recipientByLogicalId = new Map<LogicalSessionId, MentionRecipient>();
  const missing: MentionMissingTarget[] = [];
  const sessions = candidates.filter((candidate): candidate is MentionCandidate => candidate.kind === "session");

  for (const token of tokens) {
    if (token.kind === "working-all") {
      const working = sessions.filter((candidate) => candidate.isWorking);
      if (!working.length) {
        missing.push({ token, reason: "no-working-sessions" });
        continue;
      }
      for (const candidate of working) recipientByLogicalId.set(candidate.logicalSessionId, recipientFromCandidate(candidate));
      continue;
    }

    const current = sessions.find((candidate) => candidate.logicalSessionId === token.logicalSessionId);
    if (!current) {
      missing.push({ token, reason: "missing" });
    } else if (current.sessionId !== token.sessionId) {
      missing.push({ token, reason: "session-changed" });
    } else {
      recipientByLogicalId.set(current.logicalSessionId, recipientFromCandidate(current));
    }
  }

  return { recipients: [...recipientByLogicalId.values()], missing };
}

/** A GO seals its membership. Retries use this, never a fresh all-working scan. */
export function resolveSealedMentionRecipients(members: readonly MentionRecipient[], candidates: readonly MentionMenuCandidate[]): MentionResolution {
  const tokens: MentionToken[] = members.map((member) => ({
    kind: "session",
    logicalSessionId: member.logicalSessionId,
    sessionId: member.sessionId,
    labelSnapshot: member.label,
  }));
  return resolveMentionRecipients(tokens, candidates);
}

export function findMentionQuery(text: string, cursor: number): { start: number; end: number; query: string } | null {
  const end = Math.max(0, Math.min(cursor, text.length));
  const start = text.lastIndexOf("@", end - 1);
  if (start < 0) return null;
  const query = text.slice(start + 1, end);
  return /\s/.test(query) ? null : { start, end, query };
}

export function removeMentionQuery(text: string, range: { start: number; end: number }): { text: string; cursor: number } {
  return { text: `${text.slice(0, range.start)}${text.slice(range.end)}`, cursor: range.start };
}

export function mentionTokenKey(token: MentionToken): string {
  return token.kind === "working-all" ? "working-all" : `session:${token.logicalSessionId}:${token.sessionId}`;
}

function recipientFromCandidate(candidate: MentionCandidate): MentionRecipient {
  return {
    logicalSessionId: candidate.logicalSessionId,
    sessionId: candidate.sessionId,
    label: candidate.label,
    workspaceName: candidate.workspaceName,
    statusLabel: candidate.statusLabel,
  };
}

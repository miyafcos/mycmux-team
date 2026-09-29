import type { MentionCandidate, MentionToken } from "../../lib/mentionModel";

export type ContractRole = "material" | "work" | "integrator" | "review";

export interface ContractParticipant {
  logicalSessionId: string;
  label: string;
  role: ContractRole;
}

export interface ContractDraft {
  purpose: string;
  participants: ContractParticipant[];
  needsNewIntegrator: boolean;
  doneCondition: string[];
}

export interface WorkOrderPlan {
  goal: string;
  acceptanceCriteria: { id: string; description: string }[];
  bindings: {
    logicalSessionId: string;
    roles: ("source" | "worker" | "integrator" | "reviewer")[];
    labelSnapshot: string | null;
    snapshotEventId: string | null;
  }[];
  workItems: {
    id: string;
    objective: string;
    assignee: string | null;
    dependencies: string[];
    expectedArtifacts: { path: string; description: string }[];
    writeScope: { pathPrefix: string; worktree: string | null; branch: string | null }[];
    gates: { id: string; description: string }[];
    required: boolean;
    state: "pending";
  }[];
  budgets: {
    maxNewPty: number;
    maxWorkItems: number;
    maxReplans: number;
    maxPackets: number;
    maxRoundtripsPerEdge: number;
  };
}

export const DEFAULT_DONE_CONDITIONS = [
  "統合テストに合格する",
  "統合役が完了報告を返す",
  "未解決の衝突を0件にする",
] as const;

const integrationPattern = /\u307e\u3068\u3081\u308b|\u307e\u3068\u3081\u3066|\u7d71\u5408\u3059\u308b|\u7d71\u5408\u3057\u3066|\u6bd4\u8f03\u3059\u308b|\u6bd4\u8f03\u3057\u3066|\u6bd4\u8f03/;
const sameTestPattern = /\u540c\u3058[\s\S]*\u30c6\u30b9\u30c8[\s\S]*\u5b9f\u884c/;
const resultPattern = /\u6210\u679c/;
const newIntegratorId = "integrator-pending";

function sessionTokens(tokens: readonly MentionToken[]): Extract<MentionToken, { kind: "session" }>[] {
  return tokens.filter((token): token is Extract<MentionToken, { kind: "session" }> => token.kind === "session");
}

function participantsFor(tokens: readonly MentionToken[], candidates: readonly MentionCandidate[], role: ContractRole): ContractParticipant[] {
  return sessionTokens(tokens).flatMap((token) => {
    const candidate = candidates.find((entry) => entry.logicalSessionId === token.logicalSessionId);
    return candidate ? [{ logicalSessionId: String(candidate.logicalSessionId), label: candidate.label, role }] : [];
  });
}

export function shouldOfferContract(text: string, tokenCount: number): boolean {
  return tokenCount > 1 && integrationPattern.test(text);
}

export function buildContractDraft(
  text: string,
  tokens: MentionToken[],
  candidates: MentionCandidate[],
): ContractDraft {
  const participants = participantsFor(tokens, candidates, "material");
  const purpose = text.trim();
  const doneCondition = [...DEFAULT_DONE_CONDITIONS];
  if (sameTestPattern.test(text)) {
    return { purpose, participants: participants.map((participant) => ({ ...participant, role: "work" })), needsNewIntegrator: false, doneCondition };
  }
  if (resultPattern.test(text) && integrationPattern.test(text) && participants.length >= 2) {
    return {
      purpose,
      participants: participants.map((participant, index) => ({ ...participant, role: index === 1 ? "integrator" : "material" })),
      needsNewIntegrator: false,
      doneCondition,
    };
  }
  return { purpose, participants, needsNewIntegrator: true, doneCondition };
}

export function integratorProblem(draft: ContractDraft): "none" | "missing" | "multiple" {
  const count = draft.participants.filter((participant) => participant.role === "integrator").length
    + (draft.needsNewIntegrator ? 1 : 0);
  if (count === 0) return "missing";
  return count === 1 ? "none" : "multiple";
}

export function compileWorkOrderPlan(draft: ContractDraft, candidates: readonly MentionCandidate[]): WorkOrderPlan {
  const roleByContractRole: Record<ContractRole, "source" | "worker" | "integrator" | "reviewer"> = {
    material: "source",
    work: "worker",
    integrator: "integrator",
    review: "reviewer",
  };
  const bindings: WorkOrderPlan["bindings"] = draft.participants.flatMap((participant) => {
    const candidate = candidates.find((entry) => String(entry.logicalSessionId) === participant.logicalSessionId);
    return candidate ? [{
      logicalSessionId: candidate.sessionId,
      roles: [roleByContractRole[participant.role]],
      labelSnapshot: participant.label,
      snapshotEventId: null,
    }] : [];
  });
  if (draft.needsNewIntegrator) {
    bindings.push({
      logicalSessionId: newIntegratorId,
      roles: ["integrator"],
      labelSnapshot: null,
      snapshotEventId: null,
    });
  }
  return {
    goal: draft.purpose,
    acceptanceCriteria: draft.doneCondition.map((description, index) => ({ id: `completion-${index + 1}`, description })),
    bindings,
    workItems: [{
      id: "integration",
      objective: draft.purpose,
      assignee: null,
      dependencies: [],
      expectedArtifacts: [],
      writeScope: [],
      gates: [],
      required: true,
      state: "pending",
    }],
    budgets: {
      maxNewPty: 1,
      maxWorkItems: 1,
      maxReplans: 1,
      maxPackets: 1,
      maxRoundtripsPerEdge: 1,
    },
  };
}

import { create } from "zustand";
import type { DormancyPressureSample, DormancyStage } from "../lib/agentDormancy";

export const AGENT_DORMANCY_REVIEW_EVENT = "mycmux:agent-dormancy-review";
export interface AgentDormancyProposal {
  sessionId: string;
  resumeSessionId: string;
  agentKind: "claude" | "codex";
  label: string;
  workspaceName: string;
  lastActivityAt: number;
  processStatusAt: number | null;
  idleMinutes: number;
  stage: DormancyStage;
}
export interface AgentDormancyApproval extends AgentDormancyProposal { approvedAt: number }

export function matchesDormancyApproval(
  approval: AgentDormancyApproval | undefined,
  target: Pick<AgentDormancyProposal, "sessionId" | "resumeSessionId" | "agentKind" | "lastActivityAt" | "processStatusAt">,
  now: number,
): boolean {
  return Boolean(approval && now >= approval.approvedAt && now - approval.approvedAt <= 60_000
    && approval.sessionId === target.sessionId && approval.resumeSessionId === target.resumeSessionId
    && approval.agentKind === target.agentKind && approval.lastActivityAt === target.lastActivityAt
    && approval.processStatusAt === target.processStatusAt);
}

interface AgentDormancyState {
  sample: DormancyPressureSample;
  sampled: boolean;
  proposals: AgentDormancyProposal[];
  approvals: Record<string, AgentDormancyApproval>;
  setSample: (sample: DormancyPressureSample) => void;
  setProposals: (proposals: AgentDormancyProposal[]) => void;
  approve: (sessionId: string) => void;
  finishApprovals: (sessionIds: string[]) => void;
}

export const useAgentDormancyStore = create<AgentDormancyState>((set, get) => ({
  sample: { availableMemoryMiB: null, paneCount: 0 }, sampled: false,
  proposals: [], approvals: {},
  setSample: (sample) => set({ sample, sampled: true }),
  setProposals: (proposals) => set({ proposals }),
  approve: (sessionId) => {
    const proposal = get().proposals.find((entry) => entry.sessionId === sessionId);
    if (!proposal || get().approvals[sessionId]) return;
    set((state) => ({ approvals: { ...state.approvals, [sessionId]: { ...proposal, approvedAt: Date.now() } } }));
    window.dispatchEvent(new Event(AGENT_DORMANCY_REVIEW_EVENT));
  },
  finishApprovals: (sessionIds) => set((state) => ({
    approvals: Object.fromEntries(Object.entries(state.approvals).filter(([id]) => !sessionIds.includes(id))),
  })),
}));

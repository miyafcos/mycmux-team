import { create } from "zustand";

import type { ContractDraft, ContractRole } from "../components/dashboard/workOrderModel";
import type { WorkOrderPreview } from "../lib/workOrderCommands";

export type WorkOrderContractPhase = "preparing" | "refreshing" | "ready" | "running" | "error";

export interface WorkOrderContractState {
  sourceSignature: string;
  previewKey: string;
  requestRevision: number;
  draft: ContractDraft;
  manualRoles: Partial<Record<string, ContractRole>>;
  workOrderId: string | null;
  preview: WorkOrderPreview | null;
  phase: WorkOrderContractPhase;
  error: string | null;
  notice: string | null;
}

interface WorkOrderStore {
  contractDraftBySession: Record<string, WorkOrderContractState | undefined>;
  dismissedSignatureBySession: Record<string, string | undefined>;
  setContract: (sessionId: string, state: WorkOrderContractState) => void;
  updateContract: (sessionId: string, update: (current: WorkOrderContractState) => WorkOrderContractState) => void;
  dismissContract: (sessionId: string, sourceSignature: string) => void;
  clearContract: (sessionId: string) => void;
}

export const useWorkOrderStore = create<WorkOrderStore>((set) => ({
  contractDraftBySession: {},
  dismissedSignatureBySession: {},
  setContract: (sessionId, state) => set((current) => ({
    contractDraftBySession: { ...current.contractDraftBySession, [sessionId]: state },
  })),
  updateContract: (sessionId, update) => set((current) => {
    const existing = current.contractDraftBySession[sessionId];
    if (!existing) return current;
    return { contractDraftBySession: { ...current.contractDraftBySession, [sessionId]: update(existing) } };
  }),
  dismissContract: (sessionId, sourceSignature) => set((current) => ({
    dismissedSignatureBySession: { ...current.dismissedSignatureBySession, [sessionId]: sourceSignature },
  })),
  clearContract: (sessionId) => set((current) => {
    const { [sessionId]: _removed, ...remaining } = current.contractDraftBySession;
    return { contractDraftBySession: remaining };
  }),
}));

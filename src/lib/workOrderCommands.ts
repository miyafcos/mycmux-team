import { invoke } from "@tauri-apps/api/core";

import type { WorkOrderPlan } from "../components/dashboard/workOrderModel";

export interface WorkOrderIdResponse {
  workOrderId: string;
}

export interface WorkOrderCoverage {
  target: number;
  acquired: number;
  missing: number;
  failed: number;
}

export interface WorkOrderSourceDigest {
  logicalSessionId: string;
  label: string | null;
  snapshotEventId: string | null;
  currentTask: string | null;
  latestInstruction: string | null;
  activity: string | null;
  openQuestions: string[];
  acquired: boolean;
  failureReason: string | null;
}

export interface WorkOrderPreview {
  plan: WorkOrderPlan;
  coverage: WorkOrderCoverage;
  outbox: {
    workItemId: string;
    intentKind: "spawn" | "send";
    status: "pending" | "in_flight" | "delivered" | "failed";
    reason: string | null;
  }[];
  sources: WorkOrderSourceDigest[];
  integratorPrompt: string;
  writeTarget: { branch: string; path: string } | { unavailable: string } | null;
}

export interface WorkOrderGoResponse {
  sealed: "sealed" | "alreadySealed";
  spawnRequestId: string | null;
  coverage: WorkOrderCoverage;
}

export interface WorkOrderCancelResponse {
  deletedDraft: boolean;
  stopTargets: string[];
}

export interface WorkOrderRetrySpawnResponse {
  spawnRequestId: string;
}

export function workorderCreateDraft(plan: WorkOrderPlan): Promise<WorkOrderIdResponse> {
  return invoke<WorkOrderIdResponse>("workorder_create_draft", { plan });
}

export function workorderRefreshSources(id: string): Promise<{ coverage: WorkOrderCoverage; sources: WorkOrderSourceDigest[] }> {
  return invoke("workorder_refresh_sources", { id });
}

export function workorderPreview(id: string, cwd: string | null): Promise<WorkOrderPreview> {
  return invoke<WorkOrderPreview>("workorder_preview", { id, cwd });
}

export function workorderGo(
  id: string,
  options: { cwd: string; agentKind: string; overrideMissingSources: boolean },
): Promise<WorkOrderGoResponse> {
  return invoke<WorkOrderGoResponse>("workorder_go", { id, options });
}

export function workorderCancel(id: string): Promise<WorkOrderCancelResponse> {
  return invoke<WorkOrderCancelResponse>("workorder_cancel", { id });
}

export function workorderRetrySpawn(id: string): Promise<WorkOrderRetrySpawnResponse> {
  return invoke<WorkOrderRetrySpawnResponse>("workorder_retry_spawn", { workOrderId: id });
}

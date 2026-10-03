import { invoke } from "@tauri-apps/api/core";

export type CapabilityLevel = "enforced" | "requestedOnly" | "unsupported" | "unverified";
export type AdapterOperation = "start" | "resume" | "fork" | "send" | "steer" | "interrupt" | "readEvents" | "usage";
export interface ConfigurationObservation {
  requested: Record<string, unknown> | null;
  effective: Record<string, unknown> | null;
  source: string | null;
  observed: boolean;
}
export interface AdapterCapabilities {
  version: 1;
  agent: string;
  mode: string;
  enabled: boolean;
  executableVersion: string | null;
  testedExecutableVersion: string | null;
  requiredExecutableVersion: string | null;
  testedScope: string[];
  operations: Record<AdapterOperation, { level: CapabilityLevel; scope: string }>;
  configuration: ConfigurationObservation;
  sources: string[];
}
export interface CapabilitySnapshot { version: 1; adapters: AdapterCapabilities[] }
export interface DeliveryReceipt {
  operationId: string;
  requestId: string;
  turnId: string | null;
  submittedAtMs: number;
  acceptedAtMs: number | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  status: string;
}
export interface ExperimentSnapshot {
  version: 1;
  enabled: boolean;
  connectionId: string | null;
  cliVersion: string | null;
  processState: string;
  agentState: string;
  threadId: string | null;
  configuration: ConfigurationObservation;
  delivery: DeliveryReceipt | null;
  reply: string;
  replyTruncated: boolean;
  events: Array<{ sequence: number; atMs: number; method: string; source: string;
    operationId: string | null; threadId: string | null; turnId: string | null }>;
  usage: { tokenUsage: unknown | null; chatgptAllowance: unknown | null;
    apiStandardEstimateUsd: number | null; extraCostUsd: number | null };
  error: string | null;
}
export interface ExperimentCommand {
  operation: "send" | "steer" | "interrupt" | "resume" | "fork";
  operationId: string;
  expectedTurnId?: string;
  text?: string;
}
export interface ExperimentActionResult {
  duplicate: boolean;
  delivery?: DeliveryReceipt;
  control?: { operationId: string; requestId: string; method: string; turnId: string;
    status: string; accepted: boolean; observed: boolean; error: string | null };
  error?: string;
}

export const getAgentAdapterCapabilities = () => invoke<CapabilitySnapshot>("agent_adapter_capabilities");
export const setCodexExperimentEnabled = (enabled: boolean) => invoke<ExperimentSnapshot>("codex_app_server_set_enabled", { enabled });
export const startCodexExperiment = (cwd: string, executable?: string) =>
  invoke<ExperimentSnapshot>("codex_app_server_start", { cwd, executable: executable?.trim() || null });
export const codexExperimentCommand = (request: ExperimentCommand) =>
  invoke<ExperimentActionResult>("codex_app_server_command", { request });
export const getCodexExperimentStatus = () => invoke<ExperimentSnapshot>("codex_app_server_status");
export const closeCodexExperiment = () => invoke<ExperimentSnapshot>("codex_app_server_close");

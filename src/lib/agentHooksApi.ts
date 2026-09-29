import { invoke } from "@tauri-apps/api/core";

export type HookProvider = "claude" | "codex" | "grok";
export type RepairReason = "duplicate" | "missing" | "helper-path" | "untrusted" | "unknown-shape";
export type HookInstallState =
  | { state: "installed" | "disabled" | "unavailable" }
  | { state: "needs-repair"; reason: RepairReason };
export type ProviderHookStatus = { provider: HookProvider; enabled: boolean } & HookInstallState;
export interface AgentHooksStatus { version: 2; providers: ProviderHookStatus[] }

export const agentHooksStatus = () => invoke<AgentHooksStatus>("agent_hooks_status");
export const agentHooksSet = (provider: HookProvider, enabled: boolean) =>
  invoke<AgentHooksStatus>("agent_hooks_set", { provider, enabled });

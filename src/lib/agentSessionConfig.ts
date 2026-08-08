import type { AgentSessionKind } from "../types";

/**
 * Agent-session fields as they appear in persisted pane/tab config. Panes and
 * tabs carry the same trio, so both are read through these helpers.
 */
export interface AgentSessionConfigFields {
  agent_kind?: AgentSessionKind | null;
  agent_session_id?: string | null;
  claude_session_id?: string | null;
}

/**
 * The kind the saved config states outright — `agent_kind`, or "claude" implied
 * by a legacy `claude_session_id`. Returns null when nothing is declared; call
 * sites that also want to guess from `agent_id` fall back after this.
 */
export function declaredAgentKind(config: AgentSessionConfigFields): AgentSessionKind | null {
  return config.agent_kind ?? (config.claude_session_id ? "claude" : null);
}

/** The saved agent session id, preferring the modern field over the legacy one. */
export function declaredAgentSessionId(config: AgentSessionConfigFields): string | null {
  return config.agent_session_id ?? config.claude_session_id ?? null;
}

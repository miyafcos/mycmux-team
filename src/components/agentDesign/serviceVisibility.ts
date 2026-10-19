import { useCallback, useMemo } from "react";
import { useAgentServiceVisibility } from "../../hooks/useAgentServiceVisibility";
import type { AgentServiceId } from "../../lib/agentDesignApi";

/** The only adapter between agent-design ids and launcher catalog targets. */
export const AGENT_DESIGN_TARGETS = {
  claude: "claude",
  codex: "codex",
  hermes: "hermes",
} as const satisfies Record<AgentServiceId, string>;

export function useAgentDesignServiceVisibility() {
  const visible = useAgentServiceVisibility();
  return useCallback((id: string) => Object.prototype.hasOwnProperty.call(AGENT_DESIGN_TARGETS, id)
    && visible(AGENT_DESIGN_TARGETS[id as AgentServiceId]), [visible]);
}

export function useVisibleAgentDesignServices(): AgentServiceId[] {
  const visible = useAgentDesignServiceVisibility();
  return useMemo(() => (Object.keys(AGENT_DESIGN_TARGETS) as AgentServiceId[]).filter(visible), [visible]);
}

import type { AgentSessionKind, Pane, PaneTab } from "../types";

export function buildTerminalPaneLaunchEnv(
  pane: Pick<Pane, "launchEnv">,
  activeTab: PaneTab | undefined,
  launchThroughLauncher: boolean,
  savedAgentSession: { kind: AgentSessionKind; sessionId: string } | null,
): Record<string, string> | undefined {
  if (!activeTab) return undefined;
  const env: Record<string, string> = {
    ...(activeTab.launchEnv ?? pane.launchEnv ?? {}),
    MYCMUX_PANE_SESSION_ID: activeTab.sessionId,
    MYCMUX_TAB_ID: activeTab.id,
  };
  if (launchThroughLauncher || activeTab.agentId === "shell-starter") {
    env.__CMUX_LAUNCHER_DONE = "1";
  }
  if (savedAgentSession && !env.MYCMUX_HANDOFF) {
    env.MYCMUX_AGENT_KIND = savedAgentSession.kind;
    env.MYCMUX_SESSION_ID = savedAgentSession.sessionId;
    env.MYCMUX_RESUME = savedAgentSession.kind;
  } else if (activeTab.agentId === "claude-code") {
    env.MYCMUX_AGENT_KIND = "claude";
  }
  return env;
}

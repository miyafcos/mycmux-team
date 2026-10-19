import type { AgentDefinition, AgentSessionKind, Pane, PaneTab } from "../types";
import { requiresLauncherDispatch } from "./launcherDispatch";
import { buildLaunchArgs } from "./terminalLaunchArgs";
import { buildTerminalPaneLaunchEnv } from "./terminalPaneLaunchEnv";

interface TerminalPaneAgents {
  getAgent(id: string): AgentDefinition | undefined;
  getDefaultAgent(integratedShell?: boolean): AgentDefinition;
}

function resolveSavedAgentSession(tab: PaneTab): { kind: AgentSessionKind; sessionId: string } | null {
  if (tab.agentKind && tab.agentSessionId) {
    return { kind: tab.agentKind, sessionId: tab.agentSessionId };
  }
  if (tab.claudeSessionId) {
    return { kind: "claude", sessionId: tab.claudeSessionId };
  }
  return null;
}

/** UI mounts and explicit restored-tab starts share one side-effect-free launch plan. */
export function buildTerminalPaneLaunch(
  pane: Pick<Pane, "cwd" | "launchEnv">,
  activeTab: PaneTab | undefined,
  agents: TerminalPaneAgents,
) {
  const paneCwd = activeTab?.cwd ?? pane.cwd;
  const resolvedAgentId = activeTab?.agentId;
  const shellOnly = (activeTab?.launchEnv ?? pane.launchEnv)?.MYCMUX_LAUNCH_TARGET === "shell";
  const savedAgentSession = activeTab && !shellOnly ? resolveSavedAgentSession(activeTab) : null;
  const launchThroughLauncher = Boolean(
    activeTab
    && !activeTab.commandArgv?.length
    && (requiresLauncherDispatch(activeTab.launchEnv ?? pane.launchEnv)
      || (resolvedAgentId === "shell" && (savedAgentSession?.kind === "codex" || activeTab.codexRestoreReason))),
  );
  const agent = resolvedAgentId
    ? (launchThroughLauncher ? agents.getDefaultAgent(shellOnly) : agents.getAgent(resolvedAgentId) ?? agents.getDefaultAgent())
    : null;
  const launchCommand = activeTab?.commandArgv?.[0] ?? agent?.command ?? "";
  const launchArgs = activeTab?.commandArgv?.length
    ? activeTab.commandArgv.slice(1)
    : shellOnly && agent
    ? agent.args
    : agent
    ? buildLaunchArgs(
        agent.command,
        agent.args,
        resolvedAgentId,
        savedAgentSession,
        activeTab?.id,
        activeTab?.cwd ?? paneCwd,
        activeTab?.initialPrompt,
      )
    : [];
  const launchEnv = buildTerminalPaneLaunchEnv(pane, activeTab, launchThroughLauncher, savedAgentSession);
  return { paneCwd, resolvedAgentId, agent, savedAgentSession, launchCommand, launchArgs, launchEnv,
    ...(!shellOnly && activeTab?.codexRestoreReason ? { restoreReason: activeTab.codexRestoreReason } : {}) };
}

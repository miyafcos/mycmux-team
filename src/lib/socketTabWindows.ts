import type { PtyMetadataSnapshot, WindowFragment, WorkspaceConfig } from "./ipc";
import { windowLabel } from "./windowContext";
import { resolveTabMark, tabMarkSource } from "./tabMark";
import { listenForPeerSocketCommandEvent, requestPeerSocketCommand } from "./socketCommandWindows";
import { webPaneCommandContext } from "../components/workspace/webPaneCommandQueue";

const START_TAB_EVENTS = { request: "mycmux://socket-start-tab", response: "mycmux://socket-start-tab-result" };

export interface TabStartResult {
  started: boolean;
  reason?: "already_running";
  sessionId: string;
}

/** A live local workspace wins over a window's older published fragment. */
export function otherWindowWorkspaces(
  fragments: readonly WindowFragment[], ownWorkspaceIds: ReadonlySet<string>, ownLabel = windowLabel(),
): Array<{ windowLabel: string; workspace: WorkspaceConfig }> {
  const seen = new Set(ownWorkspaceIds);
  const result: Array<{ windowLabel: string; workspace: WorkspaceConfig }> = [];
  for (const fragment of fragments) {
    if (fragment.window_label === ownLabel && !fragment.pending) continue;
    for (const workspace of fragment.workspaces) {
      if (seen.has(workspace.id)) continue;
      seen.add(workspace.id);
      result.push({ windowLabel: fragment.window_label, workspace });
    }
  }
  return result;
}

/** Only publish identities and fields actually supplied by the owning window. */
export function serializeOtherWindowPanes(entries: ReturnType<typeof otherWindowWorkspaces>, processes: PtyMetadataSnapshot = {}) {
  return entries.flatMap(({ windowLabel, workspace }) => workspace.panes.map((pane) => ({
    windowLabel, workspaceId: workspace.id, workspaceName: workspace.name,
    id: pane.pane_id ?? undefined, label: pane.label ?? undefined,
    cwd: pane.cwd ?? undefined, agentId: pane.agent_id,
    agentKind: pane.agent_kind ?? undefined, activeTabId: pane.active_tab_id ?? undefined,
    tabs: (pane.tabs ?? []).filter((tab) => Boolean(tab.session_id)).map((tab) => {
      const process = processes[tab.session_id!];
      const ptyAlive = process !== undefined;
      const markTab = {
        type: tab.type ?? undefined, presetId: tab.preset_id ?? undefined,
        agentKind: tab.agent_kind ?? undefined,
        sourceKind: tab.source_kind ?? undefined, sourcePath: tab.source_path ?? undefined,
      };
      const mark = resolveTabMark(markTab, process?.live_agent_kind, ptyAlive);
      return {
      id: tab.tab_id ?? undefined, sessionId: tab.session_id!, type: tab.type ?? undefined,
      label: tab.label ?? undefined, cwd: tab.cwd ?? undefined, agentId: tab.agent_id,
      agentKind: tab.agent_kind ?? undefined, agentSessionId: tab.agent_session_id ?? undefined,
      displayKind: mark?.kind ?? null,
      liveAgentKind: ptyAlive ? process?.live_agent_kind ?? null : null,
      markSource: tabMarkSource(markTab, ptyAlive),
      claudeSessionId: tab.claude_session_id ?? undefined, lifecycle: tab.lifecycle ?? undefined,
    }; }),
  })));
}

/** Forward only this explicit start command; the owner builds from its live tab. */
export async function requestPeerTabStart(
  targetWindow: string, sessionId: string, context = webPaneCommandContext("pane.start_tab"),
): Promise<TabStartResult> {
  const result = await requestPeerSocketCommand(targetWindow, "pane.start_tab", { sessionId }, context, { events: START_TAB_EVENTS }) as TabStartResult;
  if (result?.sessionId !== sessionId || typeof result.started !== "boolean") {
    throw new Error("pane.start_tab returned an invalid owner-window response");
  }
  return result;
}

export async function listenForPeerTabStarts(
  start: (sessionId: string) => Promise<TabStartResult>, ready: () => Promise<void> = async () => {},
) {
  return listenForPeerSocketCommandEvent(request => request.cmd === "pane.start_tab"
    && typeof request.args?.sessionId === "string" && Boolean(request.args.sessionId),
  request => start(request.args!.sessionId as string), ready, START_TAB_EVENTS);
}

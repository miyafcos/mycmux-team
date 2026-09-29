/**
 * The destructive half of closing a workspace, shared by the GUI gesture
 * (AppShell, after confirmPaneClose) and the socket command (workspace.close,
 * which has no dialog and refuses the active workspace instead).
 *
 * Reads the workspace fresh from the store: panes can be added while a caller
 * awaits its confirmation, and a stale snapshot would skip their session kill
 * while still removing the workspace.
 */
export interface WorkspaceCloseResult {
  closed: boolean;
  name: string | null;
  paneCount: number;
  tabCount: number;
  killedSessionIds: string[];
  undoRecorded: number;
}

export async function closeWorkspaceAfterConfirmation(
  workspaceId: string,
): Promise<WorkspaceCloseResult> {
  const [stores, { pushClosedWorkspace }, { evictTerminalCache }, ipc, { tabHasPty }] = await Promise.all([
    import("../stores/workspaceStore"),
    import("../stores/closedPaneStore"),
    import("../components/terminal/XTermWrapper"),
    import("./ipc"),
    import("./tabLifecycle"),
  ]);
  const { useWorkspaceListStore, useUiStore, usePaneMetadataStore } = stores;
  const { killSession, removeWorkspaceScrollback } = ipc;
  const listState = useWorkspaceListStore.getState();
  const ws = listState.getWorkspace(workspaceId);
  if (!ws) {
    return { closed: false, name: null, paneCount: 0, tabCount: 0, killedSessionIds: [], undoRecorded: 0 };
  }
  // Record the workspace's tabs before their sessions die so
  // Ctrl+Shift+T can undo the close. Bounded by
  // CLOSED_WORKSPACE_BULK_LIMIT (half the history) — one gesture must not
  // flush every individually-closed pane. The focused session ranks
  // first so the most recently used tab comes back first.
  const focusedSessionId = listState.activeWorkspaceId === workspaceId
    ? useUiStore.getState().activePaneId
    : listState.lastActivePaneByWorkspace[workspaceId] ?? null;
  const undoRecorded = pushClosedWorkspace(ws, focusedSessionId);
  const killedSessionIds: string[] = [];
  for (const pane of ws.panes) {
    for (const tab of pane.tabs) {
      if (!tabHasPty(tab)) continue;
      evictTerminalCache(tab.sessionId);
      killSession(tab.sessionId).catch((err) =>
        console.warn("[mycmux] killSession failed", tab.sessionId, err),
      );
      usePaneMetadataStore.getState().removeMetadata(tab.sessionId);
      killedSessionIds.push(tab.sessionId);
    }
  }
  await removeWorkspaceScrollback(workspaceId, killedSessionIds).catch((err) =>
    console.warn("[mycmux] removeWorkspaceScrollback failed", workspaceId, err),
  );
  useWorkspaceListStore.getState().removeWorkspace(workspaceId);
  return {
    closed: true,
    name: ws.name,
    paneCount: ws.panes.length,
    tabCount: ws.panes.reduce((count, pane) => count + pane.tabs.length, 0),
    killedSessionIds,
    undoRecorded,
  };
}

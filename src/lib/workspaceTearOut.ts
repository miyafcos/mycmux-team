import { openWorkspaceWindow } from "./ipc";
import { windowLabel } from "./windowContext";
import { focusController } from "./focusController";
import { usePaneMetadataStore, useWorkspaceListStore } from "../stores/workspaceStore";
import { evictTerminalCache } from "../components/terminal/terminalCache";
import { toConfig } from "../components/layout/SocketListener";
import type { Workspace } from "../types";

/**
 * Tear-out (Phase 3b): move a workspace into a brand new OS window.
 *
 * The whole point is that the PTY sessions survive, so this path must **not**
 * go through `AppShell`'s close-workspace handler — that one calls
 * `killSession` for every tab. A move is detach + reattach:
 *
 * 1. serialize the workspace exactly the way persistence would,
 * 2. hand it to the new window (Rust queues it as a pending adoption),
 * 3. drop it from this window's stores, evicting the cached terminals and
 *    clearing focus bookkeeping so nothing keeps writing into a session this
 *    window no longer owns,
 * 4. the new window mounts it, `create_session` sees a live session and takes
 *    the reattach branch (`pty/manager.rs`) — no respawn, no lost scrollback.
 */
export function sessionIdsInWorkspace(workspace: Workspace): string[] {
  const sessionIds = new Set<string>();
  for (const pane of workspace.panes) {
    sessionIds.add(pane.sessionId);
    for (const tab of pane.tabs) {
      sessionIds.add(tab.sessionId);
    }
  }
  return Array.from(sessionIds);
}

/** Screen position for the new window, offset so it does not land exactly on top. */
export interface TearOutPlacement {
  x?: number;
  y?: number;
}

export async function tearOutWorkspaceToNewWindow(
  workspaceId: string,
  placement: TearOutPlacement = {},
): Promise<string | null> {
  const listStore = useWorkspaceListStore.getState();
  const workspace = listStore.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return null;

  const config = toConfig(workspace);
  if (config.panes.length === 0) return null;

  const label = await openWorkspaceWindow({
    fromLabel: windowLabel(),
    workspaces: [config],
    x: placement.x,
    y: placement.y,
  });

  // Only now does it leave this window: if opening the window failed, the
  // workspace (and its sessions) stay exactly where they were.
  for (const sessionId of sessionIdsInWorkspace(workspace)) {
    evictTerminalCache(sessionId);
    focusController.clearSession(sessionId);
    // The new window owns these sessions now. Leaving their metadata behind
    // keeps counting their notifications in a window that can no longer show
    // them — the bell lights up over a panel that lists nothing.
    usePaneMetadataStore.getState().removeMetadata(sessionId);
  }
  useWorkspaceListStore.getState().removeWorkspace(workspaceId);

  return label;
}

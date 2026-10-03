import { v4 as uuid } from "uuid";
import type { WindowFragment, WorkspaceConfig } from "./ipc";
import { windowLabel } from "./windowContext";

const START_TAB_EVENT = "mycmux://socket-start-tab";
const START_TAB_RESULT_EVENT = "mycmux://socket-start-tab-result";
const PEER_START_TIMEOUT_MS = 20_000;

export interface TabStartResult {
  started: boolean;
  reason?: "already_running";
  sessionId: string;
}
interface PeerStartRequest { requestId: string; sessionId: string; replyWindow: string }
interface PeerStartResponse { requestId: string; result?: TabStartResult; error?: string }

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
export function serializeOtherWindowPanes(entries: ReturnType<typeof otherWindowWorkspaces>) {
  return entries.flatMap(({ windowLabel, workspace }) => workspace.panes.map((pane) => ({
    windowLabel, workspaceId: workspace.id, workspaceName: workspace.name,
    id: pane.pane_id ?? undefined, label: pane.label ?? undefined,
    cwd: pane.cwd ?? undefined, agentId: pane.agent_id,
    agentKind: pane.agent_kind ?? undefined, activeTabId: pane.active_tab_id ?? undefined,
    tabs: (pane.tabs ?? []).filter((tab) => Boolean(tab.session_id)).map((tab) => ({
      id: tab.tab_id ?? undefined, sessionId: tab.session_id!, type: tab.type ?? undefined,
      label: tab.label ?? undefined, cwd: tab.cwd ?? undefined, agentId: tab.agent_id,
      agentKind: tab.agent_kind ?? undefined, agentSessionId: tab.agent_session_id ?? undefined,
      claudeSessionId: tab.claude_session_id ?? undefined, lifecycle: tab.lifecycle ?? undefined,
    })),
  })));
}

/** Forward only this explicit start command; the owner builds from its live tab. */
export async function requestPeerTabStart(targetWindow: string, sessionId: string): Promise<TabStartResult> {
  const { emitTo, listen } = await import("@tauri-apps/api/event");
  const requestId = uuid();
  let resolve!: (result: TabStartResult) => void;
  let reject!: (error: unknown) => void;
  const response = new Promise<TabStartResult>((done, fail) => { resolve = done; reject = fail; });
  const unlisten = await listen<PeerStartResponse>(START_TAB_RESULT_EVENT, ({ payload }) => {
    if (payload.requestId !== requestId) return;
    if (payload.error !== undefined) reject(payload.error);
    else if (payload.result?.sessionId === sessionId && typeof payload.result.started === "boolean") {
      resolve(payload.result);
    } else reject(new Error("pane.start_tab returned an invalid owner-window response"));
  });
  const timer = setTimeout(() => reject(new Error("pane.start_tab owner window did not respond")), PEER_START_TIMEOUT_MS);
  try {
    const [, result] = await Promise.all([
      emitTo(targetWindow, START_TAB_EVENT, { requestId, sessionId, replyWindow: windowLabel() } satisfies PeerStartRequest),
      response,
    ]);
    return result;
  } finally {
    clearTimeout(timer);
    unlisten();
  }
}

export async function listenForPeerTabStarts(start: (sessionId: string) => Promise<TabStartResult>) {
  const events = await import("@tauri-apps/api/event");
  return events.listen<PeerStartRequest>(START_TAB_EVENT, async ({ payload }) => {
    if (!payload.requestId || !payload.sessionId || !payload.replyWindow) return;
    let response: PeerStartResponse;
    try {
      response = { requestId: payload.requestId, result: await start(payload.sessionId) };
    } catch (error) {
      response = { requestId: payload.requestId, error: error instanceof Error ? error.message : String(error) };
    }
    await events.emitTo(payload.replyWindow, START_TAB_RESULT_EVENT, response);
  });
}

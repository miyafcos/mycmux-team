import { findAgentSessionOwner } from "./agentResumeConflict";
import { getWindowFragments, type WindowFragment } from "./ipc";
import { windowLabel } from "./windowContext";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

const OPEN_OWNER_EVENT = "mycmux://agent-resume-open-owner";

export function ownerWindowInFragments(fragments: readonly WindowFragment[], sessionId: string): string | null {
  return fragments.find(fragment => !fragment.pending && fragment.workspaces.some(workspace =>
    workspace.panes.some(pane => pane.tabs?.some(tab => tab.session_id === sessionId))))?.window_label ?? null;
}

export async function agentResumeOwnerWindow(sessionId: string): Promise<string | null> {
  if (findAgentSessionOwner(useWorkspaceListStore.getState().workspaces, sessionId)) return windowLabel();
  return ownerWindowInFragments(await getWindowFragments(), sessionId);
}

export async function openAgentResumeOwner(sessionId: string): Promise<void> {
  const label = await agentResumeOwnerWindow(sessionId);
  if (!label) return;
  if (label === windowLabel()) {
    const { openWatchdogSession } = await import("../stores/dispatchWatchdogStore");
    openWatchdogSession(sessionId);
    return;
  }
  const [{ emitTo }, { WebviewWindow }] = await Promise.all([
    import("@tauri-apps/api/event"), import("@tauri-apps/api/webviewWindow"),
  ]);
  await emitTo(label, OPEN_OWNER_EVENT, { sessionId });
  const owner = await WebviewWindow.getByLabel(label);
  await owner?.show();
  await owner?.setFocus();
}

export function connectAgentResumeOwnerNavigation(): () => void {
  let alive = true;
  let unlisten: (() => void) | null = null;
  void import("@tauri-apps/api/event").then(events => events.listen<{ sessionId: string }>(OPEN_OWNER_EVENT, ({ payload }) => {
    if (!alive || typeof payload?.sessionId !== "string" || !findAgentSessionOwner(useWorkspaceListStore.getState().workspaces, payload.sessionId)) return;
    void import("../stores/dispatchWatchdogStore").then(({ openWatchdogSession }) => {
      if (alive) openWatchdogSession(payload.sessionId);
    }).catch(error => console.warn("[resume] Owner navigation failed:", error));
  }, { target: { kind: "Webview", label: windowLabel() } })).then(stop => {
    if (alive) unlisten = stop; else stop();
  }).catch(error => console.warn("[resume] Owner navigation listener unavailable:", error));
  return () => { alive = false; unlisten?.(); };
}

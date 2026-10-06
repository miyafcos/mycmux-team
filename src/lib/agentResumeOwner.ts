import { findAgentSessionOwner } from "./agentResumeConflict";
import { getWindowFragments, type WindowFragment } from "./ipc";
import { windowLabel } from "./windowContext";
import { getTabDisplayLabel } from "./tabDisplayLabel";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

const OPEN_OWNER_EVENT = "mycmux://agent-resume-open-owner";

export interface AgentResumeOwnerLocation {
  windowLabel: string;
  workspaceName: string;
  paneName: string;
  otherWindow: boolean;
}

export function ownerLocationInFragments(fragments: readonly WindowFragment[], sessionId: string): AgentResumeOwnerLocation | null {
  for (const fragment of fragments) {
    if (fragment.pending) continue;
    for (const workspace of fragment.workspaces) for (const pane of workspace.panes) {
      const tab = pane.tabs?.find(tab => tab.session_id === sessionId);
      if (!tab) continue;
      const paneName = getTabDisplayLabel({ label: tab.label ?? pane.label ?? undefined,
        labelSource: tab.label_source === "ai" ? "ai" : "user", displayName: tab.display_name ?? undefined,
        agentId: tab.agent_id ?? pane.agent_id, sessionId, cwd: tab.cwd ?? pane.cwd ?? undefined });
      return { windowLabel: fragment.window_label, workspaceName: workspace.name,
        paneName, otherWindow: fragment.window_label !== windowLabel() };
    }
  }
  return null;
}

export async function agentResumeOwnerLocation(sessionId: string): Promise<AgentResumeOwnerLocation | null> {
  const owner = findAgentSessionOwner(useWorkspaceListStore.getState().workspaces, sessionId);
  if (owner) {
    const metadata = usePaneMetadataStore.getState();
    return { windowLabel: windowLabel(), workspaceName: owner.workspace.name,
      paneName: getTabDisplayLabel(owner.tab, true, metadata.metadata, metadata.volatileMetadata), otherWindow: false };
  }
  return ownerLocationInFragments(await getWindowFragments(), sessionId);
}

export function ownerWindowInFragments(fragments: readonly WindowFragment[], sessionId: string): string | null {
  return fragments.find(fragment => !fragment.pending && fragment.workspaces.some(workspace =>
    workspace.panes.some(pane => pane.tabs?.some(tab => tab.session_id === sessionId))))?.window_label ?? null;
}

export async function agentResumeOwnerWindow(sessionId: string): Promise<string | null> {
  return (await agentResumeOwnerLocation(sessionId))?.windowLabel ?? null;
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

import type { Pane } from "../types";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

export const HANDOFF_LAUNCH_ENV_KEYS = [
  "MYCMUX_HANDOFF",
  "MYCMUX_HANDOFF_FROM",
  "MYCMUX_HANDOFF_PROMPT_FILE",
  "MYCMUX_HANDOFF_FROM_SESSION",
  "MYCMUX_HANDOFF_LAUNCH_KIND",
] as const;

export function consumePaneHandoffLaunchEnv(pane: Pane, sessionId: string): Pane {
  let changed = false;
  const tabs = pane.tabs.map((tab) => {
    if (tab.sessionId !== sessionId) return tab;
    const source = tab.launchEnv ?? pane.launchEnv;
    if (!source?.MYCMUX_HANDOFF?.trim()) return tab;
    const launchEnv = { ...source };
    for (const key of HANDOFF_LAUNCH_ENV_KEYS) delete launchEnv[key];
    changed = true;
    return { ...tab, launchEnv };
  });
  if (!changed) return pane;
  return { ...pane, tabs };
}

/** Consume only after createSession succeeds; preserve inherited env on other tabs. */
export function consumeHandoffLaunchEnv(sessionId: string): void {
  const store = useWorkspaceListStore.getState();
  for (const workspace of store.workspaces) {
    const panes = workspace.panes.map((pane) => consumePaneHandoffLaunchEnv(pane, sessionId));
    if (panes.some((pane, index) => pane !== workspace.panes[index])) {
      store._updateWorkspacePanes(workspace.id, panes);
    }
  }
}

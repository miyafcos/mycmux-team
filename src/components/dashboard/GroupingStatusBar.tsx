import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { groupingBoundary } from "../layout/groupingBoundary";
import {
  getGroupingPanelOpen,
  subscribeGroupingPanelOpen,
} from "../layout/groupingPanelPresence";
import { TAB_GROUPING_OPEN_EVENT } from "../layout/tabGrouping";
import { useGroupingRuntimeStore } from "../../stores/groupingRuntimeStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import {
  selectGroupingStatusBarView,
  type GroupingStatusActionId,
} from "./groupingStatusBarModel";
import "./GroupingStatusBar.css";

export function GroupingStatusBar() {
  const runtime = useGroupingRuntimeStore();
  const workspaceState = useWorkspaceListStore();
  const [appVersion, setAppVersion] = useState("unknown");
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const panelOpen = useSyncExternalStore(
    subscribeGroupingPanelOpen,
    getGroupingPanelOpen,
    () => false,
  );

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => {});
  }, []);

  const view = useMemo(() => {
    const paneCount = workspaceState.workspaces.reduce((count, workspace) => count + workspace.panes.length, 0);
    const tabCount = workspaceState.workspaces.reduce(
      (count, workspace) => count + workspace.panes.reduce((paneTotal, pane) => paneTotal + pane.tabs.length, 0),
      0,
    );
    return selectGroupingStatusBarView(runtime, {
      appVersion,
      layoutRevision: workspaceState.layoutRevision,
      workspaceCount: workspaceState.workspaces.length,
      paneCount,
      tabCount,
    });
  }, [appVersion, runtime, workspaceState.layoutRevision, workspaceState.workspaces]);

  const durabilityRequestId = "requestId" in runtime.durability ? runtime.durability.requestId : "none";
  const viewKey = `${view?.kind ?? "hidden"}:${runtime.undo?.createdAt ?? "none"}:${runtime.undo?.status ?? "none"}:${runtime.durability.status}:${durabilityRequestId}`;
  if (!view || dismissedKey === viewKey) return null;
  if (panelOpen && (view.kind === "undo_available" || view.kind === "undo_expired")) return null;

  const runAction = (id: GroupingStatusActionId) => {
    if (id === "undo") {
      const result = groupingBoundary.undo();
      if (!result.ok) console.warn("[mycmux] tab grouping undo failed", result);
      return;
    }
    if (id === "copy_diagnostics" && view.kind === "poisoned") {
      void navigator.clipboard?.writeText(JSON.stringify(view.diagnosticPayload, null, 2));
      return;
    }
    if (id === "restart_app") {
      void relaunch();
      return;
    }
    if (id === "dismiss") {
      setDismissedKey(viewKey);
      return;
    }
    if (id === "inspect_layout") {
      const minimap = document.querySelector<HTMLElement>(".cmux-minimap-panel");
      minimap?.scrollIntoView({ block: "nearest" });
      (minimap?.querySelector<HTMLElement>("button, [tabindex]") ?? minimap)?.focus();
      return;
    }
    if (id === "review_changes") {
      window.dispatchEvent(new CustomEvent(TAB_GROUPING_OPEN_EVENT, { detail: { intent: "review" } }));
    }
  };

  return <section
    className="cmux-grouping-status-bar"
    data-kind={view.kind}
    role={view.kind === "poisoned" ? "alert" : "status"}
  >
    <div className="cmux-grouping-status-copy">
      <span>{view.message}</span>
      {view.warning ? <span className="cmux-grouping-status-warning">{view.warning}</span> : null}
    </div>
    {view.actions.length > 0 ? <div className="cmux-grouping-status-actions">
      {view.actions.map((item) => <button
        key={item.id}
        type="button"
        disabled={!item.enabled}
        onClick={() => runAction(item.id)}
      >{item.label}</button>)}
    </div> : null}
  </section>;
}

import { lazy, Suspense, useLayoutEffect, useRef, type ReactNode } from "react";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { useUiStore } from "../../stores/uiStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { focusController } from "../../lib/focusController";
import { dashboardStrings } from "./dashboardStrings";
import "./DashboardView.css";
import "./DetachedDashboardSurface.css";

const DashboardView = lazy(() => import("./DashboardView").then(module => ({ default: module.DashboardView })));

/** Keep terminals mounted while the shared dashboard occupies this shell. */
export function DetachedDashboardSurface({ children }: { children: ReactNode }) {
  const open = useDashboardViewStore(state => state.open);
  const close = useDashboardViewStore(state => state.close);
  const wasOpen = useRef(false);
  const returnSession = useRef<string | null>(null);
  useLayoutEffect(() => {
    const ui = useUiStore.getState();
    if (open) {
      if (!wasOpen.current) returnSession.current = ui.activePaneId ?? ui.lastActivePaneId;
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const localTerminals = new Set(useWorkspaceListStore.getState().workspaces.flatMap(workspace => (
      workspace.panes.flatMap(pane => pane.tabs.filter(tab => !tab.type || tab.type === "terminal").map(tab => tab.sessionId))
    )));
    const candidates = [ui.activePaneId, ui.lastActivePaneId, returnSession.current]
      .filter((sessionId): sessionId is string => Boolean(sessionId && localTerminals.has(sessionId)));
    returnSession.current = null;
    const target = focusController.resolveEligibleTerminal(...candidates);
    if (target) focusController.focusEligibleTerminal(target);
  }, [open]);
  return <div className="cmux-detached-dashboard-host" style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative", overflow: "hidden" }}>
    <div data-detached-terminal="true" aria-hidden={open} style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column",
      visibility: open ? "hidden" : "visible", pointerEvents: open ? "none" : "auto" }}>{children}</div>
    {open && <Suspense fallback={<div role="region" aria-label={dashboardStrings.viewAriaLabel} className="cmux-dashboard-view">{dashboardStrings.buttonTitle}</div>}>
      <DashboardView onClose={close} />
    </Suspense>}
  </div>;
}

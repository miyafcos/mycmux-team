import { useCallback, useEffect, useState } from "react";

import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { recordRecentKeystroke } from "../../stores/recentInputStore";
import { DashboardPanel } from "./DashboardPanel";
import { DASHBOARD_OPEN_EVENT } from "./dashboardEvents";
import { dashboardStrings } from "./dashboardStrings";

export function DashboardButton() {
  const [open, setOpen] = useState(false);
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);
  const closePanel = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const openPanel = () => setOpen(true);
    window.addEventListener(DASHBOARD_OPEN_EVENT, openPanel);
    return () => window.removeEventListener(DASHBOARD_OPEN_EVENT, openPanel);
  }, []);

  useEffect(() => {
    const record = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; data?: string }>).detail;
      if (typeof detail?.sessionId === "string" && typeof detail.data === "string") {
        recordRecentKeystroke(detail.sessionId, detail.data);
      }
    };
    window.addEventListener("mycmux:keystroke", record);
    return () => window.removeEventListener("mycmux:keystroke", record);
  }, []);

  return (
    <div style={{ position: "relative", height: 24, display: "flex", alignItems: "center" }}>
      <button
        type="button"
        className="cmux-title-btn"
        title={dashboardStrings.buttonTitle}
        aria-label={dashboardStrings.buttonTitle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="dashboard-panel"
        onClick={() => setOpen((value) => !value)}
        style={{ background: "none", border: "none", color: "var(--cmux-text-secondary)", cursor: "pointer", padding: "3px 6px", borderRadius: 3, display: "flex", alignItems: "center" }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
          <rect x="1" y="1" width="4" height="4" rx=".4" />
          <rect x="7" y="1" width="4" height="4" rx=".4" />
          <rect x="1" y="7" width="4" height="4" rx=".4" />
          <rect x="7" y="7" width="4" height="4" rx=".4" />
        </svg>
      </button>
      <DashboardPanel open={open} visible={mounted} closing={closing} onClose={closePanel} />
    </div>
  );
}

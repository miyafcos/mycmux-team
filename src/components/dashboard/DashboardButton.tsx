import { useEffect } from "react";

import { recordRecentKeystroke } from "../../stores/recentInputStore";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { dashboardStrings } from "./dashboardStrings";

export function DashboardButton() {
  const open = useDashboardViewStore((state) => state.open);
  const toggle = useDashboardViewStore((state) => state.toggle);

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
    <div style={{ height: 24, display: "flex", alignItems: "center" }}>
      <button
        type="button"
        className="cmux-title-btn"
        title={dashboardStrings.buttonTitle}
        aria-label={dashboardStrings.buttonTitle}
        aria-pressed={open}
        onClick={toggle}
        style={{ background: "none", border: "none", color: "var(--cmux-text-secondary)", cursor: "pointer", padding: "3px 6px", borderRadius: 3, display: "flex", alignItems: "center" }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
          <rect x="1" y="1" width="4" height="4" rx=".4" />
          <rect x="7" y="1" width="4" height="4" rx=".4" />
          <rect x="1" y="7" width="4" height="4" rx=".4" />
          <rect x="7" y="7" width="4" height="4" rx=".4" />
        </svg>
      </button>
    </div>
  );
}

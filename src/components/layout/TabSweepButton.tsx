import { useCallback, useEffect, useState } from "react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { TAB_SWEEP_OPEN_EVENT } from "./tabSweep";
import { TabSweepPanel } from "./TabSweepPanel";

/**
 * Plain toggle for the sweep panel. It deliberately does no background
 * scanning and carries no badge: the scan is expensive (a tail read per tab)
 * and a permanent counter turned housekeeping into a nag. Tabs are scanned
 * only when the panel is open.
 */
export function TabSweepButton() {
  const [open, setOpen] = useState(false);
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);

  const openPanel = useCallback(() => setOpen(true), []);
  const closePanel = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const handleOpen = () => openPanel();
    window.addEventListener(TAB_SWEEP_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(TAB_SWEEP_OPEN_EVENT, handleOpen);
  }, [openPanel]);

  return (
    <div style={{ position: "relative", height: 24, display: "flex", alignItems: "center" }}>
      <button
        type="button"
        className="cmux-title-btn"
        title="タブ掃除"
        aria-label="タブ掃除"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="tab-sweep-panel"
        onClick={() => open ? closePanel() : openPanel()}
        style={{
          background: "none",
          border: "none",
          color: "var(--cmux-text-secondary)",
          cursor: "pointer",
          padding: "3px 6px",
          borderRadius: 3,
          display: "flex",
          alignItems: "center",
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>🧹</span>
      </button>
      <TabSweepPanel
        open={open}
        visible={mounted}
        closing={closing}
        onClose={closePanel}
      />
    </div>
  );
}

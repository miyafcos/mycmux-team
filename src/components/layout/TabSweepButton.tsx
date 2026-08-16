import { useCallback, useEffect, useState } from "react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { SweepIcon } from "../icons/ChromeIcons";
import { TAB_SWEEP_OPEN_EVENT } from "./tabSweep";
import { TabSweepPanel } from "./TabSweepPanel";
import { runAutoSweep } from "./tabSweepAuto";

/**
 * The primary path sweeps in the background. The panel remains available from
 * TAB_SWEEP_OPEN_EVENT as the detail view and recovery path.
 */
export function TabSweepButton() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);

  const openPanel = useCallback(() => setOpen(true), []);
  const closePanel = useCallback(() => setOpen(false), []);
  const startAutoSweep = useCallback(() => {
    if (running) return;
    setRunning(true);
    void runAutoSweep().finally(() => setRunning(false));
  }, [running]);

  useEffect(() => {
    const handleOpen = () => openPanel();
    window.addEventListener(TAB_SWEEP_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(TAB_SWEEP_OPEN_EVENT, handleOpen);
  }, [openPanel]);

  return (
    <div className="cmux-minimap-tab-sweep">
      <button
        type="button"
        className="cmux-minimap-tab-sweep-button"
        title={running ? "タブ掃除中…" : "タブ掃除"}
        aria-label="タブ掃除"
        aria-busy={running}
        aria-expanded={open}
        aria-controls="tab-sweep-panel"
        onClick={startAutoSweep}
      >
        <SweepIcon />
        <span>タブ掃除</span>
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

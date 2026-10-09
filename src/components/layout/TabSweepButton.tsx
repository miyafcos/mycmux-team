import { useCallback, useEffect, useRef, useState } from "react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { SweepIcon } from "../icons/ChromeIcons";
import { TAB_SWEEP_OPEN_EVENT } from "./tabSweep";
import { TabSweepPanel } from "./TabSweepPanel";
import { runAutoSweep, type AutoSweepReview, type ConfirmAutoSweep } from "./tabSweepAuto";

/**
 * Judgment runs in the background; the existing panel owns human confirmation.
 * TAB_SWEEP_OPEN_EVENT also opens the manual detail and recovery path.
 */
export function TabSweepButton() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [review, setReview] = useState<AutoSweepReview | null>(null);
  const resolveReviewRef = useRef<((ids: readonly string[] | null) => void) | null>(null);
  const reviewHostActiveRef = useRef(true);
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);

  const openPanel = useCallback(() => setOpen(true), []);
  const finishReview = useCallback((ids: readonly string[] | null) => {
    resolveReviewRef.current?.(ids);
    resolveReviewRef.current = null;
    setReview(null);
    setOpen(false);
  }, []);
  const closePanel = useCallback(() => finishReview(null), [finishReview]);
  const confirmSweep: ConfirmAutoSweep = useCallback((nextReview) => {
    if (!reviewHostActiveRef.current) return Promise.resolve(null);
    return new Promise((resolve) => {
      resolveReviewRef.current = resolve;
      setReview(nextReview);
      setOpen(true);
    });
  }, []);
  useEffect(() => {
    reviewHostActiveRef.current = true;
    return () => {
      reviewHostActiveRef.current = false;
      resolveReviewRef.current?.(null);
      resolveReviewRef.current = null;
    };
  }, []);
  const startAutoSweep = useCallback(() => {
    if (running) return;
    setRunning(true);
    void runAutoSweep(confirmSweep).catch(() => undefined).finally(() => setRunning(false));
  }, [confirmSweep, running]);

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
        title={running ? "ペイン掃除中…" : "ペイン掃除"}
        aria-label="ペイン掃除"
        aria-busy={running}
        aria-expanded={open}
        aria-controls="tab-sweep-panel"
        onClick={startAutoSweep}
      >
        <SweepIcon />
        <span>ペイン掃除</span>
      </button>
      <TabSweepPanel
        open={open}
        visible={mounted}
        closing={closing}
        onClose={closePanel}
        autoReview={review}
        onConfirmSweep={(ids) => finishReview(ids)}
      />
    </div>
  );
}

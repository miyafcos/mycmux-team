import { useCallback, useEffect, useState } from "react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { markGroupingInterest, startGroupingPrecomputeIfInterested } from "../../lib/groupingPrecompute";
import { tabGroupingStrings } from "../dashboard/dashboardStrings";
import { TAB_GROUPING_OPEN_EVENT } from "./tabGrouping";
import { TabGroupingPanel } from "./TabGroupingPanel";

/**
 * Unsealed for v0.58.0: the owner ran the four scenarios on a trial build and
 * gave a hands-on GO, and the independent Gate 6 audit closed with no
 * Blocker/Critical/High findings. The remaining Medium/Low items are tracked
 * for v0.58.1.
 */
export const TAB_GROUPING_ENTRY_ENABLED = true;

export function TabGroupingButton() {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<"review" | null>(null);
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);
  const openPanel = useCallback((nextIntent: "review" | null = null) => {
    markGroupingInterest();
    setIntent(nextIntent);
    setOpen(true);
  }, []);
  const closePanel = useCallback(() => setOpen(false), []);

  useEffect(() => {
    startGroupingPrecomputeIfInterested();
  }, []);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { intent?: "review" } | undefined : undefined;
      openPanel(detail?.intent ?? null);
    };
    window.addEventListener(TAB_GROUPING_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(TAB_GROUPING_OPEN_EVENT, handleOpen);
  }, [openPanel]);

  return (
    <div className="cmux-minimap-tab-sweep">
      <button
        type="button"
        className="cmux-minimap-tab-sweep-button"
        title={tabGroupingStrings.buttonLabel}
        aria-label={tabGroupingStrings.buttonLabel}
        aria-expanded={open}
        aria-controls="tab-grouping-panel"
        onClick={() => openPanel()}
      >
        <svg aria-hidden="true" focusable="false" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="7" height="16" rx="1.5" />
          <rect x="14" y="4" width="7" height="7" rx="1.5" />
          <rect x="14" y="13" width="7" height="7" rx="1.5" />
        </svg>
        <span>{tabGroupingStrings.buttonLabel}</span>
      </button>
      {mounted ? (
        <TabGroupingPanel
          open={open}
          visible={mounted}
          closing={closing}
          intent={intent}
          onClose={closePanel}
        />
      ) : null}
    </div>
  );
}

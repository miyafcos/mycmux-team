import { useCallback, useEffect, useState } from "react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { tabGroupingStrings } from "../dashboard/dashboardStrings";
import { TAB_GROUPING_OPEN_EVENT } from "./tabGrouping";
import { TabGroupingPanel } from "./TabGroupingPanel";

/**
 * Release gate: the tab regrouping surface failed its round-1 independent audit
 * (SOL_AUDIT_tab_grouping.md, verdict REJECT). The entry stays unmounted in the
 * dashboard until the fix round closes and the feature gets a hands-on GO.
 */
export const TAB_GROUPING_ENTRY_ENABLED = false;

export function TabGroupingButton() {
  const [open, setOpen] = useState(false);
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);
  const openPanel = useCallback(() => setOpen(true), []);
  const closePanel = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const handleOpen = () => openPanel();
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
        onClick={openPanel}
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
          onClose={closePanel}
        />
      ) : null}
    </div>
  );
}

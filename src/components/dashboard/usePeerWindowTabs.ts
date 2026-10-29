import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getWindowTabIndex, WINDOW_REGISTRY_CHANGED_EVENT, type WindowTabIndex } from "../../lib/ipc";
import { windowLabel } from "../../lib/windowContext";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { delegationReadWithTimeout } from "./delegationModel";
import { parsePeerWindowTabIndex } from "./peerWindowTabs";
import { usePeerWindowTabsStore } from "./peerWindowTabsStore";

const EMPTY_INDEX: readonly WindowTabIndex[] = [];

export function usePeerWindowTabs() {
  const open = useDashboardViewStore(state => state.open);
  const index = usePeerWindowTabsStore(state => state.index);
  const label = windowLabel();
  useEffect(() => {
    if (label !== "main" || !open) return;
    let alive = true, inFlight = false, requested = false;
    let unlisten: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!alive || !useDashboardViewStore.getState().open) return;
      if (inFlight) { requested = true; return; }
      inFlight = true;
      usePeerWindowTabsStore.setState({ reading: true });
      try {
        const result = parsePeerWindowTabIndex(await delegationReadWithTimeout(getWindowTabIndex()));
        if (alive && result) usePeerWindowTabsStore.getState().acceptIndex(result);
      } catch { /* Retain the last usable index, including on timeout. */ }
      finally {
        inFlight = false;
        if (alive) {
          usePeerWindowTabsStore.getState().finishRead();
          if (requested) { requested = false; void refresh(); }
        }
      }
    };
    const requestRefresh = () => {
      const state = usePeerWindowTabsStore.getState();
      if (state.requestSequence === state.handledRequestSequence) return;
      usePeerWindowTabsStore.setState({ handledRequestSequence: state.requestSequence });
      void refresh();
      clearTimeout(retry);
      retry = setTimeout(() => { void refresh(); }, 600);
    };
    const stopRequests = usePeerWindowTabsStore.subscribe((state, previous) => {
      if (state.requestSequence !== previous.requestSequence) requestRefresh();
    });
    usePeerWindowTabsStore.setState(state => ({ pollers: state.pollers + 1 }));
    if (usePeerWindowTabsStore.getState().requestSequence !== usePeerWindowTabsStore.getState().handledRequestSequence) requestRefresh();
    else void refresh();
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    void Promise.resolve().then(() => listen(WINDOW_REGISTRY_CHANGED_EVENT, () => { void refresh(); }))
      .then(stop => { if (alive) unlisten = stop; else stop(); }).catch(() => {});
    return () => {
      alive = false;
      stopRequests(); unlisten?.(); clearInterval(interval); clearTimeout(retry);
      usePeerWindowTabsStore.setState(state => ({ pollers: Math.max(0, state.pollers - 1), reading: false }));
    };
  }, [label, open]);
  return label === "main" ? index : EMPTY_INDEX;
}

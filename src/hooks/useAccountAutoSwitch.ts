import { useEffect } from "react";
import { useAccountAutoSwitchStore } from "../stores/accountAutoSwitchStore";
import { useCliAccountStore } from "../stores/cliAccountStore";
import { useUsageStore } from "../stores/usageStore";

/** Lives with titlebar polling, so closing settings does not stop monitoring. */
export function useAccountAutoSwitch(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let queued = false;
    const schedule = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!disposed) void useAccountAutoSwitchStore.getState().evaluate();
      });
    };
    const unsubscribeUsage = useUsageStore.subscribe(schedule);
    const unsubscribeCli = useCliAccountStore.subscribe(schedule);
    const unsubscribeSetting = useAccountAutoSwitchStore.subscribe((next, prev) => {
      if (next.enabled !== prev.enabled) schedule();
    });
    schedule();
    return () => {
      disposed = true;
      unsubscribeUsage();
      unsubscribeCli();
      unsubscribeSetting();
    };
  }, [enabled]);
}

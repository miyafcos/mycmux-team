import { useDashboardViewStore } from "../stores/dashboardViewStore";

let detachedHosts = 0;

export function isDetachedDashboardHost(): boolean {
  return detachedHosts > 0;
}

/** Only the two compact shells opt out of hosting their own dashboard. */
export function mountDetachedDashboardHost(): () => void {
  detachedHosts += 1;
  const view = useDashboardViewStore.getState();
  if (view.open) view.close();
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    detachedHosts -= 1;
  };
}

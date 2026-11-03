import { BellOff } from "lucide-react";
import { useDispatchWatchdogStore } from "../../stores/dispatchWatchdogStore";
import { isMainWindow } from "../../lib/windowContext";
import { dashboardStrings } from "./dashboardStrings";
import { watchStatusModel } from "./watchStatusModel";
import { DashboardGlyph, DashboardStatusMark } from "./DashboardUi";

export function WatchStatusRow({ now }: { now: number }) {
  const telemetry = useDispatchWatchdogStore((state) => state.telemetry);
  const model = watchStatusModel({ ...telemetry, isMainWindow: isMainWindow() });
  const stateText = model.state === "running" ? dashboardStrings.watchRunning : model.state === "stopped" ? dashboardStrings.watchStopped : dashboardStrings.watchUnmeasured;
  const reason = model.skipReason === "hidden" ? dashboardStrings.watchHidden : model.skipReason === "not-main-window" ? dashboardStrings.watchNotMain : model.skipReason === "disabled" ? dashboardStrings.watchDisabled : null;
  return <section aria-label={dashboardStrings.watchTitle} title={[dashboardStrings.watchTitle, stateText, reason, model.notifySuppressed ? dashboardStrings.watchNotifyOff : null].filter(Boolean).join(" · ")} className="cmux-dashboard-watchrow">
    <DashboardStatusMark state={model.state === "running" ? "running" : model.state === "stopped" ? "stopped" : "unknown"} label={[stateText, reason].filter(Boolean).join(" · ")} />
    {model.lastTickAt === null ? null : <span className="cmux-dashboard-watch-clock" title={dashboardStrings.watchLastTick(age(model.lastTickAt, now))} aria-label={dashboardStrings.watchLastTick(age(model.lastTickAt, now))}><span aria-hidden="true">{age(model.lastTickAt, now)}</span></span>}
    {model.nextTickDueAt === null ? null : <span className="cmux-dashboard-watch-clock" title={dashboardStrings.watchNextTick(age(model.nextTickDueAt, now))} aria-label={dashboardStrings.watchNextTick(age(model.nextTickDueAt, now))}><span aria-hidden="true">{age(model.nextTickDueAt, now)}</span></span>}
    {model.notifySuppressed ? <DashboardGlyph icon={BellOff} label={dashboardStrings.watchNotifyOff} /> : null}
  </section>;
}

function age(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor(Math.abs(now - at) / 60_000));
  return at > now
    ? dashboardStrings.watchDueIn(minutes)
    : minutes === 0
      ? dashboardStrings.watchJustNow
      : dashboardStrings.watchAgo(minutes);
}

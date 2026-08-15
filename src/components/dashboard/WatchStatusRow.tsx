import { useDispatchWatchdogStore } from "../../stores/dispatchWatchdogStore";
import { isMainWindow } from "../../lib/windowContext";
import { dashboardStrings } from "./dashboardStrings";
import { watchStatusModel } from "./watchStatusModel";

export function WatchStatusRow({ now }: { now: number }) {
  const telemetry = useDispatchWatchdogStore((state) => state.telemetry);
  const model = watchStatusModel({ ...telemetry, isMainWindow: isMainWindow() });
  const stateText = model.state === "running" ? dashboardStrings.watchRunning : model.state === "stopped" ? dashboardStrings.watchStopped : dashboardStrings.watchUnmeasured;
  const reason = model.skipReason === "hidden" ? dashboardStrings.watchHidden : model.skipReason === "not-main-window" ? dashboardStrings.watchNotMain : model.skipReason === "disabled" ? dashboardStrings.watchDisabled : null;
  return <section aria-label={dashboardStrings.watchTitle} className="cmux-dashboard-watchrow">
    <strong className="cmux-dashboard-watch-title">{dashboardStrings.watchTitle}</strong>
    <span className={model.state === "running" ? "is-running" : undefined}>{stateText}</span>
    {model.lastTickAt === null ? null : <span>{dashboardStrings.watchLastTick(age(model.lastTickAt, now))}</span>}
    {model.nextTickDueAt === null ? null : <span>{dashboardStrings.watchNextTick(age(model.nextTickDueAt, now))}</span>}
    {reason ? <span>{reason}</span> : null}
    {model.notifySuppressed ? <span>{dashboardStrings.watchNotifyOff}</span> : null}
  </section>;
}

function age(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor(Math.abs(now - at) / 60_000));
  return at > now ? `${minutes}分後` : minutes === 0 ? "たった今" : `${minutes}分前`;
}

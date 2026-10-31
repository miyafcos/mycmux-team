import { Info, TerminalSquare } from "lucide-react";
import { DashboardGlyph, DashboardStatusMark } from "./DashboardUi";
import { useRecentInputStore } from "../../stores/recentInputStore";
import { attentionDetail } from "../../stores/sessionAttentionStore";
import { stallLabel } from "./DashboardSessionList";
import type { DashboardCardModel } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";

function SummaryLine({ label, value }: { label: string; value: string }) {
  return <div className="cmux-dashboard-telemetry-fallback-line">
    <DashboardGlyph icon={Info} label={label} className="cmux-dashboard-telemetry-fallback-label" />
    <span>{value}</span>
  </div>;
}

/** telemetry が生きていない時に、xterm 側から拾える分だけ中央チャット面に出す。 */
export function DashboardTelemetryFallback({ card, now }: { card: DashboardCardModel; now: number }) {
  const recentInput = useRecentInputStore((store) => store.recentBySession[card.tab.sessionId]);
  const asking = attentionDetail(card.attention);
  const reason = card.neverStarted
    ? dashboardStrings.notStartedDetail
    : card.telemetryHealth === "unavailable"
      ? dashboardStrings.telemetryUnavailable
      : dashboardStrings.telemetryUnlinked;
  return <section className="cmux-dashboard-telemetry-fallback" aria-label={dashboardStrings.fallbackTitle}>
    <DashboardStatusMark state={card.neverStarted ? "notStarted" : "unknown"} label={reason} />
    <div className="cmux-dashboard-telemetry-fallback-lines">
      <DashboardGlyph icon={TerminalSquare} label={dashboardStrings.fallbackTitle} />
      {recentInput ? <SummaryLine label={dashboardStrings.myInstructionLabel} value={recentInput.text} /> : null}
      {asking ? <SummaryLine label={dashboardStrings.agentAskingLabel} value={asking} /> : null}
      {card.stall ? <SummaryLine label={stallLabel(card.stall.reason)} value={dashboardStrings.stallSince(Math.max(0, Math.floor((now - card.stall.since) / 60_000)))} /> : null}
      {card.lastLog ? <div className="cmux-dashboard-telemetry-fallback-log">{card.lastLog}</div> : null}
    </div>
    <DashboardGlyph icon={Info} label={dashboardStrings.fallbackHint} />
  </section>;
}

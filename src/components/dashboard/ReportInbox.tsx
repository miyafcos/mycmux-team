import type { MachineReportCard, ReportReceiveMode } from "../../stores/reportInboxStore";
import { dashboardStrings } from "./dashboardStrings";

export function ReportInbox({
  cards,
  receiveModeBySession,
  onReceiveModeChange,
  onOpenSource,
}: {
  cards: readonly MachineReportCard[];
  receiveModeBySession: Record<string, ReportReceiveMode | undefined>;
  onReceiveModeChange: (ptySessionId: string, mode: ReportReceiveMode) => void;
  onOpenSource: (card: MachineReportCard) => void;
}) {
  const immediate = cards.filter((card) => (receiveModeBySession[card.ptySessionId] ?? "batch") === "immediate");
  const batched = cards.filter((card) => (receiveModeBySession[card.ptySessionId] ?? "batch") === "batch");
  const quiet = cards.filter((card) => (receiveModeBySession[card.ptySessionId] ?? "batch") === "quiet");
  return <div className="cmux-report-inbox" aria-label={dashboardStrings.reportInboxTitle}>
    <div className="cmux-report-inbox-head">
      <strong>{dashboardStrings.reportInboxTitle}</strong>
      <span>{dashboardStrings.reportInboxHint}</span>
    </div>
    {immediate.map((card) => <MachineCard key={card.id} card={card} mode={receiveModeBySession[card.ptySessionId] ?? "batch"} onReceiveModeChange={onReceiveModeChange} onOpenSource={onOpenSource} />)}
    {batched.length ? <details className="cmux-report-inbox-fold" data-report-batch-unlinked>
      <summary>{dashboardStrings.reportSummaryUnlinked(batched.length)}</summary>
      {batched.map((card) => <MachineCard key={card.id} card={card} mode="batch" onReceiveModeChange={onReceiveModeChange} onOpenSource={onOpenSource} />)}
    </details> : null}
    {quiet.length ? <details className="cmux-report-inbox-fold" data-report-quiet-fold>
      <summary>{dashboardStrings.reportQuietRecorded(quiet.length)}</summary>
      {quiet.map((card) => <MachineCard key={card.id} card={card} mode="quiet" onReceiveModeChange={onReceiveModeChange} onOpenSource={onOpenSource} />)}
    </details> : null}
    {!cards.length ? <div className="cmux-report-inbox-empty">{dashboardStrings.reportInboxEmpty}</div> : null}
  </div>;
}

function MachineCard({
  card,
  mode,
  onReceiveModeChange,
  onOpenSource,
}: {
  card: MachineReportCard;
  mode: ReportReceiveMode;
  onReceiveModeChange: (ptySessionId: string, mode: ReportReceiveMode) => void;
  onOpenSource: (card: MachineReportCard) => void;
}) {
  return <article className={`cmux-report-machine-card is-${card.state}`} data-report-inbox-card={card.id}>
    <div className="cmux-report-machine-card-head">
      <span className="cmux-report-machine-tag">{dashboardStrings.reportMachineTag}</span>
      <span>{machineStateLabel(card.state)}</span>
      <time>{clockLabel(card.observedAt)}</time>
    </div>
    <div className="cmux-report-machine-detail">{card.detail}</div>
    <div className="cmux-report-machine-actions">
      <label>
        <span>{dashboardStrings.reportReceiveModeLabel}</span>
        <select value={mode} onChange={(event) => onReceiveModeChange(card.ptySessionId, event.target.value as ReportReceiveMode)}>
          <option value="immediate">{dashboardStrings.reportModeImmediate}</option>
          <option value="batch">{dashboardStrings.reportModeBatch}</option>
          <option value="quiet">{dashboardStrings.reportModeQuiet}</option>
        </select>
      </label>
      <button type="button" onClick={() => onOpenSource(card)}>{dashboardStrings.reportSourceButton}</button>
    </div>
  </article>;
}

function machineStateLabel(state: MachineReportCard["state"]): string {
  if (state === "waiting") return dashboardStrings.reportStateWaiting;
  if (state === "stopped") return dashboardStrings.reportStateStopped;
  return dashboardStrings.reportStateNeedsReview;
}

function clockLabel(value: number): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

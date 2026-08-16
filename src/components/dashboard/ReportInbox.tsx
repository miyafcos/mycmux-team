import {
  reportBatchCoverage,
  useReportInboxStore,
  type MachineReportCard,
  type ReportDispatchBatch,
  type ReportReceiveMode,
} from "../../stores/reportInboxStore";
import { useBackgroundAiReportSummary } from "../../lib/backgroundAiScheduler";
import { dashboardStrings } from "./dashboardStrings";
import { AttentionCards } from "./AttentionCards";

export function ReportInbox({
  cards,
  receiveModeBySession,
  sourceAvailableSessionIds,
  onReceiveModeChange,
  onOpenSource,
}: {
  cards: readonly MachineReportCard[];
  receiveModeBySession: Record<string, ReportReceiveMode | undefined>;
  sourceAvailableSessionIds: ReadonlySet<string>;
  onReceiveModeChange: (ptySessionId: string, mode: ReportReceiveMode) => void;
  onOpenSource: (card: MachineReportCard) => void;
}) {
  const dispatchBatchesById = useReportInboxStore((state) => state.dispatchBatchesById);
  const dispatchBatches = Object.values(dispatchBatchesById)
    .filter((batch): batch is ReportDispatchBatch => batch !== undefined);
  const immediate = cards.filter((card) => (receiveModeBySession[card.ptySessionId] ?? "batch") === "immediate");
  const batched = cards.filter((card) => (receiveModeBySession[card.ptySessionId] ?? "batch") === "batch");
  const quiet = cards.filter((card) => (receiveModeBySession[card.ptySessionId] ?? "batch") === "quiet");
  return <div className="cmux-report-inbox" aria-label={dashboardStrings.reportInboxTitle}>
    <div className="cmux-report-inbox-head">
      <strong>{dashboardStrings.reportInboxTitle}</strong>
      <span>{dashboardStrings.reportInboxHint}</span>
    </div>
    <AttentionCards />
    {dispatchBatches.map((batch) => <BatchSummary key={batch.batch.id} batch={batch} />)}
    {immediate.map((card) => <MachineCard key={card.id} card={card} mode={receiveModeBySession[card.ptySessionId] ?? "batch"} sourceAvailable={sourceAvailableSessionIds.has(card.ptySessionId)} onReceiveModeChange={onReceiveModeChange} onOpenSource={onOpenSource} />)}
    {batched.length ? <details className="cmux-report-inbox-fold" data-report-batch-fold>
      <summary>{`${dashboardStrings.reportModeBatch} · ${batched.length}件`}</summary>
      {batched.map((card) => <MachineCard key={card.id} card={card} mode="batch" sourceAvailable={sourceAvailableSessionIds.has(card.ptySessionId)} onReceiveModeChange={onReceiveModeChange} onOpenSource={onOpenSource} />)}
    </details> : null}
    {quiet.length ? <details className="cmux-report-inbox-fold" data-report-quiet-fold>
      <summary>{`${dashboardStrings.reportModeQuiet} · ${dashboardStrings.reportQuietRecorded(quiet.length)}`}</summary>
      {quiet.map((card) => <MachineCard key={card.id} card={card} mode="quiet" sourceAvailable={sourceAvailableSessionIds.has(card.ptySessionId)} onReceiveModeChange={onReceiveModeChange} onOpenSource={onOpenSource} />)}
    </details> : null}
    {!cards.length && !dispatchBatches.length ? <div className="cmux-report-inbox-empty">{dashboardStrings.reportInboxEmpty}</div> : null}
  </div>;
}

function BatchSummary({ batch }: { batch: ReportDispatchBatch }) {
  const aiSummary = useBackgroundAiReportSummary(batch.batch.id);
  const current = reportBatchCoverage(batch);
  const hasCorrelationWarning = batch.unattributedEvidenceRefs.length > 0;
  const partial = current.missing > 0 || hasCorrelationWarning;
  const coverageLine = `対象${current.target}｜受領${current.received}｜まとめ反映${current.reflected}｜未受領${current.missing}｜要判断${current.needsJudgment}`;
  const conflicts = Object.values(batch.membersByAssignmentId)
    .flatMap((member) => member.classification.conflicts.map((conflict) => `${member.label}: ${conflict}`));
  const conflictEvidence = Object.values(batch.membersByAssignmentId)
    .filter((member) => member.classification.conflicts.length > 0)
    .flatMap((member) => member.evidences.map((evidence) => `${member.label}: ${evidence.source}/${evidence.kind}`));
  return <article
    className={partial ? "cmux-dashboard-qcard is-compact" : "cmux-dashboard-next-actions"}
    data-report-summary={batch.batch.id}
    data-report-partial={partial ? "true" : "false"}
    data-summary-revision={batch.batch.publishedSummaryRevision}
  >
    <div className={partial ? "cmux-dashboard-qcard-head" : "cmux-dashboard-next-actions-head"}>
      <strong>{partial ? "部分まとめ" : "全員分を受領"}</strong>
      {aiSummary?.status === "loading" ? <span className="cmux-dashboard-next-actions-loading">AI要約を準備中</span> : null}
      {aiSummary?.status === "ready" ? <span className="cmux-dashboard-next-actions-ai-tag">AI</span> : null}
    </div>
    <div className="cmux-dashboard-qcard-prompt" role="status" aria-live="polite" aria-label={coverageLine}>{coverageLine}</div>
    {aiSummary?.status === "ready" ? <div className="cmux-dashboard-next-actions-summary" data-report-ai-summary>{aiSummary.oneLine}</div> : null}
    {hasCorrelationWarning ? <div className="cmux-dashboard-qcard-result is-error" data-report-correlation-warning>
      同じセッションで複数のまとめが動いているため、この報告は受領数に入れていません
    </div> : null}
    {conflicts.map((conflict) => <div key={conflict} className="cmux-dashboard-qcard-result is-error" data-report-conflict>{conflict}</div>)}
    {conflictEvidence.map((evidence) => <div key={evidence} className="cmux-dashboard-qcard-result" data-report-conflict-evidence>{evidence}</div>)}
    <details className="cmux-report-inbox-fold">
      <summary>送達状況</summary>
      {Object.values(batch.membersByAssignmentId).map((member) => <div key={member.assignmentId} className={`cmux-dashboard-dispatch-result is-${member.delivery.state}`}>
        <span aria-hidden="true">{deliveryMark(member.delivery.state)}</span>
        <span>@{member.label}</span>
        <small>{member.delivery.detail}</small>
      </div>)}
    </details>
  </article>;
}

function deliveryMark(state: ReportDispatchBatch["membersByAssignmentId"][string]["delivery"]["state"]): string {
  if (state === "confirmed") return "✓";
  if (state === "pending") return "…";
  if (state === "unconfirmed") return "?";
  return "✗";
}

function MachineCard({
  card,
  mode,
  sourceAvailable,
  onReceiveModeChange,
  onOpenSource,
}: {
  card: MachineReportCard;
  mode: ReportReceiveMode;
  sourceAvailable: boolean;
  onReceiveModeChange: (ptySessionId: string, mode: ReportReceiveMode) => void;
  onOpenSource: (card: MachineReportCard) => void;
}) {
  return <article className={`cmux-report-machine-card is-${card.state}`} data-report-inbox-card={card.id} data-report-source-available={sourceAvailable ? "true" : "false"}>
    <div className="cmux-report-machine-card-head">
      <span>{machineStateLabel(card.state)}</span>
      <time>{clockLabel(card.observedAt)}</time>
    </div>
    <div className="cmux-report-machine-detail">{card.detail}</div>
    <div className="cmux-report-machine-detail" data-report-receive-mode={mode}>
      <strong>{dashboardStrings.reportReceiveModeForSession(mode)}</strong>
      <div>{dashboardStrings.reportReceiveModeDescription(mode)}</div>
    </div>
    <div className="cmux-report-machine-actions">
      <label>
        <span>{dashboardStrings.reportReceiveModeLabel}</span>
        <select value={mode} onChange={(event) => onReceiveModeChange(card.ptySessionId, event.target.value as ReportReceiveMode)}>
          <option value="immediate">{dashboardStrings.reportModeImmediate}</option>
          <option value="batch">{dashboardStrings.reportModeBatch}</option>
          <option value="quiet">{dashboardStrings.reportModeQuiet}</option>
        </select>
      </label>
      <button type="button" disabled={!sourceAvailable} title={sourceAvailable ? undefined : dashboardStrings.reportSourceUnavailable} onClick={() => {
        if (sourceAvailable) onOpenSource(card);
      }}>{dashboardStrings.reportSourceButton}</button>
    </div>
    {!sourceAvailable ? <div className="cmux-report-machine-detail" role="status" data-report-source-unavailable>{dashboardStrings.reportSourceUnavailable}</div> : null}
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

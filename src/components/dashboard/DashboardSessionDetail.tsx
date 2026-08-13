import type { CSSProperties } from "react";

import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { useRecentInputStore } from "../../stores/recentInputStore";
import { attentionDetail, useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { useDashboardViewStore, type DashboardDetailTab } from "../../stores/dashboardViewStore";
import { DashboardTerminalTab } from "./DashboardTerminalTab";
import { ChatTranscript } from "./ChatTranscript";
import { EventTimeline } from "./EventTimeline";
import { QuestionCard } from "./QuestionCard";
import { displayStateColor, displayStateLabel, stallLabel, statePillStyle } from "./DashboardSessionList";
import { resolveDisplayState, type DashboardCardModel } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";

/** [現在] タブに出す直近の行数。全量は [経緯] タブ。 */
const NOW_TIMELINE_ROWS = 15;
const HISTORY_TIMELINE_ROWS = 200;

const DETAIL_TABS: ReadonlyArray<[DashboardDetailTab, string]> = [
  ["chat", dashboardStrings.tabChat],
  ["now", dashboardStrings.tabNow],
  ["history", dashboardStrings.tabHistory],
  ["terminal", dashboardStrings.tabTerminal],
];

function SummaryLine({ label, value }: { label: string; value: string }) {
  return <div style={summaryLineStyle}>
    <span style={summaryLabelStyle}>{label}</span>
    <span style={{ minWidth: 0 }}>{value}</span>
  </div>;
}

/** telemetry が生きていない時に、xterm 側から拾える分だけ出す。空白の画面にしない。 */
function TelemetryFallback({ card, now }: { card: DashboardCardModel; now: number }) {
  const recentInput = useRecentInputStore((store) => store.recentBySession[card.tab.sessionId]);
  const asking = attentionDetail(card.attention);
  const reason = card.telemetryHealth === "unavailable"
    ? dashboardStrings.telemetryUnavailable
    : dashboardStrings.telemetryUnlinked;
  return <section style={fallbackStyle}>
    <div style={{ color: "var(--cmux-text-secondary)" }}>{reason}</div>
    <div style={summaryBlockStyle}>
      <div style={sectionTitleStyle}>{dashboardStrings.fallbackTitle}</div>
      {recentInput ? <SummaryLine label={dashboardStrings.myInstructionLabel} value={recentInput.text} /> : null}
      {asking ? <SummaryLine label={dashboardStrings.agentAskingLabel} value={asking} /> : null}
      {card.stall ? <SummaryLine label={stallLabel(card.stall.reason)} value={dashboardStrings.stallSince(Math.max(0, Math.floor((now - card.stall.since) / 60_000)))} /> : null}
      {card.lastLog ? <div style={lastLogStyle}>{card.lastLog}</div> : null}
    </div>
    <div style={{ color: "var(--cmux-text-tertiary)" }}>{dashboardStrings.fallbackHint}</div>
  </section>;
}

export function DashboardSessionDetail({ card, now, onJump, onFocusComposer }: {
  card: DashboardCardModel | null;
  now: number;
  onJump: (card: DashboardCardModel) => void;
  onFocusComposer: () => void;
}) {
  const detailTab = useDashboardViewStore((state) => state.detailTab);
  const setDetailTab = useDashboardViewStore((state) => state.setDetailTab);
  const markSeen = useSessionAttentionStore((state) => state.markSeen);
  const events = useLiveBriefStore((state) => (card ? state.eventsBySession[card.tab.sessionId] : undefined));

  if (!card) {
    return <section style={paneStyle}>
      <div style={emptyStyle}>{dashboardStrings.detailEmpty}</div>
    </section>;
  }

  const state = resolveDisplayState(card);
  const ended = card.telemetryHealth === "ended";
  // 終了後も要約は保持された内容をそのまま出す (fallback へ落とさない)。
  const live = card.telemetryHealth === "live" || ended;
  const elapsedMinutes = card.noUpdateMinutes
    ?? (card.lastActivityAt ? Math.max(0, Math.floor((now - card.lastActivityAt) / 60_000)) : null);
  const elapsedText = elapsedMinutes === null
    ? ""
    : state === "noUpdate"
      ? dashboardStrings.noUpdateFor(elapsedMinutes)
      : dashboardStrings.elapsed(elapsedMinutes);
  const timelineEvents = events ?? [];

  return <section style={paneStyle}>
    <header style={headerStyle}>
      <div style={breadcrumbStyle}>{dashboardStrings.breadcrumb(card.workspace.name, card.tabIndex + 1, card.paneIndex + 1)}</div>
      {card.neverStarted
        ? <span style={statePillStyle("var(--cmux-text-tertiary)")}>{dashboardStrings.stateNotStarted}</span>
        : <span style={statePillStyle(displayStateColor(state))}>{displayStateLabel(state)}</span>}
      {ended ? <span style={statePillStyle("var(--cmux-text-tertiary)")}>{dashboardStrings.telemetryEnded}</span> : null}
      <span style={elapsedStyle}>{elapsedText}</span>
      {card.attentionCategory === "done" && card.attention?.attentionId
        ? <button type="button" style={buttonStyle} onClick={() => markSeen(card.tab.id, card.attention?.attentionId ?? "")}>{dashboardStrings.markReadButton}</button>
        : null}
      <button type="button" style={buttonStyle} onClick={() => onJump(card)}>{dashboardStrings.jumpButtonTitle}</button>
    </header>
    {card.metadata?.cwd ? <div style={cwdStyle}>{card.metadata.cwd}</div> : null}
    <nav style={tabBarStyle}>
      {DETAIL_TABS.map(([id, label]) => <button
        key={id}
        type="button"
        aria-pressed={detailTab === id}
        onClick={() => setDetailTab(id)}
        style={{
          ...tabButtonStyle,
          color: detailTab === id ? "var(--cmux-text)" : "var(--cmux-text-secondary)",
          borderBottomColor: detailTab === id ? "var(--cmux-accent)" : "transparent",
        }}
      >{label}</button>)}
    </nav>
    {detailTab === "chat" ? <div style={nowStyle}>
      <ChatTranscript events={timelineEvents} />
      {ended || state !== "needsHuman" ? null : <QuestionCard
        brief={card.brief}
        events={timelineEvents}
        targetLabel={`${card.workspace.name} › ${card.label}`}
        onFocusComposer={onFocusComposer}
      />}
    </div> : null}
    {detailTab === "terminal" ? <DashboardTerminalTab sessionId={card.tab.sessionId} /> : null}
    {detailTab === "history" ? <EventTimeline events={timelineEvents} limit={HISTORY_TIMELINE_ROWS} /> : null}
    {detailTab === "now" ? <div style={nowStyle}>
      {card.neverStarted ? <section style={summaryBlockStyle}>
        <div style={{ color: "var(--cmux-text-secondary)" }}>{dashboardStrings.notStartedDetail}</div>
      </section> : live ? <section style={summaryBlockStyle}>
        <div style={sectionTitleStyle}>{dashboardStrings.liveBriefTitle}</div>
        {card.task ? <SummaryLine label={dashboardStrings.liveBriefTaskLabel} value={card.task} /> : null}
        {card.activityText ? <SummaryLine label={dashboardStrings.liveBriefActivityLabel} value={card.activityText} /> : null}
        {card.checkpoint ? <SummaryLine label={dashboardStrings.liveBriefCheckpointLabel} value={card.checkpoint} /> : null}
        {card.stall ? <SummaryLine label={stallLabel(card.stall.reason)} value={dashboardStrings.stallSince(Math.max(0, Math.floor((now - card.stall.since) / 60_000)))} /> : null}
      </section> : <TelemetryFallback card={card} now={now} />}
      {card.neverStarted ? null : <>
        <EventTimeline events={timelineEvents} limit={NOW_TIMELINE_ROWS} />
        {/* 質問カードはタイムラインの下 (フッタ) に置く。終了済みは介入できないので出さない。 */}
        {ended || state !== "needsHuman" ? null : <QuestionCard
          brief={card.brief}
          events={timelineEvents}
          targetLabel={`${card.workspace.name} › ${card.label}`}
          onFocusComposer={onFocusComposer}
        />}
      </>}
    </div> : null}
  </section>;
}

const paneStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  padding: 12,
  overflow: "hidden",
};
const headerStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" };
const breadcrumbStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--cmux-font-size-md)",
  fontWeight: 700,
};
const elapsedStyle: CSSProperties = { flex: "0 0 auto", color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-sm)" };
const buttonStyle: CSSProperties = {
  flex: "0 0 auto",
  background: "transparent",
  border: "1px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-sm)",
  color: "var(--cmux-text)",
  cursor: "pointer",
  fontSize: "var(--cmux-font-size-sm)",
  padding: "3px 8px",
};
const cwdStyle: CSSProperties = {
  marginTop: 4,
  fontFamily: "var(--cmux-font-mono)",
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-tertiary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const tabBarStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  margin: "10px 0 8px",
  borderBottom: "1px solid var(--cmux-border)",
};
const tabButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  borderBottom: "2px solid transparent",
  cursor: "pointer",
  fontSize: "var(--cmux-font-size-sm)",
  padding: "5px 10px",
};
const nowStyle: CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 };
const summaryBlockStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  padding: 9,
  border: "1px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-sm)",
  background: "var(--cmux-surface)",
  fontSize: "var(--cmux-font-size-sm)",
};
const sectionTitleStyle: CSSProperties = { color: "var(--cmux-text-secondary)", fontWeight: 700 };
const summaryLineStyle: CSSProperties = { display: "flex", gap: 8, minWidth: 0, overflowWrap: "anywhere" };
const summaryLabelStyle: CSSProperties = { flex: "0 0 62px", color: "var(--cmux-text-secondary)" };
const lastLogStyle: CSSProperties = {
  fontFamily: "var(--cmux-font-mono)",
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-tertiary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const fallbackStyle: CSSProperties = { display: "grid", gap: 6, fontSize: "var(--cmux-font-size-sm)" };
const emptyStyle: CSSProperties = { color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-sm)" };

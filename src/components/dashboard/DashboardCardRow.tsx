import { memo } from "react";
import type { CSSProperties } from "react";

import { AgentKindIcon } from "../icons/AgentIcons";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { useRecentInputStore } from "../../stores/recentInputStore";
import { dashboardStrings } from "./dashboardStrings";
import { resolveDisplayState, type DashboardCardModel, type DashboardDisplayState } from "./dashboardModel";
import { latestInstruction as latestInstructionFromEvents, toActivityChain } from "./liveTimelineModel";
import { QuestionCard } from "./QuestionCard";

export function displayStateLabel(state: DashboardDisplayState): string {
  if (state === "needsHuman") return dashboardStrings.stateNeedsHuman;
  if (state === "error") return dashboardStrings.stateError;
  if (state === "running") return dashboardStrings.stateRunning;
  if (state === "noUpdate") return dashboardStrings.stateNoUpdate;
  if (state === "done") return dashboardStrings.stateDone;
  return dashboardStrings.stateIdle;
}

export function displayStateColor(state: DashboardDisplayState): string {
  if (state === "needsHuman") return "var(--status-waiting)";
  if (state === "error") return "var(--status-error)";
  if (state === "running") return "var(--status-working)";
  if (state === "noUpdate") return "var(--cmux-status-stall)";
  if (state === "done") return "var(--status-done)";
  return "var(--cmux-text-tertiary)";
}

export function stallLabel(reason: string): string {
  if (reason === "pty_dead") return dashboardStrings.stallPtyDead;
  if (reason === "queued_input") return dashboardStrings.stallQueuedInput;
  return dashboardStrings.stallNoOutput;
}

/** 状態ピル。一覧行と詳細ヘッダで同じ形にする (地=状態色 15%・文字=状態色)。 */
export function statePillStyle(color: string): CSSProperties {
  return {
    flex: "0 0 auto",
    borderRadius: "var(--cmux-radius-pill)",
    padding: "0 8px",
    fontSize: "var(--cmux-font-size-xs)",
    background: `color-mix(in srgb, ${color} 15%, transparent)`,
    color,
  };
}

/** 「私の指示」の地。タイムラインの instruction 行と同じ見え方にする。 */
export const instructionBlockStyle: CSSProperties = {
  background: "color-mix(in srgb, var(--cmux-accent) 10%, transparent)",
  borderLeft: "2px solid var(--cmux-accent)",
  borderRadius: "0 6px 6px 0",
  padding: "4px 9px",
};

/**
 * 一覧の1行 = モックのカード。要素順は lhead → 私の指示 → ops連鎖 → why停滞 → 質問。
 * 状態は4重に符号化する: 左レール (全状態) / 地 (要対応・エラー・更新なし) /
 * 枠 (同3状態) / 状態ピル。色だけに頼らないための冗長化。
 */
function CardRow({ card, selected, now, onSelect, onJump, onFocusComposer }: {
  card: DashboardCardModel;
  selected: boolean;
  now: number;
  onSelect: (tabId: string) => void;
  onJump: (card: DashboardCardModel) => void;
  onFocusComposer: () => void;
}) {
  const state = resolveDisplayState(card);
  const recentInput = useRecentInputStore((store) => store.recentBySession[card.tab.sessionId]);
  // 一覧行は「一覧スライス」だけを見る。詳細 (200件) とは別物なので混ぜない。
  const listEvents = useLiveBriefStore((store) => store.listEventsBySession[card.tab.sessionId]);
  const notStarted = card.neverStarted;
  const live = card.telemetryHealth === "live";
  const ended = card.telemetryHealth === "ended";
  // brief 直結を最優先。イベント未着の初回でも指示が空にならない。
  const instruction = card.latestInstruction
    ?? (listEvents ? latestInstructionFromEvents(listEvents) : null)
    ?? recentInput?.text
    ?? null;
  const chain = listEvents?.length ? toActivityChain(listEvents) : [];
  const reason = card.telemetryHealth === "unavailable"
    ? dashboardStrings.telemetryUnavailable
    : card.telemetryHealth === "unlinked" ? dashboardStrings.telemetryUnlinked : null;
  const elapsedMinutes = card.noUpdateMinutes
    ?? (card.lastActivityAt ? Math.max(0, Math.floor((now - card.lastActivityAt) / 60_000)) : null);
  const stateColor = displayStateColor(state);
  // 地と枠を状態色に寄せるのは「人間の手が要る」3状態だけ。作業中・完了は素の面のまま。
  const emphasized = state === "needsHuman" || state === "error" || state === "noUpdate";
  const folded = state === "done";

  const openTerminal = () => {
    onSelect(card.tab.id);
    useDashboardViewStore.getState().setDetailTab("terminal");
  };

  return <div
    className="cmux-dash-row"
    role="button"
    tabIndex={-1}
    data-dashboard-row={card.tab.id}
    onClick={() => onSelect(card.tab.id)}
    onDoubleClick={() => onJump(card)}
    style={{
      ...cardStyle,
      ...(folded ? foldedStyle : null),
      background: emphasized ? `color-mix(in srgb, ${stateColor} 8%, transparent)` : "var(--cmux-surface)",
      borderColor: selected
        ? "var(--cmux-accent)"
        : emphasized ? `color-mix(in srgb, ${stateColor} 25%, transparent)` : "var(--cmux-border)",
      borderLeftColor: stateColor,
      boxShadow: selected ? "0 0 0 1px var(--cmux-accent)" : undefined,
    }}
  >
    <div style={headLineStyle}>
      <AgentKindIcon kind={card.agentKind === "none" ? undefined : card.agentKind} size={20} />
      <strong style={labelStyle}>{card.label}</strong>
      <span style={workspaceBadgeStyle}>{card.workspace.name}</span>
      <span style={positionBadgeStyle}>{dashboardStrings.paneLocation(card.tabIndex + 1, card.paneIndex + 1)}</span>
      {notStarted
        ? <span style={statePillStyle("var(--cmux-text-tertiary)")}>{dashboardStrings.stateNotStarted}</span>
        : <span style={statePillStyle(stateColor)}>{displayStateLabel(state)}</span>}
      {ended ? <span style={statePillStyle("var(--cmux-text-tertiary)")}>{dashboardStrings.telemetryEnded}</span> : null}
      <span style={elapsedStyle}>{elapsedMinutes === null ? "" : dashboardStrings.elapsed(elapsedMinutes)}</span>
      {/* モックは「移動 ▸」。短縮語は dashboardStrings に無いので既存文言をそのまま使う。 */}
      <button
        type="button"
        title={dashboardStrings.jumpButtonTitle}
        style={jumpButtonStyle}
        onClick={(event) => { event.stopPropagation(); onJump(card); }}
      >{`${dashboardStrings.jumpButtonTitle} ▸`}</button>
    </div>
    {folded ? null : <>
      {notStarted
        // 未起動: 断定できるのは「まだ開いていない」ことと置き場所だけ。
        ? (card.metadata?.cwd ? <div style={monoLineStyle}>{card.metadata.cwd}</div> : null)
        : <>
          {instruction
            ? <div style={instructionStyle}>
              <span style={instructionTagStyle}>{dashboardStrings.myInstructionLabel}</span>
              {instruction}
            </div>
            // 指示がまだ拾えていない live 行を空にしない (brief の目的で埋める)。
            : (live || ended) && card.task
              ? <div style={instructionStyle}>
                <span style={instructionTagStyle}>{dashboardStrings.liveBriefTaskLabel}</span>
                {card.task}
              </div>
              : null}
          {live || ended
            ? <>
              {chain.length
                ? <div style={chainStyle}>
                  {chain.map((item, index) => <span key={item.id}>
                    {index ? <span style={chainArrowStyle}>{" → "}</span> : null}
                    {`${item.tool}${item.target ? `(${item.target})` : ""}${item.count > 1 ? ` ×${item.count}` : ""}`}
                    {item.ok === undefined
                      ? null
                      : <span style={{ color: item.ok ? "var(--status-done)" : "var(--status-error)" }}>{item.ok ? " ✓" : " ✗"}</span>}
                  </span>)}
                </div>
                : card.activityText ? <div style={activityStyle}>{card.activityText}</div> : null}
              {card.checkpoint ? <div style={checkpointStyle}>{`✓ ${card.checkpoint}`}</div> : null}
            </>
            : <>
              {reason ? <div style={activityStyle}>{reason}</div> : null}
              {card.lastLog ? <div style={monoLineStyle}>{card.lastLog}</div> : null}
            </>}
          {/* なぜ止まって見えるのかを行の中で言い切り、その場で端末へ降りられるようにする。 */}
          {state === "noUpdate" ? <div style={stallStyle}>
            <strong>{card.stall ? stallLabel(card.stall.reason) : dashboardStrings.stallNoOutput}</strong>
            <span style={stallDetailStyle}>{dashboardStrings.stallSince(
              card.stall
                ? Math.max(0, Math.floor((now - card.stall.since) / 60_000))
                : elapsedMinutes ?? 0,
            )}</span>
            <button
              type="button"
              style={stallButtonStyle}
              onClick={(event) => { event.stopPropagation(); openTerminal(); }}
            >{dashboardStrings.openTerminalButton}</button>
          </div> : null}
        </>}
      {/* 要対応の行だけ、その場で答えられる質問カードを畳んで出す。 */}
      {state === "needsHuman" ? <QuestionCard
        brief={card.brief}
        events={listEvents}
        targetLabel={`${card.workspace.name} › ${card.label}`}
        onFocusComposer={onFocusComposer}
        compact
      /> : null}
    </>}
  </div>;
}

export const DashboardCardRow = memo(CardRow);

const cardStyle: CSSProperties = {
  display: "grid",
  gap: 5,
  minWidth: 0,
  padding: "8px 11px",
  border: "1px solid var(--cmux-border)",
  borderLeft: "3px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-card)",
  cursor: "pointer",
};
/** 完了は畳む: 見出し1行だけ残して面積と彩度を落とす。 */
const foldedStyle: CSSProperties = { padding: "5px 11px", opacity: 0.72 };
const headLineStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0 };
const labelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--cmux-font-size-md)",
};
const oneLineStyle: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const workspaceBadgeStyle: CSSProperties = {
  ...oneLineStyle,
  flex: "0 1 auto",
  maxWidth: "34%",
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-xs)",
};
/** 英数字と区切りだけのバッジなので 10px を許す (日本語行の下限は 11px)。 */
const positionBadgeStyle: CSSProperties = {
  flex: "0 0 auto",
  border: "1px solid var(--cmux-border)",
  borderRadius: 4,
  padding: "0 5px",
  color: "var(--cmux-text-secondary)",
  fontSize: 10,
};
const elapsedStyle: CSSProperties = {
  flex: "0 0 auto",
  marginLeft: "auto",
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-xs)",
};
const jumpButtonStyle: CSSProperties = {
  flex: "0 0 auto",
  background: "transparent",
  border: "1px solid color-mix(in srgb, var(--cmux-accent) 45%, transparent)",
  borderRadius: "var(--cmux-radius-md)",
  color: "var(--cmux-accent-text)",
  cursor: "pointer",
  fontSize: "var(--cmux-font-size-xs)",
  padding: "1px 8px",
};
const instructionStyle: CSSProperties = {
  ...instructionBlockStyle,
  minWidth: 0,
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflow: "hidden",
  fontSize: "var(--cmux-font-size-sm)",
  color: "var(--cmux-text)",
};
const instructionTagStyle: CSSProperties = {
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-xs)",
  marginRight: 6,
};
const chainStyle: CSSProperties = {
  ...oneLineStyle,
  fontFamily: "var(--cmux-font-mono)",
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-secondary)",
};
const chainArrowStyle: CSSProperties = { color: "var(--cmux-text-tertiary)" };
/** cwd / 生ログのような「原文そのまま」の 1 行。 */
const monoLineStyle: CSSProperties = { ...chainStyle, color: "var(--cmux-text-tertiary)" };
/** ツール連鎖が無いときに brief 由来の実行中テキストを出す行 (等幅にしない)。 */
const activityStyle: CSSProperties = {
  ...oneLineStyle,
  fontSize: "var(--cmux-font-size-sm)",
  color: "var(--cmux-text-secondary)",
};
const checkpointStyle: CSSProperties = {
  ...oneLineStyle,
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--status-done)",
};
const stallStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  minWidth: 0,
  padding: "4px 9px",
  borderRadius: 7,
  border: "1px solid color-mix(in srgb, var(--cmux-status-stall) 25%, transparent)",
  background: "color-mix(in srgb, var(--cmux-status-stall) 10%, transparent)",
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text)",
};
const stallDetailStyle: CSSProperties = { ...oneLineStyle, flex: "1 1 auto", color: "var(--cmux-text-secondary)" };
const stallButtonStyle: CSSProperties = {
  flex: "0 0 auto",
  marginLeft: "auto",
  background: "transparent",
  border: "1px solid color-mix(in srgb, var(--cmux-status-stall) 45%, transparent)",
  borderRadius: "var(--cmux-radius-md)",
  color: "var(--cmux-text)",
  cursor: "pointer",
  fontSize: "var(--cmux-font-size-xs)",
  padding: "1px 8px",
};

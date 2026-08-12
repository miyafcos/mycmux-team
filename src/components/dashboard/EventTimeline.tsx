import { useCallback, useEffect, useRef } from "react";
import type { CSSProperties } from "react";

import type { SemanticEventEnvelope } from "../../lib/livebrief";
import { instructionBlockStyle } from "./DashboardCardRow";
import { dashboardStrings } from "./dashboardStrings";
import { toTimelineRows, type TimelineRow } from "./liveTimelineModel";

/** 末尾からこの距離までなら「下を見ている」と扱い、新着で追従する。 */
const FOLLOW_SLACK_PX = 24;

function clockLabel(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * stampCount が title の末尾へ ` ×N` を焼いているので、target を挟むために一度剥がす。
 * (liveTimelineModel は変更禁止のため、表示側で組み直す。)
 */
function toolLabel(row: TimelineRow): string {
  const base = row.count > 1 ? row.title.replace(/ ×\d+$/u, "") : row.title;
  const target = row.target ? `(${row.target})` : "";
  const count = row.count > 1 ? ` ×${row.count}` : "";
  return `${base}${target}${count}`;
}

function okColor(ok: boolean | undefined): string {
  if (ok === undefined) return "var(--cmux-text-secondary)";
  return ok ? "var(--status-done)" : "var(--status-error)";
}

function RowBody({ row }: { row: TimelineRow }) {
  switch (row.kind) {
    case "instruction":
      return <div style={instructionStyle}>{row.title}</div>;
    case "answer":
      return <div style={answerStyle}>{row.title}</div>;
    case "agentText":
      return <div style={agentTextStyle}>{`● ${row.title}`}</div>;
    case "tool":
      return <div style={monoStyle}>
        <span>{toolLabel(row)}</span>
        {row.detail ? <span style={{ marginLeft: 6, color: okColor(row.ok) }}>{row.detail}</span> : null}
      </div>;
    case "result":
      return <div style={{ ...resultStyle, color: okColor(row.ok) }}>
        <span style={resultMarkStyle}>⎿ </span>
        <span>{toolLabel(row)}</span>
        {row.detail ? <span style={{ marginLeft: 6 }}>{row.detail}</span> : null}
      </div>;
    case "question":
      return <div style={questionStyle}>{row.title}</div>;
    case "error":
      return <div style={errorStyle}>{row.title}</div>;
    case "test":
      return <div style={{ ...monoStyle, color: okColor(row.ok) }}>{`${row.ok ? "✓" : "✗"} ${row.title}`}</div>;
    case "file":
      return <div style={monoStyle}>
        <span>{row.title}</span>
        {row.detail ? <span style={{ marginLeft: 6, color: "var(--cmux-text-tertiary)" }}>{row.detail}</span> : null}
      </div>;
    default:
      return null;
  }
}

export function EventTimeline({ events, limit }: {
  events: readonly SemanticEventEnvelope[];
  limit: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const rows = toTimelineRows(events, { limit });

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX;
  }, []);

  // 新しい行が増えたときだけ末尾へ寄せる。上へスクロール中の人は動かさない。
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [rows.length, rows[rows.length - 1]?.id]);

  if (!rows.length) {
    return <div style={emptyStyle}>{dashboardStrings.timelineEmpty}</div>;
  }
  return <div
    ref={scrollRef}
    onScroll={onScroll}
    role="log"
    aria-label={dashboardStrings.timelineAriaLabel}
    style={scrollStyle}
  >
    {rows.map((row) => <div key={row.id} style={rowStyle}>
      <span style={clockStyle}>{clockLabel(row.at)}</span>
      <div style={{ minWidth: 0 }}><RowBody row={row} /></div>
    </div>)}
  </div>;
}

const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "grid",
  gap: 4,
  alignContent: "start",
};
const rowStyle: CSSProperties = { display: "grid", gridTemplateColumns: "38px minmax(0, 1fr)", gap: 6, alignItems: "baseline" };
const clockStyle: CSSProperties = {
  color: "var(--cmux-text-tertiary)",
  fontSize: "var(--cmux-font-size-xs)",
  fontFamily: "var(--cmux-font-mono)",
};
// 日本語が入りうる行は sm (12px) 以上。mono のパス・ツール行だけ xs を許す。
const textStyle: CSSProperties = {
  fontSize: "var(--cmux-font-size-sm)",
  lineHeight: 1.75,
  overflowWrap: "anywhere",
};
/** 「私の指示」は一覧カードと同じ面にして、どこで見ても同じものだと分かるようにする。 */
const instructionStyle: CSSProperties = {
  ...textStyle,
  ...instructionBlockStyle,
  color: "var(--cmux-text)",
};
const answerStyle: CSSProperties = { ...textStyle, paddingLeft: 9, color: "var(--cmux-text-secondary)" };
const agentTextStyle: CSSProperties = { ...textStyle, color: "var(--cmux-text)" };
const questionStyle: CSSProperties = {
  ...textStyle,
  background: "color-mix(in srgb, var(--status-waiting) 10%, transparent)",
  borderRadius: "var(--cmux-radius-sm)",
  color: "var(--status-waiting)",
  padding: "3px 7px",
};
const errorStyle: CSSProperties = { ...textStyle, color: "var(--status-error)" };
const monoStyle: CSSProperties = {
  fontSize: "var(--cmux-font-size-xs)",
  fontFamily: "var(--cmux-font-mono)",
  lineHeight: 1.75,
  color: "var(--cmux-text-secondary)",
  overflowWrap: "anywhere",
};
/** 結果行は ⎿ をぶら下げて、折り返しが本文の頭に揃うようにする。 */
const resultStyle: CSSProperties = { ...monoStyle, paddingLeft: 14, textIndent: -14 };
const resultMarkStyle: CSSProperties = { color: "var(--cmux-text-tertiary)" };
const emptyStyle: CSSProperties = {
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-sm)",
  padding: "8px 0",
};

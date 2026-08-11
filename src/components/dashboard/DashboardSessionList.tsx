import { memo, useEffect, useMemo, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";

import { AgentKindIcon } from "../icons/AgentIcons";
import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { useRecentInputStore } from "../../stores/recentInputStore";
import { dashboardStrings } from "./dashboardStrings";
import { resolveDisplayState, type DashboardCardModel, type DashboardDisplayState } from "./dashboardModel";
import { latestInstruction, toActivityChain } from "./liveTimelineModel";

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
  if (state === "noUpdate") return "var(--cmux-yellow)";
  if (state === "done") return "var(--status-done)";
  return "var(--cmux-text-tertiary)";
}

/**
 * 並べ替えの凍結。ポインタが一覧の上にある間 (と検索入力にフォーカスがある間) は
 * 直前の並びを維持して、クリックしようとした行が足元で入れ替わるのを防ぐ。
 * 凍結中に現れた行は末尾に足し、消えた行は落とすだけで、既存の相対順は動かさない。
 */
export function useFrozenCardOrder(
  cards: readonly DashboardCardModel[],
  frozen: boolean,
): DashboardCardModel[] {
  const frozenOrderRef = useRef<string[]>([]);
  return useMemo(() => {
    if (!frozen) {
      frozenOrderRef.current = cards.map((card) => card.tab.id);
      return [...cards];
    }
    const byId = new Map(cards.map((card) => [card.tab.id, card] as const));
    const kept: DashboardCardModel[] = [];
    for (const id of frozenOrderRef.current) {
      const card = byId.get(id);
      if (card) {
        kept.push(card);
        byId.delete(id);
      }
    }
    for (const card of cards) {
      if (byId.has(card.tab.id)) kept.push(card);
    }
    frozenOrderRef.current = kept.map((card) => card.tab.id);
    return kept;
  }, [cards, frozen]);
}

function SessionRow({ card, selected, now, onSelect, onJump }: {
  card: DashboardCardModel;
  selected: boolean;
  now: number;
  onSelect: (tabId: string) => void;
  onJump: (card: DashboardCardModel) => void;
}) {
  const state = resolveDisplayState(card);
  const recentInput = useRecentInputStore((store) => store.recentBySession[card.tab.sessionId]);
  const events = useLiveBriefStore((store) => store.eventsBySession[card.tab.sessionId]);
  const instruction = (events ? latestInstruction(events) : null) ?? recentInput?.text ?? null;
  const chain = events ? toActivityChain(events) : [];
  const chainText = chain
    .map((item) => `${item.tool}${item.target ? `(${item.target})` : ""}${item.count > 1 ? ` ×${item.count}` : ""}`)
    .join(" → ");
  const elapsedMinutes = card.noUpdateMinutes
    ?? (card.lastActivityAt ? Math.max(0, Math.floor((now - card.lastActivityAt) / 60_000)) : null);
  const needsHuman = state === "needsHuman" || state === "error";

  return <div
    role="button"
    tabIndex={-1}
    data-dashboard-row={card.tab.id}
    onClick={() => onSelect(card.tab.id)}
    onDoubleClick={() => onJump(card)}
    style={{
      ...rowStyle,
      background: selected
        ? "color-mix(in srgb, var(--cmux-accent) 14%, transparent)"
        : needsHuman
          ? `color-mix(in srgb, ${displayStateColor(state)} 8%, transparent)`
          : "transparent",
      borderColor: selected ? "var(--cmux-accent)" : "var(--cmux-border)",
      opacity: state === "done" ? 0.68 : 1,
    }}
  >
    <div style={headLineStyle}>
      <AgentKindIcon kind={card.agentKind === "none" ? undefined : card.agentKind} size={14} />
      <strong style={labelStyle}>{card.label}</strong>
      <span style={{ ...chipStyle, color: displayStateColor(state), borderColor: displayStateColor(state) }}>{displayStateLabel(state)}</span>
      <span style={elapsedStyle}>{elapsedMinutes === null ? "" : dashboardStrings.elapsed(elapsedMinutes)}</span>
    </div>
    <div style={locationStyle}>
      {`${card.workspace.name} › ${dashboardStrings.paneLocation(card.tabIndex + 1, card.paneIndex + 1)}`}
    </div>
    {instruction ? <div style={instructionStyle}>
      <span style={instructionTagStyle}>{dashboardStrings.myInstructionLabel}</span>
      <span style={oneLineStyle}>{instruction}</span>
    </div> : null}
    {chainText ? <div style={chainStyle}>{chainText}</div> : null}
  </div>;
}

const MemoSessionRow = memo(SessionRow);

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <section style={{ display: "grid", gap: 4 }}>
    <div style={sectionHeadingStyle}>{title} <span style={{ color: "var(--cmux-text-tertiary)" }}>{dashboardStrings.countUnit(count)}</span></div>
    {children}
  </section>;
}

export function DashboardSessionList({
  needsHuman,
  all,
  selectedTabId,
  now,
  onSelect,
  onJump,
  onHoverChange,
}: {
  needsHuman: readonly DashboardCardModel[];
  all: readonly DashboardCardModel[];
  selectedTabId: string | null;
  now: number;
  onSelect: (tabId: string) => void;
  onJump: (card: DashboardCardModel) => void;
  onHoverChange: (hovered: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef(false);

  // キーボードで選択が動いたときだけ追う。マウス操作中は勝手にスクロールしない。
  useEffect(() => {
    if (hoveredRef.current || !selectedTabId) return;
    const rows = [...(scrollRef.current?.querySelectorAll("[data-dashboard-row]") ?? [])]
      .filter((node) => node.getAttribute("data-dashboard-row") === selectedTabId);
    rows[rows.length - 1]?.scrollIntoView({ block: "nearest" });
  }, [selectedTabId]);

  return <div
    ref={scrollRef}
    role="group"
    aria-label={dashboardStrings.sessionListAriaLabel}
    onPointerEnter={() => { hoveredRef.current = true; onHoverChange(true); }}
    onPointerLeave={() => { hoveredRef.current = false; onHoverChange(false); }}
    style={listStyle}
  >
    {needsHuman.length ? <Section title={dashboardStrings.sectionNeedsHuman} count={needsHuman.length}>
      {needsHuman.map((card) => <MemoSessionRow
        key={`needs-${card.tab.id}`}
        card={card}
        selected={card.tab.id === selectedTabId}
        now={now}
        onSelect={onSelect}
        onJump={onJump}
      />)}
    </Section> : null}
    <Section title={dashboardStrings.sectionAllSessions} count={all.length}>
      {all.length
        ? all.map((card) => <MemoSessionRow
          key={card.tab.id}
          card={card}
          selected={card.tab.id === selectedTabId}
          now={now}
          onSelect={onSelect}
          onJump={onJump}
        />)
        : <div style={emptyStyle}>{dashboardStrings.listEmpty}</div>}
    </Section>
  </div>;
}

const listStyle: CSSProperties = {
  flex: "0 0 clamp(420px, 36vw, 520px)",
  width: "clamp(420px, 36vw, 520px)",
  overflowY: "auto",
  borderRight: "1px solid var(--cmux-border)",
  background: "var(--cmux-popover)",
  padding: 10,
  display: "grid",
  gap: 14,
  alignContent: "start",
};
const sectionHeadingStyle: CSSProperties = {
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-sm)",
  fontWeight: 700,
  padding: "0 2px",
};
const rowStyle: CSSProperties = {
  display: "grid",
  gap: 3,
  minWidth: 0,
  padding: "7px 9px",
  border: "1px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-md)",
  cursor: "pointer",
};
const headLineStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0 };
const labelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--cmux-font-size-sm)",
};
const chipStyle: CSSProperties = {
  flex: "0 0 auto",
  border: "1px solid var(--cmux-border)",
  borderRadius: 999,
  padding: "0 6px",
  fontSize: "var(--cmux-font-size-sm)",
};
const elapsedStyle: CSSProperties = {
  flex: "0 0 auto",
  color: "var(--cmux-text-tertiary)",
  fontSize: "var(--cmux-font-size-sm)",
};
const oneLineStyle: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const locationStyle: CSSProperties = {
  ...oneLineStyle,
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-sm)",
};
const instructionStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  minWidth: 0,
  fontSize: "var(--cmux-font-size-sm)",
  color: "var(--cmux-text-secondary)",
};
const instructionTagStyle: CSSProperties = { flex: "0 0 auto", color: "var(--cmux-text-tertiary)" };
const chainStyle: CSSProperties = {
  ...oneLineStyle,
  fontFamily: "var(--cmux-font-mono)",
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-tertiary)",
};
const emptyStyle: CSSProperties = {
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-sm)",
  padding: "8px 2px",
};

import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";

import { DashboardCardRow } from "./DashboardCardRow";
import { dashboardStrings } from "./dashboardStrings";
import type { DashboardCardModel } from "./dashboardModel";

// 行の見た目と状態語は DashboardCardRow が持つ。詳細ペインが従来どおり
// このモジュールから取れるように、ここで通しておく。
export { displayStateColor, displayStateLabel, stallLabel, statePillStyle } from "./DashboardCardRow";

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

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <section style={{ display: "grid", gap: 8 }}>
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
  onFocusComposer,
}: {
  needsHuman: readonly DashboardCardModel[];
  all: readonly DashboardCardModel[];
  selectedTabId: string | null;
  now: number;
  onSelect: (tabId: string) => void;
  onJump: (card: DashboardCardModel) => void;
  onHoverChange: (hovered: boolean) => void;
  onFocusComposer: () => void;
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
      {needsHuman.map((card) => <DashboardCardRow
        key={`needs-${card.tab.id}`}
        card={card}
        selected={card.tab.id === selectedTabId}
        now={now}
        onSelect={onSelect}
        onJump={onJump}
        onFocusComposer={onFocusComposer}
      />)}
    </Section> : null}
    <Section title={dashboardStrings.sectionAllSessions} count={all.length}>
      {all.length
        ? all.map((card) => <DashboardCardRow
          key={card.tab.id}
          card={card}
          selected={card.tab.id === selectedTabId}
          now={now}
          onSelect={onSelect}
          onJump={onJump}
          onFocusComposer={onFocusComposer}
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
  // カードを面として浮かせたいので、一覧の地はカードより暗い側に置く。
  background: "var(--cmux-bg)",
  padding: "9px 12px",
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
const emptyStyle: CSSProperties = {
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-sm)",
  padding: "8px 2px",
};

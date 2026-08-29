import { useEffect, useMemo, useRef } from "react";
import type { ReactNode, RefObject } from "react";

import { DashboardCardRow } from "./DashboardCardRow";
import { dashboardStrings } from "./dashboardStrings";
import type { DashboardCardModel } from "./dashboardModel";
import { groupCardsByAttentionSection } from "./dashboardAttentionOrder";

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
  return <section className="cmux-dash-list-section">
    <div className="cmux-dash-list-heading">{`${title} (${count})`}</div>
    {children}
  </section>;
}

export function DashboardSessionList({
  needsHuman,
  all,
  deferred,
  hideWorkspaceBadge,
  selectedTabId,
  now,
  onSelect,
  onJump,
  onHoverChange,
  query,
  searchInputRef,
  onQueryChange,
  onSearchFocusChange,
  onClose,
  clearDoneCount,
  onClearDone,
  filteredSummary,
  reportInboxOpen,
  onOpenReportInbox,
  openTabIds,
  collapsed,
  onToggleCollapsed,
}: {
  needsHuman: readonly DashboardCardModel[];
  all: readonly DashboardCardModel[];
  deferred: readonly DashboardCardModel[];
  hideWorkspaceBadge: boolean;
  selectedTabId: string | null;
  now: number;
  onSelect: (tabId: string) => void;
  onJump: (card: DashboardCardModel) => void;
  onHoverChange: (hovered: boolean) => void;
  query: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (query: string) => void;
  onSearchFocusChange: (focused: boolean) => void;
  onClose: () => void;
  clearDoneCount: number;
  onClearDone: () => void;
  filteredSummary: string | null;
  reportInboxOpen: boolean;
  onOpenReportInbox: () => void;
  openTabIds?: readonly string[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const openIds = openTabIds ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef(false);

  // キーボードで選択が動いたときだけ追う。マウス操作中は勝手にスクロールしない。
  useEffect(() => {
    if (hoveredRef.current || !selectedTabId) return;
    const rows = [...(scrollRef.current?.querySelectorAll("[data-dashboard-row]") ?? [])]
      .filter((node) => node.getAttribute("data-dashboard-row") === selectedTabId);
    rows[rows.length - 1]?.scrollIntoView({ block: "nearest" });
  }, [selectedTabId]);

  const attentionSections = useMemo(() => {
    const cards = [...needsHuman, ...all, ...deferred];
    return groupCardsByAttentionSection(cards);
  }, [all, deferred, needsHuman]);

  const row = (card: DashboardCardModel, key: string) => <DashboardCardRow
    key={key}
    card={card}
    selected={card.tab.id === selectedTabId}
    open={openIds.includes(card.tab.id)}
    now={now}
    hideWorkspaceBadge={hideWorkspaceBadge}
    onSelect={onSelect}
    onJump={onJump}
  />;

  return <div
    ref={scrollRef}
    role="group"
    aria-label={dashboardStrings.sessionListAriaLabel}
    aria-expanded={!collapsed}
    data-collapsed={collapsed ? "true" : "false"}
    onPointerEnter={() => { hoveredRef.current = true; onHoverChange(true); }}
    onPointerLeave={() => { hoveredRef.current = false; onHoverChange(false); }}
    className="cmux-dash-list is-attention"
  >
    <div className="cmux-dash-list-toolbar">
      <button
        type="button"
        data-session-list-toggle="true"
        className="cmux-dash-list-toggle"
        aria-pressed={collapsed}
        aria-label={collapsed ? dashboardStrings.sessionListExpandTitle : dashboardStrings.sessionListCollapseTitle}
        title={collapsed ? dashboardStrings.sessionListExpandTitle : dashboardStrings.sessionListCollapseTitle}
        onClick={onToggleCollapsed}
      >
        {collapsed ? dashboardStrings.sessionListExpand : dashboardStrings.sessionListCollapse}
      </button>
      <div className="cmux-dash-list-search">
        <input
          ref={searchInputRef}
          value={query}
          aria-label={dashboardStrings.searchPlaceholder}
          placeholder={dashboardStrings.searchPlaceholder}
          onChange={(event) => onQueryChange(event.target.value)}
          onFocus={() => onSearchFocusChange(true)}
          onBlur={() => onSearchFocusChange(false)}
        />
        {filteredSummary ? <span>{filteredSummary}</span> : null}
      </div>
    </div>
    <button
      type="button"
      data-report-inbox-nav="true"
      className={`cmux-dash-report-nav${reportInboxOpen ? " is-selected" : ""}`}
      aria-pressed={reportInboxOpen}
      aria-label={dashboardStrings.reportInboxTitle}
      title={dashboardStrings.reportInboxTitle}
      onClick={onOpenReportInbox}
    >
      <span className="cmux-dash-report-nav-icon" aria-hidden="true">{dashboardStrings.reportInboxRailIcon}</span>
      <span>{dashboardStrings.reportInboxTitle}</span>
      <small>{dashboardStrings.reportInboxHint}</small>
    </button>
    <div className="cmux-dash-list-scroll">
    <Section title={dashboardStrings.sectionNeedsAnswer} count={attentionSections.needsAnswer.length}>{attentionSections.needsAnswer.map((card) => row(card, `answer-${card.tab.id}`))}</Section>
    <Section title={dashboardStrings.sectionNeedsReview} count={attentionSections.needsReview.length}>{attentionSections.needsReview.map((card) => row(card, `review-${card.tab.id}`))}</Section>
    <Section title={dashboardStrings.sectionWorking} count={attentionSections.working.length}>{attentionSections.working.map((card) => row(card, `working-${card.tab.id}`))}</Section>
    <Section title={dashboardStrings.sectionOther} count={attentionSections.other.length}>{attentionSections.other.map((card) => row(card, `other-${card.tab.id}`))}</Section>
    </div>
    <div className="cmux-dash-list-footer">
      {clearDoneCount > 0 ? <button type="button" onClick={onClearDone}>{dashboardStrings.clearDoneButton(clearDoneCount)}</button> : null}
      <button type="button" onClick={onClose}>{dashboardStrings.backToSession}</button>
    </div>
  </div>;
}

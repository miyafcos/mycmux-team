/**
 * The AI log dashboard overlay.
 *
 * Layout follows the other overlays in the app (backdrop + panel, Escape to
 * close, focus returned on exit). Every control inside is a left click: there is
 * no context menu anywhere in this panel.
 */

import { useEffect, useRef, useState } from "react";

import { OverlayShell } from "../common/OverlayShell";
import { listenIndexProgress, listenSummarizeProgress } from "../../lib/ailog";
import { useAilogStore, SESSION_PAGE_SIZE } from "../../stores/ailogStore";
import { CostHeatmap } from "./CostHeatmap";
import { ModelTable } from "./ModelTable";
import { ProjectTable } from "./ProjectTable";
import { RangeBar } from "./RangeBar";
import { RelationDiagram } from "./RelationDiagram";
import { SessionDetailView } from "./SessionDetailView";
import { SessionTable } from "./SessionTable";
import { SummaryCards } from "./SummaryCards";
import { EmptyState, Section, SkeletonBlock, noteStyle, subtleButtonStyle } from "./ui";

interface AiLogPanelProps {
  open: boolean;
  visible: boolean;
  closing?: boolean;
  onClose: () => void;
}

export function AiLogPanel({ open, visible, closing = false, onClose }: AiLogPanelProps) {
  const wasIndexingRef = useRef(false);
  const wasSummarizingRef = useRef(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const store = useAilogStore();

  // Open: pull the index status first (it decides which empty state applies),
  // then the reports.
  useEffect(() => {
    if (!open) return;
    void store.refreshIndexStatus();
    void store.refreshSummarizeStatus();
    void store.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenSummarizeProgress((progress) => store.applySummarizeProgress(progress)).then((fn) => {
      if (cancelled) fn(); else unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenIndexProgress((progress) => store.applyIndexProgress(progress)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // While a pass is running the status is polled; the moment it stops, the
  // reports are refetched so the new rows appear without a manual reload.
  const running = store.indexStatus?.running ?? false;
  useEffect(() => {
    if (!open) return;
    if (!running) {
      if (wasIndexingRef.current) {
        wasIndexingRef.current = false;
        void store.refresh();
      }
      return;
    }
    wasIndexingRef.current = true;
    const timer = window.setInterval(() => void store.refreshIndexStatus(), 1_500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, running]);

  const summarizing = store.summarizeStatus?.running ?? false;
  useEffect(() => {
    if (!open) return;
    if (!summarizing) {
      if (wasSummarizingRef.current) { wasSummarizingRef.current = false; void store.refresh(); }
      return;
    }
    wasSummarizingRef.current = true;
    const timer = window.setInterval(() => void store.refreshSummarizeStatus(), 1_500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, summarizing]);

  if (!visible) return null;

  const { overview, series, models, projects, sessions, loading, error, indexStatus } = store;
  const statusPending = indexStatus === null && store.indexError === null;
  const neverIndexed = indexStatus !== null && indexStatus.lastFinishedAt === 0;
  const noData = Boolean(overview) && (overview?.totals.sessions ?? 0) === 0;

  const openDetail = (kind: string, sessionId: string) => {
    setDetailOpen(true);
    void store.openDetail(kind, sessionId);
  };
  const closeDetail = () => {
    setDetailOpen(false);
    store.closeDetail();
  };
  const handleEscape = () => {
    if (detailOpen) {
      closeDetail();
      return true;
    }
    return false;
  };

  return (
    <OverlayShell
      open={open}
      closing={closing}
      onClose={onClose}
      onEscape={handleEscape}
      size="full"
      ariaLabel="AIログ分析"
      id="ailog-panel"
    >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 16px",
            borderBottom: "1px solid var(--cmux-border)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>AI ログ分析</div>
            <div role="status" aria-live="polite" style={{ ...noteStyle, marginTop: 2 }}>
              {loading
                ? "集計を更新中…"
                : overview
                  ? `${overview.range.label} · ${overview.totals.sessions.toLocaleString("en-US")} セッション`
                  : "—"}
            </div>
          </div>
          <button type="button" aria-label="閉じる" onClick={onClose} style={{ ...subtleButtonStyle, padding: "3px 8px" }}>
            ×
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 16px 20px", minWidth: 0 }}>
            <RangeBar
              preset={store.preset}
              customFrom={store.customFrom}
              customTo={store.customTo}
              onPreset={store.setPreset}
              onCustomRange={store.setCustomRange}
              overview={overview}
              indexStatus={indexStatus}
              indexProgress={store.indexProgress}
              indexError={store.indexError}
              onStartIndex={() => void store.startIndex(false)}
              onCancelIndex={() => void store.cancelIndex()}
              summarizeStatus={store.summarizeStatus}
              summarizeProgress={store.summarizeProgress}
              summarizeError={store.summarizeError}
              onStartSummarize={() => void store.startSummarize()}
              onCancelSummarize={() => void store.cancelSummarize()}
              onRefresh={() => void store.refresh()}
              loading={loading}
              excludeSynthetic={store.excludeSynthetic}
              onExcludeSynthetic={store.setExcludeSynthetic}
              includeSidechain={store.includeSidechain}
              onIncludeSidechain={store.setIncludeSidechain}
            />

            {error ? (
              <EmptyState kind="error" message={error} onPrimary={() => void store.refresh()} primaryLabel="再試行" />
            ) : loading && !overview ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <SkeletonBlock height={70} label="サマリーを読み込み中" />
                <SkeletonBlock height={160} label="集計を読み込み中" />
              </div>
            ) : noData && statusPending ? (
              <div style={noteStyle}>インデックス状態を確認中です。</div>
            ) : noData ? (
              <EmptyState
                kind={neverIndexed ? "not-indexed" : "no-data"}
                onPrimary={() => void store.startIndex(false)}
                busy={running}
              />
            ) : overview ? (
              <>
                <SummaryCards overview={overview} preset={store.preset} />

                <Section
                  title="期間ヒートマップ"
                  subtitle="日別のコスト相当。ドラッグで期間を選ぶと、下のすべてが連動します。"
                >
                  {series ? <CostHeatmap series={series} onSelectRange={store.setCustomRange} /> : null}
                </Section>

                <Section
                  title="関係図"
                  subtitle="案件 → 作業種別 → モデルのコストの流れ。ノードをクリックすると絞り込みます。"
                >
                  {models && sessions ? (
                    <RelationDiagram
                      models={models}
                      sessions={sessions}
                      excludeSynthetic={store.excludeSynthetic}
                      topN={store.topN}
                      onTopN={store.setTopN}
                      grandTotal={overview.totals.costUsd}
                      selection={store.selection}
                      onSelect={store.setSelection}
                    />
                  ) : null}
                </Section>

                <Section title="モデル別">
                  {models ? (
                    <ModelTable
                      report={models}
                      granularity={store.granularity}
                      onGranularity={store.setGranularity}
                      excludeSynthetic={store.excludeSynthetic}
                      selection={store.selection}
                      onSelect={store.setSelection}
                    />
                  ) : null}
                </Section>

                <Section title="案件別">
                  {projects ? (
                    <ProjectTable
                      report={projects}
                      overview={overview}
                      selection={store.selection}
                      onSelect={store.setSelection}
                    />
                  ) : null}
                </Section>

                <Section title="セッション一覧">
                  {sessions ? (
                    <SessionTable
                      report={sessions}
                      sort={store.sessionSort}
                      onSort={store.setSessionSort}
                      page={store.sessionPage}
                      onPage={store.setSessionPage}
                      pageSize={SESSION_PAGE_SIZE}
                      selection={store.selection}
                      leafDimension={store.leafDimension}
                      onOpenDetail={openDetail}
                      activeKey={store.detailKey}
                    />
                  ) : null}
                </Section>

                {detailOpen ? (
                  <Section title="セッション詳細">
                    {store.detailError ? (
                      <EmptyState
                        kind="error"
                        message={store.detailError}
                        onPrimary={() =>
                          store.detailKey
                            ? void store.openDetail(store.detailKey.kind, store.detailKey.sessionId)
                            : undefined
                        }
                        primaryLabel="再試行"
                      />
                    ) : store.detailLoading ? (
                      <SkeletonBlock height={120} label="詳細を読み込み中" />
                    ) : store.detail ? (
                      <SessionDetailView detail={store.detail} onClose={closeDetail} />
                    ) : null}
                  </Section>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
    </OverlayShell>
  );
}

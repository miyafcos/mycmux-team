import type { BreakdownReport, ModelsReport, Overview, RangePreset, SeriesReport, SessionsReport } from "../../lib/ailog";
import type { AilogSelection, BreakdownDimension, SessionSort, TopNSetting } from "../../stores/ailogStore";
import type { LeafDimension } from "./sankeyModel";
import { CostHeatmap } from "./CostHeatmap";
import { ModelTable } from "./ModelTable";
import { ProjectTable } from "./ProjectTable";
import { RelationDiagram } from "./RelationDiagram";
import { SessionTable } from "./SessionTable";
import { SummaryCards } from "./SummaryCards";
import { ButtonGroup, EmptyState, Section, SkeletonBlock, noteStyle } from "./ui";
import { SESSION_PAGE_SIZE } from "../../stores/ailogStore";

export function RecordBreakdownView(props: {
  overview: Overview | null; series: SeriesReport | null; models: ModelsReport | null; sessions: SessionsReport | null;
  loading: boolean; error: string | null; statusPending: boolean; neverIndexed: boolean; noData: boolean; running: boolean;
  preset: RangePreset; excludeSynthetic: boolean; topN: TopNSetting;
  granularity: "family" | "raw"; selection: AilogSelection | null; breakdownDimension: BreakdownDimension;
  breakdown: BreakdownReport | null; breakdownError: string | null; sessionSort: SessionSort; sessionPage: number;
  leafDimension: LeafDimension; detailKey: { kind: string; sessionId: string } | null;
  onRefresh: () => void; onStartIndex: () => void; onSelectRange: (from: string, to: string) => void;
  onTopN: (layer: keyof TopNSetting, value: number) => void; onGranularity: (value: "family" | "raw") => void;
  onSelect: (selection: AilogSelection | null) => void; onBreakdownDimension: (value: BreakdownDimension) => void;
  onRefreshBreakdown: () => void; onSessionSort: (value: SessionSort) => void; onSessionPage: (value: number) => void;
  onOpenDetail: (kind: string, sessionId: string) => void;
}) {
  const p = props;
  if (p.error) return <EmptyState kind="error" message={p.error} onPrimary={p.onRefresh} primaryLabel="再試行" />;
  if (p.loading && !p.overview) return <div style={{ display: "flex", flexDirection: "column", gap: 10 }}><SkeletonBlock height={70} label="サマリーを読み込み中" /><SkeletonBlock height={160} label="集計を読み込み中" /></div>;
  if (p.noData && p.statusPending) return <div style={noteStyle}>インデックス状態を確認中です。</div>;
  if (p.noData) return <EmptyState kind={p.neverIndexed ? "not-indexed" : "no-data"} onPrimary={p.onStartIndex} busy={p.running} />;
  if (!p.overview) return null;
  return <>
    <SummaryCards overview={p.overview} preset={p.preset} />
    <Section title="期間ヒートマップ" subtitle="日別のコスト相当。ドラッグで期間を選ぶと、この段が連動します。">{p.series ? <CostHeatmap series={p.series} onSelectRange={p.onSelectRange} /> : null}</Section>
    <Section title="関係図" subtitle="案件 → 作業種別 → モデルのコスト相当の流れ。ノードをクリックすると絞り込みます。">{p.models && p.sessions ? <RelationDiagram models={p.models} sessions={p.sessions} excludeSynthetic={p.excludeSynthetic} topN={p.topN} onTopN={p.onTopN} grandTotal={p.overview.totals.costUsd} selection={p.selection} onSelect={p.onSelect} /> : null}</Section>
    <Section title="モデル別">{p.models ? <ModelTable report={p.models} granularity={p.granularity} onGranularity={p.onGranularity} excludeSynthetic={p.excludeSynthetic} selection={p.selection} onSelect={p.onSelect} /> : null}</Section>
    <Section title="案件別" actions={<ButtonGroup ariaLabel="内訳" value={p.breakdownDimension} onChange={p.onBreakdownDimension} options={[{ value: "project", label: "案件" }, { value: "branch", label: "ブランチ" }, { value: "effort", label: "effort" }, { value: "origin", label: "起動元" }, { value: "title", label: "主題" }, { value: "agent", label: "エージェント" }]} />}>
      {p.breakdownError ? <EmptyState kind="error" message={p.breakdownError} onPrimary={p.onRefreshBreakdown} /> : p.breakdown ? <ProjectTable report={p.breakdown} overview={p.overview} selection={p.selection} onSelect={p.onSelect} dimensionLabel={({ project: "案件", branch: "ブランチ", effort: "effort", origin: "起動元", title: "主題", agent: "エージェント" })[p.breakdownDimension]} projectMode={p.breakdownDimension === "project"} /> : null}
    </Section>
    <Section title="セッション一覧">{p.sessions ? <SessionTable report={p.sessions} sort={p.sessionSort} onSort={p.onSessionSort} page={p.sessionPage} onPage={p.onSessionPage} pageSize={SESSION_PAGE_SIZE} selection={p.selection} leafDimension={p.leafDimension} onOpenDetail={p.onOpenDetail} activeKey={p.detailKey} /> : null}</Section>
  </>;
}

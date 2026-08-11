/** Project -> work tag -> model relation diagram. */
import { useMemo, useState } from "react";

import { formatCount, formatPct, formatUsd, formatUsdShort, type ModelsReport, type SessionsReport } from "../../lib/ailog";
import { MODEL_COLORS, NEUTRAL_COLOR, TAG_COLORS } from "./palette";
import { layoutSankey, type LaidOutNode } from "./sankeyLayout";
import { OTHER_KEY, buildProjectSankeyGraph, buildProjectTopicSankeyGraph, UNSUMMARIZED_KEY, type SankeyNodeDatum } from "./sankeyModel";
import type { AilogSelection, TopNSetting } from "../../stores/ailogStore";
import { ButtonGroup, ScrollBox, noteStyle, subtleButtonStyle } from "./ui";

const VIEW_W = 1260;
const NODE_W = 18;
const COLUMN_X = [20, 460, 850];
const PAD_TOP = 34;
const PAD_BOTTOM = 16;
const GAP = 10;

function colorFor(key: string, index: number, palette: string[]): string {
  return key === OTHER_KEY ? NEUTRAL_COLOR : palette[index % palette.length];
}

export function RelationDiagram({ models, sessions, excludeSynthetic, topN, onTopN, grandTotal, selection, onSelect }: {
  models: ModelsReport;
  sessions: SessionsReport;
  excludeSynthetic: boolean;
  topN: TopNSetting;
  onTopN: (layer: keyof TopNSetting, value: number) => void;
  grandTotal: number;
  selection: AilogSelection | null;
  onSelect: (selection: AilogSelection | null) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [layer, setLayer] = useState<"tag" | "topic">("tag");
  const visibleSessions = selection?.type === "tag"
    ? sessions.rows.filter((row) => row.workTags.includes(selection.key))
    : selection?.type === "topic"
      ? sessions.rows.filter((row) => (row.goalCluster?.trim() || UNSUMMARIZED_KEY) === selection.key)
    : sessions.rows;
  const visibleTags = selection?.type === "tag"
    ? models.byWorkTag.filter((row) => row.workTag === selection.key)
    : models.byWorkTag;
  const graph = useMemo(() => layer === "topic"
    ? buildProjectTopicSankeyGraph({ sessions: visibleSessions, totalSessions: sessions.total, excludeSynthetic, grandTotal, topN })
    : buildProjectSankeyGraph({ byWorkTag: visibleTags, sessions: visibleSessions, totalSessions: sessions.total, excludeSynthetic, grandTotal, topN }), [layer, visibleTags, visibleSessions, sessions.total, excludeSynthetic, grandTotal, topN]);
  const height = Math.max(420, Math.max(graph.projects.length, graph.tags.length, graph.models.length, 1) * 44 + PAD_TOP + PAD_BOTTOM);
  const layout = useMemo(() => layoutSankey([
    graph.projects.map((node) => ({ key: node.key, label: node.label, value: node.value })),
    graph.tags.map((node) => ({ key: node.key, label: node.label, value: node.value })),
    graph.models.map((node) => ({ key: node.key, label: node.label, value: node.value })),
  ], [graph.projectToTag, graph.tagToModel], { height, padTop: PAD_TOP, padBottom: PAD_BOTTOM, gap: GAP, nodeWidth: NODE_W, columnX: COLUMN_X, minNodeHeight: 3 }), [graph, height]);
  const data = useMemo(() => {
    const nodes = new Map<string, SankeyNodeDatum>();
    graph.projects.forEach((node) => nodes.set(`0:${node.key}`, node));
    graph.tags.forEach((node) => nodes.set(`1:${node.key}`, node));
    graph.models.forEach((node) => nodes.set(`2:${node.key}`, node));
    const flows = new Map<string, { sessionCount?: number }>();
    graph.projectToTag.forEach((flow) => flows.set(`0:${flow.source}>${flow.target}`, flow));
    graph.tagToModel.forEach((flow) => flows.set(`1:${flow.source}>${flow.target}`, flow));
    return { nodes, flows };
  }, [graph]);
  const colors = useMemo(() => {
    const result = new Map<string, string>();
    graph.projects.forEach((node, index) => result.set(`0:${node.key}`, colorFor(node.key, index, [NEUTRAL_COLOR])));
    graph.tags.forEach((node, index) => result.set(`1:${node.key}`, colorFor(node.key, index, TAG_COLORS)));
    graph.models.forEach((node, index) => result.set(`2:${node.key}`, colorFor(node.key, index, MODEL_COLORS)));
    return result;
  }, [graph]);
  const selectionKey = selection ? `${selection.type === "project" ? 0 : selection.type === "tag" || selection.type === "topic" ? 1 : 2}:${selection.key}` : null;
  const empty = graph.projects.length === 0 || graph.tags.length === 0 || graph.models.length === 0;

  return <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <ButtonGroup ariaLabel="関係図の中間層" value={layer} onChange={(value) => { setLayer(value as "tag" | "topic"); onSelect(null); }} options={[{ value: "tag", label: "作業種別" }, { value: "topic", label: "トピック" }]} />
      <span style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>案件はコスト上位 10 件 + その他</span>
      {(["model"] as (keyof TopNSetting)[]).map((entry) => <label key={entry} style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>
        モデル
        <select aria-label={`${entry} の表示件数`} value={String(topN[entry])} onChange={(event) => onTopN(entry, Number(event.target.value))} style={selectStyle}>
          {[5, 8, 12].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>)}
      {selection ? <button type="button" onClick={() => onSelect(null)} style={{ ...subtleButtonStyle, fontSize: "var(--cmux-font-size-xs)" }}>{`絞り込み解除：${selection.label}`}</button> : null}
    </div>
    {empty ? <div style={noteStyle}>この期間に描ける関係がありません。</div> : <ScrollBox><svg viewBox={`0 0 ${VIEW_W} ${height}`} role="img" aria-label={`案件から${layer === "topic" ? "トピック" : "作業種別"}、モデルへのコストの流れ`} style={{ width: "100%", minWidth: 900, height: "auto", display: "block" }}>
      {["案件", layer === "topic" ? "トピック" : "作業種別", "モデル"].map((label, index) => <text key={label} x={COLUMN_X[index]} y={18} style={headerTextStyle}>{label}</text>)}
      {layout.flows.map((flow) => {
        const id = `${flow.layer}:${flow.source}>${flow.target}`;
        const relation = data.flows.get(id);
        const source = data.nodes.get(`${flow.layer}:${flow.source}`);
        const target = data.nodes.get(`${flow.layer + 1}:${flow.target}`);
        const related = hovered === null || hovered === id || hovered.includes(`:${flow.source}>`) || hovered.endsWith(`>${flow.target}`);
        const selected = selectionKey === null || selectionKey === `${flow.layer}:${flow.source}` || selectionKey === `${flow.layer + 1}:${flow.target}`;
        return <path key={id} d={flow.path} onPointerEnter={() => setHovered(id)} onPointerLeave={() => setHovered(null)} style={{ fill: colors.get(`${flow.layer}:${flow.source}`) ?? NEUTRAL_COLOR, fillOpacity: related && selected ? 0.66 : selected ? 0.2 : 0.05, transition: "fill-opacity 120ms" }}>
          <title>{`${source?.label ?? flow.source} → ${target?.label ?? flow.target}\n${formatCount(relation?.sessionCount ?? 0)} 件 · ${formatUsd(flow.value)}`}</title>
        </path>;
      })}
      {layout.nodes.map((node) => <NodeMark key={`${node.layer}:${node.key}`} node={node} datum={data.nodes.get(`${node.layer}:${node.key}`)} color={colors.get(`${node.layer}:${node.key}`) ?? NEUTRAL_COLOR} selected={selectionKey === `${node.layer}:${node.key}`} dimmed={selectionKey !== null && selectionKey !== `${node.layer}:${node.key}`} onClick={() => {
        const datum = data.nodes.get(`${node.layer}:${node.key}`); if (!datum || datum.isOther) return;
        const type = node.layer === 0 ? "project" : node.layer === 1 ? (layer === "topic" ? "topic" : "tag") : "model";
        onSelect(selectionKey === `${node.layer}:${node.key}` ? null : { type, key: node.key, label: datum.label });
      }} />)}
    </svg></ScrollBox>}
    <div style={{ display: "flex", flexDirection: "column", gap: 3, ...noteStyle }}>
      <div>{layer === "topic" ? `トピックは1セッションにつき1件です（期間の総額 ${formatUsd(graph.notes.grandTotal)}）。` : `作業種別は重複します（期間の総額 ${formatUsd(graph.notes.grandTotal)}）。複数種別を持つセッションは按分していません。`}</div>
      {graph.notes.projectOther.count > 0 ? <div>{`案件の「その他」＝ ${formatCount(graph.notes.projectOther.count)} 件 / ${formatUsd(graph.notes.projectOther.value)}`}</div> : null}
      {layer === "tag" && graph.notes.untaggedSessions > 0 ? <div>{`作業種別が付かなかったセッション ${formatCount(graph.notes.untaggedSessions)} 件（${formatUsd(graph.notes.untaggedCost)}）は関係図の中間層に出ていません。`}</div> : null}
    </div>
  </div>;
}

function NodeMark({ node, datum, color, selected, dimmed, onClick }: { node: LaidOutNode; datum: SankeyNodeDatum | undefined; color: string; selected: boolean; dimmed: boolean; onClick: () => void }) {
  const label = datum?.label ?? node.key;
  return <g onClick={datum && !datum.isOther ? onClick : undefined} style={{ cursor: datum && !datum.isOther ? "pointer" : "default", opacity: dimmed ? 0.4 : 1 }}>
    <title>{`${label}\n${formatUsd(node.value)} (${formatPct(datum?.sharePct ?? 0)})${datum?.tooltip ? `\n${datum.tooltip}` : ""}`}</title>
    <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={3} style={{ fill: color, stroke: selected ? "var(--cmux-text)" : "none", strokeWidth: selected ? 2 : 0 }} />
    <text x={node.x + node.width + 8} y={node.y + node.height / 2 - 1} style={nodeLabelStyle}>{label.length > 30 ? `${label.slice(0, 29)}…` : label}</text>
    <text x={node.x + node.width + 8} y={node.y + node.height / 2 + 12} style={nodeValueStyle}>{`${formatUsdShort(node.value)} (${formatPct(datum?.sharePct ?? 0)})`}</text>
  </g>;
}
const headerTextStyle = { fill: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-sm)", fontWeight: 600 } as const;
const nodeLabelStyle = { fill: "var(--cmux-text)", fontSize: "var(--cmux-font-size-sm)" } as const;
const nodeValueStyle = { fill: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-xs)", fontVariantNumeric: "tabular-nums" } as const;
const selectStyle = { marginLeft: 4, background: "var(--cmux-hover)", border: "1px solid var(--cmux-border)", borderRadius: 5, color: "var(--cmux-text)", fontSize: "var(--cmux-font-size-xs)", padding: "2px 4px" } as const;

/**
 * The relation diagram: モデル → 作業種別 → 案件 / 主題.
 *
 * Three things this deliberately does, all of them from field feedback on the
 * mock:
 * - every node and every fat ribbon prints its amount on screen. Hovering is an
 *   extra, never the only way to read the money.
 * - work tags are shown in Japanese; the English tag id never appears. The
 *   tooltip explains why the tag was applied.
 * - the folded `その他` bucket always states how many rows and how much money it
 *   absorbed, and the tag overlap is stated as an inequality instead of being
 *   pro-rated away.
 */

import { useMemo, useState } from "react";

import {
  formatCount,
  formatPct,
  formatUsd,
  formatUsdShort,
  type ModelsReport,
  type SessionsReport,
} from "../../lib/ailog";
import { MODEL_COLORS, NEUTRAL_COLOR, TAG_COLORS } from "./palette";
import { layoutSankey, type LaidOutNode } from "./sankeyLayout";
import {
  OTHER_KEY,
  buildSankeyGraph,
  titlesWithinProject,
  type LeafDimension,
  type SankeyNodeDatum,
} from "./sankeyModel";
import type { AilogSelection, TopNSetting } from "../../stores/ailogStore";
import { ButtonGroup, ScrollBox, noteStyle, subtleButtonStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

const OTHER_COLOR = NEUTRAL_COLOR;

const VIEW_W = 1260;
const NODE_W = 18;
const COLUMN_X = [20, 460, 850];
const LABEL_GAP = 8;
const PAD_TOP = 34;
const PAD_BOTTOM = 16;
const GAP = 10;
/** Below this ribbon height the inline amount would overlap its neighbours. */
const FLOW_LABEL_MIN_H = 13;

const TOP_N_CHOICES = [
  { value: 5, label: "5" },
  { value: 8, label: "8" },
  { value: 12, label: "12" },
  { value: Number.POSITIVE_INFINITY, label: "全部" },
];

function colorFor(key: string, index: number, palette: string[]): string {
  if (key === OTHER_KEY) return OTHER_COLOR;
  return palette[index % palette.length];
}

function ellipsis(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function RelationDiagram({
  models,
  sessions,
  leafDimension,
  onLeafDimension,
  excludeSynthetic,
  topN,
  onTopN,
  grandTotal,
  selection,
  onSelect,
  drillProject,
  onDrillProject,
}: {
  models: ModelsReport;
  sessions: SessionsReport;
  leafDimension: LeafDimension;
  onLeafDimension: (value: LeafDimension) => void;
  excludeSynthetic: boolean;
  topN: TopNSetting;
  onTopN: (layer: keyof TopNSetting, value: number) => void;
  grandTotal: number;
  selection: AilogSelection | null;
  onSelect: (selection: AilogSelection | null) => void;
  drillProject: string | null;
  onDrillProject: (value: string | null) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const graph = useMemo(
    () =>
      buildSankeyGraph({
        byWorkTag: models.byWorkTag,
        sessions: sessions.rows,
        totalSessions: sessions.total,
        leafDimension,
        excludeSynthetic,
        grandTotal,
        topN,
      }),
    [models.byWorkTag, sessions.rows, sessions.total, leafDimension, excludeSynthetic, grandTotal, topN],
  );

  const maxNodes = Math.max(graph.models.length, graph.tags.length, graph.leaves.length, 1);
  const height = Math.max(420, maxNodes * 44 + PAD_TOP + PAD_BOTTOM);

  const layout = useMemo(
    () =>
      layoutSankey(
        [
          graph.models.map((node) => ({ key: node.key, label: node.label, value: node.value })),
          graph.tags.map((node) => ({ key: node.key, label: node.label, value: node.value })),
          graph.leaves.map((node) => ({ key: node.key, label: node.label, value: node.value })),
        ],
        [graph.modelToTag, graph.tagToLeaf],
        {
          height,
          padTop: PAD_TOP,
          padBottom: PAD_BOTTOM,
          gap: GAP,
          nodeWidth: NODE_W,
          columnX: COLUMN_X,
          minNodeHeight: 3,
        },
      ),
    [graph, height],
  );

  const colors = useMemo(() => {
    const map = new Map<string, string>();
    graph.models.forEach((node, index) => map.set(`0:${node.key}`, colorFor(node.key, index, MODEL_COLORS)));
    graph.tags.forEach((node, index) => map.set(`1:${node.key}`, colorFor(node.key, index, TAG_COLORS)));
    graph.leaves.forEach((node) => map.set(`2:${node.key}`, OTHER_COLOR));
    return map;
  }, [graph]);

  const datumByKey = useMemo(() => {
    const map = new Map<string, SankeyNodeDatum>();
    graph.models.forEach((node) => map.set(`0:${node.key}`, node));
    graph.tags.forEach((node) => map.set(`1:${node.key}`, node));
    graph.leaves.forEach((node) => map.set(`2:${node.key}`, node));
    return map;
  }, [graph]);

  const selectionKey = selection
    ? `${selection.type === "model" ? 0 : selection.type === "tag" ? 1 : 2}:${selection.key}`
    : null;

  const empty = graph.models.length === 0 && graph.leaves.length === 0;

  const drillRows = useMemo(
    () => (drillProject ? titlesWithinProject(sessions.rows, drillProject) : []),
    [drillProject, sessions.rows],
  );

  const dominant = graph.notes.dominantLeaf;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: "var(--cmux-text-tertiary)" }}>第 3 層</span>
        <ButtonGroup
          ariaLabel="第3層のディメンション"
          value={leafDimension}
          onChange={(value) => {
            onLeafDimension(value);
            onDrillProject(null);
          }}
          options={[
            { value: "project" as LeafDimension, label: "案件", title: "セッションの作業フォルダ" },
            { value: "title" as LeafDimension, label: "主題", title: "セッションの主題（タイトル）" },
          ]}
        />
        <span style={{ width: 12 }} />
        {(["model", "tag", "leaf"] as (keyof TopNSetting)[]).map((layer) => (
          <span key={layer} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 10, color: "var(--cmux-text-tertiary)" }}>
              {layer === "model" ? "モデル上位" : layer === "tag" ? "作業種別上位" : "第3層上位"}
            </span>
            <select
              aria-label={`${layer} の表示件数`}
              value={Number.isFinite(topN[layer]) ? String(topN[layer]) : "all"}
              onChange={(event) =>
                onTopN(layer, event.target.value === "all" ? Number.POSITIVE_INFINITY : Number(event.target.value))
              }
              style={selectStyle}
            >
              {TOP_N_CHOICES.map((choice) => (
                <option key={choice.label} value={Number.isFinite(choice.value) ? String(choice.value) : "all"}>
                  {choice.label}
                </option>
              ))}
            </select>
          </span>
        ))}
        {selection ? (
          <button type="button" onClick={() => onSelect(null)} style={{ ...subtleButtonStyle, fontSize: 10 }}>
            {`絞り込み解除：${selection.label}`}
          </button>
        ) : null}
      </div>

      {empty ? (
        <div style={noteStyle}>この期間に描ける関係がありません。</div>
      ) : (
        <ScrollBox>
          <svg
            viewBox={`0 0 ${VIEW_W} ${height}`}
            role="img"
            aria-label="モデルから作業種別、案件へのコストの流れ"
            style={{ width: "100%", minWidth: 900, height: "auto", display: "block" }}
          >
            <text x={COLUMN_X[0]} y={18} style={headerTextStyle}>
              モデル
            </text>
            <text x={COLUMN_X[1]} y={18} style={headerTextStyle}>
              作業種別
            </text>
            <text x={COLUMN_X[2]} y={18} style={headerTextStyle}>
              {leafDimension === "project" ? "案件" : "主題"}
            </text>

            {layout.flows.map((flow) => {
              const id = `${flow.layer}:${flow.source}>${flow.target}`;
              const paletteKey = flow.layer === 0 ? `0:${flow.source}` : `1:${flow.source}`;
              const color = colors.get(paletteKey) ?? OTHER_COLOR;
              const touchesSelection =
                selectionKey === null ||
                selectionKey === `${flow.layer}:${flow.source}` ||
                selectionKey === `${flow.layer + 1}:${flow.target}`;
              const isHovered = hovered === id;
              const opacity = isHovered ? 0.66 : touchesSelection ? 0.26 : 0.06;
              const sourceDatum = datumByKey.get(`${flow.layer}:${flow.source}`);
              const targetDatum = datumByKey.get(`${flow.layer + 1}:${flow.target}`);
              const midY = (flow.y0 + flow.h0 / 2 + flow.y1 + flow.h1 / 2) / 2;
              const thick = Math.min(flow.h0, flow.h1) >= FLOW_LABEL_MIN_H;
              return (
                <g key={id}>
                  <path
                    d={flow.path}
                    style={{ fill: color, fillOpacity: opacity, transition: "fill-opacity 120ms" }}
                    onPointerEnter={() => setHovered(id)}
                    onPointerLeave={() => setHovered((current) => (current === id ? null : current))}
                  >
                    <title>
                      {`${sourceDatum?.label ?? flow.source} → ${targetDatum?.label ?? flow.target}\n${formatUsd(flow.value)}`}
                    </title>
                  </path>
                  {thick ? (
                    <text
                      x={(flow.x0 + flow.x1) / 2}
                      y={midY + 3}
                      textAnchor="middle"
                      pointerEvents="none"
                      style={flowLabelStyle}
                    >
                      {formatUsdShort(flow.value)}
                    </text>
                  ) : null}
                </g>
              );
            })}

            {layout.nodes.map((node) => {
              const id = `${node.layer}:${node.key}`;
              const datum = datumByKey.get(id);
              const color = colors.get(id) ?? OTHER_COLOR;
              const selected = selectionKey === id;
              return (
                <NodeMark
                  key={id}
                  node={node}
                  datum={datum}
                  color={color}
                  selected={selected}
                  dimmed={selectionKey !== null && !selected}
                  onClick={() => {
                    if (!datum || datum.isOther) return;
                    const type = node.layer === 0 ? "model" : node.layer === 1 ? "tag" : "leaf";
                    onSelect(selected ? null : { type, key: node.key, label: datum.label });
                    if (node.layer === 2 && leafDimension === "project") {
                      onDrillProject(selected ? null : node.key);
                    }
                  }}
                />
              );
            })}
          </svg>
        </ScrollBox>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 3, ...noteStyle }}>
        <div>
          {`作業種別は重複します（作業種別の合計 ${formatUsd(graph.notes.leafBandTotal)} ＞ 期間の総額 ${formatUsd(graph.notes.grandTotal)}）。1 セッションが複数の種別を持つため、按分していません。`}
        </div>
        {graph.notes.bandMismatchPct >= 1 ? (
          <div>
            {`モデル側の合計 ${formatUsd(graph.notes.modelBandTotal)} と第 3 層側の合計 ${formatUsd(graph.notes.leafBandTotal)} は ${formatPct(graph.notes.bandMismatchPct)} ずれています。前者は期間内のターンだけ、後者はセッション全体のコストで数えるためです（辻褄合わせはしていません）。`}
          </div>
        ) : null}
        {graph.notes.syntheticExcluded && graph.notes.syntheticCost > 0 ? (
          <div>{`<synthetic>（Claude の疑似モデル名）を除外しています：${formatUsd(graph.notes.syntheticCost)} 分。上のチェックを外すと表示します。`}</div>
        ) : null}
        {graph.notes.untaggedSessions > 0 ? (
          <div>{`作業種別が付かなかったセッション ${formatCount(graph.notes.untaggedSessions)} 件（${formatUsd(graph.notes.untaggedCost)}）は第 2〜3 層に出ていません。`}</div>
        ) : null}
        {graph.notes.truncatedSessions > 0 ? (
          <div>{`セッションは上位 ${formatCount(graph.notes.fetchedSessions)} 件で描画しています（全 ${formatCount(graph.notes.totalSessions)} 件・残り ${formatCount(graph.notes.truncatedSessions)} 件は未反映）。`}</div>
        ) : null}
        {graph.notes.modelOther.count > 0 ? (
          <div>{`モデルの「その他」＝ ${formatCount(graph.notes.modelOther.count)} 件 / ${formatUsd(graph.notes.modelOther.value)}`}</div>
        ) : null}
        {graph.notes.tagOther.count > 0 ? (
          <div>{`作業種別の「その他」＝ ${formatCount(graph.notes.tagOther.count)} 件 / ${formatUsd(graph.notes.tagOther.value)}`}</div>
        ) : null}
        {graph.notes.leafOther.count > 0 ? (
          <div>{`第 3 層の「その他」＝ ${formatCount(graph.notes.leafOther.count)} 件 / ${formatUsd(graph.notes.leafOther.value)}`}</div>
        ) : null}
      </div>

      {dominant && leafDimension === "project" ? (
        <div
          style={{
            border: "1px solid var(--cmux-usage-warn)",
            borderRadius: 8,
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ fontSize: 10, color: "var(--cmux-text-secondary)", lineHeight: 1.6 }}>
            {`「${dominant.label}」が第 3 層の ${formatPct(dominant.sharePct)}（${formatUsd(dominant.value)}）を占めています。ホーム起点で始めたセッションが案件を問わずここに入るため、この 1 ノードは複数案件の集合です。`}
          </div>
          <div>
            <button
              type="button"
              style={{ ...subtleButtonStyle, fontSize: 10 }}
              onClick={() => onDrillProject(drillProject === dominant.key ? null : dominant.key)}
            >
              {drillProject === dominant.key ? "内訳を閉じる" : "主題で内訳を見る"}
            </button>
          </div>
        </div>
      ) : null}

      {drillProject ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700 }}>{`「${drillProject}」の主題別内訳`}</div>
          <ScrollBox maxHeight={260}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thLeftStyle}>主題</th>
                  <th style={thStyle}>セッション</th>
                  <th style={thStyle}>コスト</th>
                  <th style={thStyle}>シェア</th>
                </tr>
              </thead>
              <tbody>
                {drillRows.map((row) => (
                  <tr key={row.key}>
                    <td style={tdLeftStyle} title={row.key}>
                      {row.key}
                    </td>
                    <td style={tdStyle}>{formatCount(row.sessions)}</td>
                    <td style={tdStyle}>{formatUsd(row.costUsd)}</td>
                    <td style={tdStyle}>{formatPct(row.sharePct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollBox>
          <div style={noteStyle}>
            {`${formatCount(drillRows.length)} 主題・この内訳はセッション単位（作業種別による重複なし）で数えています。`}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NodeMark({
  node,
  datum,
  color,
  selected,
  dimmed,
  onClick,
}: {
  node: LaidOutNode;
  datum: SankeyNodeDatum | undefined;
  color: string;
  selected: boolean;
  dimmed: boolean;
  onClick: () => void;
}) {
  const labelX = node.x + node.width + LABEL_GAP;
  const centerY = node.y + node.height / 2;
  const label = datum?.label ?? node.key;
  const amount = `${formatUsdShort(node.value)} (${formatPct(datum?.sharePct ?? 0)})`;
  const clickable = Boolean(datum && !datum.isOther);
  return (
    <g
      onClick={clickable ? onClick : undefined}
      style={{ cursor: clickable ? "pointer" : "default", opacity: dimmed ? 0.4 : 1 }}
    >
      <title>{`${label}\n${formatUsd(node.value)}（${formatPct(datum?.sharePct ?? 0)}）${datum?.tooltip ? `\n${datum.tooltip}` : ""}`}</title>
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={3}
        style={{ fill: color, stroke: selected ? "var(--cmux-text)" : "none", strokeWidth: selected ? 2 : 0 }}
      />
      <text x={labelX} y={centerY - 1} style={nodeLabelStyle}>
        {ellipsis(label, 30)}
      </text>
      <text x={labelX} y={centerY + 12} style={nodeValueStyle}>
        {amount}
      </text>
    </g>
  );
}

const headerTextStyle = { fill: "var(--cmux-text-tertiary)", fontSize: 12, fontWeight: 600 } as const;
const nodeLabelStyle = { fill: "var(--cmux-text)", fontSize: 12 } as const;
const nodeValueStyle = { fill: "var(--cmux-text-secondary)", fontSize: 11, fontVariantNumeric: "tabular-nums" } as const;
const flowLabelStyle = {
  fill: "var(--cmux-text-secondary)",
  fontSize: 10,
  fontVariantNumeric: "tabular-nums",
} as const;

const selectStyle = {
  background: "var(--cmux-hover)",
  border: "1px solid var(--cmux-border)",
  borderRadius: 5,
  color: "var(--cmux-text)",
  fontSize: 10,
  padding: "2px 4px",
};

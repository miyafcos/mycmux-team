/**
 * Sankey geometry. Pure functions, no React and no DOM, so the proportions can
 * be pinned by unit tests.
 *
 * Ported from the Python mock that was used to pick diagram option A
 * (`scratchpad/build_mock.py`): nodes are stacked per column and each ribbon
 * takes the share of its endpoint node that its value represents. The port
 * generalises the mock from two columns to N and normalises each column against
 * its own total, because the middle column of the real chart carries a larger
 * sum than the first one (work tags overlap and are never pro-rated).
 */

export interface SankeyNodeInput {
  key: string;
  label: string;
  value: number;
}

export interface SankeyFlowInput {
  source: string;
  target: string;
  value: number;
}

export interface SankeyLayoutOptions {
  height: number;
  padTop: number;
  padBottom: number;
  /** Vertical gap between stacked nodes, in px. */
  gap: number;
  nodeWidth: number;
  /** X of the left edge of each column. Length must match `layers`. */
  columnX: number[];
  /** Floor so a rounding-error node still has a clickable target. */
  minNodeHeight: number;
}

export interface LaidOutNode {
  key: string;
  label: string;
  value: number;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutFlow {
  source: string;
  target: string;
  value: number;
  layer: number;
  /** SVG path of the closed ribbon. */
  path: string;
  y0: number;
  h0: number;
  y1: number;
  h1: number;
  x0: number;
  x1: number;
}

export interface SankeyLayout {
  nodes: LaidOutNode[];
  flows: LaidOutFlow[];
  nodeByKey: Map<string, LaidOutNode>;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Stack one column. Heights are proportional to each node's share of the
 * column total; a zero total gives every node the floor height instead of
 * NaN (the "no data yet" case must still draw something inert).
 */
function stackColumn(
  nodes: SankeyNodeInput[],
  options: SankeyLayoutOptions,
): { y: number; height: number }[] {
  const usable = Math.max(0, options.height - options.padTop - options.padBottom);
  const gaps = options.gap * Math.max(0, nodes.length - 1);
  const span = Math.max(0, usable - gaps);
  const total = nodes.reduce((sum, node) => sum + Math.max(0, finite(node.value)), 0);
  const out: { y: number; height: number }[] = [];
  let cursor = options.padTop;
  for (const node of nodes) {
    const share = total > 0 ? Math.max(0, finite(node.value)) / total : 0;
    const height = Math.max(options.minNodeHeight, span * share);
    out.push({ y: cursor, height });
    cursor += height + options.gap;
  }
  return out;
}

function ribbon(x0: number, x1: number, a0: number, a1: number, b0: number, b1: number): string {
  const mid = (x0 + x1) / 2;
  const f = (value: number) => Number(finite(value).toFixed(2));
  return (
    `M${f(x0)},${f(a0)} C${f(mid)},${f(a0)} ${f(mid)},${f(b0)} ${f(x1)},${f(b0)} ` +
    `L${f(x1)},${f(b1)} C${f(mid)},${f(b1)} ${f(mid)},${f(a1)} ${f(x0)},${f(a1)} Z`
  );
}

/**
 * Lay out an N-column Sankey.
 *
 * `layers[i]` is drawn at `columnX[i]`; `flows[i]` connects layer i to i+1.
 * Ribbon thickness at each end is that flow's share of the endpoint node's own
 * outgoing (left) or incoming (right) total, so a node whose inflow and
 * outflow disagree still has both sides fully packed rather than overflowing.
 */
export function layoutSankey(
  layers: SankeyNodeInput[][],
  flows: SankeyFlowInput[][],
  options: SankeyLayoutOptions,
): SankeyLayout {
  const nodes: LaidOutNode[] = [];
  const nodeByKey = new Map<string, LaidOutNode>();

  layers.forEach((layer, index) => {
    const stacked = stackColumn(layer, options);
    layer.forEach((node, position) => {
      const placed: LaidOutNode = {
        key: node.key,
        label: node.label,
        value: finite(node.value),
        layer: index,
        x: options.columnX[index] ?? 0,
        y: stacked[position].y,
        width: options.nodeWidth,
        height: stacked[position].height,
      };
      nodes.push(placed);
      nodeByKey.set(`${index}:${node.key}`, placed);
    });
  });

  const laidOutFlows: LaidOutFlow[] = [];

  flows.forEach((band, index) => {
    const outTotals = new Map<string, number>();
    const inTotals = new Map<string, number>();
    for (const flow of band) {
      const value = Math.max(0, finite(flow.value));
      if (value <= 0) continue;
      outTotals.set(flow.source, (outTotals.get(flow.source) ?? 0) + value);
      inTotals.set(flow.target, (inTotals.get(flow.target) ?? 0) + value);
    }

    const leftCursor = new Map<string, number>();
    const rightCursor = new Map<string, number>();

    // Drawing order follows the node stacks so ribbons leave each node in the
    // same order they arrive at the next one; crossings stay minimal without a
    // full ordering pass.
    const ordered = [...band]
      .filter((flow) => Math.max(0, finite(flow.value)) > 0)
      .sort((a, b) => {
        const left = (nodeByKey.get(`${index}:${a.source}`)?.y ?? 0) - (nodeByKey.get(`${index}:${b.source}`)?.y ?? 0);
        if (left !== 0) return left;
        const right = (nodeByKey.get(`${index + 1}:${a.target}`)?.y ?? 0) - (nodeByKey.get(`${index + 1}:${b.target}`)?.y ?? 0);
        return right;
      });

    for (const flow of ordered) {
      const source = nodeByKey.get(`${index}:${flow.source}`);
      const target = nodeByKey.get(`${index + 1}:${flow.target}`);
      if (!source || !target) continue;
      const value = Math.max(0, finite(flow.value));
      const outTotal = outTotals.get(flow.source) ?? 0;
      const inTotal = inTotals.get(flow.target) ?? 0;
      const h0 = outTotal > 0 ? (source.height * value) / outTotal : 0;
      const h1 = inTotal > 0 ? (target.height * value) / inTotal : 0;
      const y0 = leftCursor.get(flow.source) ?? source.y;
      const y1 = rightCursor.get(flow.target) ?? target.y;
      leftCursor.set(flow.source, y0 + h0);
      rightCursor.set(flow.target, y1 + h1);
      const x0 = source.x + source.width;
      const x1 = target.x;
      laidOutFlows.push({
        source: flow.source,
        target: flow.target,
        value,
        layer: index,
        path: ribbon(x0, x1, y0, y0 + h0, y1, y1 + h1),
        y0,
        h0,
        y1,
        h1,
        x0,
        x1,
      });
    }
  });

  return { nodes, flows: laidOutFlows, nodeByKey };
}

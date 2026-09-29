// Compare complete V8 snapshots, then report shortest non-weak root paths.
// Allocation stacks are deliberately not used as evidence of ownership.
import { readFileSync, writeFileSync } from 'node:fs';

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
if (!beforePath || !afterPath || !outputPath) throw new Error('Usage: before.heapsnapshot after.heapsnapshot output.json');
function read(path) {
  const heap = JSON.parse(readFileSync(path, 'utf8'));
  const meta = heap.snapshot.meta;
  const fields = Object.fromEntries(meta.node_fields.map((name, i) => [name, i]));
  const ef = Object.fromEntries(meta.edge_fields.map((name, i) => [name, i]));
  return { heap, fields, ef, width: meta.node_fields.length, edgeWidth: meta.edge_fields.length,
    nodeTypes: meta.node_types[fields.type], edgeTypes: meta.edge_types[ef.type] };
}
function inventory(snapshot) {
  const { heap, fields: f, width, nodeTypes } = snapshot;
  const ids = new Set(), groups = new Map();
  for (let offset = 0; offset < heap.nodes.length; offset += width) {
    ids.add(heap.nodes[offset + f.id]);
    const type = nodeTypes[heap.nodes[offset + f.type]], name = heap.strings[heap.nodes[offset + f.name]];
    const key = type + ':' + name;
    const group = groups.get(key) ?? { type, name, count: 0, bytes: 0 };
    group.count++; group.bytes += heap.nodes[offset + f.self_size]; groups.set(key, group);
  }
  return { ids, groups };
}
const before = read(beforePath), previous = inventory(before);
const after = read(afterPath), current = inventory(after);
const { heap, fields: f, ef, width, edgeWidth, nodeTypes, edgeTypes } = after;
const count = heap.nodes.length / width;
const edgeStart = new Uint32Array(count + 1);
for (let n = 0; n < count; n++) edgeStart[n + 1] = edgeStart[n] + heap.nodes[n * width + f.edge_count] * edgeWidth;
const parents = new Int32Array(count).fill(-1), parentEdge = new Int32Array(count).fill(-1);
const queue = new Uint32Array(count); queue[0] = 0; parents[0] = 0;
let head = 0, tail = 1;
while (head < tail) {
  const n = queue[head++];
  for (let e = edgeStart[n]; e < edgeStart[n + 1]; e += edgeWidth) {
    if (edgeTypes[heap.edges[e + ef.type]] === 'weak') continue;
    const child = heap.edges[e + ef.to_node] / width;
    if (parents[child] !== -1) continue;
    parents[child] = n; parentEdge[child] = e; queue[tail++] = child;
  }
}
function describe(n) {
  const offset = n * width;
  return { id: heap.nodes[offset + f.id], type: nodeTypes[heap.nodes[offset + f.type]],
    name: heap.strings[heap.nodes[offset + f.name]], bytes: heap.nodes[offset + f.self_size],
    detachedness: f.detachedness === undefined ? null : heap.nodes[offset + f.detachedness] };
}
function edgeName(e) {
  const type = edgeTypes[heap.edges[e + ef.type]], name = heap.edges[e + ef.name_or_index];
  return { type, name: type === 'element' || type === 'hidden' ? name : heap.strings[name] };
}
function path(n) {
  const result = [];
  for (let depth = 0; depth < 60; depth++) {
    const e = parentEdge[n]; result.push({ ...describe(n), via: e < 0 ? null : edgeName(e) });
    if (n === 0 || parents[n] < 0) break;
    n = parents[n];
  }
  return result.reverse();
}
const deltas = [...current.groups.entries()].map(([key, value]) => {
  const old = previous.groups.get(key) ?? { count: 0, bytes: 0 };
  return { ...value, countBefore: old.count, bytesBefore: old.bytes, countDelta: value.count - old.count, bytesDelta: value.bytes - old.bytes };
}).sort((a, b) => b.bytesDelta - a.bytesDelta);
const interesting = /Fiber|[Tt]erminal|[Ww]ebgl|WebGL|HTMLCanvas|HTMLTextArea|ResizeObserver|MutationObserver|EventListener|Timeout|system \/ Context/;
const paths = [], selected = new Map();
const largest = new Set(deltas.filter(g => ['object', 'closure', 'native'].includes(g.type)).slice(0, 15).map(g => g.type + ':' + g.name));
for (let n = 0; n < count; n++) {
  const node = describe(n), key = node.type + ':' + node.name;
  if (previous.ids.has(node.id) || parents[n] < 0 || (!interesting.test(node.name) && !largest.has(key))) continue;
  if (!['object', 'native', 'closure'].includes(node.type) || (selected.get(key) ?? 0) >= 3) continue;
  selected.set(key, (selected.get(key) ?? 0) + 1);
  paths.push({ node, path: path(n) });
}
const result = { beforePath, afterPath, beforeNodes: previous.ids.size, afterNodes: count,
  rootReachableWithoutWeakEdges: tail,
  method: 'Object identity difference; shallow sizes; shortest root paths exclude weak edges. Ephemeron internal edges require key-liveness interpretation; not dominator retained sizes.',
  deltas, paths };
writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ beforeNodes: previous.ids.size, afterNodes: count, top: deltas.slice(0, 20), paths: paths.length, outputPath }, null, 2));

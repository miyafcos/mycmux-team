import {
  parseGroupingOutput, sanitizeGroupingName, uniqueGroupingName,
  type GroupingAnalysisDependencies, type GroupingAnalysisResult, type GroupingGroup, type GroupingLayout,
  type GroupingPaneRole, type GroupingPlan, type GroupingScan, type GroupingStrategy, type GroupingWarning,
} from "./tabGrouping";
import {
  buildJevFocusedRequests, buildJevRequests, jevPairKey, jevProjectDirectory, readJevJudgements,
  validateJevResponse, type JevJudgements, type JevRelation, type JevRequest,
} from "./jevGroupingDecisions";

export const JEV_GROUPING_VERSION = "jev-grouping-product-v1";
const roleNames: Record<GroupingPaneRole, string> = {
  mother: "指揮", worker: "制作・実装", review: "確認・判断", mixed: "共同作業", unspecified: "要確認",
};
const roleOrder: Record<GroupingPaneRole, number> = { mother: 0, worker: 1, review: 2, mixed: 3, unspecified: 4 };
type Unit = number[];

function familyUnits(scan: GroupingScan): Unit[] {
  const index = new Map(scan.tabs.map((tab, i) => [tab.id, i]));
  const parent = scan.tabs.map((_, i) => i);
  const root = (i: number): number => {
    let current = i;
    while (parent[current] !== current) current = parent[current];
    return current;
  };
  const join = (a: number, b: number) => { const left = root(a); const right = root(b); if (left !== right) parent[right] = left; };
  scan.tabs.forEach((tab, i) => { const p = index.get(tab.origin?.parentTabId ?? ""); if (p !== undefined) join(p, i); });
  for (const cluster of scan.lineageClusters) {
    const members = cluster.tabIds.flatMap((id) => index.has(id) ? [index.get(id)!] : []);
    for (const i of members.slice(1)) join(members[0], i);
  }
  const units = new Map<number, number[]>();
  scan.tabs.forEach((_, i) => { const r = root(i); const items = units.get(r) ?? []; items.push(i); units.set(r, items); });
  return [...units.values()].map((unit) => unit.sort((a, b) => {
    const aParent = scan.tabs[a].origin?.parentTabId;
    const bParent = scan.tabs[b].origin?.parentTabId;
    if (aParent === scan.tabs[b].id) return 1;
    if (bParent === scan.tabs[a].id) return -1;
    return Number(Boolean(aParent)) - Number(Boolean(bParent)) || a - b;
  }));
}
function relation(judgements: JevJudgements, a: number, b: number): JevRelation {
  return judgements.relations[jevPairKey(a, b)] ?? { kind: "unknown", same: 0, related: 0, different: 0, confidence: 0 };
}
function crossRelations(left: Unit[], right: Unit[], judgements: JevJudgements): JevRelation[] {
  return left.flat().flatMap((a) => right.flat().map((b) => relation(judgements, a, b)));
}
function canFit(units: Unit[]): boolean {
  return units.flat().length <= 8 && units.reduce((count, unit) => count + Math.ceil(unit.length / 4), 0) <= 4;
}
function projectBuckets(units: Unit[], judgements: JevJudgements): Unit[][] {
  const buckets = units.map((unit) => [unit]);
  for (const relatedPass of [false, true]) {
    while (true) {
      let best: { a: number; b: number; score: number } | null = null;
      for (let a = 0; a < buckets.length; a += 1) {
        for (let b = a + 1; b < buckets.length; b += 1) {
          if (!canFit([...buckets[a], ...buckets[b]])) continue;
          if (relatedPass && buckets[a].flat().length >= 3 && buckets[b].flat().length >= 3) continue;
          const pairs = crossRelations(buckets[a], buckets[b], judgements);
          if (pairs.some((p) => p.kind === "different" && p.different >= 0.65)) continue;
          const scores = pairs.map((p) => relatedPass ? Math.max(p.same, p.related) : p.same);
          const score = scores.reduce((a, b) => a + b, 0) / scores.length;
          if (score < (relatedPass ? 0.72 : 0.7) || scores.some((p) => p < 0.35)) continue;
          if (!best || score > best.score) best = { a, b, score };
        }
      }
      if (!best) break;
      buckets[best.a].push(...buckets[best.b]);
      buckets.splice(best.b, 1);
    }
  }
  return buckets;
}
function dominantRole(unit: Unit, judgements: JevJudgements): GroupingPaneRole {
  const kinds = new Set(unit.map((i) => judgements.roles[i]));
  return kinds.size === 1 ? judgements.roles[unit[0]] : "mixed";
}
function roleBuckets(units: Unit[], judgements: JevJudgements): Unit[][] {
  const buckets: Unit[][] = [];
  const sorted = [...units].sort((a, b) => roleOrder[dominantRole(a, judgements)] - roleOrder[dominantRole(b, judgements)] || a[0] - b[0]);
  for (const unit of sorted) {
    const kind = dominantRole(unit, judgements);
    const match = buckets.find((bucket) => dominantRole(bucket[0], judgements) === kind && canFit([...bucket, unit]));
    if (match) match.push(unit);
    else buckets.push([unit]);
  }
  return buckets;
}
function shortName(value: string, fallback: string): string {
  const words = value.trim().split(/[\s_]+/).filter(Boolean);
  for (let count = words.length; count > 0; count -= 1) {
    const candidate = words.slice(0, count).join(" ");
    if ([...candidate].length <= 20) {
      const name = sanitizeGroupingName(candidate);
      if (name) return name;
    }
  }
  return fallback;
}
function projectName(scan: GroupingScan, members: number[]): string {
  const labels = members.map((i) => scan.tabs[i].label.trim().split(/[\s_]+/)[0]).filter(Boolean);
  const counts = new Map<string, number>();
  labels.forEach((label) => counts.set(label, (counts.get(label) ?? 0) + 1));
  const common = [...counts].sort((a, b) => b[1] - a[1]).find(([, n]) => n > 1);
  if (common) return shortName(common[0], "関連する作業");
  const dirs = members.map((i) => jevProjectDirectory(scan.tabs[i])).filter((d): d is string => Boolean(d));
  if (dirs.length > 0 && new Set(dirs.map((d) => d.toLowerCase())).size === 1) {
    const folder = dirs[0].split("/").pop()!.replace(/-(?:dev|master|main|wt)(?:-.*)?$/i, "");
    const name = shortName(folder.replace(/-/g, " "), "");
    if (name) return name;
  }
  const specific = [...new Set(labels.map((label) => shortName(label, "")).filter(Boolean))];
  let joined = "";
  for (const name of specific) {
    const next = joined ? `${joined}・${name}` : name;
    if ([...next].length > 18) return joined ? `${joined}ほか` : "関連する作業";
    joined = next;
  }
  return joined || "関連する作業";
}
function layoutFor(scan: GroupingScan, units: Unit[], judgements: JevJudgements, strategy: GroupingStrategy): GroupingLayout {
  const pane = (i: number) => ({
    title: shortName(scan.tabs[i].label, roleNames[judgements.roles[i]]),
    role: judgements.roles[i], tabIds: [scan.tabs[i].id],
  });
  // Project views nest only genuine family units. Independent tasks get separate columns.
  let columns = units.flatMap((unit) => {
    const result = [];
    for (let offset = 0; offset < unit.length; offset += 4) result.push({ panes: unit.slice(offset, offset + 4).map(pane) });
    return result;
  });
  if (strategy === "role") {
    const members = units.flat().sort((a, b) => roleOrder[judgements.roles[a]] - roleOrder[judgements.roles[b]] || a - b);
    if (members.length <= 4) columns = members.map((i) => ({ panes: [pane(i)] }));
    else if (units.length === 1) {
      // Wider overview: keep the coordinator visible and distribute related children.
      columns = Array.from({ length: Math.min(4, members.length) }, () => ({ panes: [] as ReturnType<typeof pane>[] }));
      members.forEach((i, index) => columns[index % columns.length].panes.push(pane(i)));
    } else {
      columns = columns.sort((a, b) => roleOrder[a.panes[0].role] - roleOrder[b.panes[0].role]);
    }
  }
  return { columns };
}
export function composeJevPlans(scan: GroupingScan, judgements: JevJudgements): GroupingPlan[] {
  const units = familyUnits(scan);
  const held = units.filter((unit) => unit.length > 16 || unit.every((i) => judgements.health[i] === "unknown"));
  const errors = units.filter((unit) => !held.includes(unit) && unit.every((i) => judgements.health[i] === "error"));
  const known = units.filter((unit) => !held.includes(unit) && !errors.includes(unit));
  const projects = projectBuckets(known, judgements);
  const plans: GroupingPlan[] = [];
  for (const strategy of ["project", "role", "minimal_move"] as const) {
    const buckets = [...(strategy === "role" ? roleBuckets(known, judgements) : projects), ...errors.map((unit) => [unit]), ...held.map((unit) => [unit])];
    const keep = new Map<string, Unit[]>();
    if (strategy === "minimal_move") {
      for (const bucket of buckets) {
        const places = new Set(bucket.flat().map((i) => scan.tabs[i].workspaceId));
        if (places.size !== 1) continue;
        const ws = [...places][0];
        if (bucket.flat().length > (keep.get(ws)?.flat().length ?? 0)) keep.set(ws, bucket);
      }
    }
    const names = new Set(scan.workspaces.map((ws) => ws.name));
    const warnings: GroupingWarning[] = [];
    const groups: GroupingGroup[] = buckets.map((bucket, index) => {
      const members = bucket.flat();
      const tabIds = members.map((i) => scan.tabs[i].id);
      const hold = held.includes(bucket[0]);
      const errorOnly = errors.includes(bucket[0]);
      const kind = dominantRole(members, judgements);
      const title = hold ? "要確認" : errorOnly ? "動作の確認" : strategy === "role" && kind !== "mixed" ? roleNames[kind] : projectName(scan, members);
      const name = uniqueGroupingName(title, names); names.add(name);
      const preserve = hold || (strategy === "minimal_move" && [...keep.values()].includes(bucket));
      if (hold) warnings.push({ code: "UNCLEAR_ROLE", tabIds, message: members.length > 16
        ? "大きな親子グループは現在位置を保ちます。分け方を確認してください。"
        : "作業の情報が足りないペインは現在位置に残します。" });
      if (strategy === "role" && bucket.length > 1) warnings.push({
        code: "MIXED_PROJECT", tabIds, message: "同じ役割のタスクを横に見渡せるようにまとめています。案件ごとに列を分けます。",
      });
      if (errorOnly) warnings.push({ code: "LOW_CONFIDENCE", tabIds, message: "現在の動作エラーを確認するためのグループです。ターミナルは終了しません。" });
      return { groupId: `jev-${strategy}-${index}`, title: name, disposition: preserve ? "keep" : "reorganize",
        destination: preserve ? { kind: "current_locations" } : { kind: "new_workspace", proposedName: name },
        layout: preserve ? null : layoutFor(scan, bucket, judgements, strategy), tabIds, adopted: true };
    });
    plans.push({
      planId: `jev-${strategy}`, strategy,
      title: { project: "関連する案件をまとめる", role: "同じ役割を見渡す", minimal_move: "今の位置を生かす" }[strategy],
      rationale: { project: "同じ案件とつながりのある作業をまとめます。親子の作業は同じ場所で見えるように並べます。",
        role: "指揮・制作・確認を見渡しやすく並べます。親子関係を保ちながら、同じ役割を横に比較できます。",
        minimal_move: "関連する作業をまとめつつ、現在のワークスペースでまとまっているグループを残します。" }[strategy],
      groups, unassignedTabIds: [], warnings,
    });
  }
  return plans;
}
export async function runJevGroupingAnalysis(deps: GroupingAnalysisDependencies): Promise<GroupingAnalysisResult> {
  const now = deps.now ?? (() => performance.now());
  const start = now(); deps.onProgress?.("scanning");
  const scan = await deps.scan(); const scanMs = now() - start;
  let judgeMs = 0; let judgeRequests = 0;
  const exchange = async (requests: JevRequest[]) => {
    const answers = {};
    for (let offset = 0; offset < requests.length; offset += 128) {
      const batch = requests.slice(offset, offset + 128);
      const started = now(); judgeRequests += 1;
      let raw: string;
      try { raw = await deps.judge(JSON.stringify({ requests: batch }), deps.requestId()); }
      finally { judgeMs += now() - started; }
      Object.assign(answers, validateJevResponse(raw, batch));
    }
    return answers;
  };
  deps.onProgress?.("judging");
  const requests = scan.tabs.length ? buildJevRequests(scan) : [];
  const first = await exchange(requests);
  const focused = scan.tabs.length ? buildJevFocusedRequests(scan, first) : [];
  const answers = { ...first, ...await exchange(focused) };
  deps.onProgress?.("validating");
  const validating = now();
  const plans = scan.tabs.length ? composeJevPlans(scan, readJevJudgements(scan, answers)) : [];
  const raw = JSON.stringify({ schemaVersion: 1, plans });
  const parsed = parseGroupingOutput(raw, scan.tabs.map((tab) => tab.id), scan.workspaceIds, scan.workspaces.map((ws) => ws.name));
  return { scan, raw, parsed, retried: false, timings: {
    totalMs: now() - start, scanMs, judgeMs, validationMs: now() - validating, judgeRequests,
  } };
}

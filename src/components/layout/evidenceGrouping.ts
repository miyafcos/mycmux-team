import { clipIdentityName, displayNameForWorkspace, type PaneIdentityResult, type ProjectRegistration } from "../../lib/paneIdentity";
import { identitiesForScan, paneRegistry, readEvidenceScan } from "../../lib/paneEvidence";
import { getTabDisplayLabel } from "../../lib/tabDisplayLabel";
import { reconcileSplitColumnsForPanes } from "../../lib/layoutColumns";
import { familyUnits, roleBuckets, layoutFor, roleNames } from "./jevGrouping";
import { buildJevRoleRequests, readJevJudgements, validateJevResponse, type JevJudgements } from "./jevGroupingDecisions";
import { uniqueGroupingName, type GroupingAnalysisDependencies, type GroupingAnalysisResult, type GroupingScan, type GroupingPlan, type GroupingLayout, type GroupingPaneRole, type GroupingGroup } from "./tabGrouping";

export const EVIDENCE_GROUPING_VERSION = "evidence-grouping-v1";
export function evidenceRole(scan: GroupingScan, index: number): GroupingPaneRole {
  const tab = scan.tabs[index];
  if (scan.tabs.some(t => t.origin?.parentTabId === tab.id)) return "mother";
  if (tab.origin?.parentTabId) return "worker";
  return /確認|検収|レビュー|ゲート|監査|チェック/.test((tab.taskTitle ?? "") + " " + (tab.sessionTitle ?? "")) ? "review" : "unspecified";
}
function tabName(scan: GroupingScan, id: string, identity: PaneIdentityResult, destination?: string): string {
  const tab = scan.tabs.find(t => t.id === id)!;
  const found = identity.tabs.get(id)!;
  const display = destination ? displayNameForWorkspace(found, destination, identity.homes) : found.displayName;
  return clipIdentityName(getTabDisplayLabel({ ...tab, label: tab.label || undefined, displayName: display ?? tab.displayName, agentId: tab.agentKind }));
}
function projectLayout(scan: GroupingScan, ids: string[], identity: PaneIdentityResult, destination?: string): GroupingLayout {
  const count = Math.min(4, ids.length);
  const columns: GroupingLayout["columns"] = Array.from({ length: count }, () => ({ panes: [] }));
  ids.forEach((id, i) => {
    const col = columns[i % count];
    if (!col.panes.length) col.panes.push({ title: tabName(scan, id, identity, destination), role: "unspecified", tabIds: [] });
    col.panes[0].tabIds.push(id);
  });
  return { columns };
}
function fitExisting(scan: GroupingScan, plan: GroupingPlan, identity: PaneIdentityResult) {
  const moving = new Set(plan.groups.filter(g => g.disposition === "reorganize").flatMap(g => g.tabIds));
  const slots = new Map(scan.workspaces.map(w => {
    const surviving = w.panes.filter(p => p.tabs.some(t => !moving.has(t.id)));
    return [w.id, reconcileSplitColumnsForPanes(w.splitColumns, surviving.map(p => p.id))];
  }));
  for (const g of plan.groups) {
    if (g.destination.kind !== "existing_workspace" || !g.layout) continue;
    const destinationId = g.destination.workspaceId;
    const workspace = scan.workspaces.find(w => w.id === destinationId)!;
    const columns = slots.get(workspace.id)!;
    if (columns.length + g.layout.columns.length <= 4) {
      columns.push(...g.layout.columns.map(() => []));
      continue;
    }
    const candidates = workspace.panes.filter(p => p.tabs.some(t => !moving.has(t.id)));
    if (!candidates.length) continue;
    const stacks = new Map<string, string[]>();
    for (const id of g.tabIds) {
      const key = identity.tabs.get(id)?.project?.key;
      const matching = candidates.find(p => p.tabs.some(t => !moving.has(t.id) && key && identity.tabs.get(t.id)?.project?.key === key));
      const lastId = columns.flat().filter(Boolean).slice(-1)[0];
      const target = matching ?? candidates.find(p => p.id === lastId) ?? candidates[candidates.length - 1];
      stacks.set(target.id, [...(stacks.get(target.id) ?? []), id]);
    }
    // Append operations allocate no columns; keep the wire layout within four rows per column.
    const appendPanes = [...stacks].map(([existingPaneId, tabIds]) => ({
      existingPaneId, tabIds, title: tabName(scan, tabIds[0], identity, workspace.id), role: "unspecified" as const,
    }));
    g.layout = { columns: Array.from({ length: Math.ceil(appendPanes.length / 4) }, (_, i) => ({ panes: appendPanes.slice(i * 4, i * 4 + 4) })) };
  }
}
function rationale(scan: GroupingScan, groups: GroupingGroup[], identity: PaneIdentityResult): string {
  const moves = groups.filter(g => g.disposition === "reorganize").flatMap(g => g.tabIds.map(id => {
    const dest = g.destination.kind === "existing_workspace" ? scan.workspaces.find(w => g.destination.kind === "existing_workspace" && w.id === g.destination.workspaceId)?.name : g.title;
    return tabName(scan, id, identity) + " → " + dest;
  }));
  return moves.length ? moves.length + " ペインを動かします: " + moves.slice(0, 3).join("、") + (moves.length > 3 ? "、ほか " + (moves.length - 3) + " 件" : "") : "すべてのペインを今の場所に残します。";
}
export function composeEvidencePlans(scan: GroupingScan, registry: readonly ProjectRegistration[] = paneRegistry(), roleOverrides?: GroupingPaneRole[]): GroupingPlan[] {
  const identity = identitiesForScan(scan, [...registry]);
  const projects = new Map<string, string[]>();
  for (const tab of scan.tabs) {
    const p = identity.tabs.get(tab.id)?.project;
    if (p) projects.set(p.key, [...(projects.get(p.key) ?? []), tab.id]);
  }
  const claims = new Map<string, string>();
  for (const [key] of [...projects].sort((a, b) => (identity.homeScores.get(b[0]) ?? 0) - (identity.homeScores.get(a[0]) ?? 0) || b[1].length - a[1].length)) {
    const home = identity.homes.get(key);
    if (home && ![...claims.values()].includes(home)) claims.set(key, home);
  }
  const plans: GroupingPlan[] = [];
  for (const strategy of ["minimal_move", "project", "role"] as const) {
    const groups: GroupingGroup[] = [];
    const used = new Set<string>();
    const roles = scan.tabs.map((_, i) => {
      const local = evidenceRole(scan, i);
      return local === "mother" || local === "worker" ? local : roleOverrides?.[i] && roleOverrides[i] !== "unspecified" ? roleOverrides[i] : local;
    });
    const judgements: JevJudgements = { roles, health: roles.map(() => "normal"), relations: {} };
    const roleLayout = (ids: string[]) => layoutFor(scan, familyUnits(scan)
      .map(unit => unit.filter(i => ids.includes(scan.tabs[i].id))).filter(unit => unit.length), judgements, "role");
    const canMerge = (ids: string[]) => {
      const layout = roleLayout(ids);
      return ids.length <= 8 && layout.columns.length <= 4 && layout.columns.every(c => c.panes.length <= 4);
    };
    const add = (name: string, ids: string[], home?: string, layout?: GroupingLayout, facetName?: string) => {
      const names = [...new Set([name, facetName].filter((s): s is string => Boolean(s)).map(s => clipIdentityName(s)))];
      const taken = new Set([...scan.workspaces.map(w => w.name), ...groups.map(g => g.title)]);
      for (let attempt = 0; attempt <= names.length; attempt++) {
        const title = names[attempt] ?? uniqueGroupingName(names[names.length - 1], taken);
        const matching = home ? scan.workspaces.find(w => w.id === home)
          : scan.workspaces.find(w => w.name === title || (attempt === 0 && w.name === name));
        const movingIds = matching ? ids.filter(id => scan.tabs.find(t => t.id === id)!.workspaceId !== matching.id) : ids;
        if (!movingIds.length) return;
        const existing = groups.find(g => matching
          ? g.destination.kind === "existing_workspace" && g.destination.workspaceId === matching.id
          : g.destination.kind === "new_workspace" && g.title === title);
        if (existing) {
          const joined = [...existing.tabIds, ...movingIds];
          if (strategy === "role" && !canMerge(joined)) continue;
          existing.tabIds = joined;
          existing.layout = strategy === "role" ? roleLayout(joined) : projectLayout(scan, joined, identity, matching?.id);
          for (const c of existing.layout.columns) for (const p of c.panes) p.title = tabName(scan, p.tabIds[0], identity, matching?.id);
        } else {
          const valid = new Set(movingIds);
          const selectedLayout = layout ? { columns: layout.columns.map(c => ({
            panes: c.panes.map(p => ({ ...p, tabIds: p.tabIds.filter(id => valid.has(id)) })).filter(p => p.tabIds.length),
          })).filter(c => c.panes.length) } : projectLayout(scan, movingIds, identity, matching?.id);
          for (const c of selectedLayout.columns) for (const p of c.panes) p.title = tabName(scan, p.tabIds[0], identity, matching?.id);
          groups.push({ groupId: strategy + "-" + groups.length, title, disposition: "reorganize", adopted: true,
            tabIds: movingIds, layout: selectedLayout, destination: matching
              ? { kind: "existing_workspace", workspaceId: matching.id } : { kind: "new_workspace", proposedName: title } });
        }
        // Only identical role/facet buckets that cannot fit together reach the numbered fallback.
        movingIds.forEach(id => used.add(id));
        return;
      }
    };
    if (strategy === "role") {
      const units = familyUnits(scan).filter(unit => unit.some(i => roles[i] !== "unspecified") && unit.every(i => identity.tabs.get(scan.tabs[i].id)?.project));
      const bounded = units.flatMap(unit => Array.from({ length: Math.ceil(unit.length / 8) }, (_, i) => unit.slice(i * 8, i * 8 + 8)));
      for (const bucket of roleBuckets(bounded, judgements)) {
        const members = bucket.flat();
        const kinds = new Set(members.map(i => roles[i]));
        const role = kinds.size === 1 ? roles[members[0]] : "mixed";
        const ps = [...new Map(members.map(i => { const p = identity.tabs.get(scan.tabs[i].id)!.project!; return [p.key, p]; })).values()];
        let name = ps.length === 1 ? ps[0].short + " " + roleNames[role] : roleNames[role] + " " + ps.map(p => p.short).join("・");
        if (ps.length > 1 && [...name].length > 20) name = roleNames[role] + " " + ps[0].short + " ほか";
        add(name, members.map(i => scan.tabs[i].id), undefined, layoutFor(scan, bucket, judgements, "role"),
          ps.length === 1 ? ps[0].display + " " + roleNames[role] : undefined);
      }
    } else for (const [key, ids] of projects) {
      const project = identity.tabs.get(ids[0])!.project!;
      const home = strategy === "project" ? claims.get(key) : identity.homes.get(key);
      if (strategy === "minimal_move" && !home && (ids.length < 2 || new Set(ids.map(id => scan.tabs.find(t => t.id === id)!.workspaceId)).size < 2)) continue;
      add(project.display, ids, home);
    }
    const kept = scan.tabs.filter(t => !used.has(t.id)).map(t => t.id);
    if (kept.length) groups.push({ groupId: strategy + "-keep", title: "今のまま", disposition: "keep", destination: { kind: "current_locations" }, layout: null, tabIds: kept, adopted: true });
    const plan: GroupingPlan = { nameSource: "evidence", planId: "evidence-" + strategy, title: { minimal_move: "今の場所に寄せる", project: "案件ごとに分ける", role: "役割で見渡す" }[strategy],
      rationale: rationale(scan, groups, identity), strategy, groups, unassignedTabIds: [], warnings: [] };
    fitExisting(scan, plan, identity); plans.push(plan);
  }
  return plans;
}
export function evidenceAnalysis(scan: GroupingScan, roles?: GroupingPaneRole[]): GroupingAnalysisResult {
  // Preserve current names for comparison with the destination proposal.
  return { scan, raw: "", retried: false, parsed: { status: "ok", plans: composeEvidencePlans(scan, undefined, roles), droppedPlans: [], comparisonInsufficient: false, raw: "" } };
}
export async function runEvidenceGroupingAnalysis(deps: GroupingAnalysisDependencies, useJev: boolean): Promise<GroupingAnalysisResult> {
  deps.onProgress?.("scanning");
  const scan = await deps.scan();
  const local = evidenceAnalysis(scan);
  if (!useJev || !scan.tabs.length) return local;
  deps.onProgress?.("judging");
  const answers = {};
  const requests = buildJevRoleRequests(scan);
  for (let i = 0; i < requests.length; i += 128) {
    const batch = requests.slice(i, i + 128);
    const raw = await deps.judge(JSON.stringify({ requests: batch }), deps.requestId());
    Object.assign(answers, validateJevResponse(raw, batch));
  }
  const roles = readJevJudgements(scan, answers).roles;
  const updated = evidenceAnalysis(scan, roles);
  if (local.parsed.status === "ok" && updated.parsed.status === "ok")
    updated.parsed.plans = [...local.parsed.plans.slice(0, 2), updated.parsed.plans[2]];
  return updated;
}
export { readEvidenceScan };

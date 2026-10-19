import { reconcileSplitColumnsForPanes } from "../../lib/layoutColumns";
import { attributeCombinedName } from "./attributeGroupingNames";
import {
  TAB_GROUPING_MAX_COLUMNS, TAB_GROUPING_MAX_PANES_PER_COLUMN, TAB_GROUPING_NAME_MAX,
  type GroupingScan, type GroupingPlan, type GroupingLayout, type GroupingGroup,
} from "./tabGrouping";
import {
  ATTRIBUTE_BIG_PROJECT_TABS, ATTRIBUTE_BUNDLE_MAX_PROJECTS, ATTRIBUTE_BUNDLE_MAX_TABS,
  ATTRIBUTE_HOST_MAX_GUESTS, ATTRIBUTE_HOST_MAX_TABS, ATTRIBUTE_WORKING_WORKSPACE,
  normalizeAttributeName, stripAttributeParenthesis, attributeNamePrefix,
  type JudgedAttributeTab, type AttributeUnit, type AttributeBundle, type AttributeMove,
  type AttributeGroupingResult, type AttributeJudgement,
} from "./attributeGrouping";

const held = (tab: JudgedAttributeTab): boolean => tab.workspaceName === ATTRIBUTE_WORKING_WORKSPACE || tab.pinned || !tab.project;
const size = (group: Pick<AttributeBundle, "units">): number => group.units.reduce((sum, unit) => sum + unit.movable.length, 0);
function combinedName(units: readonly AttributeUnit[]): string {
  return attributeCombinedName(units.map(unit => unit.short));
}

/** Pure prototype port. Only cross-workspace moves enter the applicable plan. */
export function bundleAttributeGrouping(scan: GroupingScan, judgement: AttributeJudgement, fallbackReason?: string): AttributeGroupingResult {
  const { tabs, projects, bundles } = judgement;
  const issues = [...judgement.issues], byId = new Map(tabs.map(tab => [tab.id, tab]));
  const units: AttributeUnit[] = projects.flatMap(project => {
    const movable = project.tabIds.filter(id => !held(byId.get(id)!));
    return movable.length && project.attribute !== "不明" ? [{ ...project, movable }] : [];
  });
  const groups: AttributeBundle[] = [], small: AttributeUnit[] = [];
  const makeGroup = (unit: AttributeUnit, big: boolean): AttributeBundle => ({
    kind: "単独", attribute: unit.attribute, units: [unit], how: big ? "大きな案件" : "近い相手なし",
    keepsWorkspaceId: null, name: "", renameHint: null, tabIds: [],
  });
  for (const unit of [...units].sort((a, b) => b.movable.length - a.movable.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (unit.movable.length >= ATTRIBUTE_BIG_PROJECT_TABS) groups.push(makeGroup(unit, true));
    else small.push(unit);
  }
  const claimed = new Set<string>();
  const relatedTo = (group: Pick<AttributeBundle, "units">, name: string): boolean => {
    const key = normalizeAttributeName(name);
    return Boolean(key) && group.units.some(unit => {
      const project = normalizeAttributeName(unit.name), short = normalizeAttributeName(unit.short);
      return Boolean(project && (key.includes(project) || project.includes(key))) || Boolean(short && key.includes(short));
    });
  };
  const scanOrder = new Map(tabs.map((tab, index) => [tab.id, index]));
  const anchors = new Map<AttributeUnit, { workspaceId: string; order: number }>();
  for (const unit of small) {
    for (const id of unit.movable) {
      const tab = byId.get(id)!;
      if (tab.workspaceName !== ATTRIBUTE_WORKING_WORKSPACE && relatedTo({ units: [unit] }, tab.workspaceName)) {
        anchors.set(unit, { workspaceId: tab.workspaceId, order: scanOrder.get(id)! });
        break;
      }
    }
  }
  const heldAnchors = new Set<AttributeUnit>();
  const claim = (group: AttributeBundle, allowUnrelated = false) => {
    const overlap = new Map<string, number>();
    for (const id of group.units.flatMap(unit => unit.movable)) {
      const workspace = byId.get(id)!.workspaceId;
      overlap.set(workspace, (overlap.get(workspace) ?? 0) + 1);
    }
    for (const [workspaceId, count] of [...overlap].sort((a, b) => b[1] - a[1])) {
      const workspace = scan.workspaces.find(candidate => candidate.id === workspaceId)!;
      if (claimed.has(workspaceId) || workspace.name === ATTRIBUTE_WORKING_WORKSPACE) continue;
      const related = relatedTo(group, workspace.name);
      if (related ? count * 2 >= size(group) : allowUnrelated && count * 2 > size(group)) {
        group.keepsWorkspaceId = workspaceId; claimed.add(workspaceId);
        group.renameHint = related ? null : combinedName(group.units);
        break;
      }
    }
  };
  for (const group of groups) claim(group);
  const home = (unit: AttributeUnit): string => {
    const counts = new Map<string, number>();
    unit.movable.forEach(id => { const workspace = byId.get(id)!.workspaceId; counts.set(workspace, (counts.get(workspace) ?? 0) + 1); });
    return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  };
  const incomingGuest = (unit: AttributeUnit, destination: string | null): boolean =>
    !destination || unit.movable.some(id => byId.get(id)!.workspaceId !== destination);
  const admit = (group: AttributeBundle, unit: AttributeUnit, why: string): boolean => {
    const anchor = anchors.get(unit);
    const guests = group.units.slice(1).filter(member => incomingGuest(member, group.keepsWorkspaceId)).length
      + Number(incomingGuest(unit, group.keepsWorkspaceId));
    if (heldAnchors.has(unit) || (anchor && anchor.workspaceId !== group.keepsWorkspaceId)
      || !small.includes(unit) || group.attribute !== unit.attribute || guests > ATTRIBUTE_HOST_MAX_GUESTS
      || size(group) + unit.movable.length > ATTRIBUTE_HOST_MAX_TABS) return false;
    group.units.push(unit); small.splice(small.indexOf(unit), 1); group.kind = "同居"; group.how = why;
    return true;
  };
  for (const group of groups) if (group.keepsWorkspaceId) {
    const guests = small.filter(unit => unit.attribute === group.attribute && home(unit) === group.keepsWorkspaceId)
      .sort((a, b) => b.movable.length - a.movable.length);
    for (const unit of guests) admit(group, unit, "今の置き場に同居");
  }
  const all = new Map(units.map(unit => [normalizeAttributeName(unit.name), unit]));
  const big = new Map(groups.map(group => [normalizeAttributeName(group.units[0].name), group]));
  for (const bundle of bundles) {
    const keys = bundle.projects.map(name => normalizeAttributeName(stripAttributeParenthesis(name)));
    const reject = (detail = bundle.reason || "条件に合わない") => issues.push({
      id: bundle.projects.join("・"), kind: "AI の組を採らず", detail,
    });
    if (keys.length < 2 || keys.length > ATTRIBUTE_BUNDLE_MAX_PROJECTS || new Set(keys).size !== keys.length || keys.some(key => !all.has(key))) {
      reject(); continue;
    }
    const hosts = keys.flatMap(key => big.has(key) ? [big.get(key)!] : []);
    if (hosts.length === 1) {
      let rejected = false;
      for (const key of keys) {
        const unit = all.get(key)!;
        if (unit === hosts[0].units[0]) continue;
        if (!admit(hosts[0], unit, `AI: ${bundle.reason}`)) rejected = true;
      }
      if (rejected) reject("同居の属性・上限・重複の条件に合わない");
      continue;
    }
    const members = keys.map(key => all.get(key)!);
    if (hosts.length || members.some(unit => !small.includes(unit)) || new Set(members.map(unit => unit.attribute)).size !== 1
      || members.reduce((count, unit) => count + unit.movable.length, 0) > ATTRIBUTE_BUNDLE_MAX_TABS) { reject(); continue; }
    members.forEach(unit => small.splice(small.indexOf(unit), 1));
    groups.push({ ...makeGroup(members[0], false), kind: "まとめ", units: members, how: `AI: ${bundle.reason}` });
  }
  for (const unit of [...small].sort((a, b) => b.movable.length - a.movable.length)) {
    const target = groups.find(group => group.attribute === unit.attribute && group.units.every(item => item.movable.length < ATTRIBUTE_BIG_PROJECT_TABS)
      && group.units.length < ATTRIBUTE_BUNDLE_MAX_PROJECTS && size(group) + unit.movable.length <= ATTRIBUTE_BUNDLE_MAX_TABS);
    if (target) {
      target.units.push(unit); target.kind = "まとめ";
      target.how = target.how.startsWith("AI:") ? target.how + `／同じ属性で「${unit.short}」を追加` : "同じ属性で詰めた";
    } else groups.push(makeGroup(unit, false));
  }
  // Reserve named homes before any unrelated receiver can claim them.
  const anchored = groups.filter(group => group.kind === "まとめ").flatMap(group => group.units.flatMap(unit => {
    const anchor = anchors.get(unit);
    return anchor ? [{ group, unit, ...anchor }] : [];
  })).sort((a, b) => b.unit.movable.length - a.unit.movable.length || a.order - b.order);
  for (const { group, unit, workspaceId } of anchored) {
    if (group.keepsWorkspaceId === workspaceId) continue;
    if (group.keepsWorkspaceId || claimed.has(workspaceId)) {
      group.units.splice(group.units.indexOf(unit), 1);
      heldAnchors.add(unit);
      const index = small.indexOf(unit);
      if (index >= 0) small.splice(index, 1);
      issues.push({ id: unit.name, kind: "錨の案件を今の場所に残す",
        detail: "錨の受け皿が別の組に使われているか、組内の別の錨と競合するため組から外す" });
    } else {
      group.keepsWorkspaceId = workspaceId; group.renameHint = null; claimed.add(workspaceId);
      group.how += "／錨のワークスペースを引き継ぐ";
    }
  }
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group.units.length) groups.splice(index, 1);
    else group.kind = group.units.length === 1 ? "単独"
      : group.units.some(unit => unit.movable.length >= ATTRIBUTE_BIG_PROJECT_TABS) ? "同居" : "まとめ";
  }
  const lonely = groups.filter(group => group.units.length === 1 && group.units[0].movable.length < ATTRIBUTE_BIG_PROJECT_TABS);
  for (const group of lonely) groups.splice(groups.indexOf(group), 1);
  for (const group of [...groups].filter(group => !group.keepsWorkspaceId).sort((a, b) => size(b) - size(a))) claim(group, true);
  for (const group of lonely) {
    const unit = group.units[0], current = home(unit);
    const hosts = [...big.values()].filter(host => host.keepsWorkspaceId && host.attribute === unit.attribute)
      .sort((a, b) => Number(b.keepsWorkspaceId === current) - Number(a.keepsWorkspaceId === current)
        || b.units[0].movable.length - a.units[0].movable.length);
    if (!hosts.some(host => admit(host, unit, "同じ属性の空きへ同居"))) issues.push({
      id: unit.name, kind: "小さい案件を今の場所に残す", detail: "近い相手と同居の空きがないため新規ワークスペースは作らない",
    });
  }
  const taken = new Set(scan.workspaces.map(workspace => workspace.name));
  const accepted = groups.filter(group => {
    group.tabIds = group.units.flatMap(unit => unit.movable);
    if (group.keepsWorkspaceId) {
      group.name = scan.workspaces.find(workspace => workspace.id === group.keepsWorkspaceId)!.name;
      return true;
    }
    const candidates = [combinedName(group.units)];
    const name = candidates.find(candidate => candidate && !taken.has(candidate) && !/[\u0000-\u001f\u007f]/u.test(candidate));
    if (!name) {
      issues.push({ id: candidates[0], kind: "名前の衝突", detail: "材料の名前だけでは新規名を区別できないため今の場所に残す" });
      return false;
    }
    if (name !== group.units.map(unit => unit.short).join("・")) issues.push({
      id: name, kind: "新規名の呼び名を省略", detail: "20文字上限に収めるため後ろの呼び名を丸ごと省き、単独の長い呼び名だけ語の境界で切る" });
    group.name = name; taken.add(name); return true;
  });
  const moving = new Set(accepted.flatMap(group => group.tabIds.filter(id => !group.keepsWorkspaceId || byId.get(id)!.workspaceId !== group.keepsWorkspaceId))
    .map(id => byId.get(id)!.tabId));
  const applicable: GroupingGroup[] = [], moves: AttributeMove[] = [];
  for (const [index, group] of accepted.entries()) {
    const incoming = group.tabIds.filter(id => moving.has(byId.get(id)!.tabId));
    if (!incoming.length) continue;
    const destination = group.keepsWorkspaceId;
    incoming.forEach(id => moves.push({ id, tabId: byId.get(id)!.tabId, from: byId.get(id)!.workspaceId, to: destination ?? `(新) ${group.name}` }));
    applicable.push({
      groupId: `attribute-${index + 1}`, title: attributeNamePrefix(group.name, TAB_GROUPING_NAME_MAX), disposition: "reorganize", adopted: true,
      destination: destination ? { kind: "existing_workspace", workspaceId: destination } : { kind: "new_workspace", proposedName: group.name },
      tabIds: incoming.map(id => byId.get(id)!.tabId), layout: attributeLayout(scan, incoming.map(id => byId.get(id)!), moving, destination),
    });
  }
  const kept = tabs.filter(tab => !moving.has(tab.tabId)).map(tab => tab.tabId);
  if (kept.length) applicable.push({ groupId: "attribute-keep", title: "今のまま", disposition: "keep", adopted: true,
    destination: { kind: "current_locations" }, layout: null, tabIds: kept });
  const rationale = accepted.map(group => `${group.name} / ${group.attribute}: ${group.units.map(unit => `${unit.name} (${unit.movable.length})`).join("・")}。 ${group.how}`
    + (group.renameHint ? `。付け直すなら候補「${group.renameHint}」(名前は変えません)` : "")).join("\n");
  const plan: GroupingPlan = { nameSource: "evidence", planId: "attribute-grouping", title: "属性でまとめる", strategy: "attribute",
    rationale: (fallbackReason ? `AI の判定なし (${fallbackReason})。\n` : "") + (rationale || "確定できる組がないため、すべてのタブを今の場所に残します。"),
    groups: applicable, unassignedTabIds: [], warnings: [] };
  return { tabs, projects, issues, groups: accepted, moves, plan, ...(fallbackReason ? { fallbackReason } : {}) };
}

function attributeLayout(scan: GroupingScan, incoming: JudgedAttributeTab[], moving: ReadonlySet<string>, destination: string | null): GroupingLayout {
  const workspace = scan.workspaces.find(candidate => candidate.id === destination);
  const residents = workspace?.panes.filter(pane => pane.tabs.some(tab => !moving.has(tab.id))) ?? [];
  const residentColumns = reconcileSplitColumnsForPanes(workspace?.splitColumns, residents.map(pane => pane.id));
  const columns = Array.from({ length: TAB_GROUPING_MAX_COLUMNS }, (_, index) => ({
    ...(residentColumns[index]?.length ? { existingColumnPaneId: residentColumns[index][0] } : {}),
    rows: residentColumns[index]?.length ?? 0, panes: [] as GroupingLayout["columns"][number]["panes"],
  }));
  for (const tab of incoming) {
    const column = columns.filter(candidate => candidate.rows + candidate.panes.length < TAB_GROUPING_MAX_PANES_PER_COLUMN)
      .sort((a, b) => a.rows + a.panes.length - b.rows - b.panes.length)[0];
    const title = attributeNamePrefix(tab.title || tab.label || tab.project || "(なし)", TAB_GROUPING_NAME_MAX);
    if (column) column.panes.push({ title, role: "unspecified", tabIds: [tab.tabId] });
    else {
      const own = columns.flatMap(candidate => candidate.panes)[0];
      if (own) own.tabIds.push(tab.tabId);
      else columns[0].panes.push({ existingPaneId: residents[residents.length - 1].id, title, role: "unspecified", tabIds: [tab.tabId] });
    }
  }
  return { columns: columns.filter(column => column.panes.length).map(({ rows: _rows, ...column }) => column) };
}

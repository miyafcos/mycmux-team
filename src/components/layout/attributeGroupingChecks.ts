import {
  ATTRIBUTE_BUNDLE_MAX_PROJECTS, ATTRIBUTE_BUNDLE_MAX_TABS, ATTRIBUTE_HOST_MAX_GUESTS, ATTRIBUTE_HOST_MAX_TABS,
  ATTRIBUTE_WORKING_WORKSPACE, attributeNameHasMaterial, normalizeAttributeName,
  type AttributeGroupingResult,
} from "./attributeGrouping";
import { TAB_GROUPING_MAX_COLUMNS, TAB_GROUPING_MAX_PANES_PER_COLUMN, validateEditedPlan, type GroupingScan } from "./tabGrouping";

export type AttributeChecks = Record<"placement" | "protected" | "limits" | "attributes" | "names" | "materials", string[]>;

/** Independent checks used by fixture tests and the offline replay. */
export function checkAttributeGrouping(scan: GroupingScan, result: AttributeGroupingResult): AttributeChecks {
  const errors: AttributeChecks = { placement: [], protected: [], limits: [], attributes: [], names: [], materials: [] };
  const byId = new Map(result.tabs.map(tab => [tab.id, tab])), grouped = new Set<string>(), keeps = new Set<string>();
  errors.placement.push(...validateEditedPlan(result.plan, scan.tabs.map(tab => tab.id), scan.workspaceIds, scan.workspaces.map(workspace => workspace.name)));
  const count = new Map<string, number>();
  result.plan.groups.flatMap(group => group.tabIds).concat(result.plan.unassignedTabIds).forEach(id => count.set(id, (count.get(id) ?? 0) + 1));
  if (count.size !== scan.tabs.length || [...count].some(([id, n]) => n !== 1 || !scan.tabs.some(tab => tab.id === id))) errors.placement.push("タブの配置が一意でない");
  const moves = new Set(result.moves.map(move => move.tabId));
  const plannedMoves = new Set(result.plan.groups.filter(group => group.disposition === "reorganize").flatMap(group => group.tabIds));
  if (moves.size !== result.moves.length || moves.size !== plannedMoves.size || [...moves].some(id => !plannedMoves.has(id))) errors.placement.push("移動の記録と適用案が違う");
  for (const tab of result.tabs) if ((tab.pinned || tab.workspaceName === ATTRIBUTE_WORKING_WORKSPACE || !tab.project)
    && (moves.has(tab.tabId) || plannedMoves.has(tab.tabId))) errors.protected.push(tab.id);
  for (const group of result.groups) {
    if (group.tabIds.some(id => !byId.has(id) || grouped.has(id))) errors.placement.push(group.name);
    group.tabIds.forEach(id => grouped.add(id));
    const memberIds = group.units.flatMap(unit => unit.movable);
    if ([...group.tabIds].sort().join() !== [...memberIds].sort().join()) errors.placement.push("組と案件のタブが違う");
    if (group.kind === "まとめ" && (group.units.length < 2 || group.units.length > ATTRIBUTE_BUNDLE_MAX_PROJECTS || group.tabIds.length > ATTRIBUTE_BUNDLE_MAX_TABS))
      errors.limits.push(group.name);
    const incomingGuests = group.units.slice(1).filter(unit => !group.keepsWorkspaceId
      || unit.movable.some(id => byId.get(id)?.workspaceId !== group.keepsWorkspaceId)).length;
    if (group.kind === "同居" && (group.units.length < 2 || incomingGuests > ATTRIBUTE_HOST_MAX_GUESTS || group.tabIds.length > ATTRIBUTE_HOST_MAX_TABS))
      errors.limits.push(group.name);
    if (new Set(group.units.map(unit => unit.attribute)).size !== 1 || group.units.some(unit => unit.attribute !== group.attribute || unit.attribute === "不明"))
      errors.attributes.push(group.name);
    if (group.keepsWorkspaceId) {
      const workspace = scan.workspaces.find(workspace => workspace.id === group.keepsWorkspaceId);
      if (!workspace || workspace.name !== group.name || keeps.has(group.keepsWorkspaceId) || workspace.name === ATTRIBUTE_WORKING_WORKSPACE) errors.names.push(group.name);
      keeps.add(group.keepsWorkspaceId);
    } else for (const part of group.name.split("・")) {
      if (!normalizeAttributeName(part) || !group.units.some(unit => normalizeAttributeName(unit.name).includes(normalizeAttributeName(part)))) errors.materials.push(group.name);
    }
    for (const unit of group.units) {
      const members = unit.tabIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
      if (!attributeNameHasMaterial(unit.name, members) || !unit.name.includes(unit.short)) errors.materials.push(unit.name);
    }
  }
  for (const group of result.plan.groups) {
    if (group.destination.kind === "existing_workspace" && ("proposedName" in group.destination || "nameEdited" in group.destination)) errors.names.push(group.groupId);
    if (group.layout && (group.layout.columns.length > TAB_GROUPING_MAX_COLUMNS
      || group.layout.columns.some(column => column.panes.length > TAB_GROUPING_MAX_PANES_PER_COLUMN))) errors.limits.push(group.groupId);
  }
  return errors;
}

import type { Pane, PaneTab, Workspace } from "../types";

export interface GroupMembershipOptions {
  parentTabIdByTabId: Readonly<Record<string, string | undefined>>;
  originRootTabIds: ReadonlySet<string>;
}

function parentTabId(tab: PaneTab): string | undefined {
  return tab.origin?.parentTabId;
}

function normalizeAbsoluteCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const normalized = cwd.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return /^(?:[a-z]:\/|\/)/.test(normalized) ? normalized : null;
}

function cycleRootTabId(
  cycleStartTabId: string,
  parentTabIdByTabId: Readonly<Record<string, string | undefined>>,
): string {
  const cycle = new Set<string>();
  let current = cycleStartTabId;
  do {
    cycle.add(current);
    current = parentTabIdByTabId[current] ?? "";
  } while (current && current !== cycleStartTabId && !cycle.has(current));
  return [...cycle].sort()[0];
}

function rootTabId(
  startTabId: string,
  startParentTabId: string,
  parentTabIdByTabId: Readonly<Record<string, string | undefined>>,
): string {
  const seen = new Set<string>();
  let current = startTabId;
  let parent = startParentTabId;
  while (parent) {
    seen.add(current);
    if (seen.has(parent)) return cycleRootTabId(parent, parentTabIdByTabId);
    current = parent;
    parent = parentTabIdByTabId[current] ?? "";
  }
  return current;
}

export function resolveGroupKey(
  tab: PaneTab,
  pane: Pane,
  opts: GroupMembershipOptions,
): string | null {
  const parent = parentTabId(tab);
  if (parent) {
    return `origin:${rootTabId(tab.id, parent, opts.parentTabIdByTabId)}`;
  }
  if (opts.originRootTabIds.has(tab.id)) return `origin:${tab.id}`;
  const cwd = normalizeAbsoluteCwd(pane.cwd);
  return cwd ? `cwd:${cwd}` : null;
}

export function buildGroups(workspaces: Workspace[]): Map<string, string[]> {
  const parentTabIdByTabId: Record<string, string | undefined> = {};
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs) parentTabIdByTabId[tab.id] = parentTabId(tab);
    }
  }

  const originRootTabIds = new Set<string>();
  for (const [tabId, parent] of Object.entries(parentTabIdByTabId)) {
    if (parent) originRootTabIds.add(rootTabId(tabId, parent, parentTabIdByTabId));
  }

  const groups = new Map<string, string[]>();
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs) {
        const key = resolveGroupKey(tab, pane, { parentTabIdByTabId, originRootTabIds });
        if (!key) continue;
        groups.set(key, [...(groups.get(key) ?? []), tab.id]);
      }
    }
  }
  return groups;
}

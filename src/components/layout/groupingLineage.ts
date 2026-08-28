import { deriveDisplayStatus } from "../../lib/notificationStatus";
import type { PaneMetadata, PaneVolatileMetadata } from "../../stores/paneMetadataStore";
import type { Workspace } from "../../types/workspace";

export type GroupingLiveStatus = "working" | "waiting" | "done" | "error" | "idle";

export interface GroupingLineageNode {
  tabId: string;
  parentTabId: string | null;
  rootTabId: string;
  depth: number;
  childTabIds: string[];
  orphan: boolean;
  cycleBroken: boolean;
}

export interface GroupingLiveInfo {
  status: GroupingLiveStatus;
  lastOutputAt: number | null;
  agentKind: string | null;
}

export function groupingLiveInfo(input: {
  declared: boolean;
  metadata?: PaneMetadata;
  volatile?: PaneVolatileMetadata;
  attentionCategory?: "waiting" | "error" | "done" | null;
  tabAgentKind?: string | null;
}): GroupingLiveInfo {
  const agentKind = input.metadata?.agentKind ?? input.tabAgentKind ?? null;
  if (input.declared) return { status: "idle", lastOutputAt: null, agentKind };

  const displayStatus = deriveDisplayStatus(input.metadata, input.volatile);
  const status: GroupingLiveStatus = input.attentionCategory === "error"
    ? "error"
    : input.attentionCategory === "waiting" || displayStatus === "waiting"
      ? "waiting"
      : displayStatus === "working"
        ? "working"
        : input.attentionCategory === "done" || input.metadata?.agentStatus === "done"
          ? "done"
          : "idle";
  return {
    status,
    lastOutputAt: input.volatile?.backendLastOutputAt ?? input.metadata?.backendLastOutputAt ?? null,
    agentKind,
  };
}

function orderedTabs(workspaces: readonly Workspace[]) {
  return workspaces.flatMap((workspace) => {
    const columns = workspace.splitColumns ?? [workspace.panes.map((pane) => pane.id)];
    return columns.flatMap((column) => column.flatMap((paneId) => (
      workspace.panes.find((pane) => pane.id === paneId)?.tabs ?? []
    )));
  });
}

function cycleRoots(
  tabIds: readonly string[],
  parentByTabId: ReadonlyMap<string, string | null>,
): Map<string, string> {
  const rootByMember = new Map<string, string>();
  for (const tabId of tabIds) {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: string | null = tabId;
    while (current) {
      const repeatedAt = pathIndex.get(current);
      if (repeatedAt !== undefined) {
        const cycle = path.slice(repeatedAt);
        const root = [...cycle].sort()[0];
        for (const member of cycle) rootByMember.set(member, root);
        break;
      }
      if (rootByMember.has(current)) break;
      pathIndex.set(current, path.length);
      path.push(current);
      current = parentByTabId.get(current) ?? null;
    }
  }
  return rootByMember;
}

function rootAndDepth(
  tabId: string,
  parentByTabId: ReadonlyMap<string, string | null>,
  cycleRootByMember: ReadonlyMap<string, string>,
  orphanRootByTabId: ReadonlyMap<string, string>,
): { rootTabId: string; depth: number } {
  let current = tabId;
  let depth = 0;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const orphanRoot = orphanRootByTabId.get(current);
    if (orphanRoot) return { rootTabId: orphanRoot, depth };
    const cycleRoot = cycleRootByMember.get(current);
    if (cycleRoot === current) return { rootTabId: cycleRoot, depth };
    const parent = parentByTabId.get(current) ?? null;
    if (!parent) return { rootTabId: current, depth };
    current = parent;
    depth += 1;
  }
  const cycleRoot = cycleRootByMember.get(current) ?? [...seen].sort()[0];
  return { rootTabId: cycleRoot, depth: 0 };
}

export function groupingLineageNodes(
  workspaces: readonly Workspace[],
): Map<string, GroupingLineageNode> {
  const tabs = orderedTabs(workspaces);
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const orphanRootByTabId = new Map<string, string>();
  const parentByTabId = new Map<string, string | null>();
  for (const tab of tabs) {
    const parent = tab.origin?.parentTabId;
    if (parent && !tabIds.has(parent)) orphanRootByTabId.set(tab.id, parent);
    parentByTabId.set(tab.id, parent && tabIds.has(parent) ? parent : null);
  }

  const childTabIdsByParent = new Map<string, string[]>();
  for (const tab of tabs) {
    const parent = parentByTabId.get(tab.id);
    if (!parent) continue;
    childTabIdsByParent.set(parent, [...(childTabIdsByParent.get(parent) ?? []), tab.id]);
  }

  const cycleRootByMember = cycleRoots(tabs.map((tab) => tab.id), parentByTabId);
  return new Map(tabs.map((tab) => {
    const resolved = rootAndDepth(
      tab.id,
      parentByTabId,
      cycleRootByMember,
      orphanRootByTabId,
    );
    return [tab.id, {
      tabId: tab.id,
      parentTabId: parentByTabId.get(tab.id) ?? null,
      rootTabId: resolved.rootTabId,
      depth: resolved.depth,
      childTabIds: childTabIdsByParent.get(tab.id) ?? [],
      orphan: orphanRootByTabId.has(tab.id),
      cycleBroken: cycleRootByMember.has(tab.id),
    }];
  }));
}

export function groupingTabLocations(
  workspaces: readonly Workspace[],
): Map<string, { workspaceId: string; paneId: string; label: string }> {
  const locations = new Map<string, { workspaceId: string; paneId: string; label: string }>();
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs) {
        locations.set(tab.id, {
          workspaceId: workspace.id,
          paneId: pane.id,
          label: tab.label ?? "",
        });
      }
    }
  }
  return locations;
}

export function groupingLiveInfoByTabId(
  workspaces: readonly Workspace[],
  input: {
    metadataBySession: Readonly<Record<string, PaneMetadata | undefined>>;
    volatileBySession: Readonly<Record<string, PaneVolatileMetadata | undefined>>;
    attentionCategoryByTabId: Readonly<Record<string, "waiting" | "error" | "done" | null | undefined>>;
  },
): Map<string, GroupingLiveInfo> {
  return new Map(orderedTabs(workspaces).map((tab) => {
    const metadata = input.metadataBySession[tab.sessionId];
    return [tab.id, groupingLiveInfo({
      declared: tab.lifecycle === "declared",
      metadata,
      volatile: input.volatileBySession[tab.sessionId],
      attentionCategory: input.attentionCategoryByTabId[tab.id],
      tabAgentKind: tab.agentKind,
    })];
  }));
}

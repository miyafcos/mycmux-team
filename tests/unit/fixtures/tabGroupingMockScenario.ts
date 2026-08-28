import type { GroupingPlan, GroupingScan } from "../../../src/components/layout/tabGrouping";
import type { Pane, PaneTab, Workspace } from "../../../src/types";

const TAB_LABELS = {
  "t請求": "請求 期間確認",
  tkessan: "codex-kessan",
  "t模試": "模試 組版判断",
  tb2: "momosta-b2-r4",
  tosaka: "osaka-sample-pack",
  "t統括": "開発統括",
  "t配置図": "配置図 Gate2-6",
  tshinso: "shinso-kenshu",
  "t数学": "数学 量産監視",
  tudr2: "udr-02-codex",
} as const;

type MockTabId = keyof typeof TAB_LABELS;

const TAB_ORIGINS: Partial<Record<MockTabId, PaneTab["origin"]>> = {
  "t配置図": { kind: "agent", parentTabId: "t統括" },
  tkessan: { kind: "agent", parentTabId: "t請求" },
  tosaka: { kind: "agent", parentTabId: "t請求" },
  tudr2: { kind: "agent", parentTabId: "t数学" },
  tshinso: { kind: "agent", parentTabId: "t存在しない" },
};

function tab(id: MockTabId, origin?: PaneTab["origin"]): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "terminal",
    agentKind: "codex",
    label: TAB_LABELS[id],
    cwd: "C:\\mock",
    ...(origin ? { origin } : {}),
  };
}

function pane(id: string, tabIds: MockTabId[]): Pane {
  const tabs = tabIds.map((id) => tab(id, TAB_ORIGINS[id]));
  return {
    id,
    agentId: "terminal",
    sessionId: tabs[0]?.sessionId ?? `session-${id}`,
    tabs,
    activeTabId: tabs[0]?.id ?? "",
  };
}

export const mockWorkspaces: Workspace[] = [
  {
    id: "wsA",
    name: "なるゼミ・モモスタ",
    gridTemplateId: "2x1",
    panes: [pane("pane-a1", ["t請求", "tkessan", "t模試", "tb2"]), pane("pane-a2", ["tosaka"])],
    splitColumns: [["pane-a1"], ["pane-a2"]],
    status: "running",
    createdAt: 1,
  },
  {
    id: "wsB",
    name: "mycmux",
    gridTemplateId: "2x1",
    panes: [pane("pane-b1", ["t統括", "t配置図"]), pane("pane-b2", ["tshinso"])],
    splitColumns: [["pane-b1"], ["pane-b2"]],
    status: "running",
    createdAt: 2,
  },
  {
    id: "wsC",
    name: "UDR・PC整理",
    gridTemplateId: "1x1",
    panes: [pane("pane-c1", ["t数学", "tudr2"])],
    splitColumns: [["pane-c1"]],
    status: "running",
    createdAt: 3,
  },
];

const ALL_TAB_IDS = Object.keys(TAB_LABELS) as MockTabId[];

function group(
  groupId: string,
  title: string,
  columns: MockTabId[][],
): GroupingPlan["groups"][number] {
  const tabIds = columns.flat();
  return {
    groupId,
    title,
    disposition: "reorganize",
    destination: { kind: "new_workspace", proposedName: title },
    layout: {
      columns: columns.map((ids, index) => ({
        panes: [{ title: index === 0 ? "母艦" : "作業", role: index === 0 ? "mother" : "worker", tabIds: ids }],
      })),
    },
    tabIds,
    adopted: true,
  };
}

function remainingTabIds(groups: GroupingPlan["groups"]): string[] {
  const used = new Set(groups.flatMap((item) => item.tabIds));
  return ALL_TAB_IDS.filter((id) => !used.has(id));
}

const projectGroups = [
  group("g1", "モモスタ制作", [["t模試", "tb2"], ["t数学"]]),
  group("g2", "請求と決算", [["t請求", "tkessan"]]),
];
const roleGroups = [
  group("g3", "母艦あつめ", [["t統括", "t配置図", "t請求"]]),
  group("g4", "作業者あつめ", [["tb2", "t数学", "tudr2"]]),
];
const minimalGroups = [group("g5", "決算分離", [["tkessan"]])];

export const mockGroupingPlans: GroupingPlan[] = [
  {
    planId: "p2",
    title: "役割別",
    rationale: "母艦系と作業者系で分ける",
    strategy: "role",
    groups: roleGroups,
    unassignedTabIds: remainingTabIds(roleGroups),
    warnings: [],
  },
  {
    planId: "p3",
    title: "移動最小",
    rationale: "混在ペインの分解だけ行う",
    strategy: "minimal_move",
    groups: minimalGroups,
    unassignedTabIds: remainingTabIds(minimalGroups),
    warnings: [],
  },
  {
    planId: "p1",
    title: "案件別",
    rationale: "案件ごとに母艦と作業者をまとめる",
    strategy: "project",
    groups: projectGroups,
    unassignedTabIds: remainingTabIds(projectGroups),
    warnings: [{ code: "LOW_CONFIDENCE", tabIds: ["tshinso"], message: "所属先を確認してください" }],
  },
];

export const mockGroupingScan: GroupingScan = {
  scannedAt: 1,
  tabs: mockWorkspaces.flatMap((workspace) => workspace.panes.flatMap((item, column) => item.tabs.map((itemTab) => ({
    id: itemTab.id,
    sessionId: itemTab.sessionId,
    label: itemTab.label ?? "",
    cwd: itemTab.cwd ?? "C:\\mock",
    agentKind: itemTab.agentKind ?? "codex",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    paneId: item.id,
    column,
    lastOutputAt: null,
    tail: [],
  })))),
  lineageClusters: [],
  baseline: mockWorkspaces.flatMap((workspace) => workspace.panes.flatMap((item) => item.tabs.map((itemTab) => ({
    tabId: itemTab.id,
    workspaceId: workspace.id,
    paneId: item.id,
    sessionId: itemTab.sessionId,
  })))),
  workspaceIds: mockWorkspaces.map((workspace) => workspace.id),
  workspaces: mockWorkspaces,
};

export const mockGroupingAnalysis = {
  scan: mockGroupingScan,
  parsed: {
    status: "ok" as const,
    plans: mockGroupingPlans,
    droppedPlans: [],
    comparisonInsufficient: false,
    raw: "fixture",
  },
  retried: false,
  raw: "fixture",
};

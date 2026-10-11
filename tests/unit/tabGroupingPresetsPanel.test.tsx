// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ pending: [] as Array<{ strategy: string | undefined; resolve: (value: unknown) => void }> }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()), invoke: vi.fn(async () => true),
}));
vi.mock("../../src/lib/groupingPrecompute", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/lib/groupingPrecompute")>()),
  markGroupingInterest: vi.fn(() => false),
  peekGroupingPrecompute: vi.fn(() => ({ kind: "miss" })),
  requestGroupingPrecomputeRefresh: vi.fn(),
  cancelForegroundGroupingAnalysis: vi.fn(),
  generateForegroundGroupingAnalysis: vi.fn((_force, _progress, strategy) => new Promise(resolve => {
    harness.pending.push({ strategy, resolve });
  })),
}));


vi.mock("../../src/components/layout/groupingBoundary", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/components/layout/groupingBoundary")>();
  return { ...actual, groupingBoundary: { ...actual.groupingBoundary,
    prepare: vi.fn(actual.groupingBoundary.prepare),
    commit: vi.fn(actual.groupingBoundary.commit),
    undo: vi.fn(actual.groupingBoundary.undo),
  } };
});

import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import { TabGroupingPanel } from "../../src/components/layout/TabGroupingPanel";
import { buildLocalGroupingAnalysis, buildLocalGroupingScan } from "../../src/components/layout/groupingLocalPlan";
import { runEvidenceGroupingAnalysis } from "../../src/components/layout/evidenceGrouping";
import { groupingBoundary } from "../../src/components/layout/groupingBoundary";
import { GROUPING_PRESET_STORAGE_KEY } from "../../src/components/layout/tabGrouping";
import { __resetGroupingPrecomputeForTests } from "../../src/lib/groupingPrecompute";
import { __resetPersistenceCoordinatorForTests, markPersistentSchemaSupported } from "../../src/lib/workspacePersistenceCoordinator";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useJevSettingsStore } from "../../src/stores/jevSettingsStore";
import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";
import { __resetGroupingRuntimeForTests, recordPersistentSchemaState } from "../../src/stores/groupingRuntimeStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Workspace } from "../../src/types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

function workspaces(): Workspace[] {
  return [{ id: "source", name: "作業机", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: ["working", "idle", "recent"].map(id => ({
      id: `pane-${id}`, agentId: "shell-starter", sessionId: `session-${id}`, activeTabId: id,
      tabs: [{ id, agentId: "shell-starter", sessionId: `session-${id}`, type: "terminal", label: id, origin: { kind: "human" } }],
    })), splitColumns: [["pane-working"], ["pane-idle"], ["pane-recent"]] }];
}

function identityPairs(layout: Workspace[]): string[][] {
  return layout.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs.map(tab => [tab.id, tab.sessionId])))
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function crowdedWorkspaces(rows: number[], name: string): Workspace[] {
  const makePane = (id: string): Workspace["panes"][number] => ({
    id: `pane-${id}`, agentId: "shell-starter", sessionId: `session-${id}`, activeTabId: id,
    tabs: [{ id, agentId: "shell-starter", sessionId: `session-${id}`, type: "terminal", label: id, origin: { kind: "human" } }],
  });
  const sourcePanes = ["focus", "working", "working-2", "approval"].map(makePane);
  const residentColumns = rows.map((count, column) => Array.from({ length: count }, (_, row) => makePane(`resident-${column}-${row}`)));
  return [
    { id: "source", name: "作業机", gridTemplateId: "4x1", status: "running", createdAt: 1,
      panes: sourcePanes, splitColumns: sourcePanes.map(pane => [pane.id]) },
    { id: "destination", name, gridTemplateId: "4x4", status: "running", createdAt: 2,
      panes: residentColumns.flat(), splitColumns: residentColumns.map(column => column.map(pane => pane.id)) },
  ];
}

function prepareCrowdedPreset(rows: number[], strategy: "active_watch" | "main_sessions"): Workspace[] {
  const original = crowdedWorkspaces(rows, strategy === "active_watch" ? "稼働中" : "メイン");
  useWorkspaceListStore.setState({ workspaces: original, layoutRevision: useWorkspaceListStore.getState().layoutRevision + 1 });
  useUiStore.setState({ activePaneId: "session-focus", lastActivePaneId: "session-focus" });
  usePaneMetadataStore.setState({ metadata: { "session-working": { agentStatus: "working" }, "session-working-2": { agentStatus: "working" } },
    volatileMetadata: { "session-working": { backendLastOutputAt: Date.now() }, "session-working-2": { backendLastOutputAt: Date.now() - 1 } } });
  useSessionAttentionStore.setState({ attentionBySession: {
    "session-approval": { sessionId: "session-approval", sessionEpoch: 1, attentionId: "approval-event", kind: "approval", detail: null,
      sessionRevision: 1, uiState: "waiting", stateSince: Date.now(), occurrenceOrder: 1 },
  } });
  useAiSettingsStore.setState({ aiEnabled: false });
  localStorage.setItem(GROUPING_PRESET_STORAGE_KEY, strategy);
  return structuredClone(original);
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
async function mount(): Promise<void> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => root!.render(<TabGroupingPanel open visible onClose={() => {}} />));
  await settle();
}
function preset(value: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-grouping-preset="${value}"]`);
  if (!button) throw new Error(`Preset missing: ${value}`);
  return button;
}
function button(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === label);
  if (!button) throw new Error(`Button missing: ${label}`);
  return button;
}
async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}
function firstPlan(): HTMLElement | null {
  return document.querySelector('[role="radio"][data-strategy]');
}
async function currentAnalysis() {
  const metadata = usePaneMetadataStore.getState();
  const attention = useSessionAttentionStore.getState();
  const scan = await buildLocalGroupingScan({
    workspaces: useWorkspaceListStore.getState().workspaces, metadata: metadata.metadata, now: Date.now(), attentionByTabId: {},
    attentionBySession: attention.attentionBySession, seenAttentionByTab: attention.seenAttentionByTab,
    questionsBySession: useAskQuestionStore.getState().bySession,
    lastOutputBySession: { "session-recent": metadata.volatileMetadata["session-recent"]?.backendLastOutputAt ?? 0 },
  });
  return buildLocalGroupingAnalysis(scan, {})!;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  harness.pending = [];
  __resetGroupingPrecomputeForTests();
  __resetGroupingRuntimeForTests();
  __resetPersistenceCoordinatorForTests();
  markPersistentSchemaSupported(1);
  recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
  const nextWorkspaces = workspaces();
  const previous = useWorkspaceListStore.getState();
  const changed = JSON.stringify(previous.workspaces) !== JSON.stringify(nextWorkspaces);
  useWorkspaceListStore.setState({ workspaces: nextWorkspaces, layoutRevision: previous.layoutRevision + Number(changed), activeWorkspaceId: "source", lastActivePaneByWorkspace: {} });
  useUiStore.setState({ activePaneId: "session-working", lastActivePaneId: "session-working", focusRevision: 0 });
  usePaneMetadataStore.setState({ metadata: { "session-working": { agentStatus: "working" } },
    volatileMetadata: { "session-recent": { backendLastOutputAt: Date.now() - 4 * 60_000 } } });
  useSessionAttentionStore.getState().resetForTests();
  useAskQuestionStore.getState().resetForTests();
  useAiSettingsStore.setState({ aiEnabled: true });
  useJevSettingsStore.setState({ enabled: true, loaded: true });
  useSettingsStore.setState({ groupingApplyAnimationEnabled: false });
  useLauncherDirsStore.setState({ view: { doc: { entries: [] } } as never });
});
afterEach(async () => {
  if (root) { await act(async () => root!.unmount()); root = null; }
  __resetGroupingPrecomputeForTests();
  __resetPersistenceCoordinatorForTests();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("grouping preset controls", () => {
  it("shows three chips, defaults to recommended, and immediately shows the requested plan while AI is pending", async () => {
    await mount();
    expect([...document.querySelectorAll('[data-grouping-preset]')].map(button => button.textContent)).toEqual(["おすすめ", "稼働中だけ", "メインだけ"]);
    expect(preset("recommended").getAttribute("aria-pressed")).toBe("true");
    await click(preset("active_watch"));
    expect(preset("active_watch").getAttribute("aria-pressed")).toBe("true");
    expect(firstPlan()?.getAttribute("data-strategy")).toBe("active_watch");
    expect(firstPlan()?.getAttribute("aria-checked")).toBe("true");
    expect(firstPlan()?.textContent).toContain("移動 2");
    expect(firstPlan()?.textContent).toContain("現状維持 1");
    expect(document.getElementById("grouping-preset-description")?.textContent).toBe(tabGroupingStrings.strategyActiveWatchDescription);
    expect(harness.pending.at(-1)?.strategy).toBe("active_watch");
    expect(button(tabGroupingStrings.confirmPlan).disabled).toBe(false);
  });

  it("pins a local requested strategy when a valid AI response contains only existing strategies", async () => {
    await mount();
    await click(preset("active_watch"));
    const analysis = await currentAnalysis();
    await act(async () => harness.pending.at(-1)!.resolve({ kind: "ready", analysis, generatedAt: Date.now() }));
    await settle();
    expect(document.querySelectorAll('[role="radio"][data-strategy]')).toHaveLength(3);
    expect(firstPlan()?.getAttribute("data-strategy")).toBe("active_watch");
    expect(firstPlan()?.getAttribute("aria-checked")).toBe("true");
  });

  it("ignores the previous request when switching presets during analysis", async () => {
    await mount();
    await click(preset("active_watch"));
    const oldRequest = harness.pending.at(-1)!;
    await click(preset("main_sessions"));
    const analysis = await currentAnalysis();
    await act(async () => oldRequest.resolve({ kind: "ready", analysis, generatedAt: Date.now() }));
    await settle();
    expect(preset("main_sessions").getAttribute("aria-pressed")).toBe("true");
    expect(firstPlan()?.getAttribute("data-strategy")).toBe("main_sessions");
    expect(harness.pending.at(-1)?.strategy).toBe("main_sessions");
  });

  it("saves the choice and restores it when the panel is reopened", async () => {
    await mount();
    await click(preset("main_sessions"));
    expect(localStorage.getItem(GROUPING_PRESET_STORAGE_KEY)).toBe("main_sessions");
    await act(async () => root!.unmount());
    root = null;
    await mount();
    expect(preset("main_sessions").getAttribute("aria-pressed")).toBe("true");
    expect(firstPlan()?.getAttribute("data-strategy")).toBe("main_sessions");
  });

  it("keeps selection usable when localStorage denies writes", async () => {
    await mount();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
    await click(preset("active_watch"));
    expect(preset("active_watch").getAttribute("aria-pressed")).toBe("true");
    expect(firstPlan()?.getAttribute("data-strategy")).toBe("active_watch");
  });

  it("treats an unknown saved strategy as recommended", async () => {
    localStorage.setItem(GROUPING_PRESET_STORAGE_KEY, "unknown");
    await mount();
    expect(preset("recommended").getAttribute("aria-pressed")).toBe("true");
    expect(firstPlan()?.getAttribute("data-strategy")).toBe("minimal_move");
  });

  it("shows an empty active plan with both confirmation and apply disabled when AI is off", async () => {
    useAiSettingsStore.setState({ aiEnabled: false });
    usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
    localStorage.setItem(GROUPING_PRESET_STORAGE_KEY, "active_watch");
    const prepare = vi.spyOn(groupingBoundary, "prepare");
    await mount();
    expect(firstPlan()?.textContent).toContain("いま該当なし");
    expect(button(tabGroupingStrings.confirmPlan).disabled).toBe(true);
    await click(button(tabGroupingStrings.stepConfirm));
    expect(button(tabGroupingStrings.apply).disabled).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(harness.pending).toHaveLength(0);
  });

  it("applies and undoes the preset through the existing grouping boundary", async () => {
    useAiSettingsStore.setState({ aiEnabled: false });
    localStorage.setItem(GROUPING_PRESET_STORAGE_KEY, "active_watch");
    const original = structuredClone(useWorkspaceListStore.getState().workspaces);
    const commit = vi.spyOn(groupingBoundary, "commit");
    const undo = vi.spyOn(groupingBoundary, "undo");
    await mount();
    await click(button(tabGroupingStrings.confirmPlan));
    expect(button(tabGroupingStrings.apply).disabled).toBe(false);
    await click(button(tabGroupingStrings.apply));
    expect(commit).toHaveBeenCalledTimes(1);
    const destination = useWorkspaceListStore.getState().workspaces.find(workspace => workspace.name === "稼働中");
    expect(destination?.panes.flatMap(pane => pane.tabs.map(tab => tab.id)).sort()).toEqual(["recent", "working"]);
    expect(useWorkspaceListStore.getState().workspaces.find(workspace => workspace.id === "source")?.panes.flatMap(pane => pane.tabs.map(tab => tab.id))).toEqual(["idle"]);
    await click(button(tabGroupingStrings.undo));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(useWorkspaceListStore.getState().workspaces).toEqual(original);
  });

  it.each(["active_watch", "main_sessions"] as const)("displays every %s selection beside four idle columns after confirmation and restores identities on Undo", async strategy => {
    const original = prepareCrowdedPreset([1, 1, 1, 1], strategy);
    const approval = useSessionAttentionStore.getState().attentionBySession["session-approval"];
    await mount();
    expect(useWorkspaceListStore.getState().workspaces).toEqual(original);
    await click(button(tabGroupingStrings.confirmPlan));
    expect(useWorkspaceListStore.getState().workspaces).toEqual(original);
    expect(groupingBoundary.commit).not.toHaveBeenCalled();
    expect(button(tabGroupingStrings.apply).disabled).toBe(false);
    await click(button(tabGroupingStrings.apply));
    const after = useWorkspaceListStore.getState().workspaces;
    const destination = after.find(workspace => workspace.id === "destination")!;
    expect(destination.panes.map(pane => pane.activeTabId).sort()).toEqual([
      "approval", "working", "working-2", "resident-0-0", "resident-1-0", "resident-2-0", "resident-3-0",
    ].sort());
    expect(identityPairs(after)).toEqual(identityPairs(original));
    for (const resident of original[1].panes) expect(destination.panes.find(pane => pane.id === resident.id))
      .toMatchObject({ activeTabId: resident.activeTabId, tabs: resident.tabs });
    expect(destination.splitColumns).toHaveLength(4);
    expect(destination.splitColumns?.every(column => column.length <= 4)).toBe(true);
    expect(useSessionAttentionStore.getState().attentionBySession["session-approval"]).toBe(approval);
    expect(usePaneMetadataStore.getState().metadata["session-working"].agentStatus).toBe("working");
    await click(button(tabGroupingStrings.undo));
    expect(groupingBoundary.undo).toHaveBeenCalledTimes(1);
    expect(useWorkspaceListStore.getState().workspaces).toEqual(original);
  });

  it("uses the single spare destination row for approval and keeps working overflow with a capacity explanation", async () => {
    const original = prepareCrowdedPreset([4, 4, 4, 3], "active_watch");
    await mount();
    expect(firstPlan()?.textContent).toContain("合流先の表示容量のため 2 本は残しました");
    await click(button(tabGroupingStrings.confirmPlan));
    expect(useWorkspaceListStore.getState().workspaces).toEqual(original);
    await click(button(tabGroupingStrings.apply));
    const after = useWorkspaceListStore.getState().workspaces;
    const destination = after.find(workspace => workspace.id === "destination")!;
    expect(destination.panes.map(pane => pane.activeTabId).sort()).toEqual([...original[1].panes.map(pane => pane.activeTabId), "approval"].sort());
    expect(destination.splitColumns?.map(column => column.length)).toEqual([4, 4, 4, 4]);
    expect(after.find(workspace => workspace.id === "source")?.panes.map(pane => [pane.id, pane.activeTabId]))
      .toEqual([["pane-focus", "focus"], ["pane-working", "working"], ["pane-working-2", "working-2"]]);
    expect(identityPairs(after)).toEqual(identityPairs(original));
    await click(button(tabGroupingStrings.undo));
    expect(useWorkspaceListStore.getState().workspaces).toEqual(original);
  });

  it.each(["active_watch", "main_sessions"] as const)("shows a destination-full %s result and cannot prepare or apply a background stack", async strategy => {
    const original = prepareCrowdedPreset([4, 4, 4, 4], strategy);
    await mount();
    expect(firstPlan()?.textContent).toContain(`合流先「${strategy === "active_watch" ? "稼働中" : "メイン"}」は表示場所がいっぱいです`);
    expect(button(tabGroupingStrings.confirmPlan).disabled).toBe(true);
    await click(button(tabGroupingStrings.stepConfirm));
    expect(button(tabGroupingStrings.apply).disabled).toBe(true);
    expect(groupingBoundary.prepare).not.toHaveBeenCalled();
    expect(groupingBoundary.commit).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().workspaces).toEqual(original);
    expect(harness.pending).toHaveLength(0);
  });

  it.each(["active_watch", "main_sessions"] as const)("keeps %s first while hand-specified role judgements change the second displayed alternative", async strategy => {
    const layout = workspaces();
    for (const pane of layout[0].panes) pane.tabs[0].cwd = "/work/sample";
    useWorkspaceListStore.setState({ workspaces: layout, layoutRevision: useWorkspaceListStore.getState().layoutRevision + 1 });
    useLauncherDirsStore.setState({ view: { doc: { entries: [{ section: "開発", label: "架空案件", path: "/work/sample" }] } } as never });
    localStorage.setItem(GROUPING_PRESET_STORAGE_KEY, strategy);
    const scan = (await currentAnalysis()).scan;
    let presetText: string | null | undefined;
    let previousRoleText: string | null | undefined;
    for (const [choice, label] of [["review", "確認・判断"], ["worker", "制作・実装"]]) {
      const refined = await runEvidenceGroupingAnalysis({ scan: async () => scan, requestId: () => "hand-role-test",
        judge: async prompt => {
          const requests = JSON.parse(prompt).requests as Array<{ questions: Record<string, { criteria: Record<string, string> }> }>;
          return JSON.stringify({ answers: Object.fromEntries(requests.flatMap(request => Object.entries(request.questions).map(([key, question]) => [key,
            { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(role => [role, Number(role === choice)])) },
          ]))) });
        },
      }, true);
      await mount();
      await act(async () => harness.pending.at(-1)!.resolve({ kind: "ready", analysis: refined, generatedAt: Date.now() }));
      await settle();
      const displayed = [...document.querySelectorAll<HTMLElement>('[role="radio"][data-strategy]')];
      expect(displayed.map(plan => plan.dataset.strategy)).toEqual([strategy, "role", "minimal_move"]);
      expect(displayed[0].getAttribute("aria-checked")).toBe("true");
      expect(displayed[1].textContent).toContain(label);
      if (previousRoleText !== undefined) {
        expect(displayed[1].textContent).not.toBe(previousRoleText);
        expect(displayed[0].textContent).toBe(presetText);
      }
      presetText = displayed[0].textContent;
      previousRoleText = displayed[1].textContent;
      await act(async () => root!.unmount());
      root = null;
    }
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  registry: null as null | { promise: Promise<unknown>; resolve: (value: unknown) => void },
  cached: { kind: "miss" } as unknown,
  attributeJudge: vi.fn(),
  jevJudge: vi.fn(),
  invoke: vi.fn(async (command: string): Promise<unknown> => {
    if (command === "launcher_dirs_get") return harness.registry!.promise;
    if (command === "run_tab_sweep_judge") return harness.attributeJudge();
    if (command === "run_jev_grouping_judge") return harness.jevJudge();
    return true;
  }),
}));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: harness.invoke,
}));
vi.mock("@tauri-apps/api/event", async original => ({
  ...await original<typeof import("@tauri-apps/api/event")>(), listen: vi.fn(async () => () => {}),
}));
vi.mock("../../src/lib/groupingPrecompute", async original => ({
  ...await original<typeof import("../../src/lib/groupingPrecompute")>(),
  markGroupingInterest: vi.fn(() => false),
  peekGroupingPrecompute: vi.fn(() => harness.cached),
  requestGroupingPrecomputeRefresh: vi.fn(),
  generateForegroundGroupingAnalysis: vi.fn(async () => ({ kind: "obsolete" })),
}));
vi.mock("../../src/components/layout/groupingBoundary", async original => {
  const actual = await original<typeof import("../../src/components/layout/groupingBoundary")>();
  return { ...actual, groupingBoundary: {
    ...actual.groupingBoundary,
    commit: vi.fn(actual.groupingBoundary.commit),
    undo: vi.fn(actual.groupingBoundary.undo),
  } };
});

import { TabGroupingPanel } from "../../src/components/layout/TabGroupingPanel";
import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import { GROUPING_PRESET_STORAGE_KEY } from "../../src/components/layout/tabGrouping";
import { groupingBoundary } from "../../src/components/layout/groupingBoundary";
import { buildLocalGroupingAnalysis, buildLocalGroupingScan } from "../../src/components/layout/groupingLocalPlan";
import { __resetGroupingPrecomputeForTests, generateForegroundGroupingAnalysis, requestGroupingPrecomputeRefresh } from "../../src/lib/groupingPrecompute";
import { __resetPersistenceCoordinatorForTests, markPersistentSchemaSupported } from "../../src/lib/workspacePersistenceCoordinator";
import { __resetGroupingRuntimeForTests, recordPersistentSchemaState, useGroupingRuntimeStore } from "../../src/stores/groupingRuntimeStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useJevSettingsStore } from "../../src/stores/jevSettingsStore";
import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import type { Workspace } from "../../src/types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalLoad = useLauncherDirsStore.getState().load;
const registry = [{ section: "dev", label: "北斗学院", path: "/work/core" }];
const loadedView = { doc: { entries: registry } };
const budgetKey = "mycmux.groupingPrecompute.dailyBudget.v1";
let root: Root | null = null;
let load: ReturnType<typeof vi.spyOn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function layout(): Workspace[] {
  return [["a", "b", "c"], ["extra"]].map((ids, index) => ({
    id: index === 0 ? "source" : "other", name: index === 0 ? "作業机" : "資料机",
    gridTemplateId: index === 0 ? "3x1" : "1x1", status: "running", createdAt: index,
    splitColumns: ids.map(id => ["place-" + id]),
    panes: ids.map(id => ({
      id: "place-" + id, agentId: "shell-starter", sessionId: "session-" + id,
      activeTabId: id, cwd: "/work/core",
      tabs: [{ id, agentId: "shell-starter", sessionId: "session-" + id,
        type: "terminal", cwd: "/work/core", label: id, origin: { kind: "human" } }],
    })),
  }));
}
function firstPlan(): HTMLElement | null {
  return document.querySelector('[role="radio"][data-strategy]');
}
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => node.textContent?.trim() === label);
  if (!found) throw new Error("Missing button: " + label);
  return found;
}
async function click(node: HTMLElement) {
  await act(async () => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
async function mount() {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => { root!.render(<TabGroupingPanel open visible onClose={() => {}} />); });
  await vi.waitFor(() => expect(firstPlan()).not.toBeNull(), { timeout: 10_000 });
}
async function pendingRegistry() {
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  await vi.waitFor(() => expect(harness.invoke.mock.calls.filter(([command]) => command === "launcher_dirs_get"))
    .toHaveLength(1), { timeout: 10_000 });
}
async function deliverRegistry() {
  await act(async () => {
    harness.registry!.resolve(loadedView);
    await load.mock.results[0].value;
  });
  expect(useLauncherDirsStore.getState().view).toEqual(loadedView);
}
function expectNoAiOrBudget() {
  expect(harness.attributeJudge).not.toHaveBeenCalled();
  expect(harness.jevJudge).not.toHaveBeenCalled();
  expect(harness.invoke.mock.calls.filter(([command]) =>
    command === "run_tab_sweep_judge" || command === "run_jev_grouping_judge")).toEqual([]);
  expect(localStorage.getItem(budgetKey)).toBeNull();
}
async function editCurrentPlan() {
  await click(button(tabGroupingStrings.stepEdit));
  const reorganize = [...document.querySelectorAll<HTMLButtonElement>(".cmux-tab-grouping-group [role=radio]")]
    .find(node => node.textContent?.trim() === tabGroupingStrings.dispositionReorganize);
  if (!reorganize) throw new Error("Missing group destination");
  await click(reorganize);
  expect(button(tabGroupingStrings.undoEdit).disabled).toBe(false);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  harness.registry = deferred<unknown>();
  harness.cached = { kind: "miss" };
  __resetGroupingPrecomputeForTests();
  __resetGroupingRuntimeForTests();
  __resetPersistenceCoordinatorForTests();
  markPersistentSchemaSupported(1);
  recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
  useAiSettingsStore.setState({ aiEnabled: false });
  // Leave Jev enabled to prove AI-off suppresses both services.
  useJevSettingsStore.setState({ enabled: true, loaded: true });
  useSettingsStore.setState({ groupingApplyAnimationEnabled: false });
  useLauncherDirsStore.setState({ view: null, load: originalLoad, error: null, loading: false });
  load = vi.spyOn(useLauncherDirsStore.getState(), "load");
  const workspaces = layout();
  useWorkspaceListStore.setState({ workspaces, activeWorkspaceId: "source", lastActivePaneByWorkspace: {},
    layoutRevision: useWorkspaceListStore.getState().layoutRevision + 1 });
  useUiStore.setState({ activePaneId: "session-a", lastActivePaneId: "session-a", focusRevision: 0 });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSessionAttentionStore.getState().resetForTests();
  useAskQuestionStore.getState().resetForTests();
  localStorage.setItem(GROUPING_PRESET_STORAGE_KEY, "attribute");
});
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  await act(async () => {
    harness.registry!.resolve(loadedView);
    for (const result of load.mock.results) if (result.type === "return") await result.value;
  });
  __resetGroupingPrecomputeForTests();
  __resetPersistenceCoordinatorForTests();
  vi.restoreAllMocks();
  useLauncherDirsStore.setState({ load: originalLoad });
  document.body.replaceChildren();
  localStorage.clear();
});

describe("FIX4 AI-off attribute with a cold registry", () => {
  it.each(["miss", "fresh", "soft-stale"] as const)("J1 loads registration after a %s and reaches one move without AI or budget", async cached => {
    if (cached !== "miss") {
      const scan = await buildLocalGroupingScan({ workspaces: layout(), metadata: {},
        attentionByTabId: {}, now: Date.now() });
      const analysis = buildLocalGroupingAnalysis(scan, {}, { requestedStrategy: "attribute" });
      expect(analysis).not.toBeNull();
      harness.cached = { kind: cached, analysis, generatedAt: Date.now(),
        ...(cached === "soft-stale" ? { reason: "structure" } : {}) };
    }
    await mount();
    expect(firstPlan()?.dataset.strategy).toBe("attribute");
    expect(firstPlan()?.textContent).toContain("移動 0");
    await pendingRegistry();
    await deliverRegistry();
    await vi.waitFor(() => expect(firstPlan()?.textContent).toContain("移動 1"), { timeout: 10_000 });
    expect(firstPlan()?.textContent).toContain("AI の判定なし (AI がオフ)");
    expect(firstPlan()?.textContent).toContain("北斗学院");
    expect(generateForegroundGroupingAnalysis).not.toHaveBeenCalled();
    expectNoAiOrBudget();
  });

  it("J2 retains the user's edited plan when registration arrives", async () => {
    await mount();
    await pendingRegistry();
    await editCurrentPlan();
    const groupTitles = [...document.querySelectorAll(".cmux-tab-grouping-group-title")].map(node => node.textContent);
    await deliverRegistry();
    expect(button(tabGroupingStrings.undoEdit).disabled).toBe(false);
    expect([...document.querySelectorAll(".cmux-tab-grouping-group-title")].map(node => node.textContent)).toEqual(groupTitles);
    expect(groupingBoundary.commit).not.toHaveBeenCalled();
    expectNoAiOrBudget();
  });

  it.each(["applied", "undone"] as const)("J2 preserves an %s plan and its Undo state after registration", async state => {
    await mount();
    await pendingRegistry();
    await editCurrentPlan();
    await click(button(tabGroupingStrings.goConfirm));
    await vi.waitFor(() => expect(button(tabGroupingStrings.apply).disabled).toBe(false), { timeout: 10_000 });
    await click(button(tabGroupingStrings.apply));
    await vi.waitFor(() => expect(groupingBoundary.commit).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    if (state === "undone") await click(button(tabGroupingStrings.undo));
    const workspaces = useWorkspaceListStore.getState().workspaces;
    const undo = useGroupingRuntimeStore.getState().undo;
    const status = document.body.textContent;
    await deliverRegistry();
    expect(useWorkspaceListStore.getState().workspaces).toBe(workspaces);
    expect(useGroupingRuntimeStore.getState().undo).toBe(undo);
    expect(document.body.textContent).toBe(status);
    expect(groupingBoundary.commit).toHaveBeenCalledTimes(1);
    expect(groupingBoundary.undo).toHaveBeenCalledTimes(state === "undone" ? 1 : 0);
    expectNoAiOrBudget();
  });

  it.each(["structure", "output"] as const)("J1 preserves the %s refresh of an already loaded attribute cache", async reason => {
    useLauncherDirsStore.setState({ view: loadedView as never });
    const scan = await buildLocalGroupingScan({ workspaces: layout(), metadata: {},
      attentionByTabId: {}, now: Date.now() });
    harness.cached = { kind: "soft-stale", reason, generatedAt: Date.now(),
      analysis: buildLocalGroupingAnalysis(scan, {}, { requestedStrategy: "attribute" }) };
    await mount();
    expect(firstPlan()?.dataset.strategy).toBe("attribute");
    expect(load).not.toHaveBeenCalled();
    expect(generateForegroundGroupingAnalysis).toHaveBeenCalledTimes(reason === "structure" ? 1 : 0);
    expect(requestGroupingPrecomputeRefresh).toHaveBeenCalledTimes(reason === "output" ? 1 : 0);
    expectNoAiOrBudget();
  });

  it.each(["recommended", "active_watch", "main_sessions"] as const)("J1 leaves the AI-off %s opening path unchanged", async preset => {
    localStorage.setItem(GROUPING_PRESET_STORAGE_KEY, preset);
    await mount();
    expect(firstPlan()?.dataset.strategy).toBe(preset === "recommended" ? "minimal_move" : preset);
    expect(load).not.toHaveBeenCalled();
    expect(generateForegroundGroupingAnalysis).toHaveBeenCalledTimes(preset === "recommended" ? 1 : 0);
    expectNoAiOrBudget();
  });

  it("J2 ignores a late registration after switching away from attribute", async () => {
    await mount();
    await pendingRegistry();
    const active = document.querySelector<HTMLButtonElement>('[data-grouping-preset="active_watch"]')!;
    await click(active);
    await vi.waitFor(() => expect(firstPlan()?.dataset.strategy).toBe("active_watch"), { timeout: 10_000 });
    await deliverRegistry();
    expect(firstPlan()?.dataset.strategy).toBe("active_watch");
    expectNoAiOrBudget();
  });
});

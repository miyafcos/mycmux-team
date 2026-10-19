// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  registry: null as null | { promise: Promise<unknown>; resolve: (value: unknown) => void },
  attributeJudge: vi.fn(),
  jevJudge: vi.fn(),
  invoke: vi.fn(async (command: string): Promise<unknown> => {
    if (command === "agent_session_titles") return [];
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
vi.mock("../../src/lib/ipc", async original => ({
  ...await original<typeof import("../../src/lib/ipc")>(),
  getPtyMetadataSnapshot: vi.fn(async () => Object.fromEntries(["a", "b", "c", "extra"]
    .map(id => ["session-" + id, { process_status: "codex" }]))),
  getSessionOutputSnapshot: vi.fn(async () => ({})),
}));

import { TabGroupingPanel } from "../../src/components/layout/TabGroupingPanel";
import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import { GROUPING_PRESET_STORAGE_KEY } from "../../src/components/layout/tabGrouping";
import { __resetGroupingPrecomputeForTests, cancelForegroundGroupingAnalysis } from "../../src/lib/groupingPrecompute";
import { __resetPersistenceCoordinatorForTests, markPersistentSchemaSupported } from "../../src/lib/workspacePersistenceCoordinator";
import { __resetGroupingRuntimeForTests, recordPersistentSchemaState } from "../../src/stores/groupingRuntimeStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useJevSettingsStore } from "../../src/stores/jevSettingsStore";
import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";
import type { Workspace } from "../../src/types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalLoad = useLauncherDirsStore.getState().load;
const loadedView = { doc: { entries: [{ section: "dev", label: "北斗学院", path: "/work/core" }] } };
let root: Root | null = null;
let load: ReturnType<typeof vi.spyOn>;

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
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  harness.registry = { promise, resolve };
  __resetGroupingPrecomputeForTests();
  __resetGroupingRuntimeForTests();
  __resetPersistenceCoordinatorForTests();
  markPersistentSchemaSupported(1);
  recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
  useAiSettingsStore.setState({ aiEnabled: true, aiProvider: "codex", aiModel: "gpt-6-luna" });
  useJevSettingsStore.setState({ enabled: false, loaded: true });
  useLauncherDirsStore.setState({ view: null, load: originalLoad, error: null, loading: false });
  load = vi.spyOn(useLauncherDirsStore.getState(), "load");
  useWorkspaceListStore.setState({ workspaces: layout(), activeWorkspaceId: "source", lastActivePaneByWorkspace: {},
    layoutRevision: useWorkspaceListStore.getState().layoutRevision + 1 });
  useUiStore.setState({ activePaneId: "session-a", lastActivePaneId: "session-a", focusRevision: 0 });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSessionAttentionStore.getState().resetForTests();
  useAskQuestionStore.getState().resetForTests();
  localStorage.setItem(GROUPING_PRESET_STORAGE_KEY, "attribute");
  harness.attributeJudge.mockResolvedValue(JSON.stringify({
    projects: [{ name: "北斗学院", short: "北斗", attribute: "アプリ・開発" }],
    panes: ["p1", "p2", "p3", "p4"].map(id => ({ id, project: "北斗学院" })), bundles: [],
  }));
});
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  cancelForegroundGroupingAnalysis();
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

it("M1 completes the first cold AI-on panel plan with one move and no manual reanalysis", async () => {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => { root!.render(<TabGroupingPanel open visible onClose={() => {}} />); });
  await vi.waitFor(() => expect(firstPlan()?.textContent).toContain("移動 0"), { timeout: 10_000 });
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  expect(harness.attributeJudge).not.toHaveBeenCalled();
  await act(async () => {
    harness.registry!.resolve(loadedView);
    await load.mock.results[0].value;
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect([...document.querySelectorAll<HTMLButtonElement>("button")]
      .find(node => node.textContent?.trim() === tabGroupingStrings.analyzeAgain)?.disabled).toBe(false);
  }, { timeout: 10_000 });
  expect(firstPlan()?.textContent).toContain("移動 1");
  expect(firstPlan()?.dataset.strategy).toBe("attribute");
  expect(firstPlan()?.textContent).not.toContain("AI の判定なし");
  expect(harness.attributeJudge).toHaveBeenCalledTimes(1);
  expect(harness.jevJudge).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(1);
  expect([...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => node.textContent?.trim() === tabGroupingStrings.analyzeAgain)?.disabled).toBe(false);
  expect(localStorage.getItem("mycmux.groupingPrecompute.dailyBudget.v1")).toBeNull();
});

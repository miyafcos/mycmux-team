// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analysisHarness = vi.hoisted(() => ({
  value: null as unknown,
  calls: 0,
  release: null as (() => void) | null,
  reject: null as ((error: unknown) => void) | null,
}));

vi.mock("../../src/components/layout/evidenceGrouping", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/evidenceGrouping")>();
  const harness = await import("../../src/components/layout/tabGrouping");
  return { ...actual, runEvidenceGroupingAnalysis: harness.runGroupingAnalysis };
});

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => true),
}));

vi.mock("../../src/components/layout/tabGrouping", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/tabGrouping")>();
  return {
    ...actual,
    runGroupingAnalysis: vi.fn(() => new Promise((resolve, reject) => {
      analysisHarness.calls += 1;
      analysisHarness.reject = reject;
      analysisHarness.release = () => resolve(analysisHarness.value);
    })),
  };
});

import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import { TabGroupingPanel } from "../../src/components/layout/TabGroupingPanel";
import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
const LOCAL_GROUPING_PLAN_TITLE = "今の場所に寄せる";
import { __resetGroupingPrecomputeForTests } from "../../src/lib/groupingPrecompute";
import { useGroupingRuntimeStore } from "../../src/stores/groupingRuntimeStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import { mockGroupingAnalysis } from "./fixtures/tabGroupingMockScenario";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
analysisHarness.value = mockGroupingAnalysis;

const NOW = 1_788_000_000_000;
let root: Root | null = null;

function tab(id: string, cwd: string): PaneTab {
  return { id, sessionId: `session-${id}`, type: "terminal", label: id, cwd } as PaneTab;
}

function pane(id: string, tabs: PaneTab[]): Pane {
  return { id, sessionId: tabs[0].sessionId, tabs, cwd: tabs[0].cwd } as unknown as Pane;
}

/** Two projects, two tabs each: enough for the local builder to group. */
function localWorkspaces(): Workspace[] {
  return [{
    id: "ws-local",
    name: "作業机",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    panes: [
      pane("pane-1", [tab("t1", "C:/Users/miyaz/anken/hikarista/math"), tab("t2", "C:/Users/miyaz/anken/hikarista/science")]),
      pane("pane-2", [tab("t3", "C:/Users/miyaz/repo/mycmux"), tab("t4", "C:/Users/miyaz/repo/mycmux/src")]),
    ],
    splitColumns: [["pane-1", "pane-2"]],
  }] as Workspace[];
}

function resetStores(workspaces: Workspace[]): void {
  const original = workspaces.find(w => w.id === "ws-local");
  const entries = original?.panes.map((p, i) => ({
    id: "r" + i, section: "fixture", label: i ? "toolx" : "ひかりスタ",
    path: i ? p.tabs[0].cwd! : p.tabs[0].cwd!.replace(/\/[^/]+$/, ""),
  })) ?? [];
  useLauncherDirsStore.setState({ view: { doc: { entries } } as unknown as NonNullable<ReturnType<typeof useLauncherDirsStore.getState>["view"]> });
  // Give the material plan a real cross-workspace move in these late-result fixtures.
  if (original) {
    const extra = { ...original, id: "ws-scattered", name: "別机", panes: original.panes.map(p => ({
      ...p, id: p.id + "-other", tabs: [p.tabs[1]], sessionId: p.tabs[1].sessionId,
    })) };
    original.panes = original.panes.map(p => ({ ...p, tabs: [p.tabs[0]] }));
    extra.splitColumns = extra.panes.map(p => [p.id]);
    workspaces = [...workspaces, extra];
  }
  useGroupingRuntimeStore.setState({
    persistentSchema: { loadedSchemaVersion: 1, migrationComplete: true, schemaEpoch: 1 },
    transitionDepth: 0,
    transitionEpoch: 0,
    transitionSource: null,
    transitionFrames: [],
    operation: null,
    poisoned: false,
    diagnostic: null,
    undo: null,
    durability: { status: "idle" },
  });
  useWorkspaceListStore.setState({
    workspaces,
    layoutRevision: 1,
    activeWorkspaceId: workspaces[0]?.id ?? null,
    lastActivePaneByWorkspace: {},
  });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSessionAttentionStore.setState({ attentionBySession: {}, seenAttentionByTab: new Map() });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountPanel(): Promise<void> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<TabGroupingPanel open visible onClose={vi.fn()} />);
  });
  await settle();
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === label);
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  __resetGroupingPrecomputeForTests();
  analysisHarness.calls = 0;
  analysisHarness.release = null;
  analysisHarness.reject = null;
  analysisHarness.value = mockGroupingAnalysis;
  resetStores(localWorkspaces());
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  __resetGroupingPrecomputeForTests();
  vi.useRealTimers();
});

describe("local plan on a cold open", () => {
  it("switches the wait message at ten seconds and offers a late AI result explicitly", async () => {
    vi.useFakeTimers();
    await mountPanel();
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(document.body.textContent).not.toContain(tabGroupingStrings.analysisSlowHint);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(document.body.textContent).toContain(tabGroupingStrings.analysisSlowHint);
    expect(document.body.textContent).toContain(tabGroupingStrings.analysisBackground);
    expect(button(tabGroupingStrings.editPlan).disabled).toBe(false);
    expect(button(tabGroupingStrings.confirmPlan).disabled).toBe(false);
    analysisHarness.value = {
      ...mockGroupingAnalysis,
      timings: { totalMs: 10_000, scanMs: 100, judgeMs: 9900, validationMs: 0, judgeRequests: 1 },
    };
    await act(async () => analysisHarness.release?.());
    await settle();
    expect(document.body.textContent).toContain(LOCAL_GROUPING_PLAN_TITLE);
    expect(document.body.textContent).toContain(tabGroupingStrings.judgeReadyAfterWait);
    expect(document.body.textContent).toContain(tabGroupingStrings.analysisDuration(10));
    expect(document.body.textContent).not.toContain(tabGroupingStrings.analysisSlowHint);
    await click(button(tabGroupingStrings.showReadyPlans));
    expect(document.body.textContent).toContain(mockGroupingAnalysis.parsed.plans[0].title);
    expect(analysisHarness.calls).toBe(1);
  });

  it("does not claim a usable fallback when no local plan exists after ten seconds", async () => {
    vi.useFakeTimers();
    resetStores([]);
    await mountPanel();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(document.body.textContent).toContain(tabGroupingStrings.analysisSlowNoPlanHint);
    expect(document.body.textContent).not.toContain(tabGroupingStrings.analysisBackground);
    expect(document.body.textContent).not.toContain(tabGroupingStrings.analysisSlowHint);
    expect(button(tabGroupingStrings.editPlan).disabled).toBe(true);
  });

  function invalidAnalysis() {
    return {
      ...mockGroupingAnalysis,
      raw: '{"plans":[]}',
      parsed: {
        status: "invalid",
        reason: "有効なプランがありません",
        issues: [
          { scope: "response", reason: "有効なプランがありません" },
          { scope: "plan", planId: "bad", planTitle: "案件案", reason: "layout が未知のペインを含みます" },
        ],
        raw: '{"plans":[]}', validPlans: [],
      },
    };
  }

  it("keeps the local plan usable after invalid AI output and shows a collapsed diagnostic", async () => {
    await mountPanel();
    analysisHarness.value = invalidAnalysis();
    await act(async () => analysisHarness.release?.());
    await settle();

    expect(document.body.textContent).toContain(LOCAL_GROUPING_PLAN_TITLE);
    expect(document.body.textContent).toContain(tabGroupingStrings.judgeFailedKeepingCurrent);
    expect(document.body.textContent).toContain("案件案: layout が未知のペインを含みます");
    expect(document.querySelector("details")?.open).toBe(false);
    expect(button(tabGroupingStrings.editPlan).disabled).toBe(false);
    expect(button(tabGroupingStrings.confirmPlan).disabled).toBe(false);
  });

  it("keeps editing and confirmation available after a judge timeout", async () => {
    await mountPanel();
    await act(async () => analysisHarness.reject?.({ code: "timeout", detail: "timed out" }));
    await settle();

    expect(document.body.textContent).toContain(LOCAL_GROUPING_PLAN_TITLE);
    expect(button(tabGroupingStrings.editPlan).disabled).toBe(false);
    await click(button(tabGroupingStrings.editPlan));
    expect(document.body.textContent).toContain(tabGroupingStrings.judgeFailedKeepingCurrent);
  });

  it("retains the plan during explicit retry and after another failure", async () => {
    await mountPanel();
    await act(async () => analysisHarness.reject?.(new Error("offline")));
    await settle();
    await click(button(tabGroupingStrings.analyzeAgain));
    expect(document.body.textContent).toContain(LOCAL_GROUPING_PLAN_TITLE);
    expect(button(tabGroupingStrings.editPlan).disabled).toBe(false);
    analysisHarness.value = invalidAnalysis();
    await act(async () => analysisHarness.release?.());
    await settle();
    expect(button(tabGroupingStrings.confirmPlan).disabled).toBe(false);
  });

  it("switches to an already generated AI result without asking the judge again", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    await act(async () => analysisHarness.release?.());
    await settle();
    expect(document.body.textContent).toContain(LOCAL_GROUPING_PLAN_TITLE);
    await click(button(tabGroupingStrings.showReadyPlans));
    expect(document.body.textContent).toContain(mockGroupingAnalysis.parsed.plans[0].title);
    expect(document.body.textContent).not.toContain(LOCAL_GROUPING_PLAN_TITLE);
    expect(analysisHarness.calls).toBe(1);
  });

  it("shows the reason for each rejected plan when no local plan exists", async () => {
    resetStores([]);
    await mountPanel();
    analysisHarness.value = invalidAnalysis();
    await act(async () => analysisHarness.release?.());
    await settle();
    expect(document.body.textContent).toContain("案件案: layout が未知のペインを含みます");
    expect(document.querySelector("details")?.open).toBe(false);
    expect(button(tabGroupingStrings.editPlan).disabled).toBe(true);
  });

  it("shows an applicable plan before the judge has answered", async () => {
    await mountPanel();

    // The judge is still pending: nothing has been resolved yet.
    expect(analysisHarness.calls).toBe(1);
    expect(document.body.textContent).toContain(LOCAL_GROUPING_PLAN_TITLE);
    expect(document.body.textContent).toContain(tabGroupingStrings.localPlanWhileJudging);
    // Applicable, unlike the read-only 参考表示 path.
    expect(button(tabGroupingStrings.editPlan).disabled).toBe(false);
  });

  it("replaces the local plan with the AI plans when the user has not touched it", async () => {
    await mountPanel();
    expect(document.body.textContent).toContain(LOCAL_GROUPING_PLAN_TITLE);

    await act(async () => {
      analysisHarness.release?.();
    });
    await settle();

    expect(document.body.textContent).not.toContain(LOCAL_GROUPING_PLAN_TITLE);
    expect(document.body.textContent).toContain(mockGroupingAnalysis.parsed.plans[0].title);
  });

  it("keeps the user's work and announces the AI plan instead of overwriting it", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));

    await act(async () => {
      analysisHarness.release?.();
    });
    await settle();

    expect(document.body.textContent).toContain(LOCAL_GROUPING_PLAN_TITLE);
    expect(document.body.textContent).toContain(tabGroupingStrings.judgeReadyKeepingCurrent);
    expect(document.body.textContent).not.toContain(mockGroupingAnalysis.parsed.plans[0].title);
  });

  it("shows three keep plans for a single pane without evidence", async () => {
    // A single tab: nothing to group locally.
    resetStores([{
      id: "ws-solo",
      name: "作業机",
      gridTemplateId: "1x1",
      status: "running",
      createdAt: NOW,
      panes: [pane("pane-1", [tab("only", "C:/Users/miyaz")])],
      splitColumns: [["pane-1"]],
    }] as Workspace[]);

    await mountPanel();

    expect(analysisHarness.calls).toBe(1);
    expect(document.body.textContent).toContain(LOCAL_GROUPING_PLAN_TITLE);
    expect(document.querySelectorAll('[role="radio"][data-strategy]')).toHaveLength(3);
  });
});

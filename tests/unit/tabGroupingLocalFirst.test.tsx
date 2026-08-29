// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analysisHarness = vi.hoisted(() => ({
  value: null as unknown,
  calls: 0,
  release: null as (() => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => true),
}));

vi.mock("../../src/components/layout/tabGrouping", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/tabGrouping")>();
  return {
    ...actual,
    runGroupingAnalysis: vi.fn(() => new Promise((resolve) => {
      analysisHarness.calls += 1;
      analysisHarness.release = () => resolve(analysisHarness.value);
    })),
  };
});

import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import { TabGroupingPanel } from "../../src/components/layout/TabGroupingPanel";
import { LOCAL_GROUPING_PLAN_TITLE } from "../../src/components/layout/groupingLocalPlan";
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
      pane("pane-1", [tab("t1", "C:/Users/miyaz/anken/momosta/math"), tab("t2", "C:/Users/miyaz/anken/momosta/science")]),
      pane("pane-2", [tab("t3", "C:/Users/miyaz/repo/mycmux"), tab("t4", "C:/Users/miyaz/repo/mycmux/src")]),
    ],
    splitColumns: [["pane-1", "pane-2"]],
  }] as Workspace[];
}

function resetStores(workspaces: Workspace[]): void {
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
  analysisHarness.value = mockGroupingAnalysis;
  resetStores(localWorkspaces());
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  __resetGroupingPrecomputeForTests();
});

describe("local plan on a cold open", () => {
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

  it("falls back to waiting on the judge when no local plan can be built", async () => {
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
    expect(document.body.textContent).not.toContain(LOCAL_GROUPING_PLAN_TITLE);
  });
});

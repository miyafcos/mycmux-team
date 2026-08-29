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
import type { GroupingAnalysisResult } from "../../src/components/layout/tabGrouping";
import {
  __resetGroupingPrecomputeForTests,
  peekGroupingPrecompute,
  rememberGroupingAnalysis,
} from "../../src/lib/groupingPrecompute";
import { useGroupingRuntimeStore } from "../../src/stores/groupingRuntimeStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { mockGroupingAnalysis, mockWorkspaces } from "./fixtures/tabGroupingMockScenario";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
analysisHarness.value = mockGroupingAnalysis;

let root: Root | null = null;

function resetStores(): void {
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
    workspaces: structuredClone(mockWorkspaces),
    layoutRevision: 1,
    activeWorkspaceId: "wsA",
    lastActivePaneByWorkspace: { wsA: "session-t請求", wsB: "session-t統括", wsC: "session-t数学" },
  });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSessionAttentionStore.setState({ attentionBySession: {}, seenAttentionByTab: new Map() });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === label);
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

function planCards(): number {
  return document.querySelectorAll(".cmux-tab-grouping-card").length;
}

beforeEach(() => {
  __resetGroupingPrecomputeForTests();
  resetStores();
  analysisHarness.calls = 0;
  analysisHarness.release = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  __resetGroupingPrecomputeForTests();
});

describe("structure-stale plan on open", () => {
  it("shows the old plan read-only and re-judges in the foreground when the layout moved", async () => {
    rememberGroupingAnalysis(mockGroupingAnalysis as GroupingAnalysisResult, Date.now());
    useWorkspaceListStore.setState({ layoutRevision: 2 });
    expect(peekGroupingPrecompute()).toMatchObject({ kind: "soft-stale", reason: "structure" });

    const container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<TabGroupingPanel open visible onClose={vi.fn()} />);
    });
    await settle();

    // The stale plan is on screen immediately, read-only, while the judge runs.
    expect(planCards()).toBeGreaterThan(0);
    expect(analysisHarness.calls).toBe(1);
    expect(button(tabGroupingStrings.editPlan).disabled).toBe(true);

    await act(async () => {
      analysisHarness.release?.();
    });
    await settle();
    await settle();

    // The fresh judge result replaced it and the plan is editable again.
    expect(planCards()).toBeGreaterThan(0);
    expect(button(tabGroupingStrings.editPlan).disabled).toBe(false);
  });
});

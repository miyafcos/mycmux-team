// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analysisHarness = vi.hoisted(() => ({ value: null as unknown }));
const editHarness = vi.hoisted(() => ({ commands: [] as unknown[] }));
const prepareHarness = vi.hoisted(() => ({ calls: 0, failNext: false }));
const previewHarness = vi.hoisted(() => ({ calls: 0, result: null as unknown }));
const commitHarness = vi.hoisted(() => ({ calls: 0, results: [] as unknown[], throwNext: false }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true) }));
vi.mock("../../src/components/layout/tabGrouping", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/tabGrouping")>();
  return { ...actual, runGroupingAnalysis: vi.fn(async () => analysisHarness.value) };
});
vi.mock("../../src/components/layout/groupingEdit", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/groupingEdit")>();
  return {
    ...actual,
    applyEditCommand: (...args: Parameters<typeof actual.applyEditCommand>) => {
      editHarness.commands.push(args[1]);
      return actual.applyEditCommand(...args);
    },
  };
});
vi.mock("../../src/components/layout/groupingBoundary", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/groupingBoundary")>();
  return {
    ...actual,
    groupingBoundary: {
      ...actual.groupingBoundary,
      preview: (...args: Parameters<typeof actual.groupingBoundary.preview>) => {
        previewHarness.calls += 1;
        const result = actual.groupingBoundary.preview(...args);
        previewHarness.result = result;
        return result;
      },
      prepare: (...args: Parameters<typeof actual.groupingBoundary.prepare>) => {
        prepareHarness.calls += 1;
        if (prepareHarness.failNext) {
          prepareHarness.failNext = false;
          return { ok: false as const, kind: "unexpected_error" as const, stale: [], errors: ["prepare failed"] };
        }
        return actual.groupingBoundary.prepare(...args);
      },
      commit: (...args: Parameters<typeof actual.groupingBoundary.commit>) => {
        commitHarness.calls += 1;
        if (commitHarness.throwNext) {
          commitHarness.throwNext = false;
          throw new Error("synthetic commit throw");
        }
        const result = actual.groupingBoundary.commit(...args);
        commitHarness.results.push(result);
        return result;
      },
    },
  };
});

import {
  groupingChangedWorkspaceIds,
  groupingEditDropTargets,
  TabGroupingPanel,
} from "../../src/components/layout/TabGroupingPanel";
import { TabGroupingButton } from "../../src/components/layout/TabGroupingButton";
import { paneRefKey, parsePaneRefKey } from "../../src/components/layout/groupingEdit";
import {
  previewKindForTab,
  runGroupingAnalysis,
  TAB_GROUPING_OPEN_EVENT,
  type GroupingPlan,
} from "../../src/components/layout/tabGrouping";
import type { PaneTab, Workspace } from "../../src/types";
import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import {
  endGroupingOperation,
  tryBeginGroupingOperation,
  useGroupingRuntimeStore,
} from "../../src/stores/groupingRuntimeStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { __resetGroupingPrecomputeForTests } from "../../src/lib/groupingPrecompute";
import { mockGroupingAnalysis, mockWorkspaces } from "./fixtures/tabGroupingMockScenario";
import { hashCanonical } from "./helpers/groupingTestEntrypoint";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

async function mountPanel(onClose = vi.fn(), intent: "review" | null = null): Promise<ReturnType<typeof vi.fn>> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => root?.render(<TabGroupingPanel open visible intent={intent} onClose={onClose} />));
  await settle();
  return onClose;
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === label);
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

function queryButton(label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === label) ?? null;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
  await settle();
}

beforeEach(() => {
  __resetGroupingPrecomputeForTests();
  localStorage.clear();
  analysisHarness.value = mockGroupingAnalysis;
  editHarness.commands = [];
  prepareHarness.calls = 0;
  prepareHarness.failNext = false;
  previewHarness.calls = 0;
  previewHarness.result = null;
  commitHarness.calls = 0;
  commitHarness.results = [];
  commitHarness.throwNext = false;
  useSettingsStore.setState({ groupingApplyAnimationEnabled: false });
  resetStores();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  __resetGroupingPrecomputeForTests();
  localStorage.clear();
  resetStores();
});

function mockTab(id: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "terminal",
    agentKind: "codex",
    label: id,
    cwd: "C:\\mock",
  };
}

function workspace(id: string, tabIds: string[], paneId = `pane-${id}`): Workspace {
  return {
    id,
    name: id,
    gridTemplateId: "1x1",
    panes: [{
      id: paneId,
      agentId: "terminal",
      sessionId: `session-${tabIds[0] ?? paneId}`,
      tabs: tabIds.map(mockTab),
      activeTabId: tabIds[0] ?? "",
    }],
    splitColumns: [[paneId]],
    status: "running",
    createdAt: 1,
  };
}

describe("groupingChangedWorkspaceIds", () => {
  it("finds added and tab-changed workspaces while omitting unchanged and removed workspaces", () => {
    const before = [
      workspace("same", ["a"]),
      workspace("added-tab", ["b"]),
      workspace("removed-tab", ["c", "d"]),
      workspace("removed-workspace", ["z"]),
    ];
    const after = [
      workspace("same", ["a"]),
      workspace("added-tab", ["b", "x"]),
      workspace("removed-tab", ["c"]),
      workspace("new-workspace", ["n"]),
    ];

    expect([...groupingChangedWorkspaceIds(before, after)]).toEqual([
      "added-tab",
      "removed-tab",
      "new-workspace",
    ]);
    expect(groupingChangedWorkspaceIds([], [])).toEqual(new Set());
  });
});

describe("groupingEditDropTargets", () => {
  it("maps projected pane ids back to stable pane refs for adopted reorganize groups only", () => {
    const plan: GroupingPlan = {
      planId: "plan",
      title: "案",
      rationale: "検査",
      strategy: "project",
      groups: [
        {
          groupId: "g:one",
          title: "採用",
          disposition: "reorganize",
          destination: { kind: "new_workspace", proposedName: "採用" },
          layout: {
            columns: [
              { panes: [{ title: "母艦", role: "mother", tabIds: ["a"] }] },
              { panes: [{ title: "作業", role: "worker", tabIds: ["b"] }] },
            ],
          },
          tabIds: ["a", "b"],
          adopted: true,
        },
        {
          groupId: "g-two",
          title: "現状維持",
          disposition: "reorganize",
          destination: { kind: "new_workspace", proposedName: "現状維持" },
          layout: { columns: [{ panes: [{ title: "除外", role: "worker", tabIds: ["c"] }] }] },
          tabIds: ["c"],
          adopted: false,
        },
        {
          groupId: "g-three",
          title: "現在位置",
          disposition: "keep",
          destination: { kind: "current_locations" },
          layout: null,
          tabIds: ["d"],
          adopted: true,
        },
      ],
      unassignedTabIds: ["u"],
      warnings: [],
    };
    const after = [
      workspace("ws-a", ["a"], "projected-a"),
      workspace("ws-b", ["b"], "projected-b"),
      workspace("ws-c", ["c"], "projected-c"),
      workspace("ws-u", ["u"], "untouched"),
    ];

    const targets = groupingEditDropTargets(plan, after);
    expect([...targets.entries()]).toEqual([
      ["projected-a", { kind: "pane", groupId: "g:one", columnIndex: 0, paneIndex: 0 }],
      ["projected-b", { kind: "pane", groupId: "g:one", columnIndex: 1, paneIndex: 0 }],
    ]);
    expect(targets.has("projected-c")).toBe(false);
    expect(targets.has("untouched")).toBe(false);
    for (const ref of targets.values()) {
      if (ref.kind !== "pane") continue;
      expect(parsePaneRefKey(paneRefKey(ref))).toEqual({
        groupId: ref.groupId,
        columnIndex: ref.columnIndex,
        paneIndex: ref.paneIndex,
      });
    }
    expect(groupingEditDropTargets(null, after).size).toBe(0);
  });

  it("adds only stashed empty groups as restorable group drop targets", () => {
    const emptyPlan: GroupingPlan = {
      planId: "empty-plan",
      title: "empty",
      rationale: "test",
      strategy: "project",
      groups: [
        {
          groupId: "stashed:0:0",
          title: "stashed",
          disposition: "keep",
          destination: { kind: "current_locations" },
          layout: null,
          tabIds: [],
          adopted: false,
        },
        {
          groupId: "not-stashed",
          title: "not stashed",
          disposition: "keep",
          destination: { kind: "current_locations" },
          layout: null,
          tabIds: [],
          adopted: false,
        },
        {
          groupId: "still-full",
          title: "full",
          disposition: "keep",
          destination: { kind: "current_locations" },
          layout: null,
          tabIds: ["a"],
          adopted: false,
        },
      ],
      unassignedTabIds: [],
      warnings: [],
    };
    const stash = {
      "stashed:0:0": { columns: [{ panes: [{ title: "pane", role: "mother" as const, tabIds: ["a"] }] }] },
      "still-full": { columns: [{ panes: [{ title: "pane", role: "mother" as const, tabIds: ["a"] }] }] },
    };

    expect([...groupingEditDropTargets(emptyPlan, [], stash).entries()]).toEqual([
      ["group:stashed%3A0%3A0", { kind: "group", groupId: "stashed:0:0" }],
    ]);
  });
});

describe("TabGroupingPanel editable after map", () => {
  it("offers the direct confirmation shortcut and the separate edit route", async () => {
    await mountPanel();
    expect(button(tabGroupingStrings.confirmPlan)).not.toBeNull();
    expect(button(tabGroupingStrings.editPlan)).not.toBeNull();
    expect(document.querySelector(".cmux-tab-grouping-body.is-edit")).toBeNull();

    await click(button(tabGroupingStrings.confirmPlan));
    expect(document.querySelector(".cmux-tab-grouping-body.is-confirm")).not.toBeNull();
    expect(document.querySelector(".cmux-tab-grouping-body.is-edit")).toBeNull();
    expect(queryButton(tabGroupingStrings.retryPrepare)).toBeNull();
  });

  it("keeps edit-only state badges out of all four confirmation views", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.confirmPlan));
    for (const label of [
      tabGroupingStrings.confirmSideBySide,
      tabGroupingStrings.confirmCurrent,
      tabGroupingStrings.confirmAfter,
      tabGroupingStrings.confirmDiff,
    ]) {
      await click(button(label));
      expect(document.querySelectorAll(".cmux-tab-grouping-state")).toHaveLength(0);
    }
  });

  it("renders every projected workspace with the shared map DOM and edit-only state badges", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    const map = document.querySelector<HTMLElement>(".cmux-tab-grouping-editmap");
    expect(map).not.toBeNull();
    expect(map?.querySelectorAll("[data-workspace-id]")).toHaveLength(5);
    expect(map?.querySelector(".cmux-tab-grouping-workspace")).not.toBeNull();
    expect(map?.querySelector(".cmux-tab-grouping-columns")).not.toBeNull();
    expect(map?.querySelector(".cmux-tab-grouping-pane")).not.toBeNull();
    expect(map?.querySelector(".cmux-tab-grouping-chip")).not.toBeNull();
    expect(map?.querySelectorAll(".cmux-tab-grouping-state").length).toBeGreaterThan(0);
    expect(map?.querySelectorAll(".cmux-tab-grouping-editcols")).toHaveLength(0);
    expect(map?.querySelectorAll("[data-grouping-side]")).toHaveLength(0);
    expect(document.querySelectorAll('.cmux-tab-grouping-body.is-edit [role="switch"]')).toHaveLength(0);
    expect(document.querySelectorAll('.cmux-tab-grouping-body.is-edit [role="radiogroup"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-drop-id="keep-current"]')).toHaveLength(1);

    const projectPlan = mockGroupingAnalysis.parsed.plans.find((plan) => plan.strategy === "project");
    if (!projectPlan) throw new Error("project plan fixture is missing");
    const preview = previewHarness.result as ReturnType<typeof groupingBoundary.preview> | null;
    if (!preview?.ok) throw new Error("edit preview fixture is missing");
    const expectedTargets = groupingEditDropTargets(projectPlan, preview.transaction.workspaces);
    const paneTargets = [...(map?.querySelectorAll<HTMLElement>(".cmux-tab-grouping-pane[data-drop-id]") ?? [])];
    expect(paneTargets).toHaveLength(expectedTargets.size);
    for (const paneTarget of paneTargets) {
      expect(parsePaneRefKey(paneTarget.dataset.dropId ?? "")).not.toBeNull();
    }
    for (const tab of mockGroupingAnalysis.scan.tabs) {
      const kind = previewKindForTab(projectPlan, tab.id);
      const state = map?.querySelector<HTMLElement>(`[data-tab-id="${tab.id}"] .cmux-tab-grouping-state`);
      if (kind === "untouched") {
        expect(state).toBeNull();
      } else {
        expect(state?.dataset.state).toBe(kind);
      }
    }
  });

  it("reports mutually exclusive moved, kept, and unassigned tab counts", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    const summary = document.querySelector<HTMLElement>(".cmux-tab-grouping-editsummary");
    const counts = [...(summary?.textContent?.matchAll(/(\d+)タブ/g) ?? [])]
      .map((match) => Number(match[1]));
    const fixtureTabCount = new Set(mockWorkspaces.flatMap((workspace) => (
      workspace.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id))
    ))).size;
    expect(counts).toEqual([5, 0, 5]);
    expect(counts.reduce((total, count) => total + count, 0)).toBe(fixtureTabCount);
  });

  it("switches each group between the two dispositions and updates its tab states", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    const groups = [...document.querySelectorAll<HTMLElement>('.cmux-tab-grouping-body.is-edit [role="radiogroup"]')];
    const radios = groups[0]?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(radios).toHaveLength(2);
    expect([...document.querySelectorAll('.cmux-tab-grouping-body.is-edit [role="switch"]')]).toHaveLength(0);
    expect(radios?.[0].textContent).toBe(tabGroupingStrings.dispositionReorganize);
    expect(radios?.[1].textContent).toBe(tabGroupingStrings.dispositionKeep);
    expect(radios?.[0].getAttribute("aria-checked")).toBe("true");
    expect(radios?.[1].getAttribute("aria-checked")).toBe("false");

    const projectPlan = mockGroupingAnalysis.parsed.plans.find((plan) => plan.strategy === "project");
    const group = projectPlan?.groups[0];
    if (!group || !radios?.[1]) throw new Error("reorganize group fixture is missing");
    await click(radios[1]);
    expect(radios[0].getAttribute("aria-checked")).toBe("false");
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    for (const tabId of group.tabIds) {
      expect(document.querySelector(`[data-tab-id="${tabId}"] .cmux-tab-grouping-state`)?.getAttribute("data-state"))
        .toBe("kept");
    }

    await click(radios[0]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(radios[1].getAttribute("aria-checked")).toBe("false");
    for (const tabId of group.tabIds) {
      expect(document.querySelector(`[data-tab-id="${tabId}"] .cmux-tab-grouping-state`)?.getAttribute("data-state"))
        .toBe("moved");
    }
  });

  it("filters the shared map to exactly the changed workspace ids and restores all workspaces", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    const map = document.querySelector<HTMLElement>(".cmux-tab-grouping-editmap");
    const fullIds = [...(map?.querySelectorAll<HTMLElement>("[data-workspace-id]") ?? [])]
      .map((workspaceNode) => workspaceNode.dataset.workspaceId);
    const preview = previewHarness.result as ReturnType<typeof groupingBoundary.preview> | null;
    if (!preview?.ok) throw new Error("edit preview fixture is missing");
    const expected = groupingChangedWorkspaceIds(mockWorkspaces, preview.transaction.workspaces);

    await click(button(tabGroupingStrings.changedOnly));
    expect(new Set([...(map?.querySelectorAll<HTMLElement>("[data-workspace-id]") ?? [])]
      .map((workspaceNode) => workspaceNode.dataset.workspaceId)))
      .toEqual(expected);
    await click(button(tabGroupingStrings.changedOnly));
    expect([...(map?.querySelectorAll<HTMLElement>("[data-workspace-id]") ?? [])]
      .map((workspaceNode) => workspaceNode.dataset.workspaceId))
      .toEqual(fullIds);
  });

  it("renders untouched tabs as non-selectable chips", async () => {
    const analysis = structuredClone(mockGroupingAnalysis);
    const plan = analysis.parsed.plans.find((candidate) => candidate.strategy === "project");
    const untouchedTabId = plan?.groups[0]?.tabIds[0];
    if (!plan || !untouchedTabId) throw new Error("untouched fixture tab is missing");
    for (const group of plan.groups) group.tabIds = group.tabIds.filter((tabId) => tabId !== untouchedTabId);
    plan.unassignedTabIds = plan.unassignedTabIds.filter((tabId) => tabId !== untouchedTabId);
    analysisHarness.value = analysis;

    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    const chip = document.querySelector<HTMLElement>(`.cmux-tab-grouping-editmap [data-tab-id="${untouchedTabId}"]`);
    expect(chip?.tagName).toBe("DIV");
    expect(chip?.hasAttribute("aria-pressed")).toBe(false);
    await click(chip!);
    expect(document.querySelectorAll('[data-tab-id][aria-pressed="true"]')).toHaveLength(0);
  });

  it("moves a selection by clicking a projected pane through one reassign command", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    const chip = document.querySelector<HTMLButtonElement>(".cmux-tab-grouping-editmap button.cmux-tab-grouping-chip");
    if (!chip?.dataset.tabId) throw new Error("selectable chip is missing");
    const tabId = chip.dataset.tabId;
    const chipChild = chip.querySelector<HTMLElement>("span");
    if (!chipChild) throw new Error("selectable chip child is missing");
    await click(chipChild);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    const destination = [...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-pane[data-drop-id]")]
      .find((pane) => !pane.querySelector(`[data-tab-id="${tabId}"]`));
    if (!destination) throw new Error("destination pane is missing");
    const targetRef = parsePaneRefKey(destination.dataset.dropId ?? "");
    if (!targetRef) throw new Error("destination pane ref is invalid");

    editHarness.commands = [];
    const previewsBeforeMove = previewHarness.calls;
    const destinationChild = destination.querySelector<HTMLElement>(".cmux-tab-grouping-lineage");
    if (!destinationChild) throw new Error("destination pane child is missing");
    await click(destinationChild);
    expect(editHarness.commands).toEqual([{
      kind: "reassign_tabs",
      tabIds: [tabId],
      target: { kind: "pane", ...targetRef },
    }]);
    expect(previewHarness.calls).toBe(previewsBeforeMove + 1);
    expect(document.querySelector(`[data-tab-id="${tabId}"][aria-pressed="true"]`)).toBeNull();
    expect(document.querySelector(`[data-drop-id="${paneRefKey(targetRef)}"] [data-tab-id="${tabId}"]`)).not.toBeNull();
  });

  it("restores an existing-workspace destination and keeps pane click equivalent to the selection-bar menu", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    const projectPlan = mockGroupingAnalysis.parsed.plans.find((candidate) => candidate.strategy === "project");
    const selectedGroup = projectPlan?.groups[0];
    const existingWorkspace = mockWorkspaces[0];
    if (!selectedGroup || !existingWorkspace) throw new Error("existing-workspace destination fixture is missing");

    await click(button(tabGroupingStrings.changeDestination));
    const destinationMenu = document.querySelector<HTMLElement>(
      `[role="menu"][aria-label="${tabGroupingStrings.changeDestination}"]`,
    );
    const existingWorkspaceItem = [...(destinationMenu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      .find((item) => item.textContent?.trim() === existingWorkspace.name);
    if (!existingWorkspaceItem) throw new Error("existing workspace menu item is missing");
    editHarness.commands = [];
    const previewsBeforeDestinationChange = previewHarness.calls;
    await click(existingWorkspaceItem);
    expect(editHarness.commands).toEqual([{
      kind: "set_group_destination",
      groupId: selectedGroup.groupId,
      destination: { kind: "existing_workspace", workspaceId: existingWorkspace.id },
    }]);
    expect(previewHarness.calls).toBe(previewsBeforeDestinationChange + 1);
    expect(document.querySelector(".cmux-tab-grouping-dest strong")?.textContent?.trim())
      .toBe(tabGroupingStrings.destinationHeading(existingWorkspace.name));

    const firstPreview = previewHarness.result as ReturnType<typeof groupingBoundary.preview> | null;
    if (!firstPreview?.ok) throw new Error("existing-workspace edit preview is missing");
    const before = hashCanonical(firstPreview.transaction.workspaces);
    const existingWorkspaceMap = document.querySelector<HTMLElement>(
      `.cmux-tab-grouping-editmap [data-workspace-id="${existingWorkspace.id}"]`,
    );
    const destination = existingWorkspaceMap?.querySelector<HTMLElement>(".cmux-tab-grouping-pane[data-drop-id]");
    const chip = [...document.querySelectorAll<HTMLButtonElement>(
      ".cmux-tab-grouping-editmap button.cmux-tab-grouping-chip",
    )].find((candidate) => !destination?.contains(candidate));
    if (!chip?.dataset.tabId) throw new Error("selectable chip is missing");
    const tabId = chip.dataset.tabId;
    await click(chip);
    const targetRef = parsePaneRefKey(destination?.dataset.dropId ?? "");
    if (!destination || !targetRef) throw new Error("destination pane is missing");
    editHarness.commands = [];
    await click(destination.querySelector<HTMLElement>(".cmux-tab-grouping-lineage")!);
    expect(editHarness.commands).toEqual([{
      kind: "reassign_tabs",
      tabIds: [tabId],
      target: { kind: "pane", ...targetRef },
    }]);
    const clickPreview = previewHarness.result as ReturnType<typeof groupingBoundary.preview> | null;
    if (!clickPreview?.ok) throw new Error("pane-click preview is missing");
    const clickProjection = hashCanonical(clickPreview.transaction.workspaces);
    expect(clickProjection).not.toBe(before);

    await click(button(tabGroupingStrings.undoEdit));
    previewHarness.result = null;
    const sameChip = document.querySelector<HTMLButtonElement>(
      `.cmux-tab-grouping-editmap button.cmux-tab-grouping-chip[data-tab-id="${tabId}"]`,
    );
    if (!sameChip) throw new Error("selection-bar source chip is missing");
    await click(sameChip);
    await click(button(tabGroupingStrings.moveSelected));
    const group = projectPlan.groups.find((candidate) => candidate.groupId === targetRef.groupId);
    const pane = group?.layout?.columns[targetRef.columnIndex]?.panes[targetRef.paneIndex];
    if (!group || !pane) throw new Error("selection-bar destination fixture is missing");
    const menuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === `${group.title} / ${pane.title}`);
    if (!menuItem) throw new Error("matching selection-bar destination is missing");
    await click(menuItem);
    const menuPreview = previewHarness.result as ReturnType<typeof groupingBoundary.preview> | null;
    if (!menuPreview?.ok) throw new Error("selection-bar preview is missing");
    expect(hashCanonical(menuPreview.transaction.workspaces)).toBe(clickProjection);
  });

  it("keeps a selection through group changes, clears it outside edit, and supports the one keep-current tray", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    const chips = [...document.querySelectorAll<HTMLButtonElement>(".cmux-tab-grouping-editmap button.cmux-tab-grouping-chip")];
    expect(chips.length).toBeGreaterThanOrEqual(2);
    await click(chips[0]);
    await click(chips[1]);
    const groupTitles = [...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-group-title")];
    await click(groupTitles[1]);
    expect(document.querySelectorAll('[data-tab-id][aria-pressed="true"]')).toHaveLength(2);
    expect(groupTitles[1].querySelector("input")).toBeNull();

    await click(button(tabGroupingStrings.goConfirm));
    await click(button(tabGroupingStrings.backToEdit));
    expect(document.querySelectorAll('[data-tab-id][aria-pressed="true"]')).toHaveLength(0);

    const chip = document.querySelector<HTMLButtonElement>(".cmux-tab-grouping-editmap button.cmux-tab-grouping-chip");
    if (!chip?.dataset.tabId) throw new Error("selectable chip is missing");
    const tabId = chip.dataset.tabId;
    await click(chip);
    editHarness.commands = [];
    const tray = document.querySelector<HTMLElement>('[data-drop-id="keep-current"]');
    const trayChild = tray?.querySelector<HTMLElement>(".cmux-tab-grouping-note");
    if (!trayChild) throw new Error("keep-current tray child is missing");
    await click(trayChild);
    expect(editHarness.commands).toEqual([{ kind: "keep_current", tabIds: [tabId] }]);
    expect(document.querySelector(`[data-tab-id="${tabId}"] .cmux-tab-grouping-state[data-state="unassigned"]`)).not.toBeNull();
  });

  it("keeps the edited projection and undo history across compare and confirmation round trips", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    const initialPreview = previewHarness.result as ReturnType<typeof groupingBoundary.preview> | null;
    if (!initialPreview?.ok) throw new Error("initial edit preview is missing");
    const initialProjection = hashCanonical(initialPreview.transaction.workspaces);
    const keepRadio = document.querySelectorAll<HTMLButtonElement>(
      '.cmux-tab-grouping-body.is-edit [role="radiogroup"] [role="radio"]',
    )[1];
    if (!keepRadio) throw new Error("keep disposition radio is missing");
    await click(keepRadio);
    const editedPreview = previewHarness.result as ReturnType<typeof groupingBoundary.preview> | null;
    if (!editedPreview?.ok) throw new Error("edited preview is missing");
    const editedProjection = hashCanonical(editedPreview.transaction.workspaces);
    expect(editedProjection).not.toBe(initialProjection);
    expect(button(tabGroupingStrings.undoEdit).disabled).toBe(false);

    await click(button(tabGroupingStrings.backToCompare));
    await click(button(tabGroupingStrings.editPlan));
    const compareRoundTrip = previewHarness.result as ReturnType<typeof groupingBoundary.preview> | null;
    if (!compareRoundTrip?.ok) throw new Error("compare round-trip preview is missing");
    expect(hashCanonical(compareRoundTrip.transaction.workspaces)).toBe(editedProjection);
    expect(button(tabGroupingStrings.undoEdit).disabled).toBe(false);

    await click(button(tabGroupingStrings.goConfirm));
    await click(button(tabGroupingStrings.backToEdit));
    const confirmRoundTrip = previewHarness.result as ReturnType<typeof groupingBoundary.preview> | null;
    if (!confirmRoundTrip?.ok) throw new Error("confirmation round-trip preview is missing");
    expect(hashCanonical(confirmRoundTrip.transaction.workspaces)).toBe(editedProjection);
  });

  it("consumes Escape to clear a tab selection before closing the panel", async () => {
    const onClose = vi.fn();
    await mountPanel(onClose);
    await click(button(tabGroupingStrings.editPlan));
    const chip = document.querySelector<HTMLButtonElement>(".cmux-tab-grouping-editmap button.cmux-tab-grouping-chip");
    if (!chip) throw new Error("selectable chip is missing");
    await click(chip);
    expect(document.querySelectorAll('[data-tab-id][aria-pressed="true"]')).toHaveLength(1);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(document.querySelectorAll('[data-tab-id][aria-pressed="true"]')).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("retries a transient prepare failure without leaving confirmation", async () => {
    prepareHarness.failNext = true;
    await mountPanel();
    await click(button(tabGroupingStrings.confirmPlan));
    expect(prepareHarness.calls).toBe(1);
    expect(queryButton(tabGroupingStrings.retryPrepare)).not.toBeNull();
    await click(button(tabGroupingStrings.retryPrepare));
    expect(prepareHarness.calls).toBe(2);
    expect(document.querySelector(".cmux-tab-grouping-body.is-confirm")).not.toBeNull();
    expect(button(tabGroupingStrings.apply).disabled).toBe(false);
    expect(queryButton(tabGroupingStrings.retryPrepare)).toBeNull();
  });

  it("allows Apply again after a real commit failure settles", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.confirmPlan));
    const token = tryBeginGroupingOperation("commit");
    if (!token) throw new Error("failed to acquire grouping operation token");
    try {
      await click(button(tabGroupingStrings.apply));
    } finally {
      await act(async () => endGroupingOperation(token));
      await settle();
    }
    expect(commitHarness.results).toHaveLength(1);
    expect(commitHarness.results[0]).toMatchObject({ commit: { ok: false, kind: "operation_in_progress" } });

    expect(button(tabGroupingStrings.goConfirm).disabled).toBe(false);
    await click(button(tabGroupingStrings.goConfirm));
    expect(button(tabGroupingStrings.apply).disabled).toBe(false);
    await click(button(tabGroupingStrings.apply));

    expect(commitHarness.results).toHaveLength(2);
    expect(commitHarness.results[1]).toMatchObject({ commit: { ok: true } });
    expect(useGroupingRuntimeStore.getState().undo?.status).toBe("available");
  });

  it("allows Apply again after the commit facade throws", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.confirmPlan));
    commitHarness.throwNext = true;

    await click(button(tabGroupingStrings.apply));

    expect(commitHarness.calls).toBe(1);
    expect(document.body.textContent).toContain("synthetic commit throw");
    expect(button(tabGroupingStrings.goConfirm).disabled).toBe(false);
    await click(button(tabGroupingStrings.goConfirm));
    expect(button(tabGroupingStrings.apply).disabled).toBe(false);
    await click(button(tabGroupingStrings.apply));

    expect(commitHarness.calls).toBe(2);
    expect(commitHarness.results).toHaveLength(1);
    expect(commitHarness.results[0]).toMatchObject({ commit: { ok: true } });
    expect(useGroupingRuntimeStore.getState().undo?.status).toBe("available");
  });

  it("does not reanalyze or discard edit and applied state when undo records are published", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    const keepRadio = document.querySelectorAll<HTMLButtonElement>(
      '.cmux-tab-grouping-body.is-edit [role="radiogroup"] [role="radio"]',
    )[1];
    if (!keepRadio) throw new Error("keep disposition radio is missing");
    await click(keepRadio);
    const analysisCalls = vi.mocked(runGroupingAnalysis).mock.calls.length;
    await act(async () => useGroupingRuntimeStore.setState({
      undo: {
        recordId: "published-during-edit",
        schemaVersion: 1,
        snapshot: { workspaces: structuredClone(mockWorkspaces) },
        report: { movedTabCount: 1, affectedWorkspaceIds: ["wsA"], emptyWorkspaceIds: [], appliedAt: 1 },
        appliedLayoutSignature: "applied",
        expectedStructuralSignature: "expected",
        committedLayoutRevision: 1,
        createdAt: 1,
        status: "available",
        expireReason: null,
      } as never,
    }));
    await settle();
    expect(vi.mocked(runGroupingAnalysis)).toHaveBeenCalledTimes(analysisCalls);
    expect(document.querySelector(".cmux-tab-grouping-body.is-edit")).not.toBeNull();
    expect(document.querySelectorAll<HTMLButtonElement>(
      '.cmux-tab-grouping-body.is-edit [role="radiogroup"] [role="radio"]',
    )[1]?.getAttribute("aria-checked")).toBe("true");

    await click(button(tabGroupingStrings.goConfirm));
    await click(button(tabGroupingStrings.apply));
    await settle();
    expect(vi.mocked(runGroupingAnalysis)).toHaveBeenCalledTimes(analysisCalls);
    expect(useGroupingRuntimeStore.getState().undo?.status).toBe("available");
    expect(document.querySelector(".cmux-tab-grouping-body.is-confirm")).not.toBeNull();
    expect(button(tabGroupingStrings.apply).disabled).toBe(true);
  });

  it("opens an available undo review without launching a fresh analysis", async () => {
    useGroupingRuntimeStore.setState({
      undo: {
        recordId: "review-1",
        schemaVersion: 1,
        snapshot: { workspaces: structuredClone(mockWorkspaces) },
        report: { movedTabCount: 2, affectedWorkspaceIds: ["wsA"], emptyWorkspaceIds: [], appliedAt: 1 },
        appliedLayoutSignature: "applied",
        expectedStructuralSignature: "expected",
        committedLayoutRevision: 1,
        createdAt: 1,
        status: "available",
        expireReason: null,
      } as never,
    });
    vi.mocked(runGroupingAnalysis).mockClear();
    await mountPanel(vi.fn(), "review");
    expect(runGroupingAnalysis).not.toHaveBeenCalled();
    expect(document.querySelector(".cmux-tab-grouping-body.is-confirm")).not.toBeNull();
  });

  it("routes the review CustomEvent through the button while a plain event analyzes normally", async () => {
    const undo = {
      recordId: "review-event-1",
      schemaVersion: 1,
      snapshot: { workspaces: structuredClone(mockWorkspaces) },
      report: { movedTabCount: 2, affectedWorkspaceIds: ["wsA"], emptyWorkspaceIds: [], appliedAt: 1 },
      appliedLayoutSignature: "applied",
      expectedStructuralSignature: "expected",
      committedLayoutRevision: 1,
      createdAt: 1,
      status: "available",
      expireReason: null,
    } as never;
    useGroupingRuntimeStore.setState({ undo });
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    root = createRoot(host);
    await act(async () => root?.render(<TabGroupingButton />));
    vi.mocked(runGroupingAnalysis).mockClear();
    await act(async () => window.dispatchEvent(new CustomEvent(TAB_GROUPING_OPEN_EVENT, {
      detail: { intent: "review" },
    })));
    await settle();
    expect(runGroupingAnalysis).not.toHaveBeenCalled();
    expect(document.querySelector(".cmux-tab-grouping-body.is-confirm")).not.toBeNull();

    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    useGroupingRuntimeStore.setState({ undo });
    const plainHost = document.createElement("div");
    document.body.append(plainHost);
    root = createRoot(plainHost);
    await act(async () => root?.render(<TabGroupingButton />));
    vi.mocked(runGroupingAnalysis).mockClear();
    await act(async () => window.dispatchEvent(new Event(TAB_GROUPING_OPEN_EVENT)));
    await settle();
    expect(runGroupingAnalysis).toHaveBeenCalledTimes(1);
  });
});

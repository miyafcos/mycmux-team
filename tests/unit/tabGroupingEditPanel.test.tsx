// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analysisHarness = vi.hoisted(() => ({ value: null as unknown }));
const boundaryHarness = vi.hoisted(() => ({
  preparedArgs: null as unknown,
  prepared: null as unknown,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => true),
}));

vi.mock("../../src/components/layout/tabGrouping", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/tabGrouping")>();
  return {
    ...actual,
    runGroupingAnalysis: vi.fn(async () => analysisHarness.value),
  };
});

vi.mock("../../src/components/layout/groupingBoundary", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/groupingBoundary")>();
  return {
    ...actual,
    groupingBoundary: {
      ...actual.groupingBoundary,
      prepare: (...args: Parameters<typeof actual.groupingBoundary.prepare>) => {
        boundaryHarness.preparedArgs = args;
        const result = actual.groupingBoundary.prepare(...args);
        boundaryHarness.prepared = result;
        return result;
      },
    },
  };
});

import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import {
  applyEditCommand,
  beginGroupingEdit,
} from "../../src/components/layout/groupingEdit";
import { groupingBoundary } from "../../src/components/layout/groupingBoundary";
import { TabGroupingPanel } from "../../src/components/layout/TabGroupingPanel";
import type { GroupingPlan } from "../../src/components/layout/tabGrouping";
import { useGroupingRuntimeStore } from "../../src/stores/groupingRuntimeStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { mockGroupingAnalysis, mockWorkspaces } from "./fixtures/tabGroupingMockScenario";
import { hashCanonical } from "./helpers/groupingTestEntrypoint";

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

async function mountPanel(onClose = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<TabGroupingPanel open visible onClose={onClose} />);
  });
  await settle();
  return onClose;
}

function queryButton(label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === label) ?? null;
}

function button(label: string): HTMLButtonElement {
  const match = queryButton(label);
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function doubleClick(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  await settle();
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

async function press(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await settle();
}

async function openEdit(): Promise<void> {
  await click(button(tabGroupingStrings.editPlan));
  expect(document.querySelector(".cmux-tab-grouping-body.is-edit")).not.toBeNull();
}

beforeEach(() => {
  analysisHarness.value = mockGroupingAnalysis;
  boundaryHarness.preparedArgs = null;
  boundaryHarness.prepared = null;
  resetStores();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  resetStores();
});

describe("TabGroupingPanel edit session controls", () => {
  it("shows edit-only undo/reset controls and restores both directions", async () => {
    await mountPanel();
    expect(queryButton(tabGroupingStrings.undoEdit)).toBeNull();
    expect(queryButton(tabGroupingStrings.resetToAiPlan)).toBeNull();

    await openEdit();
    expect(button(tabGroupingStrings.undoEdit).disabled).toBe(true);
    expect(button(tabGroupingStrings.resetToAiPlan).disabled).toBe(true);
    const titleHost = document.querySelector<HTMLElement>(".cmux-tab-grouping-group-title");
    if (!titleHost) throw new Error("group title host is missing");
    const original = titleHost.textContent ?? "";
    await doubleClick(titleHost);
    const input = titleHost.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("group title input is missing");
    await setInputValue(input, "案件名を編集");
    await press(input, "Enter");
    expect(titleHost.textContent).toBe("案件名を編集");
    expect(button(tabGroupingStrings.undoEdit).disabled).toBe(false);
    expect(button(tabGroupingStrings.resetToAiPlan).disabled).toBe(false);

    await click(button(tabGroupingStrings.undoEdit));
    expect(titleHost.textContent).toBe(original);
    expect(button(tabGroupingStrings.undoEdit).disabled).toBe(true);

    await doubleClick(titleHost);
    const secondInput = titleHost.querySelector<HTMLInputElement>("input");
    if (!secondInput) throw new Error("second group title input is missing");
    await setInputValue(secondInput, "案件名を再編集");
    await press(secondInput, "Enter");
    await click(button(tabGroupingStrings.resetToAiPlan));
    expect(titleHost.textContent).toBe(original);
    expect(button(tabGroupingStrings.resetToAiPlan).disabled).toBe(true);
    expect(button(tabGroupingStrings.undoEdit).disabled).toBe(false);
    await click(button(tabGroupingStrings.undoEdit));
    expect(titleHost.textContent).toBe("案件名を再編集");

    await click(button(tabGroupingStrings.goConfirm));
    expect(document.querySelector(".cmux-tab-grouping-body.is-confirm")).not.toBeNull();
    expect(queryButton(tabGroupingStrings.undoEdit)).toBeNull();
    expect(queryButton(tabGroupingStrings.resetToAiPlan)).toBeNull();
  });

  it("commits group, workspace, and pane names with Enter or blur", async () => {
    await mountPanel();
    await openEdit();

    const groupHost = document.querySelector<HTMLElement>(".cmux-tab-grouping-group-title");
    if (!groupHost) throw new Error("group title host is missing");
    await doubleClick(groupHost);
    const groupInput = groupHost.querySelector<HTMLInputElement>("input");
    if (!groupInput) throw new Error("group title input is missing");
    await setInputValue(groupInput, "案件群改");
    await press(groupInput, "Enter");
    expect(groupHost.textContent).toBe("案件群改");

    const destinationHost = document.querySelector<HTMLElement>(
      ".cmux-tab-grouping-group .cmux-tab-grouping-dest strong",
    );
    if (!destinationHost) throw new Error("destination host is missing");
    await click(destinationHost);
    const destinationInput = document.querySelector<HTMLInputElement>(
      ".cmux-tab-grouping-group .cmux-tab-grouping-dest strong input",
    );
    if (!destinationInput) throw new Error("workspace name input is missing");
    await setInputValue(destinationInput, "新しい作業机");
    await press(destinationInput, "Enter");
    expect(document.querySelector(".cmux-tab-grouping-group .cmux-tab-grouping-dest strong")?.textContent)
      .toContain("新しい作業机");

    const paneHost = document.querySelector<HTMLElement>(".cmux-tab-grouping-editpane-head");
    if (!paneHost) throw new Error("pane title host is missing");
    await click(paneHost);
    const paneInput = paneHost.querySelector<HTMLInputElement>("input");
    if (!paneInput) throw new Error("pane title input is missing");
    await setInputValue(paneInput, "作業ペイン改");
    await act(async () => paneInput.blur());
    await settle();
    expect(paneHost.textContent).toContain("作業ペイン改");
  });

  it("cancels Escape and blank names without closing the panel", async () => {
    const onClose = await mountPanel();
    await openEdit();
    const titleHost = document.querySelector<HTMLElement>(".cmux-tab-grouping-group-title");
    if (!titleHost) throw new Error("group title host is missing");
    const original = titleHost.textContent ?? "";

    await doubleClick(titleHost);
    const input = titleHost.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("group title input is missing");
    await setInputValue(input, "取消対象");
    await press(input, "Escape");
    expect(titleHost.querySelector("input")).toBeNull();
    expect(titleHost.textContent).toBe(original);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".cmux-tab-grouping")).not.toBeNull();

    await doubleClick(titleHost);
    const blankInput = titleHost.querySelector<HTMLInputElement>("input");
    if (!blankInput) throw new Error("blank group title input is missing");
    await setInputValue(blankInput, "   ");
    await press(blankInput, "Enter");
    expect(titleHost.textContent).toBe(original);
    expect(button(tabGroupingStrings.undoEdit).disabled).toBe(true);
  });

  it("keeps popover, direct command, and keep-then-move preview projections identical", async () => {
    await mountPanel();
    await openEdit();
    const basePlan = structuredClone(
      mockGroupingAnalysis.parsed.plans.find((plan) => plan.strategy === "project"),
    ) as GroupingPlan | undefined;
    if (!basePlan) throw new Error("project plan fixture is missing");
    const rows = [...document.querySelectorAll<HTMLButtonElement>(".cmux-tab-grouping-editmap button.cmux-tab-grouping-chip")];
    if (!rows[0]) throw new Error("source row is missing");
    const movingTabId = rows[0].dataset.tabId;
    if (!movingTabId) throw new Error("source tab id is missing");
    await click(rows[0]);
    await click(button(tabGroupingStrings.moveSelected));
    const menuItems = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    if (!menuItems[1]) throw new Error("second pane destination is missing");
    await click(menuItems[1]);
    await click(button(tabGroupingStrings.goConfirm));
    await settle();

    const prepared = boundaryHarness.prepared as ReturnType<typeof groupingBoundary.prepare> | null;
    const preparedArgs = boundaryHarness.preparedArgs as Parameters<typeof groupingBoundary.prepare> | null;
    expect(prepared?.ok).toBe(true);
    if (!prepared?.ok || !preparedArgs) throw new Error("popover prepare result is missing");
    const popoverPlan = preparedArgs[0];
    const targetGroup = popoverPlan.groups.find((group) => (
      group.layout?.columns.some((column) => column.panes.some((pane) => pane.tabIds.includes(movingTabId)))
    ));
    const targetGroupIndex = popoverPlan.groups.findIndex((group) => group.groupId === targetGroup?.groupId);
    const targetColumnIndex = targetGroup?.layout?.columns.findIndex((column) => (
      column.panes.some((pane) => pane.tabIds.includes(movingTabId))
    )) ?? -1;
    const targetPaneIndex = targetColumnIndex >= 0
      ? targetGroup?.layout?.columns[targetColumnIndex].panes.findIndex((pane) => pane.tabIds.includes(movingTabId)) ?? -1
      : -1;
    expect(targetGroupIndex).toBeGreaterThanOrEqual(0);
    expect(targetColumnIndex).toBeGreaterThanOrEqual(0);
    expect(targetPaneIndex).toBeGreaterThanOrEqual(0);
    if (!targetGroup || targetColumnIndex < 0 || targetPaneIndex < 0) return;
    const target = {
      kind: "pane" as const,
      groupId: targetGroup.groupId,
      columnIndex: targetColumnIndex,
      paneIndex: targetPaneIndex,
    };

    const direct = applyEditCommand(beginGroupingEdit(basePlan), {
      kind: "reassign_tabs",
      tabIds: [movingTabId],
      target,
    });
    const kept = applyEditCommand(beginGroupingEdit(basePlan), {
      kind: "keep_current",
      tabIds: [movingTabId],
    });
    const keptThenMoved = applyEditCommand(kept, {
      kind: "reassign_tabs",
      tabIds: [movingTabId],
      target,
    });
    const directPreview = groupingBoundary.preview(direct.plan, preparedArgs[1]);
    const keptPreview = groupingBoundary.preview(keptThenMoved.plan, preparedArgs[1]);
    expect(directPreview.ok).toBe(true);
    expect(keptPreview.ok).toBe(true);
    if (!directPreview.ok || !keptPreview.ok) return;
    const popoverProjection = hashCanonical(prepared.ticket.transaction.workspaces);
    const beforePreview = groupingBoundary.preview(basePlan, preparedArgs[1]);
    expect(beforePreview.ok).toBe(true);
    if (!beforePreview.ok) return;
    expect(popoverProjection).not.toBe(hashCanonical(beforePreview.transaction.workspaces));
    expect(hashCanonical(directPreview.transaction.workspaces)).toBe(popoverProjection);
    expect(hashCanonical(keptPreview.transaction.workspaces)).toBe(popoverProjection);
  });
});

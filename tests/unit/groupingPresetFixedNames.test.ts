// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: fake.invoke,
}));

import { groupingBoundary } from "../../src/components/layout/groupingBoundary";
import { applyEditCommand, beginGroupingEdit, normalizeEditedPlan, resetGroupingEditToAi, undoGroupingEdit } from "../../src/components/layout/groupingEdit";
import { buildLocalGroupingScan, buildPresetGroupingPlan } from "../../src/components/layout/groupingLocalPlan";
import { clonePlanForEdit, parseGroupingOutput, type GroupingPlan, type GroupingPresetStrategy, type GroupingScan } from "../../src/components/layout/tabGrouping";
import { createAutoPaneNamingScheduler } from "../../src/lib/autoPaneNaming";
import { persistentLayoutProjection } from "../../src/lib/persistentLayoutProjection";
import { __resetPersistenceCoordinatorForTests, markPersistentSchemaSupported } from "../../src/lib/workspacePersistenceCoordinator";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useAutoNameRuntimeStore } from "../../src/stores/autoNameRuntimeStore";
import { __resetGroupingRuntimeForTests, recordPersistentSchemaState } from "../../src/stores/groupingRuntimeStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { normalizeWorkspaceLayout } from "../../src/stores/workspaceFactory";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import { fixtureEvents, materialFor } from "./helpers/autoNamingInvariants";

const NOW = 1_800_000_000_000;
const selectedIds = ["w", "m2", "m3"];
const schedulers: ReturnType<typeof createAutoPaneNamingScheduler>[] = [];
const titleFor = (strategy: GroupingPresetStrategy) => strategy === "active_watch" ? "稼働中" : "メイン";
const workspaces = () => useWorkspaceListStore.getState().workspaces;
const workspace = (id: string) => workspaces().find(value => value.id === id)!;

function pane(id: string, human = false): Pane {
  const tab: PaneTab = { id, sessionId: `session-${id}`, agentId: "shell-starter", type: "terminal",
    label: id, labelSource: "user", cwd: "/work/sample", agentKind: "codex", agentSessionId: `agent-${id}`,
    origin: { kind: human ? "human" : "agent" }, initialPrompt: "original",
    commandArgv: ["codex", "resume", id], launchEnv: { ORIGINAL: id } };
  return { id: `p-${id}`, tabs: [tab], agentId: tab.agentId, sessionId: tab.sessionId,
    activeTabId: id, label: id, cwd: tab.cwd, agentKind: tab.agentKind,
    agentSessionId: tab.agentSessionId, launchEnv: tab.launchEnv };
}
function makeWorkspace(id: string, name: string, columns: Pane[][], nameSource?: "auto"): Workspace {
  return { id, name, nameSource, status: "running", createdAt: NOW - 300_000, gridTemplateId: `${columns.length}x${Math.max(...columns.map(column => column.length))}`,
    panes: columns.flat(), splitColumns: columns.map(column => column.map(value => value.id)), color: "blue" };
}
async function scan(): Promise<GroupingScan> {
  return buildLocalGroupingScan({ workspaces: workspaces(), now: Date.now(), attentionByTabId: {},
    metadata: Object.fromEntries(selectedIds.map(id => [`session-${id}`, { agentStatus: "working" as const }])),
    lastOutputBySession: Object.fromEntries(selectedIds.map(id => [`session-${id}`, Date.now()])),
    attentionBySession: {}, questionsBySession: {}, seenAttentionByTab: {} });
}
async function fixture(strategy: GroupingPresetStrategy, existing?: "manual" | "auto" | "limited", unrelated = false) {
  const source = makeWorkspace("source", "作業机", [pane("focus"), ...selectedIds.map(id => pane(id, true))].map(value => [value]));
  const values = [source];
  if (existing) {
    const rows = existing === "limited" ? [4, 4, 4, 3] : [1, 1, 1, 1];
    values.push(makeWorkspace("destination", titleFor(strategy), rows.map((count, column) =>
      Array.from({ length: count }, (_, row) => pane(`r${column}-${row}`))), existing === "manual" ? undefined : "auto"));
  }
  if (unrelated) values.push(makeWorkspace("unrelated", "以前の自動名", [[pane("background")]], "auto"));
  const normalized = values.map(normalizeWorkspaceLayout);
  useWorkspaceListStore.setState({ workspaces: structuredClone(normalized), activeWorkspaceId: "source",
    lastActivePaneByWorkspace: { source: "session-focus" }, layoutRevision: 0 });
  useUiStore.setState({ activePaneId: "session-focus", lastActivePaneId: "session-focus", focusRevision: 0 });
  const currentScan = await scan();
  const plan = buildPresetGroupingPlan(currentScan, strategy);
  expect(plan.groups[0].tabIds).toEqual(existing === "limited" ? ["w"] : selectedIds);
  return { plan, currentScan, original: structuredClone(normalized) };
}
function apply(plan: GroupingPlan, currentScan: GroupingScan, seed = "fixed-name") {
  const prepared = groupingBoundary.prepare(plan, { baseline: currentScan.baseline, activeWorkspaceId: "source",
    activeSessionId: "session-focus", allocationSeed: seed, createdAt: Date.now() });
  expect(prepared.ok, prepared.ok ? undefined : prepared.errors.join(" / ")).toBe(true);
  if (!prepared.ok) throw new Error("Fixed-name plan preparation failed");
  const result = groupingBoundary.commit(plan, prepared.ticket);
  expect(result.commit).toMatchObject({ ok: true });
  if (!result.commit.ok) throw new Error("Fixed-name plan commit failed");
  return result.commit;
}
function instruction(tab: PaneTab, text: string, occurrence: number) {
  const material = materialFor(tab, text, occurrence);
  useLiveBriefStore.setState(state => ({
    eventsBySession: { ...state.eventsBySession, [tab.sessionId]: fixtureEvents(material) },
    briefsBySession: { ...state.briefsBySession, [tab.sessionId]: {
      ptySessionId: tab.sessionId, agentSessionId: tab.agentSessionId, agentKind: tab.agentKind,
      telemetryHealth: "live", updatedAt: Date.now(), latestInstruction: text,
      taskSourceEventIds: [], checkpointEvidenceEventIds: [], activitySourceEventId: null,
      namingPlan: material.naming_plan,
    } as LiveSessionBrief },
  }));
}
async function observations() {
  const scheduler = createAutoPaneNamingScheduler(); schedulers.push(scheduler);
  const receipts: string[] = [];
  const originalApply = useWorkspaceListStore.getState().applyNamePatches;
  useWorkspaceListStore.setState({ applyNamePatches: ((...args: Parameters<typeof originalApply>) => {
    const result = originalApply(...args); receipts.push(...result); return result;
  }) as typeof originalApply });
  try {
    for (const seconds of [0, 30, 120, 300, 450, 600, 900]) {
      vi.setSystemTime(NOW + seconds * 1000);
      for (const tab of workspaces().flatMap(value => value.panes.flatMap(value => value.tabs))) {
        instruction(tab, seconds < 450 ? "動画を編集する" : "解説スライドを作る", seconds < 450 ? 0 : 1);
      }
      await scheduler.runNow();
    }
  } finally { scheduler.stop(); useWorkspaceListStore.setState({ applyNamePatches: originalApply }); }
  return receipts;
}
function roundTrip(plan: GroupingPlan, currentScan: GroupingScan, trusted = true, trustedPlans = [plan]) {
  // Sixth argument is a trusted local-plan context. On the plain merge it is
  // ignored, exposing ownership loss as an assertion failure, not a type error.
  const parsed = Reflect.apply(parseGroupingOutput, undefined, [
    JSON.stringify({ schemaVersion: 1, plans: [plan] }), currentScan.tabs.map(tab => tab.id),
    currentScan.workspaceIds, currentScan.workspaces.map(value => value.name), undefined,
    trusted ? trustedPlans : undefined,
  ]) as ReturnType<typeof parseGroupingOutput>;
  expect(parsed.status).toBe("ok");
  if (parsed.status !== "ok") throw new Error("Local preset did not parse");
  return parsed.plans[0];
}
function identity(values: Workspace[]) {
  return values.flatMap(value => value.panes.flatMap(value => value.tabs.map(tab => [tab.id, tab.sessionId])))
    .sort(([a], [b]) => a.localeCompare(b));
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear();
  __resetGroupingRuntimeForTests(); __resetPersistenceCoordinatorForTests(); markPersistentSchemaSupported(1);
  recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} }); useLiveBriefStore.getState().reset();
  useAutoNameRuntimeStore.setState({ recovery: null, revision: 0, meanings: new Map(), descriptions: new Map(),
    invalidatedTabs: new Map(), invalidatedWorkspaces: new Map() });
  useSettingsStore.setState({ autoPaneNamingEnabled: true, autoWorkspaceNamingEnabled: true });
  useAiSettingsStore.setState({ aiEnabled: false });
  fake.invoke.mockReset().mockImplementation(async command => {
    if (command === "get_pty_metadata_snapshot") return Object.fromEntries(workspaces().flatMap(value =>
      value.panes.flatMap(value => value.tabs.map(tab => [tab.sessionId, { process_status: "working" }]))));
    if (command === "get_session_output_snapshot") return {};
    if (command === "auto_name_materials") return [];
    return true; // persistence and local bookkeeping only; no native provider access
  });
});
afterEach(() => {
  schedulers.splice(0).forEach(value => value.stop());
  __resetGroupingRuntimeForTests(); __resetPersistenceCoordinatorForTests();
  vi.clearAllTimers(); vi.useRealTimers(); localStorage.clear();
});

describe.each<GroupingPresetStrategy>(["active_watch", "main_sessions"])("L13-02 %s fixed destination", strategy => {
  it("creates protected provenance atomically, crosses stability/cooldown, and reuses the same destination", async () => {
    const { plan, currentScan, original } = await fixture(strategy);
    const committed = apply(plan, currentScan);
    const id = committed.transaction.expected.newWorkspaceIds[0];
    expect.soft(workspace(id).name).toBe(titleFor(strategy));
    expect.soft(workspace(id).nameSource).toBeUndefined();
    expect.soft(await observations()).not.toContain(id);
    expect.soft(workspace(id).name).toBe(titleFor(strategy));
    expect.soft(workspace(id).nameSource).toBeUndefined();
    const nextScan = await scan(); const next = buildPresetGroupingPlan(nextScan, strategy);
    expect.soft(next.groups[0].destination).toMatchObject({ kind: "existing_workspace", workspaceId: id });
    const second = apply(next, nextScan, "repeat");
    expect.soft(second.transaction.expected.newWorkspaceIds).toEqual([]);
    expect.soft(workspaces().filter(value => value.id !== "source").map(value => value.id)).toEqual([id]);
    expect(identity(workspaces())).toEqual(identity(original));
  });

  it.each(["manual", "auto", "limited"] as const)("protects an existing %s match, preserves residents/capacity, and restores provenance on Undo", async kind => {
    const { plan, currentScan, original } = await fixture(strategy, kind);
    const result = apply(plan, currentScan);
    expect.soft(result.transaction.expected.newWorkspaceIds).toEqual([]);
    expect.soft(workspace("destination").nameSource).toBeUndefined();
    expect.soft(persistentLayoutProjection(workspaces()).workspaces.find(value => value.id === "destination")?.nameSource).toBeUndefined();
    for (const resident of original[1].panes) expect(workspace("destination").panes.find(value => value.id === resident.id)).toEqual(resident);
    expect(workspace("destination").splitColumns?.every(column => column.length <= 4)).toBe(true);
    if (kind === "limited") {
      expect(workspace("source").panes.flatMap(value => value.tabs.map(tab => tab.id))).toEqual(["focus", "m2", "m3"]);
      expect(workspace("destination").splitColumns?.map(column => column.length)).toEqual([4, 4, 4, 4]);
    }
    expect.soft(await observations()).not.toContain("destination");
    expect.soft(workspace("destination").name).toBe(titleFor(strategy));
    expect(groupingBoundary.undo()).toMatchObject({ ok: true });
    expect(workspaces()).toEqual(original);
    expect(useUiStore.getState().activePaneId).toBe("session-focus");
  });

  it.each([undefined, "auto"] as const)("preserves local ownership through clone/reassign/edit/stash/reset/parse and reuse (%s)", async existing => {
    const { plan, currentScan } = await fixture(strategy, existing);
    const id = plan.groups[0].groupId;
    expect.soft(plan.groups[0].destination).toHaveProperty("nameEdited", true);
    const cloned = clonePlanForEdit(plan); let edit = beginGroupingEdit(cloned);
    edit = applyEditCommand(edit, { kind: "reassign_tabs", tabIds: ["focus"], target: { kind: "pane", groupId: id, columnIndex: 0, paneIndex: 0 } });
    expect.soft(edit.plan.groups[0].destination).toEqual(plan.groups[0].destination);
    edit = applyEditCommand(edit, { kind: "set_group_destination", groupId: id, destination: { kind: "current_locations" } });
    edit = applyEditCommand(edit, { kind: "set_group_destination", groupId: id,
      destination: existing ? { kind: "existing_workspace", workspaceId: "destination" } : { kind: "new_workspace", proposedName: titleFor(strategy) } });
    expect.soft(edit.plan.groups[0].destination).toHaveProperty("nameEdited", true);
    if (existing) expect.soft(edit.plan.groups[0].destination).toHaveProperty("proposedName", titleFor(strategy));
    edit = resetGroupingEditToAi(edit);
    const parsed = roundTrip(edit.plan, currentScan);
    expect.soft(parsed.groups[0].destination).toEqual(plan.groups[0].destination);
    expect.soft(parsed.groups[0].destination).toHaveProperty("nameEdited", true);
    expect(parsed.groups[0].layout).toEqual(plan.groups[0].layout);
    const restored = resetGroupingEditToAi(applyEditCommand(beginGroupingEdit(parsed), { kind: "rename_group", groupId: id, title: "別の見出し" }));
    expect.soft(normalizeEditedPlan(restored.plan).groups[0].destination).toEqual(plan.groups[0].destination);
    expect.soft(plan.groups[0].destination).toHaveProperty("nameEdited", true);
    apply(restored.plan, currentScan);
    expect.soft(workspaces().find(value => value.name === titleFor(strategy))?.nameSource).toBeUndefined();
  });

  it("keeps L20's manual same-name ownership edit and edit Undo/reset", async () => {
    const { plan, currentScan } = await fixture(strategy);
    const unowned = roundTrip(plan, currentScan, false); const id = unowned.groups[0].groupId;
    expect(unowned.groups[0].destination).not.toHaveProperty("nameEdited");
    const original = beginGroupingEdit(unowned);
    const edited = applyEditCommand(original, { kind: "rename_new_workspace", groupId: id, proposedName: titleFor(strategy) });
    expect(edited).not.toBe(original);
    expect(edited.plan.groups[0].destination).toMatchObject({ proposedName: titleFor(strategy), nameEdited: true });
    expect(undoGroupingEdit(edited).plan.groups[0].destination).toEqual(unowned.groups[0].destination);
    expect(resetGroupingEditToAi(edited).plan.groups[0].destination).toEqual(unowned.groups[0].destination);
    const parsed = roundTrip(edited.plan, currentScan);
    expect.soft(parsed.groups[0].destination).toEqual(edited.plan.groups[0].destination);
    const result = apply(parsed, currentScan);
    expect.soft(workspace(result.transaction.expected.newWorkspaceIds[0]).nameSource).toBeUndefined();
  });

  it("keeps anchored Apply/Undo and the latest unrelated automatic name", async () => {
    const { plan, currentScan, original } = await fixture(strategy, "auto", true);
    const id = plan.groups[0].groupId;
    const edited = applyEditCommand(beginGroupingEdit(plan), { kind: "reassign_tabs", tabIds: ["r0-0"],
      target: { kind: "pane", groupId: id, columnIndex: 0, paneIndex: 0 } });
    expect(edited.plan.groups[0].layout?.columns[0].existingColumnPaneId).toBe("p-r0-0");
    apply(edited.plan, currentScan);
    expect(workspace("destination").panes.some(value => value.id === "p-r0-0")).toBe(false);
    const receipts = await observations();
    expect(receipts).toContain("unrelated");
    expect.soft(receipts).not.toContain("destination");
    const latestName = workspace("unrelated").name;
    expect(latestName).toBe("解説スライド制作");
    expect(groupingBoundary.undo()).toMatchObject({ ok: true });
    expect(workspace("destination")).toEqual(original[1]);
    expect(workspace("unrelated")).toEqual({ ...original[2], name: latestName });
    expect(identity(workspaces())).toEqual(identity(original));
    expect(useUiStore.getState().activePaneId).toBe("session-focus");
  });

  it("protects an existing match in Apply even if naming ran while the local plan was cached", async () => {
    const { plan, currentScan } = await fixture(strategy, "auto");
    expect(await observations()).toContain("destination");
    expect(workspace("destination").name).not.toBe(titleFor(strategy));
    apply(plan, currentScan);
    expect.soft(workspace("destination").name).toBe(titleFor(strategy));
    expect.soft(workspace("destination").nameSource).toBeUndefined();
    expect(workspaces()).toHaveLength(2);
  });

  it("keeps an existing preset's fixed destination name when only its group heading is edited", async () => {
    const { plan, currentScan } = await fixture(strategy, "auto");
    const edited = applyEditCommand(beginGroupingEdit(plan), { kind: "rename_group", groupId: plan.groups[0].groupId, title: "別の見出し" });
    apply(edited.plan, currentScan);
    expect.soft(workspace("destination").name).toBe(titleFor(strategy));
    expect.soft(workspace("destination").nameSource).toBeUndefined();
  });

  it("does not transfer trusted ownership to a different parsed destination", async () => {
    const { plan, currentScan } = await fixture(strategy);
    const altered = clonePlanForEdit(plan);
    Object.assign(altered.groups[0].destination, { proposedName: "別の自動名", nameEdited: true });
    expect(roundTrip(altered, currentScan, true, [plan]).groups[0].destination)
      .toEqual({ kind: "new_workspace", proposedName: "別の自動名" });
    const existing = clonePlanForEdit(plan);
    existing.groups[0].destination = { kind: "existing_workspace", workspaceId: "source" };
    expect(roundTrip(existing, currentScan, true, [plan]).groups[0].destination)
      .toEqual({ kind: "existing_workspace", workspaceId: "source" });
  });

  it("preserves a manual workspace rename made before a cached preset is applied", async () => {
    const { plan, currentScan } = await fixture(strategy, "auto");
    useWorkspaceListStore.getState().renameWorkspace("destination", "人が決めた名前");
    apply(plan, currentScan);
    expect(workspace("destination").name).toBe("人が決めた名前");
    expect(workspace("destination").nameSource).toBeUndefined();
  });

  it("strips raw model ownership claims and still automatically names an ordinary generated destination with the same literal name", async () => {
    const { plan, currentScan } = await fixture(strategy);
    const model = structuredClone(plan); model.planId = "model-role"; model.strategy = "role"; model.nameSource = "evidence";
    Object.assign(model.groups[0].destination, { nameEdited: true });
    const parsed = roundTrip(model, currentScan, false);
    expect(parsed.groups[0].destination).not.toHaveProperty("nameEdited");
    const result = apply(parsed, currentScan);
    const id = result.transaction.expected.newWorkspaceIds[0];
    expect(workspace(id).nameSource).toBe("auto");
    expect(await observations()).toContain(id);
    expect(workspace(id).name).toBe("解説スライド制作");
    expect(workspace(id).nameSource).toBe("auto");
    const nextScan = await scan();
    const rawExisting = buildPresetGroupingPlan(nextScan, strategy);
    Object.assign(rawExisting.groups[0], { destination: { kind: "existing_workspace", workspaceId: id, nameEdited: true, proposedName: "偽の手動名" } });
    const existing = roundTrip(rawExisting, nextScan, false);
    expect(existing.groups[0].destination).toEqual({ kind: "existing_workspace", workspaceId: id });
  });
});

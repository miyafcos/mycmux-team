import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Pane, PaneTab, Workspace } from "../../src/types";
import type {
  GroupingCommitTicket,
  GroupingCompileContext,
  GroupingPlan,
} from "./helpers/groupingTestEntrypoint";

const NOW = 1_800_000_000_000;
const APPLIED_AT = NOW + 456;
const EXPIRED_REASON = "その後レイアウトが変更されたため元に戻せません";

function tab(id: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    type: "terminal",
    label: `label-${id}`,
    labelSource: "user",
    cwd: `C:/work/${id}`,
    origin: { kind: "human" },
  };
}

function pane(id: string, tabs: PaneTab[]): Pane {
  const active = tabs[0];
  return {
    id,
    agentId: active.agentId,
    sessionId: active.sessionId,
    activeTabId: active.id,
    tabs,
    label: `pane-${id}`,
    cwd: active.cwd,
  };
}

function workspace(id: string, name: string, paneId: string, tabIds: string[]): Workspace {
  return {
    id,
    name,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    color: `color-${id}`,
    pet: "clawd",
    panes: [pane(paneId, tabIds.map(tab))],
    splitColumns: [[paneId]],
    columnWidths: [100],
    rowHeightsPerCol: [[100]],
  };
}

function initialLayout(): Workspace[] {
  return [
    workspace("ws-a", "母艦", "pane-a", ["t1", "t2"]),
    workspace("ws-b", "作業机", "pane-b", ["t3"]),
  ];
}

function baselineOf(workspaces: readonly Workspace[]) {
  return workspaces.flatMap((item) => item.panes.flatMap((itemPane) => (
    itemPane.tabs.map((itemTab) => ({
      tabId: itemTab.id,
      workspaceId: item.id,
      paneId: itemPane.id,
      sessionId: itemTab.sessionId,
    }))
  )));
}

function contextFor(workspaces: readonly Workspace[], seed: string): GroupingCompileContext {
  return {
    baseline: baselineOf(workspaces),
    activeWorkspaceId: "ws-a",
    activeSessionId: "session-t1",
    allocationSeed: seed,
    createdAt: NOW,
    newWorkspaceDefaults: { status: "running", pet: "clawd" },
  };
}

async function loadModules() {
  const entrypoint = await import("./helpers/groupingTestEntrypoint");
  return entrypoint.loadGroupingInternalsForTests();
}

type LoadedModules = Awaited<ReturnType<typeof loadModules>>;

function planFor(modules: LoadedModules): GroupingPlan {
  return {
    planId: "plan-round10-adapter",
    title: "案件で分ける",
    rationale: "案件単位",
    strategy: "project",
    groups: [
      {
        groupId: "group-a",
        title: "案件甲",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "案件甲" },
        layout: modules.grouping.defaultLayoutForTabs(["t1"], "母艦"),
        tabIds: ["t1"],
        adopted: true,
      },
      {
        groupId: "group-keep",
        title: "現状維持",
        disposition: "keep",
        destination: { kind: "current_locations" },
        layout: null,
        tabIds: ["t2", "t3"],
        adopted: true,
      },
    ],
    unassignedTabIds: [],
    warnings: [],
  };
}

function noOpPlan(modules: LoadedModules): GroupingPlan {
  const plan = planFor(modules);
  plan.groups = [{
    ...plan.groups[0],
    disposition: "keep",
    destination: { kind: "current_locations" },
    layout: null,
    tabIds: ["t1", "t2", "t3"],
  }];
  return plan;
}

function seedStores(modules: LoadedModules): Workspace[] {
  const workspaces = initialLayout();
  modules.runtime.__resetGroupingRuntimeForTests();
  modules.persistence.__resetPersistenceCoordinatorForTests();
  modules.persistence.markPersistentSchemaSupported(1);
  modules.runtime.recordPersistentSchemaState({
    loadedSchemaVersion: 1,
    migrationComplete: true,
  });
  modules.workspaceStore.useWorkspaceListStore.setState({
    workspaces: structuredClone(workspaces),
    layoutRevision: 0,
    activeWorkspaceId: "ws-a",
    lastActivePaneByWorkspace: {
      "ws-a": "session-t1",
      "ws-b": "session-t3",
    },
  });
  modules.uiStore.useUiStore.setState({
    activePaneId: "session-t1",
    lastActivePaneId: "session-t1",
    focusRevision: 0,
  });
  return workspaces;
}

function prepare(
  modules: LoadedModules,
  current: Workspace[],
  seed: string,
  plan = planFor(modules),
) {
  const selection = modules.adapter.getGroupingStoreAdapter().getSelection();
  const prepared = modules.adapter.prepareGroupingAtStoreBoundary(plan, {
    ...contextFor(current, seed),
    activeWorkspaceId: selection.activeWorkspaceId,
    activeSessionId: selection.activeSessionId,
  });
  if (!prepared.ok) throw new Error(prepared.errors.join(" / "));
  expect(prepared.ok).toBe(true);
  return { plan, ticket: prepared.ticket };
}

function tamperThroughCopyFallback(
  ticket: GroupingCommitTicket,
  mutate: (draft: GroupingCommitTicket) => void,
): GroupingCommitTicket {
  const copy = structuredClone(ticket);
  mutate(copy);
  return copy;
}

let modules: LoadedModules;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  modules = await loadModules();
  seedStores(modules);
}, 120_000);

describe("Gate 2 round 10 store boundary hardening", () => {
  it("rejects an epoch-tampered ticket after a schema ABA without mutating layout", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "epoch-tamper");
    const layoutBefore = modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    );
    const revisionBefore = modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision;
    modules.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 999, migrationComplete: false });
    modules.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
    const currentEpoch = modules.runtime.useGroupingRuntimeStore.getState().persistentSchema.schemaEpoch;
    const refreshed = prepare(modules, current, "epoch-tamper");
    expect(refreshed.ticket.previewId).toBe(ticket.previewId);
    const tampered = tamperThroughCopyFallback(ticket, (draft) => {
      (draft as { schemaEpoch: number }).schemaEpoch = currentEpoch;
    });

    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, tampered);

    expect(result.commit).toMatchObject({
      ok: false,
      kind: "invalid_input",
      errors: ["適用チケットのidentityが一致しません"],
    });
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(layoutBefore);
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revisionBefore);
    expect(modules.runtime.groupingUndoRepository.get()).toBeNull();
    expect(modules.runtime.useGroupingRuntimeStore.getState().poisoned).toBe(false);
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit).toMatchObject({
      ok: false,
      kind: "invalid_input",
      errors: ["このエンジンが発行した適用チケットではありません"],
    });
  });

  it("rejects expected.movedTabIds injection on a no-op ticket", () => {
    const current = initialLayout();
    const plan = noOpPlan(modules);
    const { ticket } = prepare(modules, current, "expected-tamper", plan);
    expect(ticket.transaction.expected.movedTabIds).toEqual([]);
    const layoutBefore = modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    );
    const revisionBefore = modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision;
    const tampered = tamperThroughCopyFallback(ticket, (draft) => {
      draft.transaction.expected.movedTabIds.push("forged-tab");
    });

    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, tampered);

    expect(result.commit).toMatchObject({
      ok: false,
      kind: "invalid_input",
      errors: ["適用チケットのidentityが一致しません"],
    });
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(layoutBefore);
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revisionBefore);
    expect(modules.runtime.groupingUndoRepository.get()).toBeNull();
    expect(modules.runtime.useGroupingRuntimeStore.getState().poisoned).toBe(false);
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit).toMatchObject({
      ok: false,
      kind: "invalid_input",
      errors: ["このエンジンが発行した適用チケットではありません"],
    });
  });

  it("keeps the applied report and signature readable after undo invalidation", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(APPLIED_AT);
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "undo-report-expiry");

    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);

    expect(result.commit.ok).toBe(true);
    if (!result.commit.ok) return;
    const appliedWorkspaces = modules.workspaceStore.useWorkspaceListStore.getState().workspaces;
    const appliedSignature = modules.engine.hashCanonical(
      modules.engine.persistentLayoutProjection(appliedWorkspaces),
    );
    const available = modules.runtime.groupingUndoRepository.get() as unknown as {
      status: string;
      appliedLayoutSignature?: string;
      report?: {
        movedTabCount: number;
        affectedWorkspaceIds: string[];
        appliedAt: number;
      };
    } | null;
    expect(available).toMatchObject({
      status: "available",
      appliedLayoutSignature: appliedSignature,
      report: {
        movedTabCount: result.commit.report.moved.length,
        affectedWorkspaceIds: ["tg-73c5bf3a143a6538dbc79c2d", "ws-a"],
        appliedAt: APPLIED_AT,
      },
    });
    const retainedReport = structuredClone(available?.report);
    const retainedSignature = available?.appliedLayoutSignature;

    modules.workspaceStore.useWorkspaceListStore.getState().renameWorkspace("ws-a", "external-change");

    const expired = modules.runtime.groupingUndoRepository.get() as unknown as {
      status: string;
      expireReason: string | null;
      appliedLayoutSignature?: string;
      report?: unknown;
    } | null;
    expect(expired).toMatchObject({
      status: "expired",
      expireReason: EXPIRED_REASON,
      appliedLayoutSignature: retainedSignature,
      report: retainedReport,
    });
    now.mockRestore();
  });

  it("reports undo-record clear failure after the layout was restored without poisoning", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "undo-clear-failure");
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit.ok).toBe(true);
    const expected = modules.engine.persistentLayoutProjection(current);
    const retained = modules.runtime.groupingUndoRepository.get();
    expect(retained).not.toBeNull();
    let injected = false;
    const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (!injected && previous.undo !== null && state.undo === null) {
        injected = true;
        throw new Error("undo repository clear exploded");
      }
    });

    const result = modules.adapter.undoGroupingAtStoreBoundary();
    unsubscribe();

    expect(result).toEqual({
      ok: false,
      kind: "post_undo_failed",
      layoutReverted: true,
      persistenceRequested: false,
      reason: "undo repository clear exploded",
    });
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(expected);
    expect(modules.runtime.useGroupingRuntimeStore.getState().poisoned).toBe(false);
    expect(modules.runtime.groupingUndoRepository.get()).toMatchObject({
      status: "expired",
      appliedLayoutSignature: retained?.appliedLayoutSignature,
      report: retained?.report,
    });
  });

  it("marks adapter cleanup failure as not yet persistence-requested", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "round12-post-undo-cleanup-failure");
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit.ok).toBe(true);
    const expected = modules.engine.persistentLayoutProjection(current);
    const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (previous.operation?.kind === "undo" && state.operation === null) {
        throw new Error("round12 undo cleanup exploded");
      }
    });

    const result = modules.adapter.undoGroupingAtStoreBoundary();
    unsubscribe();

    expect(result).toEqual({
      ok: false,
      kind: "post_undo_failed",
      layoutReverted: true,
      persistenceRequested: false,
      reason: "round12 undo cleanup exploded",
    });
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(expected);
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      operation: null,
      undo: null,
      poisoned: false,
    });
  });
});

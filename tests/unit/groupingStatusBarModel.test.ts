import { describe, expect, it } from "vitest";

import {
  selectGroupingStatusBarView,
  type GroupingStatusBarOptions,
} from "../../src/components/dashboard/groupingStatusBarModel";
import type { GroupingRuntimeState, GroupingUndoRecord } from "../../src/stores/groupingRuntimeStore";
import type { Sha256 } from "../../src/lib/persistentLayoutProjection";

const signature = "c".repeat(64) as Sha256;
const durabilityBase = {
  requestId: "persist-1",
  layoutRevision: 12,
  signature,
  snapshotDigest: signature,
  leaderGeneration: 1,
};
const undo: GroupingUndoRecord = {
  recordId: "status-bar-undo",
  schemaVersion: 1,
  snapshot: { schemaVersion: 1, workspaces: [], selection: { activeWorkspaceId: null, activeSessionId: null, lastActivePaneByWorkspace: {} } },
  report: { movedTabCount: 3, affectedWorkspaceIds: [], emptyWorkspaceIds: [], appliedAt: 1 },
  appliedLayoutSignature: signature,
  expectedStructuralSignature: signature,
  committedLayoutRevision: 11,
  createdAt: 1_800_000_000_000,
  status: "available",
  expireReason: null,
};
const options: GroupingStatusBarOptions = {
  appVersion: "0.57.0",
  layoutRevision: 12,
  workspaceCount: 2,
  paneCount: 3,
  tabCount: 5,
};

function runtime(overrides: Partial<GroupingRuntimeState> = {}): GroupingRuntimeState {
  return {
    boundaryToken: {},
    schemaVersion: 1,
    persistentSchema: { loadedSchemaVersion: 1, migrationComplete: true, schemaEpoch: 1 },
    transitionDepth: 0,
    transitionEpoch: 0,
    transitionSource: null,
    transitionFrames: [],
    operation: null,
    poisoned: false,
    diagnostic: null,
    undo: null,
    focusIntent: null,
    durability: { status: "idle" },
    ...overrides,
  };
}

describe("grouping status bar model", () => {
  it("returns a permanent poison diagnostic without undo or retry actions", () => {
    const state = runtime({
      poisoned: true,
      durability: {
        status: "failed",
        ...durabilityBase,
        errorCode: "persistence_failed",
        retryScheduled: true,
        failureGeneration: 1,
        ...({ message: "SECRET_CANARY_E02 raw persistence error" } as object),
      },
      diagnostic: {
        code: "rollback_failed",
        occurredAt: 1_800_000_000_000,
        layoutRevision: 11,
        operation: "undo",
        beforeSignature: signature,
        expectedSignature: signature,
        actualSignature: signature,
        errors: ["restore verification failed with RAW TERMINAL SECRET and RAW PROMPT SECRET"],
        ...({ terminalContent: "RAW TERMINAL SECRET", prompt: "RAW PROMPT SECRET" } as object),
      },
      undo,
    });

    const view = selectGroupingStatusBarView(state, options);
    expect(view).toMatchObject({ kind: "poisoned" });
    if (!view || view.kind !== "poisoned") throw new Error("expected poisoned view");
    expect(view.actions.map((action) => action.id)).toEqual([
      "copy_diagnostics",
      "inspect_layout",
      "restart_app",
    ]);
    expect(view.actions.map((action) => action.id)).not.toContain("undo");
    expect(view.actions.map((action) => action.id)).not.toContain("retry");
    expect(view.message).toContain("レイアウトは保存されません。再起動で最後の正常状態に戻ります");
    const serialized = JSON.stringify(view.diagnosticPayload);
    expect(serialized).not.toContain("RAW TERMINAL SECRET");
    expect(serialized).not.toContain("RAW PROMPT SECRET");
    expect(serialized).not.toContain("SECRET_CANARY_E02");
    expect(view.diagnosticPayload).toMatchObject({
      layoutRevision: 11,
      errors: ["rollback_failed:1"],
    });
  });

  it.each(["idle", "pending", "saved"] as const)("hides available undo with %s durability", (status) => {
    const durability: GroupingRuntimeState["durability"] = status === "idle"
      ? { status }
      : { status, ...durabilityBase };
    expect(selectGroupingStatusBarView(runtime({ undo, durability }), options)).toBeNull();
  });

  it("hides expired and absent undo without recomputing signatures", () => {
    expect(selectGroupingStatusBarView(runtime({
      undo: { ...undo, status: "expired", expireReason: "layout changed" },
      durability: { status: "saved", ...durabilityBase },
    }), options)).toBeNull();
    expect(selectGroupingStatusBarView(runtime(), options)).toBeNull();
  });

  it.each(["available", "expired", null] as const)("shows failed durability with undo status %s", (status) => {
    expect(selectGroupingStatusBarView(runtime({
      undo: status ? { ...undo, status, expireReason: status === "expired" ? "layout changed" : null } : null,
      durability: {
        status: "failed",
        ...durabilityBase,
        errorCode: "persistence_failed",
        retryScheduled: true,
        failureGeneration: 1,
      },
    }), options)).toEqual({
      kind: "durability_warning",
      message: "再配置は適用されましたが、ディスクへの保存を確認できません。アプリを終了せず、再保存を待ってください。",
      warning: null,
      actions: [],
    });
  });

  it("shows deferred durability even while undo is available", () => {
    expect(selectGroupingStatusBarView(runtime({
      undo,
      durability: { status: "deferred", ...durabilityBase, reason: "not_leader" },
    }), options)).toMatchObject({ kind: "durability_warning", warning: null, actions: [] });
  });
});

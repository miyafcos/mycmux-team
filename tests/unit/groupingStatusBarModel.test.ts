import { describe, expect, it } from "vitest";

import {
  selectGroupingStatusBarView,
  type GroupingStatusBarOptions,
} from "../../src/components/dashboard/groupingStatusBarModel";
import type { GroupingRuntimeState } from "../../src/stores/groupingRuntimeStore";
import type { Sha256 } from "../../src/lib/persistentLayoutProjection";

const signature = "c".repeat(64) as Sha256;
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
    persistentSchema: { loadedSchemaVersion: 1, migrationComplete: true },
    transitionDepth: 0,
    transitionEpoch: 0,
    transitionSource: null,
    operation: null,
    poisoned: false,
    diagnostic: null,
    undo: null,
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
        requestId: "persist-secret",
        layoutRevision: 12,
        signature,
        errorCode: "persistence_failed",
        retryScheduled: true,
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
      undo: {
        recordId: "status-bar-poison-undo",
        schemaVersion: 1,
        snapshot: { schemaVersion: 1, workspaces: [], selection: { activeWorkspaceId: null, activeSessionId: null, lastActivePaneByWorkspace: {} } },
        expectedStructuralSignature: signature,
        committedLayoutRevision: 11,
        createdAt: 1_800_000_000_000,
        status: "available",
        expireReason: null,
      },
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

  it("models available, expired, and absent undo states without recomputing signatures", () => {
    const undo = {
      recordId: "status-bar-undo",
      schemaVersion: 1 as const,
      snapshot: { schemaVersion: 1 as const, workspaces: [], selection: { activeWorkspaceId: null, activeSessionId: null, lastActivePaneByWorkspace: {} } },
      expectedStructuralSignature: signature,
      committedLayoutRevision: 11,
      createdAt: 1_800_000_000_000,
      status: "available" as const,
      expireReason: null,
    };

    expect(selectGroupingStatusBarView(runtime({
      undo,
      durability: {
        status: "deferred",
        requestId: "persist-1",
        layoutRevision: 12,
        signature,
        reason: "not_leader",
      },
    }), options)).toMatchObject({
      kind: "undo_available",
      warning: "再配置は適用されましたが、ディスクへの保存を確認できません。アプリを終了せず、再保存を待ってください。",
      actions: [{ id: "undo", enabled: true }, { id: "review_changes" }, { id: "dismiss" }],
    });
    expect(selectGroupingStatusBarView(runtime({ undo: { ...undo, status: "expired", expireReason: "layout changed" } }), options)).toMatchObject({
      kind: "undo_expired",
      message: "layout changed",
      actions: [{ id: "undo", enabled: false }, { id: "dismiss" }],
    });
    expect(selectGroupingStatusBarView(runtime(), options)).toBeNull();
  });
});

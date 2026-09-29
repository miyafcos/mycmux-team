import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetPersistenceCoordinatorForTests,
  capturePersistRequestSnapshot,
  createPersistenceLeaderPersist,
  createTransitionAwareAutosaveGate,
  getPersistentSchemaState,
  markPersistentSchemaSupported,
  quarantinePersistentSchema,
  quarantinePersistentWrites,
  registerPersistenceLeader,
  requestImmediatePersist,
  type PersistAck,
} from "../../src/lib/workspacePersistenceCoordinator";
import {
  __resetGroupingRuntimeForTests,
  poisonGroupingBoundary,
  runLayoutTransition,
} from "../../src/stores/groupingRuntimeStore";
import { hashCanonical, type PersistentLayoutProjection, type Sha256 } from "../../src/lib/persistentLayoutProjection";

const signature = "a".repeat(64) as Sha256;
const snapshot = { workspaces: [] } satisfies PersistentLayoutProjection;
const snapshotDigest = hashCanonical(snapshot);

function request(requestId = "persist-1", revision = 4) {
  return {
    requestId,
    revision,
    signature,
    snapshot,
    snapshotDigest,
  };
}

describe("workspace persistence coordinator", () => {
  beforeEach(() => {
    __resetPersistenceCoordinatorForTests();
    __resetGroupingRuntimeForTests();
    markPersistentSchemaSupported(1);
  });

  it("keeps persistence closed while schema validation is pending, then flushes once", async () => {
    __resetPersistenceCoordinatorForTests();
    const schedule = vi.fn();
    const gate = createTransitionAwareAutosaveGate(schedule);
    const persist = vi.fn(async (boundRequest) => ({
      status: "saved" as const,
      requestId: boundRequest.requestId,
      savedRevision: boundRequest.revision,
      savedSignature: boundRequest.signature,
      savedDigest: boundRequest.snapshotDigest,
      leaderGeneration: boundRequest.leaderGeneration,
    }));
    registerPersistenceLeader({ windowId: "main", persist });

    gate.request();
    await expect(requestImmediatePersist(request("pending"))).resolves.toMatchObject({
      status: "failed",
      retryScheduled: false,
    });
    expect(schedule).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(getPersistentSchemaState()).toEqual({ status: "pending" });

    markPersistentSchemaSupported(1);
    expect(schedule).toHaveBeenCalledOnce();
    await expect(requestImmediatePersist(request("supported"))).resolves.toMatchObject({
      status: "saved",
      requestId: "supported",
    });
    expect(persist).toHaveBeenCalledOnce();
    gate.dispose();
  });

  it("keeps a child request deferred while its schema state is still pending", async () => {
    __resetPersistenceCoordinatorForTests();

    await expect(requestImmediatePersist(request("child-pending"))).resolves.toEqual({
      status: "deferred",
      requestId: "child-pending",
      reason: "leader_unavailable",
    });
  });

  it("latches unsupported schema quarantine and never calls the leader writer", async () => {
    __resetPersistenceCoordinatorForTests();
    const persist = vi.fn();
    registerPersistenceLeader({ windowId: "main", persist });

    quarantinePersistentSchema(999);
    markPersistentSchemaSupported(1);

    await expect(requestImmediatePersist(request("quarantined"))).resolves.toMatchObject({
      status: "failed",
      requestId: "quarantined",
      retryScheduled: false,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(getPersistentSchemaState()).toEqual({
      status: "quarantined",
      reason: "unsupportedSchema",
      schemaVersion: 999,
      diagnostic: "unsupported persistent schema 999",
      requiresUnsavedConfirmation: true,
    });
  });

  it("latches hydration failures as an unsaved terminal state", async () => {
    __resetPersistenceCoordinatorForTests();
    const persist = vi.fn();
    registerPersistenceLeader({ windowId: "main", persist });

    quarantinePersistentWrites({
      reason: "hydrationFailed",
      diagnostic: "hydrate failed",
      requiresUnsavedConfirmation: true,
    });

    await expect(requestImmediatePersist(request("hydrate-failed"))).resolves.toMatchObject({
      status: "failed",
      retryScheduled: false,
      error: "hydrate failed",
    });
    expect(getPersistentSchemaState()).toEqual({
      status: "quarantined",
      reason: "hydrationFailed",
      diagnostic: "hydrate failed",
      requiresUnsavedConfirmation: true,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("never reports a missing or non-leader writer as saved", async () => {
    const persistRequest = request();
    await expect(requestImmediatePersist(persistRequest)).resolves.toEqual({
      status: "deferred",
      requestId: "persist-1",
      reason: "leader_unavailable",
    });

    const sync = vi.fn(async (boundRequest) => ({
      requestId: boundRequest.requestId,
      savedRevision: boundRequest.revision,
      savedSignature: boundRequest.signature,
      savedDigest: boundRequest.snapshotDigest,
      leaderGeneration: boundRequest.leaderGeneration,
    }));
    const unregister = registerPersistenceLeader({
      windowId: "main",
      persist: createPersistenceLeaderPersist({
        isLeader: () => false,
        sync,
        failure: () => ({ error: "unused", retryScheduled: false, failureGeneration: 0 }),
      }),
    });
    await expect(requestImmediatePersist(persistRequest)).resolves.toEqual({
      status: "deferred",
      requestId: "persist-1",
      reason: "not_leader",
    });
    expect(sync).not.toHaveBeenCalled();
    unregister();

    let leader = true;
    let finishSync: ((ack: PersistAck) => void) | null = null;
    const delayedSync = vi.fn((_boundRequest) => new Promise<PersistAck>((resolve) => {
      finishSync = resolve;
    }));
    const unregisterDelayed = registerPersistenceLeader({
      windowId: "main",
      persist: createPersistenceLeaderPersist({
        isLeader: () => leader,
        sync: delayedSync,
        failure: () => ({ error: "unused", retryScheduled: false, failureGeneration: 0 }),
      }),
    });
    const delayedOutcome = requestImmediatePersist(persistRequest);
    await vi.waitFor(() => expect(delayedSync).toHaveBeenCalledTimes(1));
    leader = false;
    if (!finishSync) throw new Error("sync resolver was not installed");
    finishSync({
      requestId: "persist-1",
      savedRevision: 4,
      savedSignature: signature,
      savedDigest: snapshotDigest,
      leaderGeneration: 2,
    });
    await expect(delayedOutcome).resolves.toEqual({
      status: "deferred",
      requestId: "persist-1",
      reason: "not_leader",
    });
    unregisterDelayed();
  });

  it("binds a deep immutable snapshot and validates every acknowledgement field", async () => {
    const source = {
      workspaces: [{
        id: "ws-1",
        panes: [{ tabs: [{ commandArgv: ["before"], terminalSnapshot: [1, 2] }] }],
      }],
    } as unknown as PersistentLayoutProjection;
    const captured = capturePersistRequestSnapshot(source);
    (source.workspaces[0] as unknown as { panes: Array<{ tabs: Array<{ commandArgv: string[] }> }> })
      .panes[0].tabs[0].commandArgv[0] = "after";
    expect((captured.snapshot.workspaces[0] as unknown as {
      panes: Array<{ tabs: Array<{ commandArgv: string[] }> }>;
    }).panes[0].tabs[0].commandArgv).toEqual(["before"]);
    expect(hashCanonical(captured.snapshot)).toBe(captured.snapshotDigest);
    expect(Object.isFrozen(captured.snapshot)).toBe(true);

    const mismatches = ["requestId", "savedRevision", "savedSignature", "savedDigest", "leaderGeneration"] as const;
    for (const mismatch of mismatches) {
      __resetPersistenceCoordinatorForTests();
      markPersistentSchemaSupported(1);
      registerPersistenceLeader({
        windowId: "main",
        persist: createPersistenceLeaderPersist({
          isLeader: () => true,
          sync: async (boundRequest) => ({
            requestId: mismatch === "requestId" ? "wrong" : boundRequest.requestId,
            savedRevision: mismatch === "savedRevision" ? boundRequest.revision + 1 : boundRequest.revision,
            savedSignature: mismatch === "savedSignature" ? "b".repeat(64) as Sha256 : boundRequest.signature,
            savedDigest: mismatch === "savedDigest" ? "c".repeat(64) as Sha256 : boundRequest.snapshotDigest,
            leaderGeneration: mismatch === "leaderGeneration"
              ? boundRequest.leaderGeneration + 1
              : boundRequest.leaderGeneration,
          }),
          failure: () => ({ error: "unused", retryScheduled: false, failureGeneration: 0 }),
        }),
      });
      await expect(requestImmediatePersist({
        requestId: `mismatch-${mismatch}`,
        revision: 1,
        signature,
        ...captured,
      })).resolves.toMatchObject({ status: "failed", error: "persistence acknowledgement mismatch" });
    }
  });

  it("rejects an old leader acknowledgement after registration changes", async () => {
    let resolveOld: ((outcome: Awaited<ReturnType<typeof requestImmediatePersist>>) => void) | null = null;
    registerPersistenceLeader({
      windowId: "old",
      persist: () => new Promise((resolve) => { resolveOld = resolve; }),
    });
    const oldOutcome = requestImmediatePersist(request("old-request"));
    await vi.waitFor(() => expect(resolveOld).not.toBeNull());
    const newPersist = vi.fn(async (boundRequest) => ({
      status: "saved" as const,
      requestId: boundRequest.requestId,
      savedRevision: boundRequest.revision,
      savedSignature: boundRequest.signature,
      savedDigest: boundRequest.snapshotDigest,
      leaderGeneration: boundRequest.leaderGeneration,
    }));
    registerPersistenceLeader({ windowId: "new", persist: newPersist });
    resolveOld?.({
      status: "saved",
      requestId: "old-request",
      savedRevision: 4,
      savedSignature: signature,
      savedDigest: snapshotDigest,
      leaderGeneration: 1,
    });
    await expect(oldOutcome).resolves.toEqual({
      status: "deferred",
      requestId: "old-request",
      reason: "leader_changed",
    });
    await requestImmediatePersist(request("new-request"));
    expect(newPersist).toHaveBeenCalledOnce();
  });

  it("coalesces transition-time autosave requests into one post-transition flush", () => {
    const snapshots: string[] = [];
    let latestSnapshot = "before";
    const gate = createTransitionAwareAutosaveGate(() => snapshots.push(latestSnapshot));

    runLayoutTransition("grouping-commit", () => {
      latestSnapshot = "intermediate";
      gate.request();
      latestSnapshot = "final";
      gate.request();
      expect(snapshots).toEqual([]);
    });

    expect(snapshots).toEqual(["final"]);
    gate.dispose();
  });

  it("quarantines deferred autosave synchronously when grouping becomes poisoned", async () => {
    const schedule = vi.fn();
    const persist = vi.fn();
    const gate = createTransitionAwareAutosaveGate(schedule);
    registerPersistenceLeader({ windowId: "main", persist });

    runLayoutTransition("grouping-commit", () => {
      gate.request();
      poisonGroupingBoundary({
        code: "rollback_failed",
        occurredAt: 1,
        layoutRevision: 2,
        operation: "commit",
        errors: ["forced rollback failure"],
      });
    });

    expect(schedule).not.toHaveBeenCalled();
    expect(getPersistentSchemaState()).toMatchObject({
      status: "quarantined",
      reason: "groupingPoisoned",
      requiresUnsavedConfirmation: true,
    });
    await expect(requestImmediatePersist(request("poisoned"))).resolves.toMatchObject({
      status: "failed",
      retryScheduled: false,
    });
    expect(persist).not.toHaveBeenCalled();
    gate.dispose();
  });
});

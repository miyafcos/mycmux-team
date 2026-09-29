import {
  PersistentLayoutValidationError,
  persistentLayoutProjection,
  persistentLayoutSignature,
} from "../../lib/persistentLayoutProjection";
import "../../lib/layoutRevisionAuditBootstrap";
import {
  capturePersistRequestSnapshot,
  currentPersistenceLeaderGeneration,
  requestImmediatePersist,
  type PersistRequestDraft,
} from "../../lib/workspacePersistenceCoordinator";
import {
  assertGroupingSchemaCompatible,
  captureGroupingSchemaStamp,
  endGroupingOperation,
  GroupingUnavailableError,
  groupingUndoRepository,
  hasGroupingOperationViolation,
  markDurabilityPending,
  poisonGroupingBoundary,
  recordPersistOutcome,
  runLayoutTransition,
  tryBeginGroupingOperation,
  useGroupingRuntimeStore,
  type GroupingUndoRecord,
  type LayoutMutationSource,
} from "../../stores/groupingRuntimeStore";
import { useUiStore } from "../../stores/uiStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { workspaceGroupingMutationCapability } from "../../stores/workspaceGroupingMutationCapability.internal";
import {
  claimPreparedGroupingCommit,
  commitClaimedGrouping,
  hashCanonical,
  normalizeGroupingStateSnapshot,
  prepareGroupingCommit,
  restoreGroupingUndo,
  validateGroupingStateSnapshot,
  type CommitResult,
  type GroupingCompileContext,
  type GroupingCommitTicket,
  type GroupingEngineDependencies,
  type GroupingSelectionState,
  type GroupingStateSnapshot,
  type PrepareResult,
  type Sha256,
  type UndoResult,
} from "./tabGroupingEngine";
import type { GroupingPlan } from "./tabGrouping";

export interface GroupingStoreAdapter extends GroupingEngineDependencies {
  getGroupingState(): GroupingStateSnapshot;
}

function assertGroupingBoundaryAvailable(): void {
  const runtime = useGroupingRuntimeStore.getState();
  if (runtime.poisoned) {
    throw new Error("grouping boundary is poisoned");
  }
  if (runtime.operation !== null && runtime.transitionDepth === 0) {
    throw new Error("grouping boundary operation is in progress");
  }
}

function assertGroupingPreviewAvailable(): void {
  const runtime = useGroupingRuntimeStore.getState();
  if (runtime.poisoned) {
    throw new Error("grouping boundary is poisoned");
  }
  if (runtime.operation !== null || runtime.transitionDepth > 0) {
    throw new Error("grouping boundary operation is in progress");
  }
}

function activeTransitionSource(): LayoutMutationSource {
  assertGroupingBoundaryAvailable();
  const runtime = useGroupingRuntimeStore.getState();
  if (runtime.transitionDepth <= 0 || !runtime.transitionSource) {
    throw new Error("grouping store mutation requires a layout transition");
  }
  return runtime.transitionSource;
}

function assertValidGroupingSnapshot(snapshot: GroupingStateSnapshot): void {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.workspaces)) {
    throw new Error("grouping snapshot workspaces must be an array");
  }
  if (snapshot.schemaVersion !== 1) {
    throw new Error("grouping snapshot schemaVersion is invalid");
  }
  const selection = snapshot.selection;
  if (!selection || typeof selection !== "object") {
    throw new Error("grouping snapshot selection is required");
  }
  if (selection.activeWorkspaceId !== null && typeof selection.activeWorkspaceId !== "string") {
    throw new Error("grouping snapshot activeWorkspaceId is invalid");
  }
  if (selection.activeSessionId !== null && typeof selection.activeSessionId !== "string") {
    throw new Error("grouping snapshot activeSessionId is invalid");
  }
  if (!selection.lastActivePaneByWorkspace
    || typeof selection.lastActivePaneByWorkspace !== "object"
    || Array.isArray(selection.lastActivePaneByWorkspace)
    || Object.values(selection.lastActivePaneByWorkspace).some((sessionId) => typeof sessionId !== "string")) {
    throw new Error("grouping snapshot lastActivePaneByWorkspace is invalid");
  }
  const issues = validateGroupingStateSnapshot(snapshot);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => (
      `${issue.kind} ${issue.id} at ${issue.locations.join(", ")}`
    )).join("; "));
  }
}

function assertCurrentSchemaForSnapshot(snapshot: GroupingStateSnapshot): void {
  assertValidGroupingSnapshot(snapshot);
  assertGroupingSchemaCompatible({ snapshotSchemaVersion: snapshot.schemaVersion });
}

function readSelection(): GroupingSelectionState {
  const workspaceState = useWorkspaceListStore.getState();
  const uiState = useUiStore.getState();
  return {
    activeWorkspaceId: workspaceState.activeWorkspaceId,
    activeSessionId: uiState.activePaneId,
    lastActivePaneByWorkspace: {
      ...workspaceState.lastActivePaneByWorkspace,
    },
  };
}

function writeUiSelection(selection: GroupingSelectionState): void {
  useUiStore.setState({
    activePaneId: selection.activeSessionId,
    ...(selection.activeSessionId !== null
      ? { lastActivePaneId: selection.activeSessionId }
      : {}),
  });
}

function readGroupingState(): GroupingStateSnapshot {
  return {
    schemaVersion: 1,
    workspaces: structuredClone(useWorkspaceListStore.getState().workspaces),
    selection: structuredClone(readSelection()),
  };
}

function restoreGroupingLayoutAtBoundary(
  workspaces: GroupingStateSnapshot["workspaces"],
  selection: GroupingSelectionState,
  source: LayoutMutationSource,
): void {
  useWorkspaceListStore.getState()._restoreGroupingLayout(
    workspaces,
    selection,
    source,
    workspaceGroupingMutationCapability,
  );
}

function sameGroupingState(left: GroupingStateSnapshot, right: GroupingStateSnapshot): boolean {
  return persistentLayoutSignature(left.workspaces) === persistentLayoutSignature(right.workspaces)
    && hashCanonical(left.selection) === hashCanonical(right.selection);
}

function restoreGroupingSnapshotUnchecked(snapshot: GroupingStateSnapshot): void {
  const normalized = normalizeGroupingStateSnapshot(snapshot, "adapter rollback");
  assertValidGroupingSnapshot(normalized);
  runLayoutTransition("grouping-rollback", () => {
    restoreGroupingLayoutAtBoundary(
      structuredClone(normalized.workspaces),
      structuredClone(normalized.selection),
      "grouping-rollback",
    );
    writeUiSelection(normalized.selection);
  });
  if (!sameGroupingState(readGroupingState(), normalized)) {
    throw new Error("レイアウトの復旧を確認できませんでした");
  }
}

function safePersistentLayoutSignature(workspaces: readonly GroupingStateSnapshot["workspaces"][number][]): Sha256 | undefined {
  try {
    return persistentLayoutSignature(workspaces);
  } catch {
    return undefined;
  }
}

export function getGroupingStoreAdapter(): GroupingStoreAdapter {
  const boundaryToken = useGroupingRuntimeStore.getState().boundaryToken;
  const getWorkspaces = () => {
    assertGroupingBoundaryAvailable();
    return useWorkspaceListStore.getState().workspaces;
  };
  const getSelection = () => {
    assertGroupingBoundaryAvailable();
    return readSelection();
  };
  const getGroupingState = (): GroupingStateSnapshot => ({
    schemaVersion: 1,
    workspaces: structuredClone(getWorkspaces()),
    selection: structuredClone(getSelection()),
  });
  const replaceWorkspaces = (workspaces: GroupingStateSnapshot["workspaces"]): void => {
    const source = activeTransitionSource();
    restoreGroupingLayoutAtBoundary(
      structuredClone(workspaces),
      readSelection(),
      source,
    );
  };
  const applySelection = (selection: GroupingSelectionState): void => {
    const source = activeTransitionSource();
    restoreGroupingLayoutAtBoundary(
      structuredClone(useWorkspaceListStore.getState().workspaces),
      structuredClone(selection),
      source,
    );
    writeUiSelection(selection);
  };
  const restoreGroupingState = (snapshot: GroupingStateSnapshot): void => {
    assertGroupingBoundaryAvailable();
    assertCurrentSchemaForSnapshot(snapshot);
    restoreGroupingSnapshotUnchecked(snapshot);
  };
  return {
    boundaryToken,
    getWorkspaces,
    getSelection,
    getGroupingState,
    replaceWorkspaces,
    applySelection,
    restoreGroupingState,
    getLayoutRevision: () => useWorkspaceListStore.getState().layoutRevision,
    undo: groupingUndoRepository,
  };
}

type StoreBoundaryPrepareFailure = {
  ok: false;
  kind: "boundary_poisoned" | "operation_in_progress" | "unexpected_error";
  stale: [];
  errors: string[];
};

export type GroupingBoundaryPrepareResult = PrepareResult | StoreBoundaryPrepareFailure;

export type GroupingBoundaryUndoResult = UndoResult;

function prepareBoundaryFailure(error: unknown): GroupingBoundaryPrepareResult {
  const message = error instanceof Error ? error.message : String(error);
  const runtime = useGroupingRuntimeStore.getState();
  if (runtime.poisoned) {
    return { ok: false, kind: "boundary_poisoned", stale: [], errors: [message] };
  }
  if (runtime.operation !== null || runtime.transitionDepth > 0) {
    return { ok: false, kind: "operation_in_progress", stale: [], errors: [message] };
  }
  if (error instanceof GroupingUnavailableError) {
    return { ok: false, kind: "schema_incompatible", stale: [], errors: [message] };
  }
  return { ok: false, kind: "unexpected_error", stale: [], errors: [message] };
}

export function prepareGroupingAtStoreBoundary(
  plan: GroupingPlan,
  context: GroupingCompileContext,
): GroupingBoundaryPrepareResult {
  try {
    assertGroupingPreviewAvailable();
    const schemaStamp = captureGroupingSchemaStamp();
    const adapter = getGroupingStoreAdapter();
    const selection = adapter.getSelection();
    return prepareGroupingCommit(plan, adapter.getWorkspaces(), {
      ...structuredClone(context),
      activeWorkspaceId: selection.activeWorkspaceId,
      activeSessionId: selection.activeSessionId,
    }, schemaStamp.schemaEpoch);
  } catch (error) {
    return prepareBoundaryFailure(error);
  }
}

function operationInProgressCommit(): CommitResult {
  return {
    ok: false,
    kind: "operation_in_progress",
    errors: ["別の再配置処理が実行中です"],
  };
}

function boundaryPoisonedCommit(): CommitResult {
  return {
    ok: false,
    kind: "boundary_poisoned",
    errors: ["再配置境界が rollback_failed 後に封印されています"],
  };
}

export type GroupingBoundaryDurability = "idle" | "pending" | "saved" | "failed" | "deferred";

export interface GroupingBoundaryCommitResult {
  commit: CommitResult;
  durability: GroupingBoundaryDurability;
}

function currentBoundaryDurability(): GroupingBoundaryDurability {
  return useGroupingRuntimeStore.getState().durability.status;
}

function requestCurrentLayoutPersistence(): GroupingBoundaryDurability {
  const workspaceState = useWorkspaceListStore.getState();
  const layoutSignature = persistentLayoutSignature(workspaceState.workspaces);
  const captured = capturePersistRequestSnapshot(
    persistentLayoutProjection(workspaceState.workspaces),
  );
  const leaderGeneration = currentPersistenceLeaderGeneration();
  markDurabilityPending(
    workspaceState.layoutRevision,
    layoutSignature,
    captured.snapshotDigest,
    leaderGeneration,
  );
  const durability = useGroupingRuntimeStore.getState().durability;
  if (durability.status !== "pending") return currentBoundaryDurability();
  const request: PersistRequestDraft = {
    requestId: durability.requestId,
    revision: durability.layoutRevision,
    signature: durability.signature,
    snapshot: captured.snapshot,
    snapshotDigest: captured.snapshotDigest,
  };
  void requestImmediatePersist(request).then(recordPersistOutcome);
  return "pending";
}

function schemaIncompatibleCommit(error: unknown): GroupingBoundaryCommitResult {
  return {
    commit: {
      ok: false,
      kind: "schema_incompatible",
      errors: [error instanceof Error ? error.message : String(error)],
    },
    durability: currentBoundaryDurability(),
  };
}

function operationInProgressUndo(): UndoResult {
  return {
    ok: false,
    kind: "operation_in_progress",
    reason: "別の再配置処理が実行中です",
  };
}

function boundaryPoisonedUndo(): UndoResult {
  return {
    ok: false,
    kind: "boundary_poisoned",
    reason: "再配置境界が rollback_failed 後に封印されています",
  };
}

function undoBoundaryFailure(error: unknown): UndoResult {
  const message = error instanceof Error ? error.message : String(error);
  if (useGroupingRuntimeStore.getState().poisoned) return boundaryPoisonedUndo();
  if (error instanceof GroupingUnavailableError) {
    return { ok: false, kind: "schema_incompatible", reason: message };
  }
  if (error instanceof PersistentLayoutValidationError) {
    return { ok: false, kind: "invalid_layout", reason: message };
  }
  return { ok: false, kind: "unexpected_error", reason: message };
}

function postUndoFailure(
  error: unknown,
  persistenceRequested?: false,
): Extract<GroupingBoundaryUndoResult, { kind: "post_undo_failed" }> {
  return {
    ok: false,
    kind: "post_undo_failed",
    layoutReverted: true,
    ...(persistenceRequested === false ? { persistenceRequested } : {}),
    reason: error instanceof Error ? error.message : String(error),
  };
}

function rollbackCommittedGrouping(
  before: GroupingStateSnapshot,
  previousUndo: GroupingUndoRecord | null,
  token: symbol,
  kind: "schema_incompatible" | "commit_mismatch",
  errors: string[],
): CommitResult {
  const beforeSignature = safePersistentLayoutSignature(before.workspaces);
  try {
    restoreGroupingSnapshotUnchecked(before);
    if (previousUndo) groupingUndoRepository.set(previousUndo);
    else groupingUndoRepository.clear();
    return { ok: false, kind, errors };
  } catch (error) {
    const rollbackErrors = [...errors, error instanceof Error ? error.message : String(error)];
    poisonGroupingBoundary({
      code: "rollback_failed",
      occurredAt: Date.now(),
      layoutRevision: useWorkspaceListStore.getState().layoutRevision,
      operation: "rollback",
      beforeSignature,
      expectedSignature: beforeSignature,
      actualSignature: safePersistentLayoutSignature(useWorkspaceListStore.getState().workspaces),
      errors: rollbackErrors,
    }, token);
    return { ok: false, kind: "rollback_failed", errors: rollbackErrors };
  }
}

export function commitGroupingAtStoreBoundary(
  plan: GroupingPlan,
  ticket: GroupingCommitTicket,
): GroupingBoundaryCommitResult {
  const initialRuntime = useGroupingRuntimeStore.getState();
  if (initialRuntime.poisoned) {
    return { commit: boundaryPoisonedCommit(), durability: currentBoundaryDurability() };
  }
  if (initialRuntime.operation !== null) {
    return { commit: operationInProgressCommit(), durability: currentBoundaryDurability() };
  }
  const claimed = claimPreparedGroupingCommit(ticket);
  if (!claimed.ok) {
    return { commit: claimed, durability: currentBoundaryDurability() };
  }
  try {
    assertGroupingSchemaCompatible({
      ticketSchemaVersion: ticket?.schemaVersion,
      ticketSchemaEpoch: ticket?.schemaEpoch,
    });
  } catch (error) {
    return schemaIncompatibleCommit(error);
  }
  if (ticket?.transaction?.expected?.movedTabIds?.length === 0) {
    return {
      commit: {
        ok: false,
        kind: "invalid_input",
        errors: ["移動対象がない再配置は適用できません"],
      },
      durability: currentBoundaryDurability(),
    };
  }
  const token = tryBeginGroupingOperation("commit");
  if (!token) {
    const commit = useGroupingRuntimeStore.getState().poisoned
      ? boundaryPoisonedCommit()
      : operationInProgressCommit();
    return { commit, durability: currentBoundaryDurability() };
  }
  try {
  let operationEndedByPoison = false;
  let outcome: GroupingBoundaryCommitResult | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let before: GroupingStateSnapshot | undefined;
  let previousUndo: GroupingUndoRecord | null | undefined;
  let committedState: GroupingStateSnapshot | undefined;
  try {
    assertGroupingSchemaCompatible({
      ticketSchemaVersion: ticket.schemaVersion,
      ticketSchemaEpoch: ticket.schemaEpoch,
    });
    const adapter = getGroupingStoreAdapter();
    previousUndo = groupingUndoRepository.get();
    before = readGroupingState();
    const beforeSignature = safePersistentLayoutSignature(useWorkspaceListStore.getState().workspaces);
    let commit = runLayoutTransition("grouping-commit", () => {
      assertGroupingSchemaCompatible({
        ticketSchemaVersion: ticket.schemaVersion,
        ticketSchemaEpoch: ticket.schemaEpoch,
      });
      const result = commitClaimedGrouping(plan, claimed.attempt, adapter);
      if (!result.ok && result.kind === "rollback_failed") {
        try {
          poisonGroupingBoundary({
            code: "rollback_failed",
            occurredAt: Date.now(),
            layoutRevision: useWorkspaceListStore.getState().layoutRevision,
            operation: "commit",
            beforeSignature,
            expectedSignature: ticket.outputSignature,
            actualSignature: safePersistentLayoutSignature(useWorkspaceListStore.getState().workspaces),
            errors: [...result.errors],
          }, token);
        } finally {
          const runtime = useGroupingRuntimeStore.getState();
          operationEndedByPoison = runtime.poisoned && runtime.operation === null;
        }
      }
      if (result.ok) committedState = readGroupingState();
      return result;
    });
    if (commit.ok) {
      try {
        assertGroupingSchemaCompatible({
          ticketSchemaVersion: ticket.schemaVersion,
          ticketSchemaEpoch: ticket.schemaEpoch,
        });
      } catch (error) {
        commit = rollbackCommittedGrouping(
          before,
          previousUndo,
          token,
          "schema_incompatible",
          [error instanceof Error ? error.message : String(error)],
        );
      }
    }
    if (commit.ok && (hasGroupingOperationViolation(token)
      || !committedState
      || !sameGroupingState(readGroupingState(), committedState))) {
      commit = rollbackCommittedGrouping(
        before,
        previousUndo,
        token,
        "commit_mismatch",
        ["transition終了通知中に外部レイアウト変更が試行されました"],
      );
    }
    operationEndedByPoison = useGroupingRuntimeStore.getState().operation === null;
    outcome = {
      commit,
      durability: commit.ok ? requestCurrentLayoutPersistence() : currentBoundaryDurability(),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "GroupingUnavailableError") {
      outcome = schemaIncompatibleCommit(error);
    } else {
      hasPrimaryError = true;
      primaryError = error;
      if (before && !sameGroupingState(readGroupingState(), before)) {
        try {
          restoreGroupingSnapshotUnchecked(before);
          if (previousUndo) groupingUndoRepository.set(previousUndo);
          else groupingUndoRepository.clear();
        } catch {
          // Preserve the primary listener/body error; poisoning is best effort here.
          try {
            poisonGroupingBoundary({
              code: "rollback_failed",
              occurredAt: Date.now(),
              layoutRevision: useWorkspaceListStore.getState().layoutRevision,
              operation: "rollback",
              expectedSignature: safePersistentLayoutSignature(before.workspaces),
              actualSignature: safePersistentLayoutSignature(useWorkspaceListStore.getState().workspaces),
              errors: [error instanceof Error ? error.message : String(error)],
            }, token);
          } catch {
            // The original exception remains authoritative.
          }
        }
      }
    }
  }
  operationEndedByPoison ||= useGroupingRuntimeStore.getState().operation === null;
  let cleanupError: unknown;
  if (!operationEndedByPoison) {
    try {
      endGroupingOperation(token);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (hasPrimaryError) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return outcome ?? schemaIncompatibleCommit(new Error("grouping commit did not produce a result"));
  } finally {
    const heldOperation = useGroupingRuntimeStore.getState().operation;
    if (heldOperation?.token === token) endGroupingOperation(token);
  }
}

export function undoGroupingAtStoreBoundary(): GroupingBoundaryUndoResult {
  if (useGroupingRuntimeStore.getState().poisoned) return boundaryPoisonedUndo();
  let token: symbol | null = null;
  let operationEndedByPoison = false;
  let result: UndoResult | undefined;
  let layoutReverted = false;
  let primaryError: unknown;
  try {
    assertGroupingSchemaCompatible();
    const schemaUndo = groupingUndoRepository.get();
    if (schemaUndo) assertGroupingSchemaCompatible({
      snapshotSchemaVersion: schemaUndo.snapshot.schemaVersion,
      undoSchemaVersion: schemaUndo.schemaVersion,
    });
    token = tryBeginGroupingOperation("undo");
    if (!token) {
      return useGroupingRuntimeStore.getState().poisoned
        ? boundaryPoisonedUndo()
        : operationInProgressUndo();
    }
    const operationToken = token;
    const adapter = getGroupingStoreAdapter();
    const undo = groupingUndoRepository.get();
    const beforeSignature = safePersistentLayoutSignature(useWorkspaceListStore.getState().workspaces);
    result = runLayoutTransition("grouping-undo", () => {
      const undoResult = restoreGroupingUndo(adapter);
      if (undoResult.ok || undoResult.kind === "post_undo_failed") layoutReverted = true;
      if (!undoResult.ok && undoResult.kind === "restore_failed") {
        try {
          poisonGroupingBoundary({
            code: "rollback_failed",
            occurredAt: Date.now(),
            layoutRevision: useWorkspaceListStore.getState().layoutRevision,
            operation: "undo",
            beforeSignature,
            expectedSignature: undo
              ? safePersistentLayoutSignature(undo.snapshot.workspaces)
              : undefined,
            actualSignature: safePersistentLayoutSignature(useWorkspaceListStore.getState().workspaces),
            errors: [undoResult.reason],
          }, operationToken);
        } finally {
          const runtime = useGroupingRuntimeStore.getState();
          operationEndedByPoison = runtime.poisoned && runtime.operation === null;
        }
      }
      return undoResult;
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (token && !operationEndedByPoison) {
      try {
        endGroupingOperation(token);
      } catch (error) {
        if (primaryError === undefined) primaryError = error;
      }
    }
  }
  if (primaryError !== undefined) {
    return layoutReverted ? postUndoFailure(primaryError, false) : undoBoundaryFailure(primaryError);
  }
  if (!result) return undoBoundaryFailure(new Error("grouping undo did not produce a result"));
  if (result.ok) {
    try {
      requestCurrentLayoutPersistence();
    } catch (error) {
      return postUndoFailure(error);
    }
  }
  return result;
}

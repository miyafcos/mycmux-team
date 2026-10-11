import { create } from "zustand";

import { structuralUndoSignature, type GroupingStateSnapshot, type Sha256 } from "../components/layout/tabGroupingEngine";
import { PersistentLayoutValidationError } from "../lib/persistentLayoutProjection";
import type { PersistOutcome } from "../lib/workspacePersistenceCoordinator";
import { useUiStore } from "./uiStore";
import { useWorkspaceListStore } from "./workspaceListStore";

export const CURRENT_PERSISTENT_SCHEMA_VERSION = 1 as const;
export const GROUPING_RUNTIME_SCHEMA_VERSION = 1 as const;

export type LayoutMutationSource =
  | "workspace-action"
  | "grouping-commit"
  | "grouping-rollback"
  | "grouping-undo"
  | "restore"
  | "metadata";

export interface GroupingPoisonDiagnostic {
  code: "rollback_failed";
  occurredAt: number;
  layoutRevision: number;
  operation: "commit" | "rollback" | "undo";
  beforeSignature?: Sha256;
  expectedSignature?: Sha256;
  actualSignature?: Sha256;
  errors: string[];
}

export interface GroupingUndoReportSummary {
  movedTabCount: number;
  affectedWorkspaceIds: string[];
  emptyWorkspaceIds: string[];
  appliedAt: number;
}

export interface GroupingUndoRecord {
  recordId: string;
  schemaVersion: 1;
  snapshot: GroupingStateSnapshot;
  report: GroupingUndoReportSummary;
  appliedLayoutSignature: Sha256;
  expectedStructuralSignature: Sha256;
  committedLayoutRevision: number;
  createdAt: number;
  status: "available" | "expired";
  expireReason: string | null;
}

export interface GroupingUndoRepository {
  get(): GroupingUndoRecord | null;
  set(record: GroupingUndoRecord): void;
  expire(reason: string): void;
  clear(): void;
}

export interface GroupingRuntimeState {
  boundaryToken: object;
  schemaVersion: typeof GROUPING_RUNTIME_SCHEMA_VERSION;
  persistentSchema: {
    loadedSchemaVersion: number | null;
    migrationComplete: boolean;
    schemaEpoch: number;
  };
  transitionDepth: number;
  transitionEpoch: number;
  transitionSource: LayoutMutationSource | null;
  transitionFrames: readonly symbol[];
  operation: null | { kind: "commit" | "undo"; token: symbol };
  poisoned: boolean;
  diagnostic: GroupingPoisonDiagnostic | null;
  undo: GroupingUndoRecord | null;
  focusIntent: GroupingPostTransitionFocusIntent | null;
  durability:
    | { status: "idle" }
    | {
        status: "pending";
        requestId: string;
        layoutRevision: number;
        signature: Sha256;
        snapshotDigest: Sha256;
        leaderGeneration: number;
      }
    | {
        status: "saved";
        requestId: string;
        layoutRevision: number;
        signature: Sha256;
        snapshotDigest: Sha256;
        leaderGeneration: number;
      }
    | {
        status: "deferred";
        requestId: string;
        layoutRevision: number;
        signature: Sha256;
        snapshotDigest: Sha256;
        leaderGeneration: number;
        reason: "not_leader" | "leader_unavailable";
      }
    | {
        status: "failed";
        requestId: string;
        layoutRevision: number;
        signature: Sha256;
        snapshotDigest: Sha256;
        leaderGeneration: number;
        errorCode: "ack_mismatch" | "persistence_failed";
        retryScheduled: boolean;
        failureGeneration: number | null;
      };
}

export interface GroupingPostTransitionFocusIntent {
  intentSequence: number;
  transitionEpoch: number;
  activeSessionId: string | null;
}

const WORKSPACE_STORE_BOUNDARY_TOKEN = Object.freeze({});
const UNDO_EXPIRED_REASON = "その後レイアウトが変更されたため元に戻せません";

const initialRuntimeState = (): GroupingRuntimeState => ({
  boundaryToken: WORKSPACE_STORE_BOUNDARY_TOKEN,
  schemaVersion: GROUPING_RUNTIME_SCHEMA_VERSION,
  persistentSchema: {
    loadedSchemaVersion: null,
    migrationComplete: false,
    schemaEpoch: 0,
  },
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
});

export const useGroupingRuntimeStore = create<GroupingRuntimeState>(() => initialRuntimeState());

let uninstallUndoInvalidationWatcher: (() => void) | null = null;
let deferredUndoInvalidation = false;
let durabilityRequestSequence = 0;
let focusIntentSequence = 0;
let focusIntentPending = false;
const focusIntentListeners = new Set<(intent: GroupingPostTransitionFocusIntent) => void>();
const violatedOperationTokens = new Set<symbol>();

export class GroupingUnavailableError extends Error {
  readonly kind = "schema_incompatible" as const;

  constructor() {
    super("永続データのschemaが未確認または非対応のため、タブ再配置を利用できません");
    this.name = "GroupingUnavailableError";
  }
}

export interface PersistentSchemaState {
  loadedSchemaVersion: number | null;
  migrationComplete: boolean;
}

export interface GroupingSchemaStamp {
  schemaVersion: typeof GROUPING_RUNTIME_SCHEMA_VERSION;
  schemaEpoch: number;
}

export function recordPersistentSchemaState(input: PersistentSchemaState): void {
  useGroupingRuntimeStore.setState((state) => ({
    persistentSchema: {
      loadedSchemaVersion: input.loadedSchemaVersion,
      migrationComplete: input.migrationComplete,
      schemaEpoch: state.persistentSchema.schemaEpoch + 1,
    },
  }));
}

export function captureGroupingSchemaStamp(): GroupingSchemaStamp {
  const runtime = useGroupingRuntimeStore.getState();
  assertGroupingSchemaCompatible();
  return Object.freeze({
    schemaVersion: runtime.schemaVersion,
    schemaEpoch: runtime.persistentSchema.schemaEpoch,
  });
}

export function assertGroupingSchemaCompatible(input: {
  ticketSchemaVersion?: number;
  ticketSchemaEpoch?: number;
  snapshotSchemaVersion?: number;
  undoSchemaVersion?: number;
} = {}): void {
  const runtime = useGroupingRuntimeStore.getState();
  const suppliedVersions = (["ticketSchemaVersion", "snapshotSchemaVersion", "undoSchemaVersion"] as const)
    .filter((key) => Object.prototype.hasOwnProperty.call(input, key))
    .map((key) => input[key]);
  if (runtime.schemaVersion !== GROUPING_RUNTIME_SCHEMA_VERSION
    || runtime.persistentSchema.loadedSchemaVersion !== CURRENT_PERSISTENT_SCHEMA_VERSION
    || !runtime.persistentSchema.migrationComplete
    || (Object.prototype.hasOwnProperty.call(input, "ticketSchemaEpoch")
      && input.ticketSchemaEpoch !== runtime.persistentSchema.schemaEpoch)
    || suppliedVersions.some((version) => version !== GROUPING_RUNTIME_SCHEMA_VERSION)) {
    throw new GroupingUnavailableError();
  }
}

export function markDurabilityPending(
  layoutRevision: number,
  signature: Sha256,
  snapshotDigest: Sha256,
  leaderGeneration: number,
): void {
  durabilityRequestSequence += 1;
  useGroupingRuntimeStore.setState({
    durability: {
      status: "pending",
      requestId: `grouping-persist-${durabilityRequestSequence}`,
      layoutRevision,
      signature,
      snapshotDigest,
      leaderGeneration,
    },
  });
}

export function recordPersistOutcome(outcome: PersistOutcome): void {
  useGroupingRuntimeStore.setState((state) => {
    const pending = state.durability;
    if (pending.status !== "pending" || pending.requestId !== outcome.requestId) return state;
    if (outcome.status === "saved") {
      if (outcome.savedRevision !== pending.layoutRevision
        || outcome.savedSignature !== pending.signature
        || outcome.savedDigest !== pending.snapshotDigest
        || outcome.leaderGeneration !== pending.leaderGeneration) {
        return {
          durability: {
            status: "failed",
            requestId: pending.requestId,
            layoutRevision: pending.layoutRevision,
            signature: pending.signature,
            snapshotDigest: pending.snapshotDigest,
            leaderGeneration: pending.leaderGeneration,
            errorCode: "ack_mismatch",
            retryScheduled: false,
            failureGeneration: null,
          },
        };
      }
      return {
        durability: {
          status: "saved",
          requestId: pending.requestId,
          layoutRevision: pending.layoutRevision,
          signature: pending.signature,
          snapshotDigest: pending.snapshotDigest,
          leaderGeneration: pending.leaderGeneration,
        },
      };
    }
    if (outcome.status === "deferred") {
      return {
        durability: {
          status: "deferred",
          requestId: pending.requestId,
          layoutRevision: pending.layoutRevision,
          signature: pending.signature,
          snapshotDigest: pending.snapshotDigest,
          leaderGeneration: pending.leaderGeneration,
          reason: outcome.reason === "leader_changed" ? "leader_unavailable" : outcome.reason,
        },
      };
    }
    return {
      durability: {
        status: "failed",
        requestId: pending.requestId,
        layoutRevision: pending.layoutRevision,
        signature: pending.signature,
        snapshotDigest: pending.snapshotDigest,
        leaderGeneration: pending.leaderGeneration,
        errorCode: "persistence_failed",
        retryScheduled: outcome.retryScheduled,
        failureGeneration: outcome.failureGeneration,
      },
    };
  });
}

export interface PersistenceRetrySuccess {
  failureGeneration: number;
  savedRevision: number;
  savedSignature: Sha256;
  savedDigest: Sha256;
  leaderGeneration: number;
}

export function recordPersistenceRetrySuccess(success: PersistenceRetrySuccess): void {
  useGroupingRuntimeStore.setState((state) => {
    const failedDurability = state.durability;
    if (failedDurability.status !== "failed"
      || failedDurability.errorCode !== "persistence_failed"
      || failedDurability.failureGeneration !== success.failureGeneration
      || failedDurability.layoutRevision !== success.savedRevision
      || failedDurability.signature !== success.savedSignature
      || failedDurability.snapshotDigest !== success.savedDigest
      || failedDurability.leaderGeneration !== success.leaderGeneration) return state;
    return {
      durability: {
        status: "saved",
        requestId: failedDurability.requestId,
        layoutRevision: failedDurability.layoutRevision,
        signature: failedDurability.signature,
        snapshotDigest: failedDurability.snapshotDigest,
        leaderGeneration: failedDurability.leaderGeneration,
      },
    };
  });
}

/** A full current-world save makes an older failed grouping snapshot obsolete. */
export function recordPersistenceRetrySuperseded(failureGeneration: number): void {
  useGroupingRuntimeStore.setState((state) => {
    const failedDurability = state.durability;
    if (failedDurability.status !== "failed"
      || failedDurability.errorCode !== "persistence_failed"
      || failedDurability.failureGeneration !== failureGeneration) return state;
    return {
      durability: {
        status: "saved",
        requestId: failedDurability.requestId,
        layoutRevision: failedDurability.layoutRevision,
        signature: failedDurability.signature,
        snapshotDigest: failedDurability.snapshotDigest,
        leaderGeneration: failedDurability.leaderGeneration,
      },
    };
  });
}

export function subscribeGroupingFocusIntents(
  listener: (intent: GroupingPostTransitionFocusIntent) => void,
): () => void {
  focusIntentListeners.add(listener);
  return () => focusIntentListeners.delete(listener);
}

function flushGroupingFocusIntent(): void {
  const runtime = useGroupingRuntimeStore.getState();
  if (!focusIntentPending || runtime.transitionDepth !== 0 || runtime.operation !== null) return;
  focusIntentPending = false;
  focusIntentSequence += 1;
  const intent: GroupingPostTransitionFocusIntent = Object.freeze({
    intentSequence: focusIntentSequence,
    transitionEpoch: runtime.transitionEpoch,
    activeSessionId: useUiStore.getState().activePaneId,
  });
  try {
    useGroupingRuntimeStore.setState({ focusIntent: intent });
  } catch {
    // Focus coordination is post-transaction and must never roll back layout.
  }
  for (const listener of focusIntentListeners) {
    try {
      listener(intent);
    } catch {
      // A focus executor failure must not suppress other coordinators or layout state.
    }
  }
}

export function uninstallGroupingUndoInvalidationWatcher(): void {
  uninstallUndoInvalidationWatcher?.();
  uninstallUndoInvalidationWatcher = null;
  deferredUndoInvalidation = false;
}

function cloneAndDeepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    cloneAndDeepFreeze((objectValue as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function storedUndoRecord(record: GroupingUndoRecord): GroupingUndoRecord {
  return cloneAndDeepFreeze(structuredClone(record));
}

function evaluateUndoInvalidation(): void {
  deferredUndoInvalidation = false;
  const undo = useGroupingRuntimeStore.getState().undo;
  if (!undo || undo.status !== "available") return;
  let currentSignature: Sha256;
  try {
    currentSignature = structuralUndoSignature(useWorkspaceListStore.getState().workspaces);
  } catch (error) {
    if (!(error instanceof PersistentLayoutValidationError)) throw error;
    console.warn(`[groupingRuntimeStore] ${error.message}`);
    return;
  }
  if (currentSignature !== undo.expectedStructuralSignature) {
    groupingUndoRepository.expire(UNDO_EXPIRED_REASON);
  }
}

function synchronizeUndoInvalidationWatcher(): void {
  const undo = useGroupingRuntimeStore.getState().undo;
  if (undo?.status === "available") {
    installGroupingUndoInvalidationWatcher();
  } else {
    uninstallGroupingUndoInvalidationWatcher();
  }
}

function updateStoredUndo(next: GroupingUndoRecord | null): void {
  const previous = useGroupingRuntimeStore.getState().undo;
  try {
    useGroupingRuntimeStore.setState({ undo: next });
  } catch (error) {
    try {
      useGroupingRuntimeStore.setState({ undo: previous });
    } catch {
      // Zustand assigns state before notifying, so verify the exact old reference below.
    }
    if (useGroupingRuntimeStore.getState().undo !== previous) {
      try {
        poisonGroupingBoundary({
          code: "rollback_failed",
          occurredAt: Date.now(),
          layoutRevision: useWorkspaceListStore.getState().layoutRevision,
          operation: "rollback",
          errors: ["undo repository notification rollback failed"],
        });
      } catch {
        uninstallGroupingUndoInvalidationWatcher();
      }
    } else {
      synchronizeUndoInvalidationWatcher();
    }
    throw error;
  }
  synchronizeUndoInvalidationWatcher();
}

export function installGroupingUndoInvalidationWatcher(): void {
  if (uninstallUndoInvalidationWatcher) return;
  uninstallUndoInvalidationWatcher = useWorkspaceListStore.subscribe((state, previous) => {
    if (state.layoutRevision === previous.layoutRevision) return;
    if (useGroupingRuntimeStore.getState().transitionDepth > 0) {
      deferredUndoInvalidation = true;
      return;
    }
    evaluateUndoInvalidation();
  });
}

export const groupingUndoRepository: GroupingUndoRepository = {
  get: () => {
    const undo = useGroupingRuntimeStore.getState().undo;
    return undo ? structuredClone(undo) : null;
  },
  set: (record) => {
    updateStoredUndo(storedUndoRecord(record));
  },
  expire: (reason) => {
    const undo = useGroupingRuntimeStore.getState().undo;
    if (!undo) return;
    updateStoredUndo(storedUndoRecord({
      ...undo,
      status: "expired",
      expireReason: reason,
    }));
  },
  clear: () => {
    updateStoredUndo(null);
  },
};

type SynchronousTransitionCallback<F extends () => unknown> = F & (
  ReturnType<F> extends { readonly then: unknown } ? never : unknown
);

function popExactTransitionFrame(frame: symbol): void {
  useGroupingRuntimeStore.setState((state) => {
    if (state.transitionFrames[state.transitionFrames.length - 1] !== frame) {
      throw new Error("layout transition frame mismatch");
    }
    const transitionFrames = state.transitionFrames.slice(0, -1);
    const transitionDepth = transitionFrames.length;
    return {
      transitionDepth,
      transitionFrames,
      transitionSource: transitionDepth === 0 ? null : state.transitionSource,
      transitionEpoch: transitionDepth === 0
        ? state.transitionEpoch + 1
        : state.transitionEpoch,
    };
  });
}

function compensateTransitionEnter(frame: symbol): void {
  try {
    const frames = useGroupingRuntimeStore.getState().transitionFrames;
    if (frames[frames.length - 1] === frame) {
      popExactTransitionFrame(frame);
    }
  } catch {
    // Compensation must never replace the notification error that caused it.
  }
}

export function runLayoutTransition<F extends () => unknown>(
  source: LayoutMutationSource,
  fn: SynchronousTransitionCallback<F>,
): ReturnType<F> {
  const frame = Symbol(source);
  try {
    useGroupingRuntimeStore.setState((state) => ({
      transitionDepth: state.transitionDepth + 1,
      transitionSource: state.transitionSource ?? source,
      transitionFrames: [...state.transitionFrames, frame],
    }));
  } catch (error) {
    compensateTransitionEnter(frame);
    throw error;
  }

  let value: ReturnType<F> | undefined;
  let primaryError: unknown;
  let failed = false;
  try {
    value = fn() as ReturnType<F>;
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      if (typeof (value as { then?: unknown }).then === "function") {
        throw new TypeError("layout transition callback must be synchronous; Promise/thenable returned");
      }
    }
  } catch (error) {
    failed = true;
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    popExactTransitionFrame(frame);
    if (useGroupingRuntimeStore.getState().transitionDepth === 0
      && (source === "grouping-commit" || source === "grouping-rollback" || source === "grouping-undo")) {
      focusIntentPending = true;
    }
  } catch (error) {
    cleanupError = error;
    compensateTransitionEnter(frame);
  }
  let invalidationError: unknown;
  if (useGroupingRuntimeStore.getState().transitionDepth === 0 && deferredUndoInvalidation) {
    try {
      evaluateUndoInvalidation();
    } catch (error) {
      invalidationError = error;
    }
  }
  if (failed) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  if (invalidationError !== undefined) throw invalidationError;
  flushGroupingFocusIntent();
  return value as ReturnType<F>;
}

export function tryBeginGroupingOperation(kind: "commit" | "undo"): symbol | null {
  const token = Symbol(kind);
  let acquired = false;
  try {
    useGroupingRuntimeStore.setState((state) => {
      if (state.poisoned || state.operation !== null) return state;
      acquired = true;
      return { operation: { kind, token } };
    });
  } catch (error) {
    try {
      useGroupingRuntimeStore.setState((state) => (
        state.operation?.token === token ? { operation: null } : state
      ));
    } catch {
      // Exact-token compensation must not replace the acquire notification error.
    }
    violatedOperationTokens.delete(token);
    throw error;
  }
  return acquired ? token : null;
}

export function endGroupingOperation(token: symbol): void {
  try {
    useGroupingRuntimeStore.setState((state) => {
      if (state.operation?.token !== token) {
        throw new Error("grouping operation token mismatch");
      }
      return { operation: null };
    });
  } finally {
    violatedOperationTokens.delete(token);
    flushGroupingFocusIntent();
  }
}

export function hasGroupingOperationViolation(token: symbol): boolean {
  return violatedOperationTokens.has(token);
}

export function poisonGroupingBoundary(
  diagnostic: GroupingPoisonDiagnostic,
  operationToken?: symbol,
): void {
  try {
    useGroupingRuntimeStore.setState((state) => {
      if (operationToken && state.operation?.token !== operationToken) {
        throw new Error("grouping operation token mismatch");
      }
      return {
        poisoned: true,
        diagnostic: structuredClone(diagnostic),
        undo: null,
        operation: null,
      };
    });
  } finally {
    uninstallGroupingUndoInvalidationWatcher();
    flushGroupingFocusIntent();
  }
}

export function assertSideEffectAllowed(name: string): void {
  if (useGroupingRuntimeStore.getState().transitionDepth > 0) {
    throw new Error(`${name} ran during layout transition`);
  }
}

export function assertExternalLayoutMutationAllowed(
  source: LayoutMutationSource,
  authorizedInternalMutation = false,
): void {
  if (authorizedInternalMutation) return;
  const runtime = useGroupingRuntimeStore.getState();
  if (runtime.operation) violatedOperationTokens.add(runtime.operation.token);
  if (runtime.operation !== null
    || runtime.transitionDepth > 0
    || source === "grouping-commit"
    || source === "grouping-rollback"
    || source === "grouping-undo") {
    throw new Error("layout mutation rejected during grouping transition by boundary capability");
  }
}

export function __resetGroupingRuntimeForTests(): void {
  // Engine poison latches live in the engine module; tests that need a clean
  // engine boundary must reload the module graph as well.
  uninstallGroupingUndoInvalidationWatcher();
  durabilityRequestSequence = 0;
  focusIntentSequence = 0;
  focusIntentPending = false;
  focusIntentListeners.clear();
  violatedOperationTokens.clear();
  useGroupingRuntimeStore.setState(initialRuntimeState(), true);
}

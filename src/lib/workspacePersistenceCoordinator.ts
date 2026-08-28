import {
  hashCanonical,
  type PersistentLayoutProjection,
  type Sha256,
} from "./persistentLayoutProjection";
import {
  assertSideEffectAllowed,
  useGroupingRuntimeStore,
} from "../stores/groupingRuntimeStore";
import { nonRetryablePersistentStorageError } from "./ipc";

export interface PersistRequest {
  requestId: string;
  revision: number;
  signature: Sha256;
  snapshot: Readonly<PersistentLayoutProjection>;
  snapshotDigest: Sha256;
  leaderGeneration: number;
}

export type PersistRequestDraft = Omit<PersistRequest, "leaderGeneration">;

export interface PersistAck {
  requestId: string;
  savedRevision: number;
  savedSignature: Sha256;
  savedDigest: Sha256;
  leaderGeneration: number;
}

export type PersistOutcome =
  | ({ status: "saved" } & PersistAck)
  | {
      status: "deferred";
      requestId: string;
      reason: "not_leader" | "leader_unavailable" | "leader_changed";
    }
  | {
      status: "failed";
      requestId: string;
      error: string;
      retryScheduled: boolean;
      failureGeneration: number;
    };

export interface PersistenceLeaderHandler {
  windowId: string;
  persist: (request: PersistRequest) => Promise<PersistOutcome>;
}

export interface PersistenceLeaderDriver {
  isLeader: () => boolean;
  sync: (request: PersistRequest) => Promise<PersistAck | null>;
  failure: () => { error: string; retryScheduled: boolean; failureGeneration: number };
}

export type PersistentSchemaState =
  | { status: "pending" }
  | { status: "supported"; schemaVersion: number }
  | {
      status: "quarantined";
      reason: "unsupportedSchema" | "unsupportedPlatform" | "invalidPayloadSchema" | "hydrationFailed" | "groupingPoisoned";
      schemaVersion?: number;
      diagnostic: string;
      requiresUnsavedConfirmation: boolean;
    };

let persistentSchemaState: PersistentSchemaState = { status: "pending" };
const persistentSchemaListeners = new Set<(state: PersistentSchemaState) => void>();

function publishPersistentSchemaState(state: PersistentSchemaState): void {
  persistentSchemaState = state;
  for (const listener of persistentSchemaListeners) listener(state);
}

export function getPersistentSchemaState(): PersistentSchemaState {
  return { ...persistentSchemaState };
}

export function isPersistenceWriteAllowed(): boolean {
  return persistentSchemaState.status === "supported"
    && !useGroupingRuntimeStore.getState().poisoned;
}

export function markPersistentSchemaSupported(schemaVersion: number): void {
  if (persistentSchemaState.status !== "pending") return;
  publishPersistentSchemaState({ status: "supported", schemaVersion });
}

export function quarantinePersistentWrites(
  quarantine: Omit<Extract<PersistentSchemaState, { status: "quarantined" }>, "status">,
): boolean {
  if (persistentSchemaState.status === "quarantined") return false;
  publishPersistentSchemaState({ status: "quarantined", ...quarantine });
  return true;
}

const GROUPING_POISON_PERSISTENCE_DIAGNOSTIC = "レイアウトは保存されません。再起動で最後の正常状態に戻ります";

function quarantineGroupingPoisonPersistence(): void {
  if (persistentSchemaState.status === "quarantined") {
    if (!persistentSchemaState.requiresUnsavedConfirmation) {
      publishPersistentSchemaState({
        ...persistentSchemaState,
        requiresUnsavedConfirmation: true,
      });
    }
    return;
  }
  quarantinePersistentWrites({
    reason: "groupingPoisoned",
    diagnostic: GROUPING_POISON_PERSISTENCE_DIAGNOSTIC,
    requiresUnsavedConfirmation: true,
  });
}

const unsubscribeGroupingPoisonPersistence = useGroupingRuntimeStore.subscribe((state, previous) => {
  if (!previous.poisoned && state.poisoned) quarantineGroupingPoisonPersistence();
});
if (useGroupingRuntimeStore.getState().poisoned) quarantineGroupingPoisonPersistence();
if (import.meta.hot) import.meta.hot.dispose(unsubscribeGroupingPoisonPersistence);

export function quarantineTerminalPersistentStorageError(error: unknown): string | null {
  const terminal = nonRetryablePersistentStorageError(error);
  if (!terminal) return null;
  const diagnostic = terminal.kind === "unsupportedSchema"
    ? `対応していない保存データ（schema ${terminal.schemaVersion}）を検出したため、この起動中は保存を停止しました。元の data.json は変更していません。`
    : terminal.kind === "unsupportedPlatform"
      ? "この環境では data.json を安全に保存できないため、この起動中は保存を停止しました。元の data.json は変更していません。"
      : `保存しようとした data.json の schema ${terminal.schemaVersion} が現在の形式と一致しないため、この起動中は保存を停止しました。元の data.json は変更していません。`;
  quarantinePersistentWrites({
    reason: terminal.kind,
    schemaVersion: terminal.kind === "unsupportedPlatform" ? undefined : terminal.schemaVersion,
    diagnostic,
    requiresUnsavedConfirmation: true,
  });
  const state = getPersistentSchemaState();
  return state.status === "quarantined" ? state.diagnostic : diagnostic;
}

export function quarantinePersistentSchema(schemaVersion: number, diagnostic?: string): boolean {
  return quarantinePersistentWrites({
    reason: "unsupportedSchema",
    schemaVersion,
    diagnostic: diagnostic ?? `unsupported persistent schema ${schemaVersion}`,
    requiresUnsavedConfirmation: true,
  });
}

export function subscribePersistentSchemaState(
  listener: (state: PersistentSchemaState) => void,
): () => void {
  persistentSchemaListeners.add(listener);
  return () => persistentSchemaListeners.delete(listener);
}

function persistenceBlocked(requestId: string): PersistOutcome {
  const error = persistentSchemaState.status === "quarantined"
    ? persistentSchemaState.diagnostic
    : "persistent schema validation is pending";
  return { status: "failed", requestId, error, retryScheduled: false, failureGeneration: 0 };
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

export function capturePersistRequestSnapshot(snapshot: PersistentLayoutProjection): {
  snapshot: Readonly<PersistentLayoutProjection>;
  snapshotDigest: Sha256;
} {
  const immutableSnapshot = cloneAndDeepFreeze(structuredClone(snapshot));
  return {
    snapshot: immutableSnapshot,
    snapshotDigest: hashCanonical(immutableSnapshot),
  };
}

function acknowledgementMatches(request: PersistRequest, ack: PersistAck): boolean {
  return ack.requestId === request.requestId
    && ack.savedRevision === request.revision
    && ack.savedSignature === request.signature
    && ack.savedDigest === request.snapshotDigest
    && ack.leaderGeneration === request.leaderGeneration;
}

export function createPersistenceLeaderPersist(
  driver: PersistenceLeaderDriver,
): PersistenceLeaderHandler["persist"] {
  return async (request) => {
    if (!isPersistenceWriteAllowed()) return persistenceBlocked(request.requestId);
    if (!driver.isLeader()) {
      return {
        status: "deferred",
        requestId: request.requestId,
        reason: "not_leader",
      };
    }
    const ack = await driver.sync(request);
    if (!driver.isLeader()) {
      return {
        status: "deferred",
        requestId: request.requestId,
        reason: "not_leader",
      };
    }
    if (ack) return { status: "saved", ...ack };
    const failure = driver.failure();
    return {
      status: "failed",
      requestId: request.requestId,
      error: failure.error,
      retryScheduled: failure.retryScheduled,
      failureGeneration: failure.failureGeneration,
    };
  };
}

interface RegisteredLeader {
  token: object;
  generation: number;
  handler: PersistenceLeaderHandler;
  tail: Promise<void> | null;
}

let registeredLeader: RegisteredLeader | null = null;
let leaderRegistrationGeneration = 0;

export function registerPersistenceLeader(handler: PersistenceLeaderHandler): () => void {
  leaderRegistrationGeneration += 1;
  const registration: RegisteredLeader = {
    token: Object.freeze({}),
    generation: leaderRegistrationGeneration,
    handler,
    tail: null,
  };
  registeredLeader = registration;
  return () => {
    if (registeredLeader?.token === registration.token) registeredLeader = null;
  };
}

export function currentPersistenceLeaderGeneration(): number {
  return registeredLeader?.generation ?? 0;
}

function leaderChanged(leader: RegisteredLeader): boolean {
  return registeredLeader?.token !== leader.token
    || registeredLeader.generation !== leader.generation;
}

function failed(requestId: string, error: string): PersistOutcome {
  return { status: "failed", requestId, error, retryScheduled: false, failureGeneration: 0 };
}

export async function requestImmediatePersist(draft: PersistRequestDraft): Promise<PersistOutcome> {
  const leader = registeredLeader;
  if (!leader) {
    return {
      status: "deferred",
      requestId: draft.requestId,
      reason: "leader_unavailable",
    };
  }
  if (!isPersistenceWriteAllowed()) return persistenceBlocked(draft.requestId);
  const captured = capturePersistRequestSnapshot(draft.snapshot as PersistentLayoutProjection);
  if (captured.snapshotDigest !== draft.snapshotDigest) {
    return failed(draft.requestId, "persistence snapshot digest mismatch");
  }
  const request = cloneAndDeepFreeze({
    ...draft,
    ...captured,
    leaderGeneration: leader.generation,
  });
  const execute = async (): Promise<PersistOutcome> => {
    if (leaderChanged(leader)) {
      return { status: "deferred", requestId: request.requestId, reason: "leader_changed" };
    }
    let outcome: PersistOutcome;
    try {
      outcome = await leader.handler.persist(request);
    } catch (error) {
      outcome = failed(request.requestId, error instanceof Error ? error.message : String(error));
    }
    if (leaderChanged(leader)) {
      return { status: "deferred", requestId: request.requestId, reason: "leader_changed" };
    }
    if (outcome.status === "saved" && !acknowledgementMatches(request, outcome)) {
      return failed(request.requestId, "persistence acknowledgement mismatch");
    }
    return outcome;
  };
  const outcome = leader.tail ? leader.tail.then(execute, execute) : execute();
  const tail = outcome.then(() => undefined, () => undefined);
  leader.tail = tail;
  void tail.finally(() => {
    if (leader.tail === tail) leader.tail = null;
  });
  return outcome;
}

export interface TransitionAwareAutosaveGate {
  request(): void;
  dispose(): void;
}

export function createTransitionAwareAutosaveGate(schedule: () => void): TransitionAwareAutosaveGate {
  let deferred = false;
  const runOrDefer = () => {
    if (!isPersistenceWriteAllowed()) {
      deferred = persistentSchemaState.status === "pending";
      return;
    }
    if (useGroupingRuntimeStore.getState().transitionDepth > 0) {
      deferred = true;
      return;
    }
    deferred = false;
    assertSideEffectAllowed("autosave");
    schedule();
  };
  const unsubscribe = useGroupingRuntimeStore.subscribe((state, previous) => {
    if (previous.transitionDepth > 0 && state.transitionDepth === 0 && deferred) runOrDefer();
  });
  const unsubscribeSchema = subscribePersistentSchemaState((state) => {
    if (state.status === "supported" && deferred) runOrDefer();
    if (state.status === "quarantined") deferred = false;
  });
  return {
    request: runOrDefer,
    dispose: () => {
      unsubscribe();
      unsubscribeSchema();
    },
  };
}

export function __resetPersistenceCoordinatorForTests(): void {
  registeredLeader = null;
  leaderRegistrationGeneration = 0;
  persistentSchemaState = { status: "pending" };
  persistentSchemaListeners.clear();
}

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { useWorkspaceListStore } from "./workspaceListStore";
import { trustedLiveTailAttentionKey, trustedLiveTailStatus } from "../lib/liveTail/status";
import { hasWorkingScreenEvidence } from "../lib/agentDormancy";
import { isolateSubscribers } from "../lib/isolatedStoreListeners";
import { TERMINAL_IPC_TIMEOUT_MS } from "../lib/terminalDeadline";
import { currentPtyRead, ptyReadGeneration, ptyReadRevision, replacePtyReadOwners, retainPtyReads, subscribePtyReads, type PtyReadGeneration } from "../lib/ptyReadGeneration";
import { cropLiveTailScreen, unreadableLiveTail } from "../lib/liveTail/crop";
import { advanceLiveTailEvidence, factForLiveTailEvidence, type LiveTailEvidence, type LiveTailFact, type LiveTailObservation } from "../lib/liveTail/facts";

export const LIVE_TAIL_INTERVAL_MS = 2_000;
export const LIVE_TAIL_API_LEASE_MS = 10_000;
export const LIVE_TAIL_READ_TIMEOUT_MS = 1_500;
export const LIVE_TAIL_HISTORY_LIMIT = 128;
export const LIVE_TAIL_SCREEN_LINES = 40;
export const LIVE_TAIL_MAX_READS_PER_TICK = 12;
export const LIVE_TAIL_MAX_CONCURRENT_READS = 2;

export interface LiveTailTarget {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  paneId: string;
  tabId: string;
  name: string;
  agentKind: string | null;
  status: "working" | "waiting" | "idle" | "unknown";
  waitingForReply: boolean;
}

export interface LiveTailEntry {
  history: LiveTailObservation[];
  evidence: LiveTailEvidence;
  screenWorking: boolean;
  /** A previous screen keeps its original observation time while being reused. */
  retained?: boolean;
  readPending?: boolean;
  readFailures?: number;
  lastAttemptAt?: number;
  /** Attention captured before acquisition; never certify a screen with later state. */
  attentionKey?: string | null;
  /** At most one exceptional-screen revalidation per accepted attention value. */
  revalidationKey?: string | null;
}

export interface LiveTailState {
  targets: LiveTailTarget[];
  entries: Record<string, LiveTailEntry>;
}

export interface LiveTailTab extends Omit<LiveTailTarget, "status"> {
  fact: LiveTailFact;
  rows: string[];
  lastOutputAt: number | null;
  readable: boolean;
  observedAt: number;
}

export interface LiveTailsResponse { generatedAt: number; tabs: LiveTailTab[] }

interface LiveTailDependencies {
  listTargets: () => Promise<LiveTailTarget[]>;
  readTail: (sessionId: string, lines: number, isCurrent: () => boolean) => Promise<string[]>;
  loadOutputs: () => Promise<Record<string, number | null>>;
  /** Sidebars read only tabs owned by their WebView; API demand remains global. */
  ownsSidebarTarget?: (target: LiveTailTarget) => boolean;
}

export function liveTailAttentionChanged(target: LiveTailTarget, entry?: LiveTailEntry): boolean {
  return Boolean(entry?.evidence.observations && entry.attentionKey !== undefined
    && entry.attentionKey !== trustedLiveTailAttentionKey(target.sessionId));
}

function exceptional(entry?: LiveTailEntry): boolean {
  return Boolean(entry?.evidence.observations && (!entry.evidence.observation.crop.readable
    || entry.evidence.observation.crop.state === "error"));
}

function needsRevalidation(target: LiveTailTarget, entry?: LiveTailEntry): boolean {
  return exceptional(entry) && liveTailAttentionChanged(target, entry)
    && entry?.revalidationKey !== trustedLiveTailAttentionKey(target.sessionId);
}

function shouldRead(target: LiveTailTarget, entry?: LiveTailEntry): boolean {
  return statusForLiveTailTarget(target) !== "idle" || needsRevalidation(target, entry);
}

export function liveTailScreenRetained(target: LiveTailTarget, entry?: LiveTailEntry): boolean {
  return Boolean(entry?.evidence.observations && (entry.retained || liveTailAttentionChanged(target, entry)));
}

export function statusForLiveTailTarget(target: LiveTailTarget): LiveTailTarget["status"] {
  return trustedLiveTailStatus(target.sessionId) ?? (target.waitingForReply ? "waiting" : target.status);
}

export function factForLiveTailTarget(target: LiveTailTarget, entry?: LiveTailEntry): LiveTailFact {
  const status = statusForLiveTailTarget(target);
  const neutral: LiveTailFact = { kind: status === "idle" || status === "waiting" ? "idle" : "alive",
    sinceMs: entry?.evidence.observation.observedAt ?? Date.now(), elapsedSec: null, tokens: null, toolElapsedSec: null, error: null };
  if (!entry || entry.evidence.observations === 0) return neutral;
  if (liveTailAttentionChanged(target, entry)) return neutral;
  const fact = factForLiveTailEvidence(entry.evidence);
  // Acquisition results have precedence over neutral task presentation.
  if (fact.kind === "error" || fact.kind === "unreadable") return fact;
  if (neutral.kind === "idle") return neutral;
  return entry.retained && (fact.kind === "frozen" || fact.kind === "stale") ? neutral : fact;
}

/** One inclusion rule for both views: every discovered live terminal is shown.
 * Ordinary idle is grouped in the sidebar, never omitted from API presentation.
 * Derive precedence here before either view groups targets or selects reads. */
export function liveTailTargetsForView(targets: readonly LiveTailTarget[], entries: Readonly<Record<string, LiveTailEntry>>) {
  return targets.map(target => {
    const entry = entries[target.sessionId], fact = factForLiveTailTarget(target, entry);
    const inputIdle = fact.kind === "idle" && statusForLiveTailTarget(target) !== "waiting"
      && !(exceptional(entry) && liveTailAttentionChanged(target, entry));
    return { target, entry, fact, inputIdle };
  });
}

/** One controller per WebView; nothing polls until there is demand. */
export function createLiveTailController(dependencies: LiveTailDependencies) {
  const store = createStore<LiveTailState>(() => ({ targets: [], entries: {} }));
  isolateSubscribers(store, "liveTail");
  const consumers = new Map<symbol, string>();
  const pendingReads = new Set<string>();
  const identities = new Map<string, { target: LiveTailTarget; revision: symbol }>();
  let recentReadStarts: number[] = [];
  interface Scope { demand: symbol; revision: symbol; pty: PtyReadGeneration; round: symbol }
  const sampleScopes = new Map<string, Scope>();
  const attemptScopes = new Map<string, Scope>();
  const outputSamples = new Map<string, { scope: Scope; at: number; acquiredAt: number }>();
  const catalogOwner = Symbol("live tail catalog");
  let catalogTargets: LiveTailTarget[] = [];
  let demand = Symbol("demand"), demandActive = false;
  let lastScheduledId: string | undefined;
  let pendingTargets = false, pendingOutputs = false;
  let apiUntil = 0, disposed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let lastTickAt: number | null = null;

  const hasDemand = () => !disposed && (consumers.size > 0 || Date.now() < apiUntil);
  function refreshDemand(): void {
    const active = hasDemand();
    if (demandActive && !active) {
      demand = Symbol("demand");
      sampleScopes.clear(); attemptScopes.clear(); outputSamples.clear();
      catalogTargets = []; replacePtyReadOwners(catalogOwner, new Set());
      retainScreens();
    }
    demandActive = active;
  }
  function retainScreens(): void {
    const entries = Object.fromEntries(Object.entries(store.getState().entries).map(([id, entry]) => [id, {
      ...entry, retained: entry.evidence.observations > 0, readPending: false,
      evidence: { ...entry.evidence, observation: { ...entry.evidence.observation, outputFresh: false } },
    }]));
    store.setState({ entries });
  }
  const unsubscribeGeneration = subscribePtyReads((sessionId, retired) => {
    identities.delete(sessionId); sampleScopes.delete(sessionId); attemptScopes.delete(sessionId); outputSamples.delete(sessionId);
    const entries = { ...store.getState().entries }; delete entries[sessionId];
    store.setState({ entries, targets: retired ? store.getState().targets.filter(target => target.sessionId !== sessionId)
      : store.getState().targets.map(target => target.sessionId === sessionId
      ? { ...target, status: "unknown", waitingForReply: false } : target) });
  });
  const wanted = (target: LiveTailTarget) => Date.now() < apiUntil
    || [...consumers.values()].some(name => name !== "sidebar")
    || (consumers.size > 0 && (dependencies.ownsSidebarTarget?.(target) ?? true));

  async function bounded<T>(task: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([task, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("live tail observation timed out")), Math.max(0, deadline - Date.now()));
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  function scopeFor(sessionId: string, round: symbol): Scope | undefined {
    const identity = identities.get(sessionId), pty = ptyReadGeneration(sessionId);
    if (!identity || !currentPtyRead(sessionId, pty)) return undefined;
    return { demand, revision: identity.revision, pty, round };
  }
  function currentTarget(sessionId: string, scope: Scope): LiveTailTarget | undefined {
    refreshDemand();
    const identity = identities.get(sessionId);
    return hasDemand() && scope.demand === demand && identity?.revision === scope.revision
      && currentPtyRead(sessionId, scope.pty) && wanted(identity.target) ? identity.target : undefined;
  }
  function sameScope(a: Scope | undefined, b: Scope): boolean {
    return a?.demand === b.demand && a.revision === b.revision && a.pty === b.pty;
  }

  function emptyObservation(): LiveTailObservation {
    return { observedAt: Date.now(), lastOutputAt: null, rawRows: [], crop: unreadableLiveTail() };
  }

  function pendingEntry(): LiveTailEntry {
    const observation = emptyObservation();
    return { history: [], evidence: { ...advanceLiveTailEvidence(undefined, observation), observations: 0 },
      screenWorking: false, readPending: true, readFailures: 0 };
  }

  function attemptedAt(entry?: LiveTailEntry): number | undefined {
    return entry?.lastAttemptAt ?? (entry?.history.length ? entry.evidence.observation.observedAt : undefined);
  }

  function freshAttempt(sessionId: string, entry?: LiveTailEntry): boolean {
    const scope = attemptScopes.get(sessionId);
    if (!scope || !currentTarget(sessionId, scope)) return false;
    const at = attemptedAt(entry);
    return at !== undefined && Date.now() - at < LIVE_TAIL_INTERVAL_MS;
  }

  function markReading(target: LiveTailTarget, scope: Scope, attentionKey: string | null, revalidation: boolean): void {
    const entries = store.getState().entries;
    const old = entries[target.sessionId];
    const entry: LiveTailEntry = old
      ? { ...old, readPending: true, retained: old.evidence.observations > 0, lastAttemptAt: Date.now(),
        revalidationKey: revalidation ? attentionKey : old.revalidationKey,
        readFailures: sameScope(attemptScopes.get(target.sessionId), scope) ? old.readFailures : 0 }
      : { ...pendingEntry(), lastAttemptAt: Date.now() };
    attemptScopes.set(target.sessionId, scope);
    store.setState({ entries: { ...entries, [target.sessionId]: entry } });
  }

  function acceptScreen(sessionId: string, scope: Scope, rows: string[], attentionKey: string | null): void {
    const target = currentTarget(sessionId, scope);
    if (!target) return;
    const entries = store.getState().entries;
    const old = entries[sessionId];
    const output = outputSamples.get(sessionId);
    const outputFresh = sameScope(output?.scope, scope) && output?.scope.round === scope.round;
    const observation: LiveTailObservation = { observedAt: Date.now(), rawRows: rows,
      crop: cropLiveTailScreen(rows, target.agentKind), outputFresh,
      outputAcquiredAt: outputFresh ? output!.acquiredAt : undefined,
      lastOutputAt: outputFresh ? output!.at : old?.evidence.observation.lastOutputAt ?? null };
    const comparable = sameScope(sampleScopes.get(sessionId), scope);
    sampleScopes.set(sessionId, scope);
    store.setState({ entries: { ...entries, [sessionId]: {
      history: [...(comparable ? old?.history ?? [] : []), observation].slice(-LIVE_TAIL_HISTORY_LIMIT),
      evidence: advanceLiveTailEvidence(comparable ? old?.evidence : undefined, observation),
      screenWorking: hasWorkingScreenEvidence(rows) || observation.crop.state === "working",
      retained: false, readPending: false, readFailures: 0, lastAttemptAt: observation.observedAt,
      attentionKey,
    } } });
    // Current silence claims need an acquisition at/after this screen, not
    // a snapshot aged while fetch/parse was delayed. One actual output request
    // at a time; a pending/failed request conservatively withholds the claim.
    void acquireOutputs(new Map([...sampleScopes].filter(([id, sample]) => Boolean(currentTarget(id, sample)))));
  }

  function failScreen(sessionId: string, scope: Scope, attentionKey: string | null, revalidation: boolean): void {
    if (!currentTarget(sessionId, scope)) return;
    const entries = store.getState().entries;
    const old = entries[sessionId];
    const failures = (old?.readFailures ?? 0) + 1;
    if (!revalidation && old?.evidence.observation.crop.readable && failures < 2) {
      // Reusing an old sample is not a new observation or progress/freeze proof.
      store.setState({ entries: { ...entries, [sessionId]: {
        ...old, retained: true, readPending: false, readFailures: failures, lastAttemptAt: Date.now(),
      } } });
      return;
    }
    const observation = emptyObservation();
    const comparable = sameScope(sampleScopes.get(sessionId), scope);
    sampleScopes.set(sessionId, scope);
    store.setState({ entries: { ...entries, [sessionId]: {
      history: [...(comparable ? old?.history ?? [] : []), observation].slice(-LIVE_TAIL_HISTORY_LIMIT),
      evidence: advanceLiveTailEvidence(comparable ? old?.evidence : undefined, observation), screenWorking: old?.screenWorking ?? false,
      retained: false, readPending: false, readFailures: failures, lastAttemptAt: observation.observedAt,
      attentionKey,
    } } });
  }

  async function readTarget(target: LiveTailTarget, scope: Scope, deadline: number): Promise<void> {
    if (!currentTarget(target.sessionId, scope) || !shouldRead(target, store.getState().entries[target.sessionId])
      || pendingReads.has(target.sessionId)) return;
    const release = retainPtyReads(target.sessionId);
    pendingReads.add(target.sessionId);
    recentReadStarts.push(Date.now());
    const attentionKey = trustedLiveTailAttentionKey(target.sessionId);
    const revalidation = needsRevalidation(target, store.getState().entries[target.sessionId]);
    markReading(target, scope, attentionKey, revalidation);
    // The request owns its actual concurrency slot even past the observation
    // deadline. Its result may still be useful if this identity remains valid.
    const task = Promise.resolve().then(() => currentTarget(target.sessionId, scope)
      ? dependencies.readTail(target.sessionId, LIVE_TAIL_SCREEN_LINES, () => Boolean(currentTarget(target.sessionId, scope))) : undefined)
      .then(rows => { if (rows !== undefined) acceptScreen(target.sessionId, scope, rows, attentionKey); },
        () => failScreen(target.sessionId, scope, attentionKey, revalidation))
      .finally(() => { pendingReads.delete(target.sessionId); release(); });
    try { await bounded(task, deadline); } catch { /* Keep pending and previous screen until the actual task settles. */ }
  }

  function sameIdentity(a: LiveTailTarget, b: LiveTailTarget): boolean {
    return a.workspaceId === b.workspaceId && a.paneId === b.paneId && a.tabId === b.tabId && a.agentKind === b.agentKind;
  }

  function reconcileTargets(targets: LiveTailTarget[]): void {
    const entries = { ...store.getState().entries };
    const ids = new Set(targets.map(target => target.sessionId));
    for (const id of identities.keys()) {
      if (!ids.has(id)) { identities.delete(id); delete entries[id]; sampleScopes.delete(id); attemptScopes.delete(id); outputSamples.delete(id); }
    }
    for (const target of targets) {
      const old = identities.get(target.sessionId);
      if (!old || !sameIdentity(old.target, target)) {
        delete entries[target.sessionId]; sampleScopes.delete(target.sessionId); attemptScopes.delete(target.sessionId); outputSamples.delete(target.sessionId);
        identities.set(target.sessionId, { target: { ...target }, revision: Symbol(target.sessionId) });
      } else identities.set(target.sessionId, { target: { ...target }, revision: old.revision });
      // Presentation includes idle too; its neutral placeholder requests no read.
      if (!entries[target.sessionId]) entries[target.sessionId] = { ...pendingEntry(), readPending: shouldRead(target) };
      const entry = entries[target.sessionId];
      if (entry?.evidence.observations && entry.evidence.observation.observedAt < Date.now()) {
        entries[target.sessionId] = { ...entry, retained: true };
      }
    }
    store.setState({ targets, entries });
  }

  const unsubscribeLayout = useWorkspaceListStore.subscribe((state, previous) => {
    if (state.workspaces === previous.workspaces) return;
    const oldLocal = new Set(previous.workspaces.map(workspace => workspace.id));
    const stillOwned = (target: LiveTailTarget) => !oldLocal.has(target.workspaceId)
      || state.workspaces.some(workspace => workspace.id === target.workspaceId && workspace.panes.some(pane =>
        pane.id === target.paneId && pane.tabs.some(tab => tab.id === target.tabId && tab.sessionId === target.sessionId)));
    catalogTargets = catalogTargets.filter(stillOwned);
    replacePtyReadOwners(catalogOwner, new Set(hasDemand() ? catalogTargets.map(target => target.sessionId) : []));
    const targets = store.getState().targets.filter(stillOwned);
    if (targets.length !== store.getState().targets.length) reconcileTargets(targets);
  });

  function acquireOutputs(scopes: Map<string, Scope>): Promise<Record<string, number | null>> {
    if (pendingOutputs || !hasDemand() || !scopes.size) return Promise.resolve({});
    pendingOutputs = true;
    const releases = [...scopes.keys()].map(retainPtyReads);
    let acquiredAt = Date.now();
    const task = Promise.resolve().then(() => {
      // Request time is a conservative acquisition bound: transport delay
      // cannot turn unobserved later output into proven silence.
      acquiredAt = Date.now(); return dependencies.loadOutputs();
    });
    void task.then(outputs => {
      pendingOutputs = false;
      const entries = { ...store.getState().entries };
      let changed = false;
      for (const [id, scope] of scopes) {
        if (!currentTarget(id, scope)) continue;
        const at = outputs[id];
        if (typeof at !== "number" || !Number.isFinite(at)) continue;
        outputSamples.set(id, { scope, at, acquiredAt });
        const entry = entries[id], sample = sampleScopes.get(id), old = entry?.evidence.observation;
        if (!entry || !old?.crop.readable || entry.readPending || entry.retained
          || !sameScope(sample, scope) || sample?.round !== scope.round) continue;
        const observation = { ...old, lastOutputAt: at, outputFresh: true, outputAcquiredAt: acquiredAt };
        const before = entry.history[entry.history.length - 2];
        const outputAdvancedWithSameScreen = entry.evidence.outputAdvancedWithSameScreen || Boolean(before
          && before.rawRows.length === old.rawRows.length && before.rawRows.every((row, index) => row === old.rawRows[index])
          && before.lastOutputAt !== null && at > before.lastOutputAt);
        entries[id] = { ...entry, history: [...entry.history.slice(0, -1), observation],
          evidence: { ...entry.evidence, observation, outputAdvancedWithSameScreen } };
        changed = true;
      }
      if (changed) store.setState({ entries });
    }, () => { pendingOutputs = false; }).finally(() => { releases.forEach(release => release()); });
    return task;
  }

  async function observe(reuseFreshObservations: boolean, deadline: number): Promise<void> {
    let targets: LiveTailTarget[];
    if (pendingTargets) return;
    const discoveryDemand = demand, discoveryRevision = ptyReadRevision(), round = Symbol("observation");
    pendingTargets = true;
    const discovery = Promise.resolve().then(dependencies.listTargets);
    void discovery.then(() => { pendingTargets = false; }, () => { pendingTargets = false; });
    try { targets = await bounded(discovery, deadline); } catch {
      // Discovery did not attempt a screen read. Retain age/history and never
      // charge pending, failed or skipped discovery against screen failures.
      refreshDemand();
      if (hasDemand() && discoveryDemand === demand) retainScreens();
      return;
    }
    refreshDemand();
    if (!hasDemand() || discoveryDemand !== demand) return;
    // The live catalog owns even an unavailable PTY's absence record. Source
    // eligibility is presentation/acquisition, not session retirement.
    catalogTargets = targets;
    replacePtyReadOwners(catalogOwner, new Set(catalogTargets.map(target => target.sessionId)));
    targets = targets.filter(target => {
      const generation = ptyReadGeneration(target.sessionId);
      return generation.available && generation.revision <= discoveryRevision;
    });
    // Duplicate session identities must not schedule duplicate PTY reads.
    targets = [...new Map(targets.map((target) => [target.sessionId, target])).values()];
    reconcileTargets(targets);
    const entries = store.getState().entries;
    const candidates = liveTailTargetsForView(targets, entries)
      .filter(({ target, entry }) => wanted(target) && shouldRead(target, entry)).map(({ target }) => target);
    const next = (candidates.findIndex(target => target.sessionId === lastScheduledId) + 1) % (candidates.length || 1);
    const selected = [...candidates.slice(next), ...candidates.slice(0, next)].flatMap(target => {
      const scope = scopeFor(target.sessionId, round);
      return scope && !pendingReads.has(target.sessionId)
        && !(reuseFreshObservations && !needsRevalidation(target, entries[target.sessionId])
          && freshAttempt(target.sessionId, entries[target.sessionId])) ? [{ target, scope }] : [];
    });
    const slots = Math.max(0, LIVE_TAIL_MAX_CONCURRENT_READS - pendingReads.size);
    recentReadStarts = recentReadStarts.filter(at => Date.now() - at < LIVE_TAIL_INTERVAL_MS);
    const readBudget = LIVE_TAIL_MAX_READS_PER_TICK - recentReadStarts.length;
    let outputsTask: Promise<Record<string, number | null>> = Promise.resolve({});
    if (selected.length && slots && readBudget > 0 && Date.now() < deadline && !pendingOutputs) {
      const scopes = new Map([...identities.keys()].flatMap(id => {
        const scope = scopeFor(id, round); return scope ? [[id, scope] as const] : [];
      }));
      const task = acquireOutputs(scopes);
      outputsTask = bounded(task, deadline).catch(() => ({}));
    }
    let index = 0, started = 0;
    await Promise.all([outputsTask, ...Array.from({ length: Math.min(slots, selected.length, readBudget) }, async () => {
      while (index < selected.length && started < readBudget && hasDemand() && Date.now() < deadline) {
        const { target, scope } = selected[index++];
        if (!currentTarget(target.sessionId, scope) || !shouldRead(target, store.getState().entries[target.sessionId])
          || pendingReads.has(target.sessionId)) continue;
        started++;
        lastScheduledId = target.sessionId;
        await readTarget(target, scope, deadline);
      }
    })]);
    if (hasDemand()) lastTickAt = Date.now();
  }

  function tick(reuseFreshObservations = false, deadline = Date.now() + LIVE_TAIL_READ_TIMEOUT_MS): Promise<void> {
    refreshDemand();
    if (!hasDemand()) return Promise.resolve();
    if (running) return running;
    running = observe(reuseFreshObservations, deadline).finally(() => { running = undefined; });
    return running;
  }

  function syncSchedule(): void {
    refreshDemand();
    if (!hasDemand()) {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      return;
    }
    if (interval === undefined) interval = setInterval(() => { void tick(); }, LIVE_TAIL_INTERVAL_MS);
  }

  function hasFreshGlobalObservations(): boolean {
    const { targets, entries } = store.getState();
    return liveTailTargetsForView(targets, entries).filter(({ target, entry }) => shouldRead(target, entry)).every(({ target, entry }) =>
      !needsRevalidation(target, entry) && freshAttempt(target.sessionId, entry));
  }

  function snapshot(): LiveTailsResponse {
    const state = store.getState();
    return { generatedAt: Date.now(), tabs: liveTailTargetsForView(state.targets, state.entries)
      .map(({ target: { status: _status, ...target }, entry, fact }) => {
        const observation = entry?.evidence.observation ?? emptyObservation();
        return { ...target, waitingForReply: statusForLiveTailTarget({ ...target, status: _status }) === "waiting", fact,
          rows: observation.crop.rows, lastOutputAt: observation.lastOutputAt,
          readable: observation.crop.readable && fact.kind !== "unreadable", observedAt: observation.observedAt };
      }) };
  }

  return {
    store, snapshot,
    __inspectForTests: () => ({ demand, active: hasDemand(), scopes: new Map(sampleScopes), outputs: new Map(outputSamples),
      pendingReads: [...pendingReads], starts: [...recentReadStarts] }),
    acquireConsumer(name: string): () => void {
      if (disposed) return () => {};
      refreshDemand();
      const consumer = Symbol(name); consumers.set(consumer, name); syncSchedule(); void tick();
      return () => { consumers.delete(consumer); syncSchedule(); };
    },
    async getForApi(): Promise<LiveTailsResponse> {
      if (disposed) return snapshot();
      refreshDemand();
      apiUntil = Date.now() + LIVE_TAIL_API_LEASE_MS;
      if (expiry !== undefined) clearTimeout(expiry);
      expiry = setTimeout(syncSchedule, LIVE_TAIL_API_LEASE_MS);
      syncSchedule();
      if (lastTickAt === null || Date.now() - lastTickAt >= LIVE_TAIL_INTERVAL_MS || !hasFreshGlobalObservations()) {
        const deadline = Date.now() + LIVE_TAIL_READ_TIMEOUT_MS;
        const pending = running;
        await tick(true, deadline);
        // An in-flight local sidebar read may not have covered foreign windows.
        if (pending && Date.now() < deadline && !hasFreshGlobalObservations()) await tick(true, deadline);
      }
      return snapshot();
    },
    dispose(): void {
      disposed = true; consumers.clear(); apiUntil = 0;
      if (expiry !== undefined) clearTimeout(expiry);
      syncSchedule(); unsubscribeGeneration(); unsubscribeLayout();
      identities.clear(); sampleScopes.clear(); attemptScopes.clear(); outputSamples.clear();
      catalogTargets = [];
      replacePtyReadOwners(catalogOwner, new Set()); store.setState({ targets: [], entries: {} });
    },
  };
}

let observer: ReturnType<typeof createLiveTailController> | undefined;
function liveTailObserver() {
  if (observer) return observer;
  let readModule: Promise<typeof import("../components/layout/socketCommands")> | undefined;
  observer = createLiveTailController({
    listTargets: async () => (await import("../lib/liveTail/targets")).loadLiveTailTargets(),
    ownsSidebarTarget: target => useWorkspaceListStore.getState().workspaces.some(workspace =>
      workspace.id === target.workspaceId && workspace.panes.some(pane => pane.id === target.paneId
        && pane.tabs.some(tab => tab.id === target.tabId && tab.sessionId === target.sessionId))),
    loadOutputs: async () => (await import("../lib/liveTail/targets")).loadLiveTailOutputs(),
    // Share initialization across concurrent reads, including a cold WebView.
    // Fetches may outlive the observation deadline; send confirmation keeps its
    // shorter default, and lost live-tail fetches still release their slots.
    readTail: async (sessionId, lines, isCurrent) => (await (readModule ??= import("../components/layout/socketCommands")))
      .readPaneTail(sessionId, lines, false, { headlessFetchTimeoutMs: TERMINAL_IPC_TIMEOUT_MS, purpose: "observation", isCurrent }),
  });
  return observer;
}

export function acquireLiveTailConsumer(name: string): () => void { return liveTailObserver().acquireConsumer(name); }
export function getLiveTailsForApi(): Promise<LiveTailsResponse> { return liveTailObserver().getForApi(); }
export function useLiveTailStore<T>(selector: (state: LiveTailState) => T): T { return useStore(liveTailObserver().store, selector); }
export function disposeLiveTailObserver(): void { observer?.dispose(); observer = undefined; }

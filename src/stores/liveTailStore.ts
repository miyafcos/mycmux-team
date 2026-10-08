import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { useWorkspaceListStore } from "./workspaceListStore";
import { hasWorkingScreenEvidence } from "../lib/agentDormancy";
import { isolateSubscribers } from "../lib/isolatedStoreListeners";
import { cropLiveTail, unreadableLiveTail } from "../lib/liveTail/crop";
import { advanceLiveTailEvidence, factForLiveTailEvidence, type LiveTailEvidence, type LiveTailFact, type LiveTailObservation } from "../lib/liveTail/facts";

export const LIVE_TAIL_INTERVAL_MS = 2_000;
export const LIVE_TAIL_API_LEASE_MS = 10_000;
export const LIVE_TAIL_READ_TIMEOUT_MS = 1_500;
export const LIVE_TAIL_HISTORY_LIMIT = 128;
export const LIVE_TAIL_SCREEN_LINES = 40;

export interface LiveTailTarget {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  paneId: string;
  tabId: string;
  name: string;
  agentKind: string | null;
  status: "working" | "waiting" | "idle";
  waitingForReply: boolean;
}

export interface LiveTailEntry {
  history: LiveTailObservation[];
  evidence: LiveTailEvidence;
  screenWorking: boolean;
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
  readTail: (sessionId: string, lines: number) => Promise<string[]>;
  loadOutputs: () => Promise<Record<string, number | null>>;
  /** Sidebars read only tabs owned by their WebView; API demand remains global. */
  ownsSidebarTarget?: (target: LiveTailTarget) => boolean;
}

function eligible(target: LiveTailTarget, entry?: LiveTailEntry): boolean {
  return target.status === "working" || target.status === "waiting" || target.waitingForReply || Boolean(entry?.screenWorking);
}

/** One controller per WebView; nothing polls until there is demand. */
export function createLiveTailController(dependencies: LiveTailDependencies) {
  const store = createStore<LiveTailState>(() => ({ targets: [], entries: {} }));
  isolateSubscribers(store, "liveTail");
  const consumers = new Map<symbol, string>();
  const pendingReads = new Set<string>();
  let pendingTargets = false, pendingOutputs = false;
  let apiUntil = 0, disposed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let lastTickAt: number | null = null;

  const hasDemand = () => !disposed && (consumers.size > 0 || Date.now() < apiUntil);
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

  async function readTarget(target: LiveTailTarget, deadline: number): Promise<string[] | null> {
    if (pendingReads.has(target.sessionId)) return null;
    pendingReads.add(target.sessionId);
    // A timed-out request is still in flight. Keep its seat occupied until the
    // actual request settles, and never apply its late result to this store.
    const task = Promise.resolve().then(() => hasDemand() && wanted(target)
      ? dependencies.readTail(target.sessionId, LIVE_TAIL_SCREEN_LINES) : null);
    void task.then(() => pendingReads.delete(target.sessionId), () => pendingReads.delete(target.sessionId));
    try { return await bounded(task, deadline); } catch { return null; }
  }

  async function observe(reuseFreshObservations = false): Promise<void> {
    const deadline = Date.now() + LIVE_TAIL_READ_TIMEOUT_MS;
    let targets: LiveTailTarget[];
    if (pendingTargets) return;
    pendingTargets = true;
    const discovery = Promise.resolve().then(dependencies.listTargets);
    void discovery.then(() => { pendingTargets = false; }, () => { pendingTargets = false; });
    try { targets = await bounded(discovery, deadline); } catch {
      if (hasDemand()) {
        // Discovery failure cannot prove old screens are still current.
        const state = store.getState();
        const entries = { ...state.entries };
        for (const target of state.targets.filter((t) => wanted(t) && eligible(t, entries[t.sessionId]))) {
          const previous = entries[target.sessionId];
          const observation: LiveTailObservation = { observedAt: Date.now(), lastOutputAt: null, rawRows: [], crop: unreadableLiveTail() };
          entries[target.sessionId] = { screenWorking: previous?.screenWorking ?? false,
            history: [...(previous?.history ?? []), observation].slice(-LIVE_TAIL_HISTORY_LIMIT),
            evidence: advanceLiveTailEvidence(previous?.evidence, observation) };
        }
        store.setState({ entries });
      }
      return;
    }
    if (!hasDemand()) return;
    // Duplicate session identities must not schedule duplicate PTY reads.
    targets = [...new Map(targets.map((target) => [target.sessionId, target])).values()];
    const previous = store.getState().entries;
    const entries = Object.fromEntries(Object.entries(previous).filter(([id]) => targets.some((t) => t.sessionId === id)));
    const selected = targets.filter((target) => wanted(target) && eligible(target, entries[target.sessionId])
      && !(reuseFreshObservations && entries[target.sessionId]
        && Date.now() - entries[target.sessionId].evidence.observation.observedAt < LIVE_TAIL_INTERVAL_MS));
    let outputsTask: Promise<Record<string, number | null>> = Promise.resolve({});
    if (selected.length && !pendingOutputs) {
      pendingOutputs = true;
      const task = Promise.resolve().then(dependencies.loadOutputs);
      void task.then(() => { pendingOutputs = false; }, () => { pendingOutputs = false; });
      outputsTask = bounded(task, deadline).catch(() => ({}));
    }
    const [readings, outputs] = await Promise.all([
      Promise.all(selected.map(async (target) => ({ target, rows: await readTarget(target, deadline) }))), outputsTask,
    ]);
    if (!hasDemand()) return;
    const observedAt = Date.now();
    for (const { target, rows } of readings) {
      const old = entries[target.sessionId];
      const observation: LiveTailObservation = { observedAt, rawRows: rows ?? [],
        crop: rows === null ? unreadableLiveTail() : cropLiveTail(rows, target.agentKind),
        lastOutputAt: outputs[target.sessionId] ?? null };
      entries[target.sessionId] = {
        history: [...(old?.history ?? []), observation].slice(-LIVE_TAIL_HISTORY_LIMIT),
        evidence: advanceLiveTailEvidence(old?.evidence, observation),
        screenWorking: rows === null ? old?.screenWorking ?? false : hasWorkingScreenEvidence(rows) || observation.crop.state === "working",
      };
    }
    lastTickAt = observedAt;
    store.setState({ targets, entries });
  }

  function tick(reuseFreshObservations = false): Promise<void> {
    if (!hasDemand()) return Promise.resolve();
    if (running) return running;
    running = observe(reuseFreshObservations).finally(() => { running = undefined; });
    return running;
  }

  function syncSchedule(): void {
    if (!hasDemand()) {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      return;
    }
    if (interval === undefined) interval = setInterval(() => { void tick(); }, LIVE_TAIL_INTERVAL_MS);
  }

  function hasFreshGlobalObservations(): boolean {
    const { targets, entries } = store.getState();
    return targets.filter(target => eligible(target, entries[target.sessionId])).every(target =>
      Boolean(entries[target.sessionId]) && Date.now() - entries[target.sessionId].evidence.observation.observedAt < LIVE_TAIL_INTERVAL_MS);
  }

  function snapshot(): LiveTailsResponse {
    const state = store.getState();
    return { generatedAt: Date.now(), tabs: state.targets.filter((target) => eligible(target, state.entries[target.sessionId]))
      .flatMap(({ status: _status, ...target }) => {
        const entry = state.entries[target.sessionId];
        if (!entry) return [];
        const observation = entry.evidence.observation;
        const fact = factForLiveTailEvidence(entry.evidence);
        return [{ ...target, fact, rows: observation.crop.rows, lastOutputAt: observation.lastOutputAt,
          readable: observation.crop.readable && fact.kind !== "unreadable", observedAt: observation.observedAt }];
      }) };
  }

  return {
    store, snapshot,
    acquireConsumer(name: string): () => void {
      if (disposed) return () => {};
      const consumer = Symbol(name); consumers.set(consumer, name); syncSchedule(); void tick();
      return () => { consumers.delete(consumer); syncSchedule(); };
    },
    async getForApi(): Promise<LiveTailsResponse> {
      if (disposed) return snapshot();
      apiUntil = Date.now() + LIVE_TAIL_API_LEASE_MS;
      if (expiry !== undefined) clearTimeout(expiry);
      expiry = setTimeout(syncSchedule, LIVE_TAIL_API_LEASE_MS);
      syncSchedule();
      if (lastTickAt === null || Date.now() - lastTickAt >= LIVE_TAIL_INTERVAL_MS || !hasFreshGlobalObservations()) {
        const pending = running;
        await tick(true);
        // An in-flight local sidebar read may not have covered foreign windows.
        if (pending && !hasFreshGlobalObservations()) await tick(true);
      }
      return snapshot();
    },
    dispose(): void {
      disposed = true; consumers.clear(); apiUntil = 0;
      if (expiry !== undefined) clearTimeout(expiry);
      syncSchedule();
    },
  };
}

let observer: ReturnType<typeof createLiveTailController> | undefined;
function liveTailObserver() {
  observer ??= createLiveTailController({
    listTargets: async () => (await import("../lib/liveTail/targets")).loadLiveTailTargets(),
    ownsSidebarTarget: target => useWorkspaceListStore.getState().workspaces.some(workspace =>
      workspace.id === target.workspaceId && workspace.panes.some(pane => pane.id === target.paneId
        && pane.tabs.some(tab => tab.id === target.tabId && tab.sessionId === target.sessionId))),
    loadOutputs: async () => (await import("../lib/liveTail/targets")).loadLiveTailOutputs(),
    readTail: async (sessionId, lines) => (await import("../components/layout/socketCommands")).readPaneTail(sessionId, lines),
  });
  return observer;
}

export function acquireLiveTailConsumer(name: string): () => void { return liveTailObserver().acquireConsumer(name); }
export function getLiveTailsForApi(): Promise<LiveTailsResponse> { return liveTailObserver().getForApi(); }
export function useLiveTailStore<T>(selector: (state: LiveTailState) => T): T { return useStore(liveTailObserver().store, selector); }
export function disposeLiveTailObserver(): void { observer?.dispose(); observer = undefined; }

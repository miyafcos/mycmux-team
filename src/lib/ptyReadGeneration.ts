/** Read lifetime, independent of the renderer's attachment/channel epoch. */
export interface PtyReadGeneration {
  readonly revision: number;
  epoch?: number;
  available: boolean;
}
const generations = new Map<string, PtyReadGeneration>();
const absent = new Set<string>();
const transitions = new Map<string, Set<symbol>>();
const owners = new Map<symbol, ReadonlySet<string>>();
const operations = new Map<string, number>();
const listeners = new Set<(sessionId: string, retired?: boolean) => void>();
let revision = 0;

function liveOwner(sessionId: string): boolean {
  return [...owners.values()].some(ids => ids.has(sessionId));
}
function owned(sessionId: string): boolean {
  return liveOwner(sessionId) || operations.has(sessionId) || transitions.has(sessionId);
}
function retire(sessionId: string): void {
  if (owned(sessionId)) return;
  const generation = generations.get(sessionId);
  if (!generation) return;
  generation.available = false;
  generations.delete(sessionId); absent.delete(sessionId);
  for (const listener of listeners) listener(sessionId, true);
}

/** Layout/catalog ownership is independent of parser cache residency. */
export function replacePtyReadOwners(owner: symbol, ids: ReadonlySet<string>): void {
  const previous = owners.get(owner) ?? new Set<string>();
  const newlyLive = new Set([...ids].filter(id => !liveOwner(id)));
  if (ids.size) owners.set(owner, new Set(ids)); else owners.delete(owner);
  for (const id of ids) {
    if (newlyLive.has(id) && generations.has(id) && !absent.has(id) && !transitions.has(id)) rotatePtyReads(id, true, false);
    else ptyReadGeneration(id);
  }
  for (const id of previous) {
    if (ids.has(id) || liveOwner(id)) continue;
    // Outstanding callbacks retain bookkeeping, never permission to publish
    // a removed live identity. A rediscovered owner gets a distinct lifetime.
    if (generations.has(id)) rotatePtyReads(id, false);
    retire(id);
  }
}

/** A real operation owns records until its actual settlement, not a timeout. */
export function retainPtyReads(sessionId: string): () => void {
  operations.set(sessionId, (operations.get(sessionId) ?? 0) + 1);
  ptyReadGeneration(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (operations.get(sessionId) ?? 1) - 1;
    if (count) operations.set(sessionId, count); else operations.delete(sessionId);
    retire(sessionId);
  };
}

export function ptyReadGeneration(sessionId: string): PtyReadGeneration {
  let generation = generations.get(sessionId);
  if (!generation) {
    generation = { revision: 0, available: true };
    // Merely checking a historical/unknown ID does not acquire ownership.
    if (owned(sessionId)) generations.set(sessionId, generation);
  }
  return generation;
}

export function ptyReadRevision(): number { return revision; }

export function invalidatePtyReads(sessionId: string, available = false): PtyReadGeneration {
  if (!owned(sessionId)) { retire(sessionId); return { revision, available: false }; }
  if (available) absent.delete(sessionId); else absent.add(sessionId);
  return rotatePtyReads(sessionId, available && !transitions.get(sessionId)?.size);
}

function rotatePtyReads(sessionId: string, available: boolean, advanceRevision = true): PtyReadGeneration {
  const generation = { revision: advanceRevision ? ++revision : revision, epoch: ptyReadGeneration(sessionId).epoch,
    available };
  generations.set(sessionId, generation);
  for (const listener of listeners) listener(sessionId);
  return generation;
}

export function subscribePtyReads(listener: (sessionId: string, retired?: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function currentPtyRead(sessionId: string, generation: PtyReadGeneration): boolean {
  return generations.get(sessionId) === generation && generation.available;
}

/** The accepted attention feed is authoritative even before the next poll. */
export function observePtyEpoch(sessionId: string, epoch: number): void {
  if (!owned(sessionId)) return;
  const generation = ptyReadGeneration(sessionId);
  if (generation.epoch === undefined && !absent.has(sessionId)) generation.epoch = epoch;
  else if (generation.epoch !== epoch) {
    const next = invalidatePtyReads(sessionId, true);
    next.epoch = epoch;
  }
}

export function beginPtyReadTransition(sessionId: string): symbol {
  const token = Symbol(sessionId);
  const pending = transitions.get(sessionId) ?? new Set<symbol>();
  pending.add(token);
  transitions.set(sessionId, pending);
  // Changing is not authoritative absence. It fences acquisition until the
  // actual serialized lifecycle operations settle, including their failures.
  rotatePtyReads(sessionId, false);
  return token;
}

export function finishPtyReadTransition(sessionId: string, token: symbol, present?: boolean): void {
  const pending = transitions.get(sessionId);
  if (!pending || !pending.delete(token)) return;
  // A failed attempt supplies no presence evidence. Preserve every settled
  // successful result, even while a later operation is still queued.
  if (present === true) absent.delete(sessionId);
  else if (present === false) absent.add(sessionId);
  if (pending.size) return;
  transitions.delete(sessionId);
  const generation = ptyReadGeneration(sessionId);
  generation.available = !absent.has(sessionId);
  // A completed transition permits fresh acquisition, not reuse of the old
  // producer's attention or result. The next binary reply establishes epoch.
  if (generation.available) generation.epoch = undefined;
  retire(sessionId);
}

/** A late binary response must never teach us an older producer's epoch. */
export function validatePtySnapshot(sessionId: string, generation: PtyReadGeneration, epoch?: number): void {
  if (!currentPtyRead(sessionId, generation)) throw new Error("PTY read generation changed");
  if (epoch !== undefined) {
    if (generation.epoch !== undefined && generation.epoch !== epoch) {
      // A newer producer discovered by this read invalidates all other tasks.
      if (epoch > generation.epoch) observePtyEpoch(sessionId, epoch);
      throw new Error("PTY snapshot belongs to another generation");
    }
    generation.epoch = epoch;
  }
}

export function __inspectPtyReadsForTests() {
  return { generations: [...generations.keys()], absent: [...absent], transitions: [...transitions.keys()],
    live: [...new Set([...owners.values()].flatMap(ids => [...ids]))], operations: new Map(operations) };
}
export function __resetPtyReadGenerationsForTests(): void {
  generations.clear(); absent.clear(); transitions.clear(); owners.clear(); operations.clear(); revision = 0;
}

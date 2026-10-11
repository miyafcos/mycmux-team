export type PetAssignmentMode = "random" | "random-repeat" | "choose" | "fixed";

/** IDs left in this cycle; atlas data and workspace assignments live elsewhere. */
export interface PetAssignmentBag {
  version: 1;
  candidates: string[];
  remaining: string[];
}

export interface PetAssignmentSettings {
  candidateIds: string[];
  mode: PetAssignmentMode;
  fixedId?: string;
  bag?: PetAssignmentBag;
}

export interface PetAssignment {
  petId: string | undefined;
  bag: PetAssignmentBag;
}

function ids(values: readonly string[]): string[] {
  return [...new Set(values.filter((id) => typeof id === "string" && id.length > 0))].sort();
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Unknown versions or malformed saved state never prevent workspace restore. */
export function readPetAssignmentBag(value: unknown): PetAssignmentBag | undefined {
  if (!value || typeof value !== "object") return undefined;
  const bag = value as Partial<PetAssignmentBag>;
  if (bag.version !== 1 || !Array.isArray(bag.candidates) || !Array.isArray(bag.remaining)) return undefined;
  const candidates = ids(bag.candidates);
  return { version: 1, candidates, remaining: ids(bag.remaining).filter((id) => candidates.includes(id)) };
}

export function reconcilePetAssignmentBag(bag: PetAssignmentBag | undefined, candidateIds: readonly string[]): PetAssignmentBag {
  const candidates = ids(candidateIds);
  const added = candidates.filter((id) => !bag?.candidates.includes(id));
  const remaining = ids([...(bag?.remaining ?? []).filter((id) => candidates.includes(id)), ...added]);
  if (bag && sameIds(bag.candidates, candidates) && sameIds(bag.remaining, remaining)) return bag;
  return { version: 1, candidates, remaining };
}

function pick(pool: readonly string[], random: () => number): string | undefined {
  return pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))];
}

function availablePetBag(
  candidateIds: readonly string[],
  usedIds: readonly (string | undefined)[],
  savedBag?: PetAssignmentBag,
): PetAssignmentBag {
  let bag = reconcilePetAssignmentBag(savedBag, candidateIds);
  const used = new Set(usedIds);
  const unused = bag.candidates.filter((id) => !used.has(id));
  if (unused.length > 0) {
    // Existing and manually selected pets count as used too. Released IDs can
    // be used immediately, even if they were consumed earlier in this cycle.
    let remaining = bag.remaining.filter((id) => !used.has(id));
    if (remaining.length === 0) remaining = unused;
    bag = { ...bag, remaining };
  } else if (bag.remaining.length === 0) {
    bag = { ...bag, remaining: [...bag.candidates] };
  }
  return bag;
}

export function drawPetAssignment(
  candidateIds: readonly string[],
  usedIds: readonly (string | undefined)[],
  savedBag?: PetAssignmentBag,
  random: () => number = Math.random,
): PetAssignment {
  const bag = availablePetBag(candidateIds, usedIds, savedBag);
  const petId = pick(bag.remaining, random);
  return { petId, bag: { ...bag, remaining: bag.remaining.filter((id) => id !== petId) } };
}

/** Commit the choices already shown by a batch preview, including full cycles. */
export function recordPetAssignmentPlan(
  settings: PetAssignmentSettings,
  usedIds: readonly (string | undefined)[],
  petIds: readonly (string | undefined)[],
): PetAssignmentBag {
  let bag = reconcilePetAssignmentBag(settings.bag, settings.candidateIds);
  const used = [...usedIds];
  for (const petId of petIds) {
    if (petId === undefined) continue;
    const available = settings.mode === "random" ? availablePetBag(settings.candidateIds, used, bag) : bag;
    if (available.remaining.includes(petId)) bag = available;
    bag = { ...bag, remaining: bag.remaining.filter((id) => id !== petId) };
    used.push(petId);
  }
  return bag;
}

export function choosePetAssignment(
  settings: PetAssignmentSettings,
  usedIds: readonly (string | undefined)[],
  random: () => number = Math.random,
): PetAssignment {
  const bag = reconcilePetAssignmentBag(settings.bag, settings.candidateIds);
  if (settings.mode === "random") return drawPetAssignment(settings.candidateIds, usedIds, bag, random);
  const petId = settings.mode === "choose" ? undefined
    : settings.mode === "fixed" ? (settings.fixedId && bag.candidates.includes(settings.fixedId) ? settings.fixedId : bag.candidates[0])
      : pick(bag.candidates, random);
  return { petId, bag: { ...bag, remaining: bag.remaining.filter((id) => id !== petId) } };
}

/** Consume manual/fixed choices and return a deleted workspace's last use. */
export function updatePetAssignmentBag(
  savedBag: PetAssignmentBag | undefined,
  candidateIds: readonly string[],
  before: readonly { id: string; pet?: string }[],
  after: readonly { id: string; pet?: string }[],
  consumeAssignments = true,
): PetAssignmentBag {
  const bag = reconcilePetAssignmentBag(savedBag, candidateIds);
  const previous = new Map(before.map((workspace) => [workspace.id, workspace.pet]));
  const usedBefore = new Set(before.map((workspace) => workspace.pet));
  const usedAfter = new Set(after.map((workspace) => workspace.pet));
  const assigned = new Set(consumeAssignments ? after.filter((workspace) => previous.get(workspace.id) !== workspace.pet).map((workspace) => workspace.pet) : []);
  const released = bag.candidates.filter((id) => usedBefore.has(id) && !usedAfter.has(id));
  const remaining = ids([
    ...bag.remaining.filter((id) => !assigned.has(id) && (savedBag !== undefined || !usedBefore.has(id))),
    ...released,
  ]);
  return sameIds(bag.remaining, remaining) ? bag : { ...bag, remaining };
}

/** Stable preview/test randomness. Assignment does not require a crypto RNG. */
export function petRandomFromSeed(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Plan a batch without consuming the live bag or changing existing pets. */
export function planPetAssignments(
  settings: PetAssignmentSettings,
  usedIds: readonly (string | undefined)[],
  keys: readonly string[],
  random: () => number = Math.random,
): { pets: Record<string, string | undefined>; bag: PetAssignmentBag } {
  let bag = reconcilePetAssignmentBag(settings.bag, settings.candidateIds);
  const used = [...usedIds];
  const pets: Record<string, string | undefined> = {};
  for (const key of keys) {
    const assignment = choosePetAssignment({ ...settings, bag }, used, random);
    pets[key] = assignment.petId;
    bag = assignment.bag;
    used.push(assignment.petId);
  }
  return { pets, bag };
}

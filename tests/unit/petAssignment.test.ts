import { describe, expect, it } from "vitest";
import {
  choosePetAssignment, drawPetAssignment, petRandomFromSeed, planPetAssignments,
  readPetAssignmentBag, reconcilePetAssignmentBag, updatePetAssignmentBag,
  type PetAssignmentBag, type PetAssignmentSettings,
} from "../../src/lib/petAssignment";

const candidates = ["clawd", "external:a", "external:b"];
const settings: PetAssignmentSettings = { candidateIds: candidates, mode: "random" };

function draws(count: number, seed: string, used: string[] = []) {
  let bag: PetAssignmentBag | undefined;
  const random = petRandomFromSeed(seed);
  const picked: string[] = [];
  for (let index = 0; index < count; index++) {
    const draw = drawPetAssignment(candidates, [...used, ...picked], bag, random);
    picked.push(draw.petId!);
    bag = draw.bag;
  }
  return { picked, bag };
}

describe("pet assignment bag", () => {
  it("is reproducible with an injected seed across catalog order", () => {
    expect(draws(9, "pet-seed")).toEqual(draws(9, "pet-seed"));
    const left = planPetAssignments(settings, [], ["a", "b", "c"], petRandomFromSeed("pet-seed"));
    const right = planPetAssignments({ ...settings, candidateIds: [...candidates].reverse() }, [], ["a", "b", "c"], petRandomFromSeed("pet-seed"));
    expect(left).toEqual(right);
  });

  it("avoids every used pet until all candidates have been assigned", () => {
    const { picked, bag } = draws(3, "first-cycle");
    expect(new Set(picked)).toEqual(new Set(candidates));
    expect(bag?.remaining).toEqual([]);
  });

  it("refills only after exhaustion and uses each candidate once in each full cycle", () => {
    const { picked } = draws(12, "four-cycles");
    for (let index = 0; index < picked.length; index += 3) {
      expect(new Set(picked.slice(index, index + 3))).toEqual(new Set(candidates));
    }
  });

  it("can repeat a sole candidate", () => {
    const first = drawPetAssignment(["clawd"], ["clawd"], undefined, () => 0);
    const second = drawPetAssignment(["clawd"], ["clawd", "clawd"], first.bag, () => 0);
    expect([first.petId, second.petId]).toEqual(["clawd", "clawd"]);
  });

  it("includes existing manual and fixed choices as used", () => {
    const before = [{ id: "manual", pet: "clawd" }];
    const after = [...before, { id: "fixed", pet: "external:a" }];
    const bag = updatePetAssignmentBag(undefined, candidates, before, after);
    expect(bag.remaining).toEqual(["external:b"]);
    expect(drawPetAssignment(candidates, after.map((item) => item.pet), bag, () => 0).petId).toBe("external:b");
  });

  it("returns a deleted pet when the last workspace using it is gone", () => {
    const bag = { version: 1 as const, candidates, remaining: [] };
    const before = [{ id: "a", pet: "clawd" }, { id: "b", pet: "external:a" }, { id: "c", pet: "external:b" }];
    const after = before.slice(1);
    const updated = updatePetAssignmentBag(bag, candidates, before, after);
    expect(updated.remaining).toEqual(["clawd"]);
    expect(drawPetAssignment(candidates, after.map((item) => item.pet), updated, () => 0).petId).toBe("clawd");
  });

  it("does not release a pet still used by another workspace", () => {
    const bag = { version: 1 as const, candidates, remaining: [] };
    const before = [{ id: "a", pet: "clawd" }, { id: "b", pet: "clawd" }];
    expect(updatePetAssignmentBag(bag, candidates, before, before.slice(1)).remaining).toEqual([]);
  });

  it("returns the old manual choice and consumes the new one", () => {
    const bag = reconcilePetAssignmentBag(undefined, candidates);
    const next = updatePetAssignmentBag(bag, candidates, [{ id: "w", pet: "clawd" }], [{ id: "w", pet: "external:a" }]);
    expect(next.remaining).toEqual(["clawd", "external:b"]);
  });

  it("adds a newly enabled candidate to an exhausted bag", () => {
    const bag = { version: 1 as const, candidates: ["clawd"], remaining: [] };
    const draw = drawPetAssignment(["clawd", "external:new"], ["clawd"], bag, () => 0);
    expect(draw.petId).toBe("external:new");
    expect(draw.bag.candidates).toEqual(["clawd", "external:new"]);
  });

  it("removes missing or disabled candidates and admits them again on restoration", () => {
    const bag = reconcilePetAssignmentBag(undefined, candidates);
    const reduced = reconcilePetAssignmentBag(bag, ["clawd", "external:b"]);
    expect(reduced.remaining).toEqual(["clawd", "external:b"]);
    expect(reconcilePetAssignmentBag(reduced, candidates).remaining).toEqual(candidates);
  });

  it("reuses an unchanged bag without mutating its arrays", () => {
    const bag = reconcilePetAssignmentBag(undefined, candidates);
    Object.freeze(bag.candidates); Object.freeze(bag.remaining); Object.freeze(bag);
    expect(reconcilePetAssignmentBag(bag, [...candidates].reverse())).toBe(bag);
    const draw = drawPetAssignment(candidates, [], bag, () => 0);
    expect(draw.bag.remaining).toEqual(["external:a", "external:b"]);
    expect(bag.remaining).toEqual(candidates);
  });

  it.each([undefined, null, {}, { version: 99 }, { version: 1, candidates: "bad", remaining: [] }])("repairs invalid saved state %j", (value) => {
    expect(readPetAssignmentBag(value)).toBeUndefined();
    expect(drawPetAssignment(candidates, ["clawd"], readPetAssignmentBag(value), () => 0).petId).toBe("external:a");
  });

  it("sanitizes duplicate and foreign saved IDs", () => {
    expect(readPetAssignmentBag({ version: 1, candidates: ["clawd", "clawd", "external:a", 7, null], remaining: ["external:a", "ghost", "external:a"] })).toEqual({
      version: 1, candidates: ["clawd", "external:a"], remaining: ["external:a"],
    });
  });

  it("handles an empty candidate set without inventing an external ID", () => {
    expect(drawPetAssignment([], [], undefined, () => 0)).toEqual({ petId: undefined, bag: { version: 1, candidates: [], remaining: [] } });
  });

  it("keeps the legacy random option free to repeat occupied candidates", () => {
    const draw = choosePetAssignment({ ...settings, mode: "random-repeat" }, ["clawd"], () => 0);
    expect(draw.petId).toBe("clawd");
  });

  it("keeps choose unassigned and fixed independent of occupancy", () => {
    expect(choosePetAssignment({ ...settings, mode: "choose" }, [], () => 0).petId).toBeUndefined();
    expect(choosePetAssignment({ ...settings, mode: "fixed", fixedId: "external:a" }, ["external:a"], () => 0).petId).toBe("external:a");
    expect(choosePetAssignment({ ...settings, mode: "fixed", fixedId: "ghost" }, [], () => 0).petId).toBe("clawd");
  });

  it("plans a distinct batch without consuming the saved bag", () => {
    const bag = reconcilePetAssignmentBag(undefined, candidates);
    const saved = structuredClone(bag);
    const plan = planPetAssignments({ ...settings, bag }, ["clawd"], ["first", "second"], () => 0);
    expect(plan.pets).toEqual({ first: "external:a", second: "external:b" });
    expect(bag).toEqual(saved);
  });

  it("continues a saved cycle after JSON round trip", () => {
    const first = draws(4, "save-cycle");
    const restored = readPetAssignmentBag(JSON.parse(JSON.stringify(first.bag)));
    const original = drawPetAssignment(candidates, candidates, first.bag, petRandomFromSeed("next"));
    const resumed = drawPetAssignment(candidates, candidates, restored, petRandomFromSeed("next"));
    expect(resumed).toEqual(original);
  });
});

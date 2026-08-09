import { describe, expect, it } from "vitest";
import { resolveTabInsertionIndex } from "../../src/stores/paneDragStore";

const strip = [
  { left: 0, right: 100 },
  { left: 100, right: 200 },
  { left: 200, right: 260 },
];

describe("resolveTabInsertionIndex", () => {
  it("returns 0 for an empty strip", () => {
    expect(resolveTabInsertionIndex([], 40)).toBe(0);
  });

  it("inserts before the first pill left of its midpoint", () => {
    expect(resolveTabInsertionIndex(strip, -20)).toBe(0);
    expect(resolveTabInsertionIndex(strip, 0)).toBe(0);
    expect(resolveTabInsertionIndex(strip, 49)).toBe(0);
  });

  it("crosses to the next slot at each midpoint", () => {
    expect(resolveTabInsertionIndex(strip, 50)).toBe(1);
    expect(resolveTabInsertionIndex(strip, 149)).toBe(1);
    expect(resolveTabInsertionIndex(strip, 150)).toBe(2);
    expect(resolveTabInsertionIndex(strip, 229)).toBe(2);
  });

  it("returns the tab count past the last midpoint", () => {
    expect(resolveTabInsertionIndex(strip, 230)).toBe(3);
    expect(resolveTabInsertionIndex(strip, 4000)).toBe(3);
  });

  it("handles a single pill", () => {
    expect(resolveTabInsertionIndex([{ left: 10, right: 30 }], 19)).toBe(0);
    expect(resolveTabInsertionIndex([{ left: 10, right: 30 }], 21)).toBe(1);
  });
});

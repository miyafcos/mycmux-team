import { describe, expect, it } from "vitest";
import { reconcileStableLayoutColumnIdentities } from "../../src/lib/layoutColumns";

describe("reconcileStableLayoutColumnIdentities", () => {
  it("keeps a column identity when its first pane closes", () => {
    const previous = [{ id: "column-a", paneIds: ["a", "b", "c"] }];
    expect(reconcileStableLayoutColumnIdentities(previous, [["b", "c"]])).toEqual([
      { id: "column-a", paneIds: ["b", "c"] },
    ]);
  });

  it("assigns a new identity only to the newly split column", () => {
    const previous = [{ id: "column-a", paneIds: ["a", "b"] }];
    const next = reconcileStableLayoutColumnIdentities(previous, [["a"], ["b"]]);

    expect(next[0].id).toBe("column-a");
    expect(next[1].id).not.toBe("column-a");
  });

  it("maximizes retained column subtrees when panes move", () => {
    const previous = [
      { id: "wide", paneIds: ["a", "b"] },
      { id: "single", paneIds: ["c"] },
    ];
    const next = reconcileStableLayoutColumnIdentities(previous, [["a", "c"], ["b"]]);

    expect(next[0].id).toBe("single");
    expect(next[1].id).toBe("wide");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetPaneLeftoverLabelsForTests,
  getPaneProcessTrees,
  groupPaneLeftovers,
  rememberClosedPaneLabel,
  type PaneLeftoverProcess,
} from "../../src/lib/paneLeftovers";
import type { ClosedPaneEntry } from "../../src/stores/closedPaneStore";

const process = (overrides: Partial<PaneLeftoverProcess> = {}): PaneLeftoverProcess => ({
  pid: 1, parentPid: null, name: "python.exe", startedAt: 100,
  memoryBytes: 1024, command: "python watch.py", paneSessionId: "pane", paneRunning: false,
  ...overrides,
});
const history = (label: string | null, displayName?: string): ClosedPaneEntry => ({
  paneSessionId: "pane", cwd: null, label, displayName, agentKind: null, agentSessionId: null,
});

beforeEach(__resetPaneLeftoverLabelsForTests);

describe("leftover group identity and remembered labels", () => {
  it("marks a pane running in another window as open, even with closed history", () => {
    const groups = groupPaneLeftovers([
      process({ paneSessionId: "12345678-running" }),
      process({ pid: 2, paneSessionId: "12345678-running", paneRunning: true }),
      process({ pid: 3, paneSessionId: "closed" }),
    ], [], [{ ...history("old"), paneSessionId: "12345678-running" }]);
    expect(groups.map((group) => group.closed)).toEqual([true, false]);
    expect(groups[1].title).toBe("動いているペイン (ID 12345678) から切り離されたもの");
  });

  it("uses remembered names after history labels and before an ID fallback", () => {
    rememberClosedPaneLabel("pane", "background");
    expect(groupPaneLeftovers([process()], [], [])[0].title).toBe("閉じたペイン「background」から残っているもの");
    expect(groupPaneLeftovers([process()], [], [history("history")])[0].title).toContain("「history」");
    expect(groupPaneLeftovers([process()], [], [history(null, "display")])[0].title).toContain("「display」");
    expect(groupPaneLeftovers([process()], [], [history(null)])[0].title).toContain("「background」");
    expect(groupPaneLeftovers([process({ paneSessionId: "unknown-id" })], [], [])[0].title).toContain("(ID unknown-)");
  });

  it("keeps the latest 200 labels and refreshes the age of a repeated pane", () => {
    for (let index = 0; index < 200; index += 1) rememberClosedPaneLabel(`id-${index}`, `label-${index}`);
    const title = (paneSessionId: string) => groupPaneLeftovers([process({ paneSessionId })], [], [])[0].title;
    expect(title("id-0")).toContain("「label-0」");
    rememberClosedPaneLabel("id-0", "latest");
    rememberClosedPaneLabel("id-200", "new");
    expect(title("id-0")).toContain("「latest」");
    expect(title("id-1")).toContain("(ID id-1)");
    expect(title("id-2")).toContain("「label-2」");
    rememberClosedPaneLabel("id-201", "newer");
    expect(title("id-2")).toContain("(ID id-2)");
    expect(title("id-201")).toContain("「newer」");
  });
});

describe("one row per process tree", () => {
  it("counts descendants and sums memory without touching unrelated processes", () => {
    const rows = [
      process({ pid: 3, parentPid: 2, memoryBytes: 4096 }),
      process({ pid: 2, parentPid: 1, memoryBytes: 2048 }),
      process(),
      process({ pid: 4, parentPid: 999, memoryBytes: 8192 }),
    ];
    const before = structuredClone(rows);
    const trees = getPaneProcessTrees(rows);
    expect(trees.map((tree) => tree.root.pid)).toEqual([1, 4]);
    expect(trees[0].descendants.map((row) => row.pid)).toEqual([2, 3]);
    expect(trees.map((tree) => tree.memoryBytes)).toEqual([7168, 8192]);
    expect(trees[1].descendants).toEqual([]);
    expect(rows).toEqual(before);
  });

  it("never joins processes from different pane groups", () => {
    const trees = getPaneProcessTrees([process(), process({ pid: 2, parentPid: 1, paneSessionId: "other" })]);
    expect(trees).toHaveLength(2);
    expect(trees.every((tree) => tree.descendants.length === 0)).toBe(true);
  });

  it("keeps cycles and their tails visible once, including self-parent cycles", () => {
    const trees = getPaneProcessTrees([
      process({ pid: 3, parentPid: 2 }),
      process({ pid: 1, parentPid: 2 }),
      process({ pid: 2, parentPid: 1 }),
      process({ pid: 4, parentPid: 4 }),
    ]);
    expect(trees).toHaveLength(2);
    expect(trees.map((tree) => tree.descendants.length)).toEqual([2, 0]);
    expect(trees.map((tree) => tree.memoryBytes)).toEqual([3072, 1024]);
    expect(trees.flatMap((tree) => [tree.root.pid, ...tree.descendants.map((row) => row.pid)]).sort()).toEqual([1, 2, 3, 4]);
  });
});

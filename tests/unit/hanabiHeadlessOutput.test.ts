import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetHeadlessBufferCacheForTests, readHeadlessBufferLines } from "../../src/components/terminal/headlessBuffer";
import { connectHanabiCelebrations } from "../../src/stores/hanabiCelebrationObserver";
import { replacePtyReadOwners } from "../../src/lib/ptyReadGeneration";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Workspace } from "../../src/types";

vi.mock("../../src/stores/liveTailStore", () => ({
  subscribeLiveTailObservations: () => () => {},
  acquireLiveTailConsumer: () => () => {},
}));
const owner = Symbol("hanabi-headless-test");
let release: (() => void) | undefined;
beforeEach(() => {
  __resetHeadlessBufferCacheForTests();
  replacePtyReadOwners(owner, new Set(["s"]));
  useWorkspaceListStore.setState({ workspaces: [{ id: "w", panes: [{ id: "p", tabs: [{ id: "t", sessionId: "s", type: "terminal" }] }] } as Workspace] });
});
afterEach(() => {
  release?.(); release = undefined;
  __resetHeadlessBufferCacheForTests(); replacePtyReadOwners(owner, new Set());
  useWorkspaceListStore.setState({ workspaces: [] });
});
it("detects a real headless-read merge after it scrolls beyond forty rows and after parser eviction", async () => {
  let now = 100;
  const celebrate = vi.fn();
  release = connectHanabiCelebrations(celebrate, () => now);
  let text = "Merged pull request #1\r\nbaseline\r\n";
  const read = () => readHeadlessBufferLines("s", async () => {
    const data = new TextEncoder().encode(text);
    return { data, startOffset: 0, endOffset: data.length, sessionEpoch: 1, sizeRevision: 1, cols: 100, rows: 40 };
  }, 40, { cols: 100, rows: 40 }, 1000, "observation");
  await read();
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(celebrate).not.toHaveBeenCalled();
  now = 200;
  text += "Updating abc123..def456\r\nFast-forward\r\n" + " src/example.ts | 3 +++\r\n".repeat(500);
  const rows = await read();
  expect(rows).toHaveLength(40);
  expect(rows.join("\n")).not.toContain("Fast-forward");
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(celebrate.mock.calls).toEqual([["merge"]]);
  await read();
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(celebrate).toHaveBeenCalledTimes(1);
  __resetHeadlessBufferCacheForTests();
  now = 20000;
  text += "Merged pull request #2\r\n" + "another file stat\r\n".repeat(100);
  await read();
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(celebrate.mock.calls).toEqual([["merge"], ["merge"]]);
});

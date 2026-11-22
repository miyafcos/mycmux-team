import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetHanabiCelebrationsForTests, connectHanabiCelebrations } from "../../src/stores/hanabiCelebrationObserver";
import { useSessionAttentionStore, type SessionAttention } from "../../src/stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { queueTerminalOutputObservation } from "../../src/stores/terminalObservationStore";
import type { Workspace } from "../../src/types";
vi.mock("../../src/stores/liveTailStore", () => ({
  subscribeLiveTailObservations: () => () => {},
  acquireLiveTailConsumer: () => () => {},
}));
let release: (() => void) | undefined;
afterEach(() => { release?.(); vi.useRealTimers(); useWorkspaceListStore.setState({ workspaces: [] }); });
it("retains merge dedup when resize releases and reconnects celebration observation", () => {
  vi.useFakeTimers();
  useWorkspaceListStore.setState({ workspaces: [{
    id: "w", panes: [{ id: "p", tabs: [{ id: "t", sessionId: "s", type: "terminal" }] }],
  } as Workspace] });
  let now = 100;
  const celebrate = vi.fn();
  release = connectHanabiCelebrations(celebrate, () => now);
  function queue(text: string, start: number) {
    const data = new TextEncoder().encode(text);
    queueTerminalOutputObservation({ sessionId: "s", epoch: 1, startOffset: start, endOffset: start + data.length, data, source: "live" });
    vi.runAllTimers();
    return start + data.length;
  }
  const success = "Merge made by the 'ort' strategy.\n";
  const end = queue(success, 0);
  expect(celebrate).toHaveBeenCalledTimes(1);
  // WinterNightBackground.resize -> syncActivity performs this release/connect
  // even while the scene remains visible and fireworks remain enabled.
  release();
  release = connectHanabiCelebrations(celebrate, () => now);
  now = 200; // still inside the intended 12-second cooldown
  queue("\x1b[H" + success + "$ ready\r\n", end);
  expect(celebrate).toHaveBeenCalledTimes(1);
});

beforeEach(() => {
  __resetHanabiCelebrationsForTests();
  useSessionAttentionStore.getState().resetForTests();
});

function ownedWorkspace() {
  useWorkspaceListStore.setState({ workspaces: [{
    id: "w", panes: [{ id: "p", tabs: [{ id: "t", sessionId: "s", type: "terminal" }] }],
  } as Workspace] });
}
function observe(celebrate: (kind: "merge" | "done") => void, now: () => number) {
  vi.useFakeTimers();
  ownedWorkspace();
  release = connectHanabiCelebrations(celebrate, now);
}
function reconnect(celebrate: (kind: "merge" | "done") => void, now: () => number) {
  release?.();
  release = connectHanabiCelebrations(celebrate, now);
}
function output(text: string, start: number, source: "live" | "snapshot" = "live", epoch = 1) {
  const data = new TextEncoder().encode(text);
  queueTerminalOutputObservation({ sessionId: "s", epoch, startOffset: start, endOffset: start + data.length, data, source });
  vi.runAllTimers();
  return start + data.length;
}
function status(kind: SessionAttention["kind"], epoch = 1) {
  const attention: SessionAttention = {
    sessionId: "s", sessionEpoch: epoch, kind, attentionId: kind, detail: null, sessionRevision: 1,
    uiState: kind === "done" ? "done" : "working", stateSince: 1, occurrenceOrder: 1,
  };
  useSessionAttentionStore.setState({ attentionBySession: { s: attention } });
}
const success = "Merge made by the 'ort' strategy.\n";

it("retains dedup through reconnect, a baseline snapshot, and a live reprint", () => {
  let now = 100;
  const celebrate = vi.fn();
  observe(celebrate, () => now);
  output(success, 0);
  expect(celebrate.mock.calls).toEqual([["merge"]]);
  reconnect(celebrate, () => now);
  now = 13000;
  const end = output(success, 0, "snapshot");
  expect(celebrate).toHaveBeenCalledTimes(1);
  output("\x1b[H" + success + "$ ready\r\n", end);
  expect(celebrate).toHaveBeenCalledTimes(1);
});
it.each(["live", "snapshot"] as const)("celebrates a different PR in %s after reconnect once twelve seconds have elapsed", source => {
  let now = 100;
  const celebrate = vi.fn();
  observe(celebrate, () => now);
  const end = output("Merged pull request #1\n", 0);
  expect(celebrate.mock.calls).toEqual([["merge"]]);
  reconnect(celebrate, () => now);
  now = 12100;
  output("Merged pull request #2\n", end, source);
  expect(celebrate.mock.calls).toEqual([["merge"], ["merge"]]);
});
it("preserves the twelve-second merge cooldown and consumed successes across reconnects", () => {
  let now = 100;
  const celebrate = vi.fn();
  observe(celebrate, () => now);
  let end = output("Merged pull request #1\n", 0);
  reconnect(celebrate, () => now);
  now = 12099;
  end = output("Merged pull request #2\n", end);
  expect(celebrate).toHaveBeenCalledTimes(1);
  reconnect(celebrate, () => now);
  now = 12100;
  end = output("Merged pull request #3\n", end);
  expect(celebrate).toHaveBeenCalledTimes(2);
  now = 30000;
  output("Merged pull request #2\n", end);
  expect(celebrate).toHaveBeenCalledTimes(2);
});
it("discards merge history and cooldown on a new output epoch after reconnect", () => {
  let now = 100;
  const celebrate = vi.fn();
  observe(celebrate, () => now);
  output(success, 0);
  expect(celebrate).toHaveBeenCalledTimes(1);
  reconnect(celebrate, () => now);
  now = 200;
  output(success, 0, "live", 2);
  expect(celebrate.mock.calls).toEqual([["merge"], ["merge"]]);
});
it("preserves the 3.5-second done cooldown across reconnects", () => {
  let now = 100;
  const celebrate = vi.fn();
  observe(celebrate, () => now);
  status("none"); status("done");
  expect(celebrate.mock.calls).toEqual([["done"]]);
  reconnect(celebrate, () => now);
  now = 200;
  status("none"); status("done");
  expect(celebrate).toHaveBeenCalledTimes(1);
  now = 3599;
  status("none"); status("done");
  expect(celebrate).toHaveBeenCalledTimes(1);
  now = 3600;
  status("none"); status("done");
  expect(celebrate.mock.calls).toEqual([["done"], ["done"]]);
});
it("discards the done cooldown on a new attention epoch after reconnect", () => {
  let now = 100;
  const celebrate = vi.fn();
  observe(celebrate, () => now);
  status("none"); status("done");
  reconnect(celebrate, () => now);
  now = 200;
  status("none", 2); status("done", 2);
  expect(celebrate.mock.calls).toEqual([["done"], ["done"]]);
});
it("cleans closed terminal history while observation is active", () => {
  let now = 100;
  const celebrate = vi.fn();
  observe(celebrate, () => now);
  output(success, 0);
  useWorkspaceListStore.setState({ workspaces: [] });
  ownedWorkspace();
  now = 200;
  output(success, 0);
  expect(celebrate.mock.calls).toEqual([["merge"], ["merge"]]);
});
it("sweeps terminals closed while disconnected at the next connection", () => {
  let now = 100;
  const celebrate = vi.fn();
  observe(celebrate, () => now);
  output(success, 0);
  release?.();
  release = undefined;
  useWorkspaceListStore.setState({ workspaces: [] });
  release = connectHanabiCelebrations(celebrate, () => now);
  ownedWorkspace();
  now = 200;
  output(success, 0);
  expect(celebrate.mock.calls).toEqual([["merge"], ["merge"]]);
});

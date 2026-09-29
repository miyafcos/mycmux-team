import { expect, it } from "vitest";
import { validateTerminalState } from "../../scripts/perf/capture-terminal-state.mjs";

const state = { panes: [{ id: "pane", activeTabId: "tab", tabs: [{ id: "tab", type: "terminal", sessionId: "active" }] }] };

it("rejects stale visible terminals and terminals painted inside hidden panes", () => {
  const snapshot = (visible: boolean, sessionId: string) => ({ detached: null,
    panes: [{ paneId: "pane", visible, terminals: [{ visible: true, sessionId }] }] });
  expect(validateTerminalState(state, snapshot(true, "active"))).toEqual([]);
  expect(validateTerminalState(state, snapshot(true, "old"))).toHaveLength(1);
  expect(validateTerminalState(state, snapshot(false, "active"))).toHaveLength(1);
});

it("requires the independently expected detached session instead of accepting an empty pane list", () => {
  const dom = { panes: [], detached: { terminals: [{ sessionId: "child", visible: true }] } };
  expect(validateTerminalState(state, dom, "child")).toEqual([]);
  expect(validateTerminalState(state, dom, "wrong")).toHaveLength(1);
  expect(validateTerminalState(state, dom)).toHaveLength(1);
  expect(validateTerminalState(state, { panes: [], detached: null })).toHaveLength(1);
});

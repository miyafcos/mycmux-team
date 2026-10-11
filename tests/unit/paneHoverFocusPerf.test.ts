// @vitest-environment jsdom
import { setup, cleanup, pane, workspace, Surface, root, host, mocks, pointer, field } from "./paneHoverFocusHarness";
import { act, Fragment, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance as measurementClock } from "node:perf_hooks";
import * as decisions from "../../src/lib/paneHoverFocus";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";

beforeEach(() => setup()); afterEach(cleanup);
function snapshots(): decisions.PaneHoverSnapshot[] {
  return Array.from({ length: 12 }, (_, i) => ({ mode: "hover", target: { workspaceId: "w", paneId: `p${i}`,
    tabId: `t${i}`, sessionId: `s${i}`, surface: {}, kind: "terminal" }, activePaneId: "a", focusRevision: 0,
    layoutRevision: 0, zoomedPaneId: null, blockerRevision: 0, windowFocused: true, documentVisible: true,
    connected: true, visible: true, samePane: false, dragging: false, captured: false, blocked: false,
    editorFocused: false, selected: false }));
}

describe("hover focus performance and resource contract", () => {
  it("P01 measures 12 snapshots, 1000 moves x 10 batches after warmup", () => {
    const facts = snapshots();
    const run = (worstCase: boolean) => {
      const states = facts.map(() => decisions.createPaneHoverState());
      const events = facts.map((snapshot) => ({ type: "move" as const, now: 0, snapshot, pointerId: 1,
        x: 0, y: 20, movementX: 1, pointerType: "mouse", buttons: 0, modified: false }));
      const batch = () => {
        for (let i = 0; i < 1000; i++) {
          const indexes = worstCase ? 12 : 1;
          for (let j = 0; j < indexes; j++) {
            const index = worstCase ? j : i % 12;
            const event = events[index]; event.x = i; event.now = i;
            states[index] = decisions.decidePaneHoverFocus(states[index], event).state;
          }
        }
      };
      for (let i = 0; i < 3; i++) batch();
      const batches: number[] = [];
      for (let i = 0; i < 10; i++) { const start = measurementClock.now(); batch(); batches.push(measurementClock.now() - start); }
      const calls = 1000 * 10 * (worstCase ? 12 : 1), totalMs = batches.reduce((a, b) => a + b, 0);
      return { label: worstCase ? "12-target worst case" : "one-candidate runtime", calls, totalMs,
        meanMsPerCall: totalMs / calls, maxBatchMs: Math.max(...batches), batchMs: batches };
    };
    const measurements = [run(false), run(true)];
    process.stdout.write(`P01 ${JSON.stringify(measurements)}\n`);
    for (const m of measurements) expect(m.meanMsPerCall).toBeLessThan(0.1);
  });

  it("P02 dispatches 1000 actual moves in each sequence on 12 surfaces without renders or writes", async () => {
    const add = vi.spyOn(EventTarget.prototype, "addEventListener"), remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const decide = vi.spyOn(decisions, "decidePaneHoverFocus");
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const nativeSet = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
    const live = new Set<number>(); let maxLive = 0, arms = 0;
    vi.spyOn(window, "setTimeout").mockImplementation((fn: any, delay?: number, ...args: any[]) => {
      const owned = fn?.name === "paneHoverFocusDwell";
      let id: number;
      id = nativeSet(typeof fn === "function" ? () => { live.delete(id); fn(...args); } : fn, delay);
      if (owned) { live.add(id); arms++; maxLive = Math.max(maxLive, live.size); }
      return id;
    });
    vi.spyOn(window, "clearTimeout").mockImplementation((id) => { live.delete(id!); nativeClear(id); });
    const panes = Array.from({ length: 12 }, (_, i) => pane(i === 0 ? "a" : `s${i}`));
    useWorkspaceListStore.setState({ workspaces: [workspace(panes)], activeWorkspaceId: "w" });
    await act(async () => { root.render(createElement(Fragment, null, ...panes.map((p) => createElement(Surface, { key: p.id, p })))); });
    const roots = [...host.querySelectorAll<HTMLElement>("[data-pane-hover-focus-surface]")];
    const ownMoves = (calls: any[][]) => calls.filter(([type, fn]) => type === "pointermove" && fn.name === "paneHoverFocusListener");
    expect(roots).toHaveLength(12); expect(ownMoves(add.mock.calls)).toHaveLength(1);
    const results: unknown[] = [];
    for (const sequence of ["same", "between", "blocked", "click"] as const) {
      window.dispatchEvent(new Event("mycmux:terminal-layout-change"));
      let editor: HTMLElement | undefined;
      if (sequence === "blocked") editor = field();
      if (sequence === "click") await act(async () => { useSettingsStore.getState().setPaneFocusMode("click"); });
      const renders = mocks.renders, writes = storage.mock.calls.length, decideCalls = decide.mock.calls.length,
        listenerAdds = ownMoves(add.mock.calls).length, oldArms = arms;
      const start = measurementClock.now();
      await act(async () => {
        for (let i = 0; i < 1000; i++) pointer(sequence === "between" ? roots[1 + i % 11] : roots[1], "pointermove", { clientX: i + 1 });
      });
      const totalMs = measurementClock.now() - start;
      expect(mocks.renders).toBe(renders); expect(storage.mock.calls).toHaveLength(writes);
      expect(ownMoves(add.mock.calls)).toHaveLength(listenerAdds); expect(maxLive).toBeLessThanOrEqual(1);
      if (sequence === "click") { expect(decide.mock.calls).toHaveLength(decideCalls); expect(arms).toBe(oldArms); expect(live.size).toBe(0); }
      else expect(decide.mock.calls.length - decideCalls).toBe(1000);
      if (sequence === "blocked") expect(arms).toBe(oldArms);
      results.push({ sequence, dispatches: 1000, totalMs, meanMsPerDispatch: totalMs / 1000,
        decideCalls: decide.mock.calls.length - decideCalls, arms: arms - oldArms,
        extraRenders: mocks.renders - renders, extraWrites: storage.mock.calls.length - writes });
      editor?.remove();
    }
    expect(ownMoves(remove.mock.calls)).toHaveLength(1); expect(maxLive).toBe(1);
    process.stdout.write(`P02 ${JSON.stringify({ surfaces: 12, maxLiveDwellTimers: maxLive, results })}\n`);
  });
});

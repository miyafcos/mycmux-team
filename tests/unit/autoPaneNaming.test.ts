import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAutoPaneNamingScheduler, AUTO_PANE_NAMING_INTERVAL_MS, buildAutoPaneNamingSignature } from "../../src/lib/autoPaneNaming";
import { identitiesForScan } from "../../src/lib/paneEvidence";
import { buildLocalGroupingScan } from "../../src/components/layout/groupingLocalPlan";
import type { Workspace } from "../../src/types";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
const schedulers: ReturnType<typeof createAutoPaneNamingScheduler>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { schedulers.forEach(s => s.stop()); schedulers.length = 0; vi.useRealTimers(); });
async function setup() {
  const workspaces: Workspace[] = ["one", "two"].map(id => ({ id, name: id, status: "running", createdAt: 0, gridTemplateId: "1x1",
    panes: [{ id: "p" + id, activeTabId: id, sessionId: "s" + id, agentId: "shell-starter", tabs: [
      { id, sessionId: "s" + id, agentId: "shell-starter", label: "dispatch-make-" + id },
    ] }] }));
  let enabled = true; let listener = () => {};
  const scan = await buildLocalGroupingScan({ workspaces, metadata: {}, attentionByTabId: {}, now: 0 });
  scan.tabs.forEach(t => { t.taskTitle = "Task " + t.id; });
  const deps = {
    enabled: () => enabled, scan: vi.fn(async () => structuredClone(scan)),
    identify: (value: typeof scan) => identitiesForScan(value, []),
    workspaces: () => workspaces, subscribe: (fn: () => void) => { listener = fn; return vi.fn(); },
    setDisplayName: vi.fn((w: string, p: string, id: string, name: string | undefined) => {
      const tab = workspaces.find(x => x.id === w)!.panes.find(x => x.id === p)!.tabs.find(x => x.id === id)!;
      tab.displayName = name; tab.displayNameSource = "auto";
    }), setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const scheduler = createAutoPaneNamingScheduler(deps); schedulers.push(scheduler);
  return { workspaces, scan, deps, scheduler, notify: () => listener(), disable: () => { enabled = false; listener(); } };
}
it("writes only changed display names across all workspaces with AI disabled", async () => {
  useAiSettingsStore.setState({ aiEnabled: false });
  const h = await setup(); const labels = h.workspaces.map(w => w.panes[0].tabs[0].label);
  await h.scheduler.runNow(); await h.scheduler.runNow();
  expect(h.deps.setDisplayName).toHaveBeenCalledTimes(2);
  expect(h.workspaces.map(w => w.panes[0].tabs[0].displayName)).toEqual(["Task one", "Task two"]);
  expect(h.workspaces.map(w => w.panes[0].tabs[0].label)).toEqual(labels);
});
it("updates on title changes but ignores tail changes", async () => {
  const h = await setup(); await h.scheduler.runNow();
  h.scan.tabs[0].tail = ["new screen output"]; await h.scheduler.runNow();
  expect(h.deps.setDisplayName).toHaveBeenCalledTimes(2);
  h.scan.tabs[0].taskTitle = "Changed"; await h.scheduler.runNow();
  expect(h.deps.setDisplayName).toHaveBeenCalledTimes(3);
  expect(buildAutoPaneNamingSignature(h.scan.tabs[0])).not.toContain("new screen output");
});
it("retains manual and readable labels, and leaves no-material names alone", async () => {
  const h = await setup();
  Object.assign(h.scan.tabs[0], { label: "手動名", labelSource: "user" });
  Object.assign(h.workspaces[0].panes[0].tabs[0], { label: "手動名", labelSource: "user" });
  Object.assign(h.scan.tabs[1], { label: "Old summary", labelSource: "ai", taskTitle: null });
  Object.assign(h.workspaces[1].panes[0].tabs[0], { label: "Old summary", labelSource: "ai" });
  await h.scheduler.runNow();
  expect(h.deps.setDisplayName).toHaveBeenCalledTimes(1);
  expect(h.deps.setDisplayName).toHaveBeenCalledWith("one", "pone", "one", "手動名");
});
it("takes automatic display names away when the setting is switched off", async () => {
  const h = await setup(); h.scheduler.start(); await h.scheduler.runNow();
  expect(h.workspaces.map(w => w.panes[0].tabs[0].displayName)).toEqual(["Task one", "Task two"]);
  h.disable();
  expect(h.deps.setDisplayName).toHaveBeenCalledWith("one", "pone", "one", undefined);
  expect(h.deps.setDisplayName).toHaveBeenCalledWith("two", "ptwo", "two", undefined);
  expect(h.workspaces.map(w => w.panes[0].tabs[0].displayName)).toEqual([undefined, undefined]);
  expect(h.workspaces.map(w => w.panes[0].tabs[0].label)).toEqual(["dispatch-make-one", "dispatch-make-two"]);
});
it("disables updates and stops all timers", async () => {
  const h = await setup(); h.disable(); await h.scheduler.runNow(); expect(h.deps.scan).not.toHaveBeenCalled();
  h.scheduler.stop(); await vi.advanceTimersByTimeAsync(AUTO_PANE_NAMING_INTERVAL_MS * 2); expect(h.deps.scan).not.toHaveBeenCalled();
});
it("discards stale material and stopped runs, without overlapping reads", async () => {
  const h = await setup(); let release!: (scan: typeof h.scan) => void;
  h.deps.scan.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const running = h.scheduler.runNow(); await h.scheduler.runNow();
  expect(h.deps.scan).toHaveBeenCalledTimes(1);
  h.notify(); h.scheduler.stop(); release(h.scan); await running;
  expect(h.deps.setDisplayName).not.toHaveBeenCalled();
});
it("does not apply a title to a replaced session", async () => {
  const h = await setup(); h.workspaces[0].panes[0].tabs[0].sessionId = "replacement";
  await h.scheduler.runNow(); expect(h.deps.setDisplayName).toHaveBeenCalledTimes(1);
  expect(h.deps.setDisplayName.mock.calls[0][2]).toBe("two");
});
it("starts with the default timers even where they reject a foreign `this` (WebView2)", () => {
  // Node's timers accept any receiver; a browser's throw "Illegal invocation". v0.80.1 never
  // showed its window because the default dependencies called them as `deps.setInterval()`.
  const strict = <T extends (...args: never[]) => unknown>(name: string, fn: T) =>
    function (this: unknown, ...args: Parameters<T>) {
      if (this !== globalThis && this !== undefined) throw new TypeError(`Illegal invocation: ${name}`);
      return fn(...args);
    };
  const calls: string[] = [];
  vi.stubGlobal("setTimeout", strict("setTimeout", () => { calls.push("setTimeout"); return 1; }));
  vi.stubGlobal("clearTimeout", strict("clearTimeout", () => { calls.push("clearTimeout"); }));
  vi.stubGlobal("setInterval", strict("setInterval", () => { calls.push("setInterval"); return 2; }));
  vi.stubGlobal("clearInterval", strict("clearInterval", () => { calls.push("clearInterval"); }));
  useSettingsStore.setState({ autoPaneNamingEnabled: true });
  try {
    const scheduler = createAutoPaneNamingScheduler();
    expect(() => scheduler.start()).not.toThrow();
    expect(() => scheduler.stop()).not.toThrow();
    expect(calls).toEqual(expect.arrayContaining(["setInterval", "setTimeout", "clearTimeout", "clearInterval"]));
  } finally {
    vi.unstubAllGlobals();
  }
});
it("keeps a naming fault inside the store listener that woke the scheduler", async () => {
  // A store listener that throws hands the exception to whoever changed the store, which then
  // stops half-way (the launcher and drag and drop in v0.80.1-v0.80.2).
  const h = await setup(); h.scheduler.start();
  const failure = new TypeError("Illegal invocation");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  h.deps.setTimeout = (() => { throw failure; }) as unknown as typeof setTimeout;
  try {
    expect(() => h.notify()).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("auto pane naming"), failure);
  } finally { consoleError.mockRestore(); }
});

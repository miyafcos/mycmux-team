import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalRendererBudget } from "../../src/components/terminal/terminalRendererBudget";
afterEach(() => vi.useRealTimers());

it("rendererBudget_preservesVisibleOldestWhenHiddenAvailable", () => {
  const budget = new TerminalRendererBudget<object>(2);
  const visible = {}, hidden = {}, next = {};
  const releaseVisible = vi.fn(), releaseHidden = vi.fn();
  budget.reserve(visible, releaseVisible, () => ({ visible: true, focused: false }));
  budget.reserve(hidden, releaseHidden, () => ({ visible: false, focused: false }));
  budget.reserve(next, vi.fn());
  expect(releaseHidden).toHaveBeenCalledOnce(); expect(releaseVisible).not.toHaveBeenCalled();
});
it("rendererBudget_evictsVisibleOnlyWhenNoHiddenLeft", () => {
  const budget = new TerminalRendererBudget<object>(2);
  const focused = {}, visible = {}, next = {};
  const releaseFocused = vi.fn(), releaseVisible = vi.fn();
  budget.reserve(focused, releaseFocused, () => ({ visible: true, focused: true }));
  budget.reserve(visible, releaseVisible, () => ({ visible: true, focused: false }));
  budget.reserve(next, vi.fn(), () => ({ visible: true, focused: false }));
  expect(releaseVisible).toHaveBeenCalledOnce(); expect(releaseFocused).not.toHaveBeenCalled();
});
it("renderer budget touches paint/focus recency within a priority tier and retains failed ownership", () => {
  const budget = new TerminalRendererBudget<object>(2);
  const a = {}, b = {}, c = {};
  const releaseA = vi.fn(() => false), releaseB = vi.fn();
  budget.reserve(a, releaseA); budget.reserve(b, releaseB); budget.touch(a);
  expect(budget.reserve(c, vi.fn())).toBe(true);
  expect(releaseB).toHaveBeenCalledOnce(); expect(releaseA).not.toHaveBeenCalled();
  const blocked = new TerminalRendererBudget<object>(1);
  blocked.reserve(a, releaseA);
  expect(blocked.reserve(b, vi.fn())).toBe(false); expect(blocked.size).toBe(1);
});

class FakeTerm {
  rows = 24; cols = 80; renderer = "dom"; output = ""; loadThrows = 0; disposeThrows = false;
  covered = false;
  hiddenByPane = false;
  element = { getBoundingClientRect: () => ({ width: 800, height: 480 }), checkVisibility: () => true,
    closest: (selector: string) => {
      if (selector === "[inert]" && this.covered) return {};
      if (selector === "[data-terminal-pane-hidden]" && this.hiddenByPane) return {};
      return null;
    } };
  textarea = {};
  addon?: { term?: FakeTerm; loss?: () => void };
  refresh = vi.fn();
  loadAddon(addon: { term?: FakeTerm; loss?: () => void }) {
    addon.term = this; this.addon = addon;
    if (this.loadThrows-- > 0) throw new TypeError("private output is never logged");
    this.renderer = "webgl";
  }
  write(value: string) { this.output += value; this.refresh(); }
}
function fixture() {
  const events = vi.fn();
  const source = readFileSync(new URL("../../src/components/terminal/XTermWrapper.tsx", import.meta.url), "utf8");
  // Execute the production lifecycle itself; do not reimplement its retry logic.
  const lifecycle = source.slice(source.indexOf("type WebglRendererState ="), source.indexOf("// Flush per-session write stats"));
  const js = ts.transpileModule(lifecycle, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const dispose = vi.fn();
  let failRegistration = false;
  class Addon {
    term?: FakeTerm; loss?: () => void;
    onContextLoss(loss: () => void) {
      if (failRegistration) throw new Error("registration failed");
      this.loss = loss;
      return { dispose: () => {} };
    }
    dispose() {
      dispose();
      if (this.term?.disposeThrows) throw new Error("private path");
      if (this.term) this.term.renderer = "dom";
    }
  }
  const state = { webgl: "never", webglLostAt: null };
  const create = new Function("TerminalRendererBudget", "WebglAddon", "useSettingsStore", "diagStatsFor",
    "recordRenderer", "recordWebglContextLoss", "reportTerminalDiagnostic", "terminalDiagnosticId", "diagnosticException",
    "document", "getComputedStyle", js + `; return { enableWebglRenderer, cancelWebglRetry, actualTerminalRenderer, webglRetryCounts, webglRendererBudget, repaintTerminalDisplay,
      disposeFinal: (session, term) => typeof disposeTerminalRenderer === "function"
        ? disposeTerminalRenderer(session, term) : rendererDisposer(session, term)() };`);
  const api = create(TerminalRendererBudget, Addon, { getState: () => ({ terminalRenderer: "webgl" }) }, () => state,
    vi.fn(), vi.fn(), events, () => 1, () => "error",
    { visibilityState: "visible", hasFocus: () => true, activeElement: null }, () => ({ visibility: "visible" })) as {
      enableWebglRenderer: (id: string, term: FakeTerm) => void;
      repaintTerminalDisplay: (id: string, term: FakeTerm) => void;
      cancelWebglRetry: (term: FakeTerm) => void;
      actualTerminalRenderer: (term: FakeTerm) => string;
      webglRetryCounts: WeakMap<FakeTerm, number>;
      webglRendererBudget: TerminalRendererBudget<FakeTerm>;
      disposeFinal: (session: string, term: FakeTerm) => void;
    };
  return { ...api, events, dispose, failRegistration: () => { failRegistration = true; } };
}
it("webglRecovery_loadThrowUsesRemainingBudget", async () => {
  vi.useFakeTimers(); const f = fixture(); const term = new FakeTerm(); term.loadThrows = 2;
  f.enableWebglRenderer("abcdef12", term); expect(term.renderer).toBe("dom");
  await vi.advanceTimersByTimeAsync(2_000); expect(f.webglRetryCounts.get(term)).toBe(1);
  await vi.advanceTimersByTimeAsync(8_000); expect(term.renderer).toBe("webgl");
  expect(vi.getTimerCount()).toBe(0);
});
it("webglRecovery_cachedReturnRearmsCancelledRetry", async () => {
  vi.useFakeTimers(); const f = fixture(); const term = new FakeTerm(); term.loadThrows = 1;
  f.enableWebglRenderer("abcdef12", term); f.cancelWebglRetry(term);
  expect(vi.getTimerCount()).toBe(0);
  f.enableWebglRenderer("abcdef12", term);
  await vi.advanceTimersByTimeAsync(2_000); expect(term.renderer).toBe("webgl");
  expect(vi.getTimerCount()).toBe(0);
});
it("webglRecovery_exhaustionLeavesWorkingDom", async () => {
  vi.useFakeTimers(); const f = fixture(); const term = new FakeTerm(); term.loadThrows = 10;
  f.enableWebglRenderer("abcdef12", term);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(f.webglRetryCounts.get(term)).toBe(3); expect(vi.getTimerCount()).toBe(0);
  expect(f.actualTerminalRenderer(term)).toBe("dom");
  term.write("after exhaustion"); expect(term.output).toBe("after exhaustion");
  expect(term.refresh).toHaveBeenCalled();
  f.enableWebglRenderer("abcdef12", term); expect(vi.getTimerCount()).toBe(0);
});
it("a failed addon disposal is unknown, never reported as a ready DOM renderer", () => {
  vi.useFakeTimers(); const f = fixture(); const term = new FakeTerm();
  f.enableWebglRenderer("abcdef12", term); term.disposeThrows = true; term.addon!.loss!();
  expect(f.actualTerminalRenderer(term)).toBe("unknown");
  expect(f.events.mock.calls.some(call => call[1] === "dispose-result" && call[4].dispose_ok === 0 && call[5].actual === "unknown")).toBe(true);
});

it("WebGL context loss switches to DOM and issues a full product refresh", () => {
  vi.useFakeTimers();
  const f = fixture(), term = new FakeTerm();
  f.enableWebglRenderer("abcdef12", term);
  expect(term.renderer).toBe("webgl");
  term.addon!.loss!();
  expect(term.renderer).toBe("dom");
  expect(term.refresh).toHaveBeenCalledExactlyOnceWith(0, term.rows - 1);
  expect(f.actualTerminalRenderer(term)).toBe("dom");
});

it("repainting a DOM terminal preserves the scheduled WebGL context loss retry", async () => {
  vi.useFakeTimers();
  const f = fixture(), term = new FakeTerm();
  f.enableWebglRenderer("abcdef12", term);
  term.addon!.loss!();
  expect(term.renderer).toBe("dom");
  term.refresh.mockClear();
  f.repaintTerminalDisplay("abcdef12", term);
  expect(term.refresh).toHaveBeenCalledExactlyOnceWith(0, term.rows - 1);

  await vi.advanceTimersByTimeAsync(2_000);
  expect(term.renderer).toBe("webgl");
});

it("final disposal releases a budget slot even when addon disposal throws", () => {
  const f = fixture(), term = new FakeTerm();
  f.enableWebglRenderer("abcdef12", term);
  term.disposeThrows = true;
  f.disposeFinal("abcdef12", term);
  expect(f.webglRendererBudget.size).toBe(0);
});

it("an addon is disposed and DOM repainted when context loss registration throws", () => {
  vi.useFakeTimers();
  const f = fixture(), term = new FakeTerm();
  f.failRegistration();
  f.enableWebglRenderer("abcdef12", term);
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(term.refresh).toHaveBeenCalledExactlyOnceWith(0, term.rows - 1);
  expect(f.webglRendererBudget.size).toBe(0);
});

it("conversation-covered requests cannot evict visible renderers", () => {
  const f = fixture();
  const incumbents = Array.from({ length: 12 }, () => new FakeTerm());
  for (const term of incumbents) f.enableWebglRenderer("abcdef12", term);
  const covered = new FakeTerm();
  covered.covered = true;
  f.enableWebglRenderer("11111111", covered);
  expect(covered.renderer).toBe("dom");
  expect(incumbents.map(term => term.renderer)).toEqual(Array(12).fill("webgl"));
  expect(f.events.mock.calls.find(call => call[1] === "budget-denied")?.[4]).toMatchObject({ budget_protected: 1 });
});

it("requests from behind a zoomed pane cannot evict visible renderers", () => {
  const f = fixture();
  const incumbents = Array.from({ length: 12 }, () => new FakeTerm());
  for (const term of incumbents) f.enableWebglRenderer("abcdef12", term);
  const behind = new FakeTerm();
  behind.hiddenByPane = true;
  f.enableWebglRenderer("11111111", behind);

  expect(behind.renderer).toBe("dom");
  expect(incumbents.every(term => term.renderer === "webgl")).toBe(true);
  expect(f.events.mock.calls.find(call => call[1] === "budget-denied")?.[4]).toMatchObject({ budget_protected: 1 });
});

it("failed eviction attempts are excluded from successful eviction diagnostics", () => {
  const f = fixture();
  const incumbents = Array.from({ length: 12 }, () => new FakeTerm());
  for (const term of incumbents) {
    f.enableWebglRenderer("abcdef12", term);
    term.disposeThrows = true;
  }
  const refused = new FakeTerm();
  f.enableWebglRenderer("11111111", refused);
  expect(refused.renderer).toBe("dom");
  expect(f.events.mock.calls.find(call => call[1] === "budget-denied")?.[4]).toMatchObject({ budget_protected: 0 });
  expect(f.events.mock.calls.filter(call => call[1] === "budget-evict")).toHaveLength(0);
  incumbents[1].disposeThrows = false;
  const admitted = new FakeTerm();
  f.enableWebglRenderer("22222222", admitted);
  expect(admitted.renderer).toBe("webgl");
  expect(f.events.mock.calls.filter(call => call[1] === "budget-evict")).toHaveLength(1);
});

it.each([false, true])("rendererBudget_hiddenRequesterNeverEvictsVisibleWhenAllVisible (requester visible=%s)", visible => {
  const budget = new TerminalRendererBudget<object>();
  const readIncumbent = vi.fn(() => ({ visible: true, focused: false }));
  const readRequester = vi.fn(() => ({ visible, focused: false }));
  const release = Array.from({ length: 12 }, () => vi.fn());
  for (const dispose of release) expect(budget.reserve({}, dispose, readIncumbent)).toBe(true);
  expect(readIncumbent).not.toHaveBeenCalled();
  expect(budget.reserve({}, vi.fn(), readRequester)).toBe(visible);
  expect(release.reduce((n, fn) => n + fn.mock.calls.length, 0)).toBe(visible ? 1 : 0);
  if (visible) expect(release[0]).toHaveBeenCalledOnce();
  expect(readRequester).toHaveBeenCalledOnce();
  expect(readIncumbent).toHaveBeenCalledTimes(12);
  expect(budget.size).toBe(12);
});

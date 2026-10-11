// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusController, createFocusControllerCore, applyStructuralActivation } from "../../src/lib/focusController";
import { useUiStore } from "../../src/stores/uiStore";

let frames: FrameRequestCallback[];
const focus = vi.fn();
let contains = false;
beforeEach(() => {
  vi.useFakeTimers(); frames = []; contains = false; focus.mockReset();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => { frames.push(fn); return frames.length; });
  useUiStore.setState({ activePaneId: "a", focusRevision: 0 });
  focusController.registerTerminal("b", { focus, containsActiveElement: () => contains });
});
afterEach(() => {
  for (const id of ["a", "b", "c"]) focusController.clearSession(id);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren();
});
function frame() { const next = frames.splice(0); for (const fn of next) fn(0); }
function first() { vi.advanceTimersByTime(0); frame(); }

describe("hover focus controller exception", () => {
  it.each(["modal", "editor", "IME", "blur", "click-mode"])("C01 guards the first async focus against %s", () => {
    let allowed = true;
    const guard = vi.fn(() => allowed);
    focusController.request("hover", { sessionId: "b", focusGuard: guard });
    expect(useUiStore.getState().activePaneId).toBe("a");
    allowed = false; first(); vi.runAllTimers(); frame();
    expect(guard).toHaveBeenCalledOnce(); expect(focus).not.toHaveBeenCalled();
    expect(useUiStore.getState().activePaneId).toBe("a"); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, "throw"])("C02 guards every retry and terminates on %s", (next) => {
    let allowed = true;
    focusController.commit("hover", "b", { focusGuard: () => {
      if (!allowed && next === "throw") throw new Error("stale guard");
      return allowed;
    } });
    first(); expect(focus).toHaveBeenCalledOnce();
    allowed = false; vi.advanceTimersByTime(16); frame(); vi.runAllTimers(); frame();
    expect(focus).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(useUiStore.getState().activePaneId).toBe("a");
  });
  it.each(["keyboard", "pointer", "structural", "direct"])("C03 accepts its own revision then stops after %s selection", (source) => {
    let ownedRevision = 0;
    const guard = () => ["a", "b"].includes(useUiStore.getState().activePaneId!) && useUiStore.getState().focusRevision === ownedRevision;
    contains = true;
    focusController.commit("hover", "b", { focusGuard: guard, commitHoverSelection: (commit) => {
      commit(); ownedRevision = useUiStore.getState().focusRevision;
    } });
    expect(useUiStore.getState().activePaneId).toBe("a");
    first(); expect(ownedRevision).toBe(1); expect(focus).toHaveBeenCalledOnce();
    // A late old-renderer input starts recovery with this same hover guard.
    expect(focusController.shouldAcceptTerminalInput("a")).toBe(false);
    if (source === "direct") useUiStore.setState({ activePaneId: "c" });
    else if (source === "structural") applyStructuralActivation("c");
    else focusController.commit(source as "keyboard" | "pointer", "c", { focus: false });
    vi.advanceTimersByTime(16); frame();
    expect(focus).toHaveBeenCalledOnce(); expect(useUiStore.getState().activePaneId).toBe("c");
  });
  it("C04 clears old pending pointer/wheel only for hover, accepts text and IME input", () => {
    let active = "a";
    let acquired: (() => void) | undefined;
    const core = createFocusControllerCore({ commit: (id) => { active = id!; }, getActiveSessionId: () => active,
      focusSession: (_id, options) => { acquired = options?.onFocused; } });
    const prime = () => {
      core.request("pointer", { sessionId: "c", action: "pending", focus: false });
      core.request("wheel", { sessionId: "b", previousSessionId: "a" });
    };
    prime(); core.request("keyboard", { sessionId: "a", focus: false });
    expect(core.state.pendingPointer).not.toBeNull(); expect(core.state.pendingWheel).not.toBeNull();
    core.request("hover", { sessionId: "b" });
    expect(core.state.pendingPointer).toBeNull(); expect(core.state.pendingWheel).toBeNull();
    expect(active).toBe("a"); expect(core.observeFocusIn("b")).toBe("pending-hover");
    acquired!(); expect(core.observeFocusIn("b")).toBe("active");
    for (const _text of ["x", "確定"]) {
      expect(core.shouldAcceptInput("b")).toBe(true); expect(core.shouldSuppressWheelInput("b")).toBe(false);
    }
    expect(core.shouldAcceptInput("c")).toBe(false);
  });
  it("C05 refuses unregistered hover before commit and after removal, with no fallback", () => {
    focusController.clearSession("b");
    const root = document.createElement("div"); root.dataset.sessionId = "b"; root.tabIndex = -1;
    const textarea = document.createElement("textarea"); textarea.className = "xterm-helper-textarea"; root.append(textarea); document.body.append(root);
    const fallback = vi.spyOn(textarea, "focus");
    focusController.commit("hover", "b"); first();
    expect(useUiStore.getState().activePaneId).toBe("a"); expect(fallback).not.toHaveBeenCalled();
    focusController.registerTerminal("b", { focus, containsActiveElement: () => true });
    focusController.commit("hover", "b"); focusController.clearSession("b"); first();
    expect(focus).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
    focusController.commit("programmatic", "b"); first(); expect(fallback).toHaveBeenCalledOnce();
  });
  it("C05 review: registry removal inside the guard cannot fall through to DOM fallback", () => {
    const root = document.createElement("div"); root.dataset.sessionId = "b";
    const textarea = document.createElement("textarea"); textarea.className = "xterm-helper-textarea";
    root.append(textarea); document.body.append(root); const fallback = vi.spyOn(textarea, "focus");
    focusController.commit("hover", "b", { focusGuard: () => { focusController.clearSession("b"); return true; } });
    first(); expect(fallback).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    expect(useUiStore.getState().activePaneId).toBe("a");
  });
});

describe("R4 hover rejection contract", () => {
  it.each(["request", "commit"] as const)("R4 %s reports each rejected public intent once without work", (entry) => {
    for (const intent of [{ sessionId: null }, { sessionId: "unregistered" }, { sessionId: "b", focus: false }]) {
      const aborted = vi.fn();
      const options = { ...intent, onHoverFocusAborted: aborted };
      if (entry === "request") focusController.request("hover", options);
      else focusController.commit("hover", options.sessionId, options);
      expect(aborted).toHaveBeenCalledOnce();
      first(); expect(focus).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
      expect(useUiStore.getState().activePaneId).toBe("a"); expect(useUiStore.getState().focusRevision).toBe(0);
    }
  });
  it.each(["pending", "abort", "observe", "suppress-tab-click"] as const)("R4 unsupported hover action %s ends the attempt without ordinary side effects", (action) => {
    const commit = vi.fn(), acquire = vi.fn(), aborted = vi.fn();
    const core = createFocusControllerCore({ commit, focusSession: acquire, getActiveSessionId: () => "a" });
    core.request("hover", { sessionId: "b", action, onHoverFocusAborted: aborted });
    expect(aborted).toHaveBeenCalledOnce(); expect(commit).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
    expect(core.state).toEqual({ pendingPointer: null, pendingWheel: null, suppressTabClickUntil: 0 });
  });
  it("R4 missing core focus implementation rejects rather than retaining acquisition", () => {
    const aborted = vi.fn(), commit = vi.fn();
    const core = createFocusControllerCore({ commit, getActiveSessionId: () => "a" });
    core.request("hover", { sessionId: "b", onHoverFocusAborted: aborted });
    expect(aborted).toHaveBeenCalledOnce(); expect(commit).not.toHaveBeenCalled();
    expect(core.observeFocusIn("b")).toBe("reconcile");
  });
  it("R4 composer rejection terminates a registered acquisition even with a permissive caller guard", () => {
    const composer = document.createElement("div"); composer.dataset.composerSession = "a";
    const textarea = document.createElement("textarea"); composer.append(textarea); document.body.append(composer); textarea.focus();
    const aborted = vi.fn();
    focusController.commit("hover", "b", { focusGuard: () => true, onHoverFocusAborted: aborted }); first();
    expect(aborted).toHaveBeenCalledOnce(); expect(focus).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(useUiStore.getState().activePaneId).toBe("a"); expect(document.activeElement).toBe(textarea);
  });
  it.each(["request", "commit"] as const)("R4 %s rejection isolates a throwing abort callback from the next click", (entry) => {
    const aborted = vi.fn(() => { throw new Error("rejected hover cleanup"); });
    expect(() => {
      if (entry === "request") focusController.request("hover", { sessionId: null, onHoverFocusAborted: aborted });
      else focusController.commit("hover", null, { onHoverFocusAborted: aborted });
    }).not.toThrow();
    expect(aborted).toHaveBeenCalledOnce();
    focusController.commit("tab-click", "c", { focus: false });
    expect(useUiStore.getState().activePaneId).toBe("c"); expect(focus).not.toHaveBeenCalled();
  });
});

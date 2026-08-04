import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const focusMocks = vi.hoisted(() => ({
  focusTerminalSoon: vi.fn(),
  isActiveTerminalInputTarget: vi.fn(() => true),
  refocusActiveTerminalIfNeeded: vi.fn(),
}));
const toastMocks = vi.hoisted(() => ({
  pushToast: vi.fn(() => "toast-1"),
  dismissToast: vi.fn(),
}));

vi.mock("../../src/components/terminal/terminalFocusHelpers", () => focusMocks);
vi.mock("../../src/stores/toastStore", () => ({
  useToastStore: {
    getState: () => toastMocks,
  },
}));

import {
  disposeSelectionCopyListener,
  registerSelectionCopyListener,
} from "../../src/components/terminal/terminalSelectionCopy";

type TestEvent = { button?: number };
type TestListener = (event: TestEvent) => void;

class TestMouseEvent {
  button: number;

  constructor(_type: string, init: { button?: number } = {}) {
    this.button = init.button ?? 0;
  }
}

class TestPointerEvent {
  button: number;

  constructor(_type: string, init: { button?: number } = {}) {
    this.button = init.button ?? 0;
  }
}

function addListener(
  listeners: Map<string, Set<TestListener>>,
  type: string,
  listener: EventListenerOrEventListenerObject,
): void {
  const callback = typeof listener === "function"
    ? listener as unknown as TestListener
    : listener.handleEvent.bind(listener) as unknown as TestListener;
  const existing = listeners.get(type) ?? new Set<TestListener>();
  existing.add(callback);
  listeners.set(type, existing);
}

function removeListener(
  listeners: Map<string, Set<TestListener>>,
  type: string,
  listener: EventListenerOrEventListenerObject,
): void {
  const callback = typeof listener === "function"
    ? listener as unknown as TestListener
    : listener.handleEvent.bind(listener) as unknown as TestListener;
  listeners.get(type)?.delete(callback);
}

function dispatch(listeners: Map<string, Set<TestListener>>, type: string, event: TestEvent): void {
  for (const listener of listeners.get(type) ?? []) {
    listener(event);
  }
}

function createSelectionHarness() {
  const windowListeners = new Map<string, Set<TestListener>>();
  const elementListeners = new Map<string, Set<TestListener>>();
  const fakeWindow = {
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => addListener(windowListeners, type, listener),
    removeEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => removeListener(windowListeners, type, listener),
    setTimeout: (callback: TimerHandler, delay?: number) =>
      globalThis.setTimeout(callback, delay) as unknown as number,
    clearTimeout: (timer: number) => globalThis.clearTimeout(timer),
  } as unknown as Window;
  const termElement = {
    ownerDocument: { defaultView: fakeWindow },
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => addListener(elementListeners, type, listener),
    removeEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => removeListener(elementListeners, type, listener),
  } as unknown as HTMLElement;
  let selection = "";
  let selectionChange: (() => void) | null = null;
  const term = {
    element: termElement,
    getSelection: () => selection,
    onSelectionChange: (listener: () => void) => {
      selectionChange = listener;
      return { dispose: vi.fn() };
    },
  } as unknown as Terminal;

  return {
    term,
    setSelection: (value: string) => {
      selection = value;
    },
    fireSelectionChange: () => selectionChange?.(),
    dispatchWindow: (type: string, event: TestEvent) =>
      dispatch(windowListeners, type, event),
    dispatchElement: (type: string, event: TestEvent) =>
      dispatch(elementListeners, type, event),
  };
}

describe("terminal selection auto-copy", () => {
  let registeredTerm: Terminal | null = null;
  let writeText: ReturnType<typeof vi.fn>;
  let execCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00Z"));
    focusMocks.focusTerminalSoon.mockReset();
    focusMocks.isActiveTerminalInputTarget.mockReset();
    focusMocks.isActiveTerminalInputTarget.mockReturnValue(true);
    focusMocks.refocusActiveTerminalIfNeeded.mockReset();
    toastMocks.pushToast.mockReset();
    toastMocks.pushToast.mockReturnValue("toast-1");
    toastMocks.dismissToast.mockReset();
    writeText = vi.fn().mockResolvedValue(undefined);
    execCommand = vi.fn().mockReturnValue(true);

    vi.stubGlobal("MouseEvent", TestMouseEvent);
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("document", {
      createElement: () => ({
        value: "",
        style: {},
        setAttribute: vi.fn(),
        select: vi.fn(),
      }),
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
      execCommand,
    });
  });

  afterEach(() => {
    disposeSelectionCopyListener(registeredTerm);
    registeredTerm = null;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const registerHarness = () => {
    const harness = createSelectionHarness();
    vi.stubGlobal("window", harness.term.element!.ownerDocument.defaultView);
    registerSelectionCopyListener(harness.term, "selection-test-session");
    registeredTerm = harness.term;
    return harness;
  };

  const flushCopyTimer = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
  };

  it("does not copy or toast a two-character selection", async () => {
    const harness = registerHarness();
    harness.setSelection("ab");
    harness.fireSelectionChange();
    harness.dispatchWindow("pointerup", new TestPointerEvent("pointerup", { button: 0 }));

    await flushCopyTimer();

    expect(writeText).not.toHaveBeenCalled();
    expect(toastMocks.pushToast).not.toHaveBeenCalled();
  });

  it("applies the two-character threshold to context-menu copying", async () => {
    const harness = registerHarness();
    harness.setSelection("ab");
    harness.fireSelectionChange();
    harness.dispatchElement("contextmenu", {});

    await flushCopyTimer();

    expect(writeText).not.toHaveBeenCalled();
    expect(toastMocks.pushToast).not.toHaveBeenCalled();
  });

  it("copies and toasts a three-character selection", async () => {
    const harness = registerHarness();
    harness.setSelection("abc");
    harness.fireSelectionChange();
    harness.dispatchWindow("pointerup", new TestPointerEvent("pointerup", { button: 0 }));

    await flushCopyTimer();

    expect(writeText).toHaveBeenCalledWith("abc");
    expect(toastMocks.pushToast).toHaveBeenCalledWith("コピーしました (3文字)", "info");
  });

  it("copies the last observed selection when output clears it before the timer", async () => {
    const harness = registerHarness();
    harness.setSelection("copied");
    harness.fireSelectionChange();
    harness.dispatchWindow("pointerup", new TestPointerEvent("pointerup", { button: 0 }));
    harness.setSelection("");

    await flushCopyTimer();

    expect(writeText).toHaveBeenCalledWith("copied");
  });

  it("does not recopy a stale selection after the next pointerdown", async () => {
    const harness = registerHarness();
    harness.setSelection("stale");
    harness.fireSelectionChange();
    harness.dispatchWindow("pointerdown", new TestPointerEvent("pointerdown", { button: 0 }));
    harness.setSelection("");
    harness.dispatchWindow("pointerup", new TestPointerEvent("pointerup", { button: 0 }));

    await flushCopyTimer();

    expect(writeText).not.toHaveBeenCalled();
    expect(toastMocks.pushToast).not.toHaveBeenCalled();
  });

  it("shows a warning when clipboard and fallback copy both fail", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    execCommand.mockReturnValue(false);
    const harness = registerHarness();
    harness.setSelection("abc");
    harness.fireSelectionChange();
    harness.dispatchWindow("pointerup", new TestPointerEvent("pointerup", { button: 0 }));

    await flushCopyTimer();

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(toastMocks.pushToast).toHaveBeenCalledWith("コピーに失敗しました", "warning");
  });

  it("replaces the previous success toast within 1200ms", async () => {
    await vi.advanceTimersByTimeAsync(2_000);
    toastMocks.pushToast
      .mockReturnValueOnce("copy-toast-1")
      .mockReturnValueOnce("copy-toast-2");
    const harness = registerHarness();
    harness.setSelection("abc");
    harness.fireSelectionChange();
    harness.dispatchWindow("pointerup", new TestPointerEvent("pointerup", { button: 0 }));
    await flushCopyTimer();

    await vi.advanceTimersByTimeAsync(500);
    harness.dispatchWindow("pointerdown", new TestPointerEvent("pointerdown", { button: 0 }));
    harness.setSelection("def");
    harness.fireSelectionChange();
    harness.dispatchWindow("pointerup", new TestPointerEvent("pointerup", { button: 0 }));
    await flushCopyTimer();

    expect(toastMocks.dismissToast).toHaveBeenCalledWith("copy-toast-1");
    expect(toastMocks.pushToast).toHaveBeenLastCalledWith("コピーしました (3文字)", "info");
  });
});

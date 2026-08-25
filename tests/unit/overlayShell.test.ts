import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Effect = () => void | (() => void);

const reactRuntime = vi.hoisted(() => {
  let active: OverlayHarness | null = null;
  return {
    activate(harness: OverlayHarness | null) {
      active = harness;
    },
    useEffect(effect: Effect, deps: unknown[]) {
      if (!active) throw new Error("Overlay harness is not active");
      active.useEffect(effect, deps);
    },
    useRef<T>(initial: T) {
      if (!active) throw new Error("Overlay harness is not active");
      return active.useRef(initial);
    },
  };
});

vi.mock("react", () => ({
  useEffect: reactRuntime.useEffect,
  useRef: reactRuntime.useRef,
}));

import { OverlayShell } from "../../src/components/common/OverlayShell";

type EffectSlot = { deps: unknown[]; cleanup?: () => void; pending?: Effect };

class OverlayHarness {
  private effectIndex = 0;
  private refIndex = 0;
  private effects: EffectSlot[] = [];
  private refs: Array<{ current: unknown }> = [];

  render(props: Parameters<typeof OverlayShell>[0], flush = true) {
    this.effectIndex = 0;
    this.refIndex = 0;
    reactRuntime.activate(this);
    const element = OverlayShell(props);
    reactRuntime.activate(null);
    if (flush) this.flushEffects();
    return element;
  }

  useEffect(effect: Effect, deps: unknown[]) {
    const index = this.effectIndex++;
    const previous = this.effects[index];
    const unchanged = previous
      && previous.deps.length === deps.length
      && deps.every((dep, depIndex) => Object.is(dep, previous.deps[depIndex]));
    if (!unchanged) this.effects[index] = { deps, cleanup: previous?.cleanup, pending: effect };
  }

  useRef<T>(initial: T): { current: T } {
    const index = this.refIndex++;
    if (!this.refs[index]) this.refs[index] = { current: initial };
    return this.refs[index] as { current: T };
  }

  unmount() {
    this.effects.forEach((effect) => effect.cleanup?.());
    this.effects = [];
    this.refs = [];
    reactRuntime.activate(null);
  }

  flushEffects() {
    this.effects.forEach((effect) => {
      if (!effect.pending) return;
      effect.cleanup?.();
      const cleanup = effect.pending();
      effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      effect.pending = undefined;
    });
  }
}

let harness: OverlayHarness;
let keydown: ((event: KeyboardEvent) => void) | undefined;
let addEventListener: ReturnType<typeof vi.spyOn>;
let removeEventListener: ReturnType<typeof vi.spyOn>;
let activeElement: HTMLElement | null;
let previous: HTMLElement;

const render = (overrides: Partial<Parameters<typeof OverlayShell>[0]> = {}) => {
  const onClose = vi.fn();
  const element = harness.render({
    open: true,
    onClose,
    ariaLabel: "テスト",
    children: "body",
    ...overrides,
  });
  const backdrop = element as unknown as { props: Record<string, unknown> };
  const panel = backdrop.props.children as { props: Record<string, unknown> };
  return { onClose, backdrop, panel };
};

beforeEach(() => {
  harness = new OverlayHarness();
  previous = { focus: vi.fn() } as unknown as HTMLElement;
  activeElement = previous;
  keydown = undefined;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      contains: () => true,
      querySelectorAll: () => [],
    },
  });
  addEventListener = vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "keydown") keydown = listener as (event: KeyboardEvent) => void;
  });
  removeEventListener = vi.spyOn(document, "removeEventListener").mockImplementation(() => undefined);
  vi.spyOn(document, "contains").mockReturnValue(true);
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => activeElement });
});

afterEach(() => {
  harness.unmount();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "document");
});

describe("OverlayShell", () => {
  it("closes on Escape and restores the prior focus on unmount", () => {
    const onClose = vi.fn();
    const element = harness.render({ open: true, onClose, ariaLabel: "テスト", children: "body" }, false);
    const backdrop = element as unknown as { props: Record<string, unknown> };
    const panel = backdrop.props.children as { props: Record<string, unknown> };
    const panelNode = { focus: vi.fn(), querySelectorAll: () => [], contains: () => false, closest: () => null };
    (panel.props.ref as { current: unknown }).current = panelNode;
    vi.spyOn(document, "querySelectorAll").mockReturnValue([panelNode] as unknown as NodeListOf<Element>);
    harness.flushEffects();
    expect(panelNode.focus).toHaveBeenCalled();

    const preventDefault = vi.fn();
    keydown?.({ key: "Escape", preventDefault } as unknown as KeyboardEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    harness.unmount();
    expect(previous.focus).toHaveBeenCalledOnce();
  });

  it("closes only for a backdrop mousedown, never a panel mousedown", () => {
    const { onClose, backdrop, panel } = render();
    const backdropTarget = {} as EventTarget;
    (backdrop.props.onMouseDown as (event: unknown) => void)({ target: backdropTarget, currentTarget: backdropTarget });
    expect(onClose).toHaveBeenCalledOnce();

    const stopPropagation = vi.fn();
    (panel.props.onMouseDown as (event: unknown) => void)({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables closing controls while closing", () => {
    const { onClose, backdrop } = render({ closing: true });
    expect(addEventListener).not.toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(backdrop.props.inert).toBe(true);
    expect(backdrop.props["aria-hidden"]).toBe(true);
    const target = {} as EventTarget;
    (backdrop.props.onMouseDown as (event: unknown) => void)({ target, currentTarget: target });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("honors close opt-outs", () => {
    const { onClose, backdrop } = render({ closeOnEscape: false, closeOnBackdrop: false });
    expect(keydown).toEqual(expect.any(Function));
    keydown?.({ key: "Escape", preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(onClose).not.toHaveBeenCalled();
    const target = {} as EventTarget;
    (backdrop.props.onMouseDown as (event: unknown) => void)({ target, currentTarget: target });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cycles Tab focus inside the topmost dialog", () => {
    const element = harness.render({ open: true, onClose: vi.fn(), ariaLabel: "テスト", children: "body" }, false);
    const backdrop = element as unknown as { props: Record<string, unknown> };
    const panel = backdrop.props.children as { props: Record<string, unknown> };
    const first = { focus: vi.fn(), getAttribute: () => null, closest: () => null } as unknown as HTMLElement;
    const last = { focus: vi.fn(), getAttribute: () => null, closest: () => null } as unknown as HTMLElement;
    const panelNode = {
      focus: vi.fn(),
      querySelectorAll: () => [first, last],
      contains: (node: unknown) => node === first || node === last,
      closest: () => null,
    } as unknown as HTMLElement;
    (panel.props.ref as { current: unknown }).current = panelNode;
    vi.spyOn(document, "querySelectorAll").mockReturnValue([panelNode] as unknown as NodeListOf<Element>);
    harness.flushEffects();

    activeElement = last;
    const forward = vi.fn();
    keydown?.({ key: "Tab", shiftKey: false, preventDefault: forward } as unknown as KeyboardEvent);
    expect(forward).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();

    activeElement = first;
    const backward = vi.fn();
    keydown?.({ key: "Tab", shiftKey: true, preventDefault: backward } as unknown as KeyboardEvent);
    expect(backward).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();
  });

  it("routes Tab from the initially focused panel and includes summary disclosures", () => {
    const element = harness.render({ open: true, onClose: vi.fn(), ariaLabel: "テスト", children: "body" }, false);
    const backdrop = element as unknown as { props: Record<string, unknown> };
    const panel = backdrop.props.children as { props: Record<string, unknown> };
    const summary = { focus: vi.fn(), getAttribute: () => null, closest: () => null } as unknown as HTMLElement;
    const last = { focus: vi.fn(), getAttribute: () => null, closest: () => null } as unknown as HTMLElement;
    const querySelectorAll = vi.fn((selector: string) => {
      expect(selector).toContain("summary");
      return [summary, last];
    });
    const panelNode = {
      focus: vi.fn(),
      querySelectorAll,
      contains: (node: unknown) => node === summary || node === last,
      closest: () => null,
    } as unknown as HTMLElement;
    (panel.props.ref as { current: unknown }).current = panelNode;
    vi.spyOn(document, "querySelectorAll").mockReturnValue([panelNode] as unknown as NodeListOf<Element>);
    harness.flushEffects();

    activeElement = panelNode;
    const forward = vi.fn();
    keydown?.({ key: "Tab", shiftKey: false, preventDefault: forward } as unknown as KeyboardEvent);
    expect(forward).toHaveBeenCalledOnce();
    expect(summary.focus).toHaveBeenCalledOnce();

    activeElement = panelNode;
    const backward = vi.fn();
    keydown?.({ key: "Tab", shiftKey: true, preventDefault: backward } as unknown as KeyboardEvent);
    expect(backward).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();
  });

  it("ignores focus targets hidden inside a closed disclosure", () => {
    const element = harness.render({ open: true, onClose: vi.fn(), ariaLabel: "テスト", children: "body" }, false);
    const backdrop = element as unknown as { props: Record<string, unknown> };
    const panel = backdrop.props.children as { props: Record<string, unknown> };
    const closedDetails = {} as HTMLElement;
    const first = { focus: vi.fn(), getAttribute: () => null, closest: () => null } as unknown as HTMLElement;
    const outerSummary = {
      focus: vi.fn(),
      getAttribute: () => null,
      closest: (selector: string) => selector === "details:not([open])" ? closedDetails : null,
      tagName: "SUMMARY",
      parentElement: closedDetails,
    } as unknown as HTMLElement;
    const innerSummary = {
      focus: vi.fn(),
      getAttribute: () => null,
      closest: (selector: string) => selector === "details:not([open])" ? closedDetails : null,
      tagName: "SUMMARY",
      parentElement: {},
    } as unknown as HTMLElement;
    const hiddenButton = {
      focus: vi.fn(),
      getAttribute: () => null,
      closest: (selector: string) => selector === "details:not([open])" ? closedDetails : null,
      tagName: "BUTTON",
      parentElement: closedDetails,
    } as unknown as HTMLElement;
    const panelNode = {
      focus: vi.fn(),
      querySelectorAll: () => [first, outerSummary, innerSummary, hiddenButton],
      contains: (node: unknown) => [first, outerSummary, innerSummary, hiddenButton].includes(node as HTMLElement),
      closest: () => null,
    } as unknown as HTMLElement;
    (panel.props.ref as { current: unknown }).current = panelNode;
    vi.spyOn(document, "querySelectorAll").mockReturnValue([panelNode] as unknown as NodeListOf<Element>);
    harness.flushEffects();

    activeElement = outerSummary;
    const preventDefault = vi.fn();
    keydown?.({ key: "Tab", shiftKey: false, preventDefault } as unknown as KeyboardEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();
    expect(innerSummary.focus).not.toHaveBeenCalled();
    expect(hiddenButton.focus).not.toHaveBeenCalled();
  });

  it.each([
    ["full", "var(--cmux-overlay-full-width)", "var(--cmux-overlay-full-height)"],
    ["wide", "var(--cmux-overlay-wide-width)", "var(--cmux-overlay-wide-height)"],
    ["dialog", "var(--cmux-overlay-dialog-width)", "var(--cmux-overlay-dialog-height)"],
  ] as const)("uses %s dimensions and dialog semantics", (size, width, height) => {
    const { panel } = render({ size });
    expect(panel.props.style).toMatchObject({ width, height });
    expect(panel.props).toMatchObject({ role: "dialog", "aria-modal": "true", tabIndex: -1 });
  });

  it("uses the top-layer token when requested", () => {
    const { backdrop } = render({ layer: "top" });
    expect((backdrop.props.style as Record<string, unknown>).zIndex).toBe("var(--cmux-overlay-z-top)");
  });
});

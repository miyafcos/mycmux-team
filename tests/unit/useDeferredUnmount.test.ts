import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactHookRuntime = vi.hoisted(() => {
  let activeHarness: HookHarnessApi | null = null;

  type HookHarnessApi = {
    useState: (initial: unknown) => [unknown, (value: unknown) => void];
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => void;
  };

  return {
    activate(harness: HookHarnessApi | null) {
      activeHarness = harness;
    },
    useState(initial: unknown) {
      if (!activeHarness) throw new Error("Hook harness is not active");
      return activeHarness.useState(initial);
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      if (!activeHarness) throw new Error("Hook harness is not active");
      return activeHarness.useEffect(effect, deps);
    },
  };
});

vi.mock("react", () => ({
  useState: reactHookRuntime.useState,
  useEffect: reactHookRuntime.useEffect,
}));

import {
  OVERLAY_EXIT_MS,
  useDeferredUnmount,
} from "../../src/hooks/useDeferredUnmount";

type DeferredState = ReturnType<typeof useDeferredUnmount>;
type EffectSlot = {
  deps: unknown[];
  cleanup?: () => void;
  pending?: () => void | (() => void);
};

class HookHarness {
  private states: unknown[] = [];
  private effects: EffectSlot[] = [];
  private stateIndex = 0;
  private effectIndex = 0;
  private needsRender = false;
  private open = false;

  render(open: boolean): DeferredState {
    this.open = open;
    let result: DeferredState;

    do {
      result = this.renderBeforeEffects(this.open);
      this.flushEffects();
    } while (this.needsRender);

    return result!;
  }

  renderBeforeEffects(open: boolean): DeferredState {
    this.open = open;
    this.needsRender = false;
    this.stateIndex = 0;
    this.effectIndex = 0;
    reactHookRuntime.activate(this);
    const result = useDeferredUnmount(this.open, OVERLAY_EXIT_MS);
    reactHookRuntime.activate(null);
    return result;
  }

  useState(initial: unknown): [unknown, (value: unknown) => void] {
    const index = this.stateIndex++;
    if (index >= this.states.length) this.states.push(initial);
    const setState = (value: unknown) => {
      const next = typeof value === "function"
        ? (value as (current: unknown) => unknown)(this.states[index])
        : value;
      if (Object.is(next, this.states[index])) return;
      this.states[index] = next;
      this.needsRender = true;
    };
    return [this.states[index], setState];
  }

  useEffect(effect: () => void | (() => void), deps: unknown[]): void {
    const index = this.effectIndex++;
    const previous = this.effects[index];
    const unchanged = previous
      && previous.deps.length === deps.length
      && deps.every((dep, depIndex) => Object.is(dep, previous.deps[depIndex]));
    if (unchanged) return;
    this.effects[index] = { deps, cleanup: previous?.cleanup, pending: effect };
  }

  flushTimerUpdates(): DeferredState {
    return this.render(this.open);
  }

  unmount(): void {
    for (const effect of this.effects) effect.cleanup?.();
    this.effects = [];
    reactHookRuntime.activate(null);
  }

  private flushEffects(): void {
    for (const effect of this.effects) {
      if (!effect.pending) continue;
      effect.cleanup?.();
      const cleanup = effect.pending();
      effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      effect.pending = undefined;
    }
  }
}

let harness: HookHarness;

beforeEach(() => {
  vi.useFakeTimers();
  harness = new HookHarness();
});

afterEach(() => {
  harness.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("useDeferredUnmount", () => {
  it("stays unmounted when initially closed", () => {
    expect(harness.render(false)).toEqual({ mounted: false, closing: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps content mounted for the exit duration", () => {
    expect(harness.render(true)).toEqual({ mounted: true, closing: false });
    expect(harness.render(false)).toEqual({ mounted: true, closing: true });

    vi.advanceTimersByTime(OVERLAY_EXIT_MS - 1);
    expect(harness.flushTimerUpdates()).toEqual({ mounted: true, closing: true });

    vi.advanceTimersByTime(1);
    expect(harness.flushTimerUpdates()).toEqual({ mounted: false, closing: false });
  });

  it("reports open, closing, and rapid reopen synchronously", () => {
    harness.render(false);
    expect(harness.renderBeforeEffects(true)).toEqual({ mounted: true, closing: false });
    harness.render(true);

    expect(harness.renderBeforeEffects(false)).toEqual({ mounted: true, closing: true });
    harness.render(false);
    expect(harness.renderBeforeEffects(true)).toEqual({ mounted: true, closing: false });
  });

  it("cancels closing when reopened", () => {
    harness.render(true);
    expect(harness.render(false)).toEqual({ mounted: true, closing: true });

    vi.advanceTimersByTime(OVERLAY_EXIT_MS / 2);
    expect(harness.render(true)).toEqual({ mounted: true, closing: false });
    vi.advanceTimersByTime(OVERLAY_EXIT_MS);

    expect(harness.flushTimerUpdates()).toEqual({ mounted: true, closing: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the close timer on unmount", () => {
    harness.render(true);
    harness.render(false);
    expect(vi.getTimerCount()).toBe(1);

    harness.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

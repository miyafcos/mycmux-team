// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregatePetTier, classifyPetTier, petSpriteStateFor,
  PET_DEMOTE_HOLD_MS, PET_OUTPUT_ACTIVE_WINDOW_MS,
  type PetTier, type PetTierInput,
} from "../../src/lib/petState";
import PetSprite from "../../src/components/workspace/PetSprite";
import { useTerminalObservationStore } from "../../src/stores/terminalObservationStore";

const now = 100_000;
const base: PetTierInput = { observed: false, attentionUnseen: false, now };
const tiers: PetTier[] = ["calling", "stuck", "working", "ready", "resting"];

describe("pet classification contract", () => {
  it.each(["web", "browser", "online"] as const)("R0: %s rests even with terminal signals", (tabType) => {
    expect(classifyPetTier({ ...base, tabType, observed: true, agentStatus: "waiting", attentionKind: "error", outputActive: true })).toBe("resting");
  });
  it.each<[string, Partial<PetTierInput>, PetTier]>([
    ["R1: observed screen waiting outranks error", { observed: true, agentStatus: "waiting", attentionKind: "error" }, "calling"],
    ["R1: unobserved frozen screen waiting is ignored", { agentStatus: "waiting" }, "resting"],
    ["R2: unobserved input", { attentionKind: "input" }, "calling"],
    ["R2: unobserved approval", { attentionKind: "approval" }, "calling"],
    ["R2: observed input is ignored", { observed: true, attentionKind: "input", agentStatus: "idle" }, "resting"],
    ["R2: observed approval is ignored", { observed: true, attentionKind: "approval", outputActive: true }, "working"],
    ["R3: rate limit outranks queued input", { attentionKind: "rate_limited", stallReason: "queued_input" }, "stuck"],
    ["R3: seen error remains stuck", { attentionKind: "error", attentionUnseen: false }, "stuck"],
    ["R4: unfinished input outranks done", { stallReason: "queued_input", attentionKind: "done" }, "calling"],
    ["R5: Claude idle prompt redraws after seen done", { attentionKind: "done", backendLastOutputAt: now - 3_000, activity: "streaming", outputActive: true }, "resting"],
    ["R5: unread completion outranks recent output", { attentionKind: "done", attentionUnseen: true, backendLastOutputAt: now - 3_000, activity: "streaming" }, "ready"],
    ["R7 before R5: observed spinner outranks unread done and stall", { attentionKind: "done", attentionUnseen: true, observed: true, workingPatternVisible: true, stallReason: "silent" }, "working"],
    ["R7 before R5: observed spinner outranks seen done", { attentionKind: "done", observed: true, workingPatternVisible: true }, "working"],
    ["R5: unobserved done outranks frozen spinner and output", { attentionKind: "done", attentionUnseen: true, workingPatternVisible: true, outputActive: true, backendLastOutputAt: now - 3_000 }, "ready"],
    ["R5: observed idle prompt output alone stays resting", { attentionKind: "done", observed: true, workingPatternVisible: false, outputActive: true, activity: "streaming", attentionStateSince: now - 2_000 }, "resting"],
    ["resume: none 2 seconds ago without output", { attentionKind: "none", attentionStateSince: now - 2_000, outputActive: false }, "working"],
    ["resume: none 20 seconds ago without output", { attentionKind: "none", attentionStateSince: now - 20_000, outputActive: false }, "resting"],
    ["resume: idle overrides recent none", { attentionKind: "none", attentionStateSince: now - 2_000, activity: "idle", outputActive: false }, "resting"],
    ["resume: absent attention and timestamp", { attentionKind: undefined, attentionStateSince: undefined }, "resting"],
    ["resume: absent kind with recent timestamp", { attentionStateSince: now - 2_000, activity: "unknown" }, "working"],
    ["resume: inclusive 15 second window", { attentionKind: "none", attentionStateSince: now - 15_000 }, "working"],
    ["resume: expired window", { attentionKind: "none", attentionStateSince: now - 15_001 }, "resting"],
    ["resume: recent clear outranks stale stall", { attentionKind: "none", attentionStateSince: now - 2_000, stallReason: "no_output" }, "working"],
    ["resume: recent clear does not outrank queued input", { attentionKind: "none", attentionStateSince: now - 2_000, stallReason: "queued_input" }, "calling"],
    ["resume: observed input does not count as a clear", { attentionKind: "input", observed: true, attentionStateSince: now - 2_000 }, "resting"],
    ["resume: unread done remains ready", { attentionKind: "done", attentionUnseen: true, attentionStateSince: now - 2_000 }, "ready"],
    ["R1: observed waiting outranks spinner", { observed: true, agentStatus: "waiting", workingPatternVisible: true, attentionKind: "done" }, "calling"],
    ["R3: error outranks spinner", { observed: true, workingPatternVisible: true, attentionKind: "error" }, "stuck"],
    ["R6: no output stall", { stallReason: "no_output", outputActive: true }, "resting"],
    ["R6: silent stall", { stallReason: "silent", activity: "running_silent" }, "resting"],
    ["R6: dead PTY without observed spinner", { stallReason: "pty_dead", workingPatternVisible: true }, "resting"],
    ["R7: observed working pattern", { observed: true, workingPatternVisible: true }, "working"],
    ["R7: unobserved working pattern is ignored", { workingPatternVisible: true }, "resting"],
    ["R8: active output", { outputActive: true }, "working"],
    ["R8: Bash tool execution", { attentionKind: "none", backendLastOutputAt: now - 2_000 }, "working"],
    ["R8: inclusive output window", { backendLastOutputAt: now - PET_OUTPUT_ACTIVE_WINDOW_MS }, "working"],
    ["R8: expired output window", { backendLastOutputAt: now - PET_OUTPUT_ACTIVE_WINDOW_MS - 1 }, "resting"],
    ["R9: silent running", { activity: "running_silent" }, "working"],
    ["R10: streaming alone is insufficient", { activity: "streaming" }, "resting"],
    ["R10: unknown", { activity: "unknown" }, "resting"],
    ["R10: idle", { activity: "idle" }, "resting"],
    ["R10: no signals", {}, "resting"],
  ])("%s", (_name, input, expected) => {
    expect(classifyPetTier({ ...base, ...input })).toBe(expected);
  });

  it.each(tiers.flatMap((left, i) => tiers.map((right, j) => [left, right, tiers[Math.min(i, j)]] as const)))(
    "aggregates %s + %s as %s", (left, right, expected) => {
      expect(aggregatePetTier([left, right])).toBe(expected);
    },
  );
  it("rests with no tabs", () => expect(aggregatePetTier([])).toBe("resting"));
  it.each(tiers)("maps %s to its sprite state", (tier) => expect(petSpriteStateFor(tier)).toBe(tier));
});

describe("displayed pet transitions", () => {
  let root: Root;
  let container: HTMLDivElement;
  function render(state: PetTier) {
    act(() => root.render(createElement(PetSprite, { atlasUrl: "pet.webp", state, height: 208 })));
  }
  const row = () => Math.abs(Number((container.firstElementChild as HTMLElement).style.getPropertyValue("--pet-row-offset").replace("px", "")) / 208);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it.each(["resting", "ready"] as const)("holds working -> %s for exactly 3 seconds", (target) => {
    render("working");
    render(target);
    expect(row()).toBe(7);
    act(() => vi.advanceTimersByTime(PET_DEMOTE_HOLD_MS - 1));
    expect(row()).toBe(7);
    act(() => vi.advanceTimersByTime(1));
    expect(row()).toBe(target === "resting" ? 0 : 8);
  });
  it.each(["resting", "ready", "calling", "stuck"] as const)("%s -> working is immediate", (from) => {
    render(from);
    render("working");
    expect(row()).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["calling", "stuck"] as const)("%s interrupts a pending demotion immediately", (target) => {
    render("working");
    render("resting");
    act(() => vi.advanceTimersByTime(2_000));
    render(target);
    expect(row()).toBe(target === "calling" ? 6 : 5);
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(3_000));
    expect(row()).toBe(target === "calling" ? 6 : 5);
  });
  it.each(["ready", "calling", "stuck"] as const)("%s -> resting is immediate", (from) => {
    render(from);
    render("resting");
    expect(row()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a demotion when work resumes", () => {
    render("working");
    render("resting");
    act(() => vi.advanceTimersByTime(2_000));
    render("working");
    act(() => vi.advanceTimersByTime(3_000));
    expect(row()).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans the demotion timer on unmount", () => {
    render("working");
    render("resting");
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("terminal observation subscription", () => {
  it("publishes mount, switch, remount and close without mutating snapshots", () => {
    const store = useTerminalObservationStore;
    store.setState({ observed: new Set() });
    const notified = vi.fn();
    const unsubscribe = store.subscribe(notified);
    const initial = store.getState().observed;
    store.getState().markObserved("a");
    const mounted = store.getState().observed;
    store.getState().markObserved("a");
    expect(notified).toHaveBeenCalledTimes(1);
    store.getState().markUnobserved("a");
    store.getState().markObserved("b");
    expect([...store.getState().observed]).toEqual(["b"]);
    store.getState().markUnobserved("b");
    store.getState().markObserved("a");
    store.getState().markUnobserved("a");
    store.getState().markUnobserved("a");
    expect(notified).toHaveBeenCalledTimes(6);
    expect([...initial]).toEqual([]);
    expect([...mounted]).toEqual(["a"]);
    expect([...store.getState().observed]).toEqual([]);
    unsubscribe();
  });
});

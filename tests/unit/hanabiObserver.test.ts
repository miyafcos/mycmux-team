import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetHanabiCelebrationsForTests, connectHanabiCelebrations } from "../../src/stores/hanabiCelebrationObserver";
import { useSessionAttentionStore, type SessionAttention } from "../../src/stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { LiveTailState } from "../../src/stores/liveTailStore";
import type { Workspace } from "../../src/types";
import { queueTerminalOutputObservation } from "../../src/stores/terminalObservationStore";
const mocks = vi.hoisted(() => ({
  listener: undefined as ((state: LiveTailState, previous: LiveTailState) => void) | undefined,
  releaseDemand: vi.fn(), releaseObservations: vi.fn(), acquire: vi.fn(),
}));
vi.mock("../../src/stores/liveTailStore", () => ({
  subscribeLiveTailObservations: (listener: typeof mocks.listener) => { mocks.listener = listener; return mocks.releaseObservations; },
  acquireLiveTailConsumer: (...args: unknown[]) => { mocks.acquire(...args); return mocks.releaseDemand; },
}));
let release: (() => void) | undefined;
const attention = (kind: SessionAttention["kind"]): SessionAttention => ({ sessionId: "s", kind, sessionEpoch: 1,
  attentionId: kind, detail: null, sessionRevision: 1, uiState: kind === "done" ? "done" : "working", stateSince: 1, occurrenceOrder: 1 });
const screen = (text: string, at: number): LiveTailState => ({
  targets: [{ sessionId: "s" }],
  entries: { s: { evidence: { observation: { rawRows: text.split("\n"), lastOutputAt: at, crop: { readable: true } } } } },
} as unknown as LiveTailState);
beforeEach(() => {
  vi.clearAllMocks(); useSessionAttentionStore.getState().resetForTests();
  __resetHanabiCelebrationsForTests();
  useWorkspaceListStore.setState({ workspaces: [{ id: "w", panes: [{ id: "p", tabs: [{ id: "t", sessionId: "s", type: "terminal" }] }] } as Workspace] });
});
afterEach(() => { release?.(); release = undefined; useWorkspaceListStore.setState({ workspaces: [] }); });
describe("hanabi observation integration", () => {
  it("subscribes once, releases all demand, and celebrates only owned completion transitions", () => {
    const celebrate = vi.fn();
    release = connectHanabiCelebrations(celebrate);
    useSessionAttentionStore.setState({ attentionBySession: { s: attention("none") } });
    useSessionAttentionStore.setState({ attentionBySession: { s: attention("done") } });
    useSessionAttentionStore.setState({ attentionBySession: { s: attention("done") } });
    useSessionAttentionStore.setState({ attentionBySession: { other: { ...attention("none"), sessionId: "other" } } });
    useSessionAttentionStore.setState({ attentionBySession: { other: { ...attention("done"), sessionId: "other" } } });
    expect(celebrate.mock.calls).toEqual([["done"]]);
    release(); release = undefined;
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(mocks.releaseDemand).toHaveBeenCalledOnce(); expect(mocks.releaseObservations).toHaveBeenCalledOnce();
  });
  it("debounces completion transitions per session", () => {
    let now = 0; const celebrate = vi.fn();
    useSessionAttentionStore.setState({ attentionBySession: { s: attention("none") } });
    release = connectHanabiCelebrations(celebrate, () => now);
    for (const kind of ["done", "none", "done"] as const) useSessionAttentionStore.setState({ attentionBySession: { s: attention(kind) } });
    expect(celebrate).toHaveBeenCalledTimes(1);
    now = 4000;
    useSessionAttentionStore.setState({ attentionBySession: { s: attention("none") } });
    useSessionAttentionStore.setState({ attentionBySession: { s: attention("done") } });
    expect(celebrate).toHaveBeenCalledTimes(2);
  });
  it("uses existing screens and output timestamps without replaying or retriggering a merge", () => {
    let now = 100; const celebrate = vi.fn();
    release = connectHanabiCelebrations(celebrate, () => now);
    const before = screen("working", 100), merged = screen("Merged pull request #42", 200);
    mocks.listener?.(before, { targets: [], entries: {} });
    now = 200; mocks.listener?.(merged, before);
    expect(celebrate.mock.calls).toEqual([["merge"]]);
    now = 30000; mocks.listener?.(screen("Merged pull request #42\nother output", 300), merged);
    expect(celebrate).toHaveBeenCalledTimes(1);
  });
  it("skips a historic merge on first observation", () => {
    const celebrate = vi.fn(); release = connectHanabiCelebrations(celebrate);
    mocks.listener?.(screen("Fast-forward", 100), { targets: [], entries: {} });
    expect(celebrate).not.toHaveBeenCalled();
  });
});

describe("merge output that scrolls out of the visible tail", () => {
  function queue(text: string, start = 0, source?: "live" | "snapshot", epoch = 1) {
    const data = new TextEncoder().encode(text);
    queueTerminalOutputObservation({ sessionId: "s", epoch, startOffset: start, endOffset: start + data.length, data, source });
    return start + data.length;
  }
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("recognizes a success before thousands of file-stat lines, outside the delivery callback", () => {
    const celebrate = vi.fn(); release = connectHanabiCelebrations(celebrate);
    queue("Updating abc123..def456\nFast-forward\n" + " src/example.ts | 3 +++\n".repeat(2200));
    expect(celebrate).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(celebrate.mock.calls).toEqual([["merge"]]);
  });
  it("joins split ANSI, UTF-8 and success text without accepting an incomplete failure prefix", () => {
    const celebrate = vi.fn(); release = connectHanabiCelebrations(celebrate);
    let end = queue("\x1b[32m✓ Merged pull request");
    vi.runAllTimers(); expect(celebrate).not.toHaveBeenCalled();
    end = queue(" failed\x1b[0m\n", end);
    vi.runAllTimers(); expect(celebrate).not.toHaveBeenCalled();
    end = queue("\x1b[32m✓ Merged pu", end);
    vi.runAllTimers(); expect(celebrate).not.toHaveBeenCalled();
    queue("ll request #42\x1b[0m\n", end);
    vi.runAllTimers(); expect(celebrate.mock.calls).toEqual([["merge"]]);
  });
  it("baselines all of a large historic snapshot, then detects fresh bytes after cache eviction", () => {
    const celebrate = vi.fn(); release = connectHanabiCelebrations(celebrate);
    const history = "old output\n".repeat(4000) + "Merged pull request #1\n";
    const end = queue(history, 0, "snapshot");
    vi.runAllTimers(); expect(celebrate).not.toHaveBeenCalled();
    // A recreated parser may supply a full history window. Absolute offsets
    // still identify only the bytes added since the previous accepted read.
    queue(history + "Merged pull request #2\n" + "file stat\n".repeat(300), 0, "snapshot");
    vi.runAllTimers(); expect(celebrate.mock.calls).toEqual([["merge"]]);
    expect(end).toBeGreaterThan(32768);
  });
  it.each(["\n", ""])("registers every historic snapshot chunk before reprints (ending %j)", ending => {
    let now = 100;
    const celebrate = vi.fn(); release = connectHanabiCelebrations(celebrate, () => now);
    const history = "Merged pull request #1\n" + "old output\n".repeat(4000)
      + "Merged pull request #2\nMerge made by the 'ort' strategy." + ending;
    let end = queue(history, 0, "snapshot");
    vi.runAllTimers(); expect(celebrate).not.toHaveBeenCalled();
    expect(end).toBeGreaterThan(32768);
    now = 13000;
    end = queue("\x1b[HMerged pull request #1\nMerged pull request #2\nMerge made by the 'ort' strategy.\n", end, "live");
    vi.runAllTimers(); expect(celebrate).not.toHaveBeenCalled();
    queue("Merged pull request #3\n", end, "live");
    vi.runAllTimers(); expect(celebrate.mock.calls).toEqual([["merge"]]);
  });
  it("deduplicates overlap between the live channel and headless snapshots", () => {
    const celebrate = vi.fn(); release = connectHanabiCelebrations(celebrate);
    const text = "Merged pull request #42\n";
    queue(text); vi.runAllTimers();
    queue(text, 0, "snapshot"); vi.runAllTimers();
    expect(celebrate).toHaveBeenCalledTimes(1);
  });
  // conhost reprints the screen on resize; see terminalViewportStability.ts.
  // Keep content-based dedup so reprints at fresh byte offsets cannot celebrate again.
  // This also deliberately suppresses a later separate merge with the same success text.
  it.each([
    ["ort", "Merge made by the 'ort' strategy.\n"],
    ["Fast-forward", "Updating a..b\nFast-forward\n"],
  ])("keeps %s merge success deduplicated across a live conhost screen reprint", (_kind, success) => {
    let now = 100; const celebrate = vi.fn();
    release = connectHanabiCelebrations(celebrate, () => now);
    const end = queue(success, 0, "live");
    vi.runAllTimers();
    expect(celebrate.mock.calls).toEqual([["merge"]]);
    now = 13_000;
    queue("\x1b[H$ git merge topic\n" + success + "file stats from the retained screen\n$ ready\n", end, "live");
    vi.runAllTimers();
    expect(celebrate.mock.calls).toEqual([["merge"]]);
  });
  it("does not replay old completion text when a new producer supplies a first snapshot", () => {
    const celebrate = vi.fn(); release = connectHanabiCelebrations(celebrate);
    queue("working\n", 0, "snapshot", 1); vi.runAllTimers();
    queue("Merged pull request #42\n", 0, "snapshot", 2); vi.runAllTimers();
    expect(celebrate).not.toHaveBeenCalled();
  });
  it("cancels pending work when the scene releases observation", () => {
    const celebrate = vi.fn(); release = connectHanabiCelebrations(celebrate);
    queue("Merged pull request #42\n");
    release(); release = undefined;
    vi.runAllTimers();
    expect(celebrate).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

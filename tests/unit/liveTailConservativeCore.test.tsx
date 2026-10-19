// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTailList } from "../../src/components/layout/LiveTailList";
import { handleSocketCommand, readPaneTail } from "../../src/components/layout/socketCommands";
import { __resetHeadlessBufferCacheForTests } from "../../src/components/terminal/headlessBuffer";
import { liveTerms, termCache } from "../../src/components/terminal/terminalCache";
import { __resetPtyReadGenerationsForTests, ptyReadGeneration } from "../../src/lib/ptyReadGeneration";
import { loadLiveTailTargets } from "../../src/lib/liveTail/targets";
import { acquireLiveTailConsumer, disposeLiveTailObserver, useLiveTailStore, type LiveTailState, type LiveTailsResponse } from "../../src/stores/liveTailStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { formatLiveTailAgo } from "../../src/lib/liveTail/stateLine";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Workspace } from "../../src/types";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: core.invoke,
  Channel: class { id = 1; onmessage = (_data: unknown) => {}; },
}));
const start = 1_800_000_000_000, epoch = 17;
const errorScreen = "API Error: 500 sample\r\n* Cooked for 3s · done 01:00\r\n";
const healthyScreen = "Recovered successfully\r\n* Cooked for 3s · done 01:00\r\n";
const encoder = new TextEncoder();
function frame(text: string): ArrayBuffer {
  const bytes = encoder.encode(text), wire = new ArrayBuffer(48 + bytes.length), view = new DataView(wire);
  new Uint8Array(wire).set([0x4d, 0x43, 0x53, 0x32]);
  view.setBigUint64(16, BigInt(bytes.length), true); view.setBigUint64(24, BigInt(epoch), true);
  view.setBigUint64(32, 1n, true); view.setUint16(40, 80, true); view.setUint16(42, 24, true);
  new Uint8Array(wire, 48).set(bytes); return wire;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const ids = ["A", "B", "C", "ordinary-idle"];
const workspace: Workspace = { id: "core-workspace", name: "Core", gridTemplateId: "1x1", createdAt: start, status: "running",
  panes: ids.map(id => ({ id: `pane-${id}`, sessionId: id, agentId: "claude", activeTabId: `tab-${id}`,
    tabs: [{ id: `tab-${id}`, sessionId: id, agentId: "claude", agentKind: "claude", type: "terminal", label: id }] })) };
let backend: Map<string, { text: string; failed: boolean }>;
let held: ReturnType<typeof deferred<ArrayBuffer>> | undefined;
let native: Array<ReturnType<typeof deferred<ArrayBuffer>>>;
let reads: Array<{ id: string; at: number }>, active: number, peak: number;
let root: Root, host: HTMLDivElement, state: LiveTailState, release: () => void;
function ConnectedScene() {
  state = useLiveTailStore(value => value);
  return <LiveTailList workspace={workspace} {...state} />;
}
async function step(ms = 30) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function api() {
  return await handleSocketCommand("pane.live_tails", {}) as LiveTailsResponse;
}
function row(id = "A") { return host.querySelector<HTMLButtonElement>(`[data-live-tail-tab="tab-${id}"]`); }
async function expandIdle() {
  const toggle = host.querySelector<HTMLButtonElement>(".live-tail-idle");
  if (toggle?.getAttribute("aria-expanded") === "false") await act(async () => toggle.click());
}
async function checkViews(response: LiveTailsResponse) {
  await expandIdle();
  // Iterate discovery, including targets omitted by the API, rather than only
  // checking returned tabs. Ordinary idle is presentation, not read demand.
  expect.soft(response.tabs.map(tab => tab.sessionId).sort()).toEqual(state.targets.map(target => target.sessionId).sort());
  for (const target of state.targets) {
    const tab = response.tabs.find(value => value.sessionId === target.sessionId);
    expect.soft(tab, `API omitted ${target.sessionId}`).toBeDefined();
    expect.soft(row(target.sessionId), `sidebar omitted ${target.sessionId}`).not.toBeNull();
    if (tab) {
      expect.soft(row(target.sessionId)?.dataset.fact).toBe(tab.fact.kind);
      expect.soft(Object.keys(tab).sort()).toEqual(["agentKind", "fact", "lastOutputAt", "name", "observedAt", "paneId", "readable", "rows", "sessionId", "tabId", "waitingForReply", "workspaceId", "workspaceName"]);
      expect.soft(Object.keys(tab.fact).sort()).toEqual(["elapsedSec", "error", "kind", "sinceMs", "tokens", "toolElapsedSec"]);
    }
  }
  expect.soft(peak).toBeLessThanOrEqual(2);
  for (const read of reads) expect.soft(reads.filter(value => value.at >= read.at && value.at < read.at + 2_000).length).toBeLessThanOrEqual(12);
  expect.soft(reads.some(value => value.id === "ordinary-idle")).toBe(false);
  expect.soft(core.invoke.mock.calls.filter(([command]) => command === "write_to_session")).toEqual([]);
}
async function checkAge(observedAt: number) {
  await expandIdle();
  const attention = useSessionAttentionStore.getState().attentionBySession.A;
  const waiting = attention.uiState === "waiting";
  expect.soft(row()?.querySelector(".live-tail-badge")?.textContent ?? null).toBe(waiting ? "回答待ち" : null);
  expect.soft(state.entries.A.evidence.observation.observedAt).toBe(observedAt);
  await showTooltip();
  const tooltip = document.querySelector('[role="tooltip"]');
  expect.soft(tooltip?.querySelector(".live-tail-evidence")).toBeNull();
  expect.soft(tooltip?.querySelector(".live-tail-fact")?.textContent).toBe(waiting ? "回答待ち"
    : attention.kind === "done" ? `完了 · ${formatLiveTailAgo(Date.now() - attention.stateSince)}`
      : state.entries.A.evidence.observation.crop.state === "done" ? "完了" : "入力待ち");
  if (state.entries.A.evidence.observation.crop.readable) expect.soft(tooltip?.querySelector(".live-tail-popup-rows--previous")).not.toBeNull();
}
async function showTooltip() {
  if (!row()) return;
  await act(async () => row()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => row()!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
}
async function changeAttention(uiState: "idle" | "done" | "working" | "waiting") {
  const previous = useSessionAttentionStore.getState().attentionBySession;
  await act(async () => useSessionAttentionStore.setState({ attentionBySession: { ...previous,
    A: { ...previous.A, kind: uiState === "done" ? "done" : "none", uiState,
      stateSince: Date.now(), sessionRevision: previous.A.sessionRevision + 1, occurrenceOrder: previous.A.occurrenceOrder + 1 },
  } }));
}
beforeEach(async () => {
  disposeLiveTailObserver(); __resetHeadlessBufferCacheForTests(); __resetPtyReadGenerationsForTests();
  liveTerms.clear(); termCache.clear(); useSessionAttentionStore.getState().resetForTests(); core.invoke.mockReset();
  backend = new Map(ids.map(id => [id, { text: errorScreen, failed: false }]));
  held = undefined; native = []; reads = []; active = 0; peak = 0;
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: "elsewhere" });
  core.invoke.mockImplementation(async (command: string, args: { sessionId: string }) => {
    if (command === "get_pty_metadata_snapshot") return Object.fromEntries(ids.map(id => [id, { live_agent_kind: "claude" }]));
    if (command === "get_window_fragments") return [];
    if (command === "get_session_output_snapshot") return Object.fromEntries(ids.map(id => [id, Date.now()]));
    if (command === "get_session_scrollback") {
      reads.push({ id: args.sessionId, at: Date.now() }); active++; peak = Math.max(peak, active);
      try {
        if (args.sessionId === "A" && held) { const pending = held; held = undefined; native.push(pending); return await pending.promise; }
        const value = backend.get(args.sessionId)!;
        if (value.failed) throw new Error("settled screen failure");
        return frame(value.text);
      } finally { active--; }
    }
    throw new Error(`Unexpected core command: ${command}`);
  });
  // Warm real dynamic imports and decode/parser paths before using fake time.
  await loadLiveTailTargets(); await readPaneTail("A", 40); __resetHeadlessBufferCacheForTests(); reads = []; peak = 0;
  vi.useFakeTimers(); vi.setSystemTime(start);
  useSessionAttentionStore.setState({ attentionBySession: Object.fromEntries(ids.map(id => [id, {
    sessionId: id, sessionEpoch: epoch, sessionRevision: 1, attentionId: null, kind: "none", detail: null,
    uiState: id === "ordinary-idle" ? "idle" : "working", stateSince: start, occurrenceOrder: 1,
  }])) });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ConnectedScene />));
  release = () => {};
});
afterEach(async () => {
  release(); await act(async () => root.unmount()); host.remove(); disposeLiveTailObserver();
  native.forEach(task => task.resolve(frame(healthyScreen))); await step(4_100);
  __resetHeadlessBufferCacheForTests(); useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  useSessionAttentionStore.getState().resetForTests(); vi.useRealTimers();
});

describe("stage C conservative screen authority, real API and rendered sidebar", () => {
  it.each([
    { initial: "error", next: "error", attention: "done" },
    { initial: "error", next: "healthy", attention: "idle" },
    { initial: "unreadable", next: "error", attention: "idle" },
    { initial: "unreadable", next: "healthy", attention: "done" },
  ] as const)("N7 $initial → same-epoch $attention → $next", async ({ initial, next, attention }) => {
    backend.get("A")!.failed = initial === "unreadable";
    await act(async () => { release = acquireLiveTailConsumer("sidebar"); }); await step();
    expect(state.entries.A.evidence.observation.crop.state).toBe(initial === "error" ? "error" : "unreadable");
    const observedAt = state.entries.A.evidence.observation.observedAt, generation = ptyReadGeneration("A");
    vi.setSystemTime(Date.now() + 2_001);
    const value = backend.get("A")!; value.failed = false;
    value.text += "\x1b[3J\x1b[2J\x1b[H" + (next === "error" ? errorScreen : healthyScreen);
    await changeAttention(attention); await checkAge(observedAt);
    expect(ptyReadGeneration("A")).toBe(generation);
    const before = reads.filter(value => value.id === "A").length, revalidation = held = deferred<ArrayBuffer>();
    const pending = api(); await step(1_500); const interim = await pending;
    await checkViews(interim); await checkAge(observedAt);
    expect.soft(interim.tabs.find(tab => tab.sessionId === "A")?.observedAt).toBe(observedAt);
    expect.soft(interim.tabs.find(tab => tab.sessionId === "A")?.fact.kind).toBe("idle");
    expect.soft(reads.filter(value => value.id === "A")).toHaveLength(before + 1);
    revalidation.resolve(frame(value.text)); await step();
    const current = api(); await step(); const final = await current; await checkViews(final);
    expect.soft(final.tabs.find(tab => tab.sessionId === "A")).toMatchObject({ readable: true, fact: { kind: next === "error" ? "error" : "idle" } });
    expect.soft(state.entries.A.evidence.observation.crop.rows.join("\n")).toContain(next === "error" ? "API Error: 500 sample" : "Recovered successfully");
    const starts = reads.filter(value => value.id === "A").length;
    await step(6_000); const later = api(); await step(); await checkViews(await later);
    expect.soft(reads.filter(value => value.id === "A")).toHaveLength(starts);
    expect.soft(starts).toBe(before + 1);
    if (next === "error") expect.soft(row()?.querySelector(".live-tail-badge")?.textContent).toBe("エラー");
    else expect.soft(row()?.querySelector(".live-tail-badge")).toBeNull();
    await showTooltip();
    expect.soft(document.querySelector('[role="tooltip"] .live-tail-evidence')).toBeNull();
    expect.soft(document.querySelector('[role="tooltip"] .live-tail-popup-rows')?.textContent)
      .toBe(state.entries.A.evidence.observation.crop.rows.join(""));
  });
  it("a single rejected revalidation settles as unreadable without idle retries", async () => {
    const first = api(); await step(); await first;
    vi.setSystemTime(Date.now() + 2_001); await changeAttention("done");
    const observedAt = state.entries.A.evidence.observation.observedAt; await checkAge(observedAt);
    const before = reads.filter(value => value.id === "A").length;
    backend.get("A")!.failed = true;
    const request = api(); await step(); const result = await request; await checkViews(result);
    expect.soft(result.tabs.find(tab => tab.sessionId === "A")).toMatchObject({ readable: false, fact: { kind: "unreadable" } });
    await step(6_000); const later = api(); await step(); await checkViews(await later);
    expect.soft(reads.filter(value => value.id === "A")).toHaveLength(before + 1);
  });
  it("an unfinished revalidation keeps the original age and no claim across the observation deadline", async () => {
    const first = api(); await step(); await first;
    vi.setSystemTime(Date.now() + 2_001); await changeAttention("idle");
    const observedAt = state.entries.A.evidence.observation.observedAt, before = reads.filter(value => value.id === "A").length;
    held = deferred<ArrayBuffer>(); const request = api(); await step(1_500);
    await checkViews(await request); await checkAge(observedAt);
    await step(1_800); const again = api(); await step(); const result = await again;
    await checkViews(result); await checkAge(observedAt);
    expect.soft(result.tabs.find(tab => tab.sessionId === "A")).toMatchObject({ observedAt, fact: { kind: "idle" } });
    expect.soft(state.entries.A.readPending).toBe(true);
    expect.soft(state.entries.A.readFailures).toBe(0);
    expect.soft(reads.filter(value => value.id === "A")).toHaveLength(before + 1);
  });
  it("attention changing during a read cannot certify that read with the newer state", async () => {
    const first = api(); await step(); await first;
    vi.setSystemTime(Date.now() + 2_001); await changeAttention("idle");
    const revalidation = held = deferred<ArrayBuffer>(); const request = api(); await step(1_500); await request;
    vi.setSystemTime(Date.now() + 1); await changeAttention("waiting");
    revalidation.resolve(frame(backend.get("A")!.text)); await step();
    const observedAt = state.entries.A.evidence.observation.observedAt; await checkAge(observedAt);
    const before = reads.filter(value => value.id === "A").length;
    backend.get("A")!.text += "\x1b[3J\x1b[2J\x1b[H" + healthyScreen;
    const current = api(); await step(); const result = await current; await checkViews(result);
    expect.soft(reads.filter(value => value.id === "A")).toHaveLength(before + 1);
    expect.soft(result.tabs.find(tab => tab.sessionId === "A")).toMatchObject({ readable: true, fact: { kind: "idle" } });
  });
  it("a healthy idle screen keeps its age without ordinary idle polling", async () => {
    backend.get("A")!.text = healthyScreen;
    const first = api(); await step(); await first;
    const observedAt = state.entries.A.evidence.observation.observedAt, before = reads.filter(value => value.id === "A").length;
    vi.setSystemTime(Date.now() + 2_001); await changeAttention("done");
    const next = api(); await step(); await checkViews(await next); await checkAge(observedAt);
    await step(6_000); const later = api(); await step(); await checkViews(await later); await checkAge(observedAt);
    expect.soft(reads.filter(value => value.id === "A")).toHaveLength(before);
  });
});

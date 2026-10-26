// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance as wallClock } from "node:perf_hooks";
// @ts-expect-error Published headless ESM does not ship adjacent declarations.
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import type { Terminal as RendererTerminal } from "@xterm/xterm";
import { LiveTailList } from "../../src/components/layout/LiveTailList";
import { handleSocketCommand, readPaneTail } from "../../src/components/layout/socketCommands";
import { __headlessBufferStateForTests, __resetHeadlessBufferCacheForTests } from "../../src/components/terminal/headlessBuffer";
import { isTerminalParsingCurrentOutput, liveTerms, markTerminalBufferReady, registerCurrentOutputParser, termCache, terminalSizeCache } from "../../src/components/terminal/terminalCache";
import { createSession, killSession } from "../../src/lib/ipc";
import { __resetPtyReadGenerationsForTests, ptyReadGeneration } from "../../src/lib/ptyReadGeneration";
import { loadLiveTailOutputs, loadLiveTailTargets } from "../../src/lib/liveTail/targets";
import { createLiveTailController, statusForLiveTailTarget } from "../../src/stores/liveTailStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Workspace } from "../../src/types";

// This is the only module mock: binary frames pass through the production IPC
// decoder, parser/cache, reader, target loader, controller and Zustand store.
const core = vi.hoisted(() => ({ invoke: vi.fn(), nextContext: 0 }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: async (command: string, ...parameters: any[]) => {
    const args = parameters[0] ?? {};
    if (command === "get_session_attachment_contexts") return args.sessionIds.map((session_id: string) => ({
      backend_epoch: "fixture-backend", transfer_id: args.transferToken ?? null, transfer_token: args.transferToken ?? null,
      session_id, window_label: "main", window_incarnation: "fixture-window",
      attachment_epoch: ++core.nextContext, nonce: String(core.nextContext), existing_only: args.existingOnly,
    }));
    const result = await core.invoke(command, ...parameters);
    return command === "create_session" || command === "tearout_attach" ? result ?? args.attachmentContext : result;
  },
  Channel: class { id = 1; onmessage = (_data: unknown) => {}; },
}));
const encoder = new TextEncoder();
const startTime = 1_800_000_000_000;
const sid = "invariant-session";
let messageInput = { text: "", accepted: false };
const working = "* Thinking… (3m 12s · ↓ 62.3k tokens)";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function frame(text: string, epoch: number, since?: { endOffset: number; sessionEpoch: number }): ArrayBuffer {
  const data = encoder.encode(text), delta = since?.sessionEpoch === epoch && since.endOffset <= data.length;
  const offset = delta ? since!.endOffset : 0;
  const wire = new ArrayBuffer(48 + data.length - offset), view = new DataView(wire);
  new Uint8Array(wire).set([0x4d, 0x43, 0x53, 0x32]);
  view.setUint32(4, delta ? 1 : 0, true);
  view.setBigUint64(8, BigInt(offset), true); view.setBigUint64(16, BigInt(data.length), true);
  view.setBigUint64(24, BigInt(epoch), true); view.setBigUint64(32, 1n, true);
  view.setUint16(40, 80, true); view.setUint16(42, 24, true);
  new Uint8Array(wire, 48).set(data.subarray(offset));
  return wire;
}
const workspace: Workspace = { id: "invariant-workspace", name: "Invariants", gridTemplateId: "1x1", createdAt: 1,
  status: "running", panes: [{ id: "invariant-pane", sessionId: sid, agentId: "claude", activeTabId: "invariant-tab",
    tabs: [{ id: "invariant-tab", sessionId: sid, agentId: "claude", agentKind: "claude", type: "terminal", label: "Invariant seat" }] }] };
let controller: ReturnType<typeof createLiveTailController>;
let backend: { text: string; epoch: number; outputAt: number };
let nextFetch: ReturnType<typeof deferred<ArrayBuffer>> | undefined;
let discoveryDelay: number;
let outputMode: "fresh" | "missing" | "pending";
let fetches: number, writes: string[];
let cachedTerminal: RendererTerminal | undefined;
let root: Root | undefined, host: HTMLDivElement | undefined;
let failDiscovery: boolean, failFetch: boolean, rendererVisible: boolean;
let rendererParsedText: string | undefined;
let settledReadFailures: number;
let heldOutputs: Array<{ task: ReturnType<typeof deferred<Record<string, number>>>; output: Record<string, number> }>;
function attention(uiState: "working" | "idle" | "waiting" = "working", epoch = backend.epoch) {
  useSessionAttentionStore.setState({ attentionBySession: { [sid]: { sessionId: sid, sessionEpoch: epoch,
    attentionId: null, kind: "none", detail: null, sessionRevision: epoch, uiState, stateSince: Date.now(), occurrenceOrder: 1 } } });
}
async function step(ms = 20) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function api() { const task = controller.getForApi(); await step(30); return task; }
function entry() { return controller.store.getState().entries[sid]; }
function screen() { return entry()?.evidence.observation.crop.rows.join("\n") ?? ""; }
async function renderList() {
  if (!host) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
  await act(async () => root!.render(<LiveTailList workspace={workspace} {...controller.store.getState()} />));
}
beforeEach(async () => {
  core.invoke.mockReset(); __resetHeadlessBufferCacheForTests(); __resetPtyReadGenerationsForTests(); terminalSizeCache.clear();
  termCache.clear(); liveTerms.clear(); useSessionAttentionStore.getState().resetForTests();
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: "another-workspace" });
  backend = { text: `Current work\r\n${working}\r\n`, epoch: 17, outputAt: startTime };
  nextFetch = undefined; discoveryDelay = 0; outputMode = "fresh"; fetches = 0; writes = [];
  failDiscovery = false; failFetch = false; rendererVisible = false; settledReadFailures = 0; heldOutputs = [];
  rendererParsedText = undefined;
  core.invoke.mockImplementation(async (command: string, args: { since?: { endOffset: number; sessionEpoch: number }; data?: string }) => {
    if (command === "get_pty_metadata_snapshot") {
      if (failDiscovery) throw new Error("discovery unavailable");
      if (discoveryDelay) await new Promise(resolve => setTimeout(resolve, discoveryDelay));
      return { [sid]: { process_status: "working" } };
    }
    if (command === "get_window_fragments") return [];
    if (command === "get_session_output_snapshot") {
      if (outputMode === "pending") {
        const task = deferred<Record<string, number>>(); heldOutputs.push({ task, output: { [sid]: backend.outputAt } }); return task.promise;
      }
      return outputMode === "missing" ? {} : { [sid]: backend.outputAt };
    }
    if (command === "get_session_scrollback") {
      fetches++;
      if (failFetch) { settledReadFailures++; throw new Error("attempted read failed"); }
      if (nextFetch) { const held = nextFetch; nextFetch = undefined; return held.promise; }
      return frame(backend.text, backend.epoch, args.since);
    }
    if (command === "kill_session") return;
    if (command === "create_session") return;
    if (command === "prepare_pane_message") {
      messageInput = { text: "", accepted: false };
      return { guard: { sessionId: sid, sessionEpoch: backend.epoch, inputRevision: 0, agentMessage: true }, reason: null };
    }
    if (command === "verify_pane_message") return { confirmed: messageInput.accepted && messageInput.text === args.text };
    if (command === "write_pane_message") {
      if (backend.epoch !== args.guard.sessionEpoch) return { sent: false, reason: "session_epoch" };
      if (args.submit) messageInput.accepted = true; else messageInput.text = args.data;
      writes.push(args.data); backend.text += args.submit ? "\r\nSubmitted\r\n" : args.data;
      backend.outputAt = Date.now(); return { sent: true, reason: null };
    }
    if (command === "write_to_session") {
      writes.push(args.data!); backend.text += args.data === "\r" ? "\r\nSubmitted\r\n" : args.data;
      backend.outputAt = Date.now(); return;
    }
    throw new Error(`Unexpected Tauri core command: ${command}`);
  });
  // Warm dynamic imports before using fake time, without replacing any reader.
  await readPaneTail(sid, 40); __resetHeadlessBufferCacheForTests(); fetches = 0;
  vi.useFakeTimers(); vi.setSystemTime(startTime); attention();
  controller = createLiveTailController({ listTargets: loadLiveTailTargets, loadOutputs: loadLiveTailOutputs,
    readTail: (id, lines, isCurrent) => readPaneTail(id, lines, false,
      { headlessFetchTimeoutMs: 4_000, purpose: "observation", isCurrent }) });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const events = ["observe", "replace-pty", "release-reacquire", "lease-renew", "discovery-delay", "discovery-failure",
  "fetch-delay", "fetch-failure", "parse-delay", "output-pending", "output-missing", "renderer-cache", "renderer-visible",
  "renderer-park", "pane-read", "send-confirm", "settle", "quiet"] as const;
type Event = typeof events[number];
// Cover every ordered pair, then vary deterministic suffixes and length. This
// drives production transitions, rather than checking a separate state model.
function sequences(): Event[][] {
  return events.flatMap((a, i) => events.map((b, j) => {
    let seed = i * events.length + j + 1;
    const length = 5 + (seed - 1) % 3, sequence: Event[] = ["observe", a, b];
    while (sequence.length < length - 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      sequence.push(events[seed % events.length]);
    }
    sequence.push("settle"); return sequence;
  }));
}
const generated = sequences();
const metrics = { sequences: 0, steps: 0, invariantChecks: 0, pairCount: events.length ** 2, lengths: {} as Record<number, number>,
  parseDelays: 0, ordinaryReads: 0, confirmedSends: 0, elapsedMs: 0 };
afterAll(() => {
  if (!metrics.sequences) return;
  mkdirSync(".dispatch", { recursive: true });
  writeFileSync(".dispatch/stage-B3-B2-continuity-counts.json", JSON.stringify(metrics, null, 2) + "\n");
});

describe("B2 mechanically generated real-path event sequences", () => {
  it.each(generated.map((sequence, index) => ({ sequence, index })))("sequence $index: $sequence", async ({ sequence, index }) => {
    const began = wallClock.now();
    if (index % 2 === 0) backend.text = "Unmarked answer\r\n";
    let release = controller.acquireConsumer("sidebar");
    const tasks: Promise<unknown>[] = [];
    const held: Array<{ task: ReturnType<typeof deferred<ArrayBuffer>>; wire: ArrayBuffer }> = [];
    const observe = async (parsePending = false) => {
      vi.setSystemTime(Date.now() + 2_001);
      tasks.push(controller.getForApi());
      if (parsePending) {
        for (let turn = 0; turn < 100; turn++) await Promise.resolve();
        if (__headlessBufferStateForTests().entries.some(value => value.busy)) metrics.parseDelays++;
      } else await step(30);
    };
    const settle = async () => {
      discoveryDelay = 0; failDiscovery = false; failFetch = false; outputMode = "fresh";
      nextFetch = undefined;
      for (const pending of held.splice(0)) pending.task.resolve(pending.wire);
      for (const pending of heldOutputs.splice(0)) pending.task.resolve(pending.output);
      await step(1_650);
    };
    const paintRenderer = async () => {
      if (!cachedTerminal) cachedTerminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true }) as RendererTerminal;
      termCache.delete(sid); liveTerms.set(sid, cachedTerminal);
      const parsed = new Promise<void>(resolve => cachedTerminal!.write("\x1b[3J\x1b[2J\x1b[H" + backend.text, resolve));
      await step(); await parsed; markTerminalBufferReady(cachedTerminal);
      rendererParsedText = backend.text;
      registerCurrentOutputParser(sid, cachedTerminal, () => rendererVisible && rendererParsedText === backend.text);
    };
    const check = async () => {
      const state = controller.store.getState(), debug = controller.__inspectForTests(), cache = __headlessBufferStateForTests();
      const current = ptyReadGeneration(sid), sample = state.entries[sid], scope = debug.scopes.get(sid);
      // LINV1: actual publication/cache lifetime, including output enrichment.
      if (sample?.history.length && !sample.retained) {
        expect(scope?.demand).toBe(debug.demand); expect(scope?.pty).toBe(current); expect(current.available).toBe(true);
      }
      for (const value of cache.entries) expect(value.generation).toBe(ptyReadGeneration(value.sessionId));
      for (const output of debug.outputs.values()) { expect(output.scope.demand).toBe(debug.demand); expect(output.scope.pty).toBe(current); }
      // LINV2: a cached/parked/noncurrent Terminal never holds read authority.
      const authorized = isTerminalParsingCurrentOutput(sid);
      if (!rendererVisible || termCache.has(sid) || !liveTerms.has(sid) || !current.available) expect(authorized).toBe(false);
      if (authorized) expect(liveTerms.get(sid)).toBe(cachedTerminal);
      // LINV3: delayed observer fetches cannot occupy the parser queue.
      if (held.length && !cache.entries.some(value => value.busy)) expect(cache.queued).not.toContain(sid);
      // LINV4: only actual settled attempted read failures can increase counts.
      expect(sample?.readFailures ?? 0).toBeLessThanOrEqual(settledReadFailures);
      if (sample?.readPending && !settledReadFailures) expect(sample.readFailures).toBe(0);
      // LINV5: work badges require a working screen, independent of readability.
      const tab = controller.snapshot().tabs.find(value => value.sessionId === sid);
      if (tab && ["progress", "cmd", "stale", "frozen"].includes(tab.fact.kind)) expect(sample.evidence.observation.crop.state).toBe("working");
      if (sample?.evidence.observation.crop.state === "unknown" && tab) expect(["alive", "idle"]).toContain(tab.fact.kind);
      // LINV6: silence proof comes from this actual sample's output round.
      if (tab?.fact.kind === "frozen") {
        const output = debug.outputs.get(sid);
        expect(sample.evidence.observation.outputFresh).toBe(true); expect(sample.retained).toBe(false);
        expect(output?.scope.round).toBe(scope?.round); expect(output?.scope.pty).toBe(current);
        expect(sample.evidence.observation.observedAt - sample.evidence.observation.lastOutputAt!).toBeGreaterThanOrEqual(20_000);
      }
      expect(debug.pendingReads.length).toBeLessThanOrEqual(2);
      expect(debug.starts.filter(at => Date.now() - at < 2_000).length).toBeLessThanOrEqual(12);
      expect(cache.entries.length).toBeLessThanOrEqual(12);
      expect(writes.every(value => value === "hello" || value === "\r")).toBe(true);
      await renderList();
      expect(host!.querySelector(".live-tail-badge")?.textContent).not.toBe("読めない");
      if (tab?.fact.kind === "unreadable") expect(sample?.evidence.observations).toBeGreaterThan(0);
      if (sample?.evidence.observation.crop.state === "unknown") {
        const row = host!.querySelector<HTMLButtonElement>(".live-tail-row");
        if (row) {
          await act(async () => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
          const text = document.querySelector('[role="tooltip"]')?.textContent ?? "";
          const status = statusForLiveTailTarget(state.targets.find(target => target.sessionId === sid)!);
          if (status === "working") expect(document.querySelector(".live-tail-fact")?.textContent).toBe("作業中");
          else expect(text).not.toContain("作業中");
          expect(text).not.toContain("止まっている"); expect(text).not.toContain("進んでいない");
        }
      }
      metrics.steps++; metrics.invariantChecks += 6;
    };
    for (const event of sequence) {
      switch (event) {
        case "observe": await observe(); break;
        case "replace-pty":
          await killSession(sid); backend.epoch++; backend.text = `PTY ${backend.epoch}\r\n${working}\r\n`;
          await createSession(sid, "synthetic", [], 80, 24, () => {}, undefined, undefined, false, { backgroundOnly: true });
          await act(async () => attention()); await step(); break;
        case "release-reacquire":
          vi.setSystemTime(Date.now() + 10_001); release(); release = controller.acquireConsumer("sidebar"); await step(); break;
        case "lease-renew":
          release(); vi.setSystemTime(Date.now() + 10_001); tasks.push(controller.getForApi()); await step(); break;
        case "discovery-delay": discoveryDelay = 1_600; await observe(); await step(1_470); break;
        case "discovery-failure": failDiscovery = true; await observe(); failDiscovery = false; break;
        case "fetch-delay": {
          rendererVisible = false;
          const task = nextFetch = deferred<ArrayBuffer>(); held.push({ task, wire: frame(backend.text, backend.epoch) }); await observe(); break;
        }
        case "fetch-failure": rendererVisible = false; failFetch = true; await observe(); failFetch = false; break;
        case "parse-delay":
          rendererVisible = false;
          backend.text += "\x1b[2K\r" + "p".repeat(32_768) + "\r\n" + working; await observe(true); break;
        case "output-pending": outputMode = "pending"; backend.outputAt = Date.now(); await observe(); break;
        case "output-missing": outputMode = "missing"; backend.text += "\x1b[?25h"; backend.outputAt = Date.now(); await observe(); break;
        case "renderer-cache":
          rendererVisible = false; await paintRenderer(); liveTerms.delete(sid);
          termCache.set(sid, { term: cachedTerminal!, xtermElement: document.createElement("div"), unlistenExit: null } as never); await observe(); break;
        case "renderer-visible": rendererVisible = true; await paintRenderer(); await observe(); break;
        case "renderer-park": rendererVisible = false; await paintRenderer(); await observe(); break;
        case "pane-read": {
          rendererVisible = false;
          let result: unknown; const task = handleSocketCommand("pane.read", { sessionId: sid, lines: 40 }).then(value => { result = value; });
          await step(190); expect(result).toMatchObject({ sessionId: sid, lines: expect.any(Array) }); await task; metrics.ordinaryReads++; break;
        }
        case "send-confirm": {
          rendererVisible = false;
          const task = handleSocketCommand("pane.send_text", { sessionId: sid, text: "hello", enter: true });
          await step(1_200); expect(await task).toMatchObject({ ok: true, confirmed: true }); metrics.confirmedSends++; break;
        }
        case "settle": await settle(); break;
        case "quiet": backend.text += "\x1b[?25h"; vi.setSystemTime(Date.now() + 21_001); await observe(); break;
      }
      await check();
    }
    await settle(); await step(4_000); await Promise.all(tasks); await check(); release();
    metrics.sequences++; metrics.lengths[sequence.length] = (metrics.lengths[sequence.length] ?? 0) + 1;
    metrics.elapsedMs += wallClock.now() - began;
  });
});
afterEach(async () => {
  if (root) { await act(async () => root!.unmount()); host!.remove(); root = undefined; host = undefined; }
  controller.dispose(); __resetHeadlessBufferCacheForTests(); cachedTerminal?.dispose(); cachedTerminal = undefined;
  termCache.clear(); liveTerms.clear(); terminalSizeCache.clear();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  useSessionAttentionStore.getState().resetForTests(); vi.useRealTimers();
});

describe("B2 regressions through real live-tail paths", () => {
  it.each([false, true])("R1 preserves settled PTY absence when a later create fails (queued=%s)", async queued => {
    core.invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("create failed"));
    const killed = killSession(sid);
    if (!queued) { await step(); await killed; }
    const creating = createSession(sid, "synthetic", [], 80, 24, () => {}, undefined, undefined, false, { backgroundOnly: true });
    const rejected = expect(creating).rejects.toThrow("create failed");
    await step(); await killed; await rejected;
    await api(); expect(screen()).toBe("");
  });
  it.each(["create", "kill"])("allows fresh evidence after a settled failed PTY %s", async operation => {
    core.invoke.mockRejectedValueOnce(new Error("PTY transition failed"));
    const task = operation === "kill" ? killSession(sid)
      : createSession(sid, "synthetic", [], 80, 24, () => {}, undefined, undefined, false, { backgroundOnly: true });
    const rejected = expect(task).rejects.toThrow("PTY transition failed"); await step(); await rejected;
    await api(); expect(screen()).toContain("Current work");
  });
  it("R1 rejects a producer born during a pending kill after that kill completes", async () => {
    const killing = deferred<void>(); core.invoke.mockImplementationOnce(() => killing.promise);
    const kill = killSession(sid); await step();
    backend.epoch++; backend.text = "BORN DURING KILL\r\n" + working; attention();
    const held = nextFetch = deferred<ArrayBuffer>(); const old = frame(backend.text, backend.epoch);
    controller.acquireConsumer("sidebar"); await step();
    killing.resolve(); await kill; held.resolve(old); await step();
    expect(screen()).not.toContain("BORN DURING KILL");
  });
  it("keeps a retired renderer parse callback from granting current authority", async () => {
    cachedTerminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true }) as RendererTerminal;
    liveTerms.set(sid, cachedTerminal); const retired = ptyReadGeneration(sid);
    backend.epoch++; attention(); rendererVisible = true;
    registerCurrentOutputParser(sid, cachedTerminal, () => rendererVisible);
    const parsed = new Promise<void>(resolve => cachedTerminal!.write("RETIRED PARSE", () => {
      markTerminalBufferReady(cachedTerminal!, retired); resolve();
    }));
    await step(); await parsed; expect(isTerminalParsingCurrentOutput(sid)).toBe(false);
    await api(); expect(screen()).toContain("Current work");
  });
  it("reads a recreated PTY even while the previous producer's idle attention is retained", async () => {
    attention("idle"); await api();
    expect(controller.snapshot().tabs).toEqual([expect.objectContaining({ sessionId: sid, readable: false, fact: expect.objectContaining({ kind: "idle" }) })]);
    await killSession(sid); backend.epoch++; backend.text = "RESUMED NEW\r\n" + working;
    await createSession(sid, "synthetic", [], 80, 24, () => {}, undefined, undefined, false, { backgroundOnly: true });
    vi.setSystemTime(Date.now() + 2_001); await api(); expect(screen()).toContain("RESUMED NEW");
  });
  it("keeps a newer parser geometry when an older observer response arrives", async () => {
    const warm = readPaneTail(sid, 40); await step(); await warm;
    const held = nextFetch = deferred<ArrayBuffer>(); const old = frame(backend.text, backend.epoch);
    controller.acquireConsumer("sidebar"); await step();
    backend.text += "\r\nNEW GEOMETRY\r\n";
    const newer = frame(backend.text, backend.epoch); const view = new DataView(newer);
    view.setBigUint64(32, 2n, true); view.setUint16(40, 90, true);
    core.invoke.mockImplementationOnce(async () => newer);
    const interactive = readPaneTail(sid, 40, true); await step(); await interactive;
    held.resolve(old); await step();
    expect(__headlessBufferStateForTests().entries[0].endOffset).toBe(encoder.encode(backend.text).length);
    const cached = readPaneTail(sid, 40, true); await step(); expect(await cached).toContain("NEW GEOMETRY");
  });
  it("R1 rejects an old binary response after same-ID PTY replacement", async () => {
    const held = nextFetch = deferred<ArrayBuffer>(); const old = frame("OLD PTY\r\n" + working, 17);
    const release = controller.acquireConsumer("sidebar"); await step(1_500);
    await killSession(sid); backend.epoch = 18; backend.text = "NEW PTY\r\n" + working; attention();
    held.resolve(old); await step();
    expect(screen()).not.toContain("OLD PTY"); expect(entry()?.history.some(sample => sample.rawRows.join().includes("OLD PTY"))).not.toBe(true);
    release(); expect(writes).toEqual([]);
  });
  it.each(["cached", "hidden mounted"])("R2 reads backend progress instead of a parsed %s renderer", async place => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true }) as RendererTerminal;
    cachedTerminal = term; const parsed = new Promise<void>(resolve => term.write("RENDERER OLD\r\n" + working, resolve));
    await step(); await parsed; markTerminalBufferReady(term);
    if (place === "cached") termCache.set(sid, { term, xtermElement: document.createElement("div"), unlistenExit: null } as never);
    else liveTerms.set(sid, term);
    backend.text = "BACKEND NEW\r\n" + working;
    await api(); expect(screen()).toContain("BACKEND NEW"); expect(fetches).toBeGreaterThan(0); expect(writes).toEqual([]);
  });
  it("R3 does not hold pane.read behind an observer fetch", async () => {
    const held = nextFetch = deferred<ArrayBuffer>(); controller.acquireConsumer("sidebar"); await step();
    let result: unknown; const read = handleSocketCommand("pane.read", { sessionId: sid, lines: 40 }).then(value => { result = value; });
    await step(190); expect(result).toMatchObject({ sessionId: sid, lines: expect.arrayContaining(["Current work"]) });
    held.resolve(frame(backend.text, backend.epoch)); await step(); await read;
  });
  it("R3 confirms a real send while an observer fetch is pending", async () => {
    const held = nextFetch = deferred<ArrayBuffer>(); controller.acquireConsumer("sidebar"); await step();
    const send = handleSocketCommand("pane.send_text", { sessionId: sid, text: "hello", enter: true });
    await step(1_200); expect(await send).toMatchObject({ ok: true, confirmed: true });
    held.resolve(frame(backend.text, backend.epoch)); await step(); expect(writes).toEqual(["hello", "\r"]);
  });
  it("R4 retains the original sample after two slow successful discoveries", async () => {
    await api(); const before = entry(); const observedAt = before.evidence.observation.observedAt;
    discoveryDelay = 1_600;
    for (let i = 0; i < 2; i++) {
      vi.setSystemTime(Date.now() + 2_001); const request = controller.getForApi(); await step(1_500); await request; await step(110);
    }
    expect(entry()).toMatchObject({ readFailures: 0, retained: true });
    expect(entry().history).toEqual(before.history); expect(entry().evidence.observation.observedAt).toBe(observedAt);
  });
  it("R5 gives an unmarked screen neutral tooltip wording", async () => {
    useSessionAttentionStore.setState({ attentionBySession: {} }); backend.text = "Unmarked answer\r\n"; await api();
    await renderList(); const row = host!.querySelector<HTMLButtonElement>(".live-tail-row")!;
    await act(async () => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')!.textContent).not.toContain("作業中");
  });
  it("R5 keeps unknown quiet screens neutral and reconciles trusted idle", async () => {
    useSessionAttentionStore.setState({ attentionBySession: {} }); backend.text = "Unmarked answer\r\n"; await api();
    vi.setSystemTime(startTime + 21_001); await api(); expect(controller.snapshot().tabs[0].fact.kind).toBe("alive");
    attention("idle"); vi.setSystemTime(Date.now() + 2_001); await api(); await renderList();
    expect(host!.textContent).toContain("ほか 入力待ち 1"); expect(host!.querySelector(".live-tail-row")).toBeNull();
    await act(async () => attention("waiting"));
    expect(host!.querySelector(".live-tail-idle")).toBeNull();
    const row = host!.querySelector<HTMLButtonElement>(".live-tail-row")!;
    await act(async () => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector('[role="tooltip"] .live-tail-popup-rows--previous')).not.toBeNull();
    expect(document.querySelector('[role="tooltip"] .live-tail-fact')?.textContent).toBe("回答待ち");
    vi.setSystemTime(Date.now() + 2_001); await api(); await renderList();
    await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')!.textContent).toContain("回答待ち");
  });
  it("R6 invalidates a read across demand release and immediate reacquisition", async () => {
    const held = nextFetch = deferred<ArrayBuffer>(); const release = controller.acquireConsumer("sidebar"); await step(1_500);
    release(); controller.acquireConsumer("sidebar"); await step();
    await renderList(); expect(host!.querySelector(".live-tail-badge")).toBeNull();
    held.resolve(frame("OLD DEMAND\r\n" + working, 17)); await step(); expect(screen()).not.toContain("OLD DEMAND");
  });
  it("R6 restarts settled failure evidence after a demand lifetime ends", async () => {
    const release = controller.acquireConsumer("sidebar"); await step();
    failFetch = true; await step(4_000); expect(entry().readFailures).toBe(2);
    release(); controller.acquireConsumer("sidebar"); await step(); expect(entry().readFailures).toBe(1);
  });
  it("R6 invalidates a read across API expiry and renewal before the expiry timer runs", async () => {
    const held = nextFetch = deferred<ArrayBuffer>(); const first = controller.getForApi(); await step(1_500); await first;
    vi.setSystemTime(startTime + 10_001); const renewed = controller.getForApi(); await step();
    held.resolve(frame("EXPIRED LEASE\r\n" + working, 17)); await step(); await renewed;
    expect(screen()).not.toContain("EXPIRED LEASE");
  });
  it.each(["pending", "missing"] as const)("R7 requires fresh output evidence when the next timestamp is %s", async mode => {
    await api(); outputMode = mode; backend.text += "\x1b[?25h"; backend.outputAt = startTime + 21_001;
    vi.setSystemTime(startTime + 21_001); const request = controller.getForApi(); await step(1_500); await request;
    expect(controller.snapshot().tabs[0].fact.kind).not.toBe("frozen");
    expect(entry().evidence.observation.lastOutputAt).toBe(startTime);
  });
});

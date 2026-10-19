// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance as wallClock } from "node:perf_hooks";
// @ts-expect-error Published ESM has no adjacent declarations.
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import type { Terminal as RendererTerminal } from "@xterm/xterm";
import { LiveTailList } from "../../src/components/layout/LiveTailList";
import { handleSocketCommand, readPaneTail } from "../../src/components/layout/socketCommands";
import { __headlessBufferStateForTests, __resetHeadlessBufferCacheForTests } from "../../src/components/terminal/headlessBuffer";
import { liveTerms, termCache, markTerminalBufferReady, isTerminalParsingCurrentOutput, pendingTerminalBufferWrites } from "../../src/components/terminal/terminalCache";
import { createSession, killSession } from "../../src/lib/ipc";
import * as registry from "../../src/lib/ptyReadGeneration";
import { loadLiveTailOutputs, loadLiveTailTargets } from "../../src/lib/liveTail/targets";
import { createLiveTailController, liveTailAttentionChanged } from "../../src/stores/liveTailStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { trustedLiveTailAttention } from "../../src/lib/liveTail/status";
import type { Workspace } from "../../src/types";
import { xtermWritePump } from "../fixtures/xtermWritePump";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: core.invoke,
  Channel: class { id = 1; onmessage = (_data: unknown) => {}; },
}));
const start = 1_800_000_000_000, working = "* Thinking… (3m 12s · ↓ 62.3k tokens)";
const errorScreen = "API Error: 500 sample\r\n* Cooked for 3s · done 01:00\r\n";
const encoder = new TextEncoder();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function frame(text: string, epoch: number): ArrayBuffer {
  const bytes = encoder.encode(text), result = new ArrayBuffer(48 + bytes.length), view = new DataView(result);
  new Uint8Array(result).set([0x4d, 0x43, 0x53, 0x32]);
  view.setBigUint64(16, BigInt(bytes.length), true); view.setBigUint64(24, BigInt(epoch), true);
  view.setBigUint64(32, 1n, true); view.setUint16(40, 80, true); view.setUint16(42, 24, true);
  new Uint8Array(result, 48).set(bytes); return result;
}
type Backend = { epoch: number; text: string; outputAt: number; failed?: boolean };
let backend: Map<string, Backend>, held: Map<string, ReturnType<typeof deferred<ArrayBuffer>>>;
// This oracle records the fake backend's actual acquisition/output history;
// it does not inspect controller scope, outputFresh or fact implementation.
let oracle: Array<{ acquiredAt: number; sessionId: string; lastOutputAt: number; epoch: number; delivered: boolean }>;
let nativeFrames: Array<{ id: string; task: ReturnType<typeof deferred<ArrayBuffer>>; wire: ArrayBuffer; settled: boolean }>;
let nativeOutputs: Array<{ ids: string[]; task: ReturnType<typeof deferred<Record<string, number>>>; values: Record<string, number>; settled: boolean }>;
let outputMode: "fresh" | "pending" | "missing", discoveryDelay: number, discoveryFailed: boolean;
let settledFailures: Map<string, number>, writes: string[];
let foreignIds: string[];
let controller: ReturnType<typeof createLiveTailController>, workspace: Workspace;
let reads: string[], roots: Root[], terms: RendererTerminal[], pumps: ReturnType<typeof xtermWritePump>[];
async function step(ms = 20) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function turns() { for (let i = 0; i < 70; i++) await Promise.resolve(); }
function scene(ids: string[]) {
  workspace = { id: "b3-workspace", name: "B3", gridTemplateId: "1x1", createdAt: start, status: "running",
    panes: ids.map((id, i) => ({ id: `pane-${i}`, sessionId: id, agentId: "claude", activeTabId: `tab-${id}`,
      tabs: [{ id: `tab-${id}`, sessionId: id, agentId: "claude", agentKind: "claude", type: "terminal" as const, label: id }] })) };
  for (const [i, id] of ids.entries()) if (!backend.has(id)) backend.set(id, { epoch: 17 + i, text: `${id}\r\n${working}\r\n`, outputAt: start });
  useWorkspaceListStore.setState({ workspaces: ids.length ? [workspace] : [], activeWorkspaceId: "elsewhere" });
  attention();
}
function attention(kind: "none" | "error" | "rate_limited" = "none", id = "A", uiState: "working" | "waiting" | "idle" | "done" = kind === "none" ? "working" : "waiting") {
  const ids = workspace.panes.flatMap(pane => pane.tabs.map(tab => tab.sessionId));
  useSessionAttentionStore.setState({ attentionBySession: Object.fromEntries(ids.map(sid => [sid, {
    sessionId: sid, sessionEpoch: backend.get(sid)!.epoch, sessionRevision: backend.get(sid)!.epoch,
    attentionId: null, kind: sid === id ? kind : "none", detail: null,
    uiState: sid === id ? uiState : "working", stateSince: Date.now(), occurrenceOrder: 1,
  }])) });
}
const inspectRegistry = () => (registry as unknown as { __inspectPtyReadsForTests(): {
  generations: string[]; absent: string[]; transitions: string[];
} }).__inspectPtyReadsForTests();

beforeEach(async () => {
  core.invoke.mockReset(); __resetHeadlessBufferCacheForTests(); registry.__resetPtyReadGenerationsForTests();
  liveTerms.clear(); termCache.clear(); useSessionAttentionStore.getState().resetForTests();
  backend = new Map(); held = new Map(); oracle = []; reads = []; roots = []; terms = []; pumps = [];
  nativeFrames = []; nativeOutputs = []; outputMode = "fresh"; discoveryDelay = 0; discoveryFailed = false;
  settledFailures = new Map(); writes = [];
  foreignIds = [];
  scene(["A", "B", "C"]);
  core.invoke.mockImplementation(async (command: string, args: { sessionId: string; data?: string }) => {
    if (command === "get_pty_metadata_snapshot") {
      if (discoveryFailed) throw new Error("metadata discovery failed");
      if (discoveryDelay) await new Promise(resolve => setTimeout(resolve, discoveryDelay));
      return Object.fromEntries([...backend].map(([id]) => [id, { process_status: "working" }]));
    }
    if (command === "get_window_fragments") return foreignIds.length ? [{ window_label: "foreign", pending: false,
      workspaces: [{ id: "foreign-workspace", name: "Foreign", panes: foreignIds.map(id => ({ pane_id: `foreign-pane-${id}`,
        agent_id: "claude", tabs: [{ tab_id: `foreign-tab-${id}`, session_id: id, agent_id: "claude", agent_kind: "claude", type: "terminal" }] })) }] }] : [];
    if (command === "get_session_output_snapshot") {
      if (outputMode === "missing") return {};
      const acquisitions: typeof oracle = [];
      const values = Object.fromEntries([...backend].map(([id, value]) => {
        const acquisition = { acquiredAt: Date.now(), sessionId: id, lastOutputAt: value.outputAt, epoch: value.epoch, delivered: outputMode !== "pending" };
        oracle.push(acquisition); acquisitions.push(acquisition); return [id, value.outputAt];
      }));
      if (outputMode === "pending") {
        const task = deferred<Record<string, number>>(); nativeOutputs.push({ ids: [...backend.keys()], task, values, settled: false });
        const result = await task.promise; acquisitions.forEach(value => { value.delivered = true; }); return result;
      }
      return values;
    }
    if (command === "get_session_scrollback") {
      reads.push(args.sessionId);
      if (held.has(args.sessionId)) {
        const task = held.get(args.sessionId)!, value = backend.get(args.sessionId)!; held.delete(args.sessionId);
        const record = { id: args.sessionId, task, wire: frame(value.text, value.epoch), settled: false }; nativeFrames.push(record);
        try { return await task.promise; } finally { record.settled = true; }
      }
      const value = backend.get(args.sessionId)!;
      if (value.failed) { settledFailures.set(args.sessionId, (settledFailures.get(args.sessionId) ?? 0) + 1); throw new Error("settled read failure"); }
      return frame(value.text, value.epoch);
    }
    if (["create_session", "kill_session", "ack_frontend_data"].includes(command)) return;
    if (command === "write_to_session") {
      writes.push(args.data!); const value = backend.get(args.sessionId)!;
      value.text += args.data === "\r" ? "\r\nSubmitted\r\n" : args.data; value.outputAt = Date.now(); return;
    }
    throw new Error(`Unexpected core command: ${command}`);
  });
  await readPaneTail("A", 40); __resetHeadlessBufferCacheForTests(); reads = [];
  vi.useFakeTimers(); vi.setSystemTime(start); attention();
  controller = createLiveTailController({ listTargets: loadLiveTailTargets, loadOutputs: loadLiveTailOutputs,
    readTail: (id, lines, isCurrent) => readPaneTail(id, lines, false, { purpose: "observation", headlessFetchTimeoutMs: 4_000, isCurrent }) });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  pumps.forEach(pump => pump.dispose()); terms.forEach(term => term.dispose());
  controller.dispose(); __resetHeadlessBufferCacheForTests(); liveTerms.clear(); termCache.clear();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  nativeFrames.filter(record => !record.settled).forEach(record => record.task.resolve(record.wire));
  nativeOutputs.filter(record => !record.settled).forEach(record => { record.settled = true; record.task.resolve(record.values); });
  await step(4_100);
  useSessionAttentionStore.getState().resetForTests(); vi.useRealTimers();
});

const events = ["observe", "replace", "release-reacquire", "lease-renew", "discovery-delay", "discovery-failure",
  "fetch-delay", "fetch-failure", "headless-parse-delay", "output-pending", "output-missing", "renderer-visible",
  "renderer-cache", "renderer-park", "pane-read", "send-confirm", "quiet", "churn", "queued-invalidate",
  "watchdog-parse", "invisible-output", "error-attention", "rate-attention", "settle"] as const;
type Event = typeof events[number] | "idle-attention" | "done-attention" | "settled-unreadable" | "healthy-screen";
const generated = events.flatMap((a, i) => events.map((b, j) => {
  let seed = i * events.length + j + 1;
  const length = 5 + (seed - 1) % 3, sequence: Event[] = ["observe", a, b];
  while (sequence.length < length - 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; sequence.push(events[seed % events.length]);
  }
  sequence.push("settle"); return { sequence, index: i * events.length + j, sessions: 3 + (i + j) % 3, corpus: "B3-original" };
}));
// Preserve the original 24×24 order and seeds above. The extended corpus has
// its own 28×28 order, including both idle transitions after each exception.
const stageCEvents = [...events, "idle-attention", "done-attention", "settled-unreadable", "healthy-screen"] as const;
const stageCGenerated = stageCEvents.flatMap((a, i) => stageCEvents.map((b, j) => {
  let seed = i * stageCEvents.length + j + 1;
  const length = 5 + (seed - 1) % 3, sequence: Event[] = ["observe", a, b];
  while (sequence.length < length - 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; sequence.push(stageCEvents[seed % stageCEvents.length]);
  }
  sequence.push("settle"); return { sequence, index: i * stageCEvents.length + j, sessions: 3 + (i + j) % 3, corpus: "C-extended" };
}));
const newMetrics = (pairCount: number) => ({ sequences: 0, states: 0, invariantChecks: 0, lengths: {} as Record<number, number>,
  sessions: {} as Record<number, number>, pairCount, elapsedMs: 0,
  attentionTransitions: 0, exceptionalIdleTransitions: 0,
  watchdogStates: 0, queuedInvalidations: 0, churnedSessions: 0, ordinaryReads: 0, confirmedSends: 0, parserDelays: 0 });
const originalMetrics = newMetrics(events.length ** 2), stageCMetrics = newMetrics(stageCEvents.length ** 2);
afterAll(() => {
  mkdirSync(".dispatch", { recursive: true });
  for (const [name, metrics] of [["B3-original", originalMetrics], ["extended", stageCMetrics]] as const) {
    if (metrics.sequences) writeFileSync(`.dispatch/stage-C-${name}-counts.json`, JSON.stringify(metrics, null, 2) + "\n");
  }
});

describe("B3 generated 3–5 session real-path sequences", () => {
  it.each([...generated, ...stageCGenerated])("$corpus sequence $index ($sessions sessions): $sequence", async ({ sequence, index, sessions, corpus }) => {
    const metrics = corpus === "B3-original" ? originalMetrics : stageCMetrics;
    const began = wallClock.now(), ids = ["A", "B", "C", "D", "E"].slice(0, sessions);
    scene(ids);
    if (index % 2 === 0) backend.get("A")!.text = "Unmarked answer\r\n";
    let release = controller.acquireConsumer("sidebar"), rendererVisible = false;
    let renderer: RendererTerminal | undefined, pump: ReturnType<typeof xtermWritePump> | undefined;
    const tasks: Promise<unknown>[] = [], apiErrors: unknown[] = [];
    const request = () => { const task = controller.getForApi().catch(error => { apiErrors.push(error); }); tasks.push(task); return task; };
    const park = () => { rendererVisible = false; pump?.visible(false); };
    const observe = async (holdParser = false) => {
      vi.setSystemTime(Date.now() + 2_001); request();
      if (holdParser) { await turns(); if (__headlessBufferStateForTests().entries.some(entry => entry.busy)) metrics.parserDelays++; }
      else await step(30);
    };
    const settle = async () => {
      discoveryDelay = 0; discoveryFailed = false; outputMode = "fresh"; held.clear();
      backend.forEach(value => { value.failed = false; });
      for (const record of nativeFrames.filter(value => !value.settled)) record.task.resolve(record.wire);
      for (const record of nativeOutputs.filter(value => !value.settled)) { record.settled = true; record.task.resolve(record.values); }
      await step(1_650);
    };
    const paint = async () => {
      if (!renderer) {
        renderer = new Terminal({ cols: 80, rows: 24, allowProposedApi: true }) as RendererTerminal;
        terms.push(renderer); liveTerms.set("A", renderer);
        pump = xtermWritePump("A", renderer); pumps.push(pump);
      }
      termCache.delete("A"); liveTerms.set("A", renderer); rendererVisible = true; pump!.visible(true);
      pump!.attach();
      const writing = pump!.submit("\x1b[3J\x1b[2J\x1b[H" + backend.get("A")!.text);
      await step(); await writing;
    };
    const check = async () => {
      const state = controller.store.getState(), debug = controller.__inspectForTests(), cache = __headlessBufferStateForTests();
      const tabs = controller.snapshot().tabs, records = registry.__inspectPtyReadsForTests();
      const live = new Set(workspace.panes.flatMap(pane => pane.tabs.map(tab => tab.sessionId)));
      const outstanding = new Set([...debug.pendingReads, ...cache.entries.filter(value => value.busy).map(value => value.sessionId),
        ...nativeFrames.filter(value => !value.settled).map(value => value.id),
        ...nativeOutputs.filter(value => !value.settled).flatMap(value => value.ids)]);
      if (renderer && pendingTerminalBufferWrites(renderer, registry.ptyReadGeneration("A"))) outstanding.add("A");
      // LINV1: accepted data/cache/scopes are current; cancelled selections do
      // not abort API requests. Checks use the actual implementation's state.
      expect(apiErrors).toEqual([]);
      for (const [id, sample] of Object.entries(state.entries)) {
        const generation = registry.ptyReadGeneration(id), scope = debug.scopes.get(id);
        if (sample.history.length && !sample.retained) { expect(scope?.pty).toBe(generation); expect(scope?.demand).toBe(debug.demand); }
        for (const output of [debug.outputs.get(id)].filter(value => value !== undefined)) {
          expect(output.scope.pty).toBe(generation); expect(output.scope.demand).toBe(debug.demand);
        }
      }
      cache.entries.forEach(value => expect(value.generation).toBe(registry.ptyReadGeneration(value.sessionId)));
      // LINV2: authority is the real component pump plus actual parse tickets,
      // independent of watchdog/ACK settlement or backend text knowledge.
      const authoritative = isTerminalParsingCurrentOutput("A");
      if (!rendererVisible || termCache.has("A") || !liveTerms.has("A")) expect(authoritative).toBe(false);
      if (renderer && authoritative) expect(pendingTerminalBufferWrites(renderer, registry.ptyReadGeneration("A"))).toBe(0);
      // LINV3: pending observer fetches never own the shared parser queue.
      for (const record of nativeFrames.filter(value => !value.settled)) {
        if (!cache.entries.some(value => value.sessionId === record.id && value.busy)) expect(cache.queued).not.toContain(record.id);
      }
      // KC4 inspects every discovered target, including omitted API targets.
      expect(tabs.map(tab => tab.sessionId).sort()).toEqual(state.targets.map(target => target.sessionId).sort());
      for (const target of state.targets) {
        const tab = tabs.find(tab => tab.sessionId === target.sessionId);
        expect(tab, `API omitted ${target.sessionId}`).toBeDefined();
        if (!tab) continue;
        const sample = state.entries[tab.sessionId];
        expect(sample?.readFailures ?? 0).toBeLessThanOrEqual(settledFailures.get(tab.sessionId) ?? 0);
        if (sample?.evidence.observations === 0) { expect(tab.readable).toBe(false); expect(["alive", "idle"]).toContain(tab.fact.kind); }
        if (tab.fact.kind === "unreadable") { expect(sample?.evidence.observations).toBeGreaterThan(0); expect(sample?.readFailures).toBeGreaterThan(0); }
        // KC3: a later trusted state cannot lend its currency to an old screen.
        const changedAfterScreen = useSessionAttentionStore.getState().attentionBySession[tab.sessionId]?.stateSince > tab.observedAt;
        if (changedAfterScreen) expect(["alive", "idle"]).toContain(tab.fact.kind);
        else if (sample?.evidence.observations && sample.evidence.observation.crop.state === "error") expect(tab.fact.kind).toBe("error");
        if (["progress", "cmd", "stale", "frozen"].includes(tab.fact.kind)) expect(sample?.evidence.observation.crop.state).toBe("working");
        // LINV6: independent backend acquisition/time oracle, not round or
        // outputFresh bookkeeping, establishes the maximum supported silence.
        if (tab.fact.kind === "frozen") {
          const proof = oracle.filter(value => value.delivered && value.sessionId === tab.sessionId && value.epoch === backend.get(tab.sessionId)?.epoch
            && value.lastOutputAt === tab.lastOutputAt && value.acquiredAt >= tab.observedAt).at(-1);
          expect(proof).toBeDefined(); expect(proof!.acquiredAt - proof!.lastOutputAt).toBeGreaterThanOrEqual(20_000);
        }
      }
      // LINV7: actual registry records are bounded by independent live layout
      // and outstanding native/parser work. Unknown lookups acquire no owner.
      const allowed = new Set([...live, ...outstanding]);
      records.generations.forEach(id => expect(allowed.has(id), `unowned record ${id}`).toBe(true));
      expect(records.generations.length).toBeLessThanOrEqual(allowed.size);
      records.absent.forEach(id => expect(records.generations).toContain(id));
      records.transitions.forEach(id => expect(allowed.has(id)).toBe(true));
      const count = records.generations.length, unknown = registry.ptyReadGeneration(`retired-lookup-${index}`);
      expect(registry.currentPtyRead(`retired-lookup-${index}`, unknown)).toBe(false);
      expect(registry.__inspectPtyReadsForTests().generations).toHaveLength(count);
      expect(debug.pendingReads.length).toBeLessThanOrEqual(2);
      expect(debug.starts.filter(at => Date.now() - at < 2_000).length).toBeLessThanOrEqual(12); expect(cache.entries.length).toBeLessThanOrEqual(12);
      expect(writes.filter(value => value === "hello").length).toBe(writes.filter(value => value === "\r").length);
      expect(writes.every(value => value === "hello" || value === "\r")).toBe(true);
      const host = document.createElement("div"), root = createRoot(host);
      roots.push(root);
      await act(async () => root.render(<LiveTailList workspace={workspace} {...state} />));
      const toggle = host.querySelector<HTMLButtonElement>(".live-tail-idle");
      if (toggle) await act(async () => toggle.click());
      for (const target of state.targets) {
        const tab = tabs.find(tab => tab.sessionId === target.sessionId)!;
        const row = host.querySelector<HTMLButtonElement>(`[data-live-tail-tab="${target.tabId}"]`);
        expect(row, `sidebar omitted ${target.sessionId}`).not.toBeNull();
        expect(row?.dataset.fact).toBe(tab.fact.kind);
        const badge = host.querySelector(`[data-live-tail-tab="${tab.tabId}"] .live-tail-badge`);
        const attentionKind = trustedLiveTailAttention(target.sessionId)?.kind;
        if (attentionKind === "rate_limited") expect(badge?.textContent).toBe("利用上限");
        else if (attentionKind === "error" || tab.fact.kind === "error") expect(badge?.textContent).toBe("エラー");
        expect(badge?.textContent).not.toBe("読めない");
        const sample = state.entries[target.sessionId];
        if (sample?.evidence.observations && (sample.retained || useSessionAttentionStore.getState().attentionBySession[target.sessionId]?.stateSince > tab.observedAt)) {
          await act(async () => row!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
          const tooltip = document.querySelector('[role="tooltip"]');
          expect(tooltip?.querySelector(".live-tail-evidence")).toBeNull();
          if (tab.readable && tab.rows.length) {
            expect(tooltip?.querySelector(".live-tail-popup-rows")?.textContent).toBe(tab.rows.slice(-3).join(""));
            expect(tooltip?.querySelector(".live-tail-popup-rows")?.classList.contains("live-tail-popup-rows--previous"))
              .toBe(liveTailAttentionChanged(target, sample));
          }
          await act(async () => row!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
        }
      }
      await act(async () => root.unmount()); roots = roots.filter(value => value !== root);
      metrics.states++; metrics.invariantChecks += 9;
    };
    for (const event of sequence) {
      switch (event) {
        case "observe": await observe(); break;
        case "replace":
          park(); await killSession("A"); backend.get("A")!.epoch++;
          await createSession("A", "synthetic", [], 80, 24, () => {}, undefined, undefined, false, { backgroundOnly: true });
          attention(); await step(); break;
        case "release-reacquire":
          vi.setSystemTime(Date.now() + 10_001); release(); release = controller.acquireConsumer("sidebar"); await step(); break;
        case "lease-renew": release(); vi.setSystemTime(Date.now() + 10_001); request(); await step(); break;
        case "discovery-delay": discoveryDelay = 1_600; await observe(); await step(1_470); break;
        case "discovery-failure": discoveryFailed = true; await observe(); discoveryFailed = false; break;
        case "fetch-delay": park(); held.set("A", deferred<ArrayBuffer>()); await observe(); break;
        case "fetch-failure": park(); backend.get("A")!.failed = true; await observe(); backend.get("A")!.failed = false; break;
        case "headless-parse-delay": park(); backend.get("A")!.text += "\r\n" + "p".repeat(32_768) + "\r\n" + working; await observe(true); break;
        case "output-pending": outputMode = "pending"; await observe(); break;
        case "output-missing": outputMode = "missing"; await observe(); break;
        case "renderer-visible": await paint(); await observe(); break;
        case "renderer-cache":
          await paint(); park(); liveTerms.delete("A"); termCache.set("A", { term: renderer!, unlistenExit: null } as never); await observe(); break;
        case "renderer-park": await paint(); park(); await observe(); break;
        case "pane-read": { park(); let result: unknown; const task = handleSocketCommand("pane.read", { sessionId: "A" }).then(value => { result = value; });
          await step(190); expect(result).toMatchObject({ sessionId: "A", lines: expect.any(Array) }); await task; metrics.ordinaryReads++; break; }
        case "send-confirm": { park(); const task = handleSocketCommand("pane.send_text", { sessionId: "A", text: "hello", enter: true });
          await step(1_200); expect(await task).toMatchObject({ ok: true, confirmed: true }); metrics.confirmedSends++; break; }
        case "quiet": vi.setSystemTime(Date.now() + 21_001); await observe(); break;
        case "invisible-output": backend.get("A")!.text += "\x1b[?25h"; backend.get("A")!.outputAt = Date.now(); break;
        case "error-attention": case "rate-attention":
          park(); backend.get("A")!.text = errorScreen; attention(event === "error-attention" ? "error" : "rate_limited"); await observe(); break;
        case "idle-attention": case "done-attention": {
          const sample = controller.store.getState().entries.A;
          if (sample?.evidence.observations && ["error", "unreadable"].includes(sample.evidence.observation.crop.state)) metrics.exceptionalIdleTransitions++;
          attention("none", "A", event === "idle-attention" ? "idle" : "done"); metrics.attentionTransitions++;
          break;
        }
        case "settled-unreadable":
          park(); backend.get("A")!.failed = true; attention(); await observe(); await observe(); backend.get("A")!.failed = false; break;
        case "healthy-screen":
          park(); backend.get("A")!.text += "\x1b[3J\x1b[2J\x1b[HRecovered successfully\r\n* Cooked for 3s · done 01:00\r\n"; break;
        case "watchdog-parse": {
          await paint(); const writing = pump!.submit("\x1b[3J\x1b[2J\x1b[H" + backend.get("A")!.text);
          await turns(); vi.setSystemTime(Date.now() + 2_001); pump!.watchdog(); await turns(); await writing;
          expect(isTerminalParsingCurrentOutput("A")).toBe(false); metrics.watchdogStates++; break;
        }
        case "churn":
          for (let n = 0; n < 3; n++) {
            const id = `churn-${index}-${n}`; scene([...ids, id]);
            await createSession(id, "synthetic", [], 80, 24, () => {}, undefined, undefined, false, { backgroundOnly: true });
            const read = readPaneTail(id, 40); await step(); await read; await killSession(id); scene(ids); backend.delete(id);
            expect(registry.__inspectPtyReadsForTests().generations).not.toContain(id); metrics.churnedSessions++;
          } break;
        case "queued-invalidate": {
          await settle(); park(); ids.forEach(id => held.set(id, deferred<ArrayBuffer>()));
          const before = reads.length; await observe(); const started = reads.slice(before), unstarted = ids.find(id => !started.includes(id));
          expect(started).toHaveLength(2); expect(unstarted).toBeDefined();
          backend.get(unstarted!)!.epoch++; attention();
          const first = nativeFrames.find(value => !value.settled && value.id === started[0])!;
          first.task.resolve(first.wire); await step(1_470);
          expect(apiErrors).toEqual([]); expect(reads.slice(before)).not.toContain(unstarted); metrics.queuedInvalidations++; break;
        }
        case "settle": await settle(); break;
      }
      await check();
    }
    await settle(); await step(4_000); await Promise.all(tasks); await check(); release();
    metrics.sequences++; metrics.lengths[sequence.length] = (metrics.lengths[sequence.length] ?? 0) + 1;
    metrics.sessions[sessions] = (metrics.sessions[sessions] ?? 0) + 1; metrics.elapsedMs += wallClock.now() - began;
  });
});

describe("B3 baseline regressions using production paths", () => {
  it("C retains an exceptional screen and its original timestamp while the real revalidation parser never settles", async () => {
    scene(["A"]); backend.get("A")!.text = errorScreen; attention("error");
    const first = controller.getForApi(); await step(); await first;
    const observedAt = controller.store.getState().entries.A.evidence.observation.observedAt;
    vi.setSystemTime(Date.now() + 2_001); attention("none", "A", "done");
    backend.get("A")!.text += "\x1b[3J\x1b[2J\x1b[H" + errorScreen;
    const request = controller.getForApi(); await turns();
    expect(__headlessBufferStateForTests().entries.some(entry => entry.busy)).toBe(true);
    // Hold actual parser timers, not a substituted reader/parser callback.
    // Advance the clock without draining those timers, beyond the fetch limit.
    const count = reads.length;
    for (let n = 0; n < 4; n++) {
      vi.setSystemTime(Date.now() + 2_001);
      const state = controller.store.getState(), tab = controller.snapshot().tabs.find(tab => tab.sessionId === "A");
      expect(tab).toMatchObject({ observedAt, readable: true, fact: { kind: "idle", error: null } });
      expect(controller.__inspectForTests().pendingReads).toEqual(["A"]);
      expect(state.entries.A.readFailures).toBe(0);
      const host = document.createElement("div"), root = createRoot(host); roots.push(root);
      await act(async () => root.render(<LiveTailList workspace={workspace} {...state} />));
      const row = host.querySelector<HTMLButtonElement>('[data-live-tail-tab="tab-A"]')!;
      expect(row.querySelector(".live-tail-badge")).toBeNull();
      expect(row.querySelector(".live-tail-summary")?.textContent).toContain("API Error: 500 sample");
      await act(async () => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      expect(document.querySelector('[role="tooltip"] .live-tail-evidence')).toBeNull();
      expect(document.querySelector('[role="tooltip"] .live-tail-popup-rows--previous')?.textContent).toContain("API Error: 500 sample");
      expect(document.querySelector('[role="tooltip"] .live-tail-fact')?.textContent).toBe("入力待ち");
      await act(async () => root.unmount()); roots = roots.filter(value => value !== root);
      expect(reads).toHaveLength(count);
      expect(__headlessBufferStateForTests().entries.some(entry => entry.busy)).toBe(true);
    }
    // Test cleanup settles the real parser only after publication is fenced.
    controller.dispose(); await step(); await request;
    expect(controller.store.getState()).toEqual({ targets: [], entries: {} });
  });
  it("C skips an ordinary target that becomes idle while queued without charging a start", async () => {
    const a = deferred<ArrayBuffer>(), b = deferred<ArrayBuffer>(); held.set("A", a); held.set("B", b);
    const request = controller.getForApi(); await step(); expect(reads).toEqual(["A", "B"]);
    const generation = registry.ptyReadGeneration("C"); attention("none", "C", "done");
    expect(registry.ptyReadGeneration("C")).toBe(generation);
    a.resolve(frame(backend.get("A")!.text, backend.get("A")!.epoch)); await step(1_480);
    const response = await request;
    expect(reads).not.toContain("C"); expect(controller.__inspectForTests().starts).toHaveLength(2);
    expect(response.tabs.find(tab => tab.sessionId === "C")).toMatchObject({ readable: false, fact: { kind: "idle" } });
    expect(controller.store.getState().entries.C.readFailures).toBe(0);
  });
  it("retires a removed identity while its old native callback is outstanding, then rejects it after rediscovery", async () => {
    const fetch = deferred<ArrayBuffer>(); held.set("A", fetch);
    const old = registry.ptyReadGeneration("A");
    const pending = readPaneTail("A", 40).then(rows => ({ rows, error: undefined }), error => ({ rows: undefined, error }));
    await turns(); scene([]);
    expect(registry.currentPtyRead("A", old)).toBe(false);
    expect(registry.__inspectPtyReadsForTests().generations).toEqual(["A"]);
    scene(["A"]); expect(registry.ptyReadGeneration("A")).not.toBe(old);
    fetch.resolve(frame(backend.get("A")!.text, backend.get("A")!.epoch)); await step();
    expect((await pending).error).toBeDefined();
    const fresh = readPaneTail("A", 40); await step(); expect(await fresh).toContain("A");
    scene([]); expect(registry.__inspectPtyReadsForTests().generations).toEqual([]);
  });
  it("keeps foreign live-catalog absence owned until its tab is removed", async () => {
    scene([]); foreignIds = ["F"]; backend.set("F", { epoch: 19, outputAt: start, text: "F\r\n" + working });
    const first = controller.getForApi(); await step(); expect((await first).tabs[0].readable).toBe(true);
    await killSession("F"); const before = reads.length;
    vi.setSystemTime(Date.now() + 2_001); const second = controller.getForApi(); await step(); await second;
    expect(reads).toHaveLength(before); expect(registry.__inspectPtyReadsForTests().absent).toContain("F");
    foreignIds = []; vi.setSystemTime(Date.now() + 2_001); const removed = controller.getForApi(); await step(); await removed;
    expect(registry.__inspectPtyReadsForTests().generations).toEqual([]);
  });
  it("owns both real pump parses after watchdogs and retires cancelled callbacks on disposal", async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true }) as RendererTerminal; terms.push(term); liveTerms.set("A", term);
    const first = new Promise<void>(resolve => term.write("initial", () => { markTerminalBufferReady(term); resolve(); })); await step(); await first;
    const pump = xtermWritePump("A", term); pumps.push(pump);
    for (const text of ["first", "second"]) { const writing = pump.submit(text); await turns(); pump.watchdog(); await turns(); await writing; }
    const generation = registry.ptyReadGeneration("A");
    expect(pendingTerminalBufferWrites(term, generation)).toBe(2); expect(isTerminalParsingCurrentOutput("A")).toBe(false);
    pump.dispose(); expect(pendingTerminalBufferWrites(term, generation)).toBe(0);
    expect(registry.__inspectPtyReadsForTests().operations.has("A")).toBe(false);
    await step(); expect(isTerminalParsingCurrentOutput("A")).toBe(false);
  });
  it("refreshes a previously sufficient silence proof after delayed publication and invisible output", async () => {
    scene(["A"]); controller.acquireConsumer("sidebar"); await step(); vi.setSystemTime(start + 21_000);
    const fetch = deferred<ArrayBuffer>(); held.set("A", fetch); const request = controller.getForApi(); await step();
    const earlier = oracle.filter(value => value.sessionId === "A").at(-1)!;
    expect(earlier.acquiredAt - earlier.lastOutputAt).toBe(21_000);
    await step(2_480); backend.get("A")!.outputAt = Date.now(); backend.get("A")!.text += "\x1b[?25h";
    fetch.resolve(frame(backend.get("A")!.text, backend.get("A")!.epoch)); await step(500); await request;
    const tab = controller.snapshot().tabs[0], latest = oracle.filter(value => value.sessionId === "A" && value.delivered).at(-1)!;
    expect(latest.acquiredAt).toBeGreaterThanOrEqual(tab.observedAt);
    expect(tab.lastOutputAt).toBe(start + 23_500); expect(tab.fact.kind).not.toBe("frozen");
  });
  it("keeps a settled unreadable acquisition ahead of waiting attention", async () => {
    backend.get("A")!.failed = true; attention("error"); const request = controller.getForApi(); await step();
    expect((await request).tabs.find(tab => tab.sessionId === "A")).toMatchObject({ readable: false, fact: { kind: "unreadable" } });
    expect(controller.store.getState().entries.A.readFailures).toBe(1);
  });
  it("N1 retires distinct-ID create/read/kill records without reset between sessions", async () => {
    for (let i = 0; i < 30; i++) {
      const id = `churn-${i}`; scene([id]);
      await createSession(id, "synthetic", [], 80, 24, () => {}, undefined, undefined, false, { backgroundOnly: true });
      const read = readPaneTail(id, 40); await step(); await read;
      await killSession(id); scene([]);
    }
    const records = inspectRegistry();
    expect(records.transitions).toHaveLength(0);
    expect(records.generations).toHaveLength(0); expect(records.absent).toHaveLength(0);
  });
  it("N2 skips an invalidated queued third target without rejecting the batch", async () => {
    const a = deferred<ArrayBuffer>(), b = deferred<ArrayBuffer>(); held.set("A", a); held.set("B", b);
    const request = controller.getForApi().then(response => ({ response, error: undefined }), error => ({ response: undefined, error }));
    await step(); expect(reads).toEqual(["A", "B"]);
    backend.get("C")!.epoch++; attention();
    a.resolve(frame(backend.get("A")!.text, backend.get("A")!.epoch)); await step(1_480);
    const outcome = await request;
    b.resolve(frame(backend.get("B")!.text, backend.get("B")!.epoch)); await step();
    expect(outcome.error).toBeUndefined();
    expect(outcome.response?.tabs.find(tab => tab.sessionId === "A")?.readable).toBe(true);
    expect(reads).not.toContain("C"); expect(controller.store.getState().entries.C?.readFailures ?? 0).toBe(0);
  });
  it("N3 keeps actual XTermWrapper pump authority revoked across watchdog until real parse", async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true }) as RendererTerminal; terms.push(term);
    liveTerms.set("A", term);
    const first = new Promise<void>(resolve => term.write("OLD RENDERER\r\n", () => { markTerminalBufferReady(term); resolve(); }));
    await step(); await first;
    const pump = xtermWritePump("A", term); pumps.push(pump);
    expect(isTerminalParsingCurrentOutput("A")).toBe(true);
    const writing = pump.submit("\x1b[3J\x1b[2J\x1b[HNEW RENDERER\r\n"); await turns();
    vi.setSystemTime(Date.now() + 2_001); pump.watchdog(); await turns(); await writing;
    expect(pump.inspect()).toEqual({ writingBatch: false, pending: 0 });
    expect(isTerminalParsingCurrentOutput("A")).toBe(false);
    const count = reads.length, reading = readPaneTail("A", 40); await turns();
    expect(reads.length).toBe(count + 1);
    await step(); expect(await reading).toContain("A");
    expect(isTerminalParsingCurrentOutput("A")).toBe(true);
  });
  it("N4 never ages an t=18 output acquisition into false silence at delayed t=21 publication", async () => {
    scene(["A"]); controller.acquireConsumer("sidebar"); await step();
    vi.setSystemTime(start + 18_000);
    const value = backend.get("A")!, fetch = deferred<ArrayBuffer>(); held.set("A", fetch);
    const request = controller.getForApi(); await step();
    const proof = oracle.filter(item => item.sessionId === "A").at(-1)!;
    expect(proof.acquiredAt - proof.lastOutputAt).toBe(18_000);
    await step(2_480); value.outputAt = Date.now(); value.text += "\x1b[?25h";
    expect(value.outputAt - start).toBe(20_500);
    fetch.resolve(frame(value.text, value.epoch)); await step(500); await request;
    const fact = controller.snapshot().tabs[0].fact;
    const oraclePermitsSilence = proof.acquiredAt - proof.lastOutputAt >= 20_000;
    expect(oraclePermitsSilence).toBe(false);
    expect(fact.kind === "frozen").toBe(oraclePermitsSilence);
  });
  it.each(["error", "rate_limited"] as const)("N5 keeps a current parsed error in API and shows trusted %s attention in DOM", async kind => {
    backend.get("A")!.text = errorScreen; attention(kind);
    const request = controller.getForApi(); await step(); const response = await request;
    const host = document.createElement("div"), root = createRoot(host); roots.push(root);
    await act(async () => root.render(<LiveTailList workspace={workspace} {...controller.store.getState()} />));
    const row = host.querySelector('[data-live-tail-tab="tab-A"]')!;
    expect(response.tabs.find(tab => tab.sessionId === "A")?.fact).toMatchObject({ kind: "error", error: "API Error 500 sample" });
    expect(row.querySelector(".live-tail-badge")?.textContent).toBe(kind === "rate_limited" ? "利用上限" : "エラー");
    expect(row.getAttribute("data-tone")).toBe("stopped");
    expect(row.querySelector(".live-tail-summary")?.textContent).toContain("API Error: 500 sample");
  });
  it.each(["initial", "overflow", "renewal"])("N6 reports zero-observation API entries as neutral (%s)", async reason => {
    if (reason === "overflow") scene(Array.from({ length: 25 }, (_, i) => `overflow-${i}`));
    else held.set("A", deferred<ArrayBuffer>());
    const first = controller.getForApi(); await step(1_500); let response = await first;
    if (reason === "renewal") {
      vi.setSystemTime(start + 10_001); const next = controller.getForApi(); await step(1_500); response = await next;
    }
    const pending = response.tabs.filter(tab => controller.store.getState().entries[tab.sessionId]?.evidence.observations === 0);
    expect(pending.length).toBeGreaterThan(0);
    for (const tab of pending) expect(tab).toMatchObject({ readable: false, fact: { kind: "alive" } });
  });
});

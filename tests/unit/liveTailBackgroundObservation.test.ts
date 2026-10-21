import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readPaneTail } from "../../src/components/layout/socketCommands";
import { __resetHeadlessBufferCacheForTests } from "../../src/components/terminal/headlessBuffer";
import { terminalSizeCache } from "../../src/components/terminal/terminalCache";
import { loadLiveTailOutputs, loadLiveTailTargets } from "../../src/lib/liveTail/targets";
import { createLiveTailController, LIVE_TAIL_READ_TIMEOUT_MS } from "../../src/stores/liveTailStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { TERMINAL_IPC_TIMEOUT_MS } from "../../src/lib/terminalDeadline";
import type { Workspace } from "../../src/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), visible: vi.fn(), lines: vi.fn(), writeDelay: 0, fetchDelay: 0 }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke,
}));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  hasTerminalBuffer: mocks.visible, isTerminalParsingCurrentOutput: (id: string) => mocks.visible(id, true), getTerminalBufferLines: mocks.lines,
}));
vi.mock("@xterm/headless/lib-headless/xterm-headless.mjs", async original => {
  const source = await original<typeof import("@xterm/headless")>();
  return { ...source, Terminal: class extends source.Terminal {
    override write(data: string | Uint8Array, callback?: () => void): void {
      super.write(data, () => {
        if (mocks.writeDelay) setTimeout(() => callback?.(), mocks.writeDelay);
        else callback?.();
      });
    }
  } };
});

const encoder = new TextEncoder();
let recordings: Map<string, Uint8Array>;
let controller: ReturnType<typeof createLiveTailController>;
let fetchedBytes: number[];
function recording(bytes: number, finalLine: string): Uint8Array {
  const data = new Uint8Array(bytes);
  const line = encoder.encode("Synthetic resumed history 日本語 " + "x".repeat(70) + "\r\n");
  const end = encoder.encode(`\r\n\x1b[3J\x1b[2J\x1b[HResume complete\r\n${finalLine}\r\n`);
  for (let offset = 0; offset < bytes - end.length; offset += line.length) {
    data.set(line.subarray(0, Math.min(line.length, bytes - end.length - offset)), offset);
  }
  data.set(end, bytes - end.length);
  return data;
}
function wire(data: Uint8Array, since?: { endOffset: number }): ArrayBuffer {
  const start = since?.endOffset ?? 0;
  const frame = new ArrayBuffer(48 + data.length - start), view = new DataView(frame);
  new Uint8Array(frame).set([0x4d, 0x43, 0x53, 0x32]); view.setUint32(4, since ? 1 : 0, true);
  view.setBigUint64(8, BigInt(start), true); view.setBigUint64(16, BigInt(data.length), true);
  view.setBigUint64(24, 17n, true); view.setBigUint64(32, 0n, true);
  view.setUint16(40, 120, true); view.setUint16(42, 40, true);
  new Uint8Array(frame, 48).set(data.subarray(start)); fetchedBytes.push(data.length - start);
  return frame;
}
function workspace(id: string, sessionId: string, kind = "claude"): Workspace {
  return { id, name: "Synthetic workspace", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: `pane-${id}`, agentId: kind, sessionId, activeTabId: `tab-${id}`,
      tabs: [{ id: `tab-${id}`, sessionId, agentId: kind, agentKind: kind, type: "terminal", label: `Seat ${id}` }] }] };
}
beforeAll(async () => {
  await Promise.all([import("../../src/lib/liveAgentMetadata"), import("../../src/lib/ipc"),
    import("../../src/components/terminal/headlessBuffer"), import("../../src/components/terminal/terminalCache")]);
});
beforeEach(() => {
  vi.clearAllMocks(); __resetHeadlessBufferCacheForTests(); terminalSizeCache.clear();
  useSessionAttentionStore.getState().resetForTests();
  recordings = new Map(); fetchedBytes = [];
  mocks.writeDelay = 0; mocks.fetchDelay = 0;
  mocks.visible.mockReturnValue(false);
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  mocks.invoke.mockImplementation(async (command: string, args: { sessionId: string; since?: { endOffset: number } }) => {
    if (command === "get_pty_metadata_snapshot") return Object.fromEntries([...recordings.keys()].map(id => [id, { process_status: "working" }]));
    if (command === "get_window_fragments") return [];
    if (command === "get_session_output_snapshot") return Object.fromEntries([...recordings.keys()].map(id => [id, Date.now()]));
    if (command === "get_session_scrollback") {
      const data = recordings.get(args.sessionId); if (!data) throw new Error("session missing");
      if (mocks.fetchDelay) await new Promise(resolve => setTimeout(resolve, mocks.fetchDelay));
      return wire(data, args.since);
    }
    throw new Error(`Unexpected IPC: ${command}`);
  });
  controller = createLiveTailController({ listTargets: loadLiveTailTargets,
    readTail: (sessionId, lines, isCurrent) => readPaneTail(sessionId, lines, false,
      { headlessFetchTimeoutMs: TERMINAL_IPC_TIMEOUT_MS, purpose: "observation", isCurrent }),
    loadOutputs: loadLiveTailOutputs });
});
afterEach(() => {
  controller.dispose(); __resetHeadlessBufferCacheForTests(); terminalSizeCache.clear(); vi.restoreAllMocks(); vi.useRealTimers();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
});

describe("live-tail observations through real background reads and mock binary IPC", () => {
  it("recovers after cold target discovery outlives the observation deadline", async () => {
    recordings.set("cold", recording(100 * 1024, "Cold discovery answer"));
    useWorkspaceListStore.setState({ workspaces: [workspace("cold", "cold")], activeWorkspaceId: "cold" });
    const original = mocks.invoke.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "get_pty_metadata_snapshot") await gate;
      return original(command, args);
    });
    vi.useFakeTimers();
    const pending = controller.getForApi();
    await vi.advanceTimersByTimeAsync(LIVE_TAIL_READ_TIMEOUT_MS);
    expect((await pending).tabs).toEqual([]);
    release(); await vi.advanceTimersByTimeAsync(600);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: true, rows: ["Resume complete", "Cold discovery answer"] });
  });
  it("keeps Hybrid live identity and does not revive a saved orange icon after an explicit shell observation", async () => {
    const current = workspace("hybrid", "hybrid-session", "claude");
    useWorkspaceListStore.setState({ workspaces: [current], activeWorkspaceId: current.id });
    usePaneMetadataStore.setState({ metadata: { "hybrid-session": { agentKind: "claude" } }, volatileMetadata: {} });
    let live: string | null = "claude-codex";
    mocks.invoke.mockImplementation(async command => command === "get_pty_metadata_snapshot"
      ? { "hybrid-session": { live_agent_kind: live, process_status: "working" } } : []);
    expect((await loadLiveTailTargets())[0].agentKind).toBe("claude-codex");
    live = null;
    expect((await loadLiveTailTargets())[0].agentKind).toBeNull();
    live = "claude";
    expect((await loadLiveTailTargets())[0].agentKind).toBe("claude");
  });
  it.each([100 * 1024, 256 * 1024, 1024 * 1024, 5 * 1024 * 1024])("reads an unmarked resumed screen in another workspace at %i bytes within the observation bound", async bytes => {
    recordings.set("resumed", recording(bytes, "Final answer from resumed conversation"));
    const other = workspace("other", "resumed", "codex");
    useWorkspaceListStore.setState({ workspaces: [workspace("front", "front-session"), other], activeWorkspaceId: "front" });
    const start = performance.now(); const response = await controller.getForApi();
    expect(performance.now() - start).toBeLessThan(LIVE_TAIL_READ_TIMEOUT_MS);
    expect(response.tabs.find(tab => tab.sessionId === "resumed")).toMatchObject({
      workspaceId: "other", readable: true, rows: ["Resume complete", "Final answer from resumed conversation"], fact: { kind: "alive" },
    });
    expect(mocks.lines).not.toHaveBeenCalled(); expect(fetchedBytes).toEqual([bytes]);
  });
  it("keeps a quiet resumed screen readable and fetches zero replay bytes on a later observation", async () => {
    recordings.set("resumed", recording(256 * 1024, "Final quiet answer"));
    useWorkspaceListStore.setState({ workspaces: [workspace("other", "resumed")], activeWorkspaceId: null });
    const first = await controller.getForApi();
    vi.spyOn(Date, "now").mockReturnValue(first.generatedAt + 2_001);
    const second = await controller.getForApi();
    expect(second.tabs[0]).toMatchObject({ readable: true, rows: ["Resume complete", "Final quiet answer"] });
    expect(fetchedBytes).toEqual([256 * 1024, 0]);
  });
  it("returns a compact unreadable observation for an actually missing session", async () => {
    const ws = workspace("missing", "missing-session");
    useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
    usePaneMetadataStore.setState({ metadata: { "missing-session": { agentStatus: "working" } } });
    expect((await controller.getForApi()).tabs[0]).toMatchObject({ readable: false, rows: [], fact: { kind: "unreadable" } });
  });
  it("accepts a background parser result past the shared deadline and keeps it on the next tick", async () => {
    // Warm dynamic module imports before fake time, while using the real parser.
    recordings.set("resumed", recording(256 * 1024, "Late resumed answer"));
    await readPaneTail("resumed", 40); __resetHeadlessBufferCacheForTests(); fetchedBytes = [];
    useWorkspaceListStore.setState({ workspaces: [workspace("other", "resumed")], activeWorkspaceId: "front" });
    vi.useFakeTimers(); mocks.writeDelay = 1_600;
    const result = controller.getForApi();
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await result).tabs[0].readable).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: true, rows: ["Resume complete", "Late resumed answer"] });
    await vi.advanceTimersByTimeAsync(400);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: true, rows: ["Resume complete", "Late resumed answer"] });
    expect(fetchedBytes).toEqual([256 * 1024, 0]);
  });
  it("accepts a slow binary IPC fetch after the observation deadline and retains its screen on the next tick", async () => {
    recordings.set("resumed", recording(256 * 1024, "Late IPC answer"));
    await readPaneTail("resumed", 40); __resetHeadlessBufferCacheForTests(); fetchedBytes = [];
    useWorkspaceListStore.setState({ workspaces: [workspace("other", "resumed")], activeWorkspaceId: "front" });
    vi.useFakeTimers(); mocks.fetchDelay = 1_600;
    const result = controller.getForApi();
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await result).tabs[0].readable).toBe(false);
    expect(controller.store.getState().entries.resumed).toMatchObject({ readPending: true, readFailures: 0 });
    await vi.advanceTimersByTimeAsync(150);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: true, rows: ["Resume complete", "Late IPC answer"] });
    const observedAt = controller.snapshot().tabs[0].observedAt;
    await vi.advanceTimersByTimeAsync(400);
    expect(controller.snapshot().tabs[0]).toMatchObject({ readable: true, observedAt, rows: ["Resume complete", "Late IPC answer"] });
    expect(controller.store.getState().entries.resumed).toMatchObject({ retained: true, readPending: true });
    expect(fetchedBytes).toEqual([256 * 1024]);
  });
});

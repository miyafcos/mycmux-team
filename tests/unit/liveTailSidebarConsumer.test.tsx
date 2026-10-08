// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveTailController, type LiveTailTarget } from "../../src/stores/liveTailStore";
import { LiveTailSidebarConsumer } from "../../src/components/layout/LiveTailList";
import { __resetLiveBriefStoreForTests } from "../../src/stores/liveBriefStore";
import { LIVE_TAIL_TEST_NOW } from "../fixtures/liveTailList";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(), readPaneTail: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), unlisten: vi.fn(), listen: vi.fn(),
  visibility: "visible",
}));
vi.mock("../../src/stores/liveTailStore", async () => ({
  ...await vi.importActual<typeof import("../../src/stores/liveTailStore")>("../../src/stores/liveTailStore"),
  acquireLiveTailConsumer: mocks.acquire,
}));
vi.mock("../../src/lib/livebrief", async () => ({
  ...await vi.importActual<typeof import("../../src/lib/livebrief")>("../../src/lib/livebrief"),
  getLiveBriefs: vi.fn(async () => []), subscribeLiveBriefs: mocks.subscribe, unsubscribeLiveBriefs: mocks.unsubscribe, onLiveBriefUpdate: mocks.listen,
}));
let controller: ReturnType<typeof createLiveTailController>;
let root: Root, host: HTMLDivElement, mounted: boolean;
const target = (id: string): LiveTailTarget => ({
  sessionId: id, workspaceId: `workspace-${id}`, workspaceName: "Sample Workspace", paneId: "sample-pane", tabId: `sample-tab-${id}`,
  name: "Sample Seat", agentKind: "claude", status: "working", waitingForReply: false,
});
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(LIVE_TAIL_TEST_NOW); vi.clearAllMocks(); mocks.visibility = "visible";
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => mocks.visibility });
  __resetLiveBriefStoreForTests();
  mocks.readPaneTail.mockResolvedValue(["* Thinking… (1s · ↓ 10 tokens)"]);
  mocks.subscribe.mockResolvedValue(undefined); mocks.unsubscribe.mockResolvedValue(undefined); mocks.listen.mockResolvedValue(mocks.unlisten);
  controller = createLiveTailController({ listTargets: async () => [target("sample")], readTail: mocks.readPaneTail, loadOutputs: async () => ({ sample: Date.now() }) });
  mocks.acquire.mockImplementation((name: string) => controller.acquireConsumer(name));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove(); controller.dispose(); __resetLiveBriefStoreForTests(); vi.useRealTimers();
});
async function render(open: boolean) { await act(async () => root.render(<LiveTailSidebarConsumer open={open} />)); }
async function advance(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function visibility(value: string) {
  await act(async () => { mocks.visibility = value; document.dispatchEvent(new Event("visibilitychange")); });
}
describe("sidebar observation lifetime", () => {
  it.each(["collapse", "unmount", "hide"] as const)("releases both subscriptions on %s and performs no reads for the following 10 seconds", async reason => {
    await render(true); await advance(0);
    expect(mocks.acquire).toHaveBeenCalledWith("sidebar"); expect(mocks.readPaneTail).toHaveBeenCalledTimes(1);
    await advance(1_999); expect(mocks.readPaneTail).toHaveBeenCalledTimes(1);
    await advance(1); expect(mocks.readPaneTail).toHaveBeenCalledTimes(2);
    await advance(2_000); expect(mocks.readPaneTail).toHaveBeenCalledTimes(3);
    if (reason === "collapse") await render(false);
    else if (reason === "unmount") { await act(async () => root.unmount()); mounted = false; }
    else await visibility("hidden");
    await advance(10_000);
    expect(mocks.readPaneTail).toHaveBeenCalledTimes(3);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1); expect(mocks.unsubscribe).toHaveBeenCalledTimes(1); expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });
  it.each(["closed", "hidden"] as const)("starts without demand when %s", async state => {
    if (state === "hidden") mocks.visibility = "hidden";
    await render(state !== "closed"); await advance(10_000);
    expect(mocks.readPaneTail).not.toHaveBeenCalled(); expect(mocks.subscribe).not.toHaveBeenCalled();
  });
  it("reacquires only once when the document becomes visible again", async () => {
    await render(true); await advance(0); await visibility("hidden"); await advance(10_000);
    await visibility("visible"); await visibility("visible"); await advance(0); await advance(2_000);
    expect(mocks.readPaneTail).toHaveBeenCalledTimes(3);
    expect(mocks.acquire).toHaveBeenCalledTimes(2); expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });
  it("does not start a queued read after releasing during discovery", async () => {
    let finish!: (targets: LiveTailTarget[]) => void;
    controller.dispose();
    controller = createLiveTailController({ listTargets: () => new Promise(resolve => { finish = resolve; }), readTail: mocks.readPaneTail, loadOutputs: async () => ({}) });
    await render(true); await render(false); finish([target("sample")]); await advance(10_000);
    expect(mocks.readPaneTail).not.toHaveBeenCalled();
  });
  it("partitions two sidebar windows by their local pane tab ownership", async () => {
    const a = vi.fn(async () => ["* Thinking… (1s · ↓ 10 tokens)"]);
    const b = vi.fn(async () => ["* Thinking… (1s · ↓ 10 tokens)"]);
    const all = [target("a"), target("b")];
    const first = createLiveTailController({ listTargets: async () => all, readTail: a, loadOutputs: async () => ({}), ownsSidebarTarget: target => target.sessionId === "a" });
    const second = createLiveTailController({ listTargets: async () => all, readTail: b, loadOutputs: async () => ({}), ownsSidebarTarget: target => target.sessionId === "b" });
    try {
      const releaseA = first.acquireConsumer("sidebar"), releaseB = second.acquireConsumer("sidebar");
      await advance(4_000);
      expect(a).toHaveBeenCalledTimes(3); expect(b).toHaveBeenCalledTimes(3);
      expect(a.mock.calls.every(call => call[0] === "a")).toBe(true); expect(b.mock.calls.every(call => call[0] === "b")).toBe(true);
      releaseA(); releaseB(); await advance(10_000); expect(a).toHaveBeenCalledTimes(3); expect(b).toHaveBeenCalledTimes(3);
    } finally { first.dispose(); second.dispose(); }
  });
  it("fills a global API response after a fresh sidebar tick without rereading fresh local seats", async () => {
    const all = [target("a"), target("b")], read = vi.fn(async () => ["* Thinking… (1s · ↓ 10 tokens)"]);
    const scoped = createLiveTailController({ listTargets: async () => all, readTail: read, loadOutputs: async () => ({}), ownsSidebarTarget: target => target.sessionId === "a" });
    try {
      scoped.acquireConsumer("sidebar"); await advance(0);
      expect(read.mock.calls.map(call => call[0])).toEqual(["a"]);
      const snapshot = await scoped.getForApi();
      expect(snapshot.tabs.map(tab => tab.sessionId)).toEqual(["a", "b"]);
      expect(read.mock.calls.map(call => call[0])).toEqual(["a", "b"]);
    } finally { scoped.dispose(); }
  });
  it("completes global API coverage when it joins an in-flight local sidebar read", async () => {
    let finish!: (rows: string[]) => void;
    const all = [target("a"), target("b")];
    const read = vi.fn((id: string) => id === "a" ? new Promise<string[]>(resolve => { finish = resolve; }) : Promise.resolve(["* Thinking… (1s · ↓ 10 tokens)"]));
    const scoped = createLiveTailController({ listTargets: async () => all, readTail: read, loadOutputs: async () => ({}), ownsSidebarTarget: target => target.sessionId === "a" });
    try {
      scoped.acquireConsumer("sidebar"); await advance(0);
      const response = scoped.getForApi();
      finish(["* Thinking… (1s · ↓ 10 tokens)"]); await advance(0);
      expect((await response).tabs.map(tab => tab.sessionId)).toEqual(["a", "b"]);
      expect(read.mock.calls.map(call => call[0])).toEqual(["a", "b"]);
    } finally { scoped.dispose(); }
  });
  it("preserves the global API target population when sidebar ownership is local", async () => {
    const all = [target("a"), target("b")], read = vi.fn(async () => ["* Thinking… (1s · ↓ 10 tokens)"]);
    const api = createLiveTailController({ listTargets: async () => all, readTail: read, loadOutputs: async () => ({}), ownsSidebarTarget: target => target.sessionId === "a" });
    try {
      const snapshot = await api.getForApi();
      expect(snapshot.tabs.map(tab => tab.sessionId)).toEqual(["a", "b"]); expect(read).toHaveBeenCalledTimes(2);
    } finally { api.dispose(); }
  });
});

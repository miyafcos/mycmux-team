import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSession, onPtyExit, type PtyMetadata } from "../../src/lib/ipc";
import { connectLiveAgentHydration } from "../../src/lib/liveAgentMetadata";
import { codexRestoreNoticeEpoch, invalidateCodexRestoreNotice, publishCodexRestoreNoticeEpoch } from "../../src/lib/codexRestoreLifecycle";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Workspace } from "../../src/types";

// Only the Tauri transport is replaced: exit admission, ownership, hydration,
// publication, create/reattach and the live metadata store are production code.
const transport = vi.hoisted(() => ({ invoke: vi.fn(), nextContext: 0, listeners: new Map<string, Array<(event: { payload: unknown }) => void>>() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: async (command: string, ...parameters: any[]) => {
    const args = parameters[0] ?? {};
    if (command === "get_session_attachment_contexts") return args.sessionIds.map((session_id: string) => ({
      backend_epoch: "fixture-backend", transfer_id: args.transferToken ?? null, transfer_token: args.transferToken ?? null,
      session_id, window_label: "main", window_incarnation: "fixture-window",
      attachment_epoch: ++transport.nextContext, nonce: String(transport.nextContext), existing_only: args.existingOnly,
    }));
    const result = await transport.invoke(command, ...parameters);
    return command === "create_session" || command === "tearout_attach" ? result ?? args.attachmentContext : result;
  },
  Channel: class { id = 1; onmessage = (_frame: ArrayBuffer): void => {}; },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
  transport.listeners.set(name, [...transport.listeners.get(name) ?? [], callback]);
  return () => transport.listeners.set(name, (transport.listeners.get(name) ?? []).filter(value => value !== callback));
}) }));
const stops: Array<() => void> = [];
const e1 = 601, e2 = 602;
function deliver(name: string, payload: unknown): void {
  for (const listener of transport.listeners.get(name) ?? []) listener({ payload });
}
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks(); transport.listeners.clear();
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
});
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers(); });

async function fixture(name: string, initial: number | null = e1) {
  const p = `integ6-${name}`;
  const ws: Workspace = { id: p, name: p, createdAt: 1, status: "running", gridTemplateId: "1x1", splitColumns: [[p]],
    panes: [{ id: p, sessionId: p, agentId: "shell", activeTabId: p, tabs: [{ id: p, sessionId: p, agentId: "shell", type: "terminal" }] }] };
  useWorkspaceListStore.getState()._replaceWorkspaces([ws]);
  publishCodexRestoreNoticeEpoch(p, initial);
  let owner: number | null = initial;
  let lookup = (): Promise<number | null> => Promise.resolve(owner);
  const snapshot: Record<string, PtyMetadata> = initial === null ? {} : { [p]: {
    session_id: p, session_epoch: initial, cwd: "fixture", process_name: "bash", agent_active: false, live_agent_kind: null,
  } };
  transport.invoke.mockImplementation((command: string) => command === "get_pty_metadata_snapshot" ? Promise.resolve(snapshot)
    : command === "get_codex_restore_epoch" ? lookup() : Promise.resolve());
  const callbacks = vi.fn();
  stops.push(await onPtyExit(p, callbacks));
  stops.push(connectLiveAgentHydration(Promise.resolve()));
  await vi.waitFor(() => {
    expect(transport.listeners.get(`pty-exit-${p}`)).toHaveLength(2);
    expect(transport.invoke).toHaveBeenCalledWith("get_pty_metadata_snapshot");
  }, { timeout: 10000 });
  await flush();
  return {
    p, callbacks, live: () => usePaneMetadataStore.getState().volatileMetadata[p],
    owner: (epoch: number | null) => { owner = epoch; },
    lookup: (value: () => Promise<number | null>) => { lookup = value; },
    queryCount: () => transport.invoke.mock.calls.filter(([command]) => command === "get_codex_restore_epoch").length,
    invalidate: () => { invalidateCodexRestoreNotice(p); deliver("codex-restore-invalidated", { session_id: p }); },
    publish: (epoch: number | null) => { owner = epoch; deliver("codex-restore-published", { session_id: p, session_epoch: epoch }); },
    exit: (epoch?: number) => deliver(`pty-exit-${p}`, epoch === undefined ? null : { session_epoch: epoch }),
  };
}
function ended(f: Awaited<ReturnType<typeof fixture>>): void {
  expect(f.callbacks).toHaveBeenCalledTimes(1);
  expect(f.live()).toMatchObject({ ptyAlive: false, liveAgentKind: null, liveAgentObservationKnown: true });
}

it("INTEG-6 delivers current E exit during invalidation then same-E publication without more output", async () => {
  const f = await fixture("same-owner");
  f.invalidate(); f.exit(e1); f.publish(e1);
  await flush(); ended(f);
});
it("INTEG-6 delivers a newly created E2 exit before its first publication", async () => {
  const f = await fixture("new-owner", null);
  f.invalidate(); f.owner(e2); f.exit(e2); f.publish(e2);
  await flush(); ended(f);
});
it("INTEG-6 discards retired E1 exit during invalidation when E2 is published", async () => {
  const f = await fixture("retired-owner");
  f.invalidate(); f.exit(e1); f.publish(e2);
  await flush();
  expect(f.callbacks).not.toHaveBeenCalled();
  expect(f.live()).toMatchObject({ ptyAlive: true, liveAgentObservationKnown: false });
});
it("INTEG-6 delivers an ordinary E2 exit after publication exactly once", async () => {
  const f = await fixture("ordinary");
  f.invalidate(); f.publish(e2); f.exit(e2);
  await flush(); ended(f);
});
it("INTEG-6 rejects ID-only exits during transition and after ownership is known", async () => {
  const f = await fixture("id-only");
  f.invalidate(); f.exit(); f.publish(e2); f.exit();
  await flush();
  expect(f.callbacks).not.toHaveBeenCalled(); expect(f.queryCount()).toBe(0);
  expect(f.live()?.ptyAlive).toBe(true);
});
it("INTEG-6 same-epoch publication preserves an exit already confirmed by native lookup", async () => {
  const f = await fixture("query-before-publication");
  f.invalidate(); f.exit(e1);
  await flush(); ended(f);
  f.publish(e1); await flush(); ended(f);
});
it.each([true, false])("INTEG-6 settles a rejected create against native ownership; matching=%s", async matching => {
  const f = await fixture(`failed-create-${matching}`);
  const creating = deferred<void>(), queried = deferred<number | null>();
  f.lookup(() => queried.promise);
  const boundary = transport.invoke.getMockImplementation()!;
  transport.invoke.mockImplementation((command: string, ...args: unknown[]) => command === "create_session" ? creating.promise : boundary(command, ...args));
  const reattach = createSession(f.p, "shell", [], 80, 24, () => {});
  const rejected = expect(reattach).rejects.toThrow("reattach rejected");
  await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledWith("create_session", expect.objectContaining({ sessionId: f.p })), { timeout: 10000 });
  expect(codexRestoreNoticeEpoch(f.p)).toBeNull();
  f.exit(e1); creating.reject(new Error("reattach rejected")); await rejected;
  queried.resolve(matching ? e1 : e2); await flush();
  expect(f.queryCount()).toBe(2);
  if (matching) ended(f); else expect(f.callbacks).not.toHaveBeenCalled();
});
it.each([true, false])("INTEG-6 settles an abandoned publication against native ownership; matching=%s", async matching => {
  const f = await fixture(`abandoned-${matching}`);
  f.invalidate(); f.owner(matching ? e1 : e2); f.exit(e1);
  await flush();
  expect(f.queryCount()).toBe(2);
  if (matching) ended(f); else expect(f.callbacks).not.toHaveBeenCalled();
  await flush(); expect(f.queryCount()).toBe(2); // Settled; no unbounded queue or polling.
});
it("INTEG-6 retries a lookup invalidated by another unresolved transition", async () => {
  const f = await fixture("revision-retry");
  const queried = deferred<number | null>();
  f.lookup(() => queried.promise); f.invalidate(); f.exit(e1);
  f.invalidate(); f.lookup(() => Promise.resolve(e1)); queried.resolve(e2);
  await flush();
  expect(f.queryCount()).toBe(4); ended(f);
});
it("INTEG-6 stale lookup cannot accept E1 after E2 publication", async () => {
  const f = await fixture("stale-query");
  const queried = deferred<number | null>();
  f.lookup(() => queried.promise); f.invalidate(); f.exit(e1); f.publish(e2); queried.resolve(e1);
  await flush();
  expect(f.queryCount()).toBe(2); expect(f.callbacks).not.toHaveBeenCalled(); expect(f.live()?.ptyAlive).toBe(true);
});
it("INTEG-6 retries transient epoch-query rejection and accepts the matching exit", async () => {
  const f = await fixture("query-retry");
  vi.useFakeTimers(); let calls = 0;
  f.lookup(() => ++calls <= 2 ? Promise.reject(new Error("transport unavailable")) : Promise.resolve(e1));
  f.invalidate(); f.exit(e1); await vi.advanceTimersByTimeAsync(300);
  expect(f.queryCount()).toBe(4); ended(f);
});
it("INTEG-6 bounds retries when every authoritative query rejects", async () => {
  const f = await fixture("query-rejected");
  vi.useFakeTimers(); f.lookup(() => Promise.reject(new Error("transport unavailable")));
  f.invalidate(); f.exit(e1); await vi.advanceTimersByTimeAsync(20_000);
  expect(f.queryCount()).toBe(6); expect(f.callbacks).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20_000); expect(f.queryCount()).toBe(6); expect(vi.getTimerCount()).toBe(0);
});
it("INTEG-6 times out abandoned epoch queries and ignores their late answers", async () => {
  const f = await fixture("query-timeout");
  vi.useFakeTimers(); const queried = deferred<number | null>(); f.lookup(() => queried.promise);
  f.invalidate(); f.exit(e1); await vi.advanceTimersByTimeAsync(20_000);
  expect(f.queryCount()).toBe(6); expect(vi.getTimerCount()).toBe(0);
  queried.resolve(e1); await flush(); expect(f.callbacks).not.toHaveBeenCalled();
});
it("INTEG-6 disposed exit listeners cannot deliver a pending query answer", async () => {
  const f = await fixture("disposed");
  const queried = deferred<number | null>(); f.lookup(() => queried.promise);
  f.invalidate(); f.exit(e1); expect(f.queryCount()).toBe(2);
  for (const stop of stops.splice(0)) stop();
  queried.resolve(e1); await flush(); expect(f.callbacks).not.toHaveBeenCalled();
});
it("INTEG-6 accepts matching publication on the final bounded query attempt", async () => {
  const f = await fixture("final-retry-publication");
  const rounds = [deferred<number | null>(), deferred<number | null>(), deferred<number | null>()];
  let calls = 0;
  f.lookup(() => rounds[Math.floor(calls++ / 2)].promise);
  f.invalidate(); f.exit(e1);
  for (let round = 0; round < 3; round++) {
    expect(f.queryCount()).toBe((round + 1) * 2);
    if (round === 2) f.publish(e1); else f.invalidate();
    rounds[round].resolve(e1); await flush();
  }
  expect(f.queryCount()).toBe(6); ended(f);
});

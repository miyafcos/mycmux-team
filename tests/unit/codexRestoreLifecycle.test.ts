// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), toast: vi.fn(),
  callbacks: new Map<string, (event: { payload: any }) => unknown>(),
  workspaces: [] as any[], route: undefined as unknown,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fixture.invoke, Channel: class { onmessage?: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: fixture.listen, emit: vi.fn() }));
vi.mock("../../src/stores/workspaceListStore", () => ({ useWorkspaceListStore: { getState: () => ({ workspaces: fixture.workspaces }) } }));
vi.mock("../../src/stores/toastStore", () => ({ useToastStore: { getState: () => ({ pushToast: fixture.toast }) } }));
const P = "r11-pty", T = "dddddddd-1111-4222-8333-444444444444", G = "cccccccc-1111-4222-8333-444444444444";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event() { return { payload: { session_id: P, session_epoch: 101, generation: G, tab_id: T, reason: "missing-id" } }; }
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); fixture.callbacks.clear(); fixture.route = undefined;
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  fixture.workspaces = [{ panes: [{ tabs: [{ id: T, sessionId: P }] }] }];
  fixture.listen.mockImplementation(async (name, callback) => { fixture.callbacks.set(name, callback); return () => {}; });
  fixture.invoke.mockImplementation(async (name, args) => {
    if (name === "create_session" || name === "tearout_attach") fixture.route = args.onData;
  });
});
afterEach(() => vi.useRealTimers());
it.each([false, true])("ordinary create and kill do not await pending notice registration (background=%s)", async backgroundOnly => {
  const registration = deferred<() => void>();
  fixture.listen.mockReturnValue(registration.promise);
  const ipc = await import("../../src/lib/ipc");
  vi.useFakeTimers();
  let completed = false;
  const creating = ipc.createSession(P, "claude", [], 80, 24, () => {}, undefined, undefined, false, { backgroundOnly })
    .then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(0);
  const killing = ipc.killSession(P);
  await vi.advanceTimersByTimeAsync(8_001);
  expect(completed, "R11-1: registration cannot hold ordinary create past the attach deadline").toBe(true);
  expect(fixture.invoke).toHaveBeenCalledWith("kill_session", { sessionId: P });
  registration.resolve(() => {});
  await Promise.allSettled([creating, killing]);
});
it("bounds Codex preparation and retains one listener after a late registration succeeds", async () => {
  const registration = deferred<() => void>(); fixture.listen.mockReturnValue(registration.promise);
  const ipc = await import("../../src/lib/ipc"); vi.useFakeTimers();
  let completed = false;
  const creating = ipc.createSession(P, "codex", ["resume", G], 80, 24, () => {}).then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(8_001);
  expect(completed, "R11-1: notification preparation must settle").toBe(true);
  const counts = fixture.listen.mock.calls.map(([name]) => name);
  registration.resolve(() => {}); await creating;
  await ipc.createSession("r11-other", "node", ["/tools/codex.js", "resume", G], 80, 24, () => {});
  expect(fixture.listen.mock.calls.map(([name]) => name)).toEqual(counts);
  expect(counts.filter(name => name === "codex-restore-notice")).toHaveLength(1);
});
it.each([false, true].flatMap(background => ["disposed", "closed", "transferred", "lease-replaced"].map(change => [background, change] as const)))
("rechecks guards after preparation (background=%s, %s)", async (backgroundOnly, change) => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  const registration = deferred<() => void>(); fixture.listen.mockReturnValue(registration.promise);
  const attachment = await import("../../src/lib/tearout/sessionAttachment");
  let owned = true;
  const lease = attachment.expectTearoutAttachments([P], "prewarm", () => owned);
  const ipc = await import("../../src/lib/ipc");
  const creating = ipc.createSession(P, "codex", ["resume", G], 80, 24, () => {}, undefined, undefined, false,
    { backgroundOnly, stillOwned: () => change === "disposed" ? owned : true });
  const result = creating.catch(error => error);
  await vi.waitFor(() => expect(fixture.listen).toHaveBeenCalled());
  let killing: Promise<void> | undefined;
  if (change === "closed") killing = ipc.killSession(P);
  else if (change === "lease-replaced") {
    lease.dispose(); attachment.expectTearoutAttachments([P], "prewarm", () => true);
  } else owned = false;
  // An independent destination has already attached the same P/T.
  await fixture.invoke("tearout_attach", { sessionId: P, onData: "destination" });
  registration.resolve(() => {});
  expect(await result).toBeInstanceOf(ipc.SessionClosedError);
  if (killing) await killing;
  expect(fixture.invoke.mock.calls.filter(([name]) => name === "create_session"), "R11-1: stale source must not dispatch").toHaveLength(0);
  expect(fixture.route, "destination channel stays current").toBe("destination");
  lease.dispose();
});
it("rejects captured E1 after another window publishes E2 with unchanged P/T", async () => {
  const restore = await import("../../src/lib/codexRestore");
  await restore.ensureCodexRestoreNoticeListener();
  const reply = deferred<number>();
  fixture.invoke.mockImplementation(name => name === "get_codex_restore_epoch" ? reply.promise : Promise.resolve());
  const receiving = fixture.callbacks.get("codex-restore-notice")!(event());
  expect(fixture.invoke).toHaveBeenCalledWith("get_codex_restore_epoch", { sessionId: P });
  // Native has read E1; its reply is held. Invalidation must precede E2 publication.
  fixture.callbacks.get("codex-restore-invalidated")?.({ payload: { session_id: P } });
  fixture.workspaces = [{ panes: [{ tabs: [{ id: T, sessionId: P }] }] }];
  reply.resolve(101); await receiving;
  expect(fixture.toast, "R11-2: E1 snapshot must not notify the same-P/T replacement").not.toHaveBeenCalled();
});
it.each(["create", "kill", "ownership"])("invalidates an in-flight notice before local %s publication", async action => {
  const restore = await import("../../src/lib/codexRestore"); await restore.ensureCodexRestoreNoticeListener();
  const ipc = await import("../../src/lib/ipc"); const reply = deferred<number>();
  fixture.invoke.mockImplementation(async (name, args) => {
    if (name === "get_codex_restore_epoch") return reply.promise;
    if (name === "create_session" || name === "tearout_attach") fixture.route = args.onData;
  });
  const receiving = fixture.callbacks.get("codex-restore-notice")!(event());
  if (action === "kill") await ipc.killSession(P);
  else await ipc.createSession(P, "shell", [], 80, 24, () => {}, undefined, undefined, action === "ownership");
  reply.resolve(101); await receiving;
  expect(fixture.toast).not.toHaveBeenCalled();
});
it("suppresses epoch queries between replacement invalidation and publication", async () => {
  const restore = await import("../../src/lib/codexRestore"); await restore.ensureCodexRestoreNoticeListener();
  fixture.invoke.mockResolvedValue(101);
  fixture.callbacks.get("codex-restore-invalidated")?.({ payload: { session_id: P } });
  await fixture.callbacks.get("codex-restore-notice")!(event());
  expect(fixture.invoke, "R11-2: an invalidated instance cannot start another stale snapshot query").not.toHaveBeenCalled();
  expect(fixture.toast).not.toHaveBeenCalled();
});
it("rejects held E1 when E2 publication arrives before the reply", async () => {
  const restore = await import("../../src/lib/codexRestore"); await restore.ensureCodexRestoreNoticeListener();
  const reply = deferred<number>(); fixture.invoke.mockReturnValue(reply.promise);
  const receiving = fixture.callbacks.get("codex-restore-notice")!(event());
  fixture.callbacks.get("codex-restore-published")?.({ payload: { session_id: P, session_epoch: 202 } });
  reply.resolve(101); await receiving;
  expect(fixture.toast, "R11-2: publication must invalidate a captured E1 reply").not.toHaveBeenCalled();
});
it("accepts E2 once after its publication ends the invalidated phase", async () => {
  const restore = await import("../../src/lib/codexRestore"); await restore.ensureCodexRestoreNoticeListener();
  fixture.invoke.mockResolvedValue(202);
  fixture.callbacks.get("codex-restore-invalidated")?.({ payload: { session_id: P } });
  fixture.callbacks.get("codex-restore-published")?.({ payload: { session_id: P, session_epoch: 202 } });
  const receive = fixture.callbacks.get("codex-restore-notice")!;
  const e2 = { payload: { ...event().payload, session_epoch: 202 } };
  await receive(e2); await receive(e2);
  expect(fixture.toast).toHaveBeenCalledTimes(1);
});

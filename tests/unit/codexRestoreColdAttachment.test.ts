// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ invoke: vi.fn(), nextContext: 0, listen: vi.fn(), toast: vi.fn(), callbacks: new Map<string, (event: { payload: any }) => unknown>(), workspaces: [] as any[], epoch: 202, publish: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, ...parameters: any[]) => {
    const args = parameters[0] ?? {};
    if (command === "get_session_attachment_contexts") return args.sessionIds.map((session_id: string) => ({
      backend_epoch: "fixture-backend", transfer_id: args.transferToken ?? null, transfer_token: args.transferToken ?? null,
      session_id, window_label: "main", window_incarnation: "fixture-window",
      attachment_epoch: ++f.nextContext, nonce: String(f.nextContext), existing_only: args.existingOnly,
    }));
    const result = await f.invoke(command, ...parameters);
    return command === "create_session" || command === "tearout_attach" ? result ?? args.attachmentContext : result;
  }, Channel: class { onmessage?: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: f.listen, emit: vi.fn() }));
vi.mock("../../src/stores/workspaceListStore", () => ({ useWorkspaceListStore: { getState: () => ({ workspaces: f.workspaces }) } }));
vi.mock("../../src/stores/toastStore", () => ({ useToastStore: { getState: () => ({ pushToast: f.toast }) } }));
const P = "r12-cold", T = "dddddddd-1111-4222-8333-444444444444", G = "cccccccc-1111-4222-8333-444444444444";
const names = ["codex-restore-published", "codex-restore-invalidated", "codex-restore-notice"];
const own = (pty = P, tab = T) => [{ panes: [{ tabs: [{ id: tab, sessionId: pty }] }] }];
const notice = (epoch = f.epoch) => ({ payload: { session_id: P, session_epoch: epoch, generation: G, tab_id: T, reason: "missing-id" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); f.callbacks.clear(); f.workspaces = own(); f.epoch = 202; f.publish = true;
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  f.listen.mockImplementation(async (name, callback) => { f.callbacks.set(name, callback); return () => {}; });
  f.invoke.mockImplementation(async name => {
    if (name === "get_codex_restore_epoch") return f.epoch;
    if ((name === "tearout_attach" || name === "create_session") && f.publish) {
      f.callbacks.get("codex-restore-invalidated")?.({ payload: { session_id: P } });
      f.callbacks.get("codex-restore-published")?.({ payload: { session_id: P, session_epoch: f.epoch } });
    }
  });
});
afterEach(() => vi.useRealTimers());
it("cold destination first reattach subscribes before publication and exclusively delivers the transferred notice", async () => {
  const source = await import("../../src/lib/ipc");
  await source.createSession(P, "codex", [], 80, 24, () => {});
  const oldReceiver = f.callbacks.get("codex-restore-notice")!;
  vi.resetModules(); f.callbacks.clear(); f.listen.mockClear(); f.invoke.mockClear();
  const destination = await import("../../src/lib/ipc");
  const attach = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (...args) => {
    if (args[0] === "tearout_attach") expect([...f.callbacks.keys()], "R12-2: cold attachment must have all three subscriptions before publication").toEqual(names);
    return attach(...args);
  });
  await destination.createSession(P, "codex", [], 80, 24, () => {}, undefined, undefined, true);
  expect(f.listen.mock.calls.map(([name]) => name)).toEqual(names);
  expect(f.invoke.mock.calls.filter(([name]) => name === "get_codex_restore_epoch")).toHaveLength(0);
  const receiver = f.callbacks.get("codex-restore-notice")!;
  f.workspaces = []; await oldReceiver(notice());
  f.workspaces = own(); await receiver(notice()); await receiver(notice());
  expect(f.toast).toHaveBeenCalledTimes(1);
});
it("cold Codex attachment waits for bounded preparation before dispatch", async () => {
  const registration = deferred<() => void>();
  f.listen.mockImplementation((name, callback) => registration.promise.then(value => { f.callbacks.set(name, callback); return value; }));
  const ipc = await import("../../src/lib/ipc"); vi.useFakeTimers();
  const attached = ipc.createSession(P, "codex", [], 80, 24, () => {}, undefined, undefined, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.listen.mock.calls.map(([name]) => name)).toEqual(names);
  expect(f.invoke, "R12-2: attachment publication must follow successful preparation").not.toHaveBeenCalled();
  registration.resolve(() => {}); await attached;
  await f.callbacks.get("codex-restore-notice")!(notice()); expect(f.toast).toHaveBeenCalledTimes(1);
});
it.each(["shell", "codex"])("cold %s attachment stays bounded when registration stalls and synchronizes missed publication on late success", async command => {
  const registration = deferred<() => void>();
  f.listen.mockImplementation((name, callback) => registration.promise.then(value => { f.callbacks.set(name, callback); return value; }));
  const ipc = await import("../../src/lib/ipc"); vi.useFakeTimers();
  let completed = false;
  const attached = ipc.createSession(P, command, [], 80, 24, () => {}, undefined, undefined, true).then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.listen.mock.calls.map(([name]) => name)).toEqual(names);
  expect(completed).toBe(command === "shell");
  await vi.advanceTimersByTimeAsync(8_001); expect(completed).toBe(true);
  registration.resolve(() => {}); await attached; await vi.advanceTimersByTimeAsync(0);
  await f.callbacks.get("codex-restore-notice")!(notice());
  expect(f.toast, "R12-2: a publication missed before subscription must not leave this PTY inactive").toHaveBeenCalledTimes(1);
  await ipc.createSession(P, command, [], 80, 24, () => {}, undefined, undefined, true);
  expect(f.listen).toHaveBeenCalledTimes(3);
});
it("rejects a synchronization reply holding E1 across same-P/T replacement and accepts E2 once", async () => {
  const registration = deferred<() => void>(); const reply = deferred<number>();
  f.listen.mockImplementation((name, callback) => registration.promise.then(value => { f.callbacks.set(name, callback); return value; }));
  const invoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation((name, ...args) => name === "get_codex_restore_epoch" ? reply.promise : invoke(name, ...args));
  const ipc = await import("../../src/lib/ipc"); vi.useFakeTimers();
  const attached = ipc.createSession(P, "codex", [], 80, 24, () => {}, undefined, undefined, true);
  await vi.advanceTimersByTimeAsync(8_001); await attached;
  registration.resolve(() => {}); await vi.advanceTimersByTimeAsync(0);
  expect(f.invoke).toHaveBeenCalledWith("get_codex_restore_epoch", { sessionId: P });
  f.callbacks.get("codex-restore-invalidated")!({ payload: { session_id: P } });
  f.callbacks.get("codex-restore-published")!({ payload: { session_id: P, session_epoch: 202 } });
  reply.resolve(101); await vi.advanceTimersByTimeAsync(0);
  f.invoke.mockResolvedValue(202);
  await f.callbacks.get("codex-restore-notice")!(notice(101));
  await f.callbacks.get("codex-restore-notice")!(notice(202));
  expect(f.toast).toHaveBeenCalledTimes(1);
});
it.each(["complete", "killed", "transferred"])("partial subscriptions preserve completed attachment reconciliation (%s)", async ending => {
  const registrations = new Map(names.map(name => [name, deferred<() => void>()]));
  const attachmentReply = deferred<void>(); const epochReply = deferred<number | null>();
  f.listen.mockImplementation((name, callback) => registrations.get(name)!.promise.then(value => { f.callbacks.set(name, callback); return value; }));
  const invoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation((name, ...args) => {
    if (name === "tearout_attach") return attachmentReply.promise;
    if (name === "get_codex_restore_epoch") return epochReply.promise;
    return invoke(name, ...args);
  });
  const ipc = await import("../../src/lib/ipc"); let owned = true; vi.useFakeTimers();
  const attached = ipc.createSession(P, "codex", [], 80, 24, () => {}, undefined, undefined, true, { stillOwned: () => owned });
  await vi.advanceTimersByTimeAsync(0);
  registrations.get("codex-restore-invalidated")!.resolve(() => {});
  registrations.get("codex-restore-notice")!.resolve(() => {});
  await vi.advanceTimersByTimeAsync(4_001);
  expect(f.invoke).toHaveBeenCalledWith("tearout_attach", expect.objectContaining({ sessionId: P }));
  const invalidate = f.callbacks.get("codex-restore-invalidated"); expect(invalidate).toBeTypeOf("function");
  invalidate!({ payload: { session_id: P } }); // attachment begin arrives after the reconciliation was armed
  expect(f.callbacks.has("codex-restore-published")).toBe(false); // completion was missed
  attachmentReply.resolve(); await attached;
  if (ending === "killed") { await ipc.killSession(P); f.epoch = 0; }
  if (ending === "transferred") { owned = false; f.workspaces = []; }
  registrations.get("codex-restore-published")!.resolve(() => {}); await vi.advanceTimersByTimeAsync(0);
  const receiver = f.callbacks.get("codex-restore-notice"); expect(receiver).toBeTypeOf("function");
  const pendingNotice = receiver!(notice(202)); await vi.advanceTimersByTimeAsync(0);
  expect(f.invoke.mock.calls.filter(([name]) => name === "get_codex_restore_epoch")).toHaveLength(ending === "complete" ? 1 : 0);
  expect(f.toast).not.toHaveBeenCalled();
  epochReply.resolve(ending === "complete" ? 202 : null); await pendingNotice;
  if (ending === "complete") { f.invoke.mockResolvedValue(202); await receiver!(notice(202)); }
  expect(f.toast, "R13-2: pre-lookup invalidation cannot discard the only missed-completion reconciliation").toHaveBeenCalledTimes(ending === "complete" ? 1 : 0);
});
it.each([false, true])("a one-shot notice arriving during late epoch synchronization survives only its original lifecycle (replaced=%s)", async replaced => {
  const registration = deferred<() => void>(); const reply = deferred<number>(); let firstQuery = true;
  f.listen.mockImplementation((name, callback) => registration.promise.then(value => { f.callbacks.set(name, callback); return value; }));
  const invoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation((name, ...args) => {
    if (name === "get_codex_restore_epoch" && firstQuery) { firstQuery = false; return reply.promise; }
    return invoke(name, ...args);
  });
  const ipc = await import("../../src/lib/ipc"); vi.useFakeTimers();
  const attached = ipc.createSession(P, "codex", [], 80, 24, () => {}, undefined, undefined, true);
  await vi.advanceTimersByTimeAsync(8_001); await attached;
  registration.resolve(() => {}); await vi.advanceTimersByTimeAsync(0);
  expect(f.invoke).toHaveBeenCalledWith("get_codex_restore_epoch", { sessionId: P });
  const receiver = f.callbacks.get("codex-restore-notice")!;
  const pendingNotice = receiver(notice(202)); await vi.advanceTimersByTimeAsync(0);
  expect(f.toast).not.toHaveBeenCalled();
  if (replaced) {
    f.epoch = 303;
    f.callbacks.get("codex-restore-invalidated")!({ payload: { session_id: P } });
    f.callbacks.get("codex-restore-published")!({ payload: { session_id: P, session_epoch: 303 } });
  }
  reply.resolve(202); await pendingNotice;
  expect(f.toast, "R12-2: the one-shot warning cannot be discarded while a bounded epoch synchronization is in flight").toHaveBeenCalledTimes(replaced ? 0 : 1);
  await receiver(notice(f.epoch)); await receiver(notice(f.epoch));
  expect(f.toast).toHaveBeenCalledTimes(1);
});
it("a notice waiting for late epoch synchronization settles at its deadline and rejects the late reply", async () => {
  const registration = deferred<() => void>(); const reply = deferred<number>();
  f.listen.mockImplementation((name, callback) => registration.promise.then(value => { f.callbacks.set(name, callback); return value; }));
  const invoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation((name, ...args) => name === "get_codex_restore_epoch" ? reply.promise : invoke(name, ...args));
  const ipc = await import("../../src/lib/ipc"); vi.useFakeTimers();
  const attached = ipc.createSession(P, "codex", [], 80, 24, () => {}, undefined, undefined, true);
  await vi.advanceTimersByTimeAsync(8_001); await attached;
  registration.resolve(() => {}); await vi.advanceTimersByTimeAsync(0);
  expect(f.invoke).toHaveBeenCalledWith("get_codex_restore_epoch", { sessionId: P });
  let completed = false;
  const receiver = f.callbacks.get("codex-restore-notice")!;
  const pendingNotice = Promise.resolve(receiver(notice())).then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(0); expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(4_001); await pendingNotice; expect(completed).toBe(true);
  reply.resolve(202); await vi.advanceTimersByTimeAsync(0);
  await receiver(notice()); expect(f.toast).not.toHaveBeenCalled();
});
it("retains a one-shot notice after late registration but before the attachment reply, without querying before that reply", async () => {
  const registration = deferred<() => void>(); const attachmentReply = deferred<void>();
  f.listen.mockImplementation((name, callback) => registration.promise.then(value => { f.callbacks.set(name, callback); return value; }));
  const invoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation((name, ...args) => {
    if (name === "tearout_attach") { void invoke(name, ...args); return attachmentReply.promise; }
    return invoke(name, ...args);
  });
  const ipc = await import("../../src/lib/ipc"); vi.useFakeTimers();
  const attached = ipc.createSession(P, "codex", [], 80, 24, () => {}, undefined, undefined, true);
  await vi.advanceTimersByTimeAsync(4_001);
  expect(f.invoke).toHaveBeenCalledWith("tearout_attach", expect.objectContaining({ sessionId: P }));
  registration.resolve(() => {}); await vi.advanceTimersByTimeAsync(0);
  const receiver = f.callbacks.get("codex-restore-notice")!;
  expect(receiver, "the receiver must exist before invoking the attachment-gap notice").toBeTypeOf("function");
  const pendingNotice = receiver(notice()); await vi.advanceTimersByTimeAsync(0);
  expect(f.invoke.mock.calls.filter(([name]) => name === "get_codex_restore_epoch")).toHaveLength(0);
  expect(f.toast).not.toHaveBeenCalled();
  attachmentReply.resolve(); await attached; await pendingNotice;
  expect(f.toast, "R12-2: a warning between late subscription and the attachment reply must survive").toHaveBeenCalledTimes(1);
  await receiver(notice()); expect(f.toast).toHaveBeenCalledTimes(1);
});
it.each(["disposed", "closed", "transferred", "lease-replaced"])("cold Codex attachment rechecks %s ownership after preparation", async change => {
  const registration = deferred<() => void>(); f.listen.mockReturnValue(registration.promise);
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  const attachment = await import("../../src/lib/tearout/sessionAttachment"); let owned = true;
  const lease = attachment.expectTearoutAttachments([P], "prewarm", () => owned);
  const ipc = await import("../../src/lib/ipc");
  const attached = ipc.createSession(P, "codex", [], 80, 24, () => {}, undefined, undefined, true, { stillOwned: () => owned }).catch(error => error);
  await vi.waitFor(() => expect(f.listen, "R12-2: even first attachment starts preparation").toHaveBeenCalled(), { timeout: 10000 });
  let killing: Promise<void> | undefined;
  if (change === "closed") killing = ipc.killSession(P);
  else if (change === "lease-replaced") { lease.dispose(); attachment.expectTearoutAttachments([P], "prewarm", () => true); }
  else owned = false;
  registration.resolve(() => {});
  expect(await attached).toBeInstanceOf(ipc.SessionClosedError);
  if (killing) await killing;
  expect(f.invoke.mock.calls.filter(([name]) => name === "tearout_attach")).toHaveLength(0); lease.dispose();
});
const tracePath = process.env.MYCMUX_RESTORE_NATIVE_TRACE;
it.skipIf(!tracePath).each(["r12-kill-first", "r12-create-first"])("real native overlap trace %s drives the actual receiver without E1 warnings", async pty => {
  const row = readFileSync(tracePath!, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.pty === pty);
  expect(row, "native orchestration must supply both controlled production-publisher traces").toBeDefined();
  f.workspaces = own(pty, row.tab); f.invoke.mockResolvedValue(row.current_epoch);
  await (await import("../../src/lib/codexRestore")).ensureCodexRestoreNoticeListener();
  for (const event of row.events) {
    const before = f.toast.mock.calls.length;
    await f.callbacks.get(event.name)!({ payload: event.payload });
    if (event.name === "codex-restore-notice" && event.payload.session_epoch === row.old_epoch) expect(f.toast.mock.calls.length).toBe(before);
  }
  const replacement = row.events.filter(event => event.name === "codex-restore-published" && event.payload.session_epoch !== null).at(-1)?.payload.session_epoch;
  expect(replacement).not.toBe(row.old_epoch);
  const replacementNotice = { ...row.events.find(event => event.name === "codex-restore-notice").payload, session_epoch: replacement };
  await f.callbacks.get("codex-restore-notice")!({ payload: replacementNotice });
  await f.callbacks.get("codex-restore-notice")!({ payload: replacementNotice });
  expect(f.toast, "R12-1: live E2 warns once; a completed kill leaves no valid warning").toHaveBeenCalledTimes(row.current_epoch === null ? 0 : 1);
});

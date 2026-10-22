import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSession, getSessionChannelId, killSession, SessionClosedError } from "../../src/lib/ipc";
import { expectTearoutAttachments, type AttachmentContext } from "../../src/lib/tearout/sessionAttachment";
import { TERMINAL_ATTACH_TIMEOUT_MS } from "../../src/lib/terminalDeadline";

const backend = vi.hoisted(() => ({ invoke: vi.fn(), next: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: backend.invoke,
  Channel: class { id = ++backend.next; onmessage?: unknown; },
}));
vi.mock("../../src/lib/codexRestore", () => ({ ensureCodexRestoreNoticeListener: async () => {} }));
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(accept => { resolve = accept; });
  return { promise, resolve };
}
function context(sessionId: string): AttachmentContext {
  return { backend_epoch: "backend", transfer_id: null, transfer_token: null, session_id: sessionId,
    window_label: "main", window_incarnation: "native-window", attachment_epoch: ++backend.next,
    nonce: String(backend.next), existing_only: false };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { platform: "Win32" });
  backend.invoke.mockReset().mockImplementation(async (command: string, args: any) => {
    if (command === "get_session_attachment_contexts") return args.sessionIds.map(context);
    if (command === "create_session" || command === "tearout_attach") return args.attachmentContext;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("I0-R1 releases the create tail and queued kill after a lost authority reply", async () => {
  const sessionId = "authority-timeout-kill";
  const gate = deferred<AttachmentContext[]>();
  backend.invoke.mockImplementationOnce(() => gate.promise);
  let result: unknown;
  const creating = createSession(sessionId, "shell", [], 80, 24, () => {}).catch(error => { result = error; });
  await vi.advanceTimersByTimeAsync(0);
  const killing = killSession(sessionId);
  await vi.advanceTimersByTimeAsync(TERMINAL_ATTACH_TIMEOUT_MS);
  expect(result).toBeInstanceOf(Error);
  expect(String(result)).toContain("Terminal IPC timed out");
  await creating; await killing;
  expect(backend.invoke.mock.calls.map(([command]) => command)).toEqual(["get_session_attachment_contexts", "kill_session"]);
  gate.resolve([context(sessionId)]); await vi.advanceTimersByTimeAsync(0);
  expect(getSessionChannelId(sessionId)).toBeUndefined();
  expect(backend.invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
});

it("I0-R1 ignores a late authority reply after a fresh attachment succeeds", async () => {
  const sessionId = "authority-timeout-retry";
  const gate = deferred<AttachmentContext[]>();
  backend.invoke.mockImplementationOnce(() => gate.promise);
  let timedOut = false;
  const original = createSession(sessionId, "shell", [], 80, 24, () => {}).catch(() => { timedOut = true; });
  await vi.advanceTimersByTimeAsync(TERMINAL_ATTACH_TIMEOUT_MS);
  expect(timedOut).toBe(true); await original;
  await createSession(sessionId, "shell", [], 80, 24, () => {});
  const active = getSessionChannelId(sessionId);
  expect(active).toBeDefined();
  gate.resolve([context(sessionId)]); await vi.advanceTimersByTimeAsync(0);
  expect(getSessionChannelId(sessionId)).toBe(active);
  expect(backend.invoke.mock.calls.filter(([command]) => command === "create_session")).toHaveLength(1);
});

it.each([false, true].flatMap(backgroundOnly => ["kill", "unmount"].map(change => ({ backgroundOnly, change }))))(
  "I0-R2 fences $change during authority lookup with backgroundOnly=$backgroundOnly", async ({ backgroundOnly, change }) => {
    const sessionId = `authority-${change}-${backgroundOnly}`;
    const gate = deferred<AttachmentContext[]>();
    backend.invoke.mockImplementationOnce(() => gate.promise);
    let owned = true;
    const creating = createSession(sessionId, "shell", [], 80, 24, () => {}, undefined, undefined, false,
      { backgroundOnly, stillOwned: () => owned }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.invoke).toHaveBeenCalledWith("get_session_attachment_contexts", expect.anything());
    const killing = change === "kill" ? killSession(sessionId) : undefined;
    if (change === "unmount") owned = false;
    gate.resolve([context(sessionId)]);
    const result = await creating; await killing;
    expect(result).toBeInstanceOf(SessionClosedError);
    expect(backend.invoke.mock.calls.some(([command]) => command === "create_session" || command === "tearout_attach")).toBe(false);
    expect(getSessionChannelId(sessionId)).toBeUndefined();
  },
);

it("I0-R1 bounds both prepared and ready when transfer authority never replies", async () => {
  const gate = deferred<AttachmentContext[]>();
  backend.invoke.mockImplementationOnce(() => gate.promise);
  const lease = expectTearoutAttachments(["authority-transfer-timeout"]);
  let preparedError: unknown, readyError: unknown;
  const prepared = lease.prepared.catch(error => { preparedError = error; });
  const ready = lease.ready.catch(error => { readyError = error; });
  try {
    await vi.advanceTimersByTimeAsync(TERMINAL_ATTACH_TIMEOUT_MS);
    expect(preparedError).toBeInstanceOf(Error); expect(readyError).toBe(preparedError);
    await prepared; await ready;
  } finally { lease.dispose(); }
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createSession, killSession, SessionClosedError } from "../../src/lib/ipc";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class { onmessage?: (frame: ArrayBuffer) => void; },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const start = (id: string) => createSession(id, "shell", [], 80, 24, () => {});
const calls = () => vi.mocked(invoke).mock.calls.map(([command]) => command);

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
});

describe("session create/kill ordering", () => {
  it("waits for an in-flight create before invoking kill", async () => {
    const pending = deferred();
    vi.mocked(invoke).mockImplementationOnce(() => pending.promise);
    const creating = start("in-flight");
    await vi.waitFor(() => expect(calls()).toEqual(["create_session"]), { timeout: 10_000 });
    const killing = killSession("in-flight");
    await Promise.resolve();
    expect(calls()).toEqual(["create_session"]);
    pending.resolve();
    await Promise.all([creating, killing]);
    expect(calls()).toEqual(["create_session", "kill_session"]);
  });

  it("cancels a queued create from before the kill without invoking it", async () => {
    const pending = deferred();
    vi.mocked(invoke).mockImplementationOnce(() => pending.promise);
    const creating = start("queued");
    await vi.waitFor(() => expect(calls()).toEqual(["create_session"]), { timeout: 10_000 });
    const queued = start("queued");
    const cancelled = expect(queued).rejects.toBeInstanceOf(SessionClosedError);
    const killing = killSession("queued");
    pending.resolve();
    await Promise.all([creating, cancelled, killing]);
    expect(calls()).toEqual(["create_session", "kill_session"]);
  });

  it("recreates the same id after a completed kill for dormancy", async () => {
    await start("dormant");
    await killSession("dormant");
    await start("dormant");
    expect(calls()).toEqual(["create_session", "kill_session", "create_session"]);
  });

  it("queues a later-generation create behind an in-flight kill", async () => {
    const pending = deferred();
    vi.mocked(invoke).mockImplementationOnce(() => pending.promise);
    const killing = killSession("later");
    const creating = start("later");
    await vi.waitFor(() => expect(calls()).toEqual(["kill_session"]), { timeout: 10_000 });
    pending.resolve();
    await Promise.all([killing, creating]);
    expect(calls()).toEqual(["kill_session", "create_session"]);
  });

  it("still kills after a create rejection and does not block other ids", async () => {
    const pending = deferred();
    vi.mocked(invoke).mockImplementationOnce(() => pending.promise);
    const creating = start("failed");
    const failed = expect(creating).rejects.toThrow("spawn failed");
    await vi.waitFor(() => expect(calls()).toEqual(["create_session"]), { timeout: 10_000 });
    const killing = killSession("failed");
    await start("independent");
    expect(calls()).toEqual(["create_session", "create_session"]);
    pending.reject(new Error("spawn failed"));
    await Promise.all([failed, killing]);
    expect(calls()).toEqual(["create_session", "create_session", "kill_session"]);
  });
});

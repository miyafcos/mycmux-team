import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { transpileModule, ScriptTarget } from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { onPtyExit } from "../../src/lib/ipc";
import { invalidateCodexRestoreNotice, publishCodexRestoreNoticeEpoch, ptyExitConfirmed } from "../../src/lib/codexRestoreLifecycle";

const transport = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: transport.invoke,
  Channel: class { id = 1; onmessage = (_frame: ArrayBuffer): void => {}; },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: transport.listen }));

// Run the actual private consumer functions, as the existing XTerm pump/focus
// fixtures do. No cleanup decision is copied and no product export is added.
const source = readFileSync("src/components/terminal/XTermWrapper.tsx", "utf8");
function section(start: string, end: string): string {
  const at = source.indexOf(start), until = source.indexOf(end, at);
  if (at < 0 || until < 0) throw new Error(`XTermWrapper exit cleanup boundary missing: ${start}`);
  return source.slice(at, until);
}
const consumer = section("    const releaseExitListener =", "    const registerInputListeners =");
const cleanup = section("      const exitListener = unlistenExit;", "      cacheCurrentTerminal();");
const compiled = transpileModule(`
  let disposed = false, termDisposed = false, sessionStarted = true, sessionExitPending = false;
  let unlistenExit = null;
  ${consumer.replaceAll("import.meta.env.DEV", "dev")}
  return {
    register: registerExitListener,
    cleanup() { disposed = true; ${cleanup} },
  };
`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
const exitConsumer = new Function("onPtyExit", "sessionId", "reportSessionExit", "dev", compiled) as (
  listen: typeof onPtyExit, sessionId: string, report: () => void, dev: boolean,
) => { register(): Promise<void>; cleanup(): void };

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.restoreAllMocks(); transport.invoke.mockReset(); transport.listen.mockReset(); });

it.each(["terminal cleanup", "listener replacement"])(
  "INTEG-6b %s handles asynchronous unregister rejection and cancels pending exit delivery",
  async mode => {
    const id = `integ6b-${mode.replaceAll(" ", "-")}`, epoch = 681;
    const queried = deferred<number | null>(), unregister = deferred<void>();
    const receives: Array<(event: { payload: { session_epoch: number } }) => void> = [];
    let result: Promise<void> | undefined;
    let catches: ReturnType<typeof vi.spyOn> | undefined;
    const unlisten = vi.fn(() => {
      result = (async () => { await unregister.promise; })();
      catches = vi.spyOn(result, "catch");
      return result;
    });
    transport.listen.mockImplementation(async (name: string, callback: typeof receives[number]) => {
      expect(name).toBe(`pty-exit-${id}`);
      receives.push(callback);
      return receives.length === 1 ? unlisten : () => Promise.resolve();
    });
    transport.invoke.mockImplementation((command: string) => {
      expect(command).toBe("get_codex_restore_epoch");
      return queried.promise;
    });
    const report = vi.fn(), debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const terminal = exitConsumer(onPtyExit, id, report, import.meta.env.DEV);
    const failure = new Error("unregister: listener already gone during docking");
    try {
      publishCodexRestoreNoticeEpoch(id, epoch);
      await terminal.register();
      invalidateCodexRestoreNotice(id);
      receives[0]({ payload: { session_epoch: epoch } });
      expect(transport.invoke).toHaveBeenCalledExactlyOnceWith("get_codex_restore_epoch", { sessionId: id });
      expect(report).not.toHaveBeenCalled();

      if (mode === "listener replacement") await terminal.register();
      else terminal.cleanup();
      expect(unlisten).toHaveBeenCalledOnce();
      // Drain only the broken path so its real asynchronous rejection yields
      // a missing-consumer-handler assertion, not a runner-level error. On
      // green, XTermWrapper is the sole rejection handler for this promise.
      const needsTestDrain = catches?.mock.calls.length === 0;
      if (needsTestDrain) void result?.then(undefined, () => {});
      unregister.reject(failure);
      await setImmediate();
      expect(debug).toHaveBeenCalledExactlyOnceWith(`[mycmux-diag xterm:${id}] exit unlisten ignored`, failure);
      expect(catches, "XTermWrapper must attach its rejection handler to the transport promise").toHaveBeenCalledOnce();
      expect(needsTestDrain).toBe(false);
      expect(unhandled).not.toHaveBeenCalled();

      queried.resolve(epoch);
      await setImmediate();
      // The failed native unregister leaves its callback available. Neither a
      // queued query answer nor another delivery may confirm this old exit.
      publishCodexRestoreNoticeEpoch(id, epoch);
      receives[0]({ payload: { session_epoch: epoch } });
      await setImmediate();
      expect(report).not.toHaveBeenCalled();
      expect(ptyExitConfirmed(id, epoch)).toBe(false);
      expect(transport.invoke).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      if (result && catches?.mock.calls.length === 0) void result.catch(() => {});
      unregister.resolve();
      queried.resolve(epoch);
      terminal.cleanup();
      await setImmediate();
      process.off("unhandledRejection", unhandled);
    }
  },
);

// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), pushToast: vi.fn(),
  receive: undefined as undefined | ((event: { payload: Record<string, unknown> }) => unknown),
  workspaces: [] as unknown[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fixture.invoke, Channel: class { onmessage?: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: fixture.listen, emit: vi.fn(async () => {}) }));
vi.mock("../../src/stores/workspaceListStore", () => ({ useWorkspaceListStore: { getState: () => ({ workspaces: fixture.workspaces }) } }));
vi.mock("../../src/stores/toastStore", () => ({ useToastStore: { getState: () => ({ pushToast: fixture.pushToast }) } }));
const TAB = "dddddddd-1111-4222-8333-444444444444";
const G = "cccccccc-1111-4222-8333-444444444444";
function notice(overrides: Record<string, unknown> = {}) {
  return { payload: { session_id: "r10-pty", session_epoch: 101, generation: G, tab_id: TAB, reason: "missing-id", ...overrides } };
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  fixture.workspaces = [{ panes: [{ tabs: [{ id: TAB, sessionId: "r10-pty" }] }] }];
  fixture.receive = undefined;
  fixture.invoke.mockResolvedValue(undefined);
  fixture.listen.mockImplementation(async (name, callback) => {
    if (name === "codex-restore-notice") fixture.receive = callback;
    return () => {};
  });
});
it.each([
  ["node", ["/tools/codex.js", "resume", G]],
  ["bun", ["/tools/codex.js", "resume", G]],
  ["C:\\tools\\CODEX.EXE", ["resume", G]],
  ["C:\\tools\\CODEX.CMD", ["resume", G]],
])("registers notice reception before actual createSession IPC for %s", async (command, args) => {
  const { createSession } = await import("../../src/lib/ipc");
  fixture.invoke.mockImplementation(async name => {
    if (name === "create_session") expect(fixture.receive, "R10-2: notice listener must precede native launch").toBeTypeOf("function");
  });
  await createSession("r10-pty", command as string, args as string[], 80, 24, () => {}, undefined, undefined, false, { backgroundOnly: true });
  expect(fixture.invoke).toHaveBeenCalledWith("create_session", expect.objectContaining({ command, args }));
});
async function receiver() {
  await (await import("../../src/lib/codexRestore")).ensureCodexRestoreNoticeListener();
  expect(fixture.receive).toBeTypeOf("function");
  return fixture.receive!;
}
it("rejects a delayed old notice after a different-window replacement of the same PTY", async () => {
  const receive = await receiver();
  fixture.invoke.mockResolvedValue(202);
  await receive(notice());
  expect(fixture.invoke).toHaveBeenCalledWith("get_codex_restore_epoch", { sessionId: "r10-pty" });
  expect(fixture.pushToast, "R10-3: old E1 must not notify replacement E2").not.toHaveBeenCalled();
});
it("delivers a matching native launch identity once", async () => {
  const receive = await receiver();
  fixture.invoke.mockResolvedValue(101);
  await receive(notice()); await receive(notice());
  expect(fixture.pushToast).toHaveBeenCalledTimes(1);
  expect(fixture.pushToast).toHaveBeenCalledWith(expect.stringContaining("前回の Codex"), "warning");
});
it("rejects a notice if its tab is replaced while the native epoch query is pending", async () => {
  const receive = await receiver();
  let resolve!: (epoch: number) => void;
  fixture.invoke.mockReturnValue(new Promise<number>(yes => { resolve = yes; }));
  const receiving = receive(notice());
  expect(fixture.invoke, "R10-3: delivery must check the authoritative native instance").toHaveBeenCalledWith("get_codex_restore_epoch", { sessionId: "r10-pty" });
  fixture.workspaces = [{ panes: [{ tabs: [{ id: "replacement-tab", sessionId: "r10-pty" }] }] }];
  resolve(101); await receiving;
  expect(fixture.pushToast).not.toHaveBeenCalled();
});
it("fails closed when the authoritative epoch query fails", async () => {
  const receive = await receiver();
  fixture.invoke.mockRejectedValue(new Error("native instance unavailable"));
  await receive(notice());
  expect(fixture.pushToast).not.toHaveBeenCalled();
});
it("rejects a notice without a complete launch identity", async () => {
  const receive = await receiver();
  fixture.invoke.mockResolvedValue(101);
  await receive(notice({ generation: "untrusted" }));
  await receive(notice({ tab_id: "other-tab" }));
  await receive({ payload: { session_id: "r10-pty", reason: "missing-id" } });
  expect(fixture.pushToast).not.toHaveBeenCalled();
});

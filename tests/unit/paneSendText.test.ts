import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const ipcMocks = vi.hoisted(() => ({
  writeToSession: vi.fn(),
}));
const terminalBufferMocks = vi.hoisted(() => ({
  getTerminalBufferLines: vi.fn(),
  hasTerminalBuffer: vi.fn(),
}));

vi.mock("../../src/lib/ipc", () => ipcMocks);
vi.mock("../../src/components/terminal/XTermWrapper", () => terminalBufferMocks);

const sessionId = "send-session";
const observed995JapaneseText = "送信確認".repeat(248) + "確認";

function workspace(): Workspace {
  const tab: PaneTab = {
    id: "send-tab",
    sessionId,
    agentId: "shell-starter",
    type: "terminal",
  };
  const pane: Pane = {
    id: "send-pane",
    agentId: tab.agentId,
    sessionId,
    tabs: [tab],
    activeTabId: tab.id,
  };
  return {
    id: "send-workspace",
    name: "Send workspace",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: [pane],
    splitColumns: [[pane.id]],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  ipcMocks.writeToSession.mockResolvedValue(undefined);
  terminalBufferMocks.hasTerminalBuffer.mockReturnValue(true);
  useWorkspaceListStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: "send-workspace",
    lastActivePaneByWorkspace: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushSendTimers(): Promise<void> {
  // The first command dynamically imports the mocked IPC/buffer modules before
  // scheduling its polls. Advance more than once so those microtasks can settle.
  for (let pass = 0; pass < 3; pass += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
}

describe("pane.send_text confirmed enter", () => {
  it("rejects a declared tab before any write or buffer read", async () => {
    const state = useWorkspaceListStore.getState();
    const declaredWorkspace = state.workspaces[0];
    declaredWorkspace.panes[0].tabs[0].lifecycle = "declared";
    useWorkspaceListStore.setState({ workspaces: [declaredWorkspace] });

    await expect(handleSocketCommand("pane.send_text", {
      sessionId,
      text: "do not send",
      enter: true,
    })).rejects.toThrow("pane.send_text cannot target a declared tab");
    expect(ipcMocks.writeToSession).not.toHaveBeenCalled();
    expect(terminalBufferMocks.hasTerminalBuffer).not.toHaveBeenCalled();
    expect(terminalBufferMocks.getTerminalBufferLines).not.toHaveBeenCalled();
  });

  it("separates the observed bytes:995 Japanese payload and confirms screen advance", async () => {
    vi.useRealTimers();
    const text = observed995JapaneseText;
    expect(text.length).toBe(994);
    expect(new TextEncoder().encode(text).byteLength).toBe(2_982);
    expect(new TextEncoder().encode(text + "\r").byteLength).toBe(2_983);
    terminalBufferMocks.getTerminalBufferLines
      .mockReturnValueOnce(["ready"])
      .mockReturnValueOnce([`ready ${text}`])
      .mockReturnValueOnce([`ready ${text}`])
      .mockReturnValueOnce(["working"]);

    await expect(
      handleSocketCommand("pane.send_text", { sessionId, text, enter: true }),
    ).resolves.toEqual({
      sessionId,
      bytes: 995,
      ok: true,
      confirmed: true,
      attempts: 1,
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([
      [sessionId, text],
      [sessionId, "\r"],
    ]);
  });

  it("returns a structured failure for the observed bytes:995 case when submit is unconfirmed", async () => {
    const text = observed995JapaneseText;
    terminalBufferMocks.getTerminalBufferLines
      .mockReturnValueOnce(["ready"])
      .mockReturnValueOnce([`ready ${text}`])
      .mockReturnValue([`ready ${text}`]);

    const pending = handleSocketCommand("pane.send_text", {
      sessionId,
      text,
      enter: true,
    });
    await flushSendTimers();

    await expect(pending).resolves.toEqual({
      sessionId,
      bytes: 995,
      ok: false,
      confirmed: false,
      attempts: 3,
      reason: "submit_unconfirmed",
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([
      [sessionId, text],
      [sessionId, "\r"],
      [sessionId, "\r"],
      [sessionId, "\r"],
    ]);
  });

  it("confirms a short payload after one separate Enter", async () => {
    terminalBufferMocks.getTerminalBufferLines
      .mockReturnValueOnce(["ready"])
      .mockReturnValueOnce(["ready short"])
      .mockReturnValueOnce(["ready short"])
      .mockReturnValueOnce(["working"]);

    const pending = handleSocketCommand("pane.send_text", {
      sessionId,
      text: "short",
      enter: true,
    });
    await flushSendTimers();

    await expect(pending).resolves.toMatchObject({
      sessionId,
      ok: true,
      confirmed: true,
      attempts: 1,
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([
      [sessionId, "short"],
      [sessionId, "\r"],
    ]);
  });

  it("sends only Enter for an empty payload and confirms it", async () => {
    terminalBufferMocks.getTerminalBufferLines
      .mockReturnValueOnce(["ready"])
      .mockReturnValueOnce(["next prompt"]);

    const pending = handleSocketCommand("pane.send_text", {
      sessionId,
      text: "",
      enter: true,
    });
    await flushSendTimers();

    await expect(pending).resolves.toEqual({
      sessionId,
      bytes: 1,
      ok: true,
      confirmed: true,
      attempts: 1,
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([[sessionId, "\r"]]);
  });

  it("reports the successful retry attempt without resending the payload", async () => {
    let snapshotReads = 0;
    terminalBufferMocks.getTerminalBufferLines.mockImplementation(() => {
      snapshotReads += 1;
      if (snapshotReads === 1) return ["ready"];
      const enterWrites = ipcMocks.writeToSession.mock.calls.filter(
        ([, data]) => data === "\r",
      ).length;
      return enterWrites >= 2 ? ["advanced"] : ["ready retry"];
    });

    const pending = handleSocketCommand("pane.send_text", {
      sessionId,
      text: "retry",
      enter: true,
    });
    await flushSendTimers();

    await expect(pending).resolves.toMatchObject({
      ok: true,
      confirmed: true,
      attempts: 2,
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([
      [sessionId, "retry"],
      [sessionId, "\r"],
      [sessionId, "\r"],
    ]);
  });

  it("returns verification_unavailable instead of claiming success without a buffer", async () => {
    terminalBufferMocks.getTerminalBufferLines.mockImplementation(() => {
      throw new Error("buffer unavailable");
    });

    const pending = handleSocketCommand("pane.send_text", {
      sessionId,
      text: "short",
      enter: true,
    });
    await flushSendTimers();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      confirmed: false,
      attempts: 1,
      reason: "verification_unavailable",
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([
      [sessionId, "short"],
      [sessionId, "\r"],
    ]);
  });

  it("sends an empty follow-up Enter only once when verification disappears", async () => {
    terminalBufferMocks.getTerminalBufferLines
      .mockReturnValueOnce(["ready"])
      .mockReturnValueOnce(["ready"])
      .mockImplementation(() => {
        throw new Error("buffer unavailable");
      });

    const pending = handleSocketCommand("pane.send_text", {
      sessionId,
      text: "",
      enter: true,
    });
    await flushSendTimers();

    await expect(pending).resolves.toEqual({
      sessionId,
      bytes: 1,
      ok: false,
      confirmed: false,
      attempts: 1,
      reason: "verification_unavailable",
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([[sessionId, "\r"]]);
  });

  it("stops after text write failure without sending Enter", async () => {
    ipcMocks.writeToSession.mockRejectedValueOnce(new Error("text write failed"));
    terminalBufferMocks.getTerminalBufferLines.mockReturnValue(["ready"]);

    await expect(
      handleSocketCommand("pane.send_text", { sessionId, text: "short", enter: true }),
    ).rejects.toThrow("text write failed");
    expect(ipcMocks.writeToSession.mock.calls).toEqual([[sessionId, "short"]]);
  });

  it("surfaces Enter write failure without retrying or resending text", async () => {
    ipcMocks.writeToSession.mockRejectedValueOnce(new Error("enter write failed"));
    terminalBufferMocks.getTerminalBufferLines.mockReturnValue(["ready"]);

    await expect(
      handleSocketCommand("pane.send_text", { sessionId, text: "", enter: true }),
    ).rejects.toThrow("enter write failed");
    expect(ipcMocks.writeToSession.mock.calls).toEqual([[sessionId, "\r"]]);
  });

  it("rejects a non-boolean enter value instead of silently skipping confirmation", async () => {
    await expect(
      handleSocketCommand("pane.send_text", { sessionId, text: "short", enter: "true" }),
    ).rejects.toThrow("pane.send_text enter must be a boolean");
    expect(ipcMocks.writeToSession).not.toHaveBeenCalled();
  });

  it("serializes concurrent sends to the same session", async () => {
    await handleSocketCommand("pane.send_text", {
      sessionId,
      text: "warmup",
      enter: false,
    });
    ipcMocks.writeToSession.mockClear();

    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    ipcMocks.writeToSession
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValue(undefined);

    const first = handleSocketCommand("pane.send_text", {
      sessionId,
      text: "first",
      enter: false,
    });
    const second = handleSocketCommand("pane.send_text", {
      sessionId,
      text: "second",
      enter: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(ipcMocks.writeToSession.mock.calls).toEqual([[sessionId, "first"]]);
    releaseFirstWrite();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { sessionId, queuedBytes: 5, unverified: true, note: "no delivery verification; use --enter or --key to get confirmation" },
      { sessionId, queuedBytes: 6, unverified: true, note: "no delivery verification; use --enter or --key to get confirmation" },
    ]);
    expect(ipcMocks.writeToSession.mock.calls).toEqual([
      [sessionId, "first"],
      [sessionId, "second"],
    ]);
  });

  it("labels a one-write result as unverified when Enter was not requested", async () => {
    await expect(
      handleSocketCommand("pane.send_text", { sessionId, text: "typed only", enter: false }),
    ).resolves.toEqual({
      sessionId,
      queuedBytes: 10,
      unverified: true,
      note: "no delivery verification; use --enter or --key to get confirmation",
    });
    expect(ipcMocks.writeToSession).toHaveBeenCalledOnce();
    expect(ipcMocks.writeToSession).toHaveBeenCalledWith(sessionId, "typed only");
    expect(terminalBufferMocks.getTerminalBufferLines).not.toHaveBeenCalled();
  });

  it("writes an arrow key once and confirms its screen effect without appending Enter", async () => {
    terminalBufferMocks.getTerminalBufferLines
      .mockReturnValueOnce(["ready"])
      .mockReturnValueOnce(["history command"]);

    const pending = handleSocketCommand("pane.send_text", { sessionId, text: "", key: "up" });
    await flushSendTimers();

    await expect(pending).resolves.toMatchObject({
      sessionId,
      ok: true,
      confirmed: true,
      attempts: 1,
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([[sessionId, "\x1b[A"]]);
  });

  it.each([
    ["enter", "\r"], ["esc", "\x1b"], ["tab", "\t"], ["up", "\x1b[A"],
    ["down", "\x1b[B"], ["left", "\x1b[D"], ["right", "\x1b[C"],
    ["ctrl-c", "\x03"], ["space", " "], ["backspace", "\x7f"],
  ])("maps key %s to its terminal byte sequence", async (key, expected) => {
    terminalBufferMocks.getTerminalBufferLines
      .mockReturnValueOnce(["ready"])
      .mockReturnValueOnce(["changed"]);

    const pending = handleSocketCommand("pane.send_text", { sessionId, text: "", key });
    await flushSendTimers();

    await expect(pending).resolves.toMatchObject({ confirmed: true });
    expect(ipcMocks.writeToSession).toHaveBeenCalledWith(sessionId, expected);
  });
});

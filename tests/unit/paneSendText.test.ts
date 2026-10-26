import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const ipcMocks = vi.hoisted(() => ({
  getSessionInputRevision: vi.fn(),
  writeToSession: vi.fn(),
  writeToSessionGuarded: vi.fn(),
  getSessionScrollback: vi.fn(),
}));
const terminalBufferMocks = vi.hoisted(() => ({
  getTerminalBufferLines: vi.fn(),
  hasTerminalBuffer: vi.fn(),
  hasMountedTerminal: vi.fn(),
}));
const headlessBufferMocks = vi.hoisted(() => ({
  getHeadlessBufferLines: vi.fn(),
}));
const messageMocks = vi.hoisted(() => ({ preparePaneMessage: vi.fn(), writePaneMessage: vi.fn(), verifyPaneMessage: vi.fn() }));
vi.mock("../../src/lib/livebrief", async (original) => ({
  ...await original<typeof import("../../src/lib/livebrief")>(), ...messageMocks,
}));

vi.mock("../../src/lib/ipc", () => ipcMocks);
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ ...terminalBufferMocks, isTerminalParsingCurrentOutput: (id: string) => terminalBufferMocks.hasTerminalBuffer(id, true) }));
vi.mock("../../src/components/terminal/headlessBuffer", () => ({
  ...headlessBufferMocks,
  readHeadlessBufferLines: async (id: string, load: () => Promise<unknown>, lines: number, size: unknown) => (
    headlessBufferMocks.getHeadlessBufferLines(id, await load(), lines, size)
  ),
}));

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
  messageMocks.preparePaneMessage.mockImplementation(async (id: string, agentMessage: boolean) => {
    const attention = useSessionAttentionStore.getState().attentionBySession[id];
    return { guard: { sessionId: id, sessionEpoch: attention?.sessionEpoch ?? 5,
      sessionRevision: attention?.sessionRevision ?? 11, attentionId: attention?.attentionId ?? null,
      inputRevision: 7, agentMessage }, reason: null };
  });
  // The fake native transport records the same physical writes as the shell
  // tests below; separate regressions assert guard calls and rejection behavior.
  messageMocks.writePaneMessage.mockImplementation(async (guard, data, submit) => {
    if (useSessionAttentionStore.getState().attentionBySession[guard.sessionId]) {
      return ipcMocks.writeToSessionGuarded(guard.sessionId, data, guard.attentionId,
        guard.sessionEpoch, guard.sessionRevision, guard.inputRevision + Number(submit));
    }
    await ipcMocks.writeToSession(guard.sessionId, data);
    return { sent: true, reason: null };
  });
  messageMocks.verifyPaneMessage.mockResolvedValue({ confirmed: false, matchedEventId: null });
  ipcMocks.getSessionInputRevision.mockResolvedValue(7);
  ipcMocks.writeToSession.mockResolvedValue(undefined);
  ipcMocks.writeToSessionGuarded.mockResolvedValue({ sent: true, reason: null });
  terminalBufferMocks.hasTerminalBuffer.mockReturnValue(true);
  terminalBufferMocks.hasMountedTerminal.mockReturnValue(true);
  useWorkspaceListStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: "send-workspace",
    lastActivePaneByWorkspace: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  useSessionAttentionStore.getState().resetForTests();
});

async function flushSendTimers(): Promise<void> {
  // The first command dynamically imports the mocked IPC/buffer modules before
  // scheduling its polls. Advance more than once so those microtasks can settle.
  for (let pass = 0; pass < 3; pass += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
}

describe("pane.send_text confirmed enter", () => {
  it("keeps the composer's erase-only adoption on the raw editing path", async () => {
    await expect(handleSocketCommand("pane.send_text", { sessionId, text: "\u007f\u007f" })).resolves.toMatchObject({ unverified: true });
    expect(messageMocks.preparePaneMessage).not.toHaveBeenCalled();
    expect(ipcMocks.writeToSession).toHaveBeenCalledExactlyOnceWith(sessionId, "\u007f\u007f");
  });
  it.each([true, false])("keeps the native receipt across text-only then Enter (enter flag=%s)", async (flag) => {
    const ws = workspace(); ws.panes[0].tabs[0].agentKind = "codex";
    useWorkspaceListStore.setState({ workspaces: [ws] });
    terminalBufferMocks.getTerminalBufferLines.mockReturnValue(["spinner"]);
    await handleSocketCommand("pane.send_text", { sessionId, text: "日本語\n次の行" });
    const pending = handleSocketCommand("pane.send_text", { sessionId, text: "", ...(flag ? { enter: true } : { key: "enter" }) });
    await flushSendTimers();
    await expect(pending).resolves.toMatchObject({ confirmed: false, enterWritten: true, outcome: "unknown" });
    expect(messageMocks.preparePaneMessage).toHaveBeenCalledOnce();
    expect(messageMocks.verifyPaneMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId }), "日本語\n次の行");
    expect(ipcMocks.writeToSession.mock.calls).toEqual([[sessionId, "日本語\n次の行"], [sessionId, "\r"]]);
  });

  it("blocks text-only before bytes when the agent is asking, without stealing answer keys", async () => {
    messageMocks.preparePaneMessage.mockResolvedValue({ guard: null, reason: "pending_prompt" });
    await expect(handleSocketCommand("pane.send_text", { sessionId, text: "本文" }))
      .resolves.toMatchObject({ sent: false, textWritten: false, reason: "pending_prompt" });
    expect(messageMocks.writePaneMessage).not.toHaveBeenCalled();
    terminalBufferMocks.getTerminalBufferLines.mockReturnValueOnce(["choice"]).mockReturnValue(["selected"]);
    const arrow = handleSocketCommand("pane.send_text", { sessionId, text: "", key: "down" });
    await flushSendTimers(); await expect(arrow).resolves.toMatchObject({ confirmed: true });
    expect(ipcMocks.writeToSession).toHaveBeenCalledWith(sessionId, "\u001b[B");
  });

  it("reports text already written if the target disappears before Enter", async () => {
    terminalBufferMocks.getTerminalBufferLines.mockReturnValue(["echo"]);
    messageMocks.writePaneMessage.mockImplementationOnce(async () => {
      useWorkspaceListStore.setState({ workspaces: [] }); return { sent: true, reason: null };
    });
    const pending = handleSocketCommand("pane.send_text", { sessionId, text: "本文", enter: true });
    await flushSendTimers();
    await expect(pending).resolves.toMatchObject({ reason: "target_changed", textWritten: true, enterWritten: false });
    expect(messageMocks.writePaneMessage).toHaveBeenCalledOnce();
  });

  it.each(["claude", "codex", "claude-codex"])("does not confirm %s from a spinner or dismissed modal", async (kind) => {
    const ws = workspace();
    ws.panes[0].tabs[0].agentKind = kind as "claude" | "codex" | "claude-codex";
    useWorkspaceListStore.setState({ workspaces: [ws] });
    terminalBufferMocks.getTerminalBufferLines.mockReturnValueOnce(["prompt"])
      .mockReturnValueOnce(["typed"] ).mockReturnValueOnce(["typed"]).mockReturnValue(["spinner changed"]);
    const pending = handleSocketCommand("pane.send_text", { sessionId, text: "same instruction", enter: true });
    await flushSendTimers();
    await expect(pending).resolves.toMatchObject({ confirmed: false, enterWritten: true, outcome: "unknown" });
    expect(messageMocks.verifyPaneMessage).toHaveBeenCalled();
    expect(ipcMocks.writeToSession.mock.calls).toEqual([[sessionId, "same instruction"], [sessionId, "\r"]]);
  });

  it("confirms an agent input from native acceptance evidence with an unreadable screen", async () => {
    const ws = workspace(); ws.panes[0].tabs[0].agentKind = "codex";
    useWorkspaceListStore.setState({ workspaces: [ws] });
    terminalBufferMocks.getTerminalBufferLines.mockImplementation(() => { throw new Error("unreadable"); });
    messageMocks.verifyPaneMessage.mockResolvedValue({ confirmed: true, matchedEventId: "new-user-event" });
    const pending = handleSocketCommand("pane.send_text", { sessionId, text: "accepted", enter: true });
    await flushSendTimers();
    await expect(pending).resolves.toMatchObject({ confirmed: true, attempts: 1 });
    expect(messageMocks.verifyPaneMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId }), "accepted");
  });

  it("blocks an ordinary message before text when expectations were omitted", async () => {
    messageMocks.preparePaneMessage.mockResolvedValue({ guard: null, reason: "pending_prompt" });
    await expect(handleSocketCommand("pane.send_text", { sessionId, text: "do not answer", enter: true }))
      .resolves.toMatchObject({ sent: false, textWritten: false, enterWritten: false, reason: "pending_prompt",
        message: expect.stringContaining("あなたの番") });
    expect(messageMocks.writePaneMessage).not.toHaveBeenCalled();
    expect(ipcMocks.writeToSession).not.toHaveBeenCalled();
  });

  it("does not submit or retype when a question arrives after text", async () => {
    terminalBufferMocks.getTerminalBufferLines.mockReturnValue(["echo"]);
    messageMocks.writePaneMessage.mockResolvedValueOnce({ sent: true, reason: null })
      .mockResolvedValueOnce({ sent: false, reason: "pending_prompt" });
    const pending = handleSocketCommand("pane.send_text", { sessionId, text: "draft", enter: true });
    await flushSendTimers();
    await expect(pending).resolves.toMatchObject({ reason: "pending_prompt", textWritten: true, enterWritten: false });
    expect(messageMocks.writePaneMessage.mock.calls.map(([, data, submit]) => [data, submit]))
      .toEqual([["draft", false], ["\r", true]]);
    expect(ipcMocks.writeToSession).not.toHaveBeenCalled();
  });

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
    expect(terminalBufferMocks.hasMountedTerminal).not.toHaveBeenCalled();
    expect(terminalBufferMocks.getTerminalBufferLines).not.toHaveBeenCalled();
  }, 120_000);

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
      attempts: 1,
      enterWritten: true,
      outcome: "unknown",
      reason: "submit_unconfirmed",
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([
      [sessionId, text],
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

  it("does not retry Enter when the first press is unconfirmed", async () => {
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
      ok: false,
      confirmed: false,
      attempts: 1,
      enterWritten: true,
      outcome: "unknown",
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([
      [sessionId, "retry"],
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
      enterWritten: true,
      outcome: "unknown",
      reason: "verification_unavailable",
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([
      [sessionId, "short"],
      [sessionId, "\r"],
    ]);
  });

  it("bounds a stalled unmounted snapshot and reports why confirmation is unavailable", async () => {
    terminalBufferMocks.hasMountedTerminal.mockReturnValue(false);
    terminalBufferMocks.hasTerminalBuffer.mockReturnValue(false);
    ipcMocks.getSessionScrollback.mockImplementation(() => new Promise(() => {}));

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
      reason: "target_unmounted",
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([
      [sessionId, "short"],
      [sessionId, "\r"],
    ]);
  });

  it("uses backend scrollback instead of a cached xterm for unmounted confirmation", async () => {
    terminalBufferMocks.hasMountedTerminal.mockReturnValue(false);
    terminalBufferMocks.hasTerminalBuffer.mockReturnValue(true);
    const before = { data: new Uint8Array([1]), startOffset: 0, endOffset: 1 };
    const after = { data: new Uint8Array([2]), startOffset: 0, endOffset: 1 };
    ipcMocks.getSessionScrollback
      .mockResolvedValueOnce(before)
      .mockResolvedValue(after);
    headlessBufferMocks.getHeadlessBufferLines.mockImplementation((
      _targetSessionId: string,
      snapshot: { data: Uint8Array },
    ) => snapshot.data[0] === 1 ? ["before"] : ["after"]);

    const pending = handleSocketCommand("pane.send_text", { sessionId, text: "", key: "down" });
    await flushSendTimers();

    await expect(pending).resolves.toMatchObject({
      sessionId,
      ok: true,
      confirmed: true,
      attempts: 1,
    });
    expect(terminalBufferMocks.getTerminalBufferLines).not.toHaveBeenCalled();
    expect(terminalBufferMocks.hasTerminalBuffer).not.toHaveBeenCalled();
    expect(ipcMocks.getSessionScrollback).toHaveBeenCalledTimes(2);
    // The fourth argument is the renderer's cached geometry (none for an unmounted session).
    expect(headlessBufferMocks.getHeadlessBufferLines).toHaveBeenCalledWith(sessionId, before, 24, undefined);
    expect(headlessBufferMocks.getHeadlessBufferLines).toHaveBeenCalledWith(sessionId, after, 24, undefined);
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
      enterWritten: true,
      outcome: "unknown",
      reason: "verification_unavailable",
    });
    expect(ipcMocks.writeToSession.mock.calls).toEqual([[sessionId, "\r"]]);
  });

  it("stops after text write failure without sending Enter", async () => {
    ipcMocks.writeToSession.mockRejectedValueOnce(new Error("text write failed"));
    terminalBufferMocks.getTerminalBufferLines.mockReturnValue(["ready"]);

    await expect(
      handleSocketCommand("pane.send_text", { sessionId, text: "short", enter: true }),
    ).resolves.toMatchObject({ confirmed: false, outcome: "unknown", reason: "write_unconfirmed", writeMayHaveOccurred: true });
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

describe("pane.send_text optimistic lock from the frontend", () => {
  function seedAttention(attentionId: string | null, sessionRevision: number) {
    useSessionAttentionStore.setState({
      attentionBySession: {
        [sessionId]: {
          sessionId,
          sessionEpoch: 5,
          attentionId,
          kind: attentionId ? "input" : "none",
          detail: null,
          sessionRevision,
          uiState: "waiting",
          stateSince: 1,
          occurrenceOrder: 1,
        },
      },
    });
  }

  it("writes through the guarded backend when all expectations match", async () => {
    seedAttention("attention-a", 11);
    await expect(handleSocketCommand("pane.send_text", {
      sessionId,
      text: "2",
      expectedAttentionId: "attention-a",
      expectedSessionEpoch: 5,
      expectedSessionRevision: 11,
      expectedInputRevision: 7,
    })).resolves.toMatchObject({ sessionId, unverified: true });
    expect(ipcMocks.writeToSession).not.toHaveBeenCalled();
    expect(ipcMocks.writeToSessionGuarded).toHaveBeenCalledOnce();
    expect(ipcMocks.writeToSessionGuarded).toHaveBeenCalledWith(
      sessionId,
      "2",
      "attention-a",
      5,
      11,
      7,
    );
  });

  it("writes through the guarded backend when null attention matches none", async () => {
    seedAttention(null, 11);
    await expect(handleSocketCommand("pane.send_text", {
      sessionId,
      text: "hello",
      expectedAttentionId: null,
      expectedSessionEpoch: 5,
      expectedSessionRevision: 11,
      expectedInputRevision: 7,
    })).resolves.toMatchObject({ sessionId, unverified: true });
    expect(ipcMocks.writeToSession).not.toHaveBeenCalled();
    expect(ipcMocks.writeToSessionGuarded).toHaveBeenCalledWith(
      sessionId,
      "hello",
      null,
      5,
      11,
      7,
    );
  });

  it("rejects partial expectations before any write", async () => {
    seedAttention("attention-a", 11);
    await expect(handleSocketCommand("pane.send_text", {
      sessionId,
      text: "2",
      expectedAttentionId: "attention-a",
      expectedSessionEpoch: 5,
      expectedSessionRevision: 11,
    })).resolves.toEqual({
      sent: false,
      reason: "incomplete_expectations",
      current: null,
    });
    expect(ipcMocks.writeToSession).not.toHaveBeenCalled();
    expect(ipcMocks.writeToSessionGuarded).not.toHaveBeenCalled();
  });

  it("rejects a mismatched expectedAttentionId before any write", async () => {
    seedAttention("attention-b", 11);
    await expect(handleSocketCommand("pane.send_text", {
      sessionId,
      text: "2",
      expectedAttentionId: "attention-a",
      expectedSessionEpoch: 5,
      expectedSessionRevision: 11,
      expectedInputRevision: 7,
    })).resolves.toMatchObject({
      sent: false,
      reason: "attention_id",
    });
    expect(ipcMocks.writeToSession).not.toHaveBeenCalled();
    expect(ipcMocks.writeToSessionGuarded).not.toHaveBeenCalled();
  });

  it.each([
    ["future", 12],
    ["older", 10],
  ])("rejects a %s expectedSessionRevision before any write", async (_label, expectedSessionRevision) => {
    seedAttention("attention-a", 11);
    await expect(handleSocketCommand("pane.send_text", {
      sessionId,
      text: "2",
      expectedAttentionId: "attention-a",
      expectedSessionEpoch: 5,
      expectedSessionRevision,
      expectedInputRevision: 7,
    })).resolves.toMatchObject({
      sent: false,
      reason: "session_revision",
    });
    expect(ipcMocks.writeToSession).not.toHaveBeenCalled();
    expect(ipcMocks.writeToSessionGuarded).not.toHaveBeenCalled();
  });

  it("accepts camelCase and snake_case expectation aliases on the same validated path", async () => {
    seedAttention("attention-a", 11);
    await expect(handleSocketCommand("pane.send_text", {
      session_id: sessionId,
      text: "2",
      expected_attention_id: "attention-a",
      expected_session_epoch: 5,
      expected_session_revision: 11,
      expected_input_revision: 7,
    })).resolves.toMatchObject({ unverified: true });
    expect(ipcMocks.writeToSession).not.toHaveBeenCalled();
    expect(ipcMocks.writeToSessionGuarded).toHaveBeenCalledWith(
      sessionId,
      "2",
      "attention-a",
      5,
      11,
      7,
    );
  });

  it("uses the supplied input revision without re-reading it at send time", async () => {
    seedAttention("attention-a", 11);
    await expect(handleSocketCommand("pane.send_text", {
      sessionId,
      text: "2",
      expectedAttentionId: "attention-a",
      expectedSessionEpoch: 5,
      expectedSessionRevision: 11,
      expectedInputRevision: 6,
    })).resolves.toMatchObject({ unverified: true });

    expect(ipcMocks.getSessionInputRevision).not.toHaveBeenCalled();
    expect(ipcMocks.writeToSessionGuarded).toHaveBeenCalledWith(
      sessionId,
      "2",
      "attention-a",
      5,
      11,
      6,
    );
  });

  it("returns a backend lock rejection without claiming that a key was queued", async () => {
    seedAttention("attention-a", 11);
    ipcMocks.writeToSessionGuarded.mockResolvedValueOnce({
      sent: false,
      reason: "attention_id",
    });
    await expect(handleSocketCommand("pane.send_text", {
      sessionId,
      text: "2",
      expectedAttentionId: "attention-a",
      expectedSessionEpoch: 5,
      expectedSessionRevision: 11,
      expectedInputRevision: 7,
    })).resolves.toEqual({ sent: false, reason: "attention_id" });
    expect(ipcMocks.writeToSession).not.toHaveBeenCalled();
  });
  it.each([true, false])("keeps a staged ordinary guard with a done attention ID (enter flag=%s)", async (flag) => {
    seedAttention("done-a", 11);
    useSessionAttentionStore.setState((state) => ({ attentionBySession: {
      ...state.attentionBySession, [sessionId]: { ...state.attentionBySession[sessionId]!, kind: "done", uiState: "done" },
    } }));
    const ws = workspace(); ws.panes[0].tabs[0].agentKind = "codex";
    useWorkspaceListStore.setState({ workspaces: [ws] });
    const expectations = { expectedAttentionId: "done-a", expectedSessionEpoch: 5, expectedSessionRevision: 11 };
    await handleSocketCommand("pane.send_text", { sessionId, text: "日本語の通常本文", ...expectations, expectedInputRevision: 7 });
    const guard = messageMocks.writePaneMessage.mock.calls[0][0];
    terminalBufferMocks.getTerminalBufferLines.mockReturnValueOnce(["status panel"]).mockReturnValue(["panel closed"]);
    const pending = handleSocketCommand("pane.send_text", {
      sessionId, text: "", ...expectations, expectedInputRevision: 8, ...(flag ? { enter: true } : { key: "enter" }),
    });
    await flushSendTimers();
    await expect(pending).resolves.toMatchObject({ confirmed: false, enterWritten: true, outcome: "unknown" });
    expect(messageMocks.writePaneMessage.mock.calls).toEqual([[guard, "日本語の通常本文", false], [guard, "\r", true]]);
    expect(messageMocks.verifyPaneMessage).toHaveBeenCalledWith(guard, "日本語の通常本文");
    expect(ipcMocks.writeToSessionGuarded).toHaveBeenCalledTimes(2);
  });

  it.each(["input", "approval"] as const)("preserves an explicit %s Enter without a staged ordinary draft", async (kind) => {
    seedAttention("question-a", 11);
    useSessionAttentionStore.setState((state) => ({ attentionBySession: {
      ...state.attentionBySession, [sessionId]: { ...state.attentionBySession[sessionId]!, kind },
    } }));
    terminalBufferMocks.getTerminalBufferLines.mockReturnValueOnce(["choice"]).mockReturnValue(["answered"]);
    const pending = handleSocketCommand("pane.send_text", { sessionId, text: "", key: "enter",
      expectedAttentionId: "question-a", expectedSessionEpoch: 5, expectedSessionRevision: 11, expectedInputRevision: 7 });
    await flushSendTimers();
    await expect(pending).resolves.toMatchObject({ confirmed: true });
    expect(messageMocks.preparePaneMessage).not.toHaveBeenCalled();
    expect(messageMocks.writePaneMessage).not.toHaveBeenCalled();
    expect(ipcMocks.writeToSessionGuarded).toHaveBeenCalledExactlyOnceWith(sessionId, "\r", "question-a", 5, 11, 7);
  });

  it.each(["input", "approval"] as const)("does not turn a staged ordinary Enter into a new %s answer", async (kind) => {
    seedAttention("done-a", 11);
    useSessionAttentionStore.setState((state) => ({ attentionBySession: {
      ...state.attentionBySession, [sessionId]: { ...state.attentionBySession[sessionId]!, kind: "done", uiState: "done" },
    } }));
    const ws = workspace(); ws.panes[0].tabs[0].agentKind = "codex";
    useWorkspaceListStore.setState({ workspaces: [ws] });
    await handleSocketCommand("pane.send_text", { sessionId, text: "通常の下書き",
      expectedAttentionId: "done-a", expectedSessionEpoch: 5, expectedSessionRevision: 11, expectedInputRevision: 7 });
    const guard = messageMocks.writePaneMessage.mock.calls[0][0];
    seedAttention("new-question", 12);
    useSessionAttentionStore.setState((state) => ({ attentionBySession: {
      ...state.attentionBySession, [sessionId]: { ...state.attentionBySession[sessionId]!, kind },
    } }));
    messageMocks.writePaneMessage.mockResolvedValueOnce({ sent: false, reason: "pending_prompt" });
    terminalBufferMocks.getTerminalBufferLines.mockReturnValueOnce(["question"]).mockReturnValue(["selection changed"]);
    const pending = handleSocketCommand("pane.send_text", { sessionId, text: "", key: "enter",
      expectedAttentionId: "new-question", expectedSessionEpoch: 5, expectedSessionRevision: 12, expectedInputRevision: 8 });
    await flushSendTimers();
    await expect(pending).resolves.toMatchObject({ sent: false, textWritten: true, enterWritten: false, reason: "pending_prompt" });
    expect(messageMocks.writePaneMessage.mock.calls).toEqual([[guard, "通常の下書き", false], [guard, "\r", true]]);
    expect(ipcMocks.writeToSessionGuarded).toHaveBeenCalledExactlyOnceWith(sessionId, "通常の下書き", "done-a", 5, 11, 7);
    expect(messageMocks.verifyPaneMessage).not.toHaveBeenCalled();
  });

});

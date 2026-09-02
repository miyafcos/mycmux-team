// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PaneComposer } from "../../src/components/composer/PaneComposer";
import { observeSessionInput, resetSessionDraft } from "../../src/lib/inputLineDraft";
import { useComposerStore } from "../../src/stores/composerStore";

const mocks = vi.hoisted(() => ({
  handleSocketCommand: vi.fn(),
  enqueueSessionWrite: vi.fn(),
  chunkedWrite: vi.fn(),
  pushToast: vi.fn(),
  focusSessionSoon: vi.fn(),
}));

vi.mock("../../src/components/layout/socketCommands", () => ({
  handleSocketCommand: mocks.handleSocketCommand,
}));
// Stubbed so the composer cannot reach a PTY, and kept complete enough that the
// pre-fix composer still loads: proving these tests fail on the old code is the
// point, and a mock that only breaks its imports would prove nothing.
vi.mock("../../src/components/terminal/terminalCache", () => ({
  enqueueSessionWrite: mocks.enqueueSessionWrite,
  chunkedWrite: mocks.chunkedWrite,
  registerTerminalCacheEvictionCleanup: () => () => {},
}));
vi.mock("../../src/lib/focusController", () => ({
  focusController: { focusSessionSoon: mocks.focusSessionSoon },
}));
vi.mock("../../src/stores/toastStore", () => ({
  useToastStore: { getState: () => ({ pushToast: mocks.pushToast }) },
}));

const SESSION = "session-1";
const CLAUDE_TARGET = { command: "claude", agentKind: "claude" };
const SHELL_TARGET = { command: "bash" };

let container: HTMLDivElement;
let root: Root;

function render(target: { command: string; agentKind?: string } = CLAUDE_TARGET) {
  act(() => {
    root.render(<PaneComposer sessionId={SESSION} target={target} />);
  });
}

function textarea(): HTMLTextAreaElement {
  const element = container.querySelector("textarea");
  if (!element) throw new Error("composer textarea not rendered");
  return element;
}

function type(text: string) {
  act(() => {
    useComposerStore.getState().setDraft(SESSION, text);
  });
}

function pressEnter() {
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handleSocketCommand.mockResolvedValue({ ok: true, confirmed: true });
  useComposerStore.setState({ draftBySession: {} });
  resetSessionDraft(SESSION);
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("pane composer send", () => {
  it("hands the body to pane.send_text and lets it own the submit key", async () => {
    // The raw route wrote the body and the CR into the shared input queue, which
    // batches whatever is pending into one PTY write. With another write already
    // in flight the agent read the paste and the Enter together, submitted before
    // its input line had caught up, and the message vanished (2026-09-02).
    type("こんにちは");
    pressEnter();

    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(1);
    expect(mocks.handleSocketCommand).toHaveBeenCalledWith("pane.send_text", {
      sessionId: SESSION,
      text: "\x1b[200~こんにちは\x1b[201~",
      enter: true,
      // A re-pressed Enter is a rescue for an agent nobody is watching. Here the
      // operator is watching, and a stray CR answers whatever the pane asks next.
      retrySubmit: false,
    });
    // Nothing may reach the PTY queue directly: that is the path that merges.
    expect(mocks.chunkedWrite).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionWrite).not.toHaveBeenCalled();
  });

  it("moves a shell's pending input line through the same route as the send", async () => {
    // The erase and the message that follows it must not race. pane.send_text
    // serialises per session; the terminal input queue is a separate lane, so
    // adopting through one and sending through the other could let the message
    // land first and then be eaten by its own backspaces.
    act(() => observeSessionInput(SESSION, "ls -la"));
    render(SHELL_TARGET);
    act(() => textarea().focus());

    expect(mocks.enqueueSessionWrite).not.toHaveBeenCalled();
    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(1);
    const [command, args] = mocks.handleSocketCommand.mock.calls[0];
    expect(command).toBe("pane.send_text");
    expect(args).not.toHaveProperty("enter");
    expect(args.sessionId).toBe(SESSION);
    expect(args.text).toBe("\x7f".repeat("ls -la".length));
    await act(async () => { await Promise.resolve(); });
    expect(useComposerStore.getState().draftBySession[SESSION]).toBe("ls -la");
  });

  it("leaves the pending line where it is when the erase fails", async () => {
    // Moving the text first and erasing in the background puts the same line in
    // the pane and in the editor, and the next send submits it twice.
    mocks.handleSocketCommand.mockRejectedValue(new Error("PTY_INPUT_BACKPRESSURE"));
    act(() => observeSessionInput(SESSION, "git status"));
    render(SHELL_TARGET);
    act(() => textarea().focus());
    await act(async () => { await Promise.resolve(); });

    expect(useComposerStore.getState().draftBySession[SESSION]).toBeUndefined();
    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.stringContaining("PTY_INPUT_BACKPRESSURE"),
      "error",
    );
  });

  it("holds focus until the message is committed", async () => {
    // Focus handed back early reopens the bug in a narrower window: keystrokes
    // ride the terminal's own queue and land between the body and the submit key.
    let resolve: ((outcome: unknown) => void) | undefined;
    mocks.handleSocketCommand.mockReturnValue(new Promise((resolveFn) => { resolve = resolveFn; }));
    type("焦って戻さない");
    pressEnter();

    expect(mocks.focusSessionSoon).not.toHaveBeenCalled();
    await act(async () => {
      resolve?.({ ok: true, confirmed: true });
      await Promise.resolve();
    });
    expect(mocks.focusSessionSoon).toHaveBeenCalledWith(SESSION);
  });

  it("does not take focus back from someone already typing the next message", async () => {
    // Waiting for the send and then grabbing focus is worse than never grabbing
    // it: the message being typed is cut in half, the first part left in the
    // editor and the rest delivered straight to the PTY.
    let resolve: ((outcome: unknown) => void) | undefined;
    mocks.handleSocketCommand.mockReturnValue(new Promise((resolveFn) => { resolve = resolveFn; }));
    type("一通目");
    pressEnter();
    type("二通目を書き始めた");
    await act(async () => {
      resolve?.({ ok: true, confirmed: true });
      await Promise.resolve();
    });

    expect(mocks.focusSessionSoon).not.toHaveBeenCalled();
    expect(useComposerStore.getState().draftBySession[SESSION]).toBe("二通目を書き始めた");
  });

  it("does not fire a second erase while the first is still in flight", async () => {
    // The mirror is cleared only when the erase lands, so a blur/focus inside
    // that window would read the same pending line again and send another run
    // of backspaces -- deleting the characters the first run uncovered.
    let resolve: ((outcome: unknown) => void) | undefined;
    mocks.handleSocketCommand.mockReturnValue(new Promise((resolveFn) => { resolve = resolveFn; }));
    act(() => observeSessionInput(SESSION, "ls -la"));
    render(SHELL_TARGET);
    act(() => textarea().focus());
    act(() => textarea().blur());
    act(() => textarea().focus());

    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve?.({ unverified: true });
      await Promise.resolve();
    });
    expect(useComposerStore.getState().draftBySession[SESSION]).toBe("ls -la");
  });

  it("keeps the pane's line ahead of whatever was typed while the erase flew", async () => {
    let resolve: ((outcome: unknown) => void) | undefined;
    mocks.handleSocketCommand.mockReturnValue(new Promise((resolveFn) => { resolve = resolveFn; }));
    act(() => observeSessionInput(SESSION, "ls -la"));
    render(SHELL_TARGET);
    act(() => textarea().focus());
    type("x");
    await act(async () => {
      resolve?.({ unverified: true });
      await Promise.resolve();
    });

    expect(useComposerStore.getState().draftBySession[SESSION]).toBe("ls -lax");
  });

  it("says so when the pane could not confirm the submit", async () => {
    // pane.send_text resolves ok:false for an unmounted or unreadable pane.
    // Treating that as success is the silence this change exists to remove.
    mocks.handleSocketCommand.mockResolvedValue({ ok: false, confirmed: false, reason: "target_unmounted" });
    type("確認できない送信");
    pressEnter();
    await act(async () => { await Promise.resolve(); });

    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.stringContaining("target_unmounted"),
      "warning",
    );
    // Unconfirmed is not failed: the bytes went out, so the editor stays empty.
    expect(useComposerStore.getState().draftBySession[SESSION]).toBeUndefined();
  });

  it("clears the editor immediately rather than waiting for the pane", () => {
    type("すぐ消える");
    pressEnter();

    expect(useComposerStore.getState().draftBySession[SESSION]).toBeUndefined();
    expect(textarea().value).toBe("");
  });

  it("puts the text back when the send never reached the pane", async () => {
    mocks.handleSocketCommand.mockRejectedValue(new Error("session is not a known pane"));
    type("届かなかった文");
    pressEnter();
    await act(async () => { await Promise.resolve(); });

    expect(useComposerStore.getState().draftBySession[SESSION]).toBe("届かなかった文");
    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.stringContaining("session is not a known pane"),
      "error",
    );
  });

  it("keeps text typed while the failed send was in flight", async () => {
    let reject: ((error: Error) => void) | undefined;
    mocks.handleSocketCommand.mockReturnValue(new Promise((_, rejectFn) => { reject = rejectFn; }));
    type("先に出した文");
    pressEnter();
    type("あとから打った文");
    await act(async () => {
      reject?.(new Error("write failed"));
      await Promise.resolve();
    });

    expect(useComposerStore.getState().draftBySession[SESSION]).toBe("先に出した文\nあとから打った文");
  });

  it("does not send an Enter of its own when the draft is empty", () => {
    pressEnter();
    // Both lanes, so this still means something if the composer ever goes back
    // to writing into the terminal queue directly.
    expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    expect(mocks.chunkedWrite).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionWrite).not.toHaveBeenCalled();
  });
});

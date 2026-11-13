// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ isDirectory: vi.fn(), write: vi.fn() }));
vi.mock("../../src/lib/ipc", () => ({ isDirectory: mocks.isDirectory, writeToSession: mocks.write }));
import { handleTerminalPathDrop } from "../../src/components/terminal/terminalPathDrop";
import { useComposerStore } from "../../src/stores/composerStore";

let pane: HTMLDivElement, target: HTMLSpanElement;
beforeEach(() => {
  mocks.isDirectory.mockReset(); mocks.isDirectory.mockResolvedValue(false);
  mocks.write.mockReset(); mocks.write.mockResolvedValue(undefined);
  useComposerStore.setState({ draftBySession: {} });
  pane = document.createElement("div"); pane.dataset.sessionId = "drop-session";
  target = document.createElement("span"); pane.append(target); document.body.append(pane);
});
afterEach(() => pane.remove());
function conversation() {
  const panel = document.createElement("div");
  panel.className = "terminal-transcript-panel--tab";
  panel.dataset.terminalTranscriptSession = "drop-session";
  pane.append(panel); panel.append(target);
}
describe("C1a-B08 native file drops", () => {
  it.each(["", "draft", "draft ", "draft\n"])("appends quoted paths to the visible conversation draft after %j", async draft => {
    conversation();
    useComposerStore.getState().setDraft("drop-session", draft);
    const paths = ["C:\\folder name\\資料.txt", "D:\\second.txt"];
    await handleTerminalPathDrop(paths, target);
    const separator = draft && !/\s$/.test(draft) ? " " : "";
    expect.soft(useComposerStore.getState().draftBySession["drop-session"])
      .toBe(draft + separator + '"C:/folder name/資料.txt" "D:/second.txt" ');
    expect.soft(mocks.write).not.toHaveBeenCalled();
    expect(mocks.isDirectory).not.toHaveBeenCalled();
  });
  it("adds a directory as a draft path without cd, Enter, or a directory probe", async () => {
    conversation(); mocks.isDirectory.mockResolvedValue(true);
    await handleTerminalPathDrop(["C:\\folder name"], target);
    expect.soft(useComposerStore.getState().draftBySession["drop-session"]).toBe('"C:/folder name" ');
    expect.soft(mocks.write).not.toHaveBeenCalled();
    expect(mocks.isDirectory).not.toHaveBeenCalled();
  });
  it("also routes a drop on the conversation pane's surrounding space into its draft", async () => {
    conversation();
    await handleTerminalPathDrop(["C:\\file.txt"], pane);
    expect.soft(useComposerStore.getState().draftBySession["drop-session"]).toBe('"C:/file.txt" ');
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("preserves terminal file path quoting and spacing under a fallback or terminal view", async () => {
    await handleTerminalPathDrop(["C:\\file one.txt", "D:\\file two.txt"], target);
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith("drop-session", '"C:/file one.txt" "D:/file two.txt" ');
    expect(useComposerStore.getState().draftBySession).toEqual({});
  });
  it("preserves terminal directory navigation and its Enter", async () => {
    mocks.isDirectory.mockResolvedValue(true);
    await handleTerminalPathDrop(["C:\\folder name"], target);
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith("drop-session", 'cd "C:/folder name"\r');
  });
  it("keeps the terminal file fallback if the directory check fails", async () => {
    mocks.isDirectory.mockRejectedValue(new Error("fixture unreadable"));
    await handleTerminalPathDrop(["C:\\file.txt"], target);
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith("drop-session", '"C:/file.txt" ');
  });
  it("ignores drops without a pane and empty drops", async () => {
    await handleTerminalPathDrop(["C:\\file.txt"], document.body);
    await handleTerminalPathDrop([], target);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.isDirectory).not.toHaveBeenCalled();
  });
});

describe("RB-01 rechecks native drops after the directory probe", () => {
  function deferredDirectory() {
    let resolve!: (directory: boolean) => void;
    mocks.isDirectory.mockReturnValue(new Promise<boolean>(done => { resolve = done; }));
    return (directory: boolean) => resolve(directory);
  }

  it.each([true, false])("routes a pending drop to the conversation draft when the probe returns %s", async directory => {
    const resolve = deferredDirectory();
    useComposerStore.getState().setDraft("drop-session", "draft");
    const pending = handleTerminalPathDrop(["C:\\folder name"], target);
    conversation();
    resolve(directory);
    await pending;
    expect.soft(mocks.write).not.toHaveBeenCalled();
    expect(useComposerStore.getState().draftBySession["drop-session"]).toBe('draft "C:/folder name" ');
  });

  it.each([true, false])("cancels a pending drop when the pane is removed and the probe returns %s", async directory => {
    const resolve = deferredDirectory();
    useComposerStore.getState().setDraft("drop-session", "keep");
    const pending = handleTerminalPathDrop(["C:\\folder name"], target);
    pane.remove();
    resolve(directory);
    await pending;
    expect.soft(mocks.write).not.toHaveBeenCalled();
    expect(useComposerStore.getState().draftBySession).toEqual({ "drop-session": "keep" });
  });

  it.each([true, false])("cancels a pending drop when the pane changes session and the probe returns %s", async directory => {
    const resolve = deferredDirectory();
    useComposerStore.getState().setDraft("drop-session", "keep");
    const pending = handleTerminalPathDrop(["C:\\folder name"], target);
    pane.dataset.sessionId = "replacement-session";
    conversation();
    resolve(directory);
    await pending;
    expect.soft(mocks.write).not.toHaveBeenCalled();
    expect(useComposerStore.getState().draftBySession).toEqual({ "drop-session": "keep" });
  });

  it.each([true, false])("preserves a pending terminal drop when the pane is unchanged and the probe returns %s", async directory => {
    const resolve = deferredDirectory();
    const pending = handleTerminalPathDrop(["C:\\folder name"], target);
    resolve(directory);
    await pending;
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
      "drop-session",
      directory ? 'cd "C:/folder name"\r' : '"C:/folder name" ',
    );
    expect(useComposerStore.getState().draftBySession).toEqual({});
  });
});


describe("P1-0912-003 cancels drops after their retained pane becomes hidden", () => {
  let host: HTMLDivElement;
  afterEach(() => host?.remove());

  function retainedPair() {
    host = document.createElement("div");
    const other = document.createElement("div");
    pane.dataset.retainedTerminal = "drop-session";
    pane.setAttribute("aria-hidden", "false");
    pane.style.visibility = "inherit";
    other.dataset.sessionId = "other-session";
    other.dataset.retainedTerminal = "other-session";
    other.setAttribute("aria-hidden", "true");
    other.style.visibility = "hidden";
    host.append(pane, other);
    document.body.append(host);
    useComposerStore.getState().setDraft("drop-session", "keep-A");
    useComposerStore.getState().setDraft("other-session", "keep-B");
    return other;
  }

  function pendingDrop() {
    let resolve!: (directory: boolean) => void;
    mocks.isDirectory.mockReturnValue(new Promise<boolean>(done => { resolve = done; }));
    const pending = handleTerminalPathDrop(["C:\\folder name"], target);
    return { pending, resolve };
  }

  function expectNoChange() {
    expect.soft(mocks.write).not.toHaveBeenCalled();
    expect(useComposerStore.getState().draftBySession).toEqual({
      "drop-session": "keep-A", "other-session": "keep-B",
    });
  }

  it.each([true, false])("cancels A after switching the retained tab to B (directory=%s)", async directory => {
    const other = retainedPair();
    const { pending, resolve } = pendingDrop();
    pane.setAttribute("aria-hidden", "true");
    pane.style.visibility = "hidden";
    other.setAttribute("aria-hidden", "false");
    other.style.visibility = "inherit";
    resolve(directory);
    await pending;
    expectNoChange();
  });

  for (const scope of ["pane", "ancestor"] as const) {
    for (const attribute of ["hidden", "aria-hidden", "inert"] as const) {
      const hide = () => (scope === "pane" ? pane : host)
        .setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");

      it.each([true, false])("cancels when the " + scope + " gains " + attribute + " (directory=%s)", async directory => {
        retainedPair();
        const { pending, resolve } = pendingDrop();
        hide();
        resolve(directory);
        await pending;
        expectNoChange();
      });

      it("ignores an already hidden conversation when the " + scope + " has " + attribute, async () => {
        retainedPair();
        conversation();
        hide();
        await handleTerminalPathDrop(["C:\\folder name"], target);
        expectNoChange();
        expect(mocks.isDirectory).not.toHaveBeenCalled();
      });
    }
  }

  for (const state of ["workspace switch", "another pane zoom", "main dashboard"]) {
    it.each([true, false])("cancels CSS-hidden ancestors after " + state + " (directory=%s)", async directory => {
      retainedPair();
      const checkVisibility = vi.fn(() => host.style.visibility !== "hidden");
      Object.defineProperty(pane, "checkVisibility", { configurable: true, value: checkVisibility });
      const { pending, resolve } = pendingDrop();
      host.style.visibility = "hidden";
      resolve(directory);
      await pending;
      expectNoChange();
      expect(checkVisibility).toHaveBeenCalledWith({ visibilityProperty: true });
      expect(checkVisibility).toHaveBeenCalledTimes(2);
    });
  }

  it.each([true, false])("cancels when native checkVisibility turns false (directory=%s)", async directory => {
    retainedPair();
    const checkVisibility = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    Object.defineProperty(pane, "checkVisibility", { configurable: true, value: checkVisibility });
    const { pending, resolve } = pendingDrop();
    resolve(directory);
    await pending;
    expectNoChange();
    expect(checkVisibility).toHaveBeenLastCalledWith({ visibilityProperty: true });
  });

  it("does not probe or change a draft when native checkVisibility is initially false", async () => {
    retainedPair();
    conversation();
    Object.defineProperty(pane, "checkVisibility", { configurable: true, value: vi.fn(() => false) });
    await handleTerminalPathDrop(["C:\\folder name"], target);
    expectNoChange();
    expect(mocks.isDirectory).not.toHaveBeenCalled();
  });

  it.each([true, false])("cancels when tear-out recreates the same session in another container (directory=%s)", async directory => {
    retainedPair();
    const { pending, resolve } = pendingDrop();
    const replacement = document.createElement("div");
    replacement.dataset.sessionId = "drop-session";
    replacement.dataset.retainedTerminal = "drop-session";
    replacement.setAttribute("aria-hidden", "false");
    host.append(replacement);
    pane.remove();
    resolve(directory);
    await pending;
    expectNoChange();
  });

  it.each([true, false])("preserves visible native panes (directory=%s)", async directory => {
    retainedPair();
    const checkVisibility = vi.fn(() => true);
    Object.defineProperty(pane, "checkVisibility", { configurable: true, value: checkVisibility });
    const { pending, resolve } = pendingDrop();
    resolve(directory);
    await pending;
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
      "drop-session", directory ? 'cd "C:/folder name"\r' : '"C:/folder name" ',
    );
    expect(useComposerStore.getState().draftBySession).toEqual({
      "drop-session": "keep-A", "other-session": "keep-B",
    });
    expect(checkVisibility).toHaveBeenCalledTimes(2);
  });
});

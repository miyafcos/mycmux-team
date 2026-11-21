// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn(), cancel: vi.fn(), send: vi.fn(), focus: vi.fn(), toast: vi.fn() }));
vi.mock("../../src/lib/presendReadingClient", () => ({ requestPresendReading: mocks.request, cancelPresendReading: mocks.cancel }));
vi.mock("../../src/components/layout/socketCommands", () => ({ handleSocketCommand: mocks.send }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ evictTerminalCache: vi.fn() }));
vi.mock("../../src/lib/focusController", () => ({ focusController: { focusSessionSoon: mocks.focus } }));
vi.mock("../../src/stores/toastStore", () => ({ useToastStore: { getState: () => ({ pushToast: mocks.toast }) } }));

import { PaneComposer } from "../../src/components/composer/PaneComposer";
import type { WorkspaceConfig } from "../../src/lib/ipc";
import * as ipc from "../../src/lib/ipc";
import { applyPtyMetadata } from "../../src/lib/liveAgentMetadata";
import { presendDraftFingerprint, presendTab, setPresendTabEnabled } from "../../src/lib/presendReading";
import { closeWorkspaceAfterConfirmation } from "../../src/lib/workspaceClose";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useComposerStore } from "../../src/stores/composerStore";
import { useSettingsStore } from "../../src/stores/settingsStore";

const reading = { reading: "test reading", assumption: "local work", missing: "target folder", elapsedMs: 30, provider: "claude" as const };
const draft = "abcdefghijklmnop";
let host: HTMLDivElement;
let root: Root;
let session: string;
let sequence = 0;
function render(id = session, command = "claude") { act(() => root.render(<PaneComposer sessionId={id} target={{ command }} />)); }
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field(), text);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function field() { return host.querySelector<HTMLTextAreaElement>("textarea")!; }
function rows() { return [...host.querySelectorAll<HTMLElement>(".cmux-presend-row")]; }
async function wait(ms = 1500) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.request.mockResolvedValue(reading);
  mocks.send.mockResolvedValue({ confirmed: true });
  useAiSettingsStore.setState({ aiEnabled: true });
  useComposerStore.setState({ draftBySession: {} });
  useSettingsStore.setState({ presendReadingEnabled: true, paneComposerEnabled: true, presendReadingProvider: "claude" });
  session = `presend-ui-${++sequence}`;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  render();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useSettingsStore.setState({ presendReadingEnabled: false });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PaneComposer pre-send reading", () => {
  it("keeps the original two child rows and no frame when off", async () => {
    act(() => useSettingsStore.setState({ presendReadingEnabled: false }));
    expect(host.querySelector(".cmux-presend-frame")).toBeNull();
    expect(host.querySelector(".cmux-composer-root")?.children).toHaveLength(2);
    type(draft);
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("does not create pre-send state for a tab opened while off", async () => {
    act(() => useSettingsStore.setState({ presendReadingEnabled: false }));
    const offSession = `${session}-off`;
    render(offSession);
    type(draft);
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(presendTab(offSession)).toBeUndefined();
  });

  it("keeps the shared draft and drops the reading across a display-only reattach", async () => {
    type(draft);
    await wait();
    expect(host.textContent).toContain(reading.reading);
    act(() => root.render(null));
    expect(useComposerStore.getState().draftBySession[session]).toBe(draft);
    render();
    expect(field().value).toBe(draft);
    expect(host.textContent).not.toContain(reading.reading);
    await wait();
    expect(mocks.request).toHaveBeenCalledOnce();
  });

  it("waits for a local edit before reading a draft present on mount", async () => {
    act(() => root.render(null));
    useComposerStore.getState().setDraft(session, draft);
    render();
    expect(field().value).toBe(draft);
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
    type(draft + "x");
    await wait();
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      expect.any(String), session, draft + "x", "claude", expect.any(Function),
    );
  });

  it("does not read a late store writeback in a new input field", async () => {
    act(() => useComposerStore.getState().setDraft(session, draft));
    expect(field().value).toBe(draft);
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
    type(draft + "x");
    await wait();
    expect(mocks.request).toHaveBeenCalledOnce();
  });

  it("requires another local edit after switching away from an unattempted draft", async () => {
    type(draft);
    render(`${session}-other`);
    await wait();
    render();
    expect(field().value).toBe(draft);
    expect(host.textContent).not.toContain(reading.reading);
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
    type(draft + "x");
    await wait();
    expect(mocks.request).toHaveBeenCalledOnce();
  });

  it("does not read the old draft after a workspace closes and restores the same PTY ID", async () => {
    const id = `pty-${session}-restored`;
    const config: WorkspaceConfig = {
      id: `workspace-${session}`, name: "Synthetic workspace", grid_template_id: "1x1", created_at: 1,
      panes: [{
        pane_id: "toy-pane", agent_id: "shell-starter", label: null,
        tabs: [{ tab_id: "toy-tab", session_id: id, agent_id: "shell-starter", type: "terminal" }],
      }],
    };
    const kill = vi.spyOn(ipc, "killSession").mockResolvedValue(undefined);
    const removeScrollback = vi.spyOn(ipc, "removeWorkspaceScrollback").mockResolvedValue(undefined);
    const previous = useWorkspaceListStore.getState();
    try {
      restoreWorkspaceConfigs([config]);
      setPresendTabEnabled(id, false);
      render(id);
      type(draft);
      await wait();
      expect(mocks.request).not.toHaveBeenCalled();
      act(() => root.render(null));
      expect((await closeWorkspaceAfterConfirmation(config.id)).killedSessionIds).toEqual([id]);
      expect(kill).toHaveBeenCalledWith(id);
      expect(presendTab(id)).toBeUndefined();
      restoreWorkspaceConfigs([config]);
      const restored = useWorkspaceListStore.getState().getWorkspace(config.id)!.panes[0].tabs[0].sessionId;
      expect(restored).toBe(id);
      render(restored);
      expect(field().value).toBe(draft);
      await wait();
      expect(mocks.request).not.toHaveBeenCalled();
      type(draft + "x");
      await wait();
      expect(mocks.request).toHaveBeenCalledOnce();
    } finally {
      useWorkspaceListStore.setState(previous);
      kill.mockRestore();
      removeScrollback.mockRestore();
    }
  });

  it("deduplicates attempts without holding the original draft", async () => {
    type(draft);
    await wait();
    const attempted = presendTab(session)?.attempted;
    expect(attempted?.size).toBe(1);
    expect([...attempted!]).not.toContain(draft);
  });

  it("hides a stale result even if the next draft matches the stored attempt fingerprint", async () => {
    type(draft);
    await wait();
    expect(host.textContent).toContain(reading.reading);
    const nextDraft = "A different draft for the same tab";
    const attempted = presendTab(session)!.attempted;
    // Simulate a collision in the stored fingerprint of the completed attempt.
    attempted.clear();
    attempted.add(presendDraftFingerprint(nextDraft));
    type(nextDraft);
    expect(host.textContent).not.toContain(reading.reading);
    await wait();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain(reading.reading);
  });

  it("discards an in-flight result when the tab is retired", async () => {
    let complete!: (result: typeof reading) => void;
    mocks.request.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    type(draft);
    await wait();
    expect(mocks.request).toHaveBeenCalledOnce();
    act(() => usePaneMetadataStore.getState().removeMetadata(session));
    await act(async () => { complete(reading); });
    expect(host.textContent).not.toContain("test reading");
    expect(presendTab(session)).toBeUndefined();
  });

  it("reserves exactly the same four fixed tracks before and after a result", async () => {
    const before = host.querySelector(".cmux-presend-frame")!;
    expect(before.children).toHaveLength(4);
    const css = readFileSync(resolve(import.meta.dirname, "../../src/components/composer/composer.css"), "utf8");
    const rule = css.match(/\.cmux-presend-frame\s*\{([^}]*)\}/)![1];
    expect(rule).toMatch(/height:\s*100px/);
    expect(rule).toMatch(/grid-template-rows:\s*28px repeat\(3, 20px\)/);
    type(draft);
    await wait();
    const after = host.querySelector(".cmux-presend-frame")!;
    expect(after).toBe(before);
    expect(after.children).toHaveLength(4);
    expect(after.className).toBe("cmux-presend-frame");
    expect(rows()[0].tagName).toBe("DIV");
    expect(after.textContent).toContain("test reading");
  });
  it("waits 1500ms and only reads the same text once", async () => {
    type(draft);
    await wait(1499);
    expect(mocks.request).not.toHaveBeenCalled();
    await wait(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    type("a different long draft");
    type(draft);
    await wait(2500);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("does not change focus or selection when the reading arrives", async () => {
    type(draft);
    act(() => { field().focus(); field().setSelectionRange(4, 7); });
    await wait();
    expect(document.activeElement).toBe(field());
    expect([field().selectionStart, field().selectionEnd]).toEqual([4, 7]);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(["assumption", "missing"] as const)("appends %s visibly without sending, then places the caret after it", async kind => {
    type(draft);
    await wait();
    act(() => rows()[kind === "assumption" ? 1 : 2].click());
    const expected = kind === "assumption" ? `${draft}\n\u524d\u63d0: local work` : `${draft}\ntarget folder: `;
    expect(field().value).toBe(expected);
    expect(field().selectionStart).toBe(expected.length);
    expect(document.activeElement).toBe(field());
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("keeps none rows dim and unclickable", async () => {
    mocks.request.mockResolvedValue({ ...reading, assumption: "\u306a\u3057", missing: "\u306a\u3057" });
    type(draft);
    await wait();
    for (const row of rows().slice(1)) {
      expect(row.className).toContain("is-none");
      expect((row as HTMLButtonElement).disabled).toBe(true);
    }
  });
  it("restarts the quiet period after IME commit", async () => {
    type(draft);
    act(() => field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await wait(3000);
    expect(mocks.request).not.toHaveBeenCalled();
    act(() => field().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await wait(1499);
    expect(mocks.request).not.toHaveBeenCalled();
    await wait(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("stops reading when a Codex launch returns to PowerShell", async () => {
    const target = { command: "powershell.exe", agentId: "codex" };
    act(() => root.render(<PaneComposer sessionId={session} target={target} />));
    act(() => applyPtyMetadata({
      session_id: session, cwd: "", process_name: "powershell.exe",
      agent_active: true, live_agent_kind: "codex",
    }));
    type(draft);
    await wait();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(host.textContent).toContain(reading.reading);

    act(() => applyPtyMetadata({
      session_id: session, cwd: "", process_name: "powershell.exe",
      agent_active: false, live_agent_kind: null,
    }));
    type(`${draft} in the shell`);
    await wait();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain(reading.reading);
  });

  it("requires a new edit when the monitor observes Codex after the shell", async () => {
    const target = { command: "powershell.exe", agentId: "codex" };
    act(() => root.render(<PaneComposer sessionId={session} target={target} />));
    const observeCodex = (active: boolean) => act(() => applyPtyMetadata({
      session_id: session, cwd: "", process_name: "powershell.exe",
      agent_active: active, live_agent_kind: active ? "codex" : null,
    }));

    observeCodex(false);
    type(draft);
    await wait(1600);
    expect(mocks.request).not.toHaveBeenCalled();
    observeCodex(true);
    expect(field().value).toBe(draft);
    await wait(1600);
    expect(mocks.request).not.toHaveBeenCalled();

    const editedDraft = draft + "x";
    type(editedDraft);
    await wait(1499);
    expect(mocks.request).not.toHaveBeenCalled();
    await wait(1);
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      expect.any(String), session, editedDraft, "claude", expect.any(Function),
    );
    expect(host.textContent).toContain(reading.reading);

    observeCodex(false);
    observeCodex(true);
    expect(field().value).toBe(editedDraft);
    await wait(1600);
    expect(mocks.request).toHaveBeenCalledOnce();
    type(editedDraft + "y");
    await wait();
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("does not infer an agent from a shell argument after observing the shell", async () => {
    const target = { command: "powershell.exe", args: ["/sample/codex"] };
    act(() => root.render(<PaneComposer sessionId={session} target={target} />));
    act(() => applyPtyMetadata({
      session_id: session, cwd: "", process_name: "powershell.exe",
      agent_active: false, live_agent_kind: null,
    }));
    type(draft);
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("suppresses reading for a shell argument ending in cursor-agent when the monitor reports no agent", async () => {
    const target = { command: "powershell.exe", args: ["-NoExit", "-Command", "cd C:/work/cursor-agent"] };
    act(() => root.render(<PaneComposer sessionId={session} target={target} />));
    act(() => applyPtyMetadata({
      session_id: session, cwd: "", process_name: "powershell.exe",
      agent_active: false, live_agent_kind: null,
    }));
    type(draft);
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("suppresses reading for a Cursor launcher when the monitor reports no agent", async () => {
    const target = { command: "powershell.exe", launchEnv: { MYCMUX_LAUNCH_TARGET: "cursor" } };
    act(() => root.render(<PaneComposer sessionId={session} target={target} />));
    act(() => applyPtyMetadata({
      session_id: session, cwd: "", process_name: "powershell.exe",
      agent_active: false, live_agent_kind: null,
    }));
    type(draft);
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("suppresses reading for a shell command with an inherited Cursor launch target when the monitor reports no agent", async () => {
    const target = {
      command: "powershell.exe",
      args: ["-NoExit", "-NoLogo"],
      launchEnv: { MYCMUX_LAUNCH_TARGET: "cursor" },
    };
    act(() => root.render(<PaneComposer sessionId={session} target={target} />));
    act(() => applyPtyMetadata({
      session_id: session, cwd: "", process_name: "powershell.exe",
      agent_active: false, live_agent_kind: null,
    }));
    type(draft);
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("suppresses reading for an unresolved launch when the monitor reports no agent", async () => {
    const target = { command: "toy-wrapper", agentKind: "toy-unknown", processTitle: "codex" };
    act(() => root.render(<PaneComposer sessionId={session} target={target} />));
    act(() => applyPtyMetadata({
      session_id: session, cwd: "", process_name: "toy-wrapper",
      agent_active: false, live_agent_kind: null,
    }));
    type(draft);
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("keeps reading for a Codex launch while the foreground is unknown", async () => {
    const target = { command: "powershell.exe", agentId: "codex" };
    act(() => root.render(<PaneComposer sessionId={session} target={target} />));
    act(() => applyPtyMetadata({ session_id: session, cwd: "", agent_active: false, live_agent_kind: null }));
    type(draft);
    await wait();
    expect(mocks.request).toHaveBeenCalledOnce();
  });

  it("does not read a shell, and remembers pause per tab only in memory", async () => {
    render(session, "bash");
    type(draft);
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
    render();
    act(() => host.querySelector<HTMLButtonElement>(".cmux-presend-toggle")!.click());
    type(draft + "x");
    await wait();
    expect(mocks.request).not.toHaveBeenCalled();
    render(`${session}-other`);
    type(draft);
    await wait();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    render();
    expect(host.querySelector(".cmux-presend-toggle")?.getAttribute("aria-pressed")).toBe("false");
  });
  it.each(["change", "clear", "switch", "off", "send"])("discards an in-flight result after %s", async action => {
    let resolve: ((value: typeof reading) => void) | undefined;
    mocks.request.mockReturnValue(new Promise(done => { resolve = done; }));
    type(draft);
    await wait();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    if (action === "change") type("changed long draft");
    if (action === "clear") type("");
    if (action === "switch") render(`${session}-other`);
    if (action === "off") act(() => useSettingsStore.setState({ presendReadingEnabled: false }));
    if (action === "send") act(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => { resolve?.(reading); await Promise.resolve(); });
    expect(host.textContent).not.toContain("test reading");
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(action === "send" ? 1 : 0);
  });
  it("leaves Enter, Shift+Enter, and Esc semantics intact", async () => {
    type(draft);
    await wait();
    act(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })));
    expect(mocks.send).not.toHaveBeenCalled();
    act(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(mocks.focus).toHaveBeenCalledWith(session);
    act(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(mocks.send).toHaveBeenCalledWith("pane.send_text", { sessionId: session, text: `\x1b[200~${draft}\x1b[201~`, enter: true });
  });
  it("never submits an IME composition Enter", async () => {
    type(draft);
    act(() => field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    act(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    expect(mocks.send).not.toHaveBeenCalled();
    expect(field().value).toBe(draft);
  });
  it("shows no toast and never retries a failed reading", async () => {
    mocks.request.mockRejectedValue(new Error("dummy provider failure"));
    type(draft);
    await wait();
    await wait(5000);
    type(draft + " edited");
    await wait(1499);
    type(draft);
    await wait(5000);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(host.querySelector(".cmux-presend-frame")?.children).toHaveLength(4);
  });
});

describe("pre-send cancellation and the global AI gate", () => {
  it("hides the frame and emits no request while global AI is OFF", async () => {
    act(() => useAiSettingsStore.getState().setAiEnabled(false));
    type(draft);
    await wait(3000);
    expect(host.querySelector(".cmux-presend-frame")).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("can request the same text again after an unfinished request was canceled", async () => {
    let finish!: (value: typeof reading) => void;
    mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    type(draft); await wait();
    type(draft + "x"); type(draft);
    await act(async () => finish(reading));
    await wait();
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
  it("does not count a dropped request as an attempt", async () => {
    mocks.request.mockResolvedValueOnce(null);
    type(draft);
    await wait();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(presendTab(session)?.attempted.has(presendDraftFingerprint(draft))).toBe(false);
    type(draft + "x");
    type(draft);
    await wait();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(reading.reading);
  });
  it("re-arms an early callback for the remaining quiet time", async () => {
    const clock = vi.spyOn(Date, "now");
    const start = Date.now();
    clock.mockReturnValue(start);
    type(draft);
    clock.mockReturnValue(start + 1400);
    await wait(1500);
    expect(mocks.request).not.toHaveBeenCalled();
    clock.mockReturnValue(start + 1500);
    await wait(100);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    clock.mockRestore();
  });
});

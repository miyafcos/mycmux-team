// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evictTerminalCache } from "../../src/components/terminal/terminalCache";
import { __turnListPromptCacheForTests } from "../../src/components/terminal/XTermWrapper";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  turnMarks: [] as Array<{ line: number; label: string; at: number }>,
  bufferType: "alternate" as "normal" | "alternate",
  bufferLines: [] as string[],
  transcriptResponses: [] as Array<Array<{ text: string; occurredAt: number }>>,
  stallWrites: false,
  writeCallbacks: [] as Array<() => void>,
  terminalInstances: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    scrollToLine: ReturnType<typeof vi.fn>;
    keyHandler?: (event: KeyboardEvent) => boolean;
    write: ReturnType<typeof vi.fn>;
    renderListeners: Set<(event: { start: number; end: number }) => void>;
  }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage?: (message: T) => void;
  },
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(() => Promise.resolve()) }));

vi.mock("@xterm/xterm", () => {
  const disposable = () => ({ dispose: vi.fn() });
  class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    element: HTMLElement | undefined;
    textarea: HTMLTextAreaElement | undefined;
    unicode = { activeVersion: "" };
    parser = { registerOscHandler: vi.fn(() => disposable()) };
    buffer = {
      active: {
        get type(): "normal" | "alternate" { return mocks.bufferType; },
        get length(): number { return Math.max(24, mocks.bufferLines.length); },
        baseY: 0,
        cursorY: 0,
        viewportY: 0,
        getLine: (index: number) => {
          const text = mocks.bufferLines[index];
          return text === undefined
            ? undefined
            : { isWrapped: false, translateToString: () => text };
        },
      },
    };
    dispose = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      mocks.terminalInstances.push(this);
    }

    loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }): void {
      addon.activate?.(this);
    }

    open(container: HTMLElement): void {
      this.element = document.createElement("div");
      this.textarea = document.createElement("textarea");
      this.textarea.className = "xterm-helper-textarea";
      this.element.appendChild(this.textarea);
      container.appendChild(this.element);
    }

    keyHandler?: (event: KeyboardEvent) => boolean;
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void { this.keyHandler = handler; }
    focus(): void { this.textarea?.focus(); }
    refresh(): void {}
    reset(): void {}
    scrollToBottom = vi.fn();
    scrollToLine = vi.fn();
    write = vi.fn((_data: string | Uint8Array, callback?: () => void): void => {
      if (callback && mocks.stallWrites) mocks.writeCallbacks.push(callback);
      else callback?.();
    });
    writeln(): void {}
    getSelection(): string { return ""; }
    hasSelection(): boolean { return false; }
    clearSelection(): void {}
    onBinary(): { dispose: () => void } { return disposable(); }
    onData(): { dispose: () => void } { return disposable(); }
    renderListeners = new Set<(event: { start: number; end: number }) => void>();
    onRender(listener: (event: { start: number; end: number }) => void): { dispose: () => void } {
      this.renderListeners.add(listener);
      return { dispose: () => { this.renderListeners.delete(listener); } };
    }
    onScroll(): { dispose: () => void } { return disposable(); }
    onSelectionChange(): { dispose: () => void } { return disposable(); }
    onTitleChange(): { dispose: () => void } { return disposable(); }
    onWriteParsed(): { dispose: () => void } { return disposable(); }
    registerLinkProvider(): { dispose: () => void } { return disposable(); }
    registerMarker(): { dispose: () => void } { return disposable(); }
  }
  return { Terminal: FakeTerminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate(): void {}
    dispose(): void {}
    fit(): void {}
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    activate(): void {}
    dispose(): void {}
    clearDecorations(): void {}
    findNext(): boolean { return false; }
    findPrevious(): boolean { return false; }
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class { activate(): void {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { activate(): void {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { activate(): void {} dispose(): void {} } }));

vi.mock("../../src/components/terminal/terminalTurnMarkers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/components/terminal/terminalTurnMarkers")>();
  return {
    ...actual,
    getTurnMarkData: vi.fn(() => mocks.turnMarks),
    restoreTurnMarksAtLines: vi.fn((
      _sessionId: string,
      _term: unknown,
      entries: ReadonlyArray<{ line: number; label: string; at: number }>,
    ) => {
      mocks.turnMarks = entries.map((entry) => ({ ...entry }));
      return entries.length;
    }),
  };
});

import XTermWrapper, { TERMINAL_SEARCH_EVENT } from "../../src/components/terminal/XTermWrapper";
import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { terminalPaneStrings } from "../../src/components/workspace/terminalPaneStrings";
import type { Pane, Workspace } from "../../src/types";
import {
  restoreTurnMarksAtLines,
  TURN_MARKS_EVENT,
} from "../../src/components/terminal/terminalTurnMarkers";
import { terminalTurnStrings } from "../../src/components/terminal/terminalTurnStrings";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { TERMINAL_HISTORY_EVENT } from "../../src/components/terminal/TerminalHistoryEntry";

// Built from the placeholder the component renders, so translating it does
// not silently turn these reachability checks into no-ops.
const SEARCH_INPUT = `input[placeholder='${terminalPaneStrings.searchPlaceholder}']`;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (
    window.setTimeout(() => callback(performance.now()), 0)
  ));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    disconnect(): void {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1200,
    bottom: 800,
    width: 1200,
    height: 800,
    toJSON: () => ({}),
  });

  mocks.turnMarks = [];
  mocks.bufferType = "alternate";
  mocks.bufferLines = [];
  mocks.transcriptResponses = [];
  mocks.stallWrites = false;
  mocks.writeCallbacks = [];
  mocks.terminalInstances.length = 0;
  mocks.invoke.mockReset();
  vi.mocked(restoreTurnMarksAtLines).mockClear();
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "get_terminal_config") {
      return Promise.resolve({
        font_size: 14,
        font_family: "monospace",
        background: "#000000",
        foreground: "#ffffff",
        ansi: [],
        windows_build_number: null,
      });
    }
    if (command === "is_session_alive") return Promise.resolve(false);
    if (command === "has_persisted_scrollback") return Promise.resolve(false);
    if (command === "get_session_input_revision") return Promise.resolve(0);
    if (command === "get_transcript_user_prompts") {
      return Promise.resolve(mocks.transcriptResponses.shift() ?? []);
    }
    return Promise.resolve(undefined);
  });
  useSettingsStore.setState({
    terminalRenderer: "dom",
    notificationsEnabled: false,
    showTerminalHistoryButton: true,
    terminalProgressDiagnosticsEnabled: false,
  });
  useUiStore.setState({ activePaneId: null, focusRevision: 0 });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("XTermWrapper turn-list row integration", () => {
  async function mountProgressPane(sessionId: string): Promise<void> {
    const pane = { id: `pane-${sessionId}`, sessionId, activeTabId: `tab-${sessionId}`, agentId: "shell",
      tabs: [{ id: `tab-${sessionId}`, sessionId, agentId: "shell", type: "terminal" }] } as Pane;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => {
      if (command === "read_agent_session_mappings") return Promise.resolve({ [sessionId]: { agent_kind: "claude", session_id: "exact-a" } });
      if (command === "get_session_scrollback") {
        const snapshot = new ArrayBuffer(24); new Uint8Array(snapshot).set([0x4d, 0x43, 0x53, 0x31]);
        return Promise.resolve(snapshot);
      }
      if (command === "get_live_briefs" || command === "get_live_events") return Promise.resolve([]);
      return original(command, args);
    });
    useWorkspaceListStore.setState({ workspaces: [{ id: "workspace", name: "Fixture", panes: [pane] }] as Workspace[], activeWorkspaceId: "workspace" });
    await act(async () => { root.render(<>
      <PaneTabBar pane={pane} workspaceId="workspace" hasTerminalBuffer={() => true} />
      <XTermWrapper workspaceId="workspace" sessionId={sessionId} command="powershell.exe" />
    </>); });
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "create_session")).toBe(true));
  }

  function sendProgressOutput(sessionId: string, text: string): number {
    const bytes = new TextEncoder().encode(text);
    const frame = new ArrayBuffer(40 + bytes.length);
    new Uint8Array(frame).set([0x4d, 0x43, 0x58, 0x31]);
    const view = new DataView(frame);
    view.setBigUint64(8, 1n, true); view.setBigUint64(16, 1n, true);
    view.setBigUint64(32, BigInt(bytes.length), true); new Uint8Array(frame).set(bytes, 40);
    const call = mocks.invoke.mock.calls.find(([command, args]) => command === "create_session" && args.sessionId === sessionId)!;
    call[1].onData.onmessage(frame);
    return bytes.length;
  }

  it.each([true, false])("P1 keeps the real wrapper attached and ACKing live output with history flag %s", async (enabled) => {
    const sessionId = `history-live-${enabled}`;
    useSettingsStore.setState({ showTerminalHistoryButton: enabled });
    await mountProgressPane(sessionId);
    const terminal = mocks.terminalInstances[0];
    // Let the initial attach's existing resize bursts settle before measuring reading.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 280)); });
    const mutations = () => mocks.invoke.mock.calls.filter(([command]) => ["create_session", "resize_session", "write_to_session", "kill_session"].includes(command)).length;
    const before = mutations();
    if (enabled) {
      await act(async () => { host.querySelector<HTMLButtonElement>("[data-terminal-history-entry]")!.click(); });
      expect(host.querySelector("[data-terminal-transcript-panel]")).not.toBeNull();
    } else {
      expect(host.querySelector("[data-terminal-history-entry]")).toBeNull();
      await act(async () => { window.dispatchEvent(new CustomEvent(TERMINAL_HISTORY_EVENT, { detail: { sessionId } })); });
      expect(host.querySelector("[data-terminal-transcript-panel]")).toBeNull();
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_agent_session_mappings")).toHaveLength(0);
    }
    await act(async () => { sendProgressOutput(sessionId, "synthetic live output\r\n"); });
    await vi.waitFor(() => expect(terminal.write).toHaveBeenCalledWith("synthetic live output\r\n", expect.any(Function)));
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "ack_frontend_data")).toBe(true));
    if (enabled) await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    expect(mutations()).toBe(before);
    expect(mocks.terminalInstances).toHaveLength(1); expect(terminal.dispose).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "record_terminal_progress")).toHaveLength(0);
  });

  it("P2 does not call a watchdog ACK parsed and observes the later parser/render callbacks", async () => {
    const sessionId = "progress-stalled-parser";
    useSettingsStore.setState({ terminalProgressDiagnosticsEnabled: true, showTerminalHistoryButton: false });
    await mountProgressPane(sessionId);
    mocks.stallWrites = true;
    let end = 0;
    await act(async () => { end = sendProgressOutput(sessionId, "private synthetic body\r\n"); });
    await vi.waitFor(() => expect(mocks.writeCallbacks).toHaveLength(1));
    const latest = () => mocks.invoke.mock.calls.filter(([command]) => command === "record_terminal_progress").at(-1)?.[1].records[0].sample;
    await vi.waitFor(() => expect(latest()).toMatchObject({ receivedEnd: end, parsedEnd: null }), { timeout: 3_000 });
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "ack_frontend_data")).toBe(true), { timeout: 3_000 });
    expect(latest().parsedEnd).toBeNull();
    await act(async () => { mocks.writeCallbacks.shift()!(); });
    await vi.waitFor(() => expect(latest()).toMatchObject({ parsedEnd: end }), { timeout: 3_000 });
    const tick = latest().renderTick;
    for (const listener of mocks.terminalInstances[0].renderListeners) listener({ start: 0, end: 23 });
    await vi.waitFor(() => expect(latest().renderTick).toBeGreaterThan(tick), { timeout: 3_000 });
    expect(JSON.stringify(latest())).not.toContain("private synthetic body");
    expect(JSON.stringify(latest())).not.toContain(sessionId);
  });

  it("reachability #5 opens only the requested terminal from header/menu, shares keyboard search and removes listeners", async () => {
    const panes = ["search-a", "search-b"].map((sessionId) => ({
      id: `pane-${sessionId}`, sessionId, activeTabId: `tab-${sessionId}`, agentId: "shell",
      tabs: [{ id: `tab-${sessionId}`, sessionId, agentId: "shell", type: "terminal" }],
    })) as Pane[];
    useWorkspaceListStore.setState({
      workspaces: [{ id: "workspace", name: "Search", panes }] as Workspace[], activeWorkspaceId: "workspace",
    });
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    try {
      await act(async () => {
        root.render(<>
          <PaneTabBar pane={panes[0]} workspaceId="workspace" hasTerminalBuffer={() => true} />
          {panes.map((pane) => <section key={pane.id} data-session={pane.sessionId}>
            <XTermWrapper workspaceId="workspace" sessionId={pane.sessionId} command="powershell.exe" />
          </section>)}
        </>);
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(2), { timeout: 10_000 });
      const first = host.querySelector<HTMLElement>("[data-session='search-a']")!;
      const second = host.querySelector<HTMLElement>("[data-session='search-b']")!;
      const searchInput = () => first.querySelector<HTMLInputElement>(SEARCH_INPUT);
      expect(searchInput()).toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label='${terminalPaneStrings.searchTerminal}']`)!.click());
      expect(searchInput()).not.toBeNull();
      expect(document.activeElement).toBe(searchInput());
      expect(second.querySelector(SEARCH_INPUT)).toBeNull();
      expect(useUiStore.getState().activePaneId).toBe("search-a");
      const closeSearch = async () => {
        await act(async () => { searchInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
        expect(searchInput()).toBeNull();
      };
      await closeSearch();
      await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label='${terminalPaneStrings.paneActions}']`)!.click());
      const item = [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
        .find((node) => node.textContent === terminalPaneStrings.searchTerminal)!;
      await act(async () => item.click());
      expect(document.activeElement).toBe(searchInput());
      expect(searchInput()).not.toBeNull();
      expect(second.querySelector(SEARCH_INPUT)).toBeNull();
      expect(host.querySelector("[role='menu']")).toBeNull();
      await closeSearch();
      await act(async () => {
        const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true, cancelable: true });
        expect(mocks.terminalInstances[0].keyHandler!(event)).toBe(false);
        expect(event.defaultPrevented).toBe(true);
      });
      expect(document.activeElement).toBe(searchInput());
      expect(searchInput()).not.toBeNull();
      await act(async () => {
        window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId: "unknown" } }));
      });
      expect(second.querySelector(SEARCH_INPUT)).toBeNull();
      const listeners = addListener.mock.calls.filter(([name]) => name === TERMINAL_SEARCH_EVENT);
      expect(listeners).toHaveLength(2);
      await act(async () => root.render(null));
      for (const [name, handler] of listeners) expect(removeListener).toHaveBeenCalledWith(name, handler);
    } finally {
      addListener.mockRestore();
      removeListener.mockRestore();
    }
  });

  it("scans a lone user turn on ▲, scrolls there, and keeps the panel closed", async () => {
    const sessionId = "turn-jump-buffer-scan";
    mocks.bufferType = "normal";
    mocks.bufferLines = ["❯ 唯一の指示", "⏺ 応答"];
    useWorkspaceListStore.setState({
      workspaces: [{
        id: "workspace",
        panes: [{ tabs: [{ id: "tab-turn-jump", sessionId }] }],
      }] as never,
      activeWorkspaceId: "workspace",
    });

    await act(async () => {
      root.render(
        <XTermWrapper
          workspaceId="workspace"
          sessionId={sessionId}
          command="claude"
          agentKind="claude"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(1), { timeout: 10_000 });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const wrapper = host.firstElementChild;
    expect(wrapper).not.toBeNull();
    act(() => {
      wrapper!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    });
    const prev = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>(
        `button[aria-label="${terminalTurnStrings.prevTurn}"]`,
      );
      expect(button).not.toBeNull();
      return button!;
    }, { timeout: 10_000 });

    act(() => prev.click());

    const terminal = mocks.terminalInstances[0]!;
    expect(restoreTurnMarksAtLines).toHaveBeenCalledOnce();
    expect(terminal.scrollToLine).toHaveBeenCalledWith(0);
    expect(host.querySelector("[data-terminal-transcript-panel]")).toBeNull();
  });

  it("renders a DOM row when a turn mark arrives while the list is open", async () => {
    const sessionId = "turn-list-live-row";
    await act(async () => {
      root.render(
        <XTermWrapper
          workspaceId="workspace"
          sessionId={sessionId}
          command="claude"
          agentKind="claude"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(1), { timeout: 10_000 });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const wrapper = host.firstElementChild;
    expect(wrapper).not.toBeNull();
    act(() => {
      wrapper!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const label = host.querySelector<HTMLButtonElement>(".terminal-turn-chip__label");
    expect(label).not.toBeNull();

    act(() => {
      label!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector(".terminal-turn-list__empty")?.textContent)
      .toBe(terminalTurnStrings.listEmpty);

    mocks.turnMarks = [{ line: 4, label: "日本語の命令", at: 1_000 }];
    act(() => {
      window.dispatchEvent(new CustomEvent(TURN_MARKS_EVENT, { detail: { sessionId } }));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const rows = host.querySelectorAll(".terminal-turn-list__row[role='option']");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe("日本語の命令");
    expect(host.querySelector(".terminal-turn-list__empty")).toBeNull();
    expect(host.querySelector(".terminal-turn-list")?.textContent)
      .not.toContain(terminalTurnStrings.listEmpty);
  });

  it("never repopulates the closed session cache from a late transcript reply", async () => {
    const sessionId = "turn-list-closed-late";
    let release!: (prompts: Array<{ text: string; occurredAt: number }>) => void;
    const previous = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === "get_transcript_user_prompts") return new Promise((resolve) => { release = resolve; });
      return previous(command, ...args);
    });
    await act(async () => { root.render(<XTermWrapper workspaceId="workspace" sessionId={sessionId} command="claude" agentKind="claude" />); });
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(1), { timeout: 10_000 });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    act(() => host.firstElementChild!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 })));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    act(() => host.querySelector<HTMLButtonElement>(".terminal-turn-chip__label")!.click());
    expect(release).toBeDefined();
    act(() => evictTerminalCache(sessionId));
    await act(async () => { release([{ text: "Late reply", occurredAt: 2000 }]); await Promise.resolve(); });
    expect(__turnListPromptCacheForTests.has(sessionId)).toBe(false);
    expect(host.querySelector(".terminal-turn-list")?.textContent).not.toContain("Late reply");
  });

  it("recovers from an initially empty transcript and renders its row in the open list", async () => {
    const sessionId = "turn-list-transcript-retry";
    mocks.transcriptResponses = [
      [],
      [{ text: "再取得できた日本語の命令", occurredAt: 2_000 }],
    ];
    await act(async () => {
      root.render(
        <XTermWrapper
          workspaceId="workspace"
          sessionId={sessionId}
          command="claude"
          agentKind="claude"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(1), { timeout: 10_000 });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const wrapper = host.firstElementChild;
    expect(wrapper).not.toBeNull();
    act(() => {
      wrapper!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const label = host.querySelector<HTMLButtonElement>(".terminal-turn-chip__label");
    expect(label).not.toBeNull();

    act(() => label!.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector(".terminal-turn-list__empty")?.textContent)
      .toBe(terminalTurnStrings.listEmpty);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 550));
    });

    const transcriptCalls = mocks.invoke.mock.calls.filter(
      ([command]) => command === "get_transcript_user_prompts",
    );
    expect(transcriptCalls).toHaveLength(2);
    expect(transcriptCalls[0]?.[1]).toEqual({ ptySessionId: sessionId, limit: 200 });
    const rows = host.querySelectorAll(".terminal-turn-list__row[role='option']");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe("再取得できた日本語の命令");
    expect(host.querySelector(".terminal-turn-list__empty")).toBeNull();
    expect(host.querySelector(".terminal-turn-list")?.textContent)
      .not.toContain(terminalTurnStrings.listEmpty);
  });
});

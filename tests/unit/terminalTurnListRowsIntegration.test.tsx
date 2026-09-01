// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  turnMarks: [] as Array<{ line: number; label: string; at: number }>,
  bufferType: "alternate" as "normal" | "alternate",
  bufferLines: [] as string[],
  transcriptResponses: [] as Array<Array<{ text: string; occurredAt: number }>>,
  terminalInstances: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    scrollToLine: ReturnType<typeof vi.fn>;
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

    attachCustomKeyEventHandler(): void {}
    focus(): void { this.textarea?.focus(); }
    refresh(): void {}
    reset(): void {}
    scrollToBottom = vi.fn();
    scrollToLine = vi.fn();
    write(_data: string | Uint8Array, callback?: () => void): void { callback?.(); }
    writeln(): void {}
    getSelection(): string { return ""; }
    hasSelection(): boolean { return false; }
    clearSelection(): void {}
    onBinary(): { dispose: () => void } { return disposable(); }
    onData(): { dispose: () => void } { return disposable(); }
    onRender(): { dispose: () => void } { return disposable(); }
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

import XTermWrapper from "../../src/components/terminal/XTermWrapper";
import {
  restoreTurnMarksAtLines,
  TURN_MARKS_EVENT,
} from "../../src/components/terminal/terminalTurnMarkers";
import { terminalTurnStrings } from "../../src/components/terminal/terminalTurnStrings";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

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
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(1));
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
    });

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
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(1));
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
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(1));
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

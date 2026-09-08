import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "webpane_list_presets") {
      return [
        { id: "chatgpt", label: "ChatGPT", url: "https://chatgpt.com/", profileDir: "chatgpt" },
        { id: "other", label: "Other", url: "https://example.com/", profileDir: "other" },
        { id: "browser", label: "Browser", url: "about:blank", profileDir: "ai" },
      ];
    }
    if (command === "webpane_eval" && args?.script === "return window.__mycmux.generation;") return { value: 123 };
    if (command === "webpane_eval") return { value: String(args?.script).includes("__mycmux.target")
      ? { ref: "r1", rect: { x: 10, y: 20, width: 100, height: 30 }, generation: 123 }
      : { ready: false, url: "https://example.com/" } };
    if (command === "webpane_set_file_input") return { tabId: args?.tabId, files: [] };
    if (command === "webpane_read") return { tabId: args?.tabId, turns: [], generating: false };
    if (command === "webpane_push") {
      return {
        tabId: args?.tabId,
        submitted: args?.submit,
        textBytes: typeof args?.text === "string" ? new TextEncoder().encode(args.text).byteLength : 0,
      };
    }
    return null;
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  Channel: class {},
}));

function terminalTab(id: string, sessionId: string): PaneTab {
  return { id, sessionId, agentId: "shell-starter", type: "terminal" };
}

function webTab(id: string, presetId = "chatgpt", label?: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "web",
    type: "web",
    presetId,
    label,
  };
}

function pane(id: string, tabs: PaneTab[], activeTabId = tabs[0].id): Pane {
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  return {
    id,
    agentId: active.agentId,
    sessionId: active.sessionId,
    tabs,
    activeTabId: active.id,
  };
}

function workspace(id: string, panes: Pane[]): Workspace {
  return {
    id,
    name: id,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes,
    splitColumns: [panes.map((candidate) => candidate.id)],
  };
}

const anchor = terminalTab("terminal", "anchor-session");
const nativeBudgetExpectation = (command: string) => ({ budgetMs: expect.any(Number), command });

beforeEach(() => {
  vi.clearAllMocks();
  const active = workspace("active", [pane("active-pane", [anchor])]);
  useWorkspaceListStore.setState({
    workspaces: [active],
    activeWorkspaceId: active.id,
    lastActivePaneByWorkspace: {},
  });
  useUiStore.setState({
    activePaneId: anchor.sessionId,
    lastActivePaneId: anchor.sessionId,
    focusRevision: 0,
  });
});

describe("web socket commands", () => {
  it("opens a web tab, replaces the anchor only when requested, and returns its tab id", async () => {
    const result = await handleSocketCommand("web.open", {
      presetId: "chatgpt",
      anchorSessionId: anchor.sessionId,
      replaceAnchor: true,
    }) as { tabId: string };

    const tabs = useWorkspaceListStore.getState().getWorkspace("active")!.panes[0].tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ id: result.tabId, type: "web", presetId: "chatgpt" });
    expect(useUiStore.getState().activePaneId).toBeNull();
  });

  it("lists web tabs in the R11 response shape", async () => {
    const first = workspace("first", [pane("first-pane", [anchor, webTab("chat", "chatgpt", "Project")])]);
    const second = workspace("second", [pane("second-pane", [webTab("other", "other")])]);
    useWorkspaceListStore.setState({ workspaces: [first, second], activeWorkspaceId: first.id });

    await expect(handleSocketCommand("web.list", {})).resolves.toEqual([
      {
        tabId: "chat",
        presetId: "chatgpt",
        url: "https://chatgpt.com/",
        title: "Project",
        workspaceId: "first",
        background: false,
        active: false,
      },
      {
        tabId: "other",
        presetId: "other",
        url: "https://example.com/",
        title: "Other",
        workspaceId: "second",
        background: false,
        active: true,
      },
    ]);
  });

  it("still builds a web tab when pane.spawn splits for one", async () => {
    // The split route is the one target: "web" is allowed on, so it has to keep
    // working after spawn_tab started refusing the same target.
    const result = await handleSocketCommand("pane.spawn", {
      target: "web",
      preset: "chatgpt",
      anchorSessionId: anchor.sessionId,
      direction: "right",
    }) as { paneId: string; presetId: string };

    expect(result.presetId).toBe("chatgpt");
    const panes = useWorkspaceListStore.getState().getWorkspace("active")!.panes;
    expect(panes).toHaveLength(2);
    const created = panes.find((candidate) => candidate.id === result.paneId)!;
    // The split makes the pane with its own terminal tab first, so the web tab
    // arrives beside it and takes the foreground. That extra shell tab predates
    // this change; what has to hold is that the web tab exists and is showing.
    const web = created.tabs.find((tab) => tab.type === "web")!;
    expect(web).toMatchObject({ type: "web", presetId: "chatgpt" });
    expect(created.activeTabId).toBe(web.id);
  });

  it("refuses a web target on pane.spawn_tab instead of opening a shell", async () => {
    // pane.spawn_tab adds a background tab via addTabToPaneWithOptions, which
    // only builds terminal tabs and drops webPresetId. `spawn --target web`
    // therefore opened a shell, which is what made the launcher's ChatGPT entry
    // look broken from v0.59.0 until 2026-09-02.
    await expect(handleSocketCommand("pane.spawn_tab", {
      anchorSessionId: anchor.sessionId,
      target: "web",
      preset: "chatgpt",
    })).rejects.toThrow("pane.spawn_tab cannot create a web tab");

    const tabs = useWorkspaceListStore.getState().getWorkspace("active")!.panes[0].tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].type).toBe("terminal");
  });

  it("focuses the explicitly requested web tab", async () => {
    const backgroundWeb = webTab("background-chat");
    const active = workspace("active", [pane("active-pane", [anchor])]);
    const background = workspace("background", [pane("background-pane", [backgroundWeb])]);
    useWorkspaceListStore.setState({ workspaces: [active, background], activeWorkspaceId: active.id });

    await expect(handleSocketCommand("web.focus", { tabId: backgroundWeb.id })).resolves.toEqual({
      tabId: backgroundWeb.id,
      workspaceId: background.id,
    });
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe(background.id);
    expect(useWorkspaceListStore.getState().getWorkspace(background.id)!.panes[0].activeTabId)
      .toBe(backgroundWeb.id);
    expect(useUiStore.getState().activePaneId).toBeNull();
  });

  it.each([null, [], ["brief.pdf"]])("rejects the unsupported files argument %j", async (files) => {
    await expect(handleSocketCommand("web.push", { text: "draft", files }))
      .rejects.toThrow("web.push files are not supported in this phase");
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith("webpane_push", expect.anything());
  });

  it("uses the last matching ChatGPT tab in the anchor workspace", async () => {
    const oldChat = webTab("old-chat");
    const newestChat = webTab("newest-chat");
    const active = workspace("active", [
      pane("first-pane", [anchor, oldChat, webTab("other", "other")]),
      pane("second-pane", [newestChat]),
    ]);
    const background = workspace("background", [pane("background-pane", [webTab("background-chat")])]);
    useWorkspaceListStore.setState({ workspaces: [active, background], activeWorkspaceId: background.id });

    await handleSocketCommand("web.push", {
      anchorSessionId: anchor.sessionId,
      text: "日本語\nC:\\tmp\\brief.md",
    });

    expect(tauriMocks.invoke).toHaveBeenCalledWith("webpane_push", {
      tabId: newestChat.id,
      text: "日本語\nC:\\tmp\\brief.md",
      submit: false,
    });
  });

  it("submits only when submit is true", async () => {
    const chat = webTab("chat");
    const active = workspace("active", [pane("active-pane", [anchor, chat])]);
    useWorkspaceListStore.setState({ workspaces: [active], activeWorkspaceId: active.id });

    await handleSocketCommand("web.push", { tabId: chat.id, text: "send", submit: true });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("webpane_push", {
      tabId: chat.id,
      text: "send",
      submit: true,
    });
  });

  it("errors without opening when the target workspace has no matching tab", async () => {
    await expect(handleSocketCommand("web.push", {
      anchorSessionId: anchor.sessionId,
      text: "draft",
    })).rejects.toThrow("web.push found no matching web tab in the target workspace");
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith("webpane_push", expect.anything());
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toEqual([anchor]);
  });
  it.each([false, true])("opens behind the anchor without changing foreground state (other workspace=%s)", async (other) => {
    if (other) {
      const foreground = workspace("foreground", [pane("foreground-pane", [terminalTab("fg", "fg-session")])]);
      useWorkspaceListStore.setState({
        workspaces: [...useWorkspaceListStore.getState().workspaces, foreground],
        activeWorkspaceId: foreground.id,
      });
      useUiStore.setState({ activePaneId: "fg-session", lastActivePaneId: "fg-session", focusRevision: 9 });
    }
    const { activePaneId, lastActivePaneId, focusRevision } = useUiStore.getState();
    const activeWorkspaceId = useWorkspaceListStore.getState().activeWorkspaceId;
    const result = await handleSocketCommand("web.open", {
      presetId: "chatgpt", anchorSessionId: anchor.sessionId, background: true,
      url: "https://chatgpt.com/c/abc",
    }) as { tabId: string; background: boolean };
    expect(result.background).toBe(true);
    const target = useWorkspaceListStore.getState().getWorkspace("active")!.panes[0];
    expect(target.activeTabId).toBe(anchor.id);
    expect(target.tabs[1]).toMatchObject({
      id: result.tabId, webBackground: true, webInitialUrl: "https://chatgpt.com/c/abc",
    });
    expect(useUiStore.getState()).toMatchObject({ activePaneId, lastActivePaneId, focusRevision });
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe(activeWorkspaceId);
    expect(await handleSocketCommand("web.list", {})).toContainEqual(expect.objectContaining({
      tabId: result.tabId, background: true, active: false,
    }));
  });

  it("passes foreground initial URLs and rejects non-HTTPS or conflicting open options", async () => {
    const result = await handleSocketCommand("web.open", {
      presetId: "chatgpt", url: "https://chatgpt.com/c/abc",
    }) as { tabId: string; background: boolean };
    expect(result.background).toBe(false);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[1].webInitialUrl)
      .toBe("https://chatgpt.com/c/abc");
    await expect(handleSocketCommand("web.open", { presetId: "chatgpt", url: "http://chatgpt.com" }))
      .rejects.toThrow("web.open url must be https");
    await expect(handleSocketCommand("web.open", { presetId: "chatgpt", replaceAnchor: true, background: true }))
      .rejects.toThrow("cannot combine replaceAnchor and background");
  });

  it("reads the latest preset in the anchor workspace and gives explicit tabId priority", async () => {
    const active = workspace("active", [pane("active-pane", [anchor, webTab("old"), webTab("new")])]);
    const other = workspace("other", [pane("other-pane", [webTab("foreign")])]);
    useWorkspaceListStore.setState({ workspaces: [active, other], activeWorkspaceId: other.id });
    await expect(handleSocketCommand("web.read", { presetId: "chatgpt", anchorSessionId: anchor.sessionId }))
      .resolves.toEqual({ tabId: "new", turns: [], generating: false });
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_read", { tabId: "new" });
    await handleSocketCommand("web.read", { tabId: "old", presetId: "other" });
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_read", { tabId: "old" });
    await expect(handleSocketCommand("web.read", { presetId: "missing", anchorSessionId: anchor.sessionId }))
      .rejects.toThrow("web.read found no matching web tab in the target workspace");
    await expect(handleSocketCommand("web.read", { anchorSessionId: "missing" }))
      .rejects.toThrow("web.read found no matching web tab in the target workspace");
    await expect(handleSocketCommand("web.read", { tabId: anchor.id })).rejects.toThrow("web tab not found");
  });

  it("closes only Web tabs and preserves the terminal", async () => {
    const active = workspace("active", [pane("active-pane", [anchor, webTab("chat")])]);
    useWorkspaceListStore.setState({ workspaces: [active] });
    await expect(handleSocketCommand("web.close", { tabId: anchor.id }))
      .rejects.toThrow("web.close requires a web tab");
    await expect(handleSocketCommand("web.close", { tabId: "chat" }))
      .resolves.toEqual({ tabId: "chat", closed: true });
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toEqual([anchor]);
  });

});

describe("web automation routing", () => {
  beforeEach(() => {
    const active = workspace("active", [pane("active-pane", [anchor, webTab("browser", "browser"), webTab("chat")])]);
    useWorkspaceListStore.setState({ workspaces: [active], activeWorkspaceId: "active" });
  });

  it.each([
    ["web.navigate", { url: "https://example.com/" }, "webpane_navigate", { url: "https://example.com/" }],
    ["web.navigate", { action: "back" }, "webpane_navigate", { action: "back" }],
    ["web.eval", { script: "return 42", timeoutMs: 42 }, "webpane_eval", { script: "return 42", timeoutMs: 42 }],
    ["web.snapshot", {}, "webpane_snapshot", { mode: "ax", maxBytes: 262144 }],
    ["web.find", { text: "Count", role: "button", exact: true, limit: 5 }, "webpane_find", { query: { text: "Count", role: "button", exact: true, limit: 5 } }],
    ["web.click", { ref: "r1" }, "webpane_click", { target: { ref: "r1" }, options: { button: "left", clickCount: 1 } }],
    ["web.click", { x: 4, y: 8, button: "right", clickCount: 2 }, "webpane_click", { target: { x: 4, y: 8 }, options: { button: "right", clickCount: 2 } }],
    ["web.type", { selector: "#text", text: "value", mode: "append", submit: true }, "webpane_type", { target: { selector: "#text" }, text: "value", mode: "append", submit: true }],
    ["web.key", { ref: "r1", key: "Enter", code: "Enter", modifiers: ["ctrl"] }, "webpane_key", { target: { ref: "r1" }, key: "Enter", code: "Enter", modifiers: ["ctrl"] }],
    ["web.scroll", { selector: "#scroller", deltaY: -10 }, "webpane_scroll", { target: { selector: "#scroller" }, deltaX: 0, deltaY: -10 }],
    ["web.scroll", {}, "webpane_scroll", { deltaX: 0, deltaY: 600 }],
    ["web.upload", { selector: "#file", paths: ["a", "b"] }, "webpane_upload", { target: { selector: "#file" }, paths: ["a", "b"], mode: "input" }],
    ["web.upload", { ref: "r1", paths: ["a"], mode: "drop" }, "webpane_upload", { target: { ref: "r1" }, paths: ["a"], mode: "drop" }],
    ["web.screenshot", { path: "out.png", clip: { x: 1, y: 2, width: 3, height: 4 } }, "webpane_screenshot", { path: "out.png", clip: { x: 1, y: 2, width: 3, height: 4 } }],
    ["web.screenshot", {}, "webpane_screenshot", {}],
    ["web.downloads", {}, "webpane_downloads", {}],
    ["web.dialogs", { clear: true }, "webpane_dialogs", { clear: true }],
  ] as const)("routes %s %j", async (command, args, invokeName, payload) => {
    await handleSocketCommand(command, { ...args, tabId: "browser" });
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith(invokeName, { tabId: "browser", ...payload,
      ...(command === "web.screenshot" ? nativeBudgetExpectation(command) : {}) });
    expect(useUiStore.getState()).toMatchObject({ activePaneId: anchor.sessionId, focusRevision: 0 });
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].activeTabId).toBe(anchor.id);
  });

  it.each([
    ["web.navigate", {}], ["web.navigate", { url: "x", action: "reload" }], ["web.navigate", { action: "bad" }],
    ["web.eval", {}], ["web.eval", { script: 1 }], ["web.eval", { script: "return 1", timeoutMs: "2" }],
    ["web.eval", { script: "", timeoutMs: null }], ["web.wait", { state: "bad" }],
    ["web.wait", { state: "selector" }], ["web.wait", { intervalMs: 0 }], ["web.wait", { timeoutMs: -1 }],
    ["web.snapshot", { mode: "bad" }], ["web.snapshot", { maxBytes: NaN }], ["web.snapshot", { maxBytes: 1 }],
    ["web.find", {}], ["web.find", { text: "x", limit: 0 }], ["web.find", { text: "x", exact: "yes" }],
    ["web.click", {}], ["web.click", { ref: "r1", selector: "button" }],
    ["web.click", { x: 1 }], ["web.click", { x: Infinity, y: 1 }], ["web.click", { ref: "r1", y: 1 }],
    ["web.click", { ref: "bad" }], ["web.click", { ref: "r1", trusted: "yes" }],
    ["web.click", { ref: "r1", button: "bad" }], ["web.click", { ref: "r1", clickCount: 1.2 }],
    ["web.type", { ref: "r1" }], ["web.type", { ref: "r1", text: 2 }], ["web.type", { x: 1, y: 2, text: "x" }],
    ["web.type", { ref: "r1", text: "x", mode: "bad" }], ["web.type", { ref: "r1", text: "x", submit: null }],
    ["web.key", {}], ["web.key", { key: "Enter", modifiers: "ctrl" }], ["web.key", { key: "a", modifiers: ["bad"] }],
    ["web.key", { key: "Enter", selector: "button" }], ["web.scroll", { ref: "r1", selector: "x" }],
    ["web.scroll", { deltaY: "600" }], ["web.upload", { ref: "r1", paths: [] }],
    ["web.upload", { ref: "r1", paths: [""] }], ["web.upload", { ref: "r1", paths: [1] }],
    ["web.upload", { ref: "r1", paths: ["a"], trusted: true, mode: "drop" }],
    ["web.screenshot", { clip: {} }], ["web.screenshot", { clip: { x: 0, y: 0, width: 0, height: 1 } }],
    ["web.screenshot", { path: 5 }], ["web.dialogs", { clear: "yes" }], ["web.downloads", { tabId: 1 }],
  ] as const)("rejects invalid %s %j before invoking", async (command, args) => {
    await expect(handleSocketCommand(command, { tabId: "browser", ...args })).rejects.toThrow(command);
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("resolves the same workspace target as read and keeps explicit tabId priority", async () => {
    await handleSocketCommand("web.downloads", { presetId: "browser", anchorSessionId: anchor.sessionId });
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_downloads", { tabId: "browser" });
    await handleSocketCommand("web.downloads", { tabId: "chat", presetId: "browser" });
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_downloads", { tabId: "chat" });
    await expect(handleSocketCommand("web.downloads", { presetId: "missing" })).rejects.toThrow("web.downloads found no matching");
    await expect(handleSocketCommand("web.downloads", { tabId: anchor.id })).rejects.toThrow("web.downloads web tab not found");
  });

  it("polls wait until the deadline and returns ready false", async () => {
    vi.useFakeTimers();
    try {
      const waiting = handleSocketCommand("web.wait", { tabId: "browser", state: "idle", intervalMs: 50, timeoutMs: 120 });
      await vi.advanceTimersByTimeAsync(120);
      await expect(waiting).resolves.toMatchObject({ tabId: "browser", state: "idle", ready: false, url: "https://example.com/", elapsedMs: 120 });
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(3);
      expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_eval", expect.objectContaining({ timeoutMs: 20 }));
    } finally { vi.useRealTimers(); }
  });

  it("returns ready immediately and tolerates webview creation before polling", async () => {
    tauriMocks.invoke.mockRejectedValueOnce("web pane does not exist: browser");
    tauriMocks.invoke.mockResolvedValueOnce({ value: { ready: true, url: "https://example.com/" } });
    await expect(handleSocketCommand("web.wait", { tabId: "browser", intervalMs: 1, timeoutMs: 100 })).resolves.toMatchObject({ ready: true });
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("resolves a ref to CSS viewport coordinates for trusted click", async () => {
    await handleSocketCommand("web.click", { tabId: "browser", ref: "r1", trusted: true, clickCount: 2 });
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "webpane_eval", { tabId: "browser", script: 'return window.__mycmux.target({"target":{"ref":"r1"}});', timeoutMs: 5000, direct: true });
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_input_trusted", {
      ...nativeBudgetExpectation("web.click"), tabId: "browser", action: { kind: "click", x: 60, y: 35, button: "left", clickCount: 2, expectedGeneration: 123 },
    });
  });

  it("focuses and selects before trusted text insertion and submits with a trusted key", async () => {
    const result = await handleSocketCommand("web.type", { tabId: "browser", selector: "#text", text: "hello", trusted: true, submit: true });
    expect(tauriMocks.invoke.mock.calls[0][1]?.script).toContain('"focus":true,"select":true,"append":false,"editable":true');
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "webpane_input_trusted", { ...nativeBudgetExpectation("web.type"), tabId: "browser", action: { kind: "insertText", text: "hello", expectedGeneration: 123 } });
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_input_trusted", { ...nativeBudgetExpectation("web.type"), tabId: "browser", action: { kind: "key", key: "Enter", code: "Enter", expectedGeneration: 123 } });
    expect(result).toMatchObject({ chars: 5, submitted: true });
  });

  it("focuses a trusted key ref and forwards the native action shape", async () => {
    await handleSocketCommand("web.key", { tabId: "browser", ref: "r1", key: "a", code: "KeyA", modifiers: ["ctrl"], trusted: true });
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_input_trusted", {
      ...nativeBudgetExpectation("web.key"), tabId: "browser", action: { kind: "key", key: "a", code: "KeyA", modifiers: ["ctrl"], expectedGeneration: 123 },
    });
  });

  it("validates a live upload ref and converts it to a selector for native file input", async () => {
    await handleSocketCommand("web.upload", { tabId: "browser", ref: "r1", paths: ["a"], trusted: true });
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_set_file_input", {
      ...nativeBudgetExpectation("web.upload"), tabId: "browser", selector: '[data-mycmux-ref="r1"]', paths: ["a"], expectedGeneration: 123,
    });
  });


  it.each(["web.eval", "web.wait"])("caps %s timeout at the socket deadline", async (command) => {
    await expect(handleSocketCommand(command, { tabId: "browser", script: "return 1", timeoutMs: 25001 }))
      .rejects.toThrow(command + " timeoutMs must be <= 25000 (socket response deadline is 30s); poll again instead");
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    if (command === "web.wait") tauriMocks.invoke.mockResolvedValueOnce({ value: { ready: true, url: "https://example.com/" } });
    await handleSocketCommand(command, { tabId: "browser", script: "return 1", timeoutMs: 25000 });
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_eval", expect.objectContaining({
      timeoutMs: expect.any(Number),
    }));
    const timeout = tauriMocks.invoke.mock.lastCall?.[1]?.timeoutMs as number;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(command === "web.eval" ? 25000 : 5000);
  });

  it("evaluates wait directly without a function constructor", async () => {
    tauriMocks.invoke.mockResolvedValueOnce({ value: { ready: true, url: "https://example.com/" } });
    await handleSocketCommand("web.wait", {tabId: "browser"});
    expect(tauriMocks.invoke).toHaveBeenCalledWith("webpane_eval", expect.objectContaining({direct: true}));
  });

  it.each([1, 3])("accepts clickCount %s at the supported boundaries", async (clickCount) => {
    await handleSocketCommand("web.click", {tabId: "browser", ref: "r1", clickCount});
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_click", expect.objectContaining({options: {button: "left", clickCount}}));
  });

  it.each([0, 4, -1, 1.5])("rejects unsupported clickCount %s before dispatch", async (clickCount) => {
    await expect(handleSocketCommand("web.click", {tabId:"browser", ref:"r1", clickCount})).rejects.toThrow("web.click clickCount");
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("enforces the 4096 byte snapshot minimum", async () => {
    await expect(handleSocketCommand("web.snapshot", {tabId:"browser", maxBytes:4095})).rejects.toThrow("web.snapshot maxBytes");
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    await handleSocketCommand("web.snapshot", {tabId:"browser", maxBytes:4096});
    expect(tauriMocks.invoke).toHaveBeenCalledWith("webpane_snapshot", {tabId:"browser", mode:"ax", maxBytes:4096});
  });

  it("limits eval input by UTF-8 bytes before dispatch", async () => {
    const boundary = "\u{1f600}".repeat(65536);
    await expect(handleSocketCommand("web.eval", {tabId:"browser", script:boundary+"x"})).rejects.toThrow("web.eval script exceeds 256 KB");
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    await handleSocketCommand("web.eval", {tabId:"browser", script:boundary});
    expect(tauriMocks.invoke).toHaveBeenCalledWith("webpane_eval", {tabId:"browser", script:boundary, timeoutMs:5000});
  });

  it("moves unsupported append inputs to the end before trusted insertion", async () => {
    tauriMocks.invoke.mockResolvedValueOnce({ value: {rect:{x:1,y:2,width:3,height:4}, generation:17, appendWithEndKey:true} });
    await handleSocketCommand("web.type", {tabId:"browser", selector:"#email", text:"x", mode:"append", submit:true, trusted:true});
    expect(tauriMocks.invoke.mock.calls.slice(1)).toEqual([
      ["webpane_input_trusted", {...nativeBudgetExpectation("web.type"), tabId:"browser", action:{kind:"key", key:"End", code:"End", expectedGeneration:17}}],
      ["webpane_input_trusted", {...nativeBudgetExpectation("web.type"), tabId:"browser", action:{kind:"insertText", text:"x", expectedGeneration:17}}],
      ["webpane_input_trusted", {...nativeBudgetExpectation("web.type"), tabId:"browser", action:{kind:"key", key:"Enter", code:"Enter", expectedGeneration:17}}],
    ]);
  });

  it("binds an unaddressed trusted key to the current generation", async () => {
    await handleSocketCommand("web.key", {tabId:"browser", key:"Enter", trusted:true});
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "webpane_eval", {tabId:"browser", script:"return window.__mycmux.generation;", timeoutMs:5000, direct:true});
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_input_trusted", {...nativeBudgetExpectation("web.key"), tabId:"browser", action:{kind:"key", key:"Enter", expectedGeneration:123}});
  });

  it("binds selector uploads and wheel actions to the resolved generation", async () => {
    await handleSocketCommand("web.upload", {tabId:"browser", selector:"#file", paths:["a"], trusted:true});
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_set_file_input", {...nativeBudgetExpectation("web.upload"), tabId:"browser", selector:"#file", paths:["a"], expectedGeneration:123});
    const api = await import("../../src/components/workspace/webPaneApi");
    const action = {kind:"wheel" as const, x:1, y:2, deltaX:0, deltaY:100, expectedGeneration:321};
    await api.inputTrustedWebPane("browser", action);
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_input_trusted", {tabId:"browser", action});
  });

  it("does not send trusted input without a valid generation", async () => {
    tauriMocks.invoke.mockResolvedValueOnce({value:{rect:{x:1,y:2,width:3,height:4}}});
    await expect(handleSocketCommand("web.click", {tabId:"browser", ref:"r1", trusted:true})).rejects.toThrow("snapshot again");
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("stops a multi-action type when native generation validation fails", async () => {
    tauriMocks.invoke.mockResolvedValueOnce({value:{rect:{x:1,y:2,width:3,height:4}, generation:17}});
    tauriMocks.invoke.mockRejectedValueOnce("page changed since the target was resolved; snapshot again");
    await expect(handleSocketCommand("web.type", {tabId:"browser", ref:"r1", text:"x", trusted:true, submit:true})).rejects.toContain("page changed");
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(2);
    expect(tauriMocks.invoke.mock.calls[1][1]?.action).toMatchObject({expectedGeneration:17});
  });

  it("serializes concurrent trusted types on the same tab through the final dispatch", async () => {
    let finishFirst!: () => void;
    const firstDispatch = new Promise<null>(resolve => { finishFirst = () => resolve(null); });
    tauriMocks.invoke.mockResolvedValueOnce({ value: { generation: 123 } });
    tauriMocks.invoke.mockImplementationOnce(() => firstDispatch);
    const first = handleSocketCommand("web.type", { tabId: "browser", selector: "#first", text: "one", trusted: true, submit: true });
    await vi.waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledTimes(2));
    const second = handleSocketCommand("web.type", { tabId: "browser", selector: "#second", text: "two", trusted: true });
    // A different tab acts as a barrier: it can finish while the first holds its tab.
    await handleSocketCommand("web.read", { tabId: "chat" });
    expect(tauriMocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      "webpane_eval", "webpane_input_trusted", "webpane_read",
    ]);
    finishFirst();
    await Promise.all([first, second]);
    expect(tauriMocks.invoke.mock.calls.slice(3).map(([command]) => command)).toEqual([
      "webpane_input_trusted", "webpane_eval", "webpane_input_trusted",
    ]);
    expect(tauriMocks.invoke.mock.calls[3][1]?.action).toMatchObject({ kind: "key", key: "Enter" });
    expect(tauriMocks.invoke.mock.calls[4][1]?.script).toContain("#second");
    expect(tauriMocks.invoke.mock.calls[5][1]?.action).toMatchObject({ kind: "insertText", text: "two" });
  });

  it("runs concurrent trusted types on different tabs without waiting for the other dispatch", async () => {
    let finishFirst!: () => void;
    const firstDispatch = new Promise<null>(resolve => { finishFirst = () => resolve(null); });
    tauriMocks.invoke.mockResolvedValueOnce({ value: { generation: 123 } });
    tauriMocks.invoke.mockImplementationOnce(() => firstDispatch);
    const first = handleSocketCommand("web.type", { tabId: "browser", ref: "r1", text: "one", trusted: true });
    await vi.waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledTimes(2));
    await handleSocketCommand("web.type", { tabId: "chat", ref: "r2", text: "two", trusted: true });
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_input_trusted", {
      ...nativeBudgetExpectation("web.type"), tabId: "chat", action: { kind: "insertText", text: "two", expectedGeneration: 123 },
    });
    finishFirst();
    await first;
  });

  it("releases the tab after a failed command and serializes legacy read push and focus", async () => {
    let rejectFirst!: (error: Error) => void;
    tauriMocks.invoke.mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }));
    const failed = expect(handleSocketCommand("web.eval", { tabId: "browser", script: "return 1;" })).rejects.toThrow("failed");
    await vi.waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledTimes(1));
    const read = handleSocketCommand("web.read", { tabId: "browser" });
    const push = handleSocketCommand("web.push", { tabId: "browser", text: "next" });
    const focus = handleSocketCommand("web.focus", { tabId: "browser" });
    await handleSocketCommand("web.read", { tabId: "chat" });
    expect(tauriMocks.invoke.mock.calls.map(([, args]) => args?.tabId)).toEqual(["browser", "chat"]);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].activeTabId).not.toBe("browser");
    rejectFirst(new Error("failed"));
    await Promise.all([failed, read, push, focus]);
    expect(tauriMocks.invoke.mock.calls.slice(2).map(([command]) => command).sort()).toEqual(["webpane_push", "webpane_read"]);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].activeTabId).toBe("browser");
  });

  it("preserves the native command-not-found error before lane 2 is merged", async () => {
    tauriMocks.invoke.mockRejectedValueOnce("Command webpane_screenshot not found");
    await expect(handleSocketCommand("web.screenshot", { tabId: "browser" })).rejects.toBe("Command webpane_screenshot not found");
  });

  it("allows local browser fixture URLs without relaxing existing preset open validation", async () => {
    await handleSocketCommand("web.open", { presetId: "browser", background: true, url: "http://127.0.0.1:1234/index.html" });
    for (const url of ["file:///C:/x", "http://example.com/", "http://localhost.evil/"])
      await expect(handleSocketCommand("web.open", { presetId: "browser", url })).rejects.toThrow("web.open browser URL");
    await expect(handleSocketCommand("web.open", { presetId: "chatgpt", url: "http://localhost:1234" })).rejects.toThrow("web.open url must be https");
  });
  describe("shared web command deadlines", () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    function heldInvocation() {
      let finish!: () => void;
      const promise = new Promise<null>(resolve => { finish = () => resolve(null); });
      return { promise, finish };
    }

    it("expires a queued command without dispatch and does not let its successor overtake the holder", async () => {
      const held = heldInvocation();
      tauriMocks.invoke.mockImplementationOnce(() => held.promise);
      const first = handleSocketCommand("web.eval", { tabId: "browser", script: "first" });
      await vi.advanceTimersByTimeAsync(0);
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
      const expired = expect(handleSocketCommand("web.type", { tabId: "browser", ref: "r1", text: "expired" }))
        .rejects.toThrow("web.type queued past the socket deadline; retry");
      await vi.advanceTimersByTimeAsync(25000);
      await expired;
      const next = handleSocketCommand("web.eval", { tabId: "browser", script: "next" });
      await vi.advanceTimersByTimeAsync(0);
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
      held.finish();
      await Promise.all([first, next]);
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(2);
      expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_eval", expect.objectContaining({ script: "next" }));
    });

    it("checks the receipt deadline again after the previous holder releases", async () => {
      const held = heldInvocation();
      tauriMocks.invoke.mockImplementationOnce(() => held.promise);
      const first = handleSocketCommand("web.eval", { tabId: "browser", script: "first" });
      await vi.advanceTimersByTimeAsync(0);
      const expired = expect(handleSocketCommand("web.eval", { tabId: "browser", script: "late" }))
        .rejects.toThrow("web.eval queued past the socket deadline; retry");
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(25000); // No timer callback: acquisition itself must check.
      held.finish();
      await Promise.all([first, expired]);
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
    });

    it.each(["close", "destroy"])("%s immediately rejects every waiter while the holder is unresolved", async (method) => {
      const held = heldInvocation();
      tauriMocks.invoke.mockImplementationOnce(() => held.promise);
      const first = handleSocketCommand("web.eval", { tabId: "browser", script: "first" });
      await vi.advanceTimersByTimeAsync(0);
      const waiters = [
        expect(handleSocketCommand("web.type", { tabId: "browser", ref: "r1", text: "late" }))
          .rejects.toThrow("web.type: tab closed while queued"),
        expect(handleSocketCommand("web.read", { tabId: "browser" }))
          .rejects.toThrow("web.read: tab closed while queued"),
        expect(handleSocketCommand("web.push", { tabId: "browser", text: "late" }))
          .rejects.toThrow("web.push: tab closed while queued"),
      ];
      await vi.advanceTimersByTimeAsync(0);
      if (method === "close") await handleSocketCommand("web.close", { tabId: "browser" });
      else await (await import("../../src/components/workspace/webPaneApi")).destroyWebPane("browser");
      await Promise.all(waiters);
      expect(tauriMocks.invoke.mock.calls.map(([name]) => name)).toEqual(
        method === "close" ? ["webpane_eval"] : ["webpane_eval", "webpane_destroy"],
      );
      held.finish();
      await first;
    });

    it("includes queue time in web.wait instead of restarting its loop clock", async () => {
      const held = heldInvocation();
      tauriMocks.invoke.mockImplementationOnce(() => held.promise);
      const first = handleSocketCommand("web.eval", { tabId: "browser", script: "first" });
      await vi.advanceTimersByTimeAsync(0);
      const waiting = handleSocketCommand("web.wait", { tabId: "browser", timeoutMs: 120, intervalMs: 50 });
      await vi.advanceTimersByTimeAsync(100);
      held.finish();
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_eval", expect.objectContaining({ timeoutMs: 20 }));
      await vi.advanceTimersByTimeAsync(20);
      await expect(waiting).resolves.toMatchObject({ ready: false, elapsedMs: 120 });
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(2);
    });

    it("passes only the remaining socket deadline to a queued eval", async () => {
      const held = heldInvocation();
      tauriMocks.invoke.mockImplementationOnce(() => held.promise);
      const first = handleSocketCommand("web.eval", { tabId: "browser", script: "first" });
      await vi.advanceTimersByTimeAsync(0);
      const next = handleSocketCommand("web.eval", { tabId: "browser", script: "next", timeoutMs: 25000 });
      await vi.advanceTimersByTimeAsync(20000);
      held.finish();
      await Promise.all([first, next]);
      expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_eval", { tabId: "browser", script: "next", timeoutMs: 5000 });
    });

    it("caps resolution plus all three trusted type stages at 20s and names web.type", async () => {
      tauriMocks.invoke.mockImplementationOnce(() => new Promise(resolve => setTimeout(
        () => resolve({ value: { generation: 123, appendWithEndKey: true } }), 4000,
      )));
      for (let index = 0; index < 3; index++)
        tauriMocks.invoke.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(null), 6000)));
      const operation = expect(handleSocketCommand("web.type", {
        tabId: "browser", ref: "r1", text: "value", mode: "append", submit: true, trusted: true,
      })).rejects.toThrow("web.type exceeded the 20s native budget");
      await vi.advanceTimersByTimeAsync(20000);
      await operation;
      expect(Date.now()).toBe(20000);
      const calls = tauriMocks.invoke.mock.calls.slice(1);
      expect(calls.map(([, args]) => [args?.budgetMs, args?.command])).toEqual([
        [16000, "web.type"], [10000, "web.type"], [4000, "web.type"],
      ]);
      expect(calls.map(([, args]) => args?.action)).toEqual([
        { kind: "key", key: "End", code: "End", expectedGeneration: 123 },
        { kind: "insertText", text: "value", expectedGeneration: 123 },
        { kind: "key", key: "Enter", code: "Enter", expectedGeneration: 123 },
      ]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(4);
    });

    it("does not dispatch native input when resolution has spent the shared budget", async () => {
      tauriMocks.invoke.mockImplementationOnce(async () => {
        vi.setSystemTime(20000);
        return { value: { generation: 123 } };
      });
      await expect(handleSocketCommand("web.type", { tabId: "browser", ref: "r1", text: "late", trusted: true }))
        .rejects.toThrow("web.type exceeded the 20s native budget");
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["web.click", { ref: "r1", trusted: true }, "webpane_input_trusted"],
      ["web.upload", { selector: "#file", paths: ["a"], trusted: true }, "webpane_set_file_input"],
    ] as const)("passes the resolution-adjusted budget and original %s name", async (command, args, nativeCommand) => {
      tauriMocks.invoke.mockImplementationOnce(async () => {
        vi.setSystemTime(1234);
        return { value: { generation: 123, rect: { x: 1, y: 2, width: 3, height: 4 } } };
      });
      await handleSocketCommand(command, { tabId: "browser", ...args });
      expect(tauriMocks.invoke).toHaveBeenLastCalledWith(nativeCommand, expect.objectContaining({
        budgetMs: 18766, command,
      }));
    });

    it("passes the screenshot budget and spends queue time before trusted dispatch", async () => {
      await handleSocketCommand("web.screenshot", { tabId: "chat" });
      expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_screenshot", { tabId: "chat", budgetMs: 20000, command: "web.screenshot" });
      const held = heldInvocation();
      tauriMocks.invoke.mockImplementationOnce(() => held.promise);
      const first = handleSocketCommand("web.eval", { tabId: "browser", script: "first" });
      await vi.advanceTimersByTimeAsync(0);
      const next = handleSocketCommand("web.type", { tabId: "browser", ref: "r1", text: "value", trusted: true });
      await vi.advanceTimersByTimeAsync(5000);
      held.finish();
      await Promise.all([first, next]);
      expect(tauriMocks.invoke).toHaveBeenLastCalledWith("webpane_input_trusted", expect.objectContaining({
        budgetMs: 15000, command: "web.type",
      }));
    });
  });

});

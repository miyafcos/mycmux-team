import { beforeEach, describe, expect, it, vi } from "vitest";
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
      ];
    }
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
      },
      {
        tabId: "other",
        presetId: "other",
        url: "https://example.com/",
        title: "Other",
        workspaceId: "second",
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
});

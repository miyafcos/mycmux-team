import { beforeEach, describe, expect, it, vi } from "vitest";

const terminalMocks = vi.hoisted(() => ({
  hasTerminalBuffer: vi.fn(() => false),
  getTerminalWriteCounter: vi.fn(() => 0),
  getTerminalBufferLines: vi.fn((): string[] => []),
}));
const turnMarkMocks = vi.hoisted(() => ({
  getTurnMarkPersistSnapshot: vi.fn(() => null as Array<{
    label: string;
    at: number;
    lines_from_bottom: number;
  }> | null),
}));

vi.mock("../../src/components/terminal/XTermWrapper", () => terminalMocks);
vi.mock("../../src/components/terminal/terminalTurnMarkers", () => ({
  capTurnMarkPersistSnapshots: <T>(marks: T[]) => marks,
  getTurnMarkPersistSnapshot: turnMarkMocks.getTurnMarkPersistSnapshot,
}));

import {
  applyMappingsToConfig,
  bindPersistRequestData,
  dedupeAgentSessionsInConfigs,
  toConfig,
} from "../../src/components/layout/SocketListener";
import { capturePersistRequestSnapshot } from "../../src/lib/workspacePersistenceCoordinator";
import { persistentLayoutProjection, persistentLayoutSignature } from "../../src/lib/persistentLayoutProjection";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

function tab(id: string, type: PaneTab["type"] = "terminal"): PaneTab {
  return { id, sessionId: `session-${id}`, agentId: "claude-code", type };
}

function pane(id: string, type: PaneTab["type"] = "terminal"): Pane {
  const activeTab = tab(`tab-${id}`, type);
  return {
    id,
    agentId: activeTab.agentId,
    sessionId: activeTab.sessionId,
    tabs: [activeTab],
    activeTabId: activeTab.id,
  };
}

function workspace(
  panes: Pane[],
  splitColumns: string[][],
  columnWidths: number[],
  rowHeightsPerCol: number[][],
): Workspace {
  return {
    id: "workspace",
    name: "Workspace",
    gridTemplateId: "3x1",
    panes,
    splitColumns,
    columnWidths,
    rowHeightsPerCol,
    status: "running",
    createdAt: 1,
  };
}

describe("SocketListener layout persistence", () => {
  beforeEach(() => {
    terminalMocks.hasTerminalBuffer.mockReturnValue(false);
    terminalMocks.getTerminalWriteCounter.mockReturnValue(0);
    terminalMocks.getTerminalBufferLines.mockReturnValue([]);
    turnMarkMocks.getTurnMarkPersistSnapshot.mockReturnValue(null);
    usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  });

  it("does not serialize volatile terminal metadata", () => {
    const source = pane("volatile");
    const input = workspace([source], [[source.id]], [1], [[1]]);
    usePaneMetadataStore.setState({
      metadata: { [source.sessionId]: { cwd: "C:\\work", processIsShell: false } },
      volatileMetadata: {},
    });
    const before = toConfig(input);
    usePaneMetadataStore.getState().setVolatileMetadata(source.sessionId, {
      processTitle: "codex",
      outputActive: true,
      workingPatternVisible: true,
      backendLastOutputAt: 1_234,
    });
    expect(toConfig(input)).toEqual(before);
  });

  it("keeps valid metrics when a browser-only pane is omitted", () => {
    const saved = toConfig(workspace(
      [pane("left"), pane("browser", "browser"), pane("right")],
      [["left"], ["browser"], ["right"]],
      [2, 3, 5],
      [[4], [1], [6]],
    ));

    expect(saved.split_columns).toEqual([[0], [1]]);
    expect(saved.column_widths).toEqual([2, 5]);
    expect(saved.column_widths).toHaveLength(saved.split_columns!.length);
    expect(saved.row_heights_per_col).toEqual([[4], [6]]);
  });

  it("omits browser, online, and ephemeral tabs without creating empty terminal panes", () => {
    const terminalPane = pane("terminal");
    const browserPane = pane("browser", "browser");
    const onlinePane = pane("online", "online");
    const ephemeralPane = pane("ephemeral");
    ephemeralPane.tabs[0].ephemeral = true;

    const saved = toConfig(workspace(
      [terminalPane, browserPane, onlinePane, ephemeralPane],
      [[terminalPane.id], [browserPane.id], [onlinePane.id], [ephemeralPane.id]],
      [2, 3, 4, 5],
      [[1], [1], [1], [1]],
    ));

    expect(saved.panes.map((savedPane) => savedPane.pane_id)).toEqual([terminalPane.id]);
    expect(saved.panes[0].tabs?.map((savedTab) => savedTab.type)).toEqual(["terminal"]);
  });

  it("preserves surviving column proportions when an omitted pane removes a column", () => {
    const saved = toConfig(workspace(
      [pane("left"), pane("browser", "browser"), pane("right")],
      [["left"], ["browser"], ["right"]],
      [2, 3, 5],
      [[1], [1], [1]],
    ));

    expect(saved.column_widths).toEqual([2, 5]);
  });

  it("keeps metrics unchanged when every pane is persisted", () => {
    const saved = toConfig(workspace(
      [pane("left"), pane("right")],
      [["left"], ["right"]],
      [2, 5],
      [[4], [6]],
    ));

    expect(saved.column_widths).toEqual([2, 5]);
    expect(saved.row_heights_per_col).toEqual([[4], [6]]);
  });

  it("does not persist ephemeral launch environment keys with noncanonical casing", () => {
    const source = pane("left");
    source.launchEnv = {
      mycmux_resume: "claude",
      MyCmUx_SeSsIoN_Id: "session",
      mYcMuX_hAnDoFf: "codex",
      __cmux_launcher_done: "1",
      SAFE: "value",
    };
    source.tabs[0].launchEnv = { ...source.launchEnv };

    const saved = toConfig(workspace([source], [["left"]], [1], [[1]]));
    expect(saved.panes[0].launch_env).toEqual({ SAFE: "value" });
    expect(saved.panes[0].tabs![0].launch_env).toEqual({ SAFE: "value" });
  });

  it("round-trips declared tab intent using the persisted snake_case schema", () => {
    const source = pane("declared");
    source.tabs[0] = {
      ...source.tabs[0],
      lifecycle: "declared",
      origin: { kind: "agent", parentTabId: "parent-tab" },
      declaredPrompt: "inspect the sibling session",
      declaredTarget: "codex",
    };
    source.activeTabId = source.tabs[0].id;
    const saved = toConfig(workspace([source], [["declared"]], [1], [[1]]));
    expect(saved.panes[0].tabs![0]).toMatchObject({
      lifecycle: "declared",
      origin: { kind: "agent", parent_tab_id: "parent-tab" },
      declared_prompt: "inspect the sibling session",
      declared_target: "codex",
    });
  });

  it("persists no resume identity or snapshot for a declared tab", () => {
    const source = pane("declared-poison");
    const declared = source.tabs[0];
    Object.assign(source, {
      claudeSessionId: "pane-claude",
      agentKind: "claude",
      agentSessionId: "pane-agent",
      suppressedAgentSessions: [{ agentKind: "claude", agentSessionId: "pane-suppressed" }],
    });
    Object.assign(declared, {
      lifecycle: "declared",
      declaredTarget: "claude",
      claudeSessionId: "tab-claude",
      agentKind: "claude",
      agentSessionId: "tab-agent",
      suppressedAgentSessions: [{ agentKind: "claude", agentSessionId: "tab-suppressed" }],
      terminalSnapshot: ["resume me"],
    });

    const saved = toConfig(workspace([source], [[source.id]], [1], [[1]]));
    expect(saved.panes[0]).toMatchObject({
      claude_session_id: null,
      agent_kind: null,
      agent_session_id: null,
      suppressed_agent_sessions: null,
    });
    expect(saved.panes[0].tabs![0]).toMatchObject({
      lifecycle: "declared",
      declared_target: "claude",
      claude_session_id: null,
      agent_kind: null,
      agent_session_id: null,
      suppressed_agent_sessions: null,
      terminal_snapshot: null,
      turn_marks: null,
    });
  });

  it("round-trips a web tab without contaminating its terminal sibling", () => {
    const source = pane("mixed");
    const terminal = source.tabs[0];
    Object.assign(terminal, {
      cwd: "C:\\terminal-work",
      terminalSnapshot: ["terminal output"],
      agentKind: "claude",
      agentSessionId: "terminal-agent-session",
    });
    const web: PaneTab = {
      id: "web-tab",
      sessionId: "web-session",
      agentId: "web",
      label: "ChatGPT",
      type: "web",
      presetId: "chatgpt",
      cwd: "C:\\must-not-persist",
      terminalSnapshot: ["must not persist"],
      agentKind: "claude",
      agentSessionId: "must-not-persist",
    };
    source.tabs.push(web);
    source.activeTabId = web.id;
    source.sessionId = web.sessionId;

    const saved = toConfig(workspace([source], [[source.id]], [1], [[1]]));
    expect(saved.panes[0].active_tab_id).toBe(web.id);
    expect(saved.panes[0].cwd).toBeNull();
    expect(saved.panes[0].tabs).toHaveLength(2);
    expect(saved.panes[0].tabs![0]).toMatchObject({
      tab_id: terminal.id,
      type: "terminal",
      cwd: "C:\\terminal-work",
      terminal_snapshot: ["terminal output"],
      agent_kind: "claude",
      agent_session_id: "terminal-agent-session",
    });
    expect(saved.panes[0].tabs![1]).toMatchObject({
      tab_id: web.id,
      type: "web",
      preset_id: "chatgpt",
      cwd: null,
      terminal_snapshot: null,
      turn_marks: null,
      agent_kind: null,
      agent_session_id: null,
      launch_env: null,
    });

    const restored = useWorkspaceLayoutStore.getState().restorePanes(
      "workspace",
      saved.panes,
      saved.split_columns,
      "1x1",
    );
    const restoredTerminal = restored.panes[0].tabs[0];
    const restoredWeb = restored.panes[0].tabs[1];
    expect(restoredTerminal).toMatchObject({
      id: terminal.id,
      type: "terminal",
      cwd: "C:\\terminal-work",
      terminalSnapshot: ["terminal output"],
      agentKind: "claude",
      agentSessionId: "terminal-agent-session",
    });
    expect(restoredWeb).toMatchObject({
      id: web.id,
      type: "web",
      presetId: "chatgpt",
      label: "ChatGPT",
    });
    expect(restoredWeb.terminalSnapshot).toBeUndefined();
    expect(restoredWeb.agentSessionId).toBeUndefined();
  });

  it("serializes the request-bound R1 layout after the source advances to R2", () => {
    const r1 = workspace([pane("r1")], [["r1"]], [1], [[1]]);
    const captured = capturePersistRequestSnapshot(persistentLayoutProjection([r1]));
    const request = {
      requestId: "request-r1",
      revision: 1,
      signature: persistentLayoutSignature([r1]),
      ...captured,
      leaderGeneration: 7,
    };
    r1.name = "R2";
    r1.panes[0].id = "r2";
    const saved = bindPersistRequestData({
      schema_version: 1,
      workspaces: [],
      settings: {
        font_size: 14,
        line_height: 1.2,
        font_family: "monospace",
        theme_id: "default",
      },
      active_workspace_id: "workspace",
      active_pane_id: "r1",
      active_tab_id: "tab-r1",
    }, request);
    expect(saved.workspaces[0]).toMatchObject({
      name: "Workspace",
      panes: [{ pane_id: "r1", active_tab_id: "tab-r1" }],
    });
    expect(saved.workspaces[0].panes[0].pane_id).not.toBe("r2");
  });

  it("uses the autosave workspace serializer for request-bound persistence", () => {
    terminalMocks.hasTerminalBuffer.mockReturnValue(true);
    terminalMocks.getTerminalWriteCounter.mockReturnValue(9);
    terminalMocks.getTerminalBufferLines.mockReturnValue(["LIVE-SCROLLBACK-LINE"]);
    turnMarkMocks.getTurnMarkPersistSnapshot.mockReturnValue([
      { label: "live-turn", at: 7, lines_from_bottom: 2 },
    ]);

    const sourcePane = pane("bound");
    sourcePane.sessionId = "pane-session";
    sourcePane.tabs.push({
      ...tab("junk"),
      agentKind: "claude",
      agentSessionId: "C:/work/agent id",
      claudeSessionId: "C:/work/agent id",
    });
    sourcePane.tabs.push(tab("mapped"));
    const input = workspace([sourcePane], [[sourcePane.id]], [100], [[100]]);
    usePaneMetadataStore.setState({
      metadata: {
        "pane-session": { cwd: "C:\\metadata-cwd" },
      },
      volatileMetadata: {},
    });
    const mapping = {
      [sourcePane.tabs[2].id]: {
        agent_kind: "claude" as const,
        session_id: "11111111-1111-4111-8111-111111111111",
      },
    };
    const foreign = {
      ...toConfig(workspace([pane("foreign")], [["foreign"]], [100], [[100]])),
      id: "foreign-window",
      name: "Foreign window",
    };
    const autosaveOwn = applyMappingsToConfig(toConfig(input), mapping);
    const autosaveWorkspaces = dedupeAgentSessionsInConfigs(
      [autosaveOwn, foreign],
      input.id,
      sourcePane.id,
      sourcePane.tabs[0].id,
    ).configs;
    const captured = capturePersistRequestSnapshot(persistentLayoutProjection([input]));
    const request = {
      requestId: "request-parity",
      revision: 2,
      signature: persistentLayoutSignature([input]),
      ...captured,
      leaderGeneration: 3,
    };

    const saved = bindPersistRequestData({
      schema_version: 1,
      workspaces: autosaveWorkspaces,
      settings: {
        font_size: 14,
        line_height: 1.2,
        font_family: "monospace",
        theme_id: "default",
      },
      active_workspace_id: input.id,
      active_pane_id: sourcePane.id,
      active_tab_id: sourcePane.tabs[0].id,
    }, request, mapping);

    expect(saved.workspaces).toEqual(autosaveWorkspaces);
    expect(saved.workspaces.map((item) => item.id)).toEqual(["workspace", "foreign-window"]);
    expect(saved.workspaces[0].panes[0]).toMatchObject({
      cwd: "C:\\metadata-cwd",
    });
    expect(saved.workspaces[0].panes[0].tabs?.[0]).toMatchObject({
      terminal_snapshot: ["LIVE-SCROLLBACK-LINE"],
      turn_marks: [{ label: "live-turn", at: 7, lines_from_bottom: 2 }],
    });
    expect(saved.workspaces[0].panes[0].tabs?.[1]).toMatchObject({
      agent_session_id: null,
      claude_session_id: null,
    });
    expect(saved.workspaces[0].panes[0].tabs?.[2]).toMatchObject({
      agent_session_id: "11111111-1111-4111-8111-111111111111",
      claude_session_id: "11111111-1111-4111-8111-111111111111",
    });
  });
});

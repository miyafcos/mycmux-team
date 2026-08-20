import { describe, expect, it } from "vitest";
import { toConfig } from "../../src/components/layout/SocketListener";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
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
});

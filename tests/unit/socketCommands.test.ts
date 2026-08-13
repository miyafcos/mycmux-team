import { beforeEach, describe, expect, it } from "vitest";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import {
  clampPaneReadLines,
  findPaneBySessionId,
  handleSocketCommand,
  resolveSpawnPlan,
  resolveSpawnPanePlan,
  resolveSpawnTabPlan,
  serializePaneForSocket,
} from "../../src/components/layout/socketCommands";
import { liveTerms } from "../../src/components/terminal/terminalCache";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

describe("resolveSpawnPlan", () => {
  it("builds a generated handoff launch environment", () => {
    const plan = resolveSpawnPlan({
      target: "codex",
      handoffFromSessionId: "source-session",
      handoffFromKind: "claude",
      cwd: "C:\\repo",
      label: "Handoff",
    }, "C:\\handoffs\\task.md");

    expect(plan.mode).toBe("handoff");
    expect(plan.launchEnv).toEqual({
      MYCMUX_AGENT_KIND: "codex",
      MYCMUX_HANDOFF: "codex",
      MYCMUX_HANDOFF_PROMPT_FILE: "C:\\handoffs\\task.md",
      MYCMUX_HANDOFF_FROM_SESSION: "source-session",
      MYCMUX_HANDOFF_FROM: "claude",
    });
    expect(plan.paneOptions).toEqual({
      agentId: "shell-starter",
      cwd: "C:\\repo",
      label: "Handoff",
      launchEnv: plan.launchEnv,
    });
  });

  it("omits an empty handoff source kind", () => {
    const plan = resolveSpawnPlan({
      target: "claude",
      handoffFromSessionId: "source-session",
    }, "C:\\handoffs\\task.md");

    expect(plan.launchEnv).not.toHaveProperty("MYCMUX_HANDOFF_FROM");
  });

  it("builds a prompt-file handoff environment", () => {
    const plan = resolveSpawnPlan({
      target: "claude-codex",
      promptFile: "C:\\prompts\\task.md",
      fromSessionId: "external-pane",
      fromKind: "codex",
    });

    expect(plan.mode).toBe("prompt");
    expect(plan.launchEnv).toEqual({
      MYCMUX_AGENT_KIND: "claude-codex",
      MYCMUX_HANDOFF: "claude-codex",
      MYCMUX_HANDOFF_PROMPT_FILE: "C:\\prompts\\task.md",
      MYCMUX_HANDOFF_FROM_SESSION: "external-pane",
      MYCMUX_HANDOFF_FROM: "codex",
    });
  });

  it("defaults prompt-file source session to external", () => {
    const plan = resolveSpawnPlan({ target: "codex", promptFile: "task.md" });
    expect(plan.launchEnv?.MYCMUX_HANDOFF_FROM_SESSION).toBe("external");
  });

  it("builds a resume environment and pane metadata", () => {
    const plan = resolveSpawnPlan({ target: "claude", resumeSessionId: "resume-id" });

    expect(plan.mode).toBe("resume");
    expect(plan.launchEnv).toEqual({
      MYCMUX_AGENT_KIND: "claude",
      MYCMUX_RESUME: "claude",
      MYCMUX_SESSION_ID: "resume-id",
    });
    expect(plan.paneOptions.agentKind).toBe("claude");
    expect(plan.paneOptions.agentSessionId).toBe("resume-id");
  });

  it("builds a fresh agent launch environment", () => {
    const plan = resolveSpawnPlan({ target: "codex" });
    expect(plan.mode).toBe("launch");
    expect(plan.launchEnv).toEqual({ MYCMUX_LAUNCH_TARGET: "codex" });
  });

  it("builds a shell pane without a launch environment", () => {
    const plan = resolveSpawnPlan({ target: "shell" });
    expect(plan.mode).toBe("shell");
    expect(plan.launchEnv).toBeUndefined();
    expect(plan.paneOptions).toEqual({ agentId: "shell-starter" });
  });

  it("uses handoff before prompt and resume", () => {
    const plan = resolveSpawnPlan({
      target: "codex",
      handoffFromSessionId: "handoff-id",
      promptFile: "prompt.md",
      resumeSessionId: "resume-id",
    }, "generated.md");
    expect(plan.mode).toBe("handoff");
    expect(plan.launchEnv?.MYCMUX_HANDOFF_FROM_SESSION).toBe("handoff-id");
  });

  it("uses prompt before resume", () => {
    const plan = resolveSpawnPlan({
      target: "codex",
      promptFile: "prompt.md",
      resumeSessionId: "resume-id",
    });
    expect(plan.mode).toBe("prompt");
  });

  it("rejects shell prompt modes", () => {
    expect(() => resolveSpawnPlan({ target: "shell", promptFile: "prompt.md" }))
      .toThrow("pane.spawn prompt requires an agent target");
  });

  it("rejects a missing target", () => {
    expect(() => resolveSpawnPlan({ promptFile: "prompt.md" }))
      .toThrow("pane.spawn requires target");
  });
});

describe("resolveSpawnTabPlan", () => {
  it("builds a one-shot command tab without a launch environment", () => {
    const plan = resolveSpawnTabPlan({
      commandArgv: ["C:\\tasks\\run.cmd", "--result", "result.json"],
      cwd: "C:\\repo",
      label: "One shot",
    });

    expect(plan).toEqual({
      mode: "command",
      paneOptions: {
        agentId: "shell-starter",
        cwd: "C:\\repo",
        label: "One shot",
        commandArgv: ["C:\\tasks\\run.cmd", "--result", "result.json"],
      },
    });
    expect(plan.paneOptions).not.toHaveProperty("launchEnv");
  });

  it("accepts the snake_case command argv alias", () => {
    const plan = resolveSpawnTabPlan({ command_argv: ["cmd.exe", "/c", "run.cmd"] });
    expect(plan.paneOptions.commandArgv).toEqual(["cmd.exe", "/c", "run.cmd"]);
  });

  it("rejects invalid command argv values", () => {
    expect(() => resolveSpawnTabPlan({ commandArgv: [] })).toThrow();
    expect(() => resolveSpawnTabPlan({ commandArgv: ["cmd.exe", 1] })).toThrow();
  });

  // spawn-tab --detach routes to pane.spawn, so a raw-argv agent (the case the
  // detach flag exists for) has to survive that route too.
  it("accepts command argv on the split-pane route as well", () => {
    const plan = resolveSpawnPanePlan({
      commandArgv: ["agy", "-i", "spec"],
      cwd: "C:\\repo",
      label: "agy",
    });
    expect(plan).toEqual({
      mode: "command",
      paneOptions: {
        agentId: "shell-starter",
        cwd: "C:\\repo",
        label: "agy",
        commandArgv: ["agy", "-i", "spec"],
      },
    });
  });

  it("rejects command argv combined with a target on the split-pane route", () => {
    expect(() => resolveSpawnPanePlan({ commandArgv: ["agy"], target: "codex" })).toThrow();
  });

  it("rejects command argv combined with a target", () => {
    expect(() => resolveSpawnTabPlan({ commandArgv: ["cmd.exe"], target: "codex" }))
      .toThrow();
  });

  it("rejects a missing launch form", () => {
    expect(() => resolveSpawnTabPlan({ cwd: "C:\\repo" })).toThrow();
  });

  it("reuses prompt-mode handoff launch semantics", () => {
    const plan = resolveSpawnTabPlan({
      target: "codex",
      prompt_file: "C:\\prompts\\task.md",
      from_session_id: "source-tab",
    });
    expect(plan.mode).toBe("prompt");
    expect(plan.paneOptions.launchEnv).toEqual({
      MYCMUX_AGENT_KIND: "codex",
      MYCMUX_HANDOFF: "codex",
      MYCMUX_HANDOFF_PROMPT_FILE: "C:\\prompts\\task.md",
      MYCMUX_HANDOFF_FROM_SESSION: "source-tab",
    });
  });

  it("builds a plain shell tab", () => {
    expect(resolveSpawnTabPlan({ target: "shell" })).toEqual({
      mode: "shell",
      paneOptions: { agentId: "shell-starter" },
    });
  });
});

describe("findPaneBySessionId", () => {
  const paneA = {
    id: "pane-a",
    sessionId: "pane-session-a",
    tabs: [{ id: "tab-a", sessionId: "tab-session-a" }],
  } as Pane;
  const paneB = {
    id: "pane-b",
    sessionId: "pane-session-b",
    tabs: [{ id: "tab-b", sessionId: "tab-session-b" }],
  } as Pane;
  const workspaceA = { id: "workspace-a", panes: [paneA] } as Workspace;
  const workspaceB = { id: "workspace-b", panes: [paneB] } as Workspace;

  it("matches a pane session id", () => {
    expect(findPaneBySessionId([workspaceA], "pane-session-a"))
      .toEqual({ workspace: workspaceA, pane: paneA });
  });

  it("matches a tab session id", () => {
    expect(findPaneBySessionId([workspaceA], "tab-session-a"))
      .toEqual({ workspace: workspaceA, pane: paneA });
  });

  it("searches across workspaces", () => {
    expect(findPaneBySessionId([workspaceA, workspaceB], "tab-session-b"))
      .toEqual({ workspace: workspaceB, pane: paneB });
  });

  it("returns null for a miss", () => {
    expect(findPaneBySessionId([workspaceA, workspaceB], "missing-session")).toBeNull();
  });
});

describe("clampPaneReadLines", () => {
  it("defaults invalid values and clamps the requested range", () => {
    expect(clampPaneReadLines(undefined)).toBe(80);
    expect(clampPaneReadLines(Number.NaN)).toBe(80);
    expect(clampPaneReadLines(0)).toBe(1);
    expect(clampPaneReadLines(25.9)).toBe(25);
    expect(clampPaneReadLines(401)).toBe(400);
  });
});

function socketWorkspace(
  id: string,
  name: string,
  paneId: string,
  tabs: PaneTab[],
): Workspace {
  return {
    id,
    name,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: [{
      id: paneId,
      agentId: tabs[0].agentId,
      sessionId: tabs[0].sessionId,
      tabs,
      activeTabId: tabs[0].id,
    }],
  };
}

function socketPane(paneId: string): Pane {
  const tab: PaneTab = {
    id: `tab-${paneId}`,
    sessionId: `session-${paneId}`,
    agentId: "shell-starter",
    type: "terminal",
  };
  return {
    id: paneId,
    agentId: tab.agentId,
    sessionId: tab.sessionId,
    tabs: [tab],
    activeTabId: tab.id,
  };
}

function socketLayoutWorkspace(splitColumns: string[][]): Workspace {
  return {
    id: "workspace-layout",
    name: "Workspace Layout",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: ["pane-a", "pane-b", "pane-c"].map(socketPane),
    splitColumns,
  };
}

describe("pane socket responses", () => {
  beforeEach(() => {
    useWorkspaceListStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      lastActivePaneByWorkspace: {},
    });
    useUiStore.setState({ activePaneId: null });
    usePaneMetadataStore.setState({ metadata: {}, lastLog: {} });
    liveTerms.clear();
  });

  it("exposes tab identities, status freshness, and the active session", async () => {
    const liveTab: PaneTab = {
      id: "tab-live",
      sessionId: "session-live",
      agentId: "shell-starter",
      type: "terminal",
      claudeSessionId: "claude-session",
      agentKind: "claude",
      agentSessionId: "agent-session",
      lastProcess: "claude.exe",
    };
    const staleTab: PaneTab = {
      id: "tab-stale",
      sessionId: "session-stale",
      agentId: "shell-starter",
      type: "terminal",
    };
    const workspace = socketWorkspace(
      "workspace-a",
      "Workspace A",
      "pane-a",
      [liveTab, staleTab],
    );
    useWorkspaceListStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });
    useUiStore.setState({ activePaneId: staleTab.sessionId });
    usePaneMetadataStore.setState({
      metadata: {
        [liveTab.sessionId]: { agentStatus: "waiting", agentStatusAt: 123 },
        [staleTab.sessionId]: { processIsShell: false, agentStatusAt: 456 },
      },
    });
    liveTerms.set(liveTab.sessionId, {} as never);

    const result = await handleSocketCommand("pane.list", {}) as {
      activePaneId: string | null;
      activeSessionId: string | null;
      splitColumns: string[][];
      columnWidths: number[];
      rowHeightsPerCol: number[][];
      gridTemplateId: string;
      panes: Array<{
        active: boolean;
        tabs: Array<Record<string, unknown>>;
      }>;
    };

    expect(result.activePaneId).toBe(staleTab.sessionId);
    expect(result.activeSessionId).toBe(staleTab.sessionId);
    expect(result.splitColumns).toEqual([["pane-a"]]);
    expect(result.columnWidths).toEqual([1]);
    expect(result.rowHeightsPerCol).toEqual([[1]]);
    expect(result.gridTemplateId).toBe("1x1");
    expect(result.panes[0].active).toBe(true);
    expect(result.panes[0].tabs[0]).toMatchObject({
      sessionId: liveTab.sessionId,
      claudeSessionId: "claude-session",
      agentSessionId: "agent-session",
      lastProcess: "claude.exe",
      agentStatus: "waiting",
      agentStatusAt: 123,
      agentStatusStale: false,
      lastOutputAt: null,
    });
    expect(result.panes[0].tabs[1]).toMatchObject({
      sessionId: staleTab.sessionId,
      agentStatus: "working",
      agentStatusAt: 456,
      agentStatusStale: true,
      lastOutputAt: null,
    });
  });

  it("serializes process evidence independently from xterm visibility", () => {
    const tab: PaneTab = {
      id: "tab-background",
      sessionId: "session-background",
      agentId: "shell-starter",
      type: "terminal",
    };
    const workspace = socketWorkspace(
      "workspace-a",
      "Workspace A",
      "pane-a",
      [tab],
    );

    const serialized = serializePaneForSocket(workspace.panes[0], {
      activeSessionId: null,
      metadata: {},
      processMetadata: {
        [tab.sessionId]: {
          session_id: tab.sessionId,
          cwd: "C:\\repo",
          process_name: "codex.exe",
          process_status: "working",
          process_status_at: 1234,
          agent_active: true,
        },
      },
      processMetadataAvailable: true,
      lastOutputBySession: { [tab.sessionId]: 5678 },
      isTerminalMounted: () => false,
    });

    expect(serialized.tabs[0]).toMatchObject({
      processStatus: "working",
      processStatusAt: 1234,
      lastOutputAt: 5678,
      processStatusReason: null,
      screenStatus: null,
      screenStatusAt: null,
      screenObserved: false,
    });
  });

  it("does not synthesize a process timestamp for a fresh monitor baseline", () => {
    const tab: PaneTab = {
      id: "tab-background",
      sessionId: "session-background",
      agentId: "shell-starter",
      type: "terminal",
    };
    const workspace = socketWorkspace(
      "workspace-a",
      "Workspace A",
      "pane-a",
      [tab],
    );

    const serialized = serializePaneForSocket(workspace.panes[0], {
      activeSessionId: null,
      metadata: {},
      processMetadata: {
        [tab.sessionId]: {
          session_id: tab.sessionId,
          cwd: "C:\\repo",
          process_name: "codex.exe",
          process_status: "working",
          agent_active: true,
        },
      },
      processMetadataAvailable: true,
      lastOutputBySession: {},
      isTerminalMounted: () => false,
    });

    expect(serialized.tabs[0]).toMatchObject({
      processStatus: "working",
      processStatusAt: null,
      lastOutputAt: null,
      processStatusReason: null,
      screenObserved: false,
    });
  });

  it("reports an idle process status for a live shell tab", () => {
    const tab: PaneTab = {
      id: "tab-shell",
      sessionId: "session-shell",
      agentId: "shell-starter",
      type: "terminal",
    };
    const workspace = socketWorkspace("workspace-a", "Workspace A", "pane-a", [tab]);

    const serialized = serializePaneForSocket(workspace.panes[0], {
      activeSessionId: null,
      metadata: {},
      processMetadata: {
        [tab.sessionId]: {
          session_id: tab.sessionId,
          cwd: "C:\\repo",
          process_name: "pwsh.exe",
          process_status: "idle",
          process_status_at: 4321,
          agent_active: false,
        },
      },
      processMetadataAvailable: true,
      lastOutputBySession: {},
      isTerminalMounted: () => false,
    });

    expect(serialized.tabs[0]).toMatchObject({
      processStatus: "idle",
      processStatusAt: 4321,
      lastOutputAt: null,
      processStatusReason: null,
    });
  });

  it("explains a saved terminal tab that has no live PTY session", () => {
    const tab: PaneTab = {
      id: "tab-cold",
      sessionId: "session-cold",
      agentId: "codex",
      agentKind: "codex",
      type: "terminal",
    };
    const workspace = socketWorkspace("workspace-a", "Workspace A", "pane-a", [tab]);

    const serialized = serializePaneForSocket(workspace.panes[0], {
      activeSessionId: null,
      metadata: {},
      processMetadata: {},
      processMetadataAvailable: true,
      lastOutputBySession: {},
      isTerminalMounted: () => false,
    });

    expect(serialized.tabs[0]).toMatchObject({
      processStatus: null,
      processStatusAt: null,
      lastOutputAt: null,
      processStatusReason: "no_live_pty_session",
    });
  });

  it("distinguishes an unavailable process snapshot from a cold tab", () => {
    const tab: PaneTab = {
      id: "tab-unknown",
      sessionId: "session-unknown",
      agentId: "shell-starter",
      type: "terminal",
    };
    const workspace = socketWorkspace("workspace-a", "Workspace A", "pane-a", [tab]);

    const serialized = serializePaneForSocket(workspace.panes[0], {
      activeSessionId: null,
      metadata: {},
      processMetadata: {},
      processMetadataAvailable: false,
      lastOutputBySession: {},
      isTerminalMounted: () => false,
    });

    expect(serialized.tabs[0]).toMatchObject({
      processStatus: null,
      processStatusAt: null,
      lastOutputAt: null,
      processStatusReason: "snapshot_unavailable",
    });
  });

  it("returns stored layout metrics when they match the normalized layout", async () => {
    const workspace = socketWorkspace("workspace-a", "Workspace A", "pane-a", [{
      id: "tab-a",
      sessionId: "session-a",
      agentId: "shell-starter",
      type: "terminal",
    }]);
    workspace.splitColumns = [["pane-a"]];
    workspace.columnWidths = [2.5];
    workspace.rowHeightsPerCol = [[3.5]];
    useWorkspaceListStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });

    const result = await handleSocketCommand("pane.list", {}) as {
      splitColumns: string[][];
      columnWidths: number[];
      rowHeightsPerCol: number[][];
      gridTemplateId: string;
    };

    expect(result).toMatchObject({
      splitColumns: [["pane-a"]],
      columnWidths: [2.5],
      rowHeightsPerCol: [[3.5]],
      gridTemplateId: "1x1",
    });
  });

  it("lists panes across every workspace with their owning workspace", async () => {
    const workspaceA = socketWorkspace("workspace-a", "Workspace A", "pane-a", [{
      id: "tab-a",
      sessionId: "session-a",
      agentId: "shell-starter",
      type: "terminal",
    }]);
    const workspaceB = socketWorkspace("workspace-b", "Workspace B", "pane-b", [{
      id: "tab-b",
      sessionId: "session-b",
      agentId: "shell-starter",
      type: "terminal",
    }]);
    workspaceA.splitColumns = [["pane-a"]];
    workspaceA.columnWidths = [2];
    workspaceA.rowHeightsPerCol = [[3]];
    useWorkspaceListStore.setState({
      workspaces: [workspaceA, workspaceB],
      activeWorkspaceId: workspaceB.id,
    });
    useUiStore.setState({ activePaneId: "session-b" });

    const result = await handleSocketCommand("pane.list_all", {}) as {
      activeWorkspaceId: string | null;
      workspaces: Array<{
        workspaceId: string;
        workspaceName: string;
        splitColumns: string[][];
        columnWidths: number[];
        rowHeightsPerCol: number[][];
        gridTemplateId: string;
      }>;
      panes: Array<{
        workspaceId: string;
        workspaceName: string;
        active: boolean;
        tabs: Array<{ sessionId: string; lastOutputAt: number | null }>;
      }>;
    };

    expect(result.activeWorkspaceId).toBe(workspaceB.id);
    expect(result.workspaces).toEqual([
      {
        workspaceId: "workspace-a",
        workspaceName: "Workspace A",
        splitColumns: [["pane-a"]],
        columnWidths: [2],
        rowHeightsPerCol: [[3]],
        gridTemplateId: "1x1",
      },
      {
        workspaceId: "workspace-b",
        workspaceName: "Workspace B",
        splitColumns: [["pane-b"]],
        columnWidths: [1],
        rowHeightsPerCol: [[1]],
        gridTemplateId: "1x1",
      },
    ]);
    expect(result.panes.map((pane) => [pane.workspaceId, pane.workspaceName])).toEqual([
      ["workspace-a", "Workspace A"],
      ["workspace-b", "Workspace B"],
    ]);
    expect(result.panes.map((pane) => pane.tabs[0].sessionId)).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(result.panes.map((pane) => pane.tabs[0].lastOutputAt)).toEqual([null, null]);
    expect(result.panes.map((pane) => pane.active)).toEqual([false, true]);
  });

  it("renames a tab by session without changing the active session", async () => {
    const firstTab: PaneTab = {
      id: "tab-a",
      sessionId: "session-a",
      agentId: "shell-starter",
      type: "terminal",
    };
    const secondTab: PaneTab = {
      id: "tab-b",
      sessionId: "session-b",
      agentId: "shell-starter",
      type: "terminal",
    };
    const workspace = socketWorkspace("workspace-a", "Workspace A", "pane-a", [firstTab, secondTab]);
    useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });

    const result = await handleSocketCommand("pane.rename_tab", {
      sessionId: secondTab.sessionId,
      label: "  Review notes  ",
    });

    expect(result).toEqual({
      workspaceId: workspace.id,
      paneId: workspace.panes[0].id,
      tabId: secondTab.id,
      sessionId: secondTab.sessionId,
      label: "Review notes",
    });
    const storedPane = useWorkspaceListStore.getState().getWorkspace(workspace.id)!.panes[0];
    expect(storedPane.activeTabId).toBe(firstTab.id);
    expect(storedPane.sessionId).toBe(firstTab.sessionId);
    expect(storedPane.tabs.map((tab) => tab.label)).toEqual([undefined, "Review notes"]);
  });

  it("clears an explicit tab label when rename receives an empty string", async () => {
    const tab: PaneTab = {
      id: "tab-a",
      sessionId: "session-a",
      agentId: "shell-starter",
      type: "terminal",
      label: "Explicit",
    };
    const workspace = socketWorkspace("workspace-a", "Workspace A", "pane-a", [tab]);
    useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });

    await expect(handleSocketCommand("pane.rename_tab", { sessionId: tab.sessionId, label: "" })).resolves.toMatchObject({ label: null });
    expect(useWorkspaceListStore.getState().getWorkspace(workspace.id)!.panes[0].tabs[0].label).toBeUndefined();
  });

  it("rejects rename requests that do not identify a known session", async () => {
    await expect(handleSocketCommand("pane.rename_tab", { label: "Name" })).rejects.toThrow("pane.rename_tab requires sessionId");
    await expect(handleSocketCommand("pane.rename_tab", { sessionId: "missing", label: "Name" })).rejects.toThrow("pane.rename_tab session not found");
  });

  it("moves a pane by session through normalized columns without replacing the pane", async () => {
    const workspace = socketLayoutWorkspace([
      ["pane-a", "ghost"],
      [],
      ["pane-b", "pane-a"],
      ["pane-c"],
    ]);
    const originalPane = workspace.panes[1];
    useWorkspaceListStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });

    const result = await handleSocketCommand("pane.move", {
      sessionId: "session-pane-b",
      toColumn: 0,
      toRow: 0,
    }) as { workspaceId: string; paneId: string; splitColumns: string[][] };

    expect(result).toEqual({
      workspaceId: workspace.id,
      paneId: "pane-b",
      splitColumns: [["pane-b", "pane-a"], ["pane-c"]],
    });
    const stored = useWorkspaceListStore.getState().getWorkspace(workspace.id)!;
    expect(stored.panes.find((pane) => pane.id === "pane-b")).toBe(originalPane);
    expect(stored.panes.find((pane) => pane.id === "pane-b")?.sessionId)
      .toBe("session-pane-b");
  });

  it("appends an out-of-range row to the selected column", async () => {
    const workspace = socketLayoutWorkspace([["pane-a", "pane-b"], ["pane-c"]]);
    useWorkspaceListStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });

    const result = await handleSocketCommand("pane.move", {
      paneId: "pane-a",
      toColumn: 1,
      toRow: 99,
    }) as { splitColumns: string[][] };

    expect(result.splitColumns).toEqual([["pane-b"], ["pane-c", "pane-a"]]);
  });

  it("appends a column that is out of range after collapsing the empty source column", async () => {
    const workspace = socketLayoutWorkspace([["pane-a"], ["pane-b", "pane-c"]]);
    useWorkspaceListStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });

    const result = await handleSocketCommand("pane.move", {
      sessionId: "session-pane-a",
      toColumn: 1,
      toRow: 99,
    }) as { splitColumns: string[][] };

    expect(result.splitColumns).toEqual([["pane-b", "pane-c"], ["pane-a"]]);
  });
});

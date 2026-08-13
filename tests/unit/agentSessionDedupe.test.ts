import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetAgentSessionDedupeReporterForTests,
  collectWorkspaceConfigSessionIds,
  dedupeAgentSessionsInConfigs,
  reportAgentSessionDedupeConflicts,
  toConfig,
  type AgentSessionDedupeConflict,
} from "../../src/components/layout/SocketListener";
import type { PaneConfig, WorkspaceConfig } from "../../src/lib/ipc";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";
import { buildClonedDuplicateSessionPaneOptions } from "../../src/lib/duplicateSession";
import type { Workspace } from "../../src/types";

function paneConfig(
  paneId: string,
  tabId: string,
  kind: "claude" | "codex" = "claude",
  sessionId = "shared-session",
): PaneConfig {
  return {
    pane_id: paneId,
    agent_id: kind === "claude" ? "claude-code" : "codex",
    label: null,
    agent_kind: kind,
    agent_session_id: sessionId,
    claude_session_id: kind === "claude" ? sessionId : null,
    active_tab_id: tabId,
    tabs: [{
      tab_id: tabId,
      agent_id: kind === "claude" ? "claude-code" : "codex",
      type: "terminal",
      agent_kind: kind,
      agent_session_id: sessionId,
      claude_session_id: kind === "claude" ? sessionId : null,
      terminal_snapshot: ["saved output"],
    }],
  };
}

function workspaceConfig(panes: PaneConfig[]): WorkspaceConfig {
  return {
    id: "workspace",
    name: "Workspace",
    grid_template_id: "2x1",
    panes,
    created_at: 1,
  };
}

beforeEach(() => {
  __resetAgentSessionDedupeReporterForTests();
  __resetToastStoreForTests();
});

describe("collectWorkspaceConfigSessionIds", () => {
  it("returns only deduplicated pane and tab PTY ids", () => {
    const config = workspaceConfig([
      paneConfig("pane-a", "tab-a"),
      paneConfig("pane-b", "tab-b"),
    ]);

    expect(collectWorkspaceConfigSessionIds([config])).toEqual([
      "pty-workspace-pane-a",
      "pty-workspace-pane-a-tab-a",
      "pty-workspace-pane-b",
      "pty-workspace-pane-b-tab-b",
    ]);
  });
});

describe("dedupeAgentSessionsInConfigs", () => {
  it.each([
    ["claude", "claude-code"],
    ["codex", "codex"],
    ["claude-codex", "shell-starter"],
  ] as const)("round-trips cloned %s sessions through persistence and restore", (agentKind, agentId) => {
    const cloned = buildClonedDuplicateSessionPaneOptions({
      agentKind,
      agentSessionId: "source-session",
      label: "Source task",
    }, {
      agent_kind: agentKind,
      source_session_id: "source-session",
      new_session_id: `${agentKind}-cloned-session`,
      resolved_cwd: "C:\\cloned",
    });
    const workspace: Workspace = {
      id: "workspace",
      name: "Workspace",
      gridTemplateId: "1x1",
      panes: [{
        id: "pane",
        sessionId: "pty-pane",
        agentId: cloned.agentId,
        tabs: [{
          id: "tab",
          sessionId: "pty-tab",
          agentId: cloned.agentId,
          type: "terminal",
          agentKind: cloned.agentKind,
          agentSessionId: cloned.agentSessionId,
        }],
        activeTabId: "tab",
      }],
      status: "running",
      createdAt: 1,
      splitColumns: [["pane"]],
    };

    const saved = toConfig(workspace);
    const savedTab = saved.panes[0].tabs![0];
    expect([savedTab.agent_id, savedTab.agent_kind, savedTab.agent_session_id])
      .toEqual([agentId, agentKind, cloned.agentSessionId]);

    const restored = useWorkspaceLayoutStore.getState().restorePanes("workspace", saved.panes, [[0]], "1x1");
    const restoredTab = restored.panes[0].tabs[0];
    expect([restoredTab.agentId, restoredTab.agentKind, restoredTab.agentSessionId])
      .toEqual([agentId, agentKind, cloned.agentSessionId]);
  });

  it("keeps the active owner and parks the losing restore identity", () => {
    const firstPane = paneConfig("pane-first", "tab-first");
    firstPane.tabs![0].suppressed_agent_sessions = [{
      agent_kind: "codex",
      agent_session_id: "previously-parked",
      claude_session_id: null,
    }];
    const result = dedupeAgentSessionsInConfigs(
      [workspaceConfig([
        firstPane,
        paneConfig("pane-active", "tab-active"),
      ])],
      "workspace",
      "pane-active",
      "tab-active",
    );

    const first = result.configs[0].panes[0].tabs![0];
    const active = result.configs[0].panes[1].tabs![0];
    expect(first.agent_session_id).toBeNull();
    expect(first.claude_session_id).toBeNull();
    expect(first.terminal_snapshot).toBeNull();
    expect(first.suppressed_agent_sessions).toEqual([
      {
        agent_kind: "codex",
        agent_session_id: "previously-parked",
        claude_session_id: null,
      },
      {
        agent_kind: "claude",
        agent_session_id: "shared-session",
        claude_session_id: "shared-session",
      },
    ]);
    expect(active.agent_session_id).toBe("shared-session");
    expect(result.conflicts).toEqual([{
      key: "claude:shared-session",
      reason: "active",
      winner: { workspaceId: "workspace", paneId: "pane-active", tabId: "tab-active" },
      loser: { workspaceId: "workspace", paneId: "pane-first", tabId: "tab-first" },
    }]);
  });

  it("keeps the first owner without an active preference and allows different kinds", () => {
    const duplicate = dedupeAgentSessionsInConfigs(
      [workspaceConfig([
        paneConfig("pane-first", "tab-first"),
        paneConfig("pane-second", "tab-second"),
      ])],
      null,
      null,
      null,
    );
    expect(duplicate.configs[0].panes[0].tabs![0].agent_session_id).toBe("shared-session");
    expect(duplicate.configs[0].panes[1].tabs![0].agent_session_id).toBeNull();
    expect(duplicate.conflicts[0].reason).toBe("order");

    const differentKinds = dedupeAgentSessionsInConfigs(
      [workspaceConfig([
        paneConfig("pane-claude", "tab-claude", "claude"),
        paneConfig("pane-codex", "tab-codex", "codex"),
      ])],
      null,
      null,
      null,
    );
    expect(differentKinds.conflicts).toEqual([]);
    expect(differentKinds.configs[0].panes[1].tabs![0].agent_session_id).toBe("shared-session");
  });

  it("keeps a self-owned session over a later non-active duplicate", () => {
    const result = dedupeAgentSessionsInConfigs(
      [workspaceConfig([
        paneConfig("pane-first", "tab-first"),
        paneConfig("pane-self", "shared-session"),
      ])],
      null,
      null,
      null,
    );

    const first = result.configs[0].panes[0].tabs![0];
    const selfOwned = result.configs[0].panes[1].tabs![0];
    expect(first.agent_session_id).toBeNull();
    expect(selfOwned.agent_session_id).toBe("shared-session");
    expect(result.conflicts).toEqual([{
      key: "claude:shared-session",
      reason: "self-owned",
      winner: { workspaceId: "workspace", paneId: "pane-self", tabId: "shared-session" },
      loser: { workspaceId: "workspace", paneId: "pane-first", tabId: "tab-first" },
    }]);
  });

  it("bounds parked history to the five most recent unique identities", () => {
    const loser = paneConfig("pane-loser", "tab-loser");
    loser.tabs![0].suppressed_agent_sessions = Array.from({ length: 5 }, (_, index) => ({
      agent_kind: "codex" as const,
      agent_session_id: `old-${index}`,
      claude_session_id: null,
    }));
    const result = dedupeAgentSessionsInConfigs(
      [workspaceConfig([loser, paneConfig("pane-winner", "tab-winner")])],
      "workspace",
      "pane-winner",
      "tab-winner",
    );

    const parked = result.configs[0].panes[0].tabs![0].suppressed_agent_sessions!;
    expect(parked).toHaveLength(5);
    expect(parked.map((value) => value.agent_session_id)).toEqual([
      "old-1",
      "old-2",
      "old-3",
      "old-4",
      "shared-session",
    ]);
  });

  it("reports a continuing conflict once and reports it again after resolution", () => {
    const conflict: AgentSessionDedupeConflict = {
      key: "claude:shared-session",
      reason: "active",
      winner: { workspaceId: "workspace", paneId: "pane-a", tabId: "tab-a" },
      loser: { workspaceId: "workspace", paneId: "pane-b", tabId: "tab-b" },
    };
    reportAgentSessionDedupeConflicts([conflict]);
    reportAgentSessionDedupeConflicts([conflict]);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    reportAgentSessionDedupeConflicts([]);
    reportAgentSessionDedupeConflicts([conflict]);
    expect(useToastStore.getState().toasts).toHaveLength(2);
  });

  it("round-trips a parked identity without making it restorable", () => {
    const parked = paneConfig("pane", "tab");
    parked.agent_kind = null;
    parked.agent_session_id = null;
    parked.claude_session_id = null;
    parked.tabs![0].agent_kind = null;
    parked.tabs![0].agent_session_id = null;
    parked.tabs![0].claude_session_id = null;
    parked.tabs![0].suppressed_agent_sessions = [{
      agent_kind: "claude",
      agent_session_id: "parked-session",
      claude_session_id: "parked-session",
    }];

    const restored = useWorkspaceLayoutStore.getState().restorePanes(
      "workspace",
      [parked],
      [[0]],
      "1x1",
    );
    const tab = restored.panes[0].tabs[0];
    expect(tab.agentSessionId).toBeUndefined();
    expect(tab.suppressedAgentSessions).toEqual([{
      agentKind: "claude",
      agentSessionId: "parked-session",
      claudeSessionId: "parked-session",
    }]);

    const workspace: Workspace = {
      id: "workspace",
      name: "Workspace",
      gridTemplateId: "1x1",
      panes: restored.panes,
      status: "running",
      createdAt: 1,
      splitColumns: restored.splitColumns,
    };
    const saved = toConfig(workspace);
    expect(saved.panes[0].tabs![0].agent_session_id).toBeNull();
    expect(saved.panes[0].tabs![0].suppressed_agent_sessions?.[0].agent_session_id).toBe("parked-session");
  });
});

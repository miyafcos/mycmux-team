import { describe, expect, it } from "vitest";
import type { PaneConfig } from "../../src/lib/ipc";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { onlineStrings } from "../../src/components/online/onlineStrings";
import {
  collectOpenAgentSessions,
  collectOpenAgentIdentityKeys,
  filterAndSortSavepoints,
  isClosedSavepoint,
  isCurrentSavepoint,
  isFinalSavepoint,
  isTrashedSavepoint,
  type OnlineSavepointEntry,
} from "../../src/components/online/onlineSavepoints";

function entry(overrides: Partial<OnlineSavepointEntry>): OnlineSavepointEntry {
  return {
    bundle_dir: "C:/online/default",
    author: "default",
    machine: "machine",
    summary_line: "default summary",
    cwd: "C:/work/default",
    created_at: "2026-07-11T00:00:00Z",
    updated_at: "2026-07-11T00:00:00Z",
    expires_at: "2026-07-13T00:00:00Z",
    pinned: false,
    warnings_count: 0,
    claude_session_id: "session",
    files_written_count: 0,
    handoff_path: "C:/online/default/handoff.md",
    ...overrides,
  };
}

describe("filterAndSortSavepoints", () => {
  it("filters case-insensitively and sorts pinned entries before newer entries", () => {
    const entries = [
      entry({ bundle_dir: "new", author: "Alice", updated_at: "2026-07-11T12:00:00Z" }),
      entry({ bundle_dir: "pinned", author: "ALICE", pinned: true, updated_at: "2026-07-10T12:00:00Z" }),
      entry({ bundle_dir: "other", author: "Bob", updated_at: "2026-07-12T12:00:00Z" }),
    ];

    expect(filterAndSortSavepoints(entries, "alice").map((item) => item.bundle_dir))
      .toEqual(["pinned", "new"]);
  });

  it("separates saved items from trash and orders trash by deletion time", () => {
    const entries = [
      entry({ bundle_dir: "active", updated_at: "2026-07-14T12:00:00Z" }),
      entry({
        bundle_dir: "trash-old",
        trash_id: "trash-old",
        deleted_at: "2026-07-13T12:00:00Z",
      }),
      entry({
        bundle_dir: "trash-new",
        trash_id: "trash-new",
        deleted_at: "2026-07-14T13:00:00Z",
      }),
    ];

    expect(filterAndSortSavepoints(entries, "", "active").map((item) => item.bundle_dir))
      .toEqual(["active"]);
    expect(filterAndSortSavepoints(entries, "", "trash").map((item) => item.bundle_dir))
      .toEqual(["trash-new", "trash-old"]);
    expect(isTrashedSavepoint(entries[1])).toBe(true);
    expect(isTrashedSavepoint(entry({ trash_id: "trash-without-date", deleted_at: "" }))).toBe(true);
  });
});

describe("savepoint record kinds", () => {
  it("treats legacy entries as current and finalized entries as immutable", () => {
    expect(isCurrentSavepoint(entry({}))).toBe(true);
    expect(isFinalSavepoint(entry({ record_kind: "final", lifecycle_status: "closed" }))).toBe(true);
    expect(isCurrentSavepoint(entry({ record_kind: "current", lifecycle_status: "closed" }))).toBe(false);
    expect(isClosedSavepoint(entry({ record_kind: "current", lifecycle_status: "closed" }))).toBe(true);
  });
});

describe("restored handoff panel labels", () => {
  it("migrates the legacy Online label to the Japanese panel name", () => {
    const config: PaneConfig = {
      pane_id: "pane-online",
      agent_id: "shell",
      label: null,
      agent_kind: null,
      agent_session_id: null,
      claude_session_id: null,
      active_tab_id: "tab-online",
      tabs: [{
        tab_id: "tab-online",
        agent_id: "shell",
        type: "online" as never,
        label: "Online",
      }],
    };

    const restored = useWorkspaceLayoutStore.getState().restorePanes(
      "workspace",
      [config],
      [[0]],
      "1x1",
    );

    expect(restored.panes[0].tabs[0].label).toBe(onlineStrings.panelTitle);
  });
});

describe("collectOpenAgentIdentityKeys", () => {
  it("prefers metadata ids, skips missing ids, and deduplicates", () => {
    const workspaces = [{
      panes: [{
        tabs: [
          { sessionId: "metadata-tab", claudeSessionId: "stale-tab-id" },
          { sessionId: "tab-only", claudeSessionId: "shared-id" },
          { sessionId: "duplicate", claudeSessionId: "shared-id" },
          { sessionId: "codex-tab", agentKind: "codex", agentSessionId: "shared-id" },
          { sessionId: "missing" },
        ],
      }],
    }];

    const result = collectOpenAgentIdentityKeys(workspaces, {
      "metadata-tab": { agentKind: "claude", agentSessionId: "metadata-id" },
    });

    expect([...result]).toEqual([
      "claude:metadata-id",
      "claude:shared-id",
      "codex:shared-id",
    ]);
  });
});

describe("collectOpenAgentSessions", () => {
  it("collects live Claude sessions across workspaces and preserves missing ids", () => {
    const workspaces = [
      {
        id: "workspace-one",
        name: "Workspace One",
        panes: [{
          label: "Primary pane",
          cwd: "C:/pane-one",
          tabs: [
            { id: "tab-a", sessionId: "terminal-a", agentId: "shell-starter", cwd: "C:/tab-one" },
            { id: "tab-shell", sessionId: "terminal-shell", agentId: "shell" },
          ],
        }],
      },
      {
        panes: [{
          tabs: [{ id: "tab-b", sessionId: "terminal-b", agentId: "shell-starter", claudeSessionId: "tab-id" }],
        }],
      },
    ];

    expect(collectOpenAgentSessions(workspaces, {
      "terminal-a": {
        agentKind: "claude",
        agentSessionId: "live-id",
        cwd: "C:/live/project",
        gitBranch: "master",
        processTitle: "claude",
      },
      "terminal-shell": { agentKind: "codex", cwd: "C:/shell" },
      "terminal-b": { agentKind: "claude", cwd: "C:/second/project" },
    })).toEqual([
      {
        terminalSessionId: "terminal-a",
        tabId: "tab-a",
        paneId: undefined,
        title: "Primary pane",
        cwd: "C:/live/project",
        agentKind: "claude",
        agentSessionId: "live-id",
        status: "running",
        workspaceId: "workspace-one",
        workspaceName: "Workspace One",
        gitBranch: "master",
      },
      {
        terminalSessionId: "terminal-shell",
        tabId: "tab-shell",
        paneId: undefined,
        title: "Primary pane",
        cwd: "C:/shell",
        agentKind: "codex",
        agentSessionId: undefined,
        status: "running",
        workspaceId: "workspace-one",
        workspaceName: "Workspace One",
        gitBranch: undefined,
      },
      {
        terminalSessionId: "terminal-b",
        tabId: "tab-b",
        paneId: undefined,
        title: "second / project",
        cwd: "C:/second/project",
        agentKind: "claude",
        agentSessionId: "tab-id",
        status: "running",
        workspaceId: undefined,
        workspaceName: undefined,
        gitBranch: undefined,
      },
    ]);
  });

  it("carries the owning workspace id so callers can jump back to the right workspace", () => {
    const workspaces = [
      {
        id: "ws-jump",
        panes: [{
          tabs: [{ id: "tab-jump", sessionId: "terminal-jump", agentId: "shell-starter" }],
        }],
      },
    ];

    const [session] = collectOpenAgentSessions(workspaces, {
      "terminal-jump": { agentKind: "claude", cwd: "C:/jump" },
    });
    expect(session.workspaceId).toBe("ws-jump");
  });

  it("carries the owning pane id so click-to-jump can activate the right tab", () => {
    const workspaces = [
      {
        id: "ws-pane-jump",
        panes: [{
          id: "pane-jump",
          tabs: [{ id: "tab-jump", sessionId: "terminal-jump", agentId: "shell-starter" }],
        }],
      },
    ];

    const [session] = collectOpenAgentSessions(workspaces, {
      "terminal-jump": { agentKind: "claude", cwd: "C:/jump" },
    });
    expect(session.paneId).toBe("pane-jump");
    expect(session.tabId).toBe("tab-jump");
  });

  it("never uses processTitle as the row title", () => {
    const workspaces = [{
      panes: [{
        tabs: [{ id: "tab-n", sessionId: "terminal-n", agentId: "shell-starter" }],
      }],
    }];

    const [session] = collectOpenAgentSessions(workspaces, {
      "terminal-n": { agentKind: "claude", cwd: "C:/deep/project", processTitle: "node.exe" },
    });
    expect(session.title).toBe("deep / project");
  });

  it("lists dormant tabs with persisted claude markers when no metadata exists", () => {
    const workspaces = [{
      name: "WS",
      panes: [{
        cwd: "C:/pane",
        tabs: [
          { id: "tab-1", sessionId: "t1", agentId: "shell-starter", claudeSessionId: "persisted-id" },
          { id: "tab-2", sessionId: "t2", agentId: "claude-code" },
          { id: "tab-3", sessionId: "t3", agentId: "shell-starter", agentKind: "claude" },
          { id: "tab-4", sessionId: "t4", agentId: "shell-starter" },
        ],
      }],
    }];

    const sessions = collectOpenAgentSessions(workspaces, {});
    expect(sessions.map((session) => session.terminalSessionId)).toEqual(["t1", "t2", "t3"]);
    expect(sessions.every((session) => session.status === "dormant")).toBe(true);
    expect(sessions[0].agentKind).toBe("claude");
    expect(sessions[0].agentSessionId).toBe("persisted-id");
    expect(sessions[1].agentSessionId).toBeUndefined();
  });

  it("lists tabs as dormant when live metadata is not claude but persisted markers exist", () => {
    // After a restart the pane's shell reports metadata within one poller
    // tick; the persisted claude marker must keep the row visible (dormant)
    // instead of vanishing ~5s after startup.
    const workspaces = [{
      panes: [{
        tabs: [{ id: "tab-x", sessionId: "tx", agentId: "claude-code", claudeSessionId: "old-id" }],
      }],
    }];

    const sessions = collectOpenAgentSessions(workspaces, {
      tx: { cwd: "C:/back-to-shell" },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("dormant");
    expect(sessions[0].agentSessionId).toBe("old-id");
    expect(sessions[0].cwd).toBe("C:/back-to-shell");
  });

  it("collects live Codex sessions even without persisted tab markers", () => {
    const workspaces = [{
      panes: [{
        tabs: [{ id: "tab-y", sessionId: "ty", agentId: "shell-starter" }],
      }],
    }];

    expect(collectOpenAgentSessions(workspaces, {
      ty: { agentKind: "codex", agentSessionId: "codex-id", cwd: "C:/codex" },
    })).toEqual([expect.objectContaining({
      terminalSessionId: "ty",
      agentKind: "codex",
      agentSessionId: "codex-id",
      status: "running",
    })]);
  });

  it("orders running sessions before dormant ones and dedupes by terminal session", () => {
    const workspaces = [
      {
        panes: [{
          tabs: [
            { id: "d1", sessionId: "dormant-1", agentId: "claude-code" },
            { id: "r1", sessionId: "running-1", agentId: "shell-starter" },
          ],
        }],
      },
      {
        panes: [{
          tabs: [{ id: "dup", sessionId: "running-1", agentId: "shell-starter" }],
        }],
      },
    ];

    const sessions = collectOpenAgentSessions(workspaces, {
      "running-1": { agentKind: "claude", cwd: "C:/live" },
    });
    expect(sessions.map((session) => `${session.terminalSessionId}:${session.status}`))
      .toEqual(["running-1:running", "dormant-1:dormant"]);
  });
});

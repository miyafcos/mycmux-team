import { describe, expect, it } from "vitest";
import { makeSessionId } from "../../src/lib/constants";
import {
  filterConflictingAgentMappings,
  resolvePersistedSelection,
} from "../../src/lib/sessionRestoreSafety";
import type { WorkspaceConfig } from "../../src/lib/ipc";

function workspaceConfig(): WorkspaceConfig {
  return {
    id: "workspace-1",
    name: "Workspace",
    grid_template_id: "2x1",
    created_at: 1,
    panes: [
      {
        pane_id: "pane-owner",
        agent_id: "claude-code",
        label: null,
        active_tab_id: "tab-owner",
        agent_kind: "claude",
        agent_session_id: "session-a",
        claude_session_id: "session-a",
        tabs: [{
          tab_id: "tab-owner",
          agent_id: "claude-code",
          type: "terminal",
          agent_kind: "claude",
          agent_session_id: "session-a",
          claude_session_id: "session-a",
        }],
      },
      {
        pane_id: "pane-empty",
        agent_id: "claude-code",
        label: null,
        active_tab_id: "tab-empty",
        tabs: [{ tab_id: "tab-empty", agent_id: "claude-code", type: "terminal" }],
      },
    ],
  };
}

describe("filterConflictingAgentMappings", () => {
  it("keeps the explicit owner and rejects a duplicate cache mapping", () => {
    const config = workspaceConfig();
    const ownerKey = makeSessionId("workspace-1", "pane-owner-tab-owner");
    const emptyKey = makeSessionId("workspace-1", "pane-empty-tab-empty");
    const filtered = filterConflictingAgentMappings([config], {
      [ownerKey]: { agent_kind: "claude", session_id: "session-a" },
      [emptyKey]: { agent_kind: "claude", session_id: "session-a" },
    });

    expect(filtered[ownerKey]?.session_id).toBe("session-a");
    expect(filtered[emptyKey]).toBeUndefined();
  });

  it("keeps an unclaimed cache mapping for recovery", () => {
    const config = workspaceConfig();
    const emptyKey = makeSessionId("workspace-1", "pane-empty-tab-empty");
    const filtered = filterConflictingAgentMappings([config], {
      [emptyKey]: { agent_kind: "claude", session_id: "session-b" },
    });

    expect(filtered[emptyKey]?.session_id).toBe("session-b");
  });
});

describe("resolvePersistedSelection", () => {
  it("falls back to the last terminal when the active online pane is omitted", () => {
    const config = workspaceConfig();
    const selection = resolvePersistedSelection(
      [config],
      { workspaceId: "workspace-1", paneId: "online-pane", tabId: "online-tab" },
      { workspaceId: "workspace-1", paneId: "pane-owner", tabId: "tab-owner" },
    );

    expect(selection).toEqual({
      workspaceId: "workspace-1",
      paneId: "pane-owner",
      tabId: "tab-owner",
    });
  });

  it("falls back across workspaces when the active online pane is omitted", () => {
    const first = workspaceConfig();
    const second = workspaceConfig();
    second.id = "workspace-2";
    second.panes[0].pane_id = "pane-last-terminal";
    second.panes[0].active_tab_id = "tab-last-terminal";
    second.panes[0].tabs![0].tab_id = "tab-last-terminal";
    const selection = resolvePersistedSelection(
      [first, second],
      { workspaceId: "workspace-1", paneId: "online-pane", tabId: "online-tab" },
      {
        workspaceId: "workspace-2",
        paneId: "pane-last-terminal",
        tabId: "tab-last-terminal",
      },
    );

    expect(selection).toEqual({
      workspaceId: "workspace-2",
      paneId: "pane-last-terminal",
      tabId: "tab-last-terminal",
    });
  });
});

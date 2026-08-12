import { describe, expect, it } from "vitest";
import {
  applyMappingsToConfig,
  dedupeAgentSessionsInConfigs,
  isJunkAgentSessionId,
} from "../../src/components/layout/SocketListener";
import type { PaneConfig, WorkspaceConfig } from "../../src/lib/ipc";

// The exact junk shape that reached the persisted config: the handoff branches
// wrote "<kind>-handoff:<source pane id>" into the pane mapping file, and the
// pre-fix reader surfaced the whole line as a session id.
const JUNK_SESSION_ID =
  "claude-handoff:pty-75da675d-8076-4086-8235-67aff0ce61e5-802524c0-4990-44a8-b3cf-5d2dbb1634b2-dbb8059e-7430-4fe7-be6a-92cb048407bf";

// Real ids, sampled from ~/.mycmux/pane-sessions: claude writes UUIDv4, codex
// writes UUIDv7. Neither may be discarded by the junk filter.
const CLAUDE_SESSION_ID = "561f2273-4b78-4558-b460-6cb8804a5664";
const CODEX_SESSION_ID = "019fe63e-4417-7c62-89bd-c4a3f0e6a70f";

function workspaceConfig(panes: PaneConfig[]): WorkspaceConfig {
  return {
    id: "workspace",
    name: "Workspace",
    grid_template_id: "1x1",
    panes,
    created_at: 1,
  };
}

describe("isJunkAgentSessionId", () => {
  it("rejects ids carrying characters no agent id contains", () => {
    expect(isJunkAgentSessionId(JUNK_SESSION_ID)).toBe(true);
    expect(isJunkAgentSessionId("codex-handoff:pty-abc")).toBe(true);
    expect(isJunkAgentSessionId("has space")).toBe(true);
    expect(isJunkAgentSessionId("C:/repo/session")).toBe(true);
    expect(isJunkAgentSessionId("C:\\repo\\session")).toBe(true);
    expect(isJunkAgentSessionId("trailing\n")).toBe(true);
  });

  it("keeps real claude and codex ids", () => {
    expect(isJunkAgentSessionId(CLAUDE_SESSION_ID)).toBe(false);
    expect(isJunkAgentSessionId(CODEX_SESSION_ID)).toBe(false);
    // Non-UUID but structurally plausible ids must survive: the filter is
    // deliberately looser than a UUID match.
    expect(isJunkAgentSessionId("sess_01HZX9K2")).toBe(false);
    expect(isJunkAgentSessionId("abc-123.4")).toBe(false);
  });

  it("treats absent ids as nothing to reject", () => {
    expect(isJunkAgentSessionId(null)).toBe(false);
    expect(isJunkAgentSessionId(undefined)).toBe(false);
    expect(isJunkAgentSessionId("")).toBe(false);
  });
});

describe("agent session mapping application", () => {
  // agent_id decides the kind the config is willing to accept a mapping for, so
  // the fixture is parameterised: a codex mapping is only applied to a codex pane.
  function paneWithoutSession(agentId: "claude-code" | "codex"): PaneConfig {
    return {
      pane_id: "pane-a",
      agent_id: agentId,
      label: null,
      agent_kind: null,
      agent_session_id: null,
      claude_session_id: null,
      active_tab_id: "tab-a",
      tabs: [{
        tab_id: "tab-a",
        agent_id: agentId,
        type: "terminal",
        agent_kind: null,
        agent_session_id: null,
        claude_session_id: null,
      }],
    };
  }

  it("does not persist a junk mapping id", () => {
    const applied = applyMappingsToConfig(
      workspaceConfig([paneWithoutSession("claude-code")]),
      {
        "pty-workspace-pane-a": { agent_kind: null, session_id: JUNK_SESSION_ID },
        "pty-workspace-pane-a-tab-a": { agent_kind: null, session_id: JUNK_SESSION_ID },
      },
    );

    const pane = applied.panes[0];
    expect(pane.agent_session_id).toBeNull();
    expect(pane.claude_session_id).toBeNull();
    expect(pane.tabs![0].agent_session_id).toBeNull();
    expect(pane.tabs![0].claude_session_id).toBeNull();
  });

  it("still applies a legitimate codex mapping id", () => {
    const applied = applyMappingsToConfig(
      workspaceConfig([paneWithoutSession("codex")]),
      {
        "pty-workspace-pane-a-tab-a": { agent_kind: "codex", session_id: CODEX_SESSION_ID },
      },
    );

    const tab = applied.panes[0].tabs![0];
    expect(tab.agent_kind).toBe("codex");
    expect(tab.agent_session_id).toBe(CODEX_SESSION_ID);
    expect(tab.claude_session_id).toBeNull();
  });

  it("still applies a legitimate claude mapping id", () => {
    const applied = applyMappingsToConfig(
      workspaceConfig([paneWithoutSession("claude-code")]),
      {
        "pty-workspace-pane-a-tab-a": { agent_kind: "claude", session_id: CLAUDE_SESSION_ID },
      },
    );

    const tab = applied.panes[0].tabs![0];
    expect(tab.agent_kind).toBe("claude");
    expect(tab.agent_session_id).toBe(CLAUDE_SESSION_ID);
    expect(tab.claude_session_id).toBe(CLAUDE_SESSION_ID);
  });
});

describe("dedupeAgentSessionsInConfigs junk sanitisation", () => {
  it("nulls junk ids already saved in the config", () => {
    const poisoned: PaneConfig = {
      pane_id: "pane-a",
      agent_id: "claude-code",
      label: null,
      agent_kind: "claude",
      agent_session_id: JUNK_SESSION_ID,
      claude_session_id: JUNK_SESSION_ID,
      active_tab_id: "tab-a",
      tabs: [{
        tab_id: "tab-a",
        agent_id: "claude-code",
        type: "terminal",
        agent_kind: "claude",
        agent_session_id: JUNK_SESSION_ID,
        claude_session_id: JUNK_SESSION_ID,
      }],
    };

    const result = dedupeAgentSessionsInConfigs(
      [workspaceConfig([poisoned])],
      "workspace",
      "pane-a",
      "tab-a",
    );

    const pane = result.configs[0].panes[0];
    expect(pane.agent_kind).toBeNull();
    expect(pane.agent_session_id).toBeNull();
    expect(pane.claude_session_id).toBeNull();
    expect(pane.tabs![0].agent_kind).toBeNull();
    expect(pane.tabs![0].agent_session_id).toBeNull();
    expect(pane.tabs![0].claude_session_id).toBeNull();
    // A junk id is not a duplicate — nothing should be parked as a conflict.
    expect(result.conflicts).toEqual([]);
    expect(pane.tabs![0].suppressed_agent_sessions ?? null).toBeNull();
  });

  it("leaves legitimate ids untouched", () => {
    const healthy: PaneConfig = {
      pane_id: "pane-a",
      agent_id: "claude-code",
      label: null,
      agent_kind: "claude",
      agent_session_id: CLAUDE_SESSION_ID,
      claude_session_id: CLAUDE_SESSION_ID,
      active_tab_id: "tab-a",
      tabs: [{
        tab_id: "tab-a",
        agent_id: "claude-code",
        type: "terminal",
        agent_kind: "claude",
        agent_session_id: CLAUDE_SESSION_ID,
        claude_session_id: CLAUDE_SESSION_ID,
      }],
    };

    const result = dedupeAgentSessionsInConfigs(
      [workspaceConfig([healthy])],
      "workspace",
      "pane-a",
      "tab-a",
    );

    const pane = result.configs[0].panes[0];
    expect(pane.agent_kind).toBe("claude");
    expect(pane.agent_session_id).toBe(CLAUDE_SESSION_ID);
    expect(pane.tabs![0].agent_session_id).toBe(CLAUDE_SESSION_ID);
    expect(pane.tabs![0].claude_session_id).toBe(CLAUDE_SESSION_ID);
  });

  it("clears only the junk half when the other id is real", () => {
    const mixed: PaneConfig = {
      pane_id: "pane-a",
      agent_id: "codex",
      label: null,
      agent_kind: "codex",
      agent_session_id: CODEX_SESSION_ID,
      claude_session_id: JUNK_SESSION_ID,
      active_tab_id: "tab-a",
      tabs: [{
        tab_id: "tab-a",
        agent_id: "codex",
        type: "terminal",
        agent_kind: "codex",
        agent_session_id: CODEX_SESSION_ID,
        claude_session_id: JUNK_SESSION_ID,
      }],
    };

    const result = dedupeAgentSessionsInConfigs(
      [workspaceConfig([mixed])],
      "workspace",
      "pane-a",
      "tab-a",
    );

    const tab = result.configs[0].panes[0].tabs![0];
    expect(tab.agent_kind).toBe("codex");
    expect(tab.agent_session_id).toBe(CODEX_SESSION_ID);
    expect(tab.claude_session_id).toBeNull();
  });
});

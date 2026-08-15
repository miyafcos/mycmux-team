import { describe, expect, it, vi } from "vitest";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import type { PaneConfig } from "../../src/lib/ipc";

function config(tabs: NonNullable<PaneConfig["tabs"]>): PaneConfig {
  return {
    pane_id: "pane-1",
    agent_id: "shell-starter",
    label: null,
    active_tab_id: "normal-0",
    tabs,
  };
}

describe("declared restore quarantine", () => {
  it("hydrates 100 declared tabs without treating an unknown lifecycle as restorable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const declared = Array.from({ length: 100 }, (_, index) => ({
      tab_id: `declared-${index}`,
      agent_id: "shell-starter",
      label: `Later ${index}`,
      type: "terminal" as const,
      lifecycle: "declared" as const,
      declared_target: "codex",
    }));
    const normal = Array.from({ length: 5 }, (_, index) => ({
      tab_id: `normal-${index}`,
      agent_id: "shell-starter",
      label: `Now ${index}`,
      type: "terminal" as const,
    }));
    const unknown = { tab_id: "bad", agent_id: "shell-starter", label: "Bad", type: "terminal" as const, lifecycle: "future" as never };
    const restored = useWorkspaceLayoutStore.getState().restorePanes("workspace", [config([...declared, ...normal, unknown])], null, "1x1");
    expect(restored.panes[0].tabs).toHaveLength(105);
    expect(restored.panes[0].tabs.filter((tab) => tab.lifecycle === "declared")).toHaveLength(100);
    expect(restored.panes[0].tabs.filter((tab) => tab.lifecycle === undefined)).toHaveLength(5);
    expect(restored.panes[0].tabs.some((tab) => tab.id === "bad")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("quarantined 1"));
    warn.mockRestore();
  });

  it("preserves tab order while dropping only quarantined tabs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tabs: NonNullable<PaneConfig["tabs"]> = [
      { tab_id: "normal-0", agent_id: "shell-starter", type: "terminal" },
      { tab_id: "declared-middle", agent_id: "shell-starter", type: "terminal", lifecycle: "declared" },
      { tab_id: "bad", agent_id: "shell-starter", type: "terminal", lifecycle: "future" as never },
      { tab_id: "normal-1", agent_id: "shell-starter", type: "terminal" },
      { tab_id: "declared-tail", agent_id: "shell-starter", type: "terminal", lifecycle: "declared" },
    ];

    const restored = useWorkspaceLayoutStore.getState().restorePanes(
      "workspace",
      [config(tabs)],
      null,
      "1x1",
    );

    expect(restored.panes[0].tabs.map((tab) => tab.id)).toEqual([
      "normal-0",
      "declared-middle",
      "normal-1",
      "declared-tail",
    ]);
    warn.mockRestore();
  });

  it("keeps saved columns tied to config indices when a middle pane is quarantined", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pane = (paneId: string, tabId: string, lifecycle?: "declared" | "future"): PaneConfig => ({
      pane_id: paneId,
      agent_id: "shell-starter",
      active_tab_id: tabId,
      tabs: [{
        tab_id: tabId,
        agent_id: "shell-starter",
        type: "terminal",
        ...(lifecycle ? { lifecycle: lifecycle as "declared" } : {}),
      }],
    });

    const restored = useWorkspaceLayoutStore.getState().restorePanes(
      "workspace",
      [pane("pane-a", "tab-a"), pane("pane-b", "tab-b", "future"), pane("pane-c", "tab-c")],
      [[0, 1], [2]],
      "3x1",
    );

    expect(restored.panes.map((candidate) => candidate.id)).toEqual(["pane-a", "pane-c"]);
    expect(restored.splitColumns).toEqual([["pane-a"], ["pane-c"]]);
    warn.mockRestore();
  });

  it("never inherits pane-level agent identity into an active declared tab", () => {
    const restored = useWorkspaceLayoutStore.getState().restorePanes(
      "workspace",
      [{
        pane_id: "pane-identity",
        agent_id: "claude-code",
        active_tab_id: "declared",
        claude_session_id: "sibling-claude-session",
        agent_kind: "claude",
        agent_session_id: "sibling-agent-session",
        suppressed_agent_sessions: [{
          agent_kind: "claude",
          agent_session_id: "suppressed-sibling",
        }],
        tabs: [{
          tab_id: "declared",
          agent_id: "claude-code",
          type: "terminal",
          lifecycle: "declared",
          claude_session_id: null,
          agent_kind: null,
          agent_session_id: null,
          suppressed_agent_sessions: null,
        }, {
          tab_id: "normal",
          agent_id: "claude-code",
          type: "terminal",
          claude_session_id: "normal-session",
          agent_kind: "claude",
          agent_session_id: "normal-session",
        }],
      }],
      null,
      "1x1",
    );

    const pane = restored.panes[0];
    const declared = pane.tabs.find((tab) => tab.id === "declared")!;
    expect(declared).toMatchObject({ lifecycle: "declared" });
    expect(declared.claudeSessionId).toBeUndefined();
    expect(declared.agentKind).toBeUndefined();
    expect(declared.agentSessionId).toBeUndefined();
    expect(declared.suppressedAgentSessions).toBeUndefined();
    expect(pane.claudeSessionId).toBeUndefined();
    expect(pane.agentKind).toBeUndefined();
    expect(pane.agentSessionId).toBeUndefined();
    expect(pane.suppressedAgentSessions).toBeUndefined();
  });
});

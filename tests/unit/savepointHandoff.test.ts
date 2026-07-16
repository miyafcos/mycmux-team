import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, PaneTab } from "../../src/types";
import {
  buildSavepointHandoffLaunchEnv,
  prepareSavepointDropOpen,
  resolveLiveSavepointTargetKind,
  resolveSavepointPaneDropIntent,
  resolveSavepointReleaseDisposition,
  sanitizeSavepointHandoffDraft,
  savepointTargetLabel,
} from "../../src/lib/savepointHandoff";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

function tab(overrides: Partial<PaneTab> = {}): PaneTab {
  return {
    id: "tab-1",
    sessionId: "terminal-1",
    agentId: "shell-starter",
    ...overrides,
  };
}

beforeEach(() => {
  useWorkspaceListStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    lastActivePaneByWorkspace: {},
  });
});

describe("resolveLiveSavepointTargetKind", () => {
  it("uses live runtime metadata for active agent tabs", () => {
    expect(resolveLiveSavepointTargetKind(tab(), "claude")).toBe("claude");
    expect(resolveLiveSavepointTargetKind(tab({ agentKind: "claude" }), "codex")).toBe("codex");
  });

  it("does not treat persisted agent fields as proof without live metadata", () => {
    expect(resolveLiveSavepointTargetKind(tab({ agentId: "claude-code", agentKind: "claude" })))
      .toBeNull();
    expect(resolveLiveSavepointTargetKind(tab({ agentId: "codex", agentKind: "codex" })))
      .toBeNull();
  });

  it("keeps a live agent target through transient shell observations", () => {
    expect(resolveLiveSavepointTargetKind(tab({ agentId: "shell" }), "claude")).toBe("claude");
  });

  it("rejects Online and browser targets", () => {
    expect(resolveLiveSavepointTargetKind(tab({ type: "online" }), "claude")).toBeNull();
    expect(resolveLiveSavepointTargetKind(tab({ type: "browser" }), "codex")).toBeNull();
  });
});

describe("savepoint pane drop intent", () => {
  const rect = { left: 0, right: 1_000, top: 0, bottom: 600, width: 1_000, height: 600 };

  it("keeps the pane center and top neutral", () => {
    expect(resolveSavepointPaneDropIntent(rect, 500, 300, true)).toBeNull();
    expect(resolveSavepointPaneDropIntent(rect, 500, 10, true)).toBeNull();
  });

  it("selects a new full-resume pane at the left or right edge", () => {
    expect(resolveSavepointPaneDropIntent(rect, 10, 300, true)).toEqual({
      mode: "spawn",
      direction: "left",
    });
    expect(resolveSavepointPaneDropIntent(rect, 990, 300, true)).toEqual({
      mode: "spawn",
      direction: "right",
    });
  });

  it("keeps paste behavior only at the bottom of a live agent pane", () => {
    expect(resolveSavepointPaneDropIntent(rect, 500, 590, true)).toEqual({
      mode: "paste",
    });
    expect(resolveSavepointPaneDropIntent(rect, 500, 590, false)).toBeNull();
  });

  it("chooses the nearest valid target at bottom corners", () => {
    expect(resolveSavepointPaneDropIntent(rect, 5, 590, true)).toEqual({
      mode: "spawn",
      direction: "left",
    });
    expect(resolveSavepointPaneDropIntent(rect, 20, 595, true)).toEqual({ mode: "paste" });
    expect(resolveSavepointPaneDropIntent(rect, 995, 590, false)).toEqual({
      mode: "spawn",
      direction: "right",
    });
  });
});

describe("savepoint drop open mode", () => {
  it("uses the existing full-resume join path by default", async () => {
    const full = {
      resolved_cwd: "C:/work",
      cwd_missing: false,
      resume_session_id: "forked-session",
      command_argv: ["claude", "--resume", "forked-session", "--fork-session"],
      agent_kind: "claude" as const,
    };
    const joinFull = vi.fn().mockResolvedValue(full);
    const joinSummary = vi.fn();

    await expect(prepareSavepointDropOpen("C:/savepoint", joinFull, joinSummary))
      .resolves.toEqual({ mode: "full", joined: full });
    expect(joinFull).toHaveBeenCalledWith("C:/savepoint");
    expect(joinSummary).not.toHaveBeenCalled();
  });

  it("falls back to the handoff join path when full resume is unavailable", async () => {
    const fullResumeError = new Error("transcript missing");
    const summary = {
      resolved_cwd: "C:/work",
      handoff_path: "C:/savepoint/handoff.md",
      cwd_missing: false,
    };
    const joinFull = vi.fn().mockRejectedValue(fullResumeError);
    const joinSummary = vi.fn().mockResolvedValue(summary);

    await expect(prepareSavepointDropOpen("C:/savepoint", joinFull, joinSummary))
      .resolves.toEqual({
        mode: "handoff",
        joined: summary,
        fullResumeError,
      });
    expect(joinSummary).toHaveBeenCalledWith("C:/savepoint");
  });
});

describe("savepoint release disposition", () => {
  it("always treats the savepoint panel as a silent cancel surface", () => {
    expect(resolveSavepointReleaseDisposition(true, true)).toBe("cancel");
    expect(resolveSavepointReleaseDisposition(true, false)).toBe("cancel");
  });

  it("commits only a real target and reports other release points as invalid", () => {
    expect(resolveSavepointReleaseDisposition(false, true)).toBe("commit");
    expect(resolveSavepointReleaseDisposition(false, false)).toBe("invalid");
  });
});

describe("savepoint handoff draft", () => {
  it("keeps Japanese paths and removes every Enter-producing line break", () => {
    const draft = sanitizeSavepointHandoffDraft(
      "引き継ぎ書 C:/共有/引き継ぎ handoff.md を読む\r\nEnterは手動",
    );
    expect(draft).toBe("引き継ぎ書 C:/共有/引き継ぎ handoff.md を読む Enterは手動");
    expect(draft).not.toMatch(/[\r\n]/);
  });
});

describe("savepoint handoff launch", () => {
  it("builds the existing launcher contract for Codex", () => {
    expect(buildSavepointHandoffLaunchEnv("codex", "source-session", "C:/shared/handoff.md"))
      .toEqual({
        MYCMUX_AGENT_KIND: "codex",
        MYCMUX_HANDOFF: "codex",
        MYCMUX_HANDOFF_FROM: "claude",
        MYCMUX_HANDOFF_PROMPT_FILE: "C:/shared/handoff.md",
        MYCMUX_HANDOFF_FROM_SESSION: "source-session",
      });
  });

  it("preserves Codex as the source when handing off to Claude", () => {
    expect(buildSavepointHandoffLaunchEnv(
      "claude",
      "source-session",
      "C:/shared/handoff.md",
      "codex",
    )).toEqual({
      MYCMUX_AGENT_KIND: "claude",
      MYCMUX_HANDOFF: "claude",
      MYCMUX_HANDOFF_FROM: "codex",
      MYCMUX_HANDOFF_PROMPT_FILE: "C:/shared/handoff.md",
      MYCMUX_HANDOFF_FROM_SESSION: "source-session",
    });
  });

  it("keeps human-facing target labels stable", () => {
    expect(savepointTargetLabel("claude")).toBe("Claude Code");
    expect(savepointTargetLabel("codex")).toBe("Codex");
    expect(savepointTargetLabel("claude-codex")).toBe("Claude + Codex");
  });

  it("keeps one-shot handoff state on the new tab instead of its sibling pane fallback", () => {
    const existingTab = tab({
      id: "existing-tab",
      sessionId: "existing-terminal",
      cwd: "C:/existing",
    });
    const pane: Pane = {
      id: "pane-1",
      agentId: existingTab.agentId,
      sessionId: existingTab.sessionId,
      tabs: [existingTab],
      activeTabId: existingTab.id,
      cwd: "C:/existing",
      launchEnv: { KEEP_FOR_EXISTING_TAB: "1" },
    };
    useWorkspaceListStore.getState().createWorkspace(
      "Workspace",
      "1x1",
      [pane],
      [[pane.id]],
      { id: "workspace-1" },
    );

    const handoffEnv = buildSavepointHandoffLaunchEnv(
      "codex",
      "source-session",
      "C:/shared/handoff.md",
    );
    useWorkspaceLayoutStore.getState().addTabToPaneWithOptions("workspace-1", "pane-1", {
      agentId: "shell-starter",
      cwd: "C:/handoff",
      launchEnv: handoffEnv,
    });

    const updatedPane = useWorkspaceListStore.getState().getWorkspace("workspace-1")?.panes[0];
    const handoffTab = updatedPane?.tabs.find((candidate) => candidate.id !== existingTab.id);
    expect(handoffTab?.cwd).toBe("C:/handoff");
    expect(handoffTab?.launchEnv).toEqual(handoffEnv);
    expect(updatedPane?.cwd).toBe("C:/existing");
    expect(updatedPane?.launchEnv).toEqual({ KEEP_FOR_EXISTING_TAB: "1" });
  });
});

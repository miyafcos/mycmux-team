import { describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../../src/types";
import {
  clampPaneReadLines,
  findPaneBySessionId,
  resolveSpawnPlan,
  resolveSpawnTabPlan,
} from "../../src/components/layout/socketCommands";

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

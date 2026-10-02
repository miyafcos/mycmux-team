import { describe, expect, it } from "vitest";
import type { AgentDefinition, Pane, PaneTab } from "../../src/types";
import { buildTerminalPaneLaunch } from "../../src/lib/terminalPaneLaunch";

function agent(id: string, command: string, args: string[] = []): AgentDefinition {
  return { id, name: id, description: id, command, args, icon: ">", color: "#fff" };
}
const launcher = agent("shell-starter", "powershell.exe", ["-NoLogo", "-Command", "launcher"]);
const catalog = [
  launcher, agent("shell", "cmd.exe", ["/k"]),
  agent("claude-code", "claude", ["--model", "opus", "--effort=high", "old-prompt"]),
  agent("codex", "codex", ["--no-alt-screen"]),
  agent("grok", "grok", ["--no-alt-screen"]),
  agent("claude-codex", "claude-codex"),
];
const agents = {
  getAgent: (id: string) => catalog.find((entry) => entry.id === id),
  getDefaultAgent: () => launcher,
};
const pane: Pick<Pane, "cwd" | "launchEnv"> = { cwd: "C:/pane", launchEnv: { KEEP: "inherited" } };
const tab = (overrides: Partial<PaneTab> = {}): PaneTab => ({
  id: "tab-id", sessionId: "pty-id", agentId: "shell", type: "terminal", ...overrides,
});

describe("shared terminal pane launch builder", () => {
  it("keeps the absent-tab UI result", () => {
    expect(buildTerminalPaneLaunch(pane, undefined, agents)).toEqual({
      paneCwd: "C:/pane", resolvedAgentId: undefined, agent: null,
      savedAgentSession: null, launchCommand: "", launchArgs: [], launchEnv: undefined,
    });
  });

  it("keeps a fresh Claude launch's tab identity and initial prompt", () => {
    const launch = buildTerminalPaneLaunch(pane, tab({ agentId: "claude-code", initialPrompt: "task" }), agents);
    expect(launch.launchCommand).toBe("claude");
    expect(launch.launchArgs).toEqual([
      "--model", "opus", "--effort=high", "old-prompt",
      "--allow-dangerously-skip-permissions", "--permission-mode", "auto",
      "--session-id", "tab-id", "task",
    ]);
    expect(launch.launchEnv).toEqual({
      KEEP: "inherited", MYCMUX_PANE_SESSION_ID: "pty-id", MYCMUX_TAB_ID: "tab-id",
      MYCMUX_AGENT_KIND: "claude",
    });
  });

  it.each([
    ["claude", "claude-code", ["--model", "opus", "--effort=high",
      "--allow-dangerously-skip-permissions", "--permission-mode", "auto", "--resume", "conversation"]],
    ["codex", "codex", ["resume", "--no-alt-screen", "-C", "C:/tab", "conversation"]],
    ["grok", "grok", ["--no-alt-screen", "--resume", "conversation"]],
    ["claude-codex", "claude-codex", ["--resume", "conversation"]],
  ] as const)("resumes saved %s with the UI command, args, env and cwd", (kind, agentId, args) => {
    const launch = buildTerminalPaneLaunch(pane, tab({
      agentId, agentKind: kind, agentSessionId: "conversation", cwd: "C:/tab", initialPrompt: "do-not-rerun",
    }), agents);
    expect(launch.launchCommand).toBe(agents.getAgent(agentId)!.command);
    expect(launch.launchArgs).toEqual(args);
    expect(launch.paneCwd).toBe("C:/tab");
    expect(launch.launchEnv).toEqual({
      KEEP: "inherited", MYCMUX_PANE_SESSION_ID: "pty-id", MYCMUX_TAB_ID: "tab-id",
      MYCMUX_AGENT_KIND: kind, MYCMUX_SESSION_ID: "conversation", MYCMUX_RESUME: kind,
    });
  });

  it("uses legacy Claude identities and prefers a complete modern identity", () => {
    const legacy = buildTerminalPaneLaunch(pane, tab({ agentId: "claude-code", claudeSessionId: "legacy" }), agents);
    expect(legacy.savedAgentSession).toEqual({ kind: "claude", sessionId: "legacy" });
    expect(legacy.launchArgs.slice(-2)).toEqual(["--resume", "legacy"]);
    const modern = buildTerminalPaneLaunch(pane, tab({
      agentId: "codex", agentKind: "codex", agentSessionId: "modern", claudeSessionId: "legacy",
    }), agents);
    expect(modern.savedAgentSession).toEqual({ kind: "codex", sessionId: "modern" });
  });

  it.each(["MYCMUX_LAUNCH_TARGET", "MYCMUX_HANDOFF", "MYCMUX_RESUME"])(
    "keeps launcher dispatch for %s and suppresses resume env during a handoff", (key) => {
      const launch = buildTerminalPaneLaunch(pane, tab({
        agentId: "codex", agentKind: "codex", agentSessionId: "own-conversation",
        launchEnv: { [key]: "codex", MYCMUX_HANDOFF_PROMPT_FILE: "task.md" },
      }), agents);
      expect(launch.agent).toBe(launcher);
      expect(launch.launchCommand).toBe(launcher.command);
      // Preserve the UI's resolved-agent argument rules for a PowerShell launcher.
      expect(launch.launchArgs).toEqual(["resume", "--no-alt-screen", "-C", "C:/pane", "own-conversation"]);
      expect(launch.launchEnv?.__CMUX_LAUNCHER_DONE).toBe("1");
      if (key === "MYCMUX_HANDOFF") {
        expect(launch.launchEnv).not.toHaveProperty("MYCMUX_RESUME");
        expect(launch.launchEnv).not.toHaveProperty("MYCMUX_SESSION_ID");
      } else {
        expect(launch.launchEnv).toMatchObject({ MYCMUX_RESUME: "codex", MYCMUX_SESSION_ID: "own-conversation" });
      }
    },
  );

  it("keeps explicit command argv and empty-tab-env precedence without mutating inputs", () => {
    const source = tab({ commandArgv: ["custom.exe", "--option", "two words"], launchEnv: {}, cwd: "C:/tab" });
    const snapshot = structuredClone({ pane, source, catalog });
    const launch = buildTerminalPaneLaunch(pane, source, agents);
    expect(launch.launchCommand).toBe("custom.exe");
    expect(launch.launchArgs).toEqual(["--option", "two words"]);
    expect(launch.launchEnv).toEqual({ MYCMUX_PANE_SESSION_ID: "pty-id", MYCMUX_TAB_ID: "tab-id" });
    expect({ pane, source, catalog }).toEqual(snapshot);
  });

  it("keeps the default-agent fallback and shell-starter marker", () => {
    for (const agentId of ["missing-agent", "shell-starter"]) {
      const launch = buildTerminalPaneLaunch(pane, tab({ agentId }), agents);
      expect(launch.agent).toBe(launcher);
      expect(launch.launchCommand).toBe(launcher.command);
      expect(launch.launchArgs).toEqual(launcher.args);
      expect(launch.launchEnv?.__CMUX_LAUNCHER_DONE).toBe(agentId === "shell-starter" ? "1" : undefined);
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import type { AgentSessionKind, PaneTab, Workspace } from "../../src/types";

const backend = vi.hoisted(() => ({ shell: "powershell.exe" }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: async (name: string) => name === "get_default_shell"
    ? { command: backend.shell, args: [] } : name === "get_test_profile" ? "terminal-integration" : undefined,
  Channel: class { id = 1; onmessage = (_data: unknown) => {}; },
}));

import { toConfig, dedupeAgentSessionsInConfigs } from "../../src/components/layout/SocketListener";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { buildTerminalPaneLaunch } from "../../src/lib/terminalPaneLaunch";
import { buildTerminalShellLaunchEnv, consumeTerminalCommandEnv } from "../../src/lib/terminalShellCommand";
import { getAgent, getDefaultAgent, initDefaultShell } from "../../src/lib/agents";

const KINDS = ["claude", "codex", "claude-codex", "grok"] as const satisfies readonly AgentSessionKind[];
const NORMALIZED_IDS: Record<AgentSessionKind, string> = {
  claude: "claude-code", codex: "codex", "claude-codex": "shell-starter", grok: "grok",
};
const SHELLS = ["powershell.exe", "/bin/bash"] as const;
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROMPT = "INITIAL_PROMPT_MUST_NOT_REPLAY";
const COMMAND = "echo ONE_SHOT_MUST_NOT_REPLAY";

beforeEach(() => useWorkspaceListStore.getState()._replaceWorkspaces([]));

function restoreTerminal(kind?: AgentSessionKind, legacy = false) {
  useWorkspaceListStore.getState()._replaceWorkspaces([]);
  const env = buildTerminalShellLaunchEnv(COMMAND);
  const tab: PaneTab = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sessionId: "pty-restore", agentId: "shell-starter",
    type: "terminal", cwd: "C:/work", launchEnv: env, initialPrompt: PROMPT,
    ...(legacy ? { claudeSessionId: SESSION_ID } : kind ? { agentKind: kind, agentSessionId: SESSION_ID } : {}),
  };
  const ws: Workspace = {
    id: "ws-restore", name: "Restore", createdAt: 1, status: "running", gridTemplateId: "1x1",
    panes: [{ id: "pane-restore", agentId: tab.agentId, sessionId: tab.sessionId,
      tabs: [tab], activeTabId: tab.id, launchEnv: env }], splitColumns: [["pane-restore"]],
  };
  const saved = toConfig(ws, {});
  consumeTerminalCommandEnv(env);
  expect(JSON.stringify(saved)).not.toContain("MYCMUX_LAUNCH_COMMAND");
  expect(JSON.stringify(saved)).not.toContain(COMMAND);
  expect(JSON.stringify(saved)).not.toContain(PROMPT);
  const normalized = dedupeAgentSessionsInConfigs([saved], ws.id, ws.panes[0].id, tab.id).configs;
  expect(normalized[0].panes[0].tabs![0].agent_id).toBe(legacy ? "claude-code" : kind ? NORMALIZED_IDS[kind] : "shell-starter");
  restoreWorkspaceConfigs(JSON.parse(JSON.stringify(normalized)));
  const pane = useWorkspaceListStore.getState().workspaces[0].panes[0];
  expect(pane.tabs[0].initialPrompt).toBeUndefined();
  return { pane, tab: pane.tabs[0] };
}

function expectPlainShell(pane: Workspace["panes"][number], tab: PaneTab) {
  const launch = buildTerminalPaneLaunch(pane, tab, { getAgent, getDefaultAgent });
  const integrated = getDefaultAgent(true);
  expect(launch.savedAgentSession).toBeNull();
  expect(launch).not.toHaveProperty("restoreReason");
  expect(launch.launchCommand).toBe(integrated.command);
  expect(launch.launchArgs).toEqual(integrated.args);
  expect(launch.launchEnv).toMatchObject({ MYCMUX_LAUNCH_TARGET: "shell" });
  for (const key of ["MYCMUX_RESUME", "MYCMUX_SESSION_ID", "MYCMUX_LAUNCH_COMMAND"]) {
    expect(launch.launchEnv).not.toHaveProperty(key);
  }
}

describe.each(SHELLS)("persisted terminal restoration through %s", shell => {
  beforeEach(async () => { backend.shell = shell; await initDefaultShell(); });

  it.each(KINDS)("U5 saves, normalizes and restores %s without agent arguments or replay", kind => {
    const { pane, tab } = restoreTerminal(kind);
    expectPlainShell(pane, tab);
  });

  it.each(KINDS)("U5 ignores an initial prompt and restore reason after %s normalization", kind => {
    const { pane, tab } = restoreTerminal(kind);
    expectPlainShell(pane, { ...tab, initialPrompt: PROMPT, codexRestoreReason: "saved-codex-pane" });
  });

  it("U5 restores a legacy Claude session as the integrated shell", () => {
    const { pane, tab } = restoreTerminal(undefined, true);
    expectPlainShell(pane, { ...tab, initialPrompt: PROMPT });
  });

  it("U5 ignores a prompt without saved agent metadata and inherits pane shell mode", () => {
    const { pane, tab } = restoreTerminal();
    expectPlainShell(pane, { ...tab, launchEnv: undefined, initialPrompt: PROMPT });
  });
});

it("exports persisted terminal restore plans for shell integration", async () => {
  const plans = [];
  for (const shell of SHELLS) {
    backend.shell = shell;
    await initDefaultShell();
    for (const kind of KINDS) {
      const { pane, tab } = restoreTerminal(kind);
      const launch = buildTerminalPaneLaunch(pane, tab, { getAgent, getDefaultAgent });
      plans.push({ shell, kind, agentId: tab.agentId, command: launch.launchCommand,
        args: launch.launchArgs, env: launch.launchEnv, expectedArgs: getDefaultAgent(true).args });
    }
  }
  expect(plans).toHaveLength(SHELLS.length * KINDS.length);
  if (process.env.TERMINAL_RESTORE_PLAN_PATH) {
    writeFileSync(process.env.TERMINAL_RESTORE_PLAN_PATH, JSON.stringify(plans, null, 2), "utf8");
  }
});

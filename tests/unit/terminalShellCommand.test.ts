import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneTab, Workspace } from "../../src/types";
import { buildTerminalShellLaunchEnv, consumeTerminalCommandEnv, resolveTerminalCommandEnv, terminalCommandError } from "../../src/lib/terminalShellCommand";
import { toConfig, toTransferConfig } from "../../src/components/layout/SocketListener";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { buildTerminalPaneLaunch } from "../../src/lib/terminalPaneLaunch";
import { buildSpawnLaunchEnv } from "../../src/lib/spawnLaunchEnv";
import { createSession } from "../../src/lib/ipc";

const backend = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: backend.invoke,
  Channel: class { id = 1; onmessage = (_data: unknown) => {}; },
}));
vi.mock("../../src/lib/codexRestore", () => ({ ensureCodexRestoreNoticeListener: async () => {} }));

beforeEach(() => { vi.clearAllMocks(); backend.invoke.mockResolvedValue(undefined); });

function workspace(env: Record<string, string>): Workspace {
  const tab: PaneTab = { id: "tab", sessionId: "pty", agentId: "shell-starter", type: "terminal", cwd: "C:/work", launchEnv: env };
  return { id: "ws", name: "Workspace", createdAt: 1, status: "running", gridTemplateId: "1x1",
    panes: [{ id: "pane", agentId: tab.agentId, sessionId: tab.sessionId, tabs: [tab], activeTabId: tab.id, launchEnv: env }], splitColumns: [["pane"]] };
}

describe("ephemeral terminal shell command", () => {
  it("U5 keeps text outside the tab model, save/transfer records and restored launches", () => {
    const command = "echo token-example; echo '$ | \" \u65e5\u672c\u8a9e'";
    const env = buildTerminalShellLaunchEnv(command), ws = workspace(env);
    expect(JSON.stringify(ws)).not.toContain(command);
    const saved = toConfig(ws, {}), transfer = toTransferConfig(ws);
    for (const config of [saved, transfer]) {
      expect(JSON.stringify(config)).not.toContain("MYCMUX_LAUNCH_COMMAND");
      expect(JSON.stringify(config)).not.toContain(command);
      expect(config.panes[0].launch_env).toEqual({ MYCMUX_LAUNCH_TARGET: "shell" });
      expect(config.panes[0].tabs?.[0].launch_env).toEqual({ MYCMUX_LAUNCH_TARGET: "shell" });
    }
    useWorkspaceListStore.getState()._replaceWorkspaces([]);
    restoreWorkspaceConfigs([saved]);
    const pane = useWorkspaceListStore.getState().workspaces[0].panes[0];
    const launcher = { id: "shell-starter", name: "launcher", description: "", command: "powershell.exe", args: ["launcher"], icon: ">", color: "#fff" };
    const launch = buildTerminalPaneLaunch(pane, { ...pane.tabs[0], agentKind: "codex", agentSessionId: "old-conversation", codexRestoreReason: "saved-codex-pane" }, { getAgent: () => launcher, getDefaultAgent: () => launcher });
    expect(launch.launchCommand).toBe("powershell.exe");
    expect(launch.launchArgs).toEqual(["launcher"]);
    expect(launch.launchEnv).toMatchObject({ MYCMUX_LAUNCH_TARGET: "shell" });
    expect(launch.launchEnv).not.toHaveProperty("MYCMUX_LAUNCH_COMMAND");
    expect(launch.launchEnv).not.toHaveProperty("MYCMUX_RESUME");
    expect(launch).not.toHaveProperty("restoreReason");
    consumeTerminalCommandEnv(env);
  });
  it("U5 never replays after a failed or uncertain IPC create", async () => {
    const command = "echo '$; | \u65e5\u672c\u8a9e'", env = buildTerminalShellLaunchEnv(command);
    backend.invoke.mockRejectedValueOnce(new Error("spawn failed"));
    const start = () => createSession("shell-command-test", "powershell.exe", ["launcher"], 80, 24, () => {}, "C:/work", env, false, { backgroundOnly: true });
    await expect(start()).rejects.toThrow("spawn failed");
    expect(resolveTerminalCommandEnv(env)).not.toHaveProperty("MYCMUX_LAUNCH_COMMAND");
    await start(); await start();
    const calls = backend.invoke.mock.calls.filter(([name]) => name === "create_session");
    expect(calls).toHaveLength(3);
    expect(calls[0][1].env.MYCMUX_LAUNCH_COMMAND).toBe(command);
    expect(calls[1][1].env).not.toHaveProperty("MYCMUX_LAUNCH_COMMAND");
    expect(calls[2][1].env).toEqual({ MYCMUX_LAUNCH_TARGET: "shell" });
  });
  it("U5 also consumes a foreground create before a queued second create", async () => {
    const env = buildTerminalShellLaunchEnv("echo once");
    const start = () => createSession("shell-foreground-test", "powershell.exe", ["launcher"], 80, 24, () => {}, undefined, env);
    await Promise.all([start(), start()]);
    const calls = backend.invoke.mock.calls.filter(([name]) => name === "create_session");
    expect(calls).toHaveLength(2);
    expect(calls[0][1].env.MYCMUX_LAUNCH_COMMAND).toBe("echo once");
    expect(calls[1][1].env).not.toHaveProperty("MYCMUX_LAUNCH_COMMAND");
  });
  it("U5 removes one-shot references from spawned children and discards stale references", () => {
    const env = buildTerminalShellLaunchEnv("echo one");
    expect(buildSpawnLaunchEnv(env)).toEqual({});
    expect(resolveTerminalCommandEnv({ MYCMUX_LAUNCH_TARGET: "shell", MYCMUX_LAUNCH_COMMAND: "stale-or-unregistered" })).toEqual({ MYCMUX_LAUNCH_TARGET: "shell" });
    consumeTerminalCommandEnv(env);
  });
  it("U4 accepts the exact UTF-16 boundary and rejects control characters", () => {
    expect(terminalCommandError("x".repeat(4096))).toBeNull();
    expect(terminalCommandError("\ud83d\ude00".repeat(2048))).toBeNull();
    expect(terminalCommandError("\ud83d\ude00".repeat(2049))).toBe("too-long");
    for (const bad of ["", " ", "a\nb", "a\rb", "a\tb", "a\0b", "a\x7fb", "a\x85b", "a\u2028b", "a\u2029b"]) {
      expect(terminalCommandError(bad)).toBe("single-line");
      expect(() => buildTerminalShellLaunchEnv(bad)).toThrow("Invalid terminal command");
    }
  });
});

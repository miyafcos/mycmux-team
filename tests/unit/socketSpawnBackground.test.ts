import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import type { Terminal } from "@xterm/xterm";
import { handleSocketCommand, startBackgroundTabSession } from "../../src/components/layout/socketCommands";
import { buildSpawnLaunchEnv, EPHEMERAL_LAUNCH_ENV_KEYS } from "../../src/lib/spawnLaunchEnv";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useSavepointDragStore } from "../../src/stores/savepointDragStore";
import { liveTerms } from "../../src/components/terminal/terminalCache";

const ipc = vi.hoisted(() => ({
  createSession: vi.fn<(...args: unknown[]) => Promise<void>>(),
  killSession: vi.fn<(...args: unknown[]) => Promise<void>>(),
  ackFrontendData: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/lib/ipc", () => ipc);

const parentEnv = {
  KEEP_SETTING: "keep-me",
  MYCMUX_HANDOFF: "claude",
  MYCMUX_HANDOFF_PROMPT_FILE: "C:\\parent\\sentinel.md",
  MYCMUX_HANDOFF_FROM: "grok",
  MYCMUX_HANDOFF_FROM_SESSION: "parent-sentinel",
  MYCMUX_RESUME: "claude",
  MYCMUX_SESSION_ID: "parent-resume",
  MYCMUX_LAUNCH_MODEL: "parent-model",
  MYCMUX_LAUNCH_EFFORT: "low",
};

function workspace(id: string): Workspace {
  const tab: PaneTab = { id: id + "-tab", sessionId: id + "-session", agentId: "shell-starter", type: "terminal" };
  const pane: Pane = { id: id + "-pane", sessionId: tab.sessionId, agentId: tab.agentId, tabs: [tab], activeTabId: tab.id, launchEnv: { ...parentEnv } };
  return { id, name: id, gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [pane], splitColumns: [[pane.id]] };
}

const current = () => useWorkspaceListStore.getState().getWorkspace("background")!;
const spawn = (args: Record<string, unknown> = {}) => handleSocketCommand("pane.spawn", {
  workspaceId: "background", target: "codex", ...args,
});

beforeEach(() => {
  vi.clearAllMocks();
  ipc.createSession.mockResolvedValue(undefined);
  ipc.killSession.mockResolvedValue(undefined);
  useWorkspaceListStore.setState({
    workspaces: [workspace("foreground"), workspace("background")],
    activeWorkspaceId: "foreground", lastActivePaneByWorkspace: {},
  });
  useUiStore.setState({ activePaneId: "foreground-session", focusRevision: 0 });
  useSavepointDragStore.setState({ item: null });
  liveTerms.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  liveTerms.clear();
  useSavepointDragStore.setState({ item: null });
});

describe("spawn launch environment ownership", () => {
  it("strips every inherited ephemeral key and its Windows case aliases", () => {
    const inherited: Record<string, string> = { KEEP_SETTING: "keep-me" };
    for (const key of EPHEMERAL_LAUNCH_ENV_KEYS) {
      inherited[key] = "parent";
      inherited[key.toLowerCase()] = "mixed-parent";
    }
    expect(buildSpawnLaunchEnv(inherited)).toEqual({ KEEP_SETTING: "keep-me" });
    expect(buildSpawnLaunchEnv(inherited, {
      MYCMUX_LAUNCH_TARGET: "codex", MYCMUX_LAUNCH_MODEL: "child-model", MYCMUX_LAUNCH_EFFORT: "high",
    })).toEqual({
      KEEP_SETTING: "keep-me", MYCMUX_LAUNCH_TARGET: "codex", MYCMUX_LAUNCH_MODEL: "child-model", MYCMUX_LAUNCH_EFFORT: "high",
    });
    expect(inherited.MYCMUX_HANDOFF).toBe("parent");
  });

  it.each(["pane.spawn", "pane.spawn_tab"])("keeps the explicit child prompt path for %s", async (command) => {
    const result = await handleSocketCommand(command, {
      workspaceId: "background", anchorSessionId: "background-session",
      target: "codex", prompt_file: "C:\\child\\spec.md",
    }) as { sessionId: string };
    const env = ipc.createSession.mock.calls[0][7] as Record<string, string>;
    // The existing protocol uses fresh handoff keys to transport prompt_file.
    // Parent handoff values and absent child source-kind must not survive.
    expect(env).toMatchObject({
      MYCMUX_AGENT_KIND: "codex", MYCMUX_HANDOFF: "codex",
      MYCMUX_HANDOFF_PROMPT_FILE: "C:\\child\\spec.md",
      MYCMUX_HANDOFF_FROM_SESSION: "external",
      MYCMUX_PANE_SESSION_ID: result.sessionId, MYCMUX_TAB_ID: expect.any(String),
      __CMUX_LAUNCHER_DONE: "1",
    });
    expect(env).not.toHaveProperty("MYCMUX_HANDOFF_FROM");
    expect(current().panes[0].launchEnv).toEqual(parentEnv);
  });

  it.each([{ target: "shell" }, { commandArgv: ["cmd.exe", "/c", "echo child"] }])(
    "stores a filtered map even when the child supplies no launch env: %j", async (args) => {
      await handleSocketCommand("pane.spawn_tab", { anchorSessionId: "background-session", ...args });
      const child = current().panes[0].tabs[1];
      expect(child.launchEnv).toEqual({ KEEP_SETTING: "keep-me" });
      const env = ipc.createSession.mock.calls[0][7] as Record<string, string>;
      for (const key of EPHEMERAL_LAUNCH_ENV_KEYS) {
        if (["MYCMUX_PANE_SESSION_ID", "MYCMUX_TAB_ID", "__CMUX_LAUNCHER_DONE"].includes(key)) continue;
        expect(env).not.toHaveProperty(key);
      }
    },
  );

  it("does not fall back to a poisoned pane at the headless entry point", async () => {
    const pane = current().panes[0];
    await startBackgroundTabSession(pane.tabs[0], pane);
    const env = ipc.createSession.mock.calls[0][7] as Record<string, string>;
    expect(env).not.toHaveProperty("MYCMUX_HANDOFF");
    expect(env.KEEP_SETTING).toBe("keep-me");
  });

  it("preserves an explicit resume while stripping the parent's handoff", async () => {
    await spawn({ target: "grok", resumeSessionId: "child-resume" });
    const env = ipc.createSession.mock.calls[0][7] as Record<string, string>;
    expect(env.MYCMUX_RESUME).toBe("grok");
    expect(env.MYCMUX_SESSION_ID).toBe("child-resume");
    expect(env).not.toHaveProperty("MYCMUX_HANDOFF");
  });
});

describe("background pane PTY startup", () => {
  it("starts five new panes before responding and leaves existing panes and foreground alone", async () => {
    const original = current().panes[0];
    const results = [];
    for (let index = 0; index < 5; index++) results.push(await spawn() as { sessionId: string });
    expect(ipc.createSession).toHaveBeenCalledTimes(5);
    expect(new Set(ipc.createSession.mock.calls.map(([id]) => id)).size).toBe(5);
    expect(ipc.createSession.mock.calls.map(([id]) => id)).toEqual(results.map(({ sessionId }) => sessionId));
    expect(current().panes).toHaveLength(6);
    expect(current().panes[0]).toBe(original);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("foreground");
    expect(useUiStore.getState().activePaneId).toBe("foreground-session");
  });

  it("does not return success before the new PTY has started", async () => {
    let finish!: () => void;
    ipc.createSession.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    let replied = false;
    const request = spawn().then(() => { replied = true; });
    await vi.waitFor(() => expect(ipc.createSession).toHaveBeenCalledTimes(1));
    expect(replied).toBe(false);
    finish();
    await request;
    expect(replied).toBe(true);
  });

  it("leaves a foreground pane to its renderer", async () => {
    await spawn({ workspaceId: "foreground" });
    expect(ipc.createSession).not.toHaveBeenCalled();
  });

  it("leaves a still-mounted background workspace to its renderer", async () => {
    liveTerms.set("background-session", {} as Terminal);
    await spawn();
    expect(ipc.createSession).not.toHaveBeenCalled();
  });

  it("leaves a mounted drag-source workspace to its renderer", async () => {
    useSavepointDragStore.setState({ item: {
      kind: "savepoint", sourceWorkspaceId: "background", bundleDir: "C:\\bundle",
      label: "drag", sourceSessionId: "background-session", sourceAgentKind: "claude",
    } });
    await spawn();
    expect(ipc.createSession).not.toHaveBeenCalled();
  });

  it("rolls back only the failed pane and cleans up only its new PTY", async () => {
    const original = current().panes[0];
    ipc.createSession.mockRejectedValueOnce(new Error("fixture PTY failure"));
    await expect(spawn()).rejects.toThrow("fixture PTY failure");
    expect(current().panes).toEqual([original]);
    expect(current().splitColumns).toEqual([[original.id]]);
    const failedSessionId = ipc.createSession.mock.calls[0][0];
    expect(failedSessionId).not.toBe(original.sessionId);
    expect(ipc.killSession.mock.calls).toEqual([[failedSessionId]]);
  });

  it("keeps a concurrently added sibling when startup fails", async () => {
    const original = current().panes[0];
    ipc.createSession.mockImplementationOnce(async () => {
      useWorkspaceLayoutStore.getState().addPaneToWorkspaceWithOptions(
        "background", original.id, "right", { agentId: "shell-starter", activate: false },
      );
      throw new Error("fixture late failure");
    });
    await expect(spawn()).rejects.toThrow("fixture late failure");
    expect(current().panes).toHaveLength(2);
    const failedSessionId = ipc.createSession.mock.calls[0][0];
    expect(current().panes.map((pane) => pane.sessionId)).not.toContain(failedSessionId);
    expect(current().panes[0]).toBe(original);
    expect(ipc.killSession.mock.calls).toEqual([[failedSessionId]]);
  });

  it("preserves the startup error if cleanup also fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    ipc.createSession.mockRejectedValueOnce(new Error("fixture PTY failure"));
    ipc.killSession.mockRejectedValueOnce(new Error("fixture cleanup failure"));
    await expect(spawn()).rejects.toThrow("fixture PTY failure");
    expect(current().panes).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledOnce();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { focusController } from "../../src/lib/focusController";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import type { Workspace } from "../../src/types";

vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(),
  createSession: vi.fn(async () => {}), ackFrontendData: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}), removeWorkspaceScrollback: vi.fn(async () => {}),
  getSessionStatusSnapshot: vi.fn(async () => ({ server_epoch: "epoch", seq: 1, sessions: [] })),
}));

vi.mock("../../src/components/terminal/XTermWrapper", () => ({ evictTerminalCache: vi.fn() }));

function workspace(id: string): Workspace {
  const tabs = ["first", "target", "declared"].map((suffix) => ({
    id: `${id}-${suffix}`, sessionId: `${id}-${suffix}`, agentId: "shell-starter",
    type: "terminal" as const,
    ...(suffix === "declared" ? { lifecycle: "declared" as const, declaredTarget: "codex" as const } : {}),
  }));
  return { id, name: id, gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: `${id}-pane`, agentId: "shell-starter", sessionId: tabs[0].sessionId,
      tabs, activeTabId: tabs[0].id }], splitColumns: [[`${id}-pane`]],
  };
}

function foreground() {
  const list = useWorkspaceListStore.getState();
  const pane = list.getWorkspace("visible")!.panes[0];
  const ui = useUiStore.getState();
  return [list.activeWorkspaceId, pane.activeTabId, pane.sessionId, ui.activePaneId, ui.focusRevision];
}

beforeEach(() => {
  useWorkspaceListStore.setState({ workspaces: [workspace("visible"), workspace("background")],
    activeWorkspaceId: "visible", lastActivePaneByWorkspace: {} });
  useUiStore.setState({ activePaneId: "visible-first", focusRevision: 0 });
  useSettingsStore.setState({ declaredLaunchEnabled: true });
});
afterEach(() => { vi.restoreAllMocks(); useSettingsStore.setState({ declaredLaunchEnabled: false }); });

describe("socket operator foreground contract", () => {
  it.each([
    ["pane.spawn", { workspaceId: "visible", target: "shell", activate: true }],
    ["pane.spawn", { workspaceId: "background", target: "shell", activate: true }],
    ["pane.spawn_tab", { anchorSessionId: "visible-first", commandArgv: ["cmd.exe"], activate: true }],
    ["pane.spawn_tab", { anchorSessionId: "background-first", commandArgv: ["cmd.exe"], activate: true }],
    ["pane.launch_declared", { tabId: "visible-declared", requestId: "foreground-visible" }],
    ["pane.launch_declared", { tabId: "background-declared", requestId: "foreground-background" }],
    ["pane.activate_tab", { sessionId: "visible-target" }],
    ["pane.activate_tab", { sessionId: "background-target" }],
    ["pane.restore_activation", { previous_session_id: "visible-first", target_session_id: "background-target", focus_revision: 0 }],
    ["workspace.new", { name: "Created" }],
    ["workspace.close", { workspaceId: "background" }],
  ] as const)("%s preserves every observed foreground state for %j", async (command, args) => {
    const before = foreground();
    const observed: unknown[] = [];
    const stopList = useWorkspaceListStore.subscribe(() => observed.push(foreground()));
    const stopUi = useUiStore.subscribe(() => observed.push(foreground()));
    const focus = vi.spyOn(focusController, "request");
    const select = vi.spyOn(useWorkspaceListStore.getState(), "setActiveWorkspace");
    try {
      const commandArgs = command === "pane.restore_activation"
        ? await handleSocketCommand("pane.activate_tab", { sessionId: "background-target" })
        : args;
      const result = await handleSocketCommand(command, commandArgs as Record<string, unknown>);
      expect(result).toBeDefined();
      expect(foreground()).toEqual(before);
      for (const state of observed) expect(state).toEqual(before);
      expect(focus).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
    } finally { stopList(); stopUi(); }
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(), mappings: vi.fn(), getWindowFragments: vi.fn(),
}));
vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(),
  createSession: mocks.createSession,
  readAgentSessionMappings: mocks.mappings,
  getWindowFragments: mocks.getWindowFragments,
}));

import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { HISTORY_MAPPING_POLL_MS, TERMINAL_HISTORY_EVENT } from "../../src/components/terminal/TerminalHistoryEntry";
import { terminalTurnStrings } from "../../src/components/terminal/terminalTurnStrings";
import type { AgentSessionMapping } from "../../src/lib/ipc";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import type { Workspace } from "../../src/types";

const workspaceId = "history-workspace";
const paneId = "history-pane";
const anchor = "pty-shell";
const agentId = "42a5a7ee-3ef5-4f95-81c1-5feb24095f33";
const command = "C:\\fixture-bin\\claude.cmd";
let root: Root;
let host: HTMLDivElement;
let mappings: Record<string, AgentSessionMapping>;

function Toolbar() {
  const pane = useWorkspaceListStore((state) => state.workspaces[0].panes[0]);
  return <PaneTabBar pane={pane} workspaceId={workspaceId} hasTerminalBuffer={() => true}
    onSelectTab={(tabId) => useWorkspaceLayoutStore.getState().setActivePaneTab(workspaceId, paneId, tabId)} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.clearAllMocks();
  mocks.createSession.mockResolvedValue(undefined);
  mocks.getWindowFragments.mockResolvedValue([]);
  // Native identity extraction is checked separately. This mock supplies an
  // exact backend identity; the real handler and toolbar decide its visibility.
  mappings = {};
  mocks.mappings.mockImplementation(async (ids: string[]) => Object.fromEntries(
    ids.filter((id) => mappings[id]).map((id) => [id, mappings[id]]),
  ));
  const workspace: Workspace = {
    id: workspaceId, name: "History acceptance", createdAt: 1, status: "running", gridTemplateId: "1x1",
    panes: [{
      id: paneId, sessionId: anchor, agentId: "shell-starter", activeTabId: "shell-tab",
      tabs: [{ id: "shell-tab", sessionId: anchor, agentId: "shell-starter", type: "terminal" }],
      launchEnv: { KEEP_SETTING: "keep", MYCMUX_RESUME: "claude", MYCMUX_SESSION_ID: "parent-id" },
    }], splitColumns: [[paneId]],
  };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspaceId, lastActivePaneByWorkspace: {} });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSettingsStore.setState({ showTerminalHistoryButton: true });
  useUiStore.setState({ activePaneId: anchor, focusRevision: 0 });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("synthetic history acceptance through the real spawn handler and toolbar", () => {
  it.each([undefined, true])("needs the spawned tab selected even with activate=%s", async (activate) => {
    const result = await handleSocketCommand("pane.spawn_tab", {
      anchorSessionId: anchor, cwd: "C:\\synthetic\\r860-project", label: "R860 exact transcript",
      commandArgv: [command, "--session-id", agentId], ...(activate === undefined ? {} : { activate }),
    }) as { tabId: string; sessionId: string; activationApplied: boolean };
    mappings[result.sessionId] = { agent_kind: "claude", session_id: agentId };
    await act(async () => root.render(<Toolbar />));

    expect(mocks.createSession).toHaveBeenCalledOnce();
    const createArgs = mocks.createSession.mock.calls[0];
    expect(createArgs.slice(0, 3)).toEqual([result.sessionId, command, ["--session-id", agentId]]);
    expect(createArgs[6]).toBe("C:\\synthetic\\r860-project");
    expect(createArgs[7]).toEqual({
      KEEP_SETTING: "keep", MYCMUX_PANE_SESSION_ID: result.sessionId, MYCMUX_TAB_ID: result.tabId,
      __CMUX_LAUNCHER_DONE: "1",
    });
    expect(result.activationApplied).toBe(false);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].activeTabId).toBe("shell-tab");
    expect(useUiStore.getState().activePaneId).toBe(anchor);
    expect(host.querySelector("[data-terminal-history-entry=true]")).toBeNull();
    expect(host.querySelector("[data-terminal-history-unavailable=true]")?.getAttribute("title"))
      .toBe(terminalTurnStrings.historyUnlinked);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(host.querySelector("[data-terminal-history-entry=true]")).toBeNull();
    expect(mocks.mappings.mock.calls.every(([ids]) => ids.length === 1 && ids[0] === anchor)).toBe(true);

    // The driver's fix is to click the returned tab, then wait for its entry.
    const target = host.querySelector<HTMLElement>(`[data-tab-id="${result.tabId}"]`)!;
    expect(target).not.toBeNull();
    await act(async () => { target.click(); await vi.advanceTimersByTimeAsync(250); });
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].activeTabId).toBe(result.tabId);
    expect(mocks.mappings).toHaveBeenLastCalledWith([result.sessionId]);
    const entry = host.querySelector<HTMLButtonElement>("[data-terminal-history-entry=true]");
    expect(entry).not.toBeNull();
    const request = vi.fn();
    window.addEventListener(TERMINAL_HISTORY_EVENT, request, { once: true });
    await act(async () => entry!.click());
    expect(request).toHaveBeenCalledOnce();
    expect((request.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: result.sessionId });
    expect(mocks.createSession).toHaveBeenCalledOnce();
    await act(async () => { target.click(); await vi.advanceTimersByTimeAsync(HISTORY_MAPPING_POLL_MS); });
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it("does not mistake the anchor's available history for the new tab's identity", async () => {
    mappings[anchor] = { agent_kind: "codex", session_id: "another-conversation" };
    const result = await handleSocketCommand("pane.spawn_tab", {
      anchorSessionId: anchor, commandArgv: [command, "--session-id", agentId],
    }) as { tabId: string; sessionId: string };
    await act(async () => root.render(<Toolbar />));
    expect(host.querySelector("[data-terminal-history-entry=true]")).not.toBeNull();
    expect(mocks.mappings).toHaveBeenLastCalledWith([anchor]);

    await act(async () => {
      host.querySelector<HTMLElement>(`[data-tab-id="${result.tabId}"]`)!.click();
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mocks.mappings).toHaveBeenLastCalledWith([result.sessionId]);
    expect(host.querySelector("[data-terminal-history-entry=true]")).toBeNull();
    expect(host.querySelector("[data-terminal-history-unavailable=true]")?.getAttribute("title"))
      .toBe(terminalTurnStrings.historyUnlinked);
  });
});

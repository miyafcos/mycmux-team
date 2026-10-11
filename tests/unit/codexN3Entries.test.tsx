// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceConfig } from "../../src/lib/ipc";
import type { PaneTab } from "../../src/types";
const mocks = vi.hoisted(() => ({ terminal: vi.fn(), create: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<typeof import("../../src/lib/ipc")>(),
  createSession: mocks.create, listRunningSessionIds: vi.fn(async () => []),
  getSessionStatusSnapshot: vi.fn(async () => ({ server_epoch: "fixture", seq: 1, sessions: [] })),
  getWindowFragments: vi.fn(async () => []),
}));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  default: (props: unknown) => { mocks.terminal(props); return <div />; },
  evictTerminalCache: vi.fn(), hasTerminalBuffer: () => false,
}));
vi.mock("../../src/components/workspace/PaneTabBar", () => ({ default: () => null }));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: () => null }));
import TerminalPane from "../../src/components/workspace/TerminalPane";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { buildAgentRecoveryLaunch, buildLaunchRequest } from "../../src/components/terminal/terminalLaunchParams";
import { buildTerminalPaneLaunch } from "../../src/lib/terminalPaneLaunch";
import { resolveDormantResumeIdentity } from "../../src/lib/agentDormancy";
import { getAgent, getDefaultAgent } from "../../src/lib/agents";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { prepareStartupSessionGate } from "../../src/lib/startupSessionGate";
// @ts-expect-error actual production graph from the pinned Git object
import { buildTerminalPaneLaunch as pinnedLaunch } from "codex-base:src/lib/terminalPaneLaunch.ts";
const A = "11111111-2222-4333-8444-555555555555";
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("React", React); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  prepareStartupSessionGate([]);
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  useSettingsStore.setState({ paneComposerEnabled: false });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function restore(agent: string, shape: "tabs" | "no-tabs" | "empty-tabs" = "tabs") {
  const config: WorkspaceConfig = { id: "n3", name: "Restore", grid_template_id: "1x1",
    panes: [{ pane_id: "pane", agent_id: agent, agent_kind: "codex", agent_session_id: A,
      cwd: "/fixture", active_tab_id: "tab",
      ...(shape === "no-tabs" ? {} : { tabs: shape === "empty-tabs" ? [] : [{ tab_id: "tab", agent_id: agent,
        type: "terminal", agent_kind: "codex", agent_session_id: A, cwd: "/fixture" }] }) }], split_columns: [[0]] };
  restoreWorkspaceConfigs([config], { dockDetached: false });
  return useWorkspaceListStore.getState().workspaces[0];
}
it("carries a runtime restore reason through the actual launch request", () => {
  expect(buildLaunchRequest({ command: "codex", args: [], restoreReason: "saved-codex-pane" } as Parameters<typeof buildLaunchRequest>[0]))
    .toHaveProperty("restoreReason", "saved-codex-pane");
});
it.each(["codex", "shell"])("mounts the main %s entry with exact A and the restore reason", async agent => {
  const ws = restore(agent);
  await act(async () => root.render(<TerminalPane workspaceId={ws.id} pane={ws.panes[0]} />));
  const props = mocks.terminal.mock.calls.at(-1)![0] as Parameters<typeof buildLaunchRequest>[0];
  const request = buildLaunchRequest(props);
  expect(request.env).toMatchObject({ MYCMUX_RESUME: "codex", MYCMUX_SESSION_ID: A });
  expect(request).toHaveProperty("restoreReason", "saved-codex-pane");
  expect(request.args).not.toContain("--last");
  if (agent === "shell") expect(request.env).toHaveProperty("__CMUX_LAUNCHER_DONE", "1");
});
it.each(["tabs", "no-tabs", "empty-tabs"] as const)("starts the background %s shape with exact A and the restore reason", async shape => {
  const ws = restore("codex", shape); const tab = ws.panes[0].tabs[0];
  await handleSocketCommand("pane.start_tab", { sessionId: tab.sessionId });
  const call = mocks.create.mock.calls[0] as unknown[];
  expect(call[7]).toMatchObject({ MYCMUX_RESUME: "codex", MYCMUX_SESSION_ID: A });
  expect(call[9]).toMatchObject({ backgroundOnly: true, restoreReason: "saved-codex-pane" });
  expect(call[2]).not.toContain("--last");
});
it.each(["codex", "shell"])("wakes retained dormant %s A after consuming the first reason, preserving the base exact ID", async agent => {
  const ws = restore(agent); const pane = ws.panes[0];
  const retained = { ...pane.tabs[0] } as PaneTab & { codexRestoreReason?: string };
  delete retained.codexRestoreReason;
  expect(resolveDormantResumeIdentity(retained)).toEqual({ agentKind: "codex", resumeSessionId: A });
  const agents = { getAgent, getDefaultAgent };
  const base = pinnedLaunch(pane, retained, agents);
  const wake = buildTerminalPaneLaunch(pane, retained, agents);
  expect(wake.launchEnv).toMatchObject({ MYCMUX_RESUME: "codex", MYCMUX_SESSION_ID: A });
  expect(base.launchEnv?.MYCMUX_SESSION_ID).toBe(A);
  expect(wake.launchArgs).not.toContain("--last");
  useWorkspaceListStore.getState()._updateWorkspacePanes(ws.id, [{ ...pane, tabs: [retained] }]);
  await handleSocketCommand("pane.start_tab", { sessionId: retained.sessionId });
  expect((mocks.create.mock.calls[0] as unknown[])[7]).toMatchObject({ MYCMUX_RESUME: "codex", MYCMUX_SESSION_ID: A });
  expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0].agentSessionId).toBe(A);
});
it("makes the explicit fresh recovery launch forget the failed ID", () => {
  const fresh = buildAgentRecoveryLaunch({ command: "codex", args: ["resume", A],
    launchEnv: { MYCMUX_RESUME: "codex", MYCMUX_SESSION_ID: A } }, "codex", A, true);
  expect(fresh.launchEnv?.MYCMUX_SESSION_ID).toBeUndefined();
  expect(fresh.launchEnv?.MYCMUX_RESUME).toBeUndefined();
  expect(fresh.args).not.toContain(A);
});

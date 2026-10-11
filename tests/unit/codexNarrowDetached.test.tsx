// @vitest-environment jsdom
import { act } from "react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ terminal: vi.fn(), invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "mycmux-w1", setTitle: vi.fn(async () => {}) }) }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ default: (props: unknown) => { mocks.terminal(props); return <div />; }, evictTerminalCache: vi.fn() }));
import DetachedPaneShell from "../../src/components/layout/DetachedPaneShell";
// @ts-expect-error immutable L16 integration component; live Codex cases stay above
import MergedDetachedPaneShell from "codex-merge:src/components/layout/DetachedPaneShell.tsx";
// @ts-expect-error actual component loaded from the pinned base Git tree
import PinnedDetachedPaneShell from "codex-base:src/components/layout/DetachedPaneShell.tsx";
import { partitionSavedWindows, type DetachedWorkspace } from "../../src/lib/detachedPane";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { buildLaunchRequest } from "../../src/components/terminal/terminalLaunchParams";
import type { WorkspaceConfig } from "../../src/lib/ipc";
let host: HTMLDivElement; let root: Root;
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("React", React);
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function saved(agent: string, kind: "codex" | "claude" | "claude-codex" | "grok", id?: string): WorkspaceConfig {
  return { id: "saved-child", name: "Saved", grid_template_id: "1x1", detached: true,
    panes: [{ pane_id: "pane", agent_id: agent, active_tab_id: "tab", cwd: "/fixture",
      tabs: [{ tab_id: "tab", agent_id: agent, type: "terminal", agent_kind: kind, agent_session_id: id,
        cwd: "/fixture", launch_env: { KEEP: "yes" } }] }], split_columns: [[0]] };
}
async function mount(Component: typeof DetachedPaneShell, ws: DetachedWorkspace) {
  mocks.terminal.mockClear();
  await act(async () => root.render(<Component workspace={ws} />));
  return mocks.terminal.mock.calls.at(-1)![0];
}
it.each(["codex", "shell"])("R7-4 adopts and mounts saved %s Codex with no existing PTY and forwards the missing-ID path", async agent => {
  const windows = partitionSavedWindows([saved(agent, "codex")]).windows;
  expect(windows).toHaveLength(1);
  // Same restoration caller used by adoptWorkspaceConfigs, with an empty
  // destination window and no transported/live PTY identity.
  restoreWorkspaceConfigs(windows[0].configs, { dockDetached: false });
  const ws = useWorkspaceListStore.getState().workspaces[0] as DetachedWorkspace;
  expect(ws.panes[0].tabs[0].codexRestoreReason).toBe("saved-codex-pane");
  const props = await mount(DetachedPaneShell, ws);
  const request = buildLaunchRequest(props);
  expect.soft(request.restoreReason).toBe("saved-codex-pane");
  if (agent === "shell") expect.soft(props.launchEnv.__CMUX_LAUNCHER_DONE).toBe("1");
  expect.soft(request.env?.MYCMUX_SESSION_ID).toBeUndefined();
  // Renderer boundary -> real sourced Bash restore helper. This checks the
  // fixed notice once. Native backend diagnosis is requested separately;
  // this fixture does not claim to execute create_session's Rust adapter.
  const output = request.restoreReason ? execFileSync("python3", ["-c",
    "import sys;sys.path.insert(0,'tests');from test_codex_restore_runtime import run_bash;print(run_bash('missing'),end='')"], { encoding: "utf8" }) : "";
  expect.soft(output.split("Previous conversation could not be restored; starting a new session.").length - 1).toBe(1);
  expect.soft(request.restoreReason && output).toBeTruthy();
});
it.each(["claude", "claude-codex", "grok"] as const)("keeps legacy detached %s launch parameters byte-identical to the pinned base", async kind => {
  for (const agent of ["shell", kind === "claude" ? "claude-code" : kind]) {
    for (const id of [undefined, "11111111-2222-4333-8444-555555555555"]) {
      useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
      restoreWorkspaceConfigs([saved(agent, kind, id)], { dockDetached: false });
      const ws = useWorkspaceListStore.getState().workspaces[0] as DetachedWorkspace;
      const base = await mount(PinnedDetachedPaneShell, ws);
      const candidate = await mount(MergedDetachedPaneShell, ws);
      const params = (props: typeof candidate) => ({ command: props.command, args: props.args, cwd: props.cwd,
        agentId: props.agentId, agentKind: props.agentKind, launchEnv: props.launchEnv, initialReplay: props.initialReplay,
        ...(props.restoreReason ? { restoreReason: props.restoreReason } : {}) });
      expect(JSON.stringify(params(candidate))).toBe(JSON.stringify(params(base)));
    }
  }
});

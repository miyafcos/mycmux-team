// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ kill: vi.fn(), destroy: vi.fn(async () => {}), confirm: vi.fn(async () => true), evict: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "mycmux-w1", destroy: mocks.destroy, setTitle: async () => {} }) }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<object>(), killSession: mocks.kill,
  setWindowCloseIntent: async () => {}, takePendingAdoption: async () => [] }));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: mocks.confirm }));
vi.mock("../../src/lib/paneCloseLifecycle", () => ({ beforePaneClose: vi.fn() }));
vi.mock("../../src/lib/focusController", () => ({ focusController: { request: vi.fn(), clearSession: vi.fn() } }));
vi.mock("../../src/components/terminal/terminalCache", async original => ({ ...await original<object>(), evictTerminalCache: mocks.evict }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ default: () => <div data-terminal-content="true" />,
  hasTerminalBuffer: () => false, getTerminalWriteCounter: () => 0, getTerminalBufferLines: () => [] }));
vi.mock("../../src/components/workspace/WebPaneController", () => ({ default: () => null, isChildWebviewPreview: () => false }));
import DetachedPaneShell from "../../src/components/layout/DetachedPaneShell";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { tearoutStrings } from "../../src/components/layout/tearoutStrings";
import type { DetachedWorkspace } from "../../src/lib/detachedPane";
let root: Root;
let host: HTMLDivElement;
const workspace: DetachedWorkspace = { id: "detached", name: "Detached", gridTemplateId: "1x1", status: "running", createdAt: 0, detached: true,
  panes: [{ id: "pane", sessionId: "pty-tab", activeTabId: "tab", agentId: "shell",
    tabs: [{ id: "tab", sessionId: "pty-tab", agentId: "shell", type: "terminal" }] }] };
const closeButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="このペインを閉じる"]')!;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks(); mocks.kill.mockResolvedValue(undefined); mocks.confirm.mockResolvedValue(true);
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  usePaneMetadataStore.setState({ metadata: { "pty-tab": { cwd: "/fixture" } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<DetachedPaneShell workspace={workspace} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe("legacy detached shell uses the real shared window close", () => {
  it("keeps the display, metadata and cache after kill failure and shows the native failure wording", async () => {
    mocks.kill.mockRejectedValueOnce(new Error("denied"));
    await act(async () => closeButton().click());
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe(tearoutStrings.failed));
    expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace]);
    expect(host.querySelector("[data-terminal-content]")).not.toBeNull();
    expect(usePaneMetadataStore.getState().metadata["pty-tab"]).toBeDefined();
    expect(mocks.evict).not.toHaveBeenCalled(); expect(mocks.destroy).not.toHaveBeenCalled();
    expect(closeButton().disabled).toBe(false);
  });
  it("waits for kill success, prevents duplicate clicks and then removes the workspace and destroys the window", async () => {
    let done!: () => void;
    mocks.kill.mockReturnValueOnce(new Promise<void>(resolve => { done = resolve; }));
    await act(async () => closeButton().click());
    await vi.waitFor(() => expect(mocks.kill).toHaveBeenCalledExactlyOnceWith("pty-tab"));
    expect(closeButton().disabled).toBe(true);
    expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace]);
    expect(mocks.destroy).not.toHaveBeenCalled(); expect(mocks.evict).not.toHaveBeenCalled();
    await act(async () => closeButton().click()); expect(mocks.kill).toHaveBeenCalledOnce();
    await act(async () => done());
    await vi.waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce());
    expect(useWorkspaceListStore.getState().workspaces).toEqual([]);
    expect(usePaneMetadataStore.getState().metadata["pty-tab"]).toBeUndefined(); expect(mocks.evict).toHaveBeenCalledExactlyOnceWith("pty-tab");
  });
  it("cancellation has no termination or window side effects", async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => closeButton().click());
    expect(mocks.kill).not.toHaveBeenCalled(); expect(mocks.destroy).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace]); expect(closeButton().disabled).toBe(false);
  });
});

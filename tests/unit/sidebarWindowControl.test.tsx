// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown) => "mycmux-w3") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import TabBar from "../../src/components/layout/TabBar";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useDetachedDockStore } from "../../src/stores/detachedDockStore";

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); useDetachedDockStore.getState().clear(); });
it("opens an empty sidebar via the real stable control and exact production invoke", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const original = useWorkspaceListStore.getState();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host); const newWorkspace = vi.fn();
  try {
    await act(async () => root.render(<TabBar onNewWorkspace={newWorkspace} onCloseWorkspace={() => {}} />));
    expect(host.querySelector('[data-dnd-new-workspace-target="true"]')).not.toBeNull();
    expect(host.querySelector("[data-detached-pane-shell]")).toBeNull();
    const control = host.querySelector<HTMLButtonElement>('[data-open-sidebar-window="true"]')!;
    expect(control).not.toBeNull();
    await act(async () => control.click());
    expect(mocks.invoke).toHaveBeenCalledWith("open_child_window", {
      label: null, x: null, y: null, width: null, height: null,
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "open_child_window")).toHaveLength(1);
    expect(newWorkspace).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().workspaces).toEqual([]);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "open_workspace_window" || command === "create_session")).toBe(false);
    const target = host.querySelector<HTMLButtonElement>('[data-dnd-new-workspace-target="true"]')!;
    const before = target.style.outline;
    await act(async () => useDetachedDockStore.getState().setTarget({ kind: "workspace" }));
    expect(target.style.outline).not.toBe(before);
  } finally {
    await act(async () => root.unmount()); host.remove();
    useWorkspaceListStore.setState(original, true);
  }
});

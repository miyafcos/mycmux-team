// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, Function>(), attachment: null as Promise<void> | null }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), emitTo: vi.fn(async () => {}),
  listen: async (event: string, callback: Function) => { mocks.listeners.set(event, callback); return () => mocks.listeners.delete(event); } }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "B", isMainWindow: () => false }));
vi.mock("../../src/lib/tearout/sessionAttachment", () => ({ rememberTearoutDormantSessions: vi.fn(),
  expectTearoutAttachments: () => ({ ready: mocks.attachment ?? Promise.resolve(), dispose() {} }) }));
import TabBar from "../../src/components/layout/TabBar";
import { installTearoutRuntime } from "../../src/lib/tearout/runtime";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useToastStore } from "../../src/stores/toastStore";
import { toTransferConfig } from "../../src/components/layout/SocketListener";
import { tearoutOperationBusy } from "../../src/lib/tearout/operation";
import { sidebarStrings } from "../../src/lib/sidebarStrings";
import type { Workspace } from "../../src/types";
const workspace: Workspace = { id: "workspace", name: "Terminal", createdAt: 1, status: "running", gridTemplateId: "1x1",
  panes: [{ id: "pane", agentId: "shell", sessionId: "pty-original", activeTabId: "tab", tabs: [{ id: "tab", sessionId: "pty-original", agentId: "shell", type: "terminal" }] }] };
let root: Root, host: HTMLDivElement, stop: () => void, release: () => void;
function pointer(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 7 }, clientX: { value: x }, clientY: { value: y },
    screenX: { value: x }, screenY: { value: y } }); return event;
}
const dispatch = (event: string, payload: unknown) => mocks.listeners.get(event)!({ payload });
beforeEach(async () => {
  vi.clearAllMocks(); mocks.listeners.clear(); vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  useSettingsStore.setState({ nativePaneTearoutEnabled: false });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null }); useToastStore.setState({ toasts: [] });
  usePaneDragStore.getState().clearDrag();
  mocks.invoke.mockImplementation(async (command: string) => { if (command === "is_session_alive") return true; });
  mocks.attachment = new Promise<void>(done => { release = done; });
  stop = installTearoutRuntime({ serialize: toTransferConfig, publish: async () => {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { await Promise.resolve(); root.render(<TabBar onNewWorkspace={() => {}} onCloseWorkspace={() => {}} />); });
});
afterEach(async () => {
  release(); dispatch("mycmux://tearout-revoke", { token: "incoming", source: "A", ack: "cleanup" });
  await act(async () => { await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false)); await root.unmount(); });
  stop(); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function dragOutside() {
  const row = host.querySelector<HTMLElement>('[data-dnd-workspace-target-id="workspace"]')!;
  expect(row).not.toBeNull();
  row.setPointerCapture = vi.fn(); row.hasPointerCapture = vi.fn(() => true); row.releasePointerCapture = vi.fn();
  await act(async () => { row.dispatchEvent(pointer("pointerdown", 20, 40)); });
  await act(async () => { row.dispatchEvent(pointer("pointermove", window.innerWidth + 80, 70)); });
  await act(async () => { row.dispatchEvent(pointer("pointerup", window.innerWidth + 80, 70)); });
}
it("F4 does not display a red ordinary-sidebar failure for a typed provisional-owner refusal", async () => {
  await act(async () => { dispatch("mycmux://tearout-delivery", { token: "incoming", source: "A", configs: [toTransferConfig(workspace)], liveSessions: ["pty-original"] }); });
  await vi.waitFor(() => expect(useWorkspaceListStore.getState().workspaces).toHaveLength(1));
  await dragOutside();
  await act(async () => { await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "tearout_log_record")).toBe(true)); });
  expect(useToastStore.getState().toasts.filter(toast => toast.kind === "error")).toEqual([]);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "open_workspace_window" || command === "tearout_prepare")).toBe(false);
  expect(useWorkspaceListStore.getState().workspaces).toHaveLength(1);
});
it("F4 keeps the real create failure visible through the ordinary wrapper and sidebar catch", async () => {
  mocks.attachment = null;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "is_session_alive") return true;
    if (command === "open_workspace_window") throw new Error("synthetic create failure");
  });
  await act(async () => { useWorkspaceListStore.setState({ workspaces: [structuredClone(workspace)], activeWorkspaceId: workspace.id }); });
  await dragOutside();
  await act(async () => { await vi.waitFor(() => expect(useToastStore.getState().toasts.some(toast => toast.kind === "error" && toast.message === sidebarStrings.newWindowFailed)).toBe(true)); });
  expect(mocks.invoke.mock.calls.some(([command]) => command === "open_workspace_window")).toBe(true);
  expect(useWorkspaceListStore.getState().workspaces).toHaveLength(1);
});

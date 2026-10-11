// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: vi.fn().mockResolvedValue(undefined), convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined), listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "legacy-browser", setTitle: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock("../../src/components/layout/SocketListener", () => ({ closeWindowWorkspacesAndDestroy: vi.fn() }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<object>(), readEditableArtifact: vi.fn().mockResolvedValue({ content: "<p>Preview</p>", sourceKind: "markdown" }) }));
import DetachedPaneShell from "../../src/components/layout/DetachedPaneShell";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { artifactEditorStrings as s } from "../../src/components/workspace/artifactEditorStrings";
import type { DetachedWorkspace } from "../../src/lib/detachedPane";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("L3 restores editor-content cancellation through the actual legacy BrowserPane host without a pane attribute", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const workspace: DetachedWorkspace = { id: "detached", name: "Browser", detached: true, gridTemplateId: "1x1", createdAt: 1, status: "running",
    panes: [{ id: "p", sessionId: "preview-session", agentId: "shell-starter", activeTabId: "preview",
      tabs: [{ id: "preview", sessionId: "preview-session", agentId: "shell-starter", type: "browser", sourceKind: "markdown", sourcePath: "/preview.md", htmlPath: "/preview.html" }] }] };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  useUiStore.setState({ activePaneId: "preview-session", zoomedPaneId: null, focusRevision: 0 });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<DetachedPaneShell workspace={workspace} />));
    expect(host.querySelector("[data-dnd-pane-id]")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label='${s.startEdit}']`)!.click());
    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!; editor.focus();
    const cancel = host.querySelector<HTMLButtonElement>(`button[aria-label='${s.discardEdits}']`)!;
    await act(async () => expect(cancel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))).toBe(false));
    expect(document.activeElement).toBe(editor);
    await act(async () => cancel.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(editor.isConnected).toBe(false); expect(document.activeElement).toBe(host.querySelector("[data-detached-pane-shell] button"));
  } finally { await act(async () => root.unmount()); host.remove(); }
});

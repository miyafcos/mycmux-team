// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, Workspace } from "../../src/types";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { KEYBINDING_DEFINITIONS } from "../../src/lib/keybindings";

// Execute AppShell's actual keyboard case without booting the app, native
// listeners, or unrelated dialogs.
const shell = readFileSync(new NodeURL("../../src/components/layout/AppShell.tsx", import.meta.url), "utf8");
const sourceHelper = shell.slice(shell.indexOf("function livePaneFocusOwner("), shell.indexOf("function isPlainXtermInputEvent("));
const closeCase = shell.split('case "pane.close": {')[1].split('case "pane.reopen":')[0];
const handler = new Function("ws", "aid", "apid", "paneMatchesSession", "closePaneOperation", "useWorkspaceListStore", "findPaneInDirection", "focusController", "e",
  ts.transpile(`${sourceHelper}\nconst lastFocusedPaneRef = { current: null };\nswitch ("pane.close") { case "pane.close": {${closeCase}}`));
const close = vi.fn(async () => ({ status: "closed" }));
const focus = { focusPaneSoon: vi.fn(), request: vi.fn() };
const neighbor = vi.fn(() => "pty-neighbor");
const pane = (count: number): Pane => ({ id: "p", agentId: "shell", sessionId: "pty-active", activeTabId: "active",
  tabs: Array.from({ length: count }, (_, i) => ({ id: i === 0 ? "active" : `hidden-${i}`, sessionId: i === 0 ? "pty-active" : `pty-hidden-${i}`, agentId: "shell", type: "terminal" as const })) });
const workspace = (count: number): Workspace => ({ id: "w", name: "Synthetic keyboard", status: "running", gridTemplateId: "1x1", createdAt: 1, panes: [pane(count)] });
async function run(workspace: Workspace, sessionId: string | null = "pty-active") {
  const event = new KeyboardEvent("keydown", { key: "w", ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  handler([workspace], workspace.id, sessionId, (pane: Pane, id: string) => pane.tabs.some((tab) => tab.sessionId === id),
    close, useWorkspaceListStore, neighbor, focus, event);
  await Promise.resolve();
}
beforeEach(() => {
  vi.clearAllMocks(); close.mockResolvedValue({ status: "closed" }); neighbor.mockReturnValue("pty-neighbor");
  useWorkspaceListStore.setState({ workspaces: [workspace(1)], activeWorkspaceId: "w" });
});

describe("Stage 2a actual keyboard close case", () => {
  it("closes the pane and preserves neighbor focus when it holds one session", async () => {
    await run(workspace(1));
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "w", paneId: "p" }, "ui");
    expect(focus.focusPaneSoon).not.toHaveBeenCalled();
    expect(neighbor).toHaveBeenCalledWith("pty-active", "right", expect.any(Array));
    expect(focus.request).toHaveBeenCalledExactlyOnceWith("keyboard", { sessionId: "pty-neighbor", focus: true });
  });
  it("closes only the displayed session and focuses the surviving pane when hidden sessions exist", async () => {
    await run(workspace(3));
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "tab", workspaceId: "w", paneId: "p", tabId: "active" }, "ui");
    expect(focus.focusPaneSoon).toHaveBeenCalledExactlyOnceWith("p");
    expect(neighbor).not.toHaveBeenCalled(); expect(focus.request).not.toHaveBeenCalled();
  });
  it.each(["refused", "cancelled", "failed"])("does not move focus after a %s close", async (status) => {
    close.mockResolvedValueOnce({ status });
    await run(workspace(3));
    expect(close).toHaveBeenCalledOnce(); expect(focus.focusPaneSoon).not.toHaveBeenCalled(); expect(focus.request).not.toHaveBeenCalled();
  });
  it("does nothing when the focused session no longer belongs to the workspace", async () => {
    await run(workspace(3), "missing");
    expect(close).not.toHaveBeenCalled(); expect(focus.request).not.toHaveBeenCalled();
  });
  it("keeps the shortcut and describes its approved one-versus-many meaning", () => {
    const binding = KEYBINDING_DEFINITIONS.find((definition) => definition.action === "pane.close");
    expect(binding?.defaultShortcut).toBe("ctrl+alt+w");
    expect(binding?.title).toBe("表示中のタブを閉じる");
  });
});

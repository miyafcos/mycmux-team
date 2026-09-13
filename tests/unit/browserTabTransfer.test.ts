import * as terminalCache from "../../src/components/terminal/terminalCache";
import { focusController } from "../../src/lib/focusController";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  hasTerminalBuffer: () => false, getTerminalWriteCounter: () => 0, getTerminalBufferLines: () => [],
}));
import { toConfig, toTransferConfig, serializePersistentWorkspaceSet } from "../../src/components/layout/SocketListener";
import { tearOutWorkspaceToNewWindow } from "../../src/lib/workspaceTearOut";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { canDropTarget } from "../../src/hooks/usePaneDragSource";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import * as ipc from "../../src/lib/ipc";
import type { PaneTab, Workspace } from "../../src/types";

function workspace(): Workspace {
  const terminal: PaneTab = { id: "terminal", agentId: "shell-starter", sessionId: "pty-original", type: "terminal" };
  const pdf: PaneTab = { id: "pdf", agentId: "shell-starter", sessionId: "pty-pdf", type: "browser",
    label: "Document", htmlPath: "C:/preview/index.html", sourcePath: "C:/docs/source.pdf",
    sourceKind: "pdf", previewPath: "C:/preview/source.pdf" };
  return { id: "source", name: "Source", gridTemplateId: "1x1", createdAt: 1, status: "running",
    panes: [{ id: "pane", agentId: terminal.agentId, sessionId: pdf.sessionId, activeTabId: pdf.id,
      pinnedTabId: pdf.id, tabs: [terminal, pdf] }], splitColumns: [["pane"]], columnWidths: [2], rowHeightsPerCol: [[3]] };
}
beforeEach(() => useWorkspaceListStore.getState()._replaceWorkspaces([]));
afterEach(() => { vi.restoreAllMocks(); useWorkspaceListStore.getState()._replaceWorkspaces([]); });

describe("browser window transfer", () => {
  it("keeps browser and web in transfer while retaining the existing save policy", () => {
    const ws = workspace();
    ws.panes[0].tabs.push({ id: "web", agentId: "shell-starter", sessionId: "pty-web", type: "web", presetId: "browser" });
    const before = structuredClone(ws);
    const transfer = toTransferConfig(ws);
    expect(transfer.panes[0].tabs!.map((tab) => tab.type)).toEqual(["terminal", "browser", "web"]);
    expect(transfer.panes[0].tabs![1]).toMatchObject({ html_path: "C:/preview/index.html", source_path: "C:/docs/source.pdf",
      source_kind: "pdf", preview_path: "C:/preview/source.pdf" });
    expect(transfer.panes[0].tabs![2].preset_id).toBe("browser");
    const saved = toConfig(ws);
    expect(saved.panes[0].tabs!.map((tab) => tab.type)).toEqual(["terminal", "web"]);
    expect(saved.panes[0].active_tab_id).toBe("terminal");
    expect(saved.panes[0].pinned_tab_id).toBeNull();
    expect(ws).toEqual(before);
  });

  it("delivers both terminal and PDF through the actual whole-workspace tear-out and adoption", async () => {
    const ws = workspace();
    useWorkspaceListStore.getState()._replaceWorkspaces([ws]);
    const open = vi.spyOn(ipc, "openWorkspaceWindow").mockResolvedValue("child");
    await expect(tearOutWorkspaceToNewWindow(ws.id)).resolves.toBe("child");
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(0);
    restoreWorkspaceConfigs(open.mock.calls[0][0].workspaces);
    const pane = useWorkspaceListStore.getState().getWorkspace(ws.id)!.panes[0];
    expect(pane.tabs.map((tab) => tab.id).sort()).toEqual(["pdf", "terminal"]);
    expect(pane.tabs.find((tab) => tab.id === "terminal")!.sessionId).toBe("pty-original");
    expect(pane.tabs.find((tab) => tab.id === "pdf")).toMatchObject(ws.panes[0].tabs[1]);
    expect(pane.activeTabId).toBe("pdf");
    expect(pane.pinnedTabId).toBe("pdf");
  });

  it("hands off before evicting local renderers and focus without killing PTYs", async () => {
    const ws = workspace();
    useWorkspaceListStore.getState()._replaceWorkspaces([ws]);
    const calls: string[] = [];
    vi.spyOn(ipc, "openWorkspaceWindow").mockImplementation(async () => { calls.push("open"); return "child"; });
    const evict = vi.spyOn(terminalCache, "evictTerminalCache").mockImplementation((id) => { calls.push(`evict:${id}`); });
    const clear = vi.spyOn(focusController, "clearSession").mockImplementation((id) => { calls.push(`focus:${id}`); });
    const kill = vi.spyOn(ipc, "killSession").mockResolvedValue();
    await tearOutWorkspaceToNewWindow(ws.id);
    expect(calls[0]).toBe("open");
    expect(evict.mock.calls.map(([id]) => id).sort()).toEqual(["pty-original", "pty-pdf"]);
    expect(clear.mock.calls.map(([id]) => id).sort()).toEqual(["pty-original", "pty-pdf"]);
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(0);
    expect(kill).not.toHaveBeenCalled();
  });
  it.each(["html", "markdown", "office", "pdf"] as const)("restores browser metadata for %s without terminal state", (sourceKind) => {
    const cfg = toTransferConfig(workspace()).panes[0];
    cfg.tabs = [{ ...cfg.tabs![1], source_kind: sourceKind, cwd: "C:/terminal", agent_kind: "claude", agent_session_id: "old",
      terminal_snapshot: ["stale"], launch_env: { TEST: "1" } }];
    const tab = useWorkspaceLayoutStore.getState().restorePanes("child", [cfg], [[0]], "1x1").panes[0].tabs[0];
    expect(tab).toMatchObject({ type: "browser", htmlPath: "C:/preview/index.html", sourceKind,
      sourcePath: "C:/docs/source.pdf", previewPath: "C:/preview/source.pdf" });
    expect(tab.agentSessionId).toBeUndefined(); expect(tab.cwd).toBeUndefined();
    expect(tab.launchEnv).toBeUndefined(); expect(tab.terminalSnapshot).toBeUndefined();
  });

  it("removes live previews from foreign and pending fragments before disk persistence", () => {
    const ws = workspace();
    ws.panes.push({ ...ws.panes[0], id: "preview-only", tabs: [{ ...ws.panes[0].tabs[1], id: "other-pdf" }], activeTabId: "other-pdf" });
    ws.splitColumns = [["preview-only"], ["pane"]]; ws.columnWidths = [5, 2]; ws.rowHeightsPerCol = [[4], [3]];
    const incoming = toTransferConfig(ws);
    const before = structuredClone(incoming);
    for (const pending of [false, true]) {
      const saved = serializePersistentWorkspaceSet({ sourceWorkspaces: [], preferredSelection: {},
        windowFragments: [{ window_label: pending ? "main" : "child", pending, workspaces: [incoming], active_workspace_id: ws.id }] }).configs[0];
      expect(saved.panes).toHaveLength(1);
      expect(saved.panes[0].tabs!.map((tab) => tab.type)).toEqual(["terminal"]);
      expect(saved.split_columns).toEqual([[0]]); expect(saved.column_widths).toEqual([2]);
      expect(saved.row_heights_per_col).toEqual([[3]]);
    }
    expect(incoming).toEqual(before);
  });

  it("never arms a mixed ephemeral pane or bundle and refuses a direct partial transfer", async () => {
    const ws = workspace(); ws.panes[0].tabs[0].ephemeral = true;
    useWorkspaceListStore.getState()._replaceWorkspaces([ws]);
    const target = { kind: "new-window" as const };
    expect(canDropTarget({ kind: "pane", workspaceId: ws.id, paneId: "pane" }, target)).toBe(false);
    expect(canDropTarget({ kind: "tab", workspaceId: ws.id, paneId: "pane", tabId: "terminal" }, target)).toBe(false);
    expect(canDropTarget({ kind: "tab-bundle", workspaceId: ws.id, paneId: "pane", anchorTabId: "pdf", tabIds: ["terminal", "pdf"] }, target)).toBe(false);
    expect(canDropTarget({ kind: "tab", workspaceId: ws.id, paneId: "pane", tabId: "pdf" }, target)).toBe(true);
    const open = vi.spyOn(ipc, "openWorkspaceWindow").mockResolvedValue("child");
    await expect(tearOutWorkspaceToNewWindow(ws.id)).rejects.toThrow("cannot be transferred");
    expect(open).not.toHaveBeenCalled(); expect(useWorkspaceListStore.getState().getWorkspace(ws.id)).toBe(ws);
  });
});

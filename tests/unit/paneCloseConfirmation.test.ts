import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "../../src/types";

const confirmDialog = vi.fn(async () => true);
const mockedStore = vi.hoisted(() => ({
  metadata: {} as Record<string, { processIsShell?: boolean; outputActive?: boolean }>,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmDialog }));
vi.mock("../../src/stores/paneMetadataStore", () => ({
  usePaneMetadataStore: { getState: () => mockedStore },
}));

const { confirmPaneClose } = await import("../../src/lib/paneCloseConfirmation");

function idlePane(): Pane {
  const tabs = [{ id: "t1", sessionId: "session-t1", agentId: "shell", label: "shell" }];
  return { id: "pane-1", agentId: "shell", sessionId: "session-t1", tabs, activeTabId: "t1" };
}

function cohabitingAgentPane(): Pane {
  const tabs = [
    { id: "t1", sessionId: "session-t1", agentId: "shell", label: "shell" },
    { id: "t2", sessionId: "session-t2", agentId: "shell", label: "codex", agentKind: "codex" as const },
  ];
  return { id: "pane-2", agentId: "shell", sessionId: "session-t1", tabs, activeTabId: "t1" };
}

function activeAgentPane(): Pane {
  const tabs = [{ id: "t2", sessionId: "session-t2", agentId: "shell", label: "codex", agentKind: "codex" as const }];
  return { id: "pane-2", agentId: "shell", sessionId: "session-t2", tabs, activeTabId: "t2" };
}

describe("confirmPaneClose", () => {
  beforeEach(() => {
    confirmDialog.mockClear();
    confirmDialog.mockResolvedValue(true);
    mockedStore.metadata = {};
  });

  it("closes a pane holding nothing live without asking", async () => {
    await expect(confirmPaneClose([idlePane()], "pane")).resolves.toBe(true);
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("asks before closing a pane whose active tab is an agent", async () => {
    await expect(confirmPaneClose([activeAgentPane()], "pane")).resolves.toBe(true);
    expect(confirmDialog).toHaveBeenCalledOnce();
  });

  it("uses the agent wording for a cohabiting live agent tab", async () => {
    await expect(confirmPaneClose([cohabitingAgentPane()], "pane")).resolves.toBe(true);
    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(confirmDialog.mock.calls[0][0]).toBe("このタブには実行中のエージェントペインが 1 件あります。まとめて閉じますか？");
    expect(confirmDialog.mock.calls[0][1]).toMatchObject({ okLabel: "終了", cancelLabel: "キャンセル" });
  });

  it("uses the existing wording for a busy non-agent tab", async () => {
    mockedStore.metadata = {
      "session-t1": { processIsShell: false, outputActive: true },
    };
    await expect(confirmPaneClose([idlePane()], "pane")).resolves.toBe(true);
    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(confirmDialog.mock.calls[0][0]).toContain("稼働中のペインが 1 個あります");
  });

  // A workspace close has always been confirmed. Reusing the pane rule here
  // would silently drop that prompt whenever no tab happened to look busy.
  it("asks before a workspace close even when no tab looks busy", async () => {
    await expect(confirmPaneClose([idlePane()], "workspace", { workspaceName: "開発" })).resolves.toBe(true);
    expect(confirmDialog).toHaveBeenCalledOnce();
    const [body, options] = confirmDialog.mock.calls[0];
    expect(body).toContain("開発");
    expect(options.title).toBe("このワークスペースを閉じます");
  });

  // Closing the last window is quitting, and everything comes back next
  // launch; closing one of several ends the work in it. The question has to
  // say which one it is asking.
  it("says the work comes back when the window being closed is the last one", async () => {
    await expect(confirmPaneClose([idlePane()], "window", { peerWindowCount: 0 })).resolves.toBe(true);
    const [body, options] = confirmDialog.mock.calls[0];
    expect(options.title).toBe("mycmux を終了します");
    expect(body).toContain("次に起動したときに、いまの状態から再開できます。");
  });

  it("says the work does not come back while another window stays open", async () => {
    await expect(confirmPaneClose([idlePane()], "window", { peerWindowCount: 2 })).resolves.toBe(true);
    const [body, options] = confirmDialog.mock.calls[0];
    expect(options.title).toBe("このウィンドウを閉じます");
    expect(body).toContain("次に起動しても戻りません");
    expect(body).toContain("他の 2 個のウィンドウ");
  });

  it("returns false when the user cancels", async () => {
    confirmDialog.mockResolvedValue(false);
    await expect(confirmPaneClose([cohabitingAgentPane()], "pane")).resolves.toBe(false);
  });

  it("treats a dialog failure as cancel", async () => {
    confirmDialog.mockRejectedValue(new Error("dialog unavailable"));
    await expect(confirmPaneClose([cohabitingAgentPane()], "pane")).resolves.toBe(false);
  });
});

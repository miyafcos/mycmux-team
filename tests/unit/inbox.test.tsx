// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import ToastHost from "../../src/components/common/ToastHost";
import { InboxButton } from "../../src/components/inbox/InboxButton";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { inboxStrings, inboxSenderLabel, postInboxMessage, openInboxEntry, type InboxEntry } from "../../src/lib/inbox";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useUiStore } from "../../src/stores/uiStore";
import { createWorkspaceAtCwd } from "../../src/lib/workspaceBootstrap";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()), invoke: vi.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const entry: InboxEntry = { from: "grokbot", title: "入試制度の変更", path: "grokbot/20261008_report.md", receivedAt: 1791414000000 };
const args = { from: entry.from, title: entry.title, path: entry.path };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  __resetToastStoreForTests();
  useSettingsStore.setState({ notificationsEnabled: true, toastUserActionEnabled: true });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  __resetToastStoreForTests();
  host.remove();
  vi.restoreAllMocks();
});

async function render(element: React.ReactNode) {
  await act(async () => { root.render(element); });
}

function selectWorkspace() {
  createWorkspaceAtCwd("", { name: "Work" });
  const workspace = useWorkspaceListStore.getState().getActiveWorkspace()!;
  const pane = workspace.panes[0];
  useUiStore.setState({ activePaneId: pane.sessionId });
  return { workspace, pane };
}

describe("inbox delivery notices", () => {
  it.each([["codex", "Codex"], ["constructor", "constructor"], ["toString", "toString"]])("displays sender %s as %s", (from, label) => {
    expect(inboxSenderLabel(from)).toBe(label);
  });

  it("dispatches through Rust validation, uses the sender display name and offers Open", async () => {
    vi.mocked(invoke).mockResolvedValue(entry);
    await render(<ToastHost />);
    await act(async () => { expect(await handleSocketCommand("inbox.post", args)).toEqual(entry); });
    expect(invoke).toHaveBeenCalledWith("inbox_post", args);
    expect(host.textContent).toContain("Grok Bot から届きました: 入試制度の変更");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === inboxStrings.open)).toBe(true);
    expect(useToastStore.getState().toasts[0].category).toBe("user-action");
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(0);
  });

  it("does not stack the same delivered file, including concurrent posts", async () => {
    vi.mocked(invoke).mockResolvedValue(entry);
    await Promise.all([postInboxMessage(args), postInboxMessage(args), postInboxMessage(args)]);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("keeps distinct same-title reports as separate actions", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(entry).mockResolvedValueOnce({ ...entry, path: "grokbot/second.md" });
    await postInboxMessage(args);
    await postInboxMessage({ ...args, path: "grokbot/second.md" });
    expect(useToastStore.getState().toasts).toHaveLength(2);
  });

  it("opens the validated document in the existing Markdown preview only on click", async () => {
    const { workspace, pane } = selectWorkspace();
    const preview = { sourceKind: "markdown", sourcePath: "/profile/inbox/grokbot/report.md", previewPath: "/profile/preview.html" };
    vi.mocked(invoke).mockResolvedValueOnce(entry).mockResolvedValueOnce(preview);
    const open = vi.spyOn(useWorkspaceLayoutStore.getState(), "openOrReloadHtmlPreviewPane").mockImplementation(() => {});
    await postInboxMessage(args);
    await render(<ToastHost />);
    expect(open).not.toHaveBeenCalled();
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === inboxStrings.open)!;
    await act(async () => {
      button.click();
      await vi.waitFor(() => {
        expect(invoke).toHaveBeenLastCalledWith("inbox_preview", { sessionId: pane.sessionId, path: entry.path });
        expect(open).toHaveBeenCalledWith(workspace.id, pane.id, preview);
      });
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("emits no receipt notice when Rust rejects the path", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("inbox path is outside the inbox"));
    await expect(postInboxMessage({ ...args, path: "../outside.md" })).rejects.toThrow("outside");
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("respects existing notification settings", async () => {
    useSettingsStore.setState({ notificationsEnabled: false });
    vi.mocked(invoke).mockResolvedValue(entry);
    await postInboxMessage(args);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("revalidates at open time and reports failure without opening a preview", async () => {
    selectWorkspace();
    const open = vi.spyOn(useWorkspaceLayoutStore.getState(), "openOrReloadHtmlPreviewPane").mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValue(new Error("inbox paths must not contain junctions"));
    await openInboxEntry(entry);
    expect(open).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0].message).toContain(inboxStrings.openFailed);
  });
});

describe("inbox title-bar entry", () => {
  it("loads only on explicit open and makes all twenty recent documents accessible", async () => {
    selectWorkspace();
    const recent = Array.from({ length: 20 }, (_, i) => ({ ...entry, title: "Report " + i, path: "grokbot/" + i + ".md" }));
    vi.mocked(invoke).mockResolvedValueOnce(recent).mockResolvedValueOnce({ sourceKind: "markdown", previewPath: "preview.html", sourcePath: "note.md" });
    const open = vi.spyOn(useWorkspaceLayoutStore.getState(), "openOrReloadHtmlPreviewPane").mockImplementation(() => {});
    await render(<InboxButton />);
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    const panel = document.getElementById("inbox-panel")!;
    expect(invoke).toHaveBeenCalledWith("inbox_recent");
    expect(panel.querySelectorAll("li")).toHaveLength(20);
    const button = panel.querySelector<HTMLButtonElement>('button[aria-label="Report 0 開く"]')!;
    await act(async () => button.click());
    expect(invoke).toHaveBeenLastCalledWith("inbox_preview", expect.objectContaining({ path: "grokbot/0.md" }));
    expect(open).toHaveBeenCalledOnce();
  });

  it("shows a recoverable listing error and reloads after Refresh", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("unreadable")).mockResolvedValueOnce([]);
    await render(<InboxButton />);
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    const panel = document.getElementById("inbox-panel")!;
    expect(panel.textContent).toContain(inboxStrings.failed);
    const button = [...panel.querySelectorAll("button")].find((item) => item.textContent === inboxStrings.refresh)!;
    await act(async () => button.click());
    expect(panel.textContent).toContain(inboxStrings.empty);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

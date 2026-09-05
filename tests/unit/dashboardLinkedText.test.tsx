// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  preview: vi.fn(),
  reveal: vi.fn(),
  openPath: vi.fn(),
  resolve: vi.fn(),
  openPreviewPane: vi.fn(),
  openInDashboardPreview: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("../../src/lib/ipc", () => ({
  previewArtifactUriForSessionV2: mocks.preview,
  revealPathInExplorer: mocks.reveal,
  openPathWithDefaultApp: mocks.openPath,
}));
vi.mock("../../src/stores/workspaceStore", () => ({
  useWorkspaceLayoutStore: (selector: (state: { openOrReloadHtmlPreviewPane: typeof mocks.openPreviewPane }) => unknown) => selector({ openOrReloadHtmlPreviewPane: mocks.openPreviewPane }),
}));
vi.mock("../../src/components/terminal/terminalLinkProvider", () => ({
  HTTP_LINK_REGEX: /https?:\/\/[^\s]+/i,
  isArtifactPreviewUri: (uri: string) => /\.(?:md|html?)$/i.test(uri),
  isDirectoryLikeUri: (uri: string) => /[\\/]$/.test(uri),
  resolveTextLocalPathLinks: mocks.resolve,
}));

import { DashboardLinkedText } from "../../src/components/dashboard/DashboardLinkedText";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.open.mockReset();
  mocks.preview.mockReset();
  mocks.reveal.mockReset();
  mocks.openPath.mockReset();
  mocks.resolve.mockReset();
  mocks.openPreviewPane.mockReset();
  mocks.openInDashboardPreview.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  window.getSelection()?.removeAllRanges();
  container.remove();
});

async function renderText(text: string): Promise<void> {
  await act(async () => {
    root.render(<DashboardLinkedText text={text} />);
    await Promise.resolve();
  });
}

describe("DashboardLinkedText", () => {
  it("renders only paths confirmed by the terminal resolver", async () => {
    mocks.resolve.mockResolvedValue([]);

    await renderText("C:\\missing\\not-real.pdf");

    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("opens a resolved directory in Explorer", async () => {
    const path = "C:\\Users\\miyaz\\Dropbox\\成果物\\";
    mocks.resolve.mockResolvedValue([{ text: path, index: 0, endIndex: path.length, activationUri: path }]);

    await renderText(path);
    await act(async () => { (container.querySelector("a") as HTMLAnchorElement).click(); });

    expect(mocks.reveal).toHaveBeenCalledWith(path);
  });

  it("does not activate a path after text is drag-selected", async () => {
    const path = "C:\\Users\\miyaz\\Dropbox\\成果物\\";
    mocks.resolve.mockResolvedValue([{ text: path, index: 0, endIndex: path.length, activationUri: path }]);

    await renderText(path);
    const link = container.querySelector("a") as HTMLAnchorElement;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(link);
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => { link.click(); });

    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it("offers the terminal-equivalent default-app and Explorer choices for a resolved file", async () => {
    const path = "C:\\Users\\miyaz\\Dropbox\\成果物\\report.pdf";
    mocks.resolve.mockResolvedValue([{ text: path, index: 0, endIndex: path.length, activationUri: path }]);

    await renderText(path);
    await act(async () => { (container.querySelector("a") as HTMLAnchorElement).click(); });

    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "既定のアプリで開く",
      "ファイルの場所を表示",
    ]);
    expect(mocks.openInDashboardPreview).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.openPreviewPane).not.toHaveBeenCalled();
  });

  it("opens an artifact preview in the dashboard column when the context asks for it", async () => {
    const path = "C:\\Users\\miyaz\\Dropbox\\成果物\\report.html";
    mocks.resolve.mockResolvedValue([{ text: path, index: 0, endIndex: path.length, activationUri: path }]);
    mocks.preview.mockResolvedValue({
      previewPath: path,
      sourcePath: path,
      sourceKind: "html",
    });

    await act(async () => {
      root.render(<DashboardLinkedText
        text={path}
        context={{
          workspaceId: "ws-a",
          paneId: "pane-a",
          sessionId: "session-a",
          canPreviewInternally: true,
          openInDashboardPreview: mocks.openInDashboardPreview,
        }}
      />);
      await Promise.resolve();
    });
    await act(async () => { (container.querySelector("a") as HTMLAnchorElement).click(); });
    await act(async () => { await Promise.resolve(); });

    expect(mocks.preview).toHaveBeenCalledWith("session-a", path);
    expect(mocks.openInDashboardPreview).toHaveBeenCalledWith({
      previewPath: path,
      sourcePath: path,
      sourceKind: "html",
    });
    expect(mocks.openPreviewPane).not.toHaveBeenCalled();
  });

  it("does not open a dashboard preview column for a URI that is not an artifact preview", async () => {
    const path = "C:\\Users\\miyaz\\Dropbox\\成果物\\report.pdf";
    mocks.resolve.mockResolvedValue([{ text: path, index: 0, endIndex: path.length, activationUri: path }]);

    await act(async () => {
      root.render(<DashboardLinkedText
        text={path}
        context={{
          workspaceId: "ws-a",
          paneId: "pane-a",
          sessionId: "session-a",
          canPreviewInternally: true,
          openInDashboardPreview: mocks.openInDashboardPreview,
        }}
      />);
      await Promise.resolve();
    });
    await act(async () => { (container.querySelector("a") as HTMLAnchorElement).click(); });

    expect(mocks.openInDashboardPreview).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.openPreviewPane).not.toHaveBeenCalled();
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "既定のアプリで開く",
      "ファイルの場所を表示",
    ]);
  });

  it("opens a resolved file with the default app through IPC, not plugin-shell", async () => {
    const path = "C:\\Users\\miyaz\\Dropbox\\report.pdf";
    mocks.resolve.mockResolvedValue([{ text: path, index: 0, endIndex: path.length, activationUri: path }]);
    mocks.openPath.mockResolvedValue(undefined);

    await renderText(path);
    await act(async () => { (container.querySelector("a") as HTMLAnchorElement).click(); });
    const openButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === dashboardStrings.pathActionOpenDefault,
    );
    expect(openButton).toBeTruthy();
    await act(async () => { openButton!.click(); });

    expect(mocks.openPath).toHaveBeenCalledWith(path);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("shows a failure label when opening with the default app rejects", async () => {
    const path = "C:\\Users\\miyaz\\Dropbox\\report.pdf";
    mocks.resolve.mockResolvedValue([{ text: path, index: 0, endIndex: path.length, activationUri: path }]);
    mocks.openPath.mockRejectedValue("access denied");

    await renderText(path);
    await act(async () => { (container.querySelector("a") as HTMLAnchorElement).click(); });
    const openButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === dashboardStrings.pathActionOpenDefault,
    );
    await act(async () => {
      openButton!.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(dashboardStrings.pathActionFailed("access denied"));
  });
});

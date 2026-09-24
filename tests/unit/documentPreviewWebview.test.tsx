// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  collectWebPaneTabs,
  isChildWebviewPreview,
  webPaneIdentity,
  webPaneUrl,
  DOCUMENT_PREVIEW_PRESET_ID,
} from "../../src/components/workspace/WebPaneController";
import BrowserPane from "../../src/components/workspace/BrowserPane";
import type { PaneTab, Workspace } from "../../src/types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
  invoke: vi.fn(),
}));

const noop = () => {};

function tab(overrides: Partial<PaneTab> = {}): PaneTab {
  return {
    id: "preview-tab",
    sessionId: "session",
    agentId: "agent",
    type: "browser",
    htmlPath: "C:/reports/report.html",
    previewPath: "C:/reports/report.html",
    sourcePath: "C:/reports/report.html",
    sourceKind: "html",
    reloadCounter: 0,
    ...overrides,
  };
}

function workspaceWith(...tabs: PaneTab[]): Workspace[] {
  return [{
    id: "w",
    name: "w",
    gridTemplateId: "single",
    status: "running",
    panes: [{ id: "p", agentId: "a", sessionId: "s", tabs, activeTabId: tabs[0]?.id }],
  } as unknown as Workspace];
}

describe("which previews get a child webview", () => {
  it("takes an HTML preview and leaves every other kind alone", () => {
    expect(isChildWebviewPreview({ type: "browser", sourceKind: "html", previewPath: "x" })).toBe(true);
    for (const sourceKind of ["markdown", "text", "office", "pdf"]) {
      expect(isChildWebviewPreview({ type: "browser", sourceKind, previewPath: "x" })).toBe(false);
    }
    // A terminal or a Web tab is not a document preview whatever else it says.
    expect(isChildWebviewPreview({ type: "terminal", sourceKind: "html", previewPath: "x" })).toBe(false);
    // Nothing to show is not a preview either.
    expect(isChildWebviewPreview({ type: "browser", sourceKind: "html" })).toBe(false);
  });
});

describe("collectWebPaneTabs", () => {
  it("gives an HTML preview the preview preset and the file it shows", () => {
    expect(collectWebPaneTabs(workspaceWith(tab()))).toEqual([{
      tabId: "preview-tab",
      presetId: DOCUMENT_PREVIEW_PRESET_ID,
      previewPath: "C:/reports/report.html",
      previewReload: 0,
    }]);
  });

  it("falls back to htmlPath exactly as the pane does", () => {
    // A tab carrying only htmlPath would otherwise show a host rectangle with
    // no webview over it: a white area with nothing to explain it.
    const [descriptor] = collectWebPaneTabs(workspaceWith(tab({ previewPath: undefined })));
    expect(descriptor?.previewPath).toBe("C:/reports/report.html");
  });

  it("leaves Markdown, text, Office and PDF previews out", () => {
    for (const sourceKind of ["markdown", "text", "office", "pdf"] as const) {
      expect(collectWebPaneTabs(workspaceWith(tab({ sourceKind })))).toEqual([]);
    }
  });

  it("still collects Web tabs unchanged", () => {
    const web = tab({
      id: "web-tab",
      type: "web",
      presetId: "chatgpt",
      htmlPath: undefined,
      previewPath: undefined,
      sourceKind: undefined,
    });
    expect(collectWebPaneTabs(workspaceWith(web))).toEqual([{
      tabId: "web-tab",
      presetId: "chatgpt",
      webBackground: undefined,
      webInitialUrl: undefined,
    }]);
  });
});

describe("webPaneIdentity", () => {
  it("rebuilds only when the file changes", () => {
    const base = { tabId: "t", presetId: DOCUMENT_PREVIEW_PRESET_ID, previewPath: "a.html", previewReload: 0 };
    expect(webPaneIdentity(base)).toBe(webPaneIdentity({ ...base }));
    expect(webPaneIdentity({ ...base, previewPath: "b.html" })).not.toBe(webPaneIdentity(base));
    expect(webPaneIdentity({ ...base, previewReload: 1 })).toBe(webPaneIdentity(base));
  });

  it("leaves a Web tab keyed on its preset alone", () => {
    // Navigating ChatGPT must not rebuild its webview; the session lives in it.
    const web = { tabId: "t", presetId: "chatgpt", webInitialUrl: "https://chatgpt.com/c/1" };
    expect(webPaneIdentity(web)).toBe("chatgpt");
  });
});

describe("webPaneUrl", () => {
  it("reads a preview's file through the asset protocol", () => {
    expect(webPaneUrl({ tabId: "t", presetId: DOCUMENT_PREVIEW_PRESET_ID, previewPath: "C:/a/b.html" }))
      .toBe("http://asset.localhost/C%3A%2Fa%2Fb.html");
  });

  it("has no address for a preview with no file", () => {
    expect(webPaneUrl({ tabId: "t", presetId: DOCUMENT_PREVIEW_PRESET_ID })).toBeUndefined();
  });

  it("hands a Web tab its own initial url", () => {
    expect(webPaneUrl({ tabId: "t", presetId: "chatgpt", webInitialUrl: "https://chatgpt.com/" }))
      .toBe("https://chatgpt.com/");
  });
});

describe("the pane's host rectangle", () => {
  function markupFor(props: Record<string, unknown>) {
    return renderToStaticMarkup(createElement(BrowserPane, {
      htmlPath: "C:/reports/report.html",
      previewPath: "C:/reports/report.html",
      sourcePath: "C:/reports/report.html",
      sourceKind: "html",
      reloadKey: 0,
      isDirty: false,
      onDirtyChange: noop,
      onSaved: noop,
      ...props,
    } as never));
  }

  it("puts out a host for the child webview instead of a frame", () => {
    const markup = markupFor({ tabId: "preview-tab" });
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const host = doc.querySelector("[data-web-pane-host-tab-id]");
    expect(host?.getAttribute("data-web-pane-host-tab-id")).toBe("preview-tab");
    expect(doc.querySelector("iframe")).toBeNull();
    expect(doc.querySelector("embed")).toBeNull();
  });

  it("keeps the toolbar, which is drawn above the webview and not inside it", () => {
    const markup = markupFor({ tabId: "preview-tab" });
    expect(markup).toContain("HTML");
    expect(markup).toContain("report.html");
  });

  it("stays on the frame where there is no tab to place a webview over", () => {
    // The dashboard's preview column is not a tab, so it keeps the frame.
    const doc = new DOMParser().parseFromString(markupFor({}), "text/html");
    expect(doc.querySelector("[data-web-pane-host-tab-id]")).toBeNull();
    expect(doc.querySelector("iframe")).not.toBeNull();
  });
});

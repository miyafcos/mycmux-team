import { describe, expect, it } from "vitest";
import {
  browserTabNeedsReload,
  type BrowserPreviewInfo,
} from "../../src/stores/workspaceLayoutStore";
import type { PaneTab } from "../../src/types";

const sourcePath = "C:/reports/report.html";
const previewPath = sourcePath;

function tab(overrides: Partial<PaneTab> = {}): PaneTab {
  return {
    id: "tab",
    sessionId: "session",
    agentId: "agent",
    type: "browser",
    htmlPath: previewPath,
    previewPath,
    sourcePath,
    sourceKind: "html",
    sourceMtimeMs: 1_700_000_000_000,
    isDirty: false,
    reloadCounter: 3,
    ...overrides,
  };
}

function info(overrides: Partial<Required<BrowserPreviewInfo>> = {}): Required<BrowserPreviewInfo> {
  return {
    previewPath,
    sourcePath,
    sourceKind: "html",
    sourceMtimeMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("browserTabNeedsReload", () => {
  it("leaves a document that has not changed alone", () => {
    // Clicking the same path twice used to re-lay-out the whole file, which on
    // a 13 MB report is seconds of a frozen pane for nothing.
    expect(browserTabNeedsReload(tab(), info())).toBe(false);
  });

  it("reloads once the file has been written again", () => {
    expect(browserTabNeedsReload(tab(), info({ sourceMtimeMs: 1_700_000_005_000 }))).toBe(true);
  });

  it("reloads when either side has no timestamp to compare", () => {
    expect(browserTabNeedsReload(tab({ sourceMtimeMs: null }), info())).toBe(true);
    expect(browserTabNeedsReload(tab(), info({ sourceMtimeMs: null }))).toBe(true);
    expect(browserTabNeedsReload(tab(), undefined)).toBe(true);
  });

  it("reloads when the tab is now showing a different file", () => {
    expect(browserTabNeedsReload(tab(), info({ sourcePath: "C:/reports/other.html" }))).toBe(true);
    expect(browserTabNeedsReload(tab(), info({ previewPath: "C:/reports/other.html" }))).toBe(true);
  });

  it("reloads an edited document, so unsaved work is not shown as saved", () => {
    expect(browserTabNeedsReload(tab({ isDirty: true }), info())).toBe(true);
  });
});

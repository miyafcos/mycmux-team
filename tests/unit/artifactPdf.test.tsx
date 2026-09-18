// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { sourceKindFromPath } from "../../src/stores/workspaceLayoutStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { isArtifactPreviewUri, findLocalFilePathLinks } from "../../src/components/terminal/terminalLinkProvider";
import ArtifactEditorToolbar from "../../src/components/workspace/ArtifactEditorToolbar";
import BrowserPane from "../../src/components/workspace/BrowserPane";
import { rendersThemedSrcDoc, resolveBrowserIframeSources } from "../../src/lib/browserPanePreview";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `http://asset.localhost/${path}`,
  invoke: vi.fn(),
}));

const noop = () => {};

describe("PDF artifacts", () => {
  it.each(["C:/reports/report.pdf", "C:/reports/report.PDF"])("recognizes %s in source detection and terminal links", (path) => {
    expect(sourceKindFromPath(path)).toBe("pdf");
    expect(isArtifactPreviewUri(path)).toBe(true);
    expect(findLocalFilePathLinks(path).length).toBeGreaterThan(0);
  });

  it("labels an inferred dashboard PDF preview", () => {
    useDashboardViewStore.getState().openOrReloadPreviewColumn({ previewPath: "C:/reports/report.pdf" });
    expect(useDashboardViewStore.getState().previewColumn).toMatchObject({ sourceKind: "pdf", label: "PDF report.pdf" });
  });

  it("renders the original PDF asset in a native PDF embed instead of the sandboxed iframe", () => {
    expect(rendersThemedSrcDoc("pdf")).toBe(false);
    expect(resolveBrowserIframeSources({
      isEditing: false, editableSrcDoc: "", readOnlySrcDoc: "",
      assetSrc: "http://asset.localhost/report.pdf",
    })).toEqual({ src: "http://asset.localhost/report.pdf", srcDoc: undefined });
    const markup = renderToStaticMarkup(createElement(BrowserPane, {
      htmlPath: "report.pdf", sourcePath: "report.pdf", sourceKind: "pdf",
      reloadKey: 0, isDirty: false, onDirtyChange: noop, onSaved: noop,
    }));
    expect(markup).toContain('src="http://asset.localhost/report.pdf"');
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const preview = doc.querySelector("embed");
    expect(preview?.getAttribute("type")).toBe("application/pdf");
    expect(preview?.getAttribute("src")).toBe("http://asset.localhost/report.pdf");
    expect(preview?.hasAttribute("sandbox")).toBe(false);
    expect(doc.querySelector("iframe")).toBeNull();
    expect(markup).not.toContain("srcDoc=");
    expect(markup).not.toContain("mycmux-artifact-editor");
    expect(markup).not.toContain("lucide-pencil");
    expect(markup).not.toContain("lucide-save");
  });

  it.each(["html", "markdown", "text", "office"] as const)("keeps the %s preview on the original sandboxed iframe", (sourceKind) => {
    const markup = renderToStaticMarkup(createElement(BrowserPane, {
      htmlPath: "preview.html", sourcePath: "source", sourceKind,
      reloadKey: 0, isDirty: false, onDirtyChange: noop, onSaved: noop,
    }));
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const frame = doc.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-popups allow-same-origin");
    expect(doc.querySelector("embed, object")).toBeNull();
    expect(markup).not.toContain("allow-scripts");
  });

  it.each([false, true])("hides PDF edit and save controls even with editing=%s", (isEditing) => {
    const markup = renderToStaticMarkup(createElement(ArtifactEditorToolbar, {
      sourcePath: "report.pdf", sourceKind: "pdf", canEdit: true,
      isEditing, isDirty: true, isBusy: false,
      onStartEdit: noop, onSave: noop, onCancel: noop, onReload: noop,
      onRevealSource: noop, onOpenSource: noop, onCommand: noop,
    }));
    expect(markup).toContain(">PDF<");
    expect(markup).not.toContain("lucide-pencil");
    expect(markup).not.toContain("lucide-save");
    expect(markup).toContain("lucide-external-link");
  });
});

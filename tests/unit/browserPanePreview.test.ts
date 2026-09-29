import { describe, expect, it } from "vitest";
import {
  rendersThemedSrcDoc,
  resolveBrowserIframeSources,
} from "../../src/lib/browserPanePreview";

const assetSrc = "http://asset.localhost/preview.html";
const editableSrcDoc = "<html>editable</html>";
const readOnlySrcDoc = "<html>readonly</html>";

describe("rendersThemedSrcDoc", () => {
  it("is true for the kinds the app renders itself", () => {
    expect(rendersThemedSrcDoc("markdown")).toBe(true);
    expect(rendersThemedSrcDoc("text")).toBe(true);
  });

  it("is false for the kinds shown as the file on disk", () => {
    expect(rendersThemedSrcDoc("html")).toBe(false);
    expect(rendersThemedSrcDoc("office")).toBe(false);
    expect(rendersThemedSrcDoc("pdf")).toBe(false);
    expect(rendersThemedSrcDoc(undefined)).toBe(false);
  });
});

describe("resolveBrowserIframeSources", () => {
  it("shows the editable document while editing, whatever else is loaded", () => {
    expect(resolveBrowserIframeSources({
      isEditing: true,
      editableSrcDoc,
      readOnlySrcDoc,
      assetSrc,
    })).toEqual({ src: undefined, srcDoc: editableSrcDoc });
  });

  it("shows the rendered document once it has arrived", () => {
    expect(resolveBrowserIframeSources({
      isEditing: false,
      editableSrcDoc: "",
      readOnlySrcDoc,
      assetSrc,
    })).toEqual({ src: undefined, srcDoc: readOnlySrcDoc });
  });

  it("holds the frame empty while a themed document is still on its way", () => {
    // The preview on disk carries the stylesheet's own light palette, so
    // showing it first flashes a white page in a dark workspace.
    expect(resolveBrowserIframeSources({
      isEditing: false,
      editableSrcDoc: "",
      readOnlySrcDoc: "",
      assetSrc,
      awaitReadOnlySrcDoc: true,
    })).toEqual({ src: undefined, srcDoc: undefined });
  });

  it("points an html preview straight at the file on disk", () => {
    // No fetch, no ArrayBuffer and no Blob: those copied a 13 MB report twice
    // through the thread that also paints the terminal.
    expect(resolveBrowserIframeSources({
      isEditing: false,
      editableSrcDoc: "",
      readOnlySrcDoc: "",
      assetSrc,
    })).toEqual({ src: assetSrc, srcDoc: undefined });
  });

  it("falls back to the file on disk when the rendered document never came", () => {
    expect(resolveBrowserIframeSources({
      isEditing: false,
      editableSrcDoc: "",
      readOnlySrcDoc: "",
      assetSrc,
      awaitReadOnlySrcDoc: false,
    })).toEqual({ src: assetSrc, srcDoc: undefined });
  });
});

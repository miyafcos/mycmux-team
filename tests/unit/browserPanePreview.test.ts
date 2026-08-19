// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  READONLY_HTML_BLOB_MIME,
  createReadonlyHtmlBlob,
  initialHtmlBlobPreview,
  objectUrlToRevoke,
  resolveBrowserIframeSources,
  shouldLoadHtmlAsBlobPreview,
} from "../../src/lib/browserPanePreview";

describe("shouldLoadHtmlAsBlobPreview", () => {
  it("is true only for read-only html", () => {
    expect(shouldLoadHtmlAsBlobPreview("html", false)).toBe(true);
    expect(shouldLoadHtmlAsBlobPreview("html", true)).toBe(false);
    expect(shouldLoadHtmlAsBlobPreview("markdown", false)).toBe(false);
    expect(shouldLoadHtmlAsBlobPreview("office", false)).toBe(false);
    expect(shouldLoadHtmlAsBlobPreview(undefined, false)).toBe(false);
  });
});

describe("createReadonlyHtmlBlob", () => {
  it("forces text/html charset even when the source buffer has no type", () => {
    const blob = createReadonlyHtmlBlob(new TextEncoder().encode("<html></html>"));
    expect(blob.type).toBe(READONLY_HTML_BLOB_MIME);
  });
});

describe("objectUrlToRevoke", () => {
  it("revokes the previous url only when it is replaced or cleared", () => {
    expect(objectUrlToRevoke("blob:a", "blob:b")).toBe("blob:a");
    expect(objectUrlToRevoke("blob:a", null)).toBe("blob:a");
    expect(objectUrlToRevoke("blob:a", "blob:a")).toBe(null);
    expect(objectUrlToRevoke(null, "blob:b")).toBe(null);
    expect(objectUrlToRevoke(null, null)).toBe(null);
  });
});

describe("initialHtmlBlobPreview", () => {
  it("starts loading only for read-only html", () => {
    expect(initialHtmlBlobPreview("html")).toEqual({ status: "loading" });
    expect(initialHtmlBlobPreview("html", true)).toEqual({ status: "idle" });
    expect(initialHtmlBlobPreview("markdown")).toEqual({ status: "idle" });
    expect(initialHtmlBlobPreview("office")).toEqual({ status: "idle" });
  });
});

describe("resolveBrowserIframeSources", () => {
  const assetSrc = "http://asset.localhost/preview.html";
  const blobUrl = "blob:http://localhost/html";
  const readOnlySrcDoc = "<html>readonly</html>";
  const editableSrcDoc = "<html>edit</html>";

  it("prefers the editor srcDoc while editing", () => {
    expect(resolveBrowserIframeSources({
      isEditing: true,
      editableSrcDoc,
      htmlBlobPreview: { status: "ready", url: blobUrl },
      readOnlySrcDoc,
      assetSrc,
    })).toEqual({ src: undefined, srcDoc: editableSrcDoc });
  });

  it("leaves src and srcDoc unset while the html blob is loading", () => {
    expect(resolveBrowserIframeSources({
      isEditing: false,
      editableSrcDoc,
      htmlBlobPreview: { status: "loading" },
      readOnlySrcDoc,
      assetSrc,
    })).toEqual({ src: undefined, srcDoc: undefined });
  });

  it("uses the blob url when the html preview is ready", () => {
    expect(resolveBrowserIframeSources({
      isEditing: false,
      editableSrcDoc,
      htmlBlobPreview: { status: "ready", url: blobUrl },
      readOnlySrcDoc,
      assetSrc,
    })).toEqual({ src: blobUrl, srcDoc: undefined });
  });

  it("falls back to the asset protocol src after a blob load error", () => {
    expect(resolveBrowserIframeSources({
      isEditing: false,
      editableSrcDoc,
      htmlBlobPreview: { status: "error" },
      readOnlySrcDoc,
      assetSrc,
    })).toEqual({ src: assetSrc, srcDoc: undefined });
  });

  it("resolves markdown/office through readOnlySrcDoc then the asset src", () => {
    expect(resolveBrowserIframeSources({
      isEditing: false,
      editableSrcDoc,
      htmlBlobPreview: { status: "idle" },
      readOnlySrcDoc,
      assetSrc,
    })).toEqual({ src: undefined, srcDoc: readOnlySrcDoc });
    expect(resolveBrowserIframeSources({
      isEditing: false,
      editableSrcDoc,
      htmlBlobPreview: { status: "idle" },
      readOnlySrcDoc: "",
      assetSrc,
    })).toEqual({ src: assetSrc, srcDoc: undefined });
  });
});

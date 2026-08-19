import type { ArtifactSourceKind } from "../types";

export const READONLY_HTML_BLOB_MIME = "text/html;charset=utf-8";

export type HtmlBlobPreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error" };

export function shouldLoadHtmlAsBlobPreview(
  sourceKind: ArtifactSourceKind | undefined,
  isEditing: boolean,
): boolean {
  return sourceKind === "html" && !isEditing;
}

export function initialHtmlBlobPreview(
  sourceKind: ArtifactSourceKind | undefined,
  isEditing = false,
): HtmlBlobPreviewState {
  return shouldLoadHtmlAsBlobPreview(sourceKind, isEditing)
    ? { status: "loading" }
    : { status: "idle" };
}

export function htmlBlobPreviewUrl(state: HtmlBlobPreviewState): string | null {
  return state.status === "ready" ? state.url : null;
}

export function createReadonlyHtmlBlob(data: BufferSource): Blob {
  return new Blob([data], { type: READONLY_HTML_BLOB_MIME });
}

export function objectUrlToRevoke(
  previousUrl: string | null,
  nextUrl: string | null,
): string | null {
  return previousUrl && previousUrl !== nextUrl ? previousUrl : null;
}

export function resolveBrowserIframeSources(input: {
  isEditing: boolean;
  editableSrcDoc: string;
  htmlBlobPreview: HtmlBlobPreviewState;
  readOnlySrcDoc: string;
  assetSrc: string;
}): { src: string | undefined; srcDoc: string | undefined } {
  if (input.isEditing) {
    return { src: undefined, srcDoc: input.editableSrcDoc };
  }
  switch (input.htmlBlobPreview.status) {
    case "loading":
      return { src: undefined, srcDoc: undefined };
    case "ready":
      return { src: input.htmlBlobPreview.url, srcDoc: undefined };
    case "error":
      return { src: input.assetSrc, srcDoc: undefined };
    case "idle":
      if (input.readOnlySrcDoc) {
        return { src: undefined, srcDoc: input.readOnlySrcDoc };
      }
      return { src: input.assetSrc, srcDoc: undefined };
  }
}

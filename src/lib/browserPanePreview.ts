import type { ArtifactSourceKind } from "../types";

/**
 * Whether the pane shows a document it rendered itself, painted in the current
 * theme, rather than the file as it sits on disk.
 *
 * Markdown and plain text are both turned into a standalone HTML document by
 * the backend and handed to the frame as a `srcDoc`, so the theme can be
 * written over them and their links can be answered by the pane. HTML, PDF and
 * the spreadsheet/deck previews are pointed at a file instead.
 */
export function rendersThemedSrcDoc(sourceKind: ArtifactSourceKind | undefined): boolean {
  return sourceKind === "markdown" || sourceKind === "text";
}

export function resolveBrowserIframeSources(input: {
  isEditing: boolean;
  editableSrcDoc: string;
  readOnlySrcDoc: string;
  assetSrc: string;
  /**
   * Wait for the rendered document instead of showing the file on disk first.
   * The preview written to disk carries the stylesheet's own light palette, so
   * loading it first flashes a white page before the themed document arrives.
   */
  awaitReadOnlySrcDoc?: boolean;
}): { src: string | undefined; srcDoc: string | undefined } {
  if (input.isEditing) {
    return { src: undefined, srcDoc: input.editableSrcDoc };
  }
  if (input.readOnlySrcDoc) {
    return { src: undefined, srcDoc: input.readOnlySrcDoc };
  }
  if (input.awaitReadOnlySrcDoc) {
    return { src: undefined, srcDoc: undefined };
  }
  // An HTML file arrives here: the frame is given the asset URL and the WebView
  // streams the file itself. It used to be fetched into an ArrayBuffer and then
  // into a Blob first, which copied a 13 MB report twice through the same
  // thread that paints the terminal.
  return { src: input.assetSrc, srcDoc: undefined };
}

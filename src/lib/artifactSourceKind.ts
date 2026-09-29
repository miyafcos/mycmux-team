import type { ArtifactSourceKind } from "../types";

/**
 * Which file a path names, for the one pane that shows documents.
 *
 * This file is the front end's half of a pair. `is_previewable_artifact` and
 * `artifact_source_kind` in `src-tauri/src/commands/artifact/mod.rs` are the
 * gate that actually refuses anything else; the lists here decide whether a
 * path in terminal output looks clickable and which viewer it opens. When the
 * two halves disagree, a link underlines and then fails on the click, which is
 * how a whole class of "nothing happened" reports used to start.
 *
 * It lives in one module because the same table used to be written out three
 * times (the terminal link provider, the workspace store and the dashboard
 * store) and the copies drifted.
 */
export const ARTIFACT_EXTENSION_PATTERN = String.raw`html?|markdown|md|txt|text|log|pdf|docx?|docm|dotx?|dotm|xlsx?|xlsm|xlsb|xltx?|xltm|pptx?|pptm|potx?|potm|ppsx?|ppsm`;

const PDF_EXTENSION = /\.pdf$/i;
const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/i;
const TEXT_EXTENSION = /\.(?:txt|text|log)$/i;
const OFFICE_EXTENSION =
  /\.(?:docx?|docm|dotx?|dotm|xlsx?|xlsm|xlsb|xltx?|xltm|pptx?|pptm|potx?|potm|ppsx?|ppsm)$/i;

export function sourceKindFromPath(path: string): ArtifactSourceKind {
  if (PDF_EXTENSION.test(path)) return "pdf";
  if (MARKDOWN_EXTENSION.test(path)) return "markdown";
  if (TEXT_EXTENSION.test(path)) return "text";
  if (OFFICE_EXTENSION.test(path)) return "office";
  // Anything the backend let through that is not one of the above is HTML: it
  // is the only kind the pane shows exactly as it sits on disk, so it is also
  // the only safe answer for a name this table does not recognise.
  return "html";
}

export function sourceKindLabel(kind: ArtifactSourceKind): string {
  switch (kind) {
    case "pdf":
      return "PDF";
    case "markdown":
      return "MD";
    case "text":
      return "TXT";
    case "office":
      return "OFFICE";
    case "html":
      return "HTML";
  }
}

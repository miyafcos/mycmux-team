import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ArtifactSourceKind } from "../../types";
import {
  openWithDefault,
  readEditableArtifact,
  revealInExplorer,
  saveEditableArtifact,
  type SaveEditableArtifactResult,
} from "../../lib/ipc";
import { useKeybindingStore } from "../../stores/keybindingStore";
import {
  createReadonlyHtmlBlob,
  htmlBlobPreviewUrl,
  initialHtmlBlobPreview,
  objectUrlToRevoke,
  resolveBrowserIframeSources,
  shouldLoadHtmlAsBlobPreview,
  type HtmlBlobPreviewState,
} from "../../lib/browserPanePreview";
import ArtifactEditorToolbar, {
  type ArtifactEditorCommand,
  type ArtifactEditorCommandValue,
} from "./ArtifactEditorToolbar";

interface BrowserPaneProps {
  /** Local absolute path (no file:// prefix). Already normalized by the caller. */
  htmlPath: string;
  sourcePath?: string;
  sourceKind?: ArtifactSourceKind;
  previewPath?: string;
  /** Bump to force iframe remount when the same htmlPath is re-emitted. */
  reloadKey: number;
  isDirty: boolean;
  onDirtyChange: (isDirty: boolean) => void;
  onSaved: (result: SaveEditableArtifactResult) => void;
  onZoomToggle?: () => void;
}

const EDITOR_STYLE_ID = "mycmux-artifact-editor-style";
const OFFICE_PAGE_CLASS = "mycmux-doc-page";

function removeScripts(doc: Document): void {
  doc.querySelectorAll("script").forEach((script) => script.remove());
}

function parentHrefFor(sourcePath: string | undefined): string | null {
  if (!sourcePath) return null;
  const normalized = sourcePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return null;
  return convertFileSrc(normalized.slice(0, index + 1));
}

function isOfficeEditorSource(sourceKind: ArtifactSourceKind | undefined): boolean {
  return sourceKind === "office";
}

function getOfficePage(body: HTMLElement): HTMLElement | null {
  return Array.from(body.children).find((child): child is HTMLElement => {
    return child instanceof HTMLElement && child.classList.contains(OFFICE_PAGE_CLASS);
  }) ?? null;
}

function wrapOfficeBody(doc: Document, isEditing: boolean): void {
  doc.body.classList.add("mycmux-office-surface");
  doc.body.classList.toggle("mycmux-office-editing", isEditing);
  doc.body.classList.toggle("mycmux-office-previewing", !isEditing);
  if (getOfficePage(doc.body)) return;
  const page = doc.createElement("main");
  page.className = OFFICE_PAGE_CLASS;
  while (doc.body.firstChild) {
    page.appendChild(doc.body.firstChild);
  }
  doc.body.appendChild(page);
}

function editorCss(sourceKind: ArtifactSourceKind | undefined): string {
  const officeCss = isOfficeEditorSource(sourceKind)
    ? `
    html {
      background: #dfe4eb;
    }
    body.mycmux-office-surface {
      min-height: 100vh;
      margin: 0;
      padding: 28px;
      box-sizing: border-box;
      background: #dfe4eb;
      color: #1f2937;
      font-family: Aptos, "Yu Gothic", Meiryo, "Segoe UI", sans-serif;
      font-size: 12pt;
      line-height: 1.55;
    }
    body.mycmux-office-surface .${OFFICE_PAGE_CLASS} {
      width: min(820px, calc(100vw - 56px));
      min-height: calc(100vh - 56px);
      margin: 0 auto;
      padding: 72px 76px;
      box-sizing: border-box;
      background: #ffffff;
      box-shadow: 0 18px 48px rgba(15, 23, 42, 0.16);
      border: 1px solid #d7dde6;
    }
    body.mycmux-office-surface p,
    body.mycmux-office-surface h1,
    body.mycmux-office-surface h2,
    body.mycmux-office-surface h3,
    body.mycmux-office-surface blockquote {
      margin-top: 0;
      margin-bottom: 0.72em;
      overflow-wrap: anywhere;
    }
    body.mycmux-office-surface h1 {
      font-size: 22pt;
      line-height: 1.22;
      margin-bottom: 0.58em;
    }
    body.mycmux-office-surface h2 {
      font-size: 18pt;
      line-height: 1.26;
      margin-bottom: 0.62em;
    }
    body.mycmux-office-surface h3 {
      font-size: 15pt;
      line-height: 1.3;
    }
    body.mycmux-office-surface blockquote {
      margin-left: 0.5in;
      padding-left: 0.16in;
      border-left: 3px solid #cbd5e1;
      color: #334155;
    }
    body.mycmux-office-surface table {
      width: 100%;
      margin: 0 0 1em;
      border-collapse: collapse;
    }
    body.mycmux-office-surface th,
    body.mycmux-office-surface td {
      border: 1px solid #c9d2df;
      min-width: 54px;
      min-height: 24px;
      padding: 7px 9px;
      vertical-align: top;
    }
    body.mycmux-office-surface th {
      background: #f8fafc;
    }
    body.mycmux-office-surface .mycmux-equation,
    body.mycmux-office-surface [data-mycmux-equation] {
      display: inline-block;
      margin: 0 0.12em;
      padding: 0.06em 0.34em;
      border: 1px solid #bfdbfe;
      border-radius: 4px;
      background: #eff6ff;
      color: #1d4ed8;
      font-family: "Cambria Math", "Times New Roman", serif;
      font-style: italic;
      white-space: pre-wrap;
    }
    @media (max-width: 700px) {
      body.mycmux-office-surface {
        padding: 14px;
      }
      body.mycmux-office-surface .${OFFICE_PAGE_CLASS} {
        width: calc(100vw - 28px);
        min-height: calc(100vh - 28px);
        padding: 38px 28px;
      }
    }
  `
    : "";
  return `
    body[contenteditable="true"] {
      outline: none;
      min-height: calc(100vh - 64px);
      caret-color: #0a84ff;
    }
    body[contenteditable="true"] table {
      border-collapse: collapse;
      min-width: 160px;
    }
    body[contenteditable="true"] th,
    body[contenteditable="true"] td {
      border: 1px solid #cbd5e1;
      min-width: 48px;
      min-height: 24px;
      padding: 6px 8px;
    }
    body[contenteditable="true"] th {
      background: #f8fafc;
    }
    body[contenteditable="true"] :focus {
      outline: 2px solid rgba(10, 132, 255, 0.28);
      outline-offset: 2px;
    }
    ${officeCss}
  `;
}

function buildEditableSrcDoc(
  content: string,
  sourcePath: string | undefined,
  sourceKind: ArtifactSourceKind | undefined,
): string {
  const doc = new DOMParser().parseFromString(content, "text/html");
  removeScripts(doc);

  const href = parentHrefFor(sourcePath);
  if (href && !doc.head.querySelector("base[data-mycmux-editor-base]")) {
    const base = doc.createElement("base");
    base.href = href;
    base.setAttribute("data-mycmux-editor-base", "true");
    doc.head.prepend(base);
  }

  const style = doc.createElement("style");
  style.id = EDITOR_STYLE_ID;
  style.textContent = editorCss(sourceKind);
  doc.head.appendChild(style);
  if (isOfficeEditorSource(sourceKind)) {
    wrapOfficeBody(doc, true);
  }
  doc.body.setAttribute("contenteditable", "true");
  doc.body.setAttribute("spellcheck", "true");
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function buildReadOnlySrcDoc(
  content: string,
  sourcePath: string | undefined,
  sourceKind: ArtifactSourceKind | undefined,
): string {
  const doc = new DOMParser().parseFromString(content, "text/html");
  removeScripts(doc);

  const href = parentHrefFor(sourcePath);
  if (href && !doc.head.querySelector("base[data-mycmux-editor-base]")) {
    const base = doc.createElement("base");
    base.href = href;
    base.setAttribute("data-mycmux-editor-base", "true");
    doc.head.prepend(base);
  }

  if (isOfficeEditorSource(sourceKind)) {
    wrapOfficeBody(doc, false);
    const style = doc.createElement("style");
    style.id = EDITOR_STYLE_ID;
    style.textContent = editorCss(sourceKind);
    doc.head.appendChild(style);
  }

  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function serializeEditableHtml(doc: Document): string {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script").forEach((script) => script.remove());
  clone.querySelector(`style#${EDITOR_STYLE_ID}`)?.remove();
  clone.querySelector('base[data-mycmux-editor-base="true"]')?.remove();
  const body = clone.querySelector("body");
  body?.removeAttribute("contenteditable");
  body?.removeAttribute("spellcheck");
  return `<!doctype html>\n${clone.outerHTML}\n`;
}

function htmlFontSizeForPointSize(value: string): string {
  const size = Number(value);
  if (!Number.isFinite(size)) return "3";
  if (size <= 10) return "2";
  if (size <= 13) return "3";
  if (size <= 16) return "4";
  if (size <= 20) return "5";
  if (size <= 28) return "6";
  return "7";
}

function fontTagSizeToPointSize(value: string): string | null {
  switch (value.trim()) {
    case "1":
      return "8";
    case "2":
      return "10";
    case "3":
      return "12";
    case "4":
      return "14";
    case "5":
      return "18";
    case "6":
      return "24";
    case "7":
      return "32";
    default:
      return null;
  }
}

function normalizeGeneratedFontTags(root: ParentNode, forcedFontSizePt?: string): void {
  root.querySelectorAll("font").forEach((font) => {
    const span = font.ownerDocument.createElement("span");
    const face = font.getAttribute("face");
    const size = forcedFontSizePt ?? fontTagSizeToPointSize(font.getAttribute("size") ?? "");
    if (face) span.style.fontFamily = face;
    if (size) span.style.fontSize = `${size}pt`;
    while (font.firstChild) {
      span.appendChild(font.firstChild);
    }
    font.replaceWith(span);
  });
}

function serializeEditableBodyHtml(doc: Document, sourceKind: ArtifactSourceKind | undefined): string {
  const clone = doc.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script").forEach((script) => script.remove());
  normalizeGeneratedFontTags(clone);
  if (isOfficeEditorSource(sourceKind)) {
    return getOfficePage(clone)?.innerHTML ?? clone.innerHTML;
  }
  return clone.innerHTML;
}

function isEditableWordSource(sourceKind: ArtifactSourceKind | undefined, sourcePath: string | undefined): boolean {
  return sourceKind === "office" && /\.(?:docx|docm|dotx|dotm)$/i.test(sourcePath ?? "");
}

function closestElement(node: Node | null, selector: string): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement && current.matches(selector)) return current;
    current = current.parentNode;
  }
  return null;
}

function insertStarterTable(doc: Document): void {
  doc.execCommand(
    "insertHTML",
    false,
    "<table><tbody><tr><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td></tr></tbody></table><p><br></p>",
  );
}

function isRangeInsideBody(doc: Document, range: Range): boolean {
  const ancestor = range.commonAncestorContainer;
  return ancestor === doc.body || doc.body.contains(ancestor);
}

function restoreEditorSelection(doc: Document, range: Range | null): void {
  doc.body.focus();
  if (!range || !isRangeInsideBody(doc, range)) return;
  const selection = doc.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertEquation(doc: Document, expression: string): boolean {
  const span = doc.createElement("span");
  span.className = "mycmux-equation";
  span.dataset.mycmuxEquation = expression;
  span.textContent = expression;
  return doc.execCommand("insertHTML", false, `${span.outerHTML}&nbsp;`);
}

function runTableCommand(doc: Document, command: ArtifactEditorCommand): boolean {
  const selection = doc.getSelection();
  const cell = closestElement(selection?.anchorNode ?? null, "td,th") as HTMLTableCellElement | null;
  if (!cell) {
    if (command === "addRow" || command === "addColumn") {
      insertStarterTable(doc);
      return true;
    }
    return false;
  }

  const row = cell.parentElement as HTMLTableRowElement | null;
  const table = closestElement(cell, "table") as HTMLTableElement | null;
  if (!row || !table) return false;

  if (command === "addRow") {
    const nextRow = doc.createElement("tr");
    const width = Math.max(row.cells.length, 1);
    for (let index = 0; index < width; index += 1) {
      const nextCell = doc.createElement("td");
      nextCell.innerHTML = "<br>";
      nextRow.appendChild(nextCell);
    }
    row.after(nextRow);
    return true;
  }

  if (command === "addColumn") {
    const cellIndex = Math.max(cell.cellIndex, 0);
    Array.from(table.rows).forEach((tableRow) => {
      const tag = tableRow.parentElement?.tagName.toLowerCase() === "thead" ? "th" : "td";
      const nextCell = doc.createElement(tag);
      nextCell.innerHTML = "<br>";
      const anchor = tableRow.cells[Math.min(cellIndex, tableRow.cells.length - 1)];
      if (anchor) {
        anchor.after(nextCell);
      } else {
        tableRow.appendChild(nextCell);
      }
    });
    return true;
  }

  if (command === "deleteRow") {
    const section = row.parentElement;
    row.remove();
    if (section && section.children.length === 0) section.remove();
    if (table.rows.length === 0) table.remove();
    return true;
  }

  if (command === "deleteColumn") {
    const cellIndex = Math.max(cell.cellIndex, 0);
    Array.from(table.rows).forEach((tableRow) => {
      tableRow.cells[cellIndex]?.remove();
    });
    if (!Array.from(table.rows).some((tableRow) => tableRow.cells.length > 0)) {
      table.remove();
    }
    return true;
  }

  return false;
}

function BrowserPaneImpl({
  htmlPath,
  sourcePath,
  sourceKind,
  previewPath,
  reloadKey,
  isDirty,
  onDirtyChange,
  onSaved,
  onZoomToggle,
}: BrowserPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const inputCleanupRef = useRef<(() => void) | null>(null);
  const selectionRangeRef = useRef<Range | null>(null);
  const preserveEditAfterSaveRef = useRef(false);
  const lastSavedSourcePathRef = useRef<string | null>(null);
  const saveCurrentArtifactRef = useRef<() => void>(() => {});
  const editLoadRequestRef = useRef(0);
  const readOnlyBlobUrlRef = useRef<string | null>(null);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onSavedRef = useRef(onSaved);
  const [isEditing, setIsEditing] = useState(false);
  const [dirty, setDirty] = useState(isDirty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [editableSrcDoc, setEditableSrcDoc] = useState<string>("");
  const [readOnlySrcDoc, setReadOnlySrcDoc] = useState<string>("");
  const [htmlBlobPreview, setHtmlBlobPreview] = useState<HtmlBlobPreviewState>(() =>
    initialHtmlBlobPreview(sourceKind),
  );
  const [localReloadKey, setLocalReloadKey] = useState(0);
  const resolvedPreviewPath = previewPath ?? htmlPath;
  const src = useMemo(() => convertFileSrc(resolvedPreviewPath), [resolvedPreviewPath]);
  const canUseInAppEditor =
    sourceKind === "html" || sourceKind === "markdown" || isEditableWordSource(sourceKind, sourcePath);
  const canEdit = Boolean(sourcePath && canUseInAppEditor);
  const getActionsForEvent = useKeybindingStore((s) => s.getActionsForEvent);

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const updateDirty = useCallback((nextDirty: boolean) => {
    setDirty(nextDirty);
    onDirtyChangeRef.current(nextDirty);
  }, []);

  const adoptHtmlBlobPreview = useCallback((next: HtmlBlobPreviewState) => {
    const nextUrl = htmlBlobPreviewUrl(next);
    const revoke = objectUrlToRevoke(readOnlyBlobUrlRef.current, nextUrl);
    if (revoke) URL.revokeObjectURL(revoke);
    readOnlyBlobUrlRef.current = nextUrl;
    setHtmlBlobPreview(next);
  }, []);

  useEffect(() => {
    setDirty(isDirty);
  }, [isDirty]);

  useEffect(() => {
    if (
      preserveEditAfterSaveRef.current
      && lastSavedSourcePathRef.current
      && sourcePath === lastSavedSourcePathRef.current
    ) {
      preserveEditAfterSaveRef.current = false;
      lastSavedSourcePathRef.current = null;
      setError(null);
      updateDirty(false);
      return;
    }
    inputCleanupRef.current?.();
    inputCleanupRef.current = null;
    editLoadRequestRef.current += 1;
    setIsEditing(false);
    setMarkdownDraft("");
    setEditableSrcDoc("");
    setReadOnlySrcDoc("");
    adoptHtmlBlobPreview(initialHtmlBlobPreview(sourceKind));
    selectionRangeRef.current = null;
    setError(null);
    updateDirty(false);
  }, [htmlPath, resolvedPreviewPath, reloadKey, sourceKind, sourcePath, updateDirty, adoptHtmlBlobPreview]);

  useEffect(() => {
    return () => {
      inputCleanupRef.current?.();
      const leftover = readOnlyBlobUrlRef.current;
      if (leftover) {
        URL.revokeObjectURL(leftover);
        readOnlyBlobUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const startEdit = useCallback(async () => {
    if (!sourcePath || !canUseInAppEditor) return;
    const requestId = editLoadRequestRef.current + 1;
    editLoadRequestRef.current = requestId;
    setBusy(true);
    setError(null);
    try {
      const source = await readEditableArtifact(sourcePath);
      if (editLoadRequestRef.current !== requestId) return;
      if (source.sourceKind === "markdown") {
        setMarkdownDraft(source.rawContent ?? "");
        setEditableSrcDoc("");
      } else {
        setMarkdownDraft("");
        setEditableSrcDoc(buildEditableSrcDoc(source.content, source.sourcePath, source.sourceKind));
      }
      setIsEditing(true);
      selectionRangeRef.current = null;
      updateDirty(false);
    } catch (caught) {
      if (editLoadRequestRef.current !== requestId) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (editLoadRequestRef.current === requestId) {
        setBusy(false);
      }
    }
  }, [canUseInAppEditor, sourcePath, updateDirty]);

  useEffect(() => {
    if (shouldLoadHtmlAsBlobPreview(sourceKind, isEditing)) {
      let cancelled = false;
      const controller = new AbortController();

      const loadBlob = async () => {
        try {
          const url = convertFileSrc(resolvedPreviewPath);
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) throw new Error(`asset fetch failed: ${res.status}`);
          const buf = await res.arrayBuffer();
          if (cancelled) return;
          const objectUrl = URL.createObjectURL(createReadonlyHtmlBlob(buf));
          if (cancelled) {
            URL.revokeObjectURL(objectUrl);
            return;
          }
          adoptHtmlBlobPreview({ status: "ready", url: objectUrl });
          setReadOnlySrcDoc("");
        } catch (caught) {
          if (cancelled) return;
          adoptHtmlBlobPreview({ status: "error" });
          console.warn("[artifactEditor] read-only blob load failed", caught);
        }
      };

      void loadBlob();
      return () => {
        cancelled = true;
        controller.abort();
        adoptHtmlBlobPreview({ status: "loading" });
      };
    }

    adoptHtmlBlobPreview({ status: "idle" });

    if (isEditing || !sourcePath || !canUseInAppEditor) {
      return;
    }

    let cancelled = false;
    readEditableArtifact(sourcePath)
      .then((source) => {
        if (cancelled) return;
        setReadOnlySrcDoc(buildReadOnlySrcDoc(source.content, source.sourcePath, source.sourceKind));
      })
      .catch((caught) => {
        if (cancelled) return;
        setReadOnlySrcDoc("");
        console.warn("[artifactEditor] read-only srcdoc load failed", caught);
      });

    return () => {
      cancelled = true;
    };
  }, [
    adoptHtmlBlobPreview,
    canUseInAppEditor,
    isEditing,
    localReloadKey,
    reloadKey,
    resolvedPreviewPath,
    sourceKind,
    sourcePath,
  ]);

  const handleFrameLoad = useCallback(() => {
    inputCleanupRef.current?.();
    inputCleanupRef.current = null;
    let doc: Document | null = null;
    try {
      doc = iframeRef.current?.contentDocument ?? null;
    } catch {
      doc = null;
    }
    if (!doc) return;

    const forwardShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (
        isEditing &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        event.stopPropagation();
        saveCurrentArtifactRef.current();
        return;
      }

      if (
        isEditing &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "b"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (doc.execCommand("bold")) updateDirty(true);
        return;
      }

      if (
        isEditing &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "i"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (doc.execCommand("italic")) updateDirty(true);
        return;
      }

      const actions = getActionsForEvent(event);
      if (actions.length === 0) return;

      if (actions.includes("pane.zoom.toggle")) {
        event.preventDefault();
        event.stopPropagation();
        onZoomToggle?.();
        return;
      }

      const forwarded = new KeyboardEvent("keydown", {
        key: event.key,
        code: event.code,
        location: event.location,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
        bubbles: true,
        cancelable: true,
      });

      const handled = !window.dispatchEvent(forwarded) || forwarded.defaultPrevented;
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    doc.addEventListener("keydown", forwardShortcut, true);

    if (!isEditing) {
      inputCleanupRef.current = () => {
        doc.removeEventListener("keydown", forwardShortcut, true);
      };
      return;
    }

    const markDirty = () => updateDirty(true);
    const rememberSelection = () => {
      const selection = doc?.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (isRangeInsideBody(doc, range)) {
        selectionRangeRef.current = range.cloneRange();
      }
    };
    doc.addEventListener("selectionchange", rememberSelection);
    doc.addEventListener("keyup", rememberSelection);
    doc.addEventListener("mouseup", rememberSelection);
    doc.addEventListener("input", markDirty);
    doc.addEventListener("cut", markDirty);
    doc.addEventListener("paste", markDirty);
    inputCleanupRef.current = () => {
      doc.removeEventListener("keydown", forwardShortcut, true);
      doc.removeEventListener("selectionchange", rememberSelection);
      doc.removeEventListener("keyup", rememberSelection);
      doc.removeEventListener("mouseup", rememberSelection);
      doc.removeEventListener("input", markDirty);
      doc.removeEventListener("cut", markDirty);
      doc.removeEventListener("paste", markDirty);
    };
    doc.body.focus();
  }, [getActionsForEvent, isEditing, onZoomToggle, updateDirty]);

  const getEditableDocument = useCallback((): Document | null => {
    return iframeRef.current?.contentDocument ?? null;
  }, []);

  const handleCommand = useCallback((command: ArtifactEditorCommand, value?: ArtifactEditorCommandValue) => {
    const doc = getEditableDocument();
    if (!doc) return;
    restoreEditorSelection(doc, selectionRangeRef.current);
    let changed = false;

    switch (command) {
      case "bold":
        changed = doc.execCommand("bold");
        break;
      case "italic":
        changed = doc.execCommand("italic");
        break;
      case "alignLeft":
        changed = doc.execCommand("justifyLeft");
        break;
      case "alignCenter":
        changed = doc.execCommand("justifyCenter");
        break;
      case "alignRight":
        changed = doc.execCommand("justifyRight");
        break;
      case "indent":
        changed = doc.execCommand("indent");
        break;
      case "outdent":
        changed = doc.execCommand("outdent");
        break;
      case "fontFamily":
        if (value) {
          changed = doc.execCommand("fontName", false, value);
          normalizeGeneratedFontTags(doc);
        }
        break;
      case "fontSize":
        if (value) {
          changed = doc.execCommand("fontSize", false, htmlFontSizeForPointSize(value));
          normalizeGeneratedFontTags(doc, value);
        }
        break;
      case "heading":
        changed = doc.execCommand("formatBlock", false, "h2");
        break;
      case "bulletList":
        changed = doc.execCommand("insertUnorderedList");
        break;
      case "numberedList":
        changed = doc.execCommand("insertOrderedList");
        break;
      case "link": {
        const href = window.prompt("URL");
        if (href) {
          restoreEditorSelection(doc, selectionRangeRef.current);
          changed = doc.execCommand("createLink", false, href);
        }
        break;
      }
      case "equation": {
        const expression = window.prompt("Equation");
        if (expression?.trim()) {
          restoreEditorSelection(doc, selectionRangeRef.current);
          changed = insertEquation(doc, expression.trim());
        }
        break;
      }
      case "addRow":
      case "addColumn":
      case "deleteRow":
      case "deleteColumn":
        changed = runTableCommand(doc, command);
        break;
    }

    if (changed) updateDirty(true);
  }, [getEditableDocument, updateDirty]);

  const handleSave = useCallback(async () => {
    if (!sourcePath || !sourceKind || !canUseInAppEditor || busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      let content: string;
      if (sourceKind === "markdown") {
        content = markdownDraft;
      } else {
        const doc = getEditableDocument();
        if (!doc) return;
        content = sourceKind === "office"
          ? serializeEditableBodyHtml(doc, sourceKind)
          : serializeEditableHtml(doc);
      }
      const result = await saveEditableArtifact(sourcePath, sourceKind, content);
      preserveEditAfterSaveRef.current = true;
      lastSavedSourcePathRef.current = result.sourcePath;
      updateDirty(false);
      onSavedRef.current(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [busy, canUseInAppEditor, dirty, getEditableDocument, markdownDraft, sourceKind, sourcePath, updateDirty]);

  useEffect(() => {
    saveCurrentArtifactRef.current = () => {
      void handleSave();
    };
  }, [handleSave]);

  const handleCancel = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved edits?")) return;
    inputCleanupRef.current?.();
    inputCleanupRef.current = null;
    setIsEditing(false);
    setMarkdownDraft("");
    setEditableSrcDoc("");
    selectionRangeRef.current = null;
    setError(null);
    updateDirty(false);
  }, [dirty, updateDirty]);

  const handleReload = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved edits and reload?")) return;
    if (isEditing) {
      void startEdit();
      return;
    }
    setLocalReloadKey((value) => value + 1);
  }, [dirty, isEditing, startEdit]);

  const handleRevealSource = useCallback(() => {
    const targetPath = sourcePath ?? resolvedPreviewPath;
    if (!targetPath) return;
    revealInExplorer(targetPath).catch((caught: unknown) => {
      console.warn("[artifactEditor] reveal source location failed", caught);
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [resolvedPreviewPath, sourcePath]);

  const handleOpenSource = useCallback(() => {
    const targetPath = sourcePath ?? resolvedPreviewPath;
    if (!targetPath) return;
    openWithDefault(targetPath).catch((caught: unknown) => {
      console.warn("[artifactEditor] open source failed", caught);
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [resolvedPreviewPath, sourcePath]);

  const iframeSources = resolveBrowserIframeSources({
    isEditing,
    editableSrcDoc,
    htmlBlobPreview,
    readOnlySrcDoc,
    assetSrc: src,
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--cmux-popover, #1e1e1e)",
        overflow: "hidden",
      }}
    >
      <ArtifactEditorToolbar
        canEdit={canEdit}
        isEditing={isEditing}
        isDirty={dirty}
        isBusy={busy}
        isSourceMode={isEditing && sourceKind === "markdown"}
        sourcePath={sourcePath}
        sourceKind={sourceKind}
        onStartEdit={startEdit}
        onSave={handleSave}
        onCancel={handleCancel}
        onReload={handleReload}
        onRevealSource={handleRevealSource}
        onOpenSource={handleOpenSource}
        onCommand={handleCommand}
      />
      {error && (
        <div
          style={{
            flex: "0 0 auto",
            padding: "6px 10px",
            fontSize: 12,
            color: "#fecaca",
            background: "rgba(127, 29, 29, 0.6)",
            borderBottom: "1px solid rgba(248, 113, 113, 0.28)",
          }}
        >
          {error}
        </div>
      )}
      {/* Read-only preview stays no-script; same-origin lets the parent capture shortcuts. */}
      {isEditing && sourceKind === "markdown" ? (
        <textarea
          value={markdownDraft}
          spellCheck
          title={sourcePath ?? htmlPath}
          onChange={(event) => {
            setMarkdownDraft(event.currentTarget.value);
            updateDirty(true);
          }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
              event.preventDefault();
              event.stopPropagation();
              saveCurrentArtifactRef.current();
            }
          }}
          style={{
            flex: 1,
            minHeight: 0,
            width: "100%",
            boxSizing: "border-box",
            border: "none",
            outline: "none",
            resize: "none",
            padding: "18px 22px",
            background: "#0f172a",
            color: "#e5edf7",
            caretColor: "#60a5fa",
            fontFamily: "Consolas, 'Cascadia Mono', 'Yu Gothic UI', monospace",
            fontSize: 14,
            lineHeight: 1.65,
            tabSize: 2,
            whiteSpace: "pre-wrap",
          }}
        />
      ) : (
      <iframe
        ref={iframeRef}
        key={
          isEditing
            ? `${sourcePath ?? htmlPath}#edit#${reloadKey}`
            : `${resolvedPreviewPath}#${reloadKey}#${localReloadKey}`
        }
        src={iframeSources.src}
        srcDoc={iframeSources.srcDoc}
        sandbox={isEditing ? "allow-popups allow-same-origin" : "allow-popups allow-same-origin"}
        title={sourcePath ?? htmlPath}
        onLoad={handleFrameLoad}
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          border: "none",
          display: "block",
          background: "white",
        }}
      />
      )}
    </div>
  );
}

export default memo(BrowserPaneImpl);

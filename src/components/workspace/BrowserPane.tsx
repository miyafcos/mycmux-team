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
import ArtifactEditorToolbar, { type ArtifactEditorCommand } from "./ArtifactEditorToolbar";

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

function buildEditableSrcDoc(content: string, sourcePath: string | undefined): string {
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
  style.textContent = `
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
  `;
  doc.head.appendChild(style);
  doc.body.setAttribute("contenteditable", "true");
  doc.body.setAttribute("spellcheck", "true");
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function buildReadOnlySrcDoc(content: string, sourcePath: string | undefined): string {
  const doc = new DOMParser().parseFromString(content, "text/html");
  removeScripts(doc);

  const href = parentHrefFor(sourcePath);
  if (href && !doc.head.querySelector("base[data-mycmux-editor-base]")) {
    const base = doc.createElement("base");
    base.href = href;
    base.setAttribute("data-mycmux-editor-base", "true");
    doc.head.prepend(base);
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

function serializeEditableBodyHtml(doc: Document): string {
  const clone = doc.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script").forEach((script) => script.remove());
  return clone.innerHTML;
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
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onSavedRef = useRef(onSaved);
  const [isEditing, setIsEditing] = useState(false);
  const [dirty, setDirty] = useState(isDirty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editableSrcDoc, setEditableSrcDoc] = useState<string>("");
  const [readOnlySrcDoc, setReadOnlySrcDoc] = useState<string>("");
  const [localReloadKey, setLocalReloadKey] = useState(0);
  const resolvedPreviewPath = previewPath ?? htmlPath;
  const src = useMemo(() => convertFileSrc(resolvedPreviewPath), [resolvedPreviewPath]);
  const canUseInAppEditor = sourceKind === "html" || sourceKind === "markdown";
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

  useEffect(() => {
    setDirty(isDirty);
  }, [isDirty]);

  useEffect(() => {
    inputCleanupRef.current?.();
    inputCleanupRef.current = null;
    setIsEditing(false);
    setEditableSrcDoc("");
    setReadOnlySrcDoc("");
    setError(null);
    updateDirty(false);
  }, [htmlPath, resolvedPreviewPath, reloadKey, sourceKind, sourcePath, updateDirty]);

  useEffect(() => {
    return () => inputCleanupRef.current?.();
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
    setBusy(true);
    setError(null);
    try {
      const source = await readEditableArtifact(sourcePath);
      setEditableSrcDoc(buildEditableSrcDoc(source.content, source.sourcePath));
      setIsEditing(true);
      updateDirty(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [canUseInAppEditor, sourcePath, updateDirty]);

  useEffect(() => {
    if (isEditing || !sourcePath || !canUseInAppEditor) {
      return;
    }

    let cancelled = false;
    readEditableArtifact(sourcePath)
      .then((source) => {
        if (cancelled) return;
        setReadOnlySrcDoc(buildReadOnlySrcDoc(source.content, source.sourcePath));
      })
      .catch((caught) => {
        if (cancelled) return;
        setReadOnlySrcDoc("");
        console.warn("[artifactEditor] read-only srcdoc load failed", caught);
      });

    return () => {
      cancelled = true;
    };
  }, [canUseInAppEditor, isEditing, localReloadKey, reloadKey, sourcePath]);

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
    doc.addEventListener("input", markDirty);
    doc.addEventListener("cut", markDirty);
    doc.addEventListener("paste", markDirty);
    inputCleanupRef.current = () => {
      doc.removeEventListener("keydown", forwardShortcut, true);
      doc.removeEventListener("input", markDirty);
      doc.removeEventListener("cut", markDirty);
      doc.removeEventListener("paste", markDirty);
    };
    doc.body.focus();
  }, [getActionsForEvent, isEditing, onZoomToggle, updateDirty]);

  const getEditableDocument = useCallback((): Document | null => {
    return iframeRef.current?.contentDocument ?? null;
  }, []);

  const handleCommand = useCallback((command: ArtifactEditorCommand) => {
    const doc = getEditableDocument();
    if (!doc) return;
    doc.body.focus();
    let changed = false;

    switch (command) {
      case "bold":
        changed = doc.execCommand("bold");
        break;
      case "italic":
        changed = doc.execCommand("italic");
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
        if (href) changed = doc.execCommand("createLink", false, href);
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
    if (!sourcePath || !sourceKind || !canUseInAppEditor) return;
    const doc = getEditableDocument();
    if (!doc) return;
    setBusy(true);
    setError(null);
    try {
      const content = sourceKind === "markdown"
        ? serializeEditableBodyHtml(doc)
        : serializeEditableHtml(doc);
      const result = await saveEditableArtifact(sourcePath, sourceKind, content);
      updateDirty(false);
      setIsEditing(false);
      setEditableSrcDoc("");
      onSavedRef.current(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [canUseInAppEditor, getEditableDocument, sourceKind, sourcePath, updateDirty]);

  const handleCancel = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved edits?")) return;
    inputCleanupRef.current?.();
    inputCleanupRef.current = null;
    setIsEditing(false);
    setEditableSrcDoc("");
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
      <iframe
        ref={iframeRef}
        key={
          isEditing
            ? `${sourcePath ?? htmlPath}#edit#${reloadKey}`
            : `${resolvedPreviewPath}#${reloadKey}#${localReloadKey}`
        }
        src={isEditing || readOnlySrcDoc ? undefined : src}
        srcDoc={isEditing ? editableSrcDoc : readOnlySrcDoc || undefined}
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
    </div>
  );
}

export default memo(BrowserPaneImpl);

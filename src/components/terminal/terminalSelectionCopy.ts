import type { Terminal } from "@xterm/xterm";
import {
  focusTerminalSoon,
  isActiveTerminalInputTarget,
  refocusActiveTerminalIfNeeded,
} from "./terminalFocusHelpers";

const terminalSelectionCopyListeners = new WeakMap<Terminal, { dispose: () => void }>();

function fallbackCopyTextToClipboard(text: string, restoreFocus?: () => void): void {
  if (typeof document === "undefined") {
    restoreFocus?.();
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } catch {
    // Clipboard access is best effort; terminal selection must never break input.
  } finally {
    document.body.removeChild(textarea);
    restoreFocus?.();
  }
}

function copyTextToClipboard(text: string, restoreFocus?: () => void): void {
  if (!text) {
    restoreFocus?.();
    return;
  }
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    clipboard
      .writeText(text)
      .then(() => restoreFocus?.())
      .catch(() => fallbackCopyTextToClipboard(text, restoreFocus));
    return;
  }
  fallbackCopyTextToClipboard(text, restoreFocus);
}

export function disposeSelectionCopyListener(currentTerm: Terminal | null | undefined): void {
  if (!currentTerm) return;
  const existing = terminalSelectionCopyListeners.get(currentTerm);
  if (!existing) return;
  existing.dispose();
  terminalSelectionCopyListeners.delete(currentTerm);
}

export function registerSelectionCopyListener(currentTerm: Terminal, sessionId: string): void {
  disposeSelectionCopyListener(currentTerm);

  let selectionDirty = false;
  let copyTimer: number | null = null;
  const selectionDisposable = currentTerm.onSelectionChange(() => {
    selectionDirty = true;
  });

  const copySelectedText = (): void => {
    const restoreSelectionFocus = (): void => {
      if (isActiveTerminalInputTarget(sessionId)) {
        focusTerminalSoon(currentTerm, sessionId);
        return;
      }
      refocusActiveTerminalIfNeeded();
    };
    const selectedText = currentTerm.getSelection();
    if (!selectedText) {
      restoreSelectionFocus();
      return;
    }
    restoreSelectionFocus();
    copyTextToClipboard(selectedText, restoreSelectionFocus);
  };

  const flushSelectionCopy = (event?: Event) => {
    if (event instanceof MouseEvent && event.button !== 0) {
      selectionDirty = false;
      return;
    }
    if (typeof PointerEvent !== "undefined" && event instanceof PointerEvent && event.button !== 0) {
      selectionDirty = false;
      return;
    }
    if (!selectionDirty) return;
    selectionDirty = false;
    if (copyTimer !== null) {
      window.clearTimeout(copyTimer);
    }
    copyTimer = window.setTimeout(() => {
      copyTimer = null;
      copySelectedText();
    }, 0);
  };

  const win = currentTerm.element?.ownerDocument.defaultView ?? window;
  const termElement = currentTerm.element;
  const flushContextMenuSelectionCopy = () => {
    if (copyTimer !== null) {
      window.clearTimeout(copyTimer);
    }
    copyTimer = window.setTimeout(() => {
      copyTimer = null;
      selectionDirty = false;
      copySelectedText();
    }, 0);
  };
  win.addEventListener("pointerup", flushSelectionCopy, true);
  win.addEventListener("mouseup", flushSelectionCopy, true);
  win.addEventListener("touchend", flushSelectionCopy, true);
  termElement?.addEventListener("contextmenu", flushContextMenuSelectionCopy);
  terminalSelectionCopyListeners.set(currentTerm, {
    dispose: () => {
      selectionDisposable.dispose();
      if (copyTimer !== null) {
        window.clearTimeout(copyTimer);
        copyTimer = null;
      }
      win.removeEventListener("pointerup", flushSelectionCopy, true);
      win.removeEventListener("mouseup", flushSelectionCopy, true);
      win.removeEventListener("touchend", flushSelectionCopy, true);
      termElement?.removeEventListener("contextmenu", flushContextMenuSelectionCopy);
    },
  });
}

import type { Terminal } from "@xterm/xterm";
import {
  focusTerminalSoon,
  isActiveTerminalInputTarget,
  refocusActiveTerminalIfNeeded,
} from "./terminalFocusHelpers";
import { useToastStore } from "../../stores/toastStore";

const terminalSelectionCopyListeners = new WeakMap<Terminal, { dispose: () => void }>();
export const MIN_AUTO_COPY_SELECTION_LENGTH = 3;
const SUCCESS_TOAST_REPLACEMENT_WINDOW_MS = 1_200;
let lastSuccessToastId: string | null = null;
let lastSuccessToastAt = 0;

function showCopyResultToast(text: string, succeeded: boolean): void {
  const toastStore = useToastStore.getState();
  if (!succeeded) {
    toastStore.pushToast("コピーに失敗しました", "warning");
    return;
  }
  const now = Date.now();
  const elapsed = now - lastSuccessToastAt;
  if (lastSuccessToastId && elapsed >= 0 && elapsed <= SUCCESS_TOAST_REPLACEMENT_WINDOW_MS) {
    toastStore.dismissToast(lastSuccessToastId);
  }
  lastSuccessToastId = toastStore.pushToast(`コピーしました (${text.length}文字)`, "info");
  lastSuccessToastAt = now;
}

function fallbackCopyTextToClipboard(text: string, restoreFocus?: () => void): boolean {
  if (typeof document === "undefined") {
    restoreFocus?.();
    return false;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // Clipboard access is best effort; terminal selection must never break input.
  } finally {
    document.body.removeChild(textarea);
    restoreFocus?.();
  }
  return copied;
}

function copyTextToClipboard(text: string, restoreFocus?: () => void): void {
  if (text.trim().length < MIN_AUTO_COPY_SELECTION_LENGTH) {
    restoreFocus?.();
    return;
  }
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    void clipboard
      .writeText(text)
      .then(() => restoreFocus?.())
      .catch(() => fallbackCopyTextToClipboard(text, restoreFocus))
      .then((fallbackResult) => {
        if (typeof fallbackResult === "boolean") {
          showCopyResultToast(text, fallbackResult);
        } else {
          showCopyResultToast(text, true);
        }
      });
    return;
  }
  showCopyResultToast(text, fallbackCopyTextToClipboard(text, restoreFocus));
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
  let lastNonEmptySelection = "";
  const selectionDisposable = currentTerm.onSelectionChange(() => {
    selectionDirty = true;
    const selectedText = currentTerm.getSelection();
    if (selectedText) {
      lastNonEmptySelection = selectedText;
    }
  });

  const readSelectionForCopy = (): string => {
    const selectedText = currentTerm.getSelection();
    return selectedText || lastNonEmptySelection;
  };

  const copySelectedText = (): void => {
    const restoreSelectionFocus = (): void => {
      if (isActiveTerminalInputTarget(sessionId)) {
        focusTerminalSoon(currentTerm, sessionId);
        return;
      }
      refocusActiveTerminalIfNeeded();
    };
    const selectedText = readSelectionForCopy();
    if (!selectedText) {
      restoreSelectionFocus();
      return;
    }
    restoreSelectionFocus();
    copyTextToClipboard(selectedText, restoreSelectionFocus);
    lastNonEmptySelection = "";
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
  const resetSelectionSnapshot = () => {
    lastNonEmptySelection = "";
  };
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
  win.addEventListener("pointerdown", resetSelectionSnapshot, true);
  win.addEventListener("mousedown", resetSelectionSnapshot, true);
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
      win.removeEventListener("pointerdown", resetSelectionSnapshot, true);
      win.removeEventListener("mousedown", resetSelectionSnapshot, true);
      win.removeEventListener("pointerup", flushSelectionCopy, true);
      win.removeEventListener("mouseup", flushSelectionCopy, true);
      win.removeEventListener("touchend", flushSelectionCopy, true);
      termElement?.removeEventListener("contextmenu", flushContextMenuSelectionCopy);
    },
  });
}

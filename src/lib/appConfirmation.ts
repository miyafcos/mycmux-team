import { getCurrentWindow } from "@tauri-apps/api/window";

export interface AppConfirmationOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  cancelLabel?: string;
}

type Request = {
  message: string;
  options: AppConfirmationOptions;
  resolve: (accepted: boolean) => void;
};
const queue: Request[] = [];
let dismissActive: ((accepted: boolean) => void) | null = null;

/** Every webview owns its queue. Closing it is always a negative answer. */
export function cancelAppConfirmations(): boolean {
  const pending = queue.splice(0);
  const dismiss = dismissActive;
  dismiss?.(false);
  for (const request of pending) request.resolve(false);
  return dismiss !== null || pending.length > 0;
}

/** A DOM modal never enters the platform dialog's nested message loop. */
export function confirm(message: string, options: AppConfirmationOptions = {}): Promise<boolean> {
  if (typeof document === "undefined" || !document.body) return Promise.resolve(false);
  return new Promise((resolve) => {
    queue.push({ message, options, resolve });
    showNext();
  });
}

function showNext(): void {
  if (dismissActive) return;
  const request = queue.shift();
  if (!request) return;
  const target = document.querySelector<HTMLElement>("[data-cmux-themed-root]") ?? document.body;
  const previousFocus = document.activeElement;
  const backdrop = document.createElement("div");
  backdrop.className = "cmux-overlay-backdrop";
  backdrop.dataset.cmuxOverlayRoot = "true";
  backdrop.dataset.cmuxNativeWebviewOccluder = "true";
  Object.assign(backdrop.style, {
    position: "fixed", inset: "0", display: "flex", alignItems: "center",
    justifyContent: "center", padding: "var(--cmux-overlay-gutter)",
    zIndex: "calc(var(--cmux-overlay-z-top) + 1)",
  });
  const panel = document.createElement("div");
  panel.className = "cmux-overlay-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", request.options.title ?? "mycmux");
  Object.assign(panel.style, {
    width: "var(--cmux-overlay-dialog-width)", maxWidth: "100%",
    maxHeight: "calc(100vh - 32px)", overflow: "auto",
    background: "var(--cmux-popover)", color: "var(--cmux-text)",
    border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-overlay-radius)",
    boxShadow: "var(--cmux-shadow-dialog)", padding: "var(--cmux-space-6)",
    fontSize: "var(--cmux-font-size-md)",
  });
  const title = document.createElement("h2");
  title.textContent = request.options.title ?? "mycmux";
  Object.assign(title.style, { margin: "0 0 12px", fontSize: "inherit" });
  const body = document.createElement("p");
  body.textContent = request.message;
  Object.assign(body.style, { margin: "0 0 20px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" });
  const actions = document.createElement("div");
  Object.assign(actions.style, { display: "flex", justifyContent: "flex-end", gap: "8px" });
  const cancel = document.createElement("button");
  const accept = document.createElement("button");
  for (const button of [cancel, accept]) {
    button.type = "button";
    Object.assign(button.style, {
      border: "1px solid var(--cmux-border)", borderRadius: "5px",
      background: "var(--cmux-hover)", color: "var(--cmux-text)",
      padding: "6px 12px", fontSize: "inherit", cursor: "pointer",
    });
  }
  cancel.textContent = request.options.cancelLabel ?? "キャンセル";
  accept.textContent = request.options.okLabel ?? "OK";
  actions.append(cancel, accept);
  panel.append(title, body, actions);
  backdrop.append(panel);
  const isolated = [...target.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map((element) => ({ element, inert: element.hasAttribute("inert"), hidden: element.getAttribute("aria-hidden") }));
  for (const { element } of isolated) {
    element.setAttribute("inert", "");
    element.setAttribute("aria-hidden", "true");
  }
  target.append(backdrop);
  let settled = false;
  const unlisteners: Array<Promise<() => void>> = [];
  const finish = (accepted: boolean) => {
    if (settled) return;
    settled = true;
    dismissActive = null;
    document.removeEventListener("keydown", keydown, true);
    window.removeEventListener("beforeunload", windowClosed);
    window.removeEventListener("pagehide", windowClosed);
    for (const stop of unlisteners) void stop.then((unlisten) => unlisten()).catch(() => {});
    backdrop.remove();
    for (const { element, inert, hidden } of isolated) {
      if (!inert) element.removeAttribute("inert");
      if (hidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", hidden);
    }
    if (panel.contains(document.activeElement) || document.activeElement === document.body) {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    }
    request.resolve(accepted);
    showNext();
  };
  const windowClosed = () => { cancelAppConfirmations(); };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(false);
    } else if (event.key === "Tab") {
      event.preventDefault();
      event.stopImmediatePropagation();
      (document.activeElement === cancel ? accept : cancel).focus();
    }
  };
  dismissActive = finish;
  cancel.onclick = () => finish(false);
  accept.onclick = () => finish(true);
  backdrop.onmousedown = (event) => {
    if (event.target === backdrop && event.button === 0) finish(false);
  };
  document.addEventListener("keydown", keydown, true);
  window.addEventListener("beforeunload", windowClosed);
  window.addEventListener("pagehide", windowClosed);
  cancel.focus();
  if ("__TAURI_INTERNALS__" in window) {
    try {
      const currentWindow = getCurrentWindow();
      // Raw listen avoids onCloseRequested's per-listener automatic destroy.
      // The persistence owner keeps control of the actual close operation.
      unlisteners.push(currentWindow.listen("tauri://close-requested", () => {
        if (!settled) windowClosed();
      }));
      unlisteners.push(currentWindow.once("tauri://destroyed", () => { if (!settled) windowClosed(); }));
      // Dispatch both at presentation time; a late show reply must not steal focus.
      void currentWindow.show().catch(() => {});
      void currentWindow.setFocus().catch(() => {});
    } catch { /* A missing native API must never approve an action. */ }
  }
}

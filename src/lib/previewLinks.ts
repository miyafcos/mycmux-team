import { invoke } from "@tauri-apps/api/core";
import { classifyPreviewLink, findAnchorElement } from "./markdownPreviewDocument";

/** Frames have no document scripts. Their trusted clicks use the primary app IPC. */
export function openNativePreviewLink(url: string): Promise<unknown> {
  return invoke("webpane_navigate", { tabId: "", action: "preview-link", url });
}

interface PreviewLinkOptions {
  openNative?: (url: string) => Promise<unknown>;
  openLocal?: (path: string) => void;
  revealLocal?: (path: string) => Promise<unknown>;
  allowLocalDocuments?: boolean;
  onError: (error: unknown) => void;
  now?: () => number;
}

export function installPreviewLinkHandler(doc: Document, options: PreviewLinkOptions): () => void {
  let lastAt = -Infinity;
  const now = options.now ?? (() => performance.now());
  const activate = (event: MouseEvent) => {
    if (event.type === "auxclick" ? event.button !== 1 : event.button !== 0) return;
    const anchor = findAnchorElement(event.target);
    if (!anchor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.isTrusted) return;
    const action = classifyPreviewLink(anchor);
    if (action.kind === "fragment") {
      const target = action.id
        ? doc.getElementById(action.id) ?? doc.getElementsByName(action.id)[0] ?? null
        : doc.documentElement;
      target?.scrollIntoView({ block: "start" });
      return;
    }
    const at = now();
    if (at - lastAt < 500) return;
    if (action.kind === "reveal" || action.kind === "external") {
      lastAt = at;
      (options.openNative ?? openNativePreviewLink)(action.url).catch(options.onError);
    } else if (action.kind === "local" && options.allowLocalDocuments) {
      lastAt = at;
      if (options.openLocal) options.openLocal(action.path);
      else options.revealLocal?.(action.path).catch(options.onError);
    }
  };
  doc.addEventListener("click", activate, true);
  doc.addEventListener("auxclick", activate, true);
  return () => {
    doc.removeEventListener("click", activate, true);
    doc.removeEventListener("auxclick", activate, true);
  };
}

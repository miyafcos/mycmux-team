// The preview document as the frame receives it, and what a click in it means.
//
// The renderer (src-tauri/src/commands/artifact/markdown_preview.rs) hands over
// a whole HTML document that is already sanitised. Two things it cannot do are
// done here: local images need an asset URL that only the webview can mint, and
// the theme's colours only exist on this side.
//
// The frame has no scripts (the sandbox withholds allow-scripts), so links are
// handled by the pane: it reads the classification below and decides whether a
// click scrolls, opens a file in mycmux, or leaves for the browser.

import type { MarkdownPreviewPalette } from "./markdownPreviewTheme";

export interface MarkdownPreviewAppearance {
  palette: MarkdownPreviewPalette;
  /** The reader's terminal font for code, or null to keep the document's own. */
  monoFont: string | null;
}

/** Idempotent: the pane calls this again whenever the theme changes, on a live frame. */
export function applyMarkdownPreviewAppearance(
  doc: Document,
  appearance: MarkdownPreviewAppearance,
): void {
  const root = doc.documentElement;
  if (!root) return;
  root.setAttribute("data-scheme", appearance.palette.scheme);
  for (const [name, value] of Object.entries(appearance.palette.vars)) {
    root.style.setProperty(name, value);
  }
  if (appearance.monoFont) {
    root.style.setProperty("--md-font-mono", appearance.monoFont);
  } else {
    root.style.removeProperty("--md-font-mono");
  }
}

export function buildMarkdownPreviewSrcDoc(
  content: string,
  appearance: MarkdownPreviewAppearance,
  toAssetUrl: (path: string) => string,
): string {
  const doc = new DOMParser().parseFromString(content, "text/html");
  // The renderer never emits one; this is the belt to its braces.
  doc.querySelectorAll("script").forEach((script) => script.remove());
  doc.querySelectorAll("img[data-mycmux-local-src]").forEach((image) => {
    const path = image.getAttribute("data-mycmux-local-src");
    if (!path) return;
    image.setAttribute("src", toAssetUrl(path));
  });
  // No <base> element on purpose (the read-only HTML preview adds one): with a
  // base, a `#heading` link resolves against another URL and leaves the page
  // instead of scrolling it.
  applyMarkdownPreviewAppearance(doc, appearance);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

export type PreviewLinkAction =
  | { kind: "fragment"; id: string }
  | { kind: "local"; path: string }
  | { kind: "external"; url: string }
  | { kind: "none" };

/**
 * The `<a>` a click landed in, or null.
 *
 * The nodes come from the frame's document, which is a different realm: an
 * `instanceof` check against this window's Element would be false for every one
 * of them, so the shape is what decides.
 */
export function findAnchorElement(target: EventTarget | null): Element | null {
  const node = target as Node | null;
  if (!node) return null;
  const element = node.nodeType === Node.TEXT_NODE
    ? (node as Text).parentElement
    : (node as Element);
  if (!element || typeof element.closest !== "function") return null;
  return element.closest("a");
}

export function classifyPreviewLink(anchor: Element): PreviewLinkAction {
  // The renderer resolves a local target and records the absolute path; the
  // href it leaves in place is the document's own spelling of it.
  const path = anchor.getAttribute("data-mycmux-local-path") ?? "";
  if (path) return { kind: "local", path };

  const href = (anchor.getAttribute("href") ?? "").trim();
  if (href.startsWith("#")) {
    const raw = href.slice(1);
    let id = raw;
    try {
      id = decodeURIComponent(raw);
    } catch {
      // A half-written escape is a literal id, not an error worth showing.
    }
    return { kind: "fragment", id };
  }
  if (/^(?:https?|mailto):/i.test(href)) return { kind: "external", url: href };
  return { kind: "none" };
}

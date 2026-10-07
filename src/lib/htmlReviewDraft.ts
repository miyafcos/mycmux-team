import { reviewScript } from "./htmlReviewScripts";
import type { WebPaneBounds, WebPaneNode, WebPaneScreenshotResult } from "../components/workspace/webPaneApi";

/** A draft tied to the rendered document; it is not a work order or a human receipt. */
export interface ReviewPageRevision {
  url: string;
  documentId: string;
  generation: number;
  mutationRevision: number;
  view?: { scrollX: number; scrollY: number; dpr: number; cssZoom: number; width: number; height: number };
}
export interface ReviewAnchor { text: string; before: string; after: string; heading: string }
export interface ReviewTarget extends WebPaneNode { anchor?: ReviewAnchor; frame?: ReviewFrame }
export interface ReviewFrame extends ReviewPageRevision {
  anchor?: ReviewAnchor;
  mode?: "text" | "selection" | "element";
  ref: string;
  fingerprint: string;
  selector: string;
  rect: WebPaneBounds;
  rects?: WebPaneBounds[];
  scrollX: number;
  scrollY: number;
  dpr: number;
  cssZoom: number;
  viewport: { width: number; height: number };
}
export interface HtmlReviewCapture {
  id: string;
  sourcePath: string;
  tabId: string;
  capturedAt: string;
  node: Pick<WebPaneNode, "ref" | "tag" | "role" | "name">;
  frame: ReviewFrame;
  coordinateSpace: "document-css";
  clip: WebPaneBounds;
  screenshot: WebPaneScreenshotResult;
}

export const htmlReviewStrings = {
  title: "\u6307\u6458\u306e\u4e0b\u66f8\u304d",
  open: "\u6307\u6458\u3092\u4f5c\u308b",
  close: "\u6307\u6458\u306e\u4e0b\u66f8\u304d\u3092\u9589\u3058\u308b",
  query: "\u9078\u3076\u7b87\u6240\u306e\u6587\u5b57",
  selection: "\u9078\u3093\u3060\u7bc4\u56f2\u3067\u6307\u6458",
  noSelection: "\u30d7\u30ec\u30d3\u30e5\u30fc\u306e\u6587\u5b57\u3092\u30c9\u30e9\u30c3\u30b0\u3057\u3066\u7bc4\u56f2\u3092\u9078\u3093\u3067\u304b\u3089\u62bc\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
  pick: "\u753b\u9762\u3067\u9078\u3076",
  picking: "\u30d7\u30ec\u30d3\u30e5\u30fc\u306b\u30dd\u30a4\u30f3\u30bf\u30fc\u3092\u4e57\u305b\u3001\u6307\u6458\u3059\u308b\u7b87\u6240\u3092\u30af\u30ea\u30c3\u30af\u3057\u3066\u304f\u3060\u3055\u3044\u3002Esc\u3067\u53d6\u308a\u6d88\u305b\u307e\u3059\u3002",
  cancelPick: "\u9078\u629e\u3092\u53d6\u308a\u6d88\u3059",
  pickCancelled: "\u753b\u9762\u3067\u306e\u9078\u629e\u3092\u53d6\u308a\u6d88\u3057\u307e\u3057\u305f\u3002",
  search: "\u6587\u5b57\u3067\u63a2\u3059",
  comment: "\u4fee\u6b63\u3057\u3066\u307b\u3057\u3044\u3053\u3068",
  copy: "\u753b\u50cf\u306e\u4fdd\u5b58\u5148\u3092\u542b\u3081\u3066\u4f9d\u983c\u6587\u3092\u30b3\u30d4\u30fc",
  hint: "\u6587\u5b57\u30fb\u7bc4\u56f2\u30fb\u753b\u9762\u304b\u3089\u9078\u3076 \u2192 \u30b3\u30e1\u30f3\u30c8 \u2192 \u4f9d\u983c\u6587\u3092\u30b3\u30d4\u30fc",
  pending: "\u62c5\u5f53AI\u3078\u306e\u9001\u4fe1\u3068\u3001\u4fee\u6b63\u5f8c\u306eOK\u7ba1\u7406\u306f\u6b21\u306e\u6bb5\u968e\u3067\u3059\u3002",
  searching: "\u7b87\u6240\u3092\u63a2\u3057\u3066\u3044\u307e\u3059\u2026",
  capturing: "\u9078\u3093\u3060\u7b87\u6240\u306e\u753b\u50cf\u3092\u53d6\u5f97\u3057\u3066\u3044\u307e\u3059\u2026",
  copied: "\u4f9d\u983c\u6587\u3092\u30b3\u30d4\u30fc\u3057\u307e\u3057\u305f\u3002\u62c5\u5f53AI\u3078\u8cbc\u308a\u4ed8\u3051\u3066\u304f\u3060\u3055\u3044\u3002",
  empty: "\u8a72\u5f53\u3059\u308b\u6587\u5b57\u304c\u3042\u308a\u307e\u305b\u3093\u3002\u30d7\u30ec\u30d3\u30e5\u30fc\u3067\u7bc4\u56f2\u3092\u9078\u3076\u304b\u3001\u300c\u753b\u9762\u3067\u9078\u3076\u300d\u3092\u4f7f\u3063\u3066\u304f\u3060\u3055\u3044\u3002",
  stale: "\u753b\u9762\u307e\u305f\u306f\u9078\u3093\u3060\u7b87\u6240\u304c\u5909\u308f\u308a\u307e\u3057\u305f\u3002\u7b87\u6240\u3092\u63a2\u3057\u76f4\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
  outside: "\u7b87\u6240\u304c\u753b\u9762\u5916\u3067\u3059\u3002\u30da\u30fc\u30b8\u3092\u30b9\u30af\u30ed\u30fc\u30eb\u3057\u3066\u304b\u3089\u9078\u3093\u3067\u304f\u3060\u3055\u3044\u3002",
  failed: "\u753b\u50cf\u307e\u305f\u306f\u4f9d\u983c\u6587\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u3082\u3046\u4e00\u5ea6\u7b87\u6240\u3092\u63a2\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
  clipboard: "\u30b3\u30d4\u30fc\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u3082\u3046\u4e00\u5ea6\u30b3\u30d4\u30fc\u3092\u62bc\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
};

export function supportsHtmlReviewDraft(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  // Document clips have been measured on Windows. Mac's native contract needs its own acceptance.
  return /^Win/i.test(platform);
}
export function sameReviewPage(a: ReviewPageRevision, b: ReviewPageRevision): boolean {
  return a.url === b.url && a.documentId === b.documentId && a.generation === b.generation
    && a.mutationRevision === b.mutationRevision && JSON.stringify(a.view) === JSON.stringify(b.view);
}
export function sameReviewFrame(a: ReviewFrame, b: ReviewFrame): boolean {
  return sameReviewPage(a, b) && a.ref === b.ref && a.fingerprint === b.fingerprint
    && a.selector === b.selector && a.mode === b.mode && JSON.stringify(a.anchor) === JSON.stringify(b.anchor)
    && a.scrollX === b.scrollX && a.scrollY === b.scrollY
    && a.dpr === b.dpr && a.cssZoom === b.cssZoom
    && JSON.stringify(a.rects) === JSON.stringify(b.rects)
    && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height
    && (Object.keys(a.rect) as (keyof WebPaneBounds)[]).every((key) => Math.abs(a.rect[key] - b.rect[key]) < 0.01);
}

export function reviewDocumentClip(frame: ReviewFrame): WebPaneBounds {
  const { rect, viewport, scrollX, scrollY, dpr, cssZoom } = frame;
  if (![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height, scrollX, scrollY, dpr, cssZoom]
    .every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || viewport.width <= 0
    || viewport.height <= 0 || dpr <= 0 || cssZoom <= 0 || scrollX < 0 || scrollY < 0) {
    throw new Error(htmlReviewStrings.stale);
  }
  if (frame.rects) {
    const visible = frame.rects.map(part => {
      if (![part.x, part.y, part.width, part.height].every(Number.isFinite) || part.width <= 0 || part.height <= 0) {
        throw new Error(htmlReviewStrings.stale);
      }
      return { x: Math.max(0, part.x), y: Math.max(0, part.y),
        right: Math.min(viewport.width, part.x + part.width), bottom: Math.min(viewport.height, part.y + part.height) };
    }).filter(part => part.right > part.x && part.bottom > part.y);
    if (!visible.length) throw new Error(htmlReviewStrings.outside);
    const x = Math.min(...visible.map(part => part.x)), y = Math.min(...visible.map(part => part.y));
    return { x: x + scrollX, y: y + scrollY, width: Math.max(...visible.map(part => part.right)) - x,
      height: Math.max(...visible.map(part => part.bottom)) - y };
  }
  const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width), bottom = Math.min(viewport.height, rect.y + rect.height);
  if (right <= left || bottom <= top) throw new Error(htmlReviewStrings.outside);
  // getBoundingClientRect already includes CSS zoom; CDP expects document CSS units, not device pixels.
  return { x: left + scrollX, y: top + scrollY, width: right - left, height: bottom - top };
}

/** Read a review-owned ref without changing shared automation refs. */
export function reviewReadScript(expectedUrl: string, ref?: string): string {
  return reviewScript(expectedUrl, { kind: "read", ref });
}

export function buildHtmlReviewRequest(capture: HtmlReviewCapture, comment: string): string {
  if (!comment.trim() || [...comment].length > 2000) throw new Error(htmlReviewStrings.failed);
  return [
    "HTML\u306e\u4fee\u6b63\u4f9d\u983c\uff08\u4e0b\u66f8\u304d\uff09",
    `\u5bfe\u8c61\u30d5\u30a1\u30a4\u30eb: ${capture.sourcePath}`,
    `\u6307\u6458ID: ${capture.id}`,
    `\u9078\u3093\u3060\u7b87\u6240: ${capture.node.tag} / ${capture.node.name}`,
    `\u7b87\u6240\u306e\u6587\u5b57: ${capture.frame.anchor?.text ?? capture.node.name}`,
    `\u524d\u306e30\u5b57: ${capture.frame.anchor?.before ?? ""}`,
    `\u5f8c\u306e30\u5b57: ${capture.frame.anchor?.after ?? ""}`,
    `\u76f4\u524d\u306e\u898b\u51fa\u3057: ${capture.frame.anchor?.heading ?? ""}`,
    `\u7b87\u6240\u306e\u76ee\u5b89: ${capture.frame.selector}`,
    "", "\u4fee\u6b63\u3057\u3066\u307b\u3057\u3044\u3053\u3068:", comment.trim(), "",
    `\u53c2\u8003\u753b\u50cf: ${capture.screenshot.path}`,
    `\u753b\u50cf\u53d6\u5f97\u6642\u523b: ${capture.capturedAt}`,
    `\u5207\u308a\u51fa\u3057\u7bc4\u56f2 (document CSS): ${JSON.stringify(capture.clip)}`,
    "", "\u753b\u50cf\u3068\u6587\u306f\u8868\u793a\u4e2d\u306e\u753b\u9762\u304b\u3089\u53d6\u5f97\u3057\u305f\u3082\u306e\u3067\u3059\u3002\u4fee\u6b63\u524d\u306b\u5bfe\u8c61\u30d5\u30a1\u30a4\u30eb\u306e\u73fe\u5728\u306e\u5185\u5bb9\u3068\u7b87\u6240\u3092\u7167\u5408\u3057\u3001\u4fee\u6b63\u5f8c\u306e\u78ba\u8a8d\u7528\u753b\u50cf\u3092\u8fd4\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
  ].join("\n");
}

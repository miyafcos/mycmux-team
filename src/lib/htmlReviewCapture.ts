import { evalWebPane, findWebPane, screenshotWebPane, type WebPaneNode } from "../components/workspace/webPaneApi";
import {
  htmlReviewStrings, reviewDocumentClip, reviewReadScript, sameReviewFrame, sameReviewPage,
  type HtmlReviewCapture, type ReviewFrame, type ReviewPageRevision,
} from "./htmlReviewDraft";

function validatePage(page: ReviewPageRevision): ReviewPageRevision {
  if (!page || typeof page.url !== "string" || !page.url || typeof page.documentId !== "string"
    || !page.documentId || !Number.isSafeInteger(page.generation) || page.generation < 0
    || !Number.isSafeInteger(page.mutationRevision) || page.mutationRevision < 0) throw new Error(htmlReviewStrings.stale);
  return page;
}
async function readPage(tabId: string, url: string): Promise<ReviewPageRevision> {
  const result = await evalWebPane<ReviewPageRevision>(tabId, reviewReadScript(url));
  if (result.tabId !== tabId) throw new Error(htmlReviewStrings.stale);
  return validatePage(result.value);
}
async function readFrame(tabId: string, url: string, ref: string): Promise<ReviewFrame> {
  const result = await evalWebPane<ReviewFrame>(tabId, reviewReadScript(url, ref));
  if (result.tabId !== tabId) throw new Error(htmlReviewStrings.stale);
  const frame = result.value;
  validatePage(frame);
  if (frame.ref !== ref || typeof frame.fingerprint !== "string" || typeof frame.selector !== "string"
    || !frame.rect || !frame.viewport) throw new Error(htmlReviewStrings.stale);
  reviewDocumentClip(frame);
  return frame;
}
export async function searchHtmlReviewTargets(tabId: string, url: string, text: string) {
  const page = await readPage(tabId, url);
  const found = await findWebPane(tabId, { text: text.trim(), limit: 30 });
  if (found.tabId !== tabId || !Array.isArray(found.nodes) || !sameReviewPage(page, await readPage(tabId, url))) {
    throw new Error(htmlReviewStrings.stale);
  }
  return { page, nodes: found.nodes };
}
export async function captureHtmlReviewTarget(
  tabId: string, url: string, sourcePath: string, page: ReviewPageRevision, node: WebPaneNode,
): Promise<HtmlReviewCapture> {
  const before = await readFrame(tabId, url, node.ref);
  if (!sameReviewPage(page, before)) throw new Error(htmlReviewStrings.stale);
  const clip = reviewDocumentClip(before);
  const screenshot = await screenshotWebPane(tabId, { clip });
  if (screenshot.tabId !== tabId || typeof screenshot.path !== "string" || !/^(?:[a-z]:[\\/]|\\\\)/i.test(screenshot.path)
    || !Number.isFinite(screenshot.width) || screenshot.width <= 0 || !Number.isFinite(screenshot.height)
    || screenshot.height <= 0 || !sameReviewFrame(before, await readFrame(tabId, url, node.ref))) {
    throw new Error(htmlReviewStrings.stale);
  }
  return {
    id: crypto.randomUUID(), sourcePath, tabId, capturedAt: new Date().toISOString(),
    node: { ref: node.ref, tag: node.tag, role: node.role, name: node.name.slice(0, 200) },
    frame: before, coordinateSpace: "document-css", clip, screenshot,
  };
}
export async function validateHtmlReviewCapture(capture: HtmlReviewCapture, url: string): Promise<void> {
  if (!sameReviewFrame(capture.frame, await readFrame(capture.tabId, url, capture.node.ref))) {
    throw new Error(htmlReviewStrings.stale);
  }
}

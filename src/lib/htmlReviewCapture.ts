import { reviewScript } from "./htmlReviewScripts";
import { evalWebPane, screenshotWebPane } from "../components/workspace/webPaneApi";
import {
  htmlReviewStrings, reviewDocumentClip, reviewReadScript, sameReviewFrame, sameReviewPage,
  type HtmlReviewCapture, type ReviewFrame, type ReviewPageRevision, type ReviewTarget,
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
  const found = await evalWebPane<{ page: ReviewPageRevision; nodes: ReviewTarget[] }>(tabId, reviewScript(url, { kind: "search", text }));
  if (found.tabId !== tabId || !found.value || !Array.isArray(found.value.nodes)) throw new Error(htmlReviewStrings.stale);
  const { page, nodes } = found.value;
  validatePage(page);
  if (!sameReviewPage(page, await readPage(tabId, url))) throw new Error(htmlReviewStrings.stale);
  return { page, nodes };
}
export async function captureHtmlReviewTarget(
  tabId: string, url: string, sourcePath: string, page: ReviewPageRevision, node: ReviewTarget,
): Promise<HtmlReviewCapture> {
  const before = await readFrame(tabId, url, node.ref);
  if (!sameReviewPage(page, before) || (node.frame && !sameReviewFrame(node.frame, before))) throw new Error(htmlReviewStrings.stale);
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

/** Snapshot a cloned DOM range; later changes to the user's selection do not retarget it. */
export async function readHtmlReviewSelection(tabId: string, url: string) {
  const result = await evalWebPane<{ page: ReviewPageRevision; node: ReviewTarget | null }>(tabId, reviewScript(url, { kind: "selection" }));
  if (result.tabId !== tabId || !result.value) throw new Error(htmlReviewStrings.stale);
  validatePage(result.value.page);
  if (result.value.node && !sameReviewPage(result.value.page, await readPage(tabId, url))) throw new Error(htmlReviewStrings.stale);
  return result.value;
}

/** Token-scoped cleanup also works after a URL change. It never reads page metadata. */
export async function cancelHtmlReviewPicker(tabId: string, token: string): Promise<void> {
  await evalWebPane(tabId, reviewScript("", { kind: "picker-stop", token }));
}
export async function chooseHtmlReviewElement(
  tabId: string, url: string, token: string, current: () => boolean,
): Promise<{ page: ReviewPageRevision; node: ReviewTarget } | null> {
  try {
    const started = await evalWebPane(tabId, reviewScript(url, { kind: "picker-start", token }));
    if (started.tabId !== tabId) throw new Error(htmlReviewStrings.stale);
    while (current()) {
      const result = await evalWebPane<{ phase: string; page?: ReviewPageRevision; node?: ReviewTarget }>(
        tabId, reviewScript(url, { kind: "picker-poll", token }),
      );
      if (!current()) return null;
      if (result.tabId !== tabId || !result.value) throw new Error(htmlReviewStrings.stale);
      const { phase, page, node } = result.value;
      if (phase === "cancelled") return null;
      if (phase === "selected") {
        if (!page || !node?.frame || !sameReviewPage(validatePage(page), await readPage(tabId, url))) {
          throw new Error(htmlReviewStrings.stale);
        }
        return { page, node };
      }
      if (phase !== "pending") throw new Error(htmlReviewStrings.stale);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return null;
  } finally { await cancelHtmlReviewPicker(tabId, token).catch(() => undefined); }
}

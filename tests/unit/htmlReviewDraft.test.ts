// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHtmlReviewRequest, reviewDocumentClip, reviewReadScript, sameReviewFrame, sameReviewPage,
  supportsHtmlReviewDraft, type HtmlReviewCapture, type ReviewFrame, type ReviewPageRevision,
} from "../../src/lib/htmlReviewDraft";

const frame: ReviewFrame = {
  url: "http://localhost:3000/fixture", documentId: "document-1", generation: 42, mutationRevision: 0,
  ref: "r1", fingerprint: "button-1", selector: "html > body:nth-of-type(1) > button:nth-of-type(1)",
  rect: { x: 20, y: 40, width: 150, height: 30 }, scrollX: 10, scrollY: 1040,
  dpr: 1.5, cssZoom: 1.25, viewport: { width: 800, height: 600 },
};
const draft: HtmlReviewCapture = {
  id: "review-1", sourcePath: "C:\\reports\\sample.html", tabId: "preview", capturedAt: "2026-10-05T12:00:00Z",
  node: { ref: "r1", tag: "button", role: "button", name: "Pay" }, frame,
  coordinateSpace: "document-css", clip: { x: 30, y: 1080, width: 150, height: 30 },
  screenshot: { tabId: "preview", path: "C:\\reports\\shot.png", width: 150, height: 30, dpr: 1.5 },
};

describe("HTML review draft coordinates and status", () => {
  it.each([1040, 1136])("adds CSS scroll %s without multiplying DPR or zoom", (scrollY) => {
    expect(reviewDocumentClip({ ...frame, scrollY })).toEqual({ x: 30, y: scrollY + 40, width: 150, height: 30 });
  });
  it("captures only the visible part, including a partially clipped element", () => {
    expect(reviewDocumentClip({ ...frame, rect: { x: -10, y: 590, width: 50, height: 30 } }))
      .toEqual({ x: 10, y: 1630, width: 40, height: 10 });
  });
  it.each([
    { rect: { ...frame.rect, y: 601 } }, { dpr: 0 }, { cssZoom: Infinity }, { scrollY: -1 },
    { viewport: { width: 0, height: 600 } }, { rect: { ...frame.rect, width: NaN } },
  ])("refuses unusable capture geometry %o", (change) => {
    expect(() => reviewDocumentClip({ ...frame, ...change })).toThrow();
  });
  it.each(["documentId", "generation", "mutationRevision", "url"] as const)("invalidates a changed %s", (key) => {
    const changed = { ...frame, [key]: typeof frame[key] === "number" ? Number(frame[key]) + 1 : "other" };
    expect(sameReviewPage(frame, changed)).toBe(false);
    expect(sameReviewFrame(frame, changed)).toBe(false);
  });
  it("invalidates a resized or scrolled view and changed target fingerprint", () => {
    for (const change of [{ scrollY: 1136 }, { dpr: 2 }, { cssZoom: 1 }, { fingerprint: "changed" },
      { viewport: { width: 390, height: 600 } }, { rect: { ...frame.rect, x: 21 } }]) {
      expect(sameReviewFrame(frame, { ...frame, ...change })).toBe(false);
    }
  });
  it("keeps the same finding and source/image in a request, without claiming delivery", () => {
    const text = buildHtmlReviewRequest(draft, "  Make the button larger  ");
    for (const value of [draft.id, draft.sourcePath, draft.screenshot.path, draft.frame.selector, "Make the button larger"]) {
      expect(text).toContain(value);
    }
    expect(text).not.toMatch(/delivered|humanaccepted|workOrderId|verified/);
    expect(() => buildHtmlReviewRequest(draft, " ")).toThrow();
    expect(() => buildHtmlReviewRequest(draft, "x".repeat(2001))).toThrow();
  });
  it("limits native review clips to the measured Windows platform", () => {
    expect(supportsHtmlReviewDraft("Win32")).toBe(true);
    expect(supportsHtmlReviewDraft("MacIntel")).toBe(false);
    expect(supportsHtmlReviewDraft("Linux x86_64")).toBe(false);
  });
});

describe("the script against a real DOM", () => {
  let el: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<button id="pay">Pay</button><input id="password" type="password" value="never-serialize-this">';
    el = document.getElementById("pay")!;
    el.getBoundingClientRect = () => ({ x: 20, y: 40, width: 150, height: 30 }) as DOMRect;
    Object.defineProperty(window, "__mycmux", { value: { generation: 42, refs: new Map([["r1", el]]) }, configurable: true });
    // Use one new document state per test; the production property stays immutable for that document.
    const script = reviewReadScript(location.href).replaceAll("__mycmuxReviewDraftV1", "__testReview" + Math.random().toString().slice(2));
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    (globalThis as unknown as { runReview: (ref?: string) => ReviewPageRevision | ReviewFrame }).runReview =
      (ref) => new Function(ref ? script.replace("const ref = null;", 'const ref = "' + ref + '";') : script)();
  });
  const read = (ref?: string) => (globalThis as unknown as { runReview: (ref?: string) => ReviewFrame }).runReview(ref);

  it("describes exactly the selected node, not input values or the whole document", () => {
    const selected = read("r1");
    expect(document.querySelector(selected.selector)).toBe(el);
    expect(selected.fingerprint).toContain("Pay");
    expect(JSON.stringify(selected)).not.toContain("never-serialize-this");
    expect(JSON.stringify(selected).length).toBeLessThan(2000);
  });
  it("detects DOM insertion before observer delivery, while refs alone do not change revision", () => {
    const before = read();
    el.setAttribute("data-mycmux-ref", "r1");
    expect(sameReviewPage(before, read())).toBe(true);
    document.body.prepend(document.createElement("button"));
    expect(sameReviewPage(before, read())).toBe(false);
    expect(document.querySelector(read("r1").selector)).toBe(el);
  });
  it("refuses disconnected or replaced refs rather than retargeting a selector", () => {
    el.remove();
    expect(() => read("r1")).toThrow("review-stale");
    expect(() => read("other")).toThrow("review-stale");
  });
  it("rejects a different document URL before returning any metadata", () => {
    expect(() => new Function(reviewReadScript("https://other.example/"))()).toThrow("review-stale");
  });
});

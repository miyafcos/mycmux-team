// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHtmlReviewRequest, reviewReadScript, sameReviewFrame, type ReviewFrame } from "../../src/lib/htmlReviewDraft";
const mocks = vi.hoisted(() => ({ evalWebPane: vi.fn(), screenshotWebPane: vi.fn() }));
vi.mock("../../src/components/workspace/webPaneApi", () => mocks);
import { captureHtmlReviewTarget, readHtmlReviewSelection, validateHtmlReviewCapture } from "../../src/lib/htmlReviewCapture";
let key: string, rects: DOMRect[], rectDescriptor: PropertyDescriptor | undefined;
const run = <T,>(script: string): T => new Function(script.replaceAll("__mycmuxReviewDraftV1", key))();
function select(start: number, end: number) {
  const range = document.createRange(); range.setStart(document.querySelector("p")!.firstChild!, start);
  range.setEnd(document.querySelector("p")!.firstChild!, end);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
}
beforeEach(() => {
  vi.clearAllMocks();
  key = "__rvSelection" + Math.random().toString().slice(2);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("scrollX", 10); vi.stubGlobal("scrollY", 1040);
  vi.stubGlobal("devicePixelRatio", 1.5); vi.stubGlobal("innerWidth", 800); vi.stubGlobal("innerHeight", 600);
  Object.defineProperty(window, "__mycmux", { value: { generation: 10, refs: new Map() }, configurable: true });
  document.body.innerHTML = "<h2>\u8aac\u660e</h2><p>" + "\u524d".repeat(40) + "\u9078\u629e\u672c\u6587" + "\u5f8c".repeat(40) + "</p>";
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 40, width: 180, height: 70 } as DOMRect);
  rects = [{ x: 20, y: 40, width: 100, height: 20 }, { x: 20, y: 70, width: 140, height: 20 }] as DOMRect[];
  rectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  Object.defineProperty(Range.prototype, "getClientRects", { value: () => rects, configurable: true });
  mocks.evalWebPane.mockImplementation(async (tabId: string, script: string) => ({ tabId, value: run(script) }));
  mocks.screenshotWebPane.mockResolvedValue({ tabId: "preview", path: "C:/review/selection.png", width: 140, height: 50, dpr: 1.5 });
});
afterEach(() => {
  (window as unknown as Record<string, { observer: MutationObserver }>)[key]?.observer.disconnect();
  window.getSelection()!.removeAllRanges();
  if (rectDescriptor) Object.defineProperty(Range.prototype, "getClientRects", rectDescriptor);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe("RV-T3 selection", () => {
  it("captures the client-rect union and puts exact text, 30 characters, heading, selector and paths in the request", async () => {
    select(40, 44);
    const selected = await readHtmlReviewSelection("preview", location.href);
    expect(selected.node!.anchor).toEqual({ text: "\u9078\u629e\u672c\u6587", before: "\u524d".repeat(30), after: "\u5f8c".repeat(30), heading: "\u8aac\u660e" });
    const capture = await captureHtmlReviewTarget("preview", location.href, "C:/fixture.html", selected.page, selected.node!);
    expect(capture.clip).toEqual({ x: 30, y: 1080, width: 140, height: 50 });
    const request = buildHtmlReviewRequest(capture, "Fix this range");
    for (const text of ["\u9078\u629e\u672c\u6587", "\u524d".repeat(30), "\u5f8c".repeat(30), "\u8aac\u660e", capture.frame.selector, "C:/fixture.html", "C:/review/selection.png"]) expect(request).toContain(text);
    await expect(validateHtmlReviewCapture(capture, location.href)).resolves.toBeUndefined();
  });
  it("keeps the preceding heading for ranges across paragraphs and element-boundary starts", async () => {
    document.body.innerHTML = "<h2>Section heading</h2><p>Before chosen first</p><p>chosen last after</p>";
    const first = document.querySelectorAll("p")[0].firstChild!, last = document.querySelectorAll("p")[1].firstChild!;
    for (const startsAtElement of [false, true]) {
      const range = document.createRange();
      if (startsAtElement) range.setStart(document.body, 1);
      else range.setStart(first, 7);
      range.setEnd(last, 11);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
      const selected = await readHtmlReviewSelection("preview", location.href);
      expect(selected.node!.anchor!.text).toBe(range.toString());
      expect(selected.node!.anchor!.heading).toBe("Section heading");
      expect(selected.node!.tag).toBe("body");
    }
  });
  it("clips individual line boxes before union and excludes completely off-screen boxes", async () => {
    rects = [{ x: -10, y: -20, width: 50, height: 35 }, { x: 60, y: 590, width: 80, height: 40 },
      { x: 0, y: 630, width: 10, height: 10 }] as DOMRect[];
    select(40, 44);
    const selected = await readHtmlReviewSelection("preview", location.href);
    const capture = await captureHtmlReviewTarget("preview", location.href, "C:/fixture.html", selected.page, selected.node!);
    expect(capture.clip).toEqual({ x: 10, y: 1040, width: 140, height: 600 });
  });
  it("reports no selection or a collapsed selection without taking a screenshot", async () => {
    window.getSelection()!.removeAllRanges();
    expect((await readHtmlReviewSelection("preview", location.href)).node).toBeNull();
    select(40, 40);
    expect((await readHtmlReviewSelection("preview", location.href)).node).toBeNull();
    expect(mocks.screenshotWebPane).not.toHaveBeenCalled();
  });
  it("keeps a cloned range when the user selects something else", async () => {
    select(40, 44);
    const selected = await readHtmlReviewSelection("preview", location.href);
    select(0, 5);
    const frame = run<ReviewFrame>(reviewReadScript(location.href, selected.node!.ref));
    expect(frame.anchor?.text).toBe("\u9078\u629e\u672c\u6587");
    expect(sameReviewFrame(selected.node!.frame!, frame)).toBe(true);
  });
  it("refuses a fully off-screen range instead of capturing another area", async () => {
    rects = [{ x: 10, y: 610, width: 80, height: 20 }] as DOMRect[];
    select(40, 44);
    await expect(readHtmlReviewSelection("preview", location.href)).rejects.toThrow("review-outside");
    expect(mocks.screenshotWebPane).not.toHaveBeenCalled();
  });
  it("refuses selected form/default/editable text without exporting it", async () => {
    document.body.innerHTML = '<textarea>private-default</textarea><div contenteditable="true">private-edited</div>';
    for (const selector of ["textarea", "[contenteditable]"]) {
      const range = document.createRange(); range.selectNodeContents(document.querySelector(selector)!);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
      const selected = await readHtmlReviewSelection("preview", location.href);
      expect(selected.node).toBeNull();
      expect(JSON.stringify(selected)).not.toContain("private-");
    }
  });
  it("invalidates changed range line geometry and DOM before copy", async () => {
    select(40, 44);
    const selected = await readHtmlReviewSelection("preview", location.href);
    const capture = await captureHtmlReviewTarget("preview", location.href, "C:/fixture.html", selected.page, selected.node!);
    rects = [{ ...rects[0], x: 21 }, rects[1]] as DOMRect[];
    await expect(validateHtmlReviewCapture(capture, location.href)).rejects.toThrow();
    rects = capture.frame.rects as DOMRect[];
    document.querySelector("p")!.firstChild!.textContent = "replacement";
    await expect(validateHtmlReviewCapture(capture, location.href)).rejects.toThrow();
  });
});

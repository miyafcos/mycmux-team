// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewScript } from "../../src/lib/htmlReviewScripts";
import { reviewReadScript } from "../../src/lib/htmlReviewDraft";
const mocks = vi.hoisted(() => ({ evalWebPane: vi.fn(), screenshotWebPane: vi.fn() }));
vi.mock("../../src/components/workspace/webPaneApi", () => mocks);
import { cancelHtmlReviewPicker, captureHtmlReviewTarget, chooseHtmlReviewElement } from "../../src/lib/htmlReviewCapture";
let key: string, hit: Element, originalUrl: string;
const run = <T,>(script: string): T => new Function(script.replaceAll("__mycmuxReviewDraftV1", key))();
const operation = (kind: "picker-start" | "picker-poll" | "picker-stop", token = "test-picker") =>
  run<{ phase: string; page: import("../../src/lib/htmlReviewDraft").ReviewPageRevision; node: import("../../src/lib/htmlReviewDraft").ReviewTarget }>(
    reviewScript(location.href, { kind, token }),
  );
const event = (type: string) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 30, clientY: 50, button: 0 });
beforeEach(() => {
  vi.clearAllMocks();
  key = "__rvPicker" + Math.random().toString().slice(2); originalUrl = location.href;
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  Object.defineProperty(window, "__mycmux", { value: { generation: 10, refs: new Map() }, configurable: true });
  document.body.innerHTML = '<h2>Section</h2><a id="link" href="#changed">Link</a><svg id="figure"><rect width="100" height="100"/></svg><img id="photo"><input id="form" value="private-value"><p>Paragraph</p>';
  hit = document.querySelector("#figure")!;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 40, width: 150, height: 30 } as DOMRect);
  Object.defineProperty(document, "elementsFromPoint", { value: () => [document.querySelector("[data-mycmux-review-overlay]"), hit, document.body].filter(Boolean), configurable: true });
  mocks.evalWebPane.mockImplementation(async (tabId: string, script: string) => ({ tabId, value: run(script) }));
  mocks.screenshotWebPane.mockResolvedValue({ tabId: "preview", path: "C:/review/picked.png", width: 150, height: 30, dpr: 1 });
});
afterEach(() => {
  run(reviewScript("", { kind: "picker-stop", token: "test-picker" }));
  (window as unknown as Record<string, { observer: MutationObserver }>)[key]?.observer.disconnect();
  history.replaceState(null, "", originalUrl);
  Reflect.deleteProperty(document, "elementsFromPoint");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe("RV-T4 element picker", () => {
  it("adds an outline, prevents page pointer/click actions and removes every listener on selection", () => {
    const added = vi.spyOn(window, "addEventListener"), removed = vi.spyOn(window, "removeEventListener");
    const pageClick = vi.fn(), pageDown = vi.fn();
    hit.addEventListener("click", pageClick); hit.addEventListener("pointerdown", pageDown);
    const revision = run<{ mutationRevision: number }>(reviewReadScript(location.href)).mutationRevision;
    operation("picker-start");
    const overlay = document.querySelector("[data-mycmux-review-overlay]")!;
    hit.dispatchEvent(event("pointermove"));
    expect((overlay.firstChild as HTMLElement).style.left).toBe("20px");
    expect((overlay.firstChild as HTMLElement).style.width).toBe("150px");
    expect(run<{ mutationRevision: number }>(reviewReadScript(location.href)).mutationRevision).toBe(revision);
    expect(hit.dispatchEvent(event("pointerdown"))).toBe(false);
    expect(hit.dispatchEvent(event("click"))).toBe(false);
    expect(pageDown).not.toHaveBeenCalled(); expect(pageClick).not.toHaveBeenCalled();
    const selected = operation("picker-poll");
    expect(selected.phase).toBe("selected"); expect(selected.node.tag).toBe("svg");
    expect(document.querySelector(selected.node.frame!.selector)).toBe(hit);
    expect(document.querySelector("[data-mycmux-review-overlay]")).toBeNull();
    const listeners = added.mock.calls.filter(call => call[2] === true);
    expect(listeners.length).toBeGreaterThan(10);
    for (const listener of listeners) expect(removed.mock.calls.some(call => call[0] === listener[0] && call[1] === listener[1] && call[2] === true)).toBe(true);
    hit.dispatchEvent(event("click")); expect(pageClick).toHaveBeenCalledOnce();
  });
  it.each(["Escape", "pagehide", "beforeunload", "popstate", "hashchange"])("cleans up when cancelled by %s", (reason) => {
    operation("picker-start");
    window.dispatchEvent(reason === "Escape" ? new KeyboardEvent("keydown", { key: "Escape", cancelable: true }) : new Event(reason));
    expect(operation("picker-poll").phase).toBe("cancelled");
    expect(document.querySelector("[data-mycmux-review-overlay]")).toBeNull();
  });
  it("does not follow a link when selected and restores it after cancelling", () => {
    hit = document.querySelector("#link")!;
    operation("picker-start");
    expect(hit.dispatchEvent(event("click"))).toBe(false);
    expect(location.href).toBe(originalUrl);
    expect(operation("picker-poll").node.tag).toBe("a");
  });
  it.each(["#photo", "p", "#form"])("selects any %s element without carrying form values", (selector) => {
    hit = document.querySelector(selector)!;
    operation("picker-start"); hit.dispatchEvent(event("click"));
    const selected = operation("picker-poll");
    expect(selected.phase).toBe("selected");
    expect(JSON.stringify(selected)).not.toContain("private-value");
  });
  it("anchors textless SVG context at its DOM position rather than the page start", () => {
    operation("picker-start"); hit.dispatchEvent(event("click"));
    const selected = operation("picker-poll");
    expect(selected.node.anchor!.text).toBe("");
    expect(selected.node.anchor!.before).toContain("Link");
    expect(selected.node.anchor!.after).toMatch(/^Paragraph/);
    expect(selected.node.anchor!.heading).toBe("Section");
  });
  it("scopes stop to its token, permits cleanup after navigation and rejects stale URL metadata", () => {
    operation("picker-start");
    operation("picker-stop", "other-token");
    expect(document.querySelector("[data-mycmux-review-overlay]")).not.toBeNull();
    history.replaceState(null, "", "?different-page");
    expect(() => run(reviewScript(originalUrl, { kind: "picker-poll", token: "test-picker" }))).toThrow("review-stale");
    expect(document.querySelector("[data-mycmux-review-overlay]")).toBeNull();
    expect(() => run(reviewScript("", { kind: "picker-stop", token: "test-picker" }))).not.toThrow();
  });
  it("uses the same capture guards for a picked SVG and cleans up the API transaction", async () => {
    mocks.evalWebPane.mockImplementation(async (tabId: string, script: string) => {
      if (script.includes('"kind":"picker-poll"')) hit.dispatchEvent(event("click"));
      return { tabId, value: run(script) };
    });
    const chosen = await chooseHtmlReviewElement("preview", location.href, "test-picker", () => true);
    const capture = await captureHtmlReviewTarget("preview", location.href, "C:/fixture.html", chosen!.page, chosen!.node);
    expect(capture.node.tag).toBe("svg");
    expect(capture.clip).toEqual({ x: 20, y: 40, width: 150, height: 30 });
    expect(document.querySelector("[data-mycmux-review-overlay]")).toBeNull();
    expect(mocks.evalWebPane.mock.calls.some(([, script]) => String(script).includes('"kind":"picker-stop"'))).toBe(true);
  });
  it("cleans a late start when the component is no longer current", async () => {
    const chosen = await chooseHtmlReviewElement("preview", location.href, "test-picker", () => false);
    expect(chosen).toBeNull();
    expect(document.querySelector("[data-mycmux-review-overlay]")).toBeNull();
    await expect(cancelHtmlReviewPicker("preview", "test-picker")).resolves.toBeUndefined();
  });
});

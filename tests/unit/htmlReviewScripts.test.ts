// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewScript } from "../../src/lib/htmlReviewScripts";
import { reviewReadScript, sameReviewFrame, type ReviewTarget } from "../../src/lib/htmlReviewDraft";

let key: string;
const run = <T,>(script: string): T => new Function(script.replaceAll("__mycmuxReviewDraftV1", key))();
const search = (text: string) => run<{ nodes: ReviewTarget[] }>(reviewScript(location.href, { kind: "search", text })).nodes;
beforeEach(() => {
  key = "__rvReview" + Math.random().toString().slice(2);
  vi.stubGlobal("CSS", { escape: (text: string) => text });
  Object.defineProperty(window, "__mycmux", { value: { generation: 7, refs: new Map() }, configurable: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return { x: Number(this.getAttribute("data-x") ?? 10), y: Number(this.getAttribute("data-y") ?? 20), width: 120, height: 30 } as DOMRect;
  });
  document.body.innerHTML = "";
});
afterEach(() => {
  (window as unknown as Record<string, { observer: MutationObserver }>)[key]?.observer.disconnect();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("RV-T2 text targets", () => {
  it("matches Japanese prose across line breaks, spaces and NFKC differences", () => {
    document.body.innerHTML = "<h2>\u4f7f\u3044\u65b9</h2><p>\u524d\u6587\u3000\u672c\u6587\u306e\n\u8aac\u660e  \uff21\uff22\uff23 \uff76\uff9e\u3000\u5f8c\u6587</p>";
    const [node] = search("\u672c\u6587\u306e\u8aac\u660e ABC \u30ac");
    expect(node.tag).toBe("p");
    expect(node.anchor?.text).toBe("\u672c\u6587\u306e\n\u8aac\u660e  \uff21\uff22\uff23 \uff76\uff9e");
    expect(node.anchor?.before).toBe("\u524d\u6587\u3000");
    expect(node.anchor?.after).toBe("\u3000\u5f8c\u6587");
    expect(node.anchor?.heading).toBe("\u4f7f\u3044\u65b9");
  });
  it("keeps only the innermost visible span and keeps surrounding paragraph context", () => {
    document.body.innerHTML = "<p>\u524d\u6587<span><span>\u6307\u6458\u3059\u308b\u672c\u6587</span></span>\u5f8c\u6587</p>";
    const nodes = search("\u6307\u6458\u3059\u308b\u672c\u6587");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].tag).toBe("span");
    expect(nodes[0].anchor).toMatchObject({ before: "\u524d\u6587", after: "\u5f8c\u6587" });
    expect(document.querySelector(nodes[0].frame!.selector)).toBe(document.querySelector("span span"));
  });
  it.each(["p", "li", "td", "th", "figcaption", "code", "pre", "button", "h3"])("includes displayed %s text", (tag) => {
    document.body.innerHTML = tag === "td" || tag === "th"
      ? "<table><tbody><tr><" + tag + ">\u672c\u6587\u306e\u8aac\u660e</" + tag + "></tr></tbody></table>"
      : "<" + tag + ">\u672c\u6587\u306e\u8aac\u660e</" + tag + ">";
    expect(search("\u672c\u6587\u306e\u8aac\u660e").map(node => node.tag)).toEqual([tag]);
  });
  it("joins br-separated text without losing its original line break", () => {
    document.body.innerHTML = "<p>\u65e5\u672c\u8a9e<br>\u672c\u6587</p>";
    expect(search("\u65e5\u672c\u8a9e\u672c\u6587")[0].anchor?.text).toBe("\u65e5\u672c\u8a9e\n\u672c\u6587");
  });
  it("sorts by screen top, then left, and caps results at 30", () => {
    document.body.innerHTML = Array.from({ length: 35 }, (_, i) => '<p data-y="' + (350 - i * 10) + '">\u672c\u6587 ' + i + "</p>").join("");
    const nodes = search("\u672c\u6587");
    expect(nodes).toHaveLength(30);
    expect(nodes.map(node => node.rect.y)).toEqual(Array.from({ length: 30 }, (_, i) => 10 + i * 10));
  });
  it("does not match hidden text or carry any form/edited value in a parent match", () => {
    document.body.innerHTML = '<h2 style="display:none">hidden-heading</h2><p>\u672c\u6587<span hidden>secret-hidden</span><input value="secret-value"><textarea>secret-default</textarea><select><option selected>secret-option</option></select><span contenteditable="true">secret-edit</span></p>';
    expect(search("secret")).toEqual([]);
    const serialized = JSON.stringify(search("\u672c\u6587"));
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain('"value"');
  });
  it("keeps shared refs and node descriptors untouched", () => {
    document.body.innerHTML = '<button data-mycmux-ref="agent-ref">Original</button><p>\u672c\u6587</p>';
    const state = (window as unknown as { __mycmux: { refs: Map<string, Element> } }).__mycmux;
    state.refs.set("agent-ref", document.querySelector("button")!);
    const nodes = search("\u672c\u6587");
    expect(state.refs.size).toBe(1);
    expect(document.querySelector("button")!.getAttribute("data-mycmux-ref")).toBe("agent-ref");
    expect(state.refs.has(nodes[0].ref)).toBe(false);
  });
  it("binds each candidate to search-time geometry and invalidates DOM or scroll changes", () => {
    document.body.innerHTML = "<p>\u672c\u6587</p>";
    const [node] = search("\u672c\u6587");
    expect(sameReviewFrame(node.frame!, run(reviewReadScript(location.href, node.ref)))).toBe(true);
    document.querySelector("p")!.textContent = "\u5909\u66f4\u5f8c";
    expect(sameReviewFrame(node.frame!, run(reviewReadScript(location.href, node.ref)))).toBe(false);
  });
  it("returns no broad parent match for an empty query and refuses another URL", () => {
    document.body.innerHTML = "<p>\u672c\u6587</p>";
    expect(search(" \n")).toEqual([]);
    expect(() => run(reviewScript("https://example.test/other", { kind: "search", text: "\u672c\u6587" }))).toThrow("review-stale");
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { classifyPreviewLink } from "../../src/lib/markdownPreviewDocument";
import { installPreviewLinkHandler, openNativePreviewLink } from "../../src/lib/previewLinks";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

function fixture(href: string, target = "") {
  const doc = new DOMParser().parseFromString("<body><a><span>link</span></a></body>", "text/html");
  const anchor = doc.querySelector("a")!;
  anchor.setAttribute("href", href);
  if (target) anchor.setAttribute("target", target);
  let listener: EventListener | null = null;
  const add = doc.addEventListener.bind(doc);
  vi.spyOn(doc, "addEventListener").mockImplementation((name, handler, options) => {
    if (name === "click") listener = handler as EventListener;
    add(name, handler, options);
  });
  const openNative = vi.fn(() => Promise.resolve());
  const openLocal = vi.fn();
  const onError = vi.fn();
  let at = 0;
  const cleanup = installPreviewLinkHandler(doc, { openNative, openLocal, onError, allowLocalDocuments: true, now: () => at });
  const click = (trusted: boolean, button = 0) => {
    const event = { target: anchor.querySelector("span"), type: "click", button, isTrusted: trusted,
      preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    listener!(event as unknown as Event);
    return event;
  };
  return { doc, anchor, openNative, openLocal, onError, cleanup, click, advance: () => { at += 500; } };
}

describe("preview frame links", () => {
  it.each(["", "_blank"])("opens http(s) from one trusted click with target=%s", (target) => {
    const state = fixture("https://example.test/report", target);
    const event = state.click(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(state.openNative).toHaveBeenCalledExactlyOnceWith("https://example.test/report");
    state.cleanup();
  });

  it.each(["html", "markdown", "text", "office", "editing"])("uses the same native path operation in %s documents", () => {
    const state = fixture("mzopen:b64.QzovcmVwb3J0LnR4dA");
    state.click(true);
    expect(state.openNative).toHaveBeenCalledExactlyOnceWith("mzopen:b64.QzovcmVwb3J0LnR4dA");
    state.cleanup();
  });

  it("swallows DOM-generated clicks without opening any native target", () => {
    const state = fixture("https://example.test/report");
    state.anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    state.click(false);
    expect(state.openNative).not.toHaveBeenCalled();
    expect(state.openLocal).not.toHaveBeenCalled();
    state.cleanup();
  });

  it.each(["ms-settings:display", "file:///C:/Windows/cmd.exe", "javascript:alert(1)", "mailto:a@example.test", "mzopen:b64.broken!", "https:example.test"])("blocks %s", (href) => {
    const state = fixture(href);
    state.click(true);
    expect(state.openNative).not.toHaveBeenCalled();
    expect(classifyPreviewLink(state.anchor)).toEqual({ kind: "none" });
    state.cleanup();
  });

  it("rate limits repeated clicks and releases its listeners on replacement", () => {
    const state = fixture("https://example.test/report");
    state.click(true);
    state.click(true);
    expect(state.openNative).toHaveBeenCalledOnce();
    state.advance();
    state.click(true);
    expect(state.openNative).toHaveBeenCalledTimes(2);
    state.cleanup();
    state.anchor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(state.openNative).toHaveBeenCalledTimes(2);
  });

  it("retains the rendered Markdown local-document callback", () => {
    const state = fixture("other.md");
    state.anchor.setAttribute("data-mycmux-local-path", "C:/reports/other.md");
    state.click(true);
    expect(state.openLocal).toHaveBeenCalledExactlyOnceWith("C:/reports/other.md");
    expect(state.openNative).not.toHaveBeenCalled();
    state.cleanup();
  });

  it("routes through the already registered async command without shell IPC", async () => {
    await openNativePreviewLink("https://example.test/x");
    expect(invoke).toHaveBeenCalledWith("webpane_navigate", { tabId: "", action: "preview-link", url: "https://example.test/x" });
  });
});

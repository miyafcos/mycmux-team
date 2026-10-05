import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

const source = readFileSync("src-tauri/src/commands/webpane_preview_links.js", "utf8");

function fixture() {
  const listeners = new Map<string, (event: TestEvent) => void>();
  const navigations: string[] = [];
  let at = 0;
  class TestElement {
    attrs: Record<string, string> = {};
    getAttribute(name: string) { return this.attrs[name] ?? null; }
  }
  class TestAnchor extends TestElement {
    constructor(href: string, target = "") { super(); this.attrs = { href, target }; }
    get href() { return new URL(this.attrs.href, "http://asset.localhost/document.html").href; }
  }
  class TestEvent {
    defaultPrevented = false;
    stopped = false;
    constructor(readonly target: TestAnchor, readonly isTrusted: boolean, readonly type = "click", readonly button = 0) {}
    composedPath() { return [this.target]; }
    preventDefault() { this.defaultPrevented = true; }
    stopImmediatePropagation() { this.stopped = true; }
  }
  const window: Record<string, unknown> = { addEventListener: (name: string, listener: (event: TestEvent) => void) => listeners.set(name, listener) };
  window.top = window;
  const location = { assign: (url: string) => navigations.push(url) };
  runInNewContext(source.replace("__MYCMUX_PREVIEW_TOKEN__", "capability"), {
    window, location, crypto: webcrypto, performance: { now: () => at },
    Event: TestEvent, Element: TestElement, HTMLAnchorElement: TestAnchor, URL,
  });
  const click = (href: string, trusted: boolean, target = "", type = "click", button = 0) => {
    const event = new TestEvent(new TestAnchor(href, target), trusted, type, button);
    listeners.get(type)!(event);
    return event;
  };
  return { window, location, click, navigations, advance: () => { at += 500; } };
}

describe("actual document-start preview script", () => {
  it.each(["", "_blank"])("intercepts a trusted anchor before the page can navigate with target=%s", (target) => {
    const state = fixture();
    const event = state.click("https://example.test/report", true, target);
    expect(event.defaultPrevented).toBe(true);
    expect(event.stopped).toBe(true);
    expect(state.navigations).toHaveLength(1);
    const url = new URL(state.navigations[0]);
    expect(url.hostname).toBe("mycmux-preview-link.invalid");
    expect(url.searchParams.get("url")).toBe("https://example.test/report");
    expect(Object.keys(state.window)).toEqual(["addEventListener", "top"]);
  });

  it("does not accept script-generated events or unsupported URLs", () => {
    const state = fixture();
    for (let index = 0; index < 20; index++) state.click("https://example.test/report", false, "_blank");
    for (const url of ["ms-settings:display", "file:///C:/Windows/cmd.exe", "javascript:alert(1)"]) state.click(url, true);
    expect(state.navigations).toEqual([]);
  });

  it("keeps the native function private even after document scripts replace globals", () => {
    const state = fixture();
    state.location.assign = () => { throw new Error("document replacement was called"); };
    state.click("mzopen:b64.QzovcmVwb3J0LnR4dA", true);
    expect(state.navigations).toHaveLength(1);
    expect(new URL(state.navigations[0]).searchParams.get("url")).toBe("mzopen:b64.QzovcmVwb3J0LnR4dA");
  });

  it("consumes at most one target each 500 ms and sequences accepted clicks", () => {
    const state = fixture();
    state.click("https://example.test/a", true);
    state.click("https://example.test/b", true);
    expect(state.navigations).toHaveLength(1);
    state.advance();
    state.click("https://example.test/b", true, "_blank", "auxclick", 1);
    expect(state.navigations).toHaveLength(2);
    expect(new URL(state.navigations[0]).pathname.endsWith("/1")).toBe(true);
    expect(new URL(state.navigations[1]).pathname.endsWith("/2")).toBe(true);
  });

  it("leaves fragments and existing asset navigation inside the preview", () => {
    const state = fixture();
    expect(state.click("#heading", true).defaultPrevented).toBe(false);
    expect(state.click("http://asset.localhost/other.html", true).defaultPrevented).toBe(false);
    expect(state.click("https://example.test/right", true, "", "auxclick", 2).defaultPrevented).toBe(false);
    expect(state.navigations).toEqual([]);
  });
});

// @vitest-environment jsdom
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { TextEncoder } from "node:util";
import { URL as NativeURL } from "node:url";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

const key = "test-only-operator-focus-key";
const nonce = "07070707070707070707070707070707";
const start = 1_800_000_000_000;
const target = "terminal.fixture-1:2";
const attribute = "data-mycmux-focus-tab";
const marker = "data-mycmux-operator-focus";
const testURL = (path: string) => new URL("../../src-tauri/src/commands/" + path, import.meta.url);
const hmacFile = testURL("webpane_hmac.js");
function injectedScript(proofKey = key) {
  return readFileSync(testURL("webpane_operator_focus.js"), "utf8")
    .replace("__MYCMUX_OPERATOR_FOCUS_KEY__", proofKey)
    .replace("__MYCMUX_HMAC_SHA256__", () => readFileSync(hmacFile, "utf8").trim());
}

function fixture({
  origin = "http://localhost:8123",
  top = true,
  root = true,
  proofKey = key,
}: { origin?: string; top?: boolean; root?: boolean; proofKey?: string } = {}) {
  let currentOrigin = origin;
  let elapsed = 0;
  let observer: (() => void) | undefined;
  let click: ((event: MockEvent) => void) | undefined;
  const location = { get origin() { return currentOrigin; }, assign: vi.fn() };
  const window = { location, top: {} };
  if (top) window.top = window;
  const disconnect = vi.fn();
  class Observer {
    constructor(callback: () => void) { observer = callback; }
    observe() {}
    disconnect() { observer = undefined; disconnect(); }
  }
  class MockNode { get nodeType() { return 1; } }
  class MockElement extends MockNode {
    private attributes = new Map<string, string>();
    constructor(private name = "span") { super(); }
    get localName() { return this.name; }
    get namespaceURI() { return "http://www.w3.org/1999/xhtml"; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    hasAttribute(name: string) { return this.attributes.has(name); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    matches() { return false; }
  }
  class MockButton extends MockElement {
    constructor(private disabledValue = false) { super("button"); }
    get disabled() { return this.disabledValue; }
  }
  class MockEvent {
    constructor(readonly nodes: unknown[], readonly isTrusted: boolean) {}
    prevented = vi.fn();
    stopped = vi.fn();
    composedPath() { return this.nodes; }
    preventDefault() { this.prevented(); }
    stopImmediatePropagation() { this.stopped(); }
  }
  class MockUiEvent extends MockEvent {
    constructor(nodes: unknown[], trusted: boolean, private clickDetail: number) { super(nodes, trusted); }
    get detail() { return this.clickDetail; }
  }
  class MockMouseEvent extends MockUiEvent {
    constructor(nodes: unknown[], trusted: boolean, detail: number, private mouseButton: number) {
      super(nodes, trusted, detail);
    }
    get button() { return this.mouseButton; }
  }
  class MockDocument {
    private rootElement: MockElement | null = root ? new MockElement("html") : null;
    get documentElement() { return this.rootElement; }
    set documentElement(value: MockElement | null) { this.rootElement = value; }
    addEventListener(name: string, handler: typeof click, capture: boolean) {
      expect(name).toBe("click");
      expect(capture).toBe(true);
      click = handler;
    }
  }
  const doc = new MockDocument();
  const context = vm.createContext({
    window, location, document: doc, URL: NativeURL, TextEncoder,
    Date: { now: () => start + elapsed }, performance: { now: () => elapsed },
    crypto: { getRandomValues: (bytes: Uint8Array) => { for (let i = 0; i < bytes.length; i++) bytes[i] = 7; return bytes; } },
    Document: MockDocument, Node: MockNode, Element: MockElement, HTMLButtonElement: MockButton, Event: MockEvent,
    UIEvent: MockUiEvent, MouseEvent: MockMouseEvent, MutationObserver: Observer,
  });
  vm.runInContext(injectedScript(proofKey), context);
  const button = new MockButton();
  button.setAttribute(attribute, target);
  const span = new MockElement();
  return {
    doc, button, span, context, location, move: location.assign, disconnect,
    element: (name: string) => new MockElement(name),
    disabled: () => { const item = new MockButton(true); item.setAttribute(attribute, target); return item; },
    setElapsed: (value: number) => { elapsed = value; },
    setOrigin: (value: string) => { currentOrigin = value; },
    mutation: () => observer?.(),
    hasClick: () => Boolean(click),
    click({
      trusted = true, detail = 1, mouseButton = 0, path = [span, button, window],
    }: { trusted?: boolean; detail?: number; mouseButton?: number; path?: unknown[] } = {}) {
      const event = new MockMouseEvent(path, trusted, detail, mouseButton);
      click?.(event);
      return event;
    },
  };
}

function expectMove(moved: unknown, sequence: number, pressed: number, origin: string, proofKey = key) {
  expect(typeof moved).toBe("string");
  const url = new URL(moved as string);
  const message = [nonce, sequence, pressed, origin, target].join("\n");
  const mac = createHmac("sha256", proofKey).update(message).digest("hex");
  expect(url.origin).toBe("https://mycmux-operator-focus.invalid");
  expect(url.pathname).toBe("/" + [nonce, sequence, pressed, mac].join("/"));
  expect(url.searchParams.get("origin")).toBe(origin);
  expect(url.searchParams.get("tab")).toBe(target);
}

it("marks loopback and signs exactly the nearest eligible button within a trusted pointer click", () => {
  const f = fixture();
  expect(f.doc.documentElement?.getAttribute(marker)).toBe("1");
  const event = f.click();
  expect(event.prevented).toHaveBeenCalledOnce();
  expect(event.stopped).toHaveBeenCalledOnce();
  expect(f.move).toHaveBeenCalledOnce();
  expectMove(f.move.mock.calls[0]?.[0], 1, start, "http://localhost:8123");
  f.setElapsed(499);
  f.click();
  expect(f.move).toHaveBeenCalledOnce();
  f.setElapsed(500);
  f.click();
  expect(f.move).toHaveBeenCalledTimes(2);
  expectMove(f.move.mock.calls[1]?.[0], 2, start + 500, "http://localhost:8123");
});

it.each([
  "https://localhost", "http://example.test", "http://127.0.0.2",
  "http://asset.localhost", "http://[::1]", "http://localhost.", "null",
])("does not install or mark on %s", (origin) => {
  const f = fixture({ origin });
  expect(f.doc.documentElement?.hasAttribute(marker)).toBe(false);
  expect(f.hasClick()).toBe(false);
  f.click();
  expect(f.move).not.toHaveBeenCalled();
});

it("does not install or mark in a child frame", () => {
  const f = fixture({ top: false });
  expect(f.doc.documentElement?.hasAttribute(marker)).toBe(false);
  expect(f.hasClick()).toBe(false);
});

it("marks a newly created document root once", () => {
  const f = fixture({ root: false, origin: "http://127.0.0.1" });
  expect(f.doc.documentElement).toBeNull();
  f.mutation();
  const root = f.element("html");
  f.doc.documentElement = root;
  f.mutation();
  expect(root.getAttribute(marker)).toBe("1");
  expect(f.disconnect).toHaveBeenCalledOnce();
  root.removeAttribute(marker);
  f.mutation();
  expect(root.hasAttribute(marker)).toBe(false);
});

it("rechecks the document origin at the time of the press", () => {
  const f = fixture();
  f.setOrigin("https://localhost");
  f.click();
  expect(f.move).not.toHaveBeenCalled();
  f.setOrigin("http://127.0.0.1:8080");
  f.click();
  expectMove(f.move.mock.calls[0]?.[0], 1, start, "http://127.0.0.1:8080");
});

it("ignores synthetic, secondary-button, keyboard and disabled clicks", () => {
  const f = fixture();
  const events = [
    f.click({ trusted: false }),
    f.click({ mouseButton: 1 }),
    f.click({ detail: 0 }),
    f.click({ path: [f.disabled(), f.button] }),
    f.click({ path: [f.span] }),
  ];
  expect(f.move).not.toHaveBeenCalled();
  for (const event of events) expect(event.prevented).not.toHaveBeenCalled();
  f.click();
  expect(f.move).toHaveBeenCalledOnce();
});

it("does not walk past an ineligible closest marker or accept a malformed target", () => {
  const f = fixture();
  f.span.setAttribute(attribute, target);
  f.click();
  f.span.removeAttribute(attribute);
  for (const value of ["", "x".repeat(129), "wrong\n", "x/y", "日本語"]) {
    f.button.setAttribute(attribute, value);
    f.click();
  }
  expect(f.move).not.toHaveBeenCalled();
  f.button.setAttribute(attribute, target);
  f.click();
  expect(f.move).toHaveBeenCalledOnce();
});

it("keeps the captured methods and ignores page changes to globals and prototypes", () => {
  const f = fixture();
  vm.runInContext('location.assign = () => { throw new Error("late assign"); };' +
    'Date.now = () => 17; Array.prototype.find = () => undefined;' +
    'Element.prototype.getAttribute = () => "changed";' +
    'Object.defineProperty(HTMLButtonElement, Symbol.hasInstance, { value: () => false });', f.context);
  f.click();
  expect(f.move).toHaveBeenCalledOnce();
  expectMove(f.move.mock.calls[0]?.[0], 1, start, "http://localhost:8123");
});

it("ignores dispatchEvent and element.click in a DOM document", () => {
  const doc = document.implementation.createHTMLDocument();
  const location = { origin: "http://localhost", assign: vi.fn() };
  const environment = {
    window: { location, top: {} }, location, document: doc, URL: NativeURL, TextEncoder,
    Date, performance, crypto, Document, Node, Element, HTMLButtonElement, Event,
    UIEvent, MouseEvent, MutationObserver,
  };
  environment.window.top = environment.window;
  vm.runInNewContext(injectedScript(), environment);
  expect(doc.documentElement.getAttribute(marker)).toBe("1");
  const button = doc.createElement("button");
  button.setAttribute(attribute, target);
  doc.body.appendChild(button);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
  button.click();
  expect(location.assign).not.toHaveBeenCalled();
});


it("validates target characters even when the page replaces RegExp and String methods", () => {
  const f = fixture();
  vm.runInContext("RegExp.prototype.exec = () => null; String.prototype.charCodeAt = () => 97;", f.context);
  f.button.setAttribute(attribute, "bad/target");
  f.click();
  expect(f.move).not.toHaveBeenCalled();
  f.button.setAttribute(attribute, target);
  f.click();
  expectMove(f.move.mock.calls[0]?.[0], 1, start, "http://localhost:8123");
});


it.each([
  ["0123456789abcdef".repeat(4), "68209799e620ec44dfcf78f0339df6da92fcae02e70181aac891dc23cf713ebc"],
  ["0123456789abcdef".repeat(4) + "0", "6300e2d05283d7f2b123c455ac21b881b20bc993d8e9232cc5f426f9d8afb286"],
])("matches the Node and fixed HMAC vectors at the SHA-256 block boundary", (proofKey, expected) => {
  const f = fixture({ proofKey });
  f.click();
  expect(f.move).toHaveBeenCalledOnce();
  const moved = f.move.mock.calls[0]![0];
  expectMove(moved, 1, start, "http://localhost:8123", proofKey);
  expect(new URL(moved).pathname.split("/").at(-1)).toBe(expected);
});

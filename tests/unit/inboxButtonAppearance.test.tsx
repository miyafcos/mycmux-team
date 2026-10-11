// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboxButton } from "../../src/components/inbox/InboxButton";
import { inboxStrings, listInboxEntries, openInboxEntry } from "../../src/lib/inbox";

vi.mock("../../src/lib/inbox", async (original) => ({
  ...(await original<typeof import("../../src/lib/inbox")>()),
  listInboxEntries: vi.fn(), openInboxEntry: vi.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let styles: HTMLStyleElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  styles = document.createElement("style");
  // jsdom has no pointer/keyboard pseudo-state engine. Apply the actual CSS
  // declarations and cascade, mapping only those states to explicit attributes.
  styles.textContent = readFileSync("src/global.css", "utf8")
    .replaceAll(":hover", "[data-test-hover]")
    .replaceAll(":active", "[data-test-active]")
    .replaceAll(":focus-visible", "[data-test-focus]");
  document.head.append(styles);
});

afterEach(async () => {
  await act(async () => root.unmount());
  styles.remove();
  host.remove();
  vi.useRealTimers();
});

async function openPanel(): Promise<HTMLElement> {
  await act(async () => root.render(<InboxButton />));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  return document.getElementById("inbox-panel")!;
}

function refresh(panel: HTMLElement): HTMLButtonElement {
  return [...panel.querySelectorAll("button")].find((button) => button.textContent === inboxStrings.refresh)!;
}

function expectDisabledAppearance(button: HTMLButtonElement): void {
  expect(button.disabled).toBe(true);
  const resting = getComputedStyle(button);
  expect(resting.cursor).toBe("not-allowed");
  expect(resting.opacity).toBe("0.5");
  const color = resting.color;
  const background = resting.backgroundColor;
  button.dataset.testHover = "";
  button.dataset.testActive = "";
  const hovered = getComputedStyle(button);
  expect(hovered.color).toBe(color);
  expect(hovered.backgroundColor).toBe(background);
  expect(hovered.transform).not.toBe("scale(0.97)");
}

it("makes pending Refresh visibly disabled at rest and on hover", async () => {
  vi.mocked(listInboxEntries).mockReturnValue(new Promise(() => {}));
  const panel = await openPanel();
  const button = refresh(panel);
  expectDisabledAppearance(button);
  await act(async () => button.click());
  expect(listInboxEntries).toHaveBeenCalledTimes(1);
});

it("makes retained Refresh and Open visibly disabled while closing", async () => {
  vi.mocked(listInboxEntries).mockResolvedValue([
    { from: "codex", title: "Example", path: "codex/example.md", receivedAt: null },
  ]);
  const panel = await openPanel();
  const open = panel.querySelector<HTMLButtonElement>('button[aria-label="Example 開く"]')!;
  expect(open.disabled).toBe(false);
  await act(async () => panel.querySelector<HTMLButtonElement>(`button[aria-label="${inboxStrings.close}"]`)!.click());
  expectDisabledAppearance(refresh(panel));
  expectDisabledAppearance(open);
  await act(async () => open.click());
  expect(openInboxEntry).not.toHaveBeenCalled();
});

it("restores enabled hover, pressed feedback and global keyboard focus after loading", async () => {
  let resolve!: (entries: []) => void;
  vi.mocked(listInboxEntries).mockReturnValue(new Promise((done) => { resolve = done; }));
  const panel = await openPanel();
  await act(async () => resolve([]));
  const button = refresh(panel);
  expect(button.disabled).toBe(false);
  expect(getComputedStyle(button).cursor).toBe("pointer");
  button.dataset.testHover = "";
  // jsdom does not apply !important over an inline background consistently.
  // Check the installed rule's selector and declaration for enabled hover.
  const hoverRule = [...styles.sheet!.cssRules].find((rule) => rule instanceof CSSStyleRule
    && rule.selectorText === ".cmux-title-btn[data-test-hover]") as CSSStyleRule;
  expect(button.matches(hoverRule.selectorText)).toBe(true);
  expect(hoverRule.style.getPropertyValue("background")).toBe("var(--cmux-hover)");
  button.dataset.testActive = "";
  expect(getComputedStyle(button).transform).toBe("scale(0.97)");
  button.dataset.testFocus = "";
  expect(getComputedStyle(button).outline).toContain("2px solid");
});

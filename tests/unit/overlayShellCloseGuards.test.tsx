// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayShell } from "../../src/components/common/OverlayShell";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

function render(open: boolean, closing: boolean, onClose: () => void): void {
  act(() => root.render(
    <OverlayShell open={open} closing={closing} onClose={onClose} ariaLabel="検査">
      <button type="button">中身</button>
    </OverlayShell>,
  ));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("OverlayShell close guards", () => {
  it("closes from a primary-button backdrop press only", () => {
    const onClose = vi.fn();
    render(true, false, onClose);
    const backdrop = document.querySelector<HTMLElement>("[data-cmux-overlay-root]");
    expect(backdrop).not.toBeNull();

    act(() => backdrop?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => backdrop?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the background inert through the closing transition and restores it on unmount", () => {
    const background = document.createElement("main");
    document.body.insertBefore(background, container);
    render(true, false, () => {});
    expect(background.hasAttribute("inert")).toBe(true);

    render(false, true, () => {});
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");

    act(() => root.unmount());
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    root = createRoot(container);
  });
});

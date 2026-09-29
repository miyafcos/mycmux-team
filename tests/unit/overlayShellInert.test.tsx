// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OverlayShell } from "../../src/components/common/OverlayShell";

let container: HTMLDivElement;
let root: Root;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function overlays(states: Array<{ id: string; closing?: boolean }>) {
  return states.map(({ id, closing }) => (
    <OverlayShell
      key={id}
      id={id}
      open
      closing={closing}
      onClose={() => {}}
      ariaLabel={id}
    >
      {id}
    </OverlayShell>
  ));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

describe("OverlayShell portal background isolation", () => {
  it("portals to body and makes only non-overlay body children inert", () => {
    const background = document.createElement("main");
    document.body.insertBefore(background, container);

    act(() => root.render(overlays([{ id: "one" }])));

    const portalRoot = document.querySelector<HTMLElement>("[data-cmux-overlay-root]");
    expect(portalRoot?.parentElement).toBe(document.body);
    expect(portalRoot?.hasAttribute("inert")).toBe(false);
    expect(portalRoot?.hasAttribute("aria-hidden")).toBe(false);
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the background inert until the final overlay closes", () => {
    const background = document.createElement("main");
    document.body.insertBefore(background, container);

    act(() => root.render(overlays([{ id: "one" }, { id: "two" }])));
    expect(background.hasAttribute("inert")).toBe(true);
    expect(document.querySelectorAll("[data-cmux-overlay-root]")).toHaveLength(2);

    act(() => root.render(overlays([{ id: "two" }])));
    expect(background.hasAttribute("inert")).toBe(true);

    act(() => root.render([]));
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
  });

  it("restores the exact prior inert and aria-hidden states", () => {
    const plain = document.createElement("main");
    const explicitFalse = document.createElement("aside");
    explicitFalse.setAttribute("aria-hidden", "false");
    const preInert = document.createElement("footer");
    preInert.setAttribute("inert", "");
    preInert.setAttribute("aria-hidden", "legacy");
    document.body.prepend(plain, explicitFalse, preInert);

    act(() => root.render(overlays([{ id: "one" }])));
    expect([plain, explicitFalse, preInert].every((element) => element.hasAttribute("inert"))).toBe(true);
    expect([plain, explicitFalse, preInert].every((element) => element.getAttribute("aria-hidden") === "true")).toBe(true);

    act(() => root.render([]));
    expect(plain.hasAttribute("inert")).toBe(false);
    expect(plain.hasAttribute("aria-hidden")).toBe(false);
    expect(explicitFalse.hasAttribute("inert")).toBe(false);
    expect(explicitFalse.getAttribute("aria-hidden")).toBe("false");
    expect(preInert.hasAttribute("inert")).toBe(true);
    expect(preInert.getAttribute("aria-hidden")).toBe("legacy");
  });

  it("does not acquire background inert while closing", () => {
    const background = document.createElement("main");
    document.body.insertBefore(background, container);

    act(() => root.render(overlays([{ id: "closing", closing: true }])));

    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(document.querySelector("[data-cmux-overlay-root]")?.hasAttribute("inert")).toBe(true);
  });
});

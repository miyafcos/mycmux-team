// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OverlayShell } from "../../src/components/common/OverlayShell";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const themeCases = [
  {
    name: "Paper light / relaxed / 125%",
    values: {
      "--cmux-popover": "#fbfaf7",
      "--cmux-text": "#2d3136",
      "--cmux-font-size-xs": "15px",
      "--cmux-font-size-sm": "16px",
      "--cmux-font-size-md": "19px",
    },
    fontFamily: '"Yu Gothic UI", sans-serif',
  },
  {
    name: "Mayonaka dark / relaxed / 110%",
    values: {
      "--cmux-popover": "#20242b",
      "--cmux-text": "#f2f4f8",
      "--cmux-font-size-xs": "13px",
      "--cmux-font-size-sm": "14px",
      "--cmux-font-size-md": "17px",
    },
    fontFamily: 'Inter, "Segoe UI", sans-serif',
  },
] as const;

let themedRoot: HTMLDivElement;
let reactHost: HTMLDivElement;
let background: HTMLElement;
let root: Root;

beforeEach(() => {
  themedRoot = document.createElement("div");
  themedRoot.dataset.cmuxThemedRoot = "true";
  background = document.createElement("main");
  reactHost = document.createElement("div");
  themedRoot.append(background, reactHost);
  document.body.appendChild(themedRoot);
  root = createRoot(reactHost);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("OverlayShell themed portal scope", () => {
  it.each(themeCases)("inherits $name variables, typography, and stacking", ({ values, fontFamily }) => {
    for (const [name, value] of Object.entries(values)) themedRoot.style.setProperty(name, value);
    themedRoot.style.setProperty("--cmux-overlay-z", "1000");
    themedRoot.style.fontFamily = fontFamily;

    act(() => root.render(
      <OverlayShell open onClose={() => {}} ariaLabel="theme scope">
        themed overlay
      </OverlayShell>,
    ));

    const portalRoot = document.querySelector<HTMLElement>("[data-cmux-overlay-root]");
    const panel = document.querySelector<HTMLElement>(".cmux-overlay-panel");
    expect(portalRoot?.parentElement).toBe(themedRoot);
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(themedRoot.hasAttribute("inert")).toBe(false);
    expect(portalRoot?.hasAttribute("inert")).toBe(false);

    const rootStyle = getComputedStyle(themedRoot);
    const panelStyle = getComputedStyle(panel!);
    for (const name of Object.keys(values)) {
      expect(panelStyle.getPropertyValue(name)).toBe(rootStyle.getPropertyValue(name));
    }
    expect(panelStyle.fontFamily).toBe(rootStyle.fontFamily);
    expect(getComputedStyle(portalRoot!).position).toBe("fixed");
    expect(portalRoot?.style.zIndex).toBe("var(--cmux-overlay-z)");
    expect(rootStyle.getPropertyValue("--cmux-overlay-z")).toBe("1000");
  });

  it("routes Settings, Keybindings, TabSweep, and AiLog through the shared shell", () => {
    const consumers = [
      "src/components/settings/SettingsDialog.tsx",
      "src/components/layout/KeybindingsModal.tsx",
      "src/components/layout/TabSweepPanel.tsx",
      "src/components/ailog/AiLogPanel.tsx",
    ];
    for (const relativePath of consumers) {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      expect(source).toMatch(/import\s+\{\s*OverlayShell\s*\}/);
      expect(source).toContain("<OverlayShell");
    }

    const appShell = readFileSync(resolve(process.cwd(), "src/components/layout/AppShell.tsx"), "utf8");
    const dragHook = readFileSync(resolve(process.cwd(), "src/hooks/useGroupingDrag.ts"), "utf8");
    const liveMock = readFileSync(resolve(process.cwd(), "src/mock/tabGroupingLiveMock.tsx"), "utf8");
    expect(appShell).toContain('data-cmux-themed-root="true"');
    expect(dragHook).toContain('document.querySelector("[data-cmux-themed-root]")');
    expect(liveMock).not.toContain("document.documentElement.style.setProperty");
    expect(liveMock).toContain('document.body.dataset.cmuxThemedRoot = "true"');
  });
});

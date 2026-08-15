// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/components/dashboard/DashboardLinkedText", () => ({
  DashboardLinkedText: ({ text }: { text: string }) => <>{text}</>,
  DashboardUrlLink: ({ url, children }: { url: string; children: React.ReactNode }) => <a href={url}>{children}</a>,
}));

import { MarkdownView } from "../../src/components/dashboard/MarkdownView";
import { dashboardTypographyVars } from "../../src/components/layout/AppShell";
import { parseMarkdown } from "../../src/components/dashboard/markdownModel";
import { useThemeStore } from "../../src/stores/themeStore";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useThemeStore.setState({
    fontFamily: "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', 'Geist Mono', 'SF Mono', 'BIZ UDGothic', 'MS Gothic', monospace",
    fontSize: 14,
    lineHeight: 1.35,
    uiFontScale: 1,
  });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render(view: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(view);
    await Promise.resolve();
  });
}

function DashboardFontScope() {
  const fontFamily = useThemeStore((state) => state.fontFamily);
  const fontSize = useThemeStore((state) => state.fontSize);
  const lineHeight = useThemeStore((state) => state.lineHeight);
  const uiFontScale = useThemeStore((state) => state.uiFontScale);
  return <div className="cmux-dashboard-view" data-dashboard-font-scope="true" style={dashboardTypographyVars(fontFamily, fontSize, lineHeight, uiFontScale)} />;
}

describe("MarkdownView", () => {
  it("renders a table inside its own horizontal-scroll container", async () => {
    const text = "| 対象 | **本数** | `実測` |\n|:---|:--:|---:|\n| [資料](https://example.test) | 12 | 3.5 |";
    expect(parseMarkdown(text)[0]?.type).toBe("table");
    await render(<MarkdownView text={text} />);

    const scroll = container.querySelector<HTMLElement>(".cmux-dashboard-markdown-table-scroll");
    const table = scroll?.querySelector("table");
    expect(scroll?.getAttribute("aria-label")).toBe("Markdown table");
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll("thead th")).toHaveLength(3);
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(table?.querySelector("th:nth-child(2)")?.dataset.align).toBe("center");
    expect(table?.querySelector("th:nth-child(3)")?.dataset.align).toBe("right");
    expect(table?.querySelector("td:nth-child(2)")?.dataset.numeric).toBe("true");
    expect(table?.querySelector("strong")?.textContent).toBe("本数");
    expect(table?.querySelector("code")?.textContent).toBe("実測");
    expect(table?.querySelector("a")?.getAttribute("href")).toBe("https://example.test");
  });

  it("keeps UI chrome and message/table content on separate dashboard font routes", async () => {
    await render(<DashboardFontScope />);
    const scope = container.querySelector<HTMLElement>("[data-dashboard-font-scope='true']")!;
    expect(scope.style.getPropertyValue("--cmux-dash-font-size")).toBe("14px");

    await act(async () => {
      useThemeStore.getState().setFontFamily("'BIZ UDGothic', monospace");
      useThemeStore.getState().setFontSize(10);
      useThemeStore.getState().setLineHeight(1.6);
      useThemeStore.getState().setUiFontScale(0.9);
      await Promise.resolve();
    });

    expect(scope.style.getPropertyValue("--cmux-dash-body-font")).toBe("'BIZ UDGothic', monospace");
    expect(scope.style.getPropertyValue("--cmux-dash-font-family")).toBe("");
    expect(scope.style.getPropertyValue("--cmux-dash-font-size")).toBe("10px");
    expect(scope.style.getPropertyValue("--cmux-dash-line-height")).toBe("1.6");

    const css = readFileSync("src/components/dashboard/DashboardView.css", "utf8");
    const globalCss = readFileSync("src/global.css", "utf8");
    const markdown = readFileSync("src/components/dashboard/MarkdownView.tsx", "utf8");
    const terminalTail = readFileSync("src/components/dashboard/DashboardTerminalTab.tsx", "utf8");
    expect(css).toContain(".cmux-dashboard-view {");
    expect(css).toContain("font-family: var(--cmux-dash-ui-font);");
    expect(css).toContain(".cmux-dashboard-msg { display: grid; min-width: 0; max-width: 84%; gap: 4px; border-radius: 10px; padding: 9px 13px; font-family: var(--cmux-dash-body-font);");
    expect(css).toContain(".cmux-dashboard-markdown { font-family: var(--cmux-dash-body-font) !important;");
    expect(css).toContain(".cmux-dashboard-markdown-table th, .cmux-dashboard-markdown-table td { border-right: 1px solid var(--cmux-border-hairline); border-bottom: 1px solid var(--cmux-border-hairline); padding: 6px 9px; vertical-align: top; text-align: left; white-space: normal; overflow-wrap: anywhere; font-family: var(--cmux-dash-body-font);");
    expect(globalCss).toContain("--cmux-dash-ui-font: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif;");
    expect(globalCss).toContain("font-family: var(--cmux-dash-ui-font);");
    expect(markdown).toContain('fontFamily: "var(--cmux-dash-body-font)"');
    expect(terminalTail).toContain('fontFamily: "var(--cmux-dash-body-font)"');
  });
});

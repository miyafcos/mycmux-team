// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import postcss from "postcss";

vi.mock("../../src/components/dashboard/DashboardLinkedText", () => ({
  DashboardLinkedText: ({ text }: { text: string }) => <>{text}</>,
  DashboardUrlLink: ({ url, children }: { url: string; children: React.ReactNode }) => <a href={url}>{children}</a>,
}));

import { MarkdownView } from "../../src/components/dashboard/MarkdownView";
import { buildThemeVars } from "../../src/components/layout/themeVars";
import { parseMarkdown } from "../../src/components/dashboard/markdownModel";
import { useThemeStore } from "../../src/stores/themeStore";

let container: HTMLDivElement;
let root: Root;
let fontStyle: HTMLStyleElement | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  fontStyle?.remove();
  fontStyle = undefined;
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

function DashboardFontScope({ children }: { children?: React.ReactNode }) {
  const theme = useThemeStore();
  return <div className="cmux-dashboard-view" data-cmux-themed-root="true" data-dashboard-font-scope="true"
    style={buildThemeVars({ ...theme, background: theme.themeTweaks.background })}>{children}</div>;
}

describe("MarkdownView", () => {
  it("F-1 loads standalone defaults without either dashboard stylesheet", async () => {
    fontStyle = document.createElement("style");
    fontStyle.textContent = readFileSync("src/components/dashboard/MarkdownView.css", "utf8");
    document.head.append(fontStyle);
    await render(<MarkdownView text={'# Heading\n\nParagraph\n\n> Quote\n\n- Item\n  - Nested\n- [x] Checked\n\n```ts\ncode\n```\n\n| Name | Count |\n| --- | ---: |\n| a | 2 |'} />);
    expect(readFileSync("src/components/dashboard/MarkdownView.tsx", "utf8")).toContain('import "./MarkdownView.css"');
    expect(readFileSync("src/components/dashboard/DashboardView.css", "utf8")).not.toContain(".cmux-dashboard-markdown {");
    expect(getComputedStyle(container.querySelector("p")!).margin).toBe("0px");
    expect(getComputedStyle(container.querySelector("h1")!).fontSize).toBe("15px");
    expect(getComputedStyle(container.querySelector("pre")!).padding).toBe("10px");
    expect(getComputedStyle(container.querySelector("blockquote")!).paddingLeft).toBe("10px");
    expect(getComputedStyle(container.querySelector("ul")!).paddingLeft).toBe("22px");
    expect(getComputedStyle(container.querySelector("ul ul")!).paddingLeft).toBe("22px");
    expect(getComputedStyle(container.querySelector("ul ul")!).marginTop).toBe("0px");
    expect(getComputedStyle(container.querySelector("td")!).padding).toBe("6px 9px");
  });

  it("R2: fenced code keeps the explicit pre body route under the real global CSS", async () => {
    fontStyle = document.createElement("style");
    fontStyle.textContent = readFileSync("src/global.css", "utf8").replaceAll("\r\n", "\n");
    document.head.append(fontStyle);
    useThemeStore.setState({ fontFamily: '"Fixture Body Font", monospace' });
    await render(<DashboardFontScope><MarkdownView text={'```sh\nprintf "fixture"\n```'} /></DashboardFontScope>);
    const scope = container.querySelector<HTMLElement>("[data-dashboard-font-scope]")!;
    const pre = scope.querySelector("pre")!;
    const code = pre.querySelector("code")!;
    expect(code.textContent).toBe('printf "fixture"');
    expect(scope.style.getPropertyValue("--cmux-dash-body-font")).toBe('"Fixture Body Font", monospace');
    expect(scope.style.getPropertyValue("--cmux-font-mono")).toBe('"Fixture Body Font", "UDEV Gothic NF", "UDEV Gothic", "SFMono-Regular", "JetBrains Mono", "Consolas", ui-monospace, monospace');
    expect(pre.style.fontFamily).toBe("");
    expect(pre.className).toBe("cmux-dashboard-markdown-code");
    const base = postcss.parse(readFileSync("src/components/dashboard/MarkdownView.css", "utf8"));
    const surface = postcss.parse(readFileSync("src/components/dashboard/DashboardChatSurface.css", "utf8"));
    const family = (css: postcss.Root, selector: string) => {
      let value = "";
      css.walkRules(selector, rule => { rule.walkDecls("font-family", declaration => { value = declaration.value; }); });
      return value;
    };
    expect(family(base, ".cmux-dashboard-markdown-code")).toBe("var(--cmux-dash-body-font)");
    expect(family(surface, ".cmux-dashboard-view .cmux-dashboard-markdown-code")).toBe("var(--cmux-font-mono)");
    expect(code.style.fontFamily).toBe("");
    expect(code.className).toBe("");
    // jsdom does not compute custom-property font values. Pin the real CSS cascade
    // and the real component's lack of a competing declaration instead.
    const rules = Array.from(fontStyle.sheet!.cssRules).filter((rule): rule is CSSStyleRule => "selectorText" in rule);
    const mono = rules.find((rule) => rule.selectorText === ":where([data-cmux-themed-root]) :where(code, pre, kbd, samp)")!;
    const nested = rules.find((rule) => rule.selectorText === ":where([data-cmux-themed-root], [data-cmux-app-font-scope]) :where(pre code)")!;
    expect(mono.style.getPropertyValue("font-family")).toBe("var(--cmux-font-mono)");
    expect(nested.style.getPropertyValue("font-family")).toBe("inherit");
    expect(code.matches(mono.selectorText)).toBe(true);
    expect(code.matches(nested.selectorText)).toBe(true);
    expect(rules.indexOf(nested)).toBeGreaterThan(rules.indexOf(mono));
  });

  it("renders a table inside its own horizontal-scroll container", async () => {
    const text = "| 対象 | **本数** | `実測` |\n|:---|:--:|---:|\n| [資料](https://example.test) | 12 | 3.5 |";
    expect(parseMarkdown(text)[0]?.type).toBe("table");
    await render(<MarkdownView text={text} />);

    const scroll = container.querySelector<HTMLElement>(".cmux-dashboard-markdown-table-scroll");
    const table = scroll?.querySelector("table");
    expect(scroll?.getAttribute("aria-label")).toBe("表");
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

  it("applies the selected font to UI chrome and conversation content while preserving Markdown reader typography", async () => {
    await render(<DashboardFontScope />);
    const scope = container.querySelector<HTMLElement>("[data-dashboard-font-scope='true']")!;
    expect(scope.style.getPropertyValue("--cmux-dash-font-size")).toBe("14px");
    const previousUiFont = scope.style.getPropertyValue("--cmux-font-ui");

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
    const uiFont = scope.style.getPropertyValue("--cmux-font-ui");
    expect(uiFont).not.toBe(previousUiFont);
    expect(uiFont).toMatch(/^'BIZ UDGothic', /);
    expect(scope.style.getPropertyValue("--cmux-dash-ui-font")).toBe(uiFont);
    expect(scope.style.getPropertyValue("--cmux-font-mono")).toMatch(/^'BIZ UDGothic', /);

    const css = readFileSync("src/components/dashboard/DashboardView.css", "utf8")
      + readFileSync("src/components/dashboard/MarkdownView.css", "utf8");
    const globalCss = readFileSync("src/global.css", "utf8").replaceAll("\r\n", "\n");
    const markdown = readFileSync("src/components/dashboard/MarkdownView.tsx", "utf8");
    const terminalTail = readFileSync("src/components/dashboard/DashboardTerminalTab.tsx", "utf8");
    expect(css).toContain(".cmux-dashboard-view {");
    expect(css).toContain("font-family: var(--cmux-dash-ui-font);");
    expect(css).toContain(".cmux-dashboard-msg { display: grid; min-width: 0; max-width: 84%; gap: 4px; border-radius: 10px; padding: 9px 13px; font-family: var(--cmux-dash-body-font);");
    expect(css).toContain("font-family: var(--cmux-dash-body-font); font-size: var(--cmux-dash-font-size); line-height: var(--cmux-dash-line-height);");
    expect(css).toContain(".cmux-dashboard-markdown-table th, .cmux-dashboard-markdown-table td { border-right: 1px solid var(--cmux-border-hairline); border-bottom: 1px solid var(--cmux-border-hairline); padding: 6px 9px; vertical-align: top; text-align: left; white-space: normal; overflow-wrap: anywhere; font-family: var(--cmux-dash-body-font);");
    // The fixed stacks remain the fallback; themed roots prefer the setting.
    expect(globalCss).toContain(
      '--cmux-font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", Meiryo, Roboto, sans-serif;',
    );
    expect(globalCss).toContain("--cmux-dash-ui-font: var(--cmux-font-ui);");
    expect(globalCss).toContain("font-family: var(--cmux-dash-ui-font);");
    expect(globalCss).toContain("[data-cmux-themed-root] {\n  font-family: var(--cmux-font-ui);\n}");
    expect(markdown).toContain('className="cmux-dashboard-markdown-code"');
    expect(markdown).not.toContain("style={");
    const surface = readFileSync("src/components/dashboard/DashboardChatSurface.css", "utf8");
    expect(surface).toContain("font-size: var(--cmux-read-font-size)");
    expect(scope.style.getPropertyValue("--cmux-read-font-size")).toBe("13px");
    expect(scope.style.getPropertyValue("--cmux-read-line-height")).toBe("1.7");
    expect(terminalTail).toContain('fontFamily: "var(--cmux-dash-body-font)"');
    const previewCss = readFileSync("src-tauri/src/commands/artifact/markdown_preview.css", "utf8").replaceAll("\r\n", "\n");
    expect(previewCss).toContain('--md-font: "Segoe UI Variable Text", "Segoe UI", "BIZ UDPGothic", "Hiragino Sans",\n    "Hiragino Kaku Gothic ProN", "Yu Gothic UI", Meiryo, system-ui, sans-serif;');
    expect(previewCss).toContain("font-family: var(--md-font);");
  });
});

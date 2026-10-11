// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThemeVars } from "../../src/components/layout/themeVars";
import { ThemeFontSettings } from "../../src/components/theme/ThemeFontSettings";
import { THEMES } from "../../src/components/theme/themeDefinitions";
import { PaneTabRenameEditor } from "../../src/components/workspace/PaneTabRenameEditor";
import { UI_FONT_FALLBACK, MONO_FONT_FALLBACK, fontStackWithFallback, resetFontAvailabilityCache } from "../../src/lib/fontAvailability";
import { DEFAULT_THEME_BACKGROUND } from "../../src/lib/themeBackgrounds";
import { DEFAULT_TERMINAL_FONT_FAMILY, TERMINAL_FONT_PRESETS, useThemeStore } from "../../src/stores/themeStore";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const globalCss = read("src/global.css");
const rootCss = globalCss.match(/:root\s*\{([\s\S]*?)\n\}/)![1];

// Expected output is independent of the stack builder, including generic order.
const UI_SUFFIX = '"Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Roboto", -apple-system, BlinkMacSystemFont, sans-serif';
const MONO_SUFFIX = '"UDEV Gothic NF", "UDEV Gothic", "SFMono-Regular", "JetBrains Mono", "Consolas", ui-monospace, monospace';
const fontCases = [
  {
    name: "bundled default",
    setting: DEFAULT_TERMINAL_FONT_FAMILY,
    prefix: "'UDEV Gothic NF', 'BIZ UDGothic', 'MS Gothic', ",
  },
  {
    name: "Mincho preset",
    setting: TERMINAL_FONT_PRESETS.find((preset) => preset.id === "biz-udmincho")!.value,
    prefix: "'BIZ UDMincho', 'BIZ UDPMincho', 'Yu Mincho', 'MS Mincho', 'BIZ UDGothic', ",
  },
  {
    name: "quoted name with spaces and punctuation",
    setting: '"Fixture Font (Alt)+", monospace',
    prefix: '"Fixture Font (Alt)+", ',
  },
  {
    name: "generic-only setting",
    setting: "serif, monospace, system-ui, sans-serif",
    prefix: "",
  },
];

describe("font unification contract", () => {
  it.each(fontCases)("F1: derives all four font routes for $name", ({ setting, prefix }) => {
    const vars = buildThemeVars({
      theme: THEMES[0], background: DEFAULT_THEME_BACKGROUND, uiDensity: "standard",
      fontFamily: setting, fontSize: 14, lineHeight: 1.35, uiFontScale: 1,
    }) as Record<string, string>;
    expect(vars["--cmux-font-ui"]).toBe(prefix + UI_SUFFIX);
    expect(vars["--cmux-dash-ui-font"]).toBe(vars["--cmux-font-ui"]);
    expect(vars["--cmux-font-mono"]).toBe(prefix + MONO_SUFFIX);
    expect(vars["--cmux-dash-body-font"]).toBe(setting);
  });

  it("F2: keeps both canonical fallback constants byte-identical to :root", () => {
    expect(UI_FONT_FALLBACK).toBe(rootCss.match(/--cmux-font-ui:\s*([^;]+);/)![1]);
    expect(MONO_FONT_FALLBACK).toBe(rootCss.match(/--cmux-font-mono:\s*([^;]+);/)![1]);
  });

  it.each([
    { name: "UI", fallback: UI_FONT_FALLBACK, suffix: UI_SUFFIX, generics: ["-apple-system", "BlinkMacSystemFont", "sans-serif"] },
    { name: "mono", fallback: MONO_FONT_FALLBACK, suffix: MONO_SUFFIX, generics: ["ui-monospace", "monospace"] },
  ])("F2: leaves generics only after every named $name fallback", ({ fallback, suffix, generics }) => {
    const stack = fontStackWithFallback('serif, "Missing Font", monospace, "Second Font", sans-serif', fallback);
    expect(stack).toBe('"Missing Font", "Second Font", ' + suffix);
    const parts = stack.split(", ");
    expect(parts.slice(-generics.length)).toEqual(generics);
    expect(parts.slice(0, -generics.length).every((part) => part.startsWith('"') && part.endsWith('"'))).toBe(true);
  });

  it.each([
    '"Fixture, Font", monospace',
    '"Fixture \\"Quoted\\" Font", serif',
    "'Fixture \\'Quoted\\' Font', sans-serif",
    '"O\'Brien Font", monospace',
  ])("F2: preserves the CSS spelling of a quoted custom family in %s", (setting) => {
    const family = setting.slice(0, setting.lastIndexOf(","));
    expect(fontStackWithFallback(setting, UI_FONT_FALLBACK)).toBe(`${family}, ${UI_SUFFIX}`);
    expect(fontStackWithFallback(setting, MONO_FONT_FALLBACK)).toBe(`${family}, ${MONO_SUFFIX}`);
  });

  it("F3: resets inherited typography on the themed root", () => {
    expect(globalCss).toMatch(/\[data-cmux-themed-root\]\s*\{\s*font-family:\s*var\(--cmux-font-ui\);\s*\}/);
  });

  it("F9: lets all form controls inherit with zero specificity and no importance", () => {
    const rules = [...globalCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((rule) => rule[1].includes("data-cmux-themed-root") && /\bbutton\b/.test(rule[1]));
    expect(rules).toHaveLength(1);
    // Both selector arguments must stay inside :where(); nothing outside adds specificity.
    expect(rules[0][1].trim()).toBe(":where([data-cmux-themed-root]) :where(button, input, select, textarea)");
    expect(rules[0][2].trim()).toBe("font-family: inherit;");
  });

  it.each([
    { file: "src/components/CommandPalette/CrsmPalette.css", selector: ".cmux-crsm-cwd-chip", family: "var(--cmux-font-mono)" },
    { file: "src/components/dashboard/DashboardView.css", selector: ".cmux-dashboard-composer-input", family: "var(--cmux-dash-ui-font)" },
  ])("F9: preserves the explicit class font on $selector", ({ file, selector, family }) => {
    const rules = [...read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const rule = rules.find((candidate) => candidate[1].trim() === selector)!;
    // One class has specificity (0, 1, 0), above the inheritance rule's (0, 0, 0).
    expect(rule[1].trim()).toMatch(/^\.[a-z-]+$/);
    expect(rule[2]).toContain(`font-family: ${family};`);
  });

  it("R2: overrides semantic monospace fonts at zero specificity and lets nested code inherit pre", () => {
    const rules = [...globalCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const mono = rules.filter((rule) => rule[1].includes("data-cmux-themed-root") && rule[1].includes("kbd"));
    expect(mono).toHaveLength(1);
    expect(mono[0][1].trim()).toBe(":where([data-cmux-themed-root]) :where(code, pre, kbd, samp)");
    expect(mono[0][2].trim()).toBe("font-family: var(--cmux-font-mono);");
    const nested = rules.filter((rule) => rule[1].includes("pre code"));
    expect(nested).toHaveLength(1);
    expect(nested[0][1].trim()).toBe(":where([data-cmux-themed-root], [data-cmux-app-font-scope]) :where(pre code)");
    expect(nested[0][2].trim()).toBe("font-family: inherit;");
    expect(rules.indexOf(nested[0])).toBeGreaterThan(rules.indexOf(mono[0]));
  });

  it.each(["AppShell", "DetachedPaneShell", "NativePaneShell"])(
    "F3: %s publishes theme variables without changing the fixed-position containing block",
    (name) => {
      const source = read(`src/components/layout/${name}.tsx`);
      expect(source).toContain('data-cmux-themed-root="true"');
      expect(source).toContain("buildThemeVars(");
      const themedStyle = source.split('data-cmux-themed-root="true"')[1].match(/style=\{\{([\s\S]*?)\}\}/)![1];
      expect(themedStyle).toContain("...themeVars");
      expect(themedStyle).not.toMatch(/\b(?:transform|translate|rotate|scale|filter|backdropFilter|perspective|contain|containerType|contentVisibility|willChange)\s*:/);
    },
  );

  it("F6: describes UDEV without restricting it to terminal use", () => {
    expect(TERMINAL_FONT_PRESETS.find((preset) => preset.id === "udev-gothic")!.description)
      .toBe("日本語=BIZ UDゴシック、英数字=JetBrains Mono");
  });

  it("F6: decodes the font-repair notification with the approved wording", () => {
    const source = ts.createSourceFile("SocketListener.tsx", read("src/components/layout/SocketListener.tsx"),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const messages: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "pushToast" && node.arguments[0]
        && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith("保存されていた")) {
        messages.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(messages).toEqual([
      "保存されていたフォントがこの環境で正しく表示できないため、同梱フォントに切り替えました (設定 → 外観 で変更できます)",
    ]);
  });
});

describe("font unification DOM contract", () => {
  let container: HTMLDivElement;
  let root: Root;
  const savedTheme = useThemeStore.getState();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    resetFontAvailabilityCache();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    useThemeStore.setState(savedTheme);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetFontAvailabilityCache();
  });

  function themedRoot(kind: string): HTMLDivElement {
    const element = document.createElement("div");
    element.dataset.cmuxThemedRoot = "true";
    element.setAttribute(`data-${kind}-pane-shell`, "true");
    element.style.fontFamily = '"Local Fixture Font", serif';
    element.style.setProperty("--cmux-font-ui", '"Local Fixture Font", serif');
    document.body.append(element);
    return element;
  }

  function renderRename() {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    act(() => root.render(createElement(PaneTabRenameEditor, {
      label: "名前", value: "Fixture pane", anchor: new DOMRect(40, 50, 100, 20),
      onChange: vi.fn(), onSave, onCancel,
    })));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    return { dialog, onSave, onCancel };
  }

  it.each(["main", "detached", "native"])(
    "F4: prefers the caller's %s themed root and preserves viewport positioning",
    (kind) => {
      const unrelated = themedRoot("other");
      const owner = themedRoot(kind);
      const nested = document.createElement("section");
      owner.append(nested);
      nested.append(container);
      const { dialog } = renderRename();
      expect(document.querySelector("[data-cmux-themed-root]")).toBe(unrelated);
      expect(dialog.parentElement).toBe(owner);
      expect(dialog.parentElement).not.toBe(document.body);
      expect(getComputedStyle(dialog).fontFamily).toBe(owner.style.fontFamily);
      expect(getComputedStyle(dialog).getPropertyValue("--cmux-font-ui")).toBe(owner.style.getPropertyValue("--cmux-font-ui"));
      expect(getComputedStyle(dialog).position).toBe("fixed");
      expect(dialog.style.left).toBe("40px");
      expect(dialog.style.top).toBe("70px");
    },
  );

  it("F4: uses the document's themed root when the caller is outside one", () => {
    const owner = themedRoot("detached");
    expect(renderRename().dialog.parentElement).toBe(owner);
  });

  it("F4: falls back to body when there is no themed root", () => {
    expect(renderRename().dialog.parentElement).toBe(document.body);
  });

  it("F4: retains focus, selection, save, and cancel after mounting the portal", () => {
    themedRoot("main").append(container);
    const { dialog, onSave, onCancel } = renderRename();
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSave).toHaveBeenCalledTimes(1);
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    DEFAULT_TERMINAL_FONT_FAMILY,
    TERMINAL_FONT_PRESETS.find((preset) => preset.id === "biz-udmincho")!.value,
    '"Custom Fixture Font", monospace',
  ])("F5: keeps every candidate specimen on its own font with selection %s", (fontFamily) => {
    const owner = themedRoot("main");
    const vars = buildThemeVars({
      theme: THEMES[0], background: DEFAULT_THEME_BACKGROUND, uiDensity: "standard",
      fontFamily, fontSize: 14, lineHeight: 1.35, uiFontScale: 1,
    }) as Record<string, string>;
    for (const [name, value] of Object.entries(vars)) {
      if (name.startsWith("--")) owner.style.setProperty(name, value);
    }
    owner.append(container);
    act(() => root.render(createElement(ThemeFontSettings, {
      mode: "presets", fontFamily, fontSize: 14, lineHeight: 1.35,
      setFontFamily: vi.fn(), setFontSize: vi.fn(), setLineHeight: vi.fn(),
    })));
    // The saved macOS-system preset is retained in the store but is not a card.
    const values = ["jetbrains-ja", "hackgen-console", "udev-gothic", "udev-gothic-35",
      "cascadia-biz", "consolas-meiryo", "biz-readable", "ms-gothic", "ud-kyokasho", "biz-udmincho"]
      .map((id) => TERMINAL_FONT_PRESETS.find((preset) => preset.id === id)!.value);
    if (!values.includes(fontFamily)) values.unshift(fontFamily);
    const expected = values.map((value) => {
      const specimen = document.createElement("div");
      specimen.style.fontFamily = value;
      return specimen.style.fontFamily;
    });
    const specimens = [...container.querySelectorAll<HTMLElement>("div[style]")]
      .filter((element) => element.style.fontFamily);
    expect(specimens).toHaveLength(expected.length);
    expect(specimens.map((element) => element.style.fontFamily)).toEqual(expected);
    expect(specimens.every((element) => element.textContent?.includes("国鬱ぎゅアガパ"))).toBe(true);
  });

  it.each([
    { fontSize: 14, lineHeight: 1.35, lineLabel: "1.35" },
    { fontSize: 20, lineHeight: 1.6, lineLabel: "1.60" },
  ])("F6: renders the approved settings copy at $fontSize px / $lineLabel", ({ fontSize, lineHeight, lineLabel }) => {
    act(() => root.render(createElement(ThemeFontSettings, {
      fontSize, lineHeight, fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      setFontFamily: vi.fn(), setFontSize: vi.fn(), setLineHeight: vi.fn(),
    })));
    const labels = [...container.querySelectorAll("div")].map((element) => element.textContent);
    expect(labels).toContain("フォント");
    expect(labels).toContain("アプリの文字すべて (端末・会話・サイドバー・メニュー) に使います。3 分類から選べます");
    expect(labels).toContain(`端末と会話の文字の大きさ: ${fontSize}px`);
    expect(labels).toContain(`端末と会話の行間: ${lineLabel}`);
  });
});

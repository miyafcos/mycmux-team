// @vitest-environment jsdom
// N9 plan 1 ("same place, smaller"): the reply area and the column header controls shrink in height only.
// These are contracts on the shipped CSS and component source, because jsdom does not load the CSS.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UI_DENSITY_TOKENS } from "../../src/stores/themeStore";

const dashboard = (name: string) => readFileSync(join(__dirname, "../../src/components/dashboard", name), "utf8").replace(/\r\n/g, "\n");
const selectorList = (text: string) => {
  let depth = 0, start = 0;
  const result: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if ("([".includes(text[i]!)) depth++;
    if (")]".includes(text[i]!)) depth--;
    if (text[i] === "," && depth === 0) { result.push(text.slice(start, i).trim()); start = i + 1; }
  }
  result.push(text.slice(start).trim());
  return result;
};
const rules = (text: string) => [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap(rule => selectorList(rule[1]!).map(selector => ({ selector, body: rule[2]! })));

const css = dashboard("DashboardA.css");
const marker = "/* N9 plan 1 (2026-11-06)";
const block = css.slice(css.indexOf(marker));
const plan = rules(block);
const one = (selector: string) => {
  const found = plan.filter(rule => rule.selector === selector);
  expect(found, selector).toHaveLength(1);
  return found[0]!.body;
};
const V = ".cmux-dashboard-view ";

// Resolve the shipped spacing expressions against the same rounded density ladder as AppShell.
const globalCss = readFileSync(join(__dirname, "../../src/global.css"), "utf8");
const metric = (body: string, property: string, density: keyof typeof UI_DENSITY_TOKENS = "standard") => {
  const value = body.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`))?.[1];
  expect(value, property).toBeDefined();
  const expression = value!.replace(/var\((--cmux-space-\d+)\)/g, (_match, token: string) => {
    const base = globalCss.match(new RegExp(`${token}:\\s*([0-9.]+)px;`))?.[1];
    expect(base, token).toBeDefined();
    return String(Math.round(Number(base) * UI_DENSITY_TOKENS[density].spaceScale));
  }).replace(/^calc\((.*)\)$/, "$1").replace(/px/g, "");
  expect(expression).toMatch(/^[\d.\s+*()/\-]+$/);
  return Function(`"use strict"; return (${expression});`)() as number;
};


describe("N9 plan 1 shipped CSS", () => {
  it("has the plan block at the end of the last-loaded dashboard stylesheet", () => {
    expect(css.indexOf(marker)).toBeGreaterThan(0);
    expect(plan.length).toBeGreaterThan(20);
  });

  it("shrinks the three header controls to 24px while keeping the 12px text and the thin frame", () => {
    const body = one(`${V}.cmux-dashboard-chat-actions .cmux-dashboard-chat-header-btn`);
    expect(metric(body, "min-height")).toBe(24);
    expect(metric(body, "height")).toBe(24);
    expect(body).toMatch(/font-size:\s*var\(--cmux-font-size-sm\)/);
    expect(body).toMatch(/border-color:\s*var\(--cmux-border-hairline\)/);
    expect(body).not.toMatch(/border:\s*0/);
    expect(metric(one(`${V}.cmux-dashboard-chat-header`), "min-height")).toBe(40);
  });

  it("leaves input and send styling to the shared composer rather than N9 or the chat surface", () => {
    for (const source of [block, dashboard("DashboardChatSurface.css")]) {
      for (const rule of rules(source)) {
        expect(rule.selector).not.toMatch(/\.cmux-dashboard-composer-(?:input|send)\b/);
      }
    }
  });


  it("scales every 24/28/40px control with density while preserving standard dimensions (DB-R-010)", () => {
    const controls = [
      [".cmux-dashboard-chat-header", ["min-height"], 40],
      [".cmux-dashboard-chat-actions .cmux-dashboard-chat-header-btn", ["min-height", "height", "min-width"], 24],
      [".cmux-dashboard-next-actions.is-balanced", ["min-height"], 24],
      ['.cmux-dashboard-next-actions.is-balanced[data-next-action-status="ready"]', ["min-height"], 28],
      [".cmux-dashboard-next-actions.is-balanced button", ["min-height", "height"], 24],
      [".cmux-dashboard-next-actions.is-balanced .cmux-dashboard-next-actions-list", ["min-height"], 28],
      [".cmux-dashboard-next-actions-more-panel button", ["min-height", "height"], 24],
      [".cmux-dashboard-next-actions-more-panel .cmux-dashboard-next-actions-retry", ["min-height", "height"], 24],
      [".cmux-dashboard-qcard:not(.is-compact) .cmux-dashboard-qcard-option", ["min-height"], 28],
    ] as const;
    for (const [selector, properties, standard] of controls) {
      const body = one(V + selector);
      for (const property of properties) {
        expect(metric(body, property), `${selector}: ${property}`).toBe(standard);
        expect(metric(body, property, "relaxed"), `${selector}: ${property}`).toBeGreaterThan(standard);
        expect(metric(body, property, "compact"), `${selector}: ${property}`).toBeLessThan(standard);
      }
    }
  });

  it("makes the destination line one 16px line", () => {
    const body = one(`${V}.cmux-dashboard-composer-target`);
    expect(body).toMatch(/line-height:\s*16px/);
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/padding-bottom:\s*0/);
  });

  it("makes the next-action row 24px before reading and 28px once read, with 24px buttons", () => {
    expect(metric(one(`${V}.cmux-dashboard-next-actions.is-balanced`), "min-height")).toBe(24);
    expect(metric(one(`${V}.cmux-dashboard-next-actions.is-balanced[data-next-action-status="ready"]`), "min-height")).toBe(28);
    const buttons = one(`${V}.cmux-dashboard-next-actions.is-balanced button`);
    expect(metric(buttons, "min-height")).toBe(24);
    expect(buttons).toMatch(/font-size:\s*var\(--cmux-font-size-sm\)/);
    // The send-confirmation buttons keep the normal control size.
    expect(one(`${V}.cmux-dashboard-next-actions.is-balanced .cmux-dashboard-next-action-confirm button`)).toContain("var(--cmux-dashboard-control-size)");
  });

  it("places the more panel outside the composer's overflow: fixed, capped in width and height, scrolling inside", () => {
    const panel = one(`${V}.cmux-dashboard-next-actions-more-panel`);
    expect(panel).toMatch(/position:\s*fixed/);
    expect(panel).toMatch(/max-width:\s*min\(420px, 100%\)/);
    expect(panel).toMatch(/max-height:\s*60vh/);
    expect(panel).toMatch(/overflow-y:\s*auto/);
    expect(panel).toContain("var(--cmux-popover)");
    // The anchor is the row, not the "more" button: nothing between them is positioned.
    expect(one(`${V}.cmux-dashboard-next-actions-more`)).not.toMatch(/position:/);
    // Panel buttons keep the 24px size even though the panel is no longer inside the section.
    expect(metric(one(`${V}.cmux-dashboard-next-actions-more-panel button`), "height")).toBe(24);
    // The retry button inside the panel must not lose to the 32px rule at specificity (0,3,0).
    const retry = one(`${V}.cmux-dashboard-next-actions-more-panel .cmux-dashboard-next-actions-retry`);
    expect(metric(retry, "min-height")).toBe(24);
    expect(metric(retry, "height")).toBe(24);
  });

  it("keeps the composer's own scroll container (and its scrollbar gutter) as before", () => {
    const surface = rules(dashboard("DashboardChatSurface.css"));
    const composer = surface.filter(rule => rule.selector.endsWith("> .cmux-dashboard-composer") && rule.selector.includes('data-visible-columns="1"'));
    expect(composer).toHaveLength(1);
    expect(composer[0]!.body).toMatch(/overflow-y:\s*auto/);
    expect(composer[0]!.body).toMatch(/scrollbar-gutter:\s*stable both-edges/);
    expect(composer[0]!.body).not.toMatch(/overflow:\s*visible/);
  });

  it("loads the CSS in the order View, ChatSurface, A so the plan 1 block wins", () => {
    const source = dashboard("DashboardView.tsx");
    const view = source.indexOf('import "./DashboardView.css";');
    const surface = source.indexOf('import "./DashboardChatSurface.css";');
    const a = source.indexOf('import "./DashboardA.css";');
    expect(view).toBeGreaterThan(-1);
    expect(surface).toBeGreaterThan(view);
    expect(a).toBeGreaterThan(surface);
  });

  it("puts 8px between the first suggestion and the more button", () => {
    expect(one(`${V}.cmux-dashboard-next-actions.is-balanced .cmux-dashboard-next-actions-list`)).toMatch(/gap:\s*var\(--cmux-space-4\)/);
  });

  it("tightens only the full question card, never the compact one", () => {
    const selectors = plan.map(rule => rule.selector).filter(selector => selector.includes("qcard"));
    expect(selectors.length).toBeGreaterThanOrEqual(4);
    for (const selector of selectors) expect(selector).toContain(":not(.is-compact)");
    expect(metric(one(`${V}.cmux-dashboard-qcard:not(.is-compact) .cmux-dashboard-qcard-option`), "min-height")).toBe(28);
  });

  it("uses only existing tokens: no colour literals, and every font size is a token", () => {
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/\brgba?\(|\bhsla?\(/);
    for (const match of block.matchAll(/font-size:\s*([^;}]+)/g)) expect(match[1]!.trim()).toMatch(/^var\(--cmux-font-size-(xs|sm|md)\)$/);
  });

  it("does not touch the narrow-container gutters: header and composer set padding per axis", () => {
    expect(one(`${V}.cmux-dashboard-chat-header`)).toContain("padding-block");
    expect(one(`${V}.cmux-dashboard-chat-header`)).not.toMatch(/padding:|padding-inline/);
    expect(one(`${V}.cmux-dashboard-composer`)).toContain("padding-block");
    expect(one(`${V}.cmux-dashboard-composer`)).not.toMatch(/padding:|padding-inline/);
  });
});

describe("N9 plan 1 component source", () => {
  it("marks the history, more and pin controls of the column header", () => {
    const source = dashboard("ChatColumn.tsx");
    expect(source).toContain('<summary className="cmux-dashboard-chat-header-btn">履歴</summary>');
    expect(source).toMatch(/<summary className="cmux-dashboard-chat-header-btn" aria-label="その他" title="その他">/);
    expect(source).toMatch(/data-dashboard-chat-column-pin=\{card\.tab\.id\} className="cmux-dashboard-chat-header-action cmux-dashboard-chat-header-btn"/);
    expect(source.match(/cmux-dashboard-chat-header-btn/g)).toHaveLength(3);
  });

  it("keeps the new wording in dashboardStrings", () => {
    const strings = dashboard("dashboardStrings.ts");
    expect(strings).toContain('nextActionNotRequested: "提案はまだありません"');
    expect(strings).toContain('nextActionWaitSettle: "返答が終わると読めます"');
    expect(strings).toContain('nextActionMoreDetail: "詳細"');
    for (const key of ["nextActionNotRequested", "nextActionWaitSettle", "nextActionMoreCount", "nextActionMoreDetail", "nextActionMorePanelLabel"]) expect(strings).toContain(`${key}:`);
  });
});

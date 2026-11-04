// @vitest-environment jsdom
import { act } from "react";
import { DetachedDashboardSurface } from "../../src/components/dashboard/DetachedDashboardSurface";
import { createRoot, type Root } from "react-dom/client";
import { ArrowLeft } from "lucide-react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardPanelWidths, useDashboardViewStore,
  DASHBOARD_MINIMAP_STORAGE_KEY,
} from "../../src/stores/dashboardViewStore";
import { dashboardMenuKeys } from "../../src/components/dashboard/dashboardMenuKeys";
import { DashboardGlyph, DashboardIconButton, DashboardStatusMark } from "../../src/components/dashboard/DashboardUi";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const source = (name: string) => readFileSync(join(__dirname, "../../src", name), "utf8");
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe("shared dashboard option A", () => {
  it("keeps three columns at narrow widths without detached-only vertical stacking", () => {
    const vertical: string[] = [];
    const scan = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { scan(path); continue; }
        if (!entry.name.endsWith(".css")) continue;
        const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          const targetsShell = rule[1].split(",").some(selector => /\.cmux-dashboard-shell(?:[.#:[\w-][^ >+~]*)?$/.test(selector.trim()));
          if (targetsShell && /(?:flex-direction\s*:\s*column(?:-reverse)?|flex-flow\s*:[^;]*\bcolumn\b|display\s*:\s*(?:block|grid))/.test(rule[2])) vertical.push(path + ":" + rule[1].trim());
        }
      }
    };
    scan(join(__dirname, "../../src"));
    expect(vertical).toEqual([]);
    expect(source("components/dashboard/DashboardA.css")).toMatch(/\.cmux-dashboard-shell\s*\{\s*flex-direction:\s*row;/);
  });

  it("uses 208/534/208 at 958 and preserves 256/600/336 at 1200", () => {
    expect(dashboardPanelWidths(958, 336)).toEqual({ sessionListWidth: 208, chatWidth: 534, minimapWidth: 208, compact: true });
    expect(dashboardPanelWidths(1200, 336)).toEqual({ sessionListWidth: 256, chatWidth: 600, minimapWidth: 336, compact: false });
    expect(dashboardPanelWidths(1120, 336).compact).toBe(false);
    expect(dashboardPanelWidths(1119, 336).compact).toBe(true);
  });

  it("derives compact widths without overwriting a saved splitter preference", () => {
    useDashboardViewStore.setState({ minimapWidth: 480 });
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(dashboardPanelWidths(958, useDashboardViewStore.getState().minimapWidth).minimapWidth).toBe(208);
    expect(dashboardPanelWidths(1600, useDashboardViewStore.getState().minimapWidth).minimapWidth).toBe(480);
    expect(useDashboardViewStore.getState().minimapWidth).toBe(480);
    expect(write).not.toHaveBeenCalled();
  });

  it("retains saved width when the store is first opened in a narrow window", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 958 });
    localStorage.setItem(DASHBOARD_MINIMAP_STORAGE_KEY, "480");
    vi.resetModules();
    const fresh = await import("../../src/stores/dashboardViewStore");
    expect(fresh.useDashboardViewStore.getState().minimapWidth).toBe(480);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    localStorage.removeItem(DASHBOARD_MINIMAP_STORAGE_KEY);
  });

  it("keeps a collapsed list collapsed while making room for reading", () => {
    expect(dashboardPanelWidths(958, 600, true)).toEqual({ sessionListWidth: 32, chatWidth: 710, minimapWidth: 208, compact: true });
  });

  it("keeps the legacy terminal focus ring inside the clipped host with a scoped child selector", async()=>{
    const css=source("components/dashboard/DetachedDashboardSurface.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(rule=>rule[1].includes('[role="group"]')&&rule[1].includes('[data-session-id]')&&rule[1].includes(':focus-visible'));
    expect(rules).toHaveLength(2);
    const base=rules.find(rule=>rule[1].trim().endsWith(':focus-visible'))!;
    const overlay=rules.find(rule=>rule[1].trim().endsWith(':focus-visible::after'))!;
    expect(base).toBeDefined();expect(overlay).toBeDefined();
    const [selector,declarations]=[base[1].trim(),base[2]];
    expect(selector).toMatch(/^\.cmux-detached-dashboard-host\s*>\s*\[data-detached-terminal\]\s*>\s*\[role="group"\]\[data-session-id\]:focus-visible$/);
    expect(declarations).toMatch(/outline-offset\s*:\s*-2px\s*!important/);
    expect(overlay[1].trim()).toBe(selector+'::after');
    for(const declaration of [/content\s*:\s*""\s*;/,/position\s*:\s*absolute\s*;/,/inset\s*:\s*0\s*;/,/border\s*:\s*2px\s+solid\s+var\(--cmux-accent\)\s*;/,/pointer-events\s*:\s*none\s*;/,/z-index\s*:\s*1\s*;/])expect(overlay[2]).toMatch(declaration);
    await act(async()=>root.render(<DetachedDashboardSurface><div role="group" data-session-id="fictional-focus" tabIndex={0}><div role="group" data-session-id="fictional-inner" tabIndex={0}/></div></DetachedDashboardSurface>));
    const outer=host.querySelector('[data-session-id="fictional-focus"]')!;
    const dashboard=document.createElement("div");dashboard.className="cmux-dashboard-view";
    dashboard.innerHTML='<div role="group" data-session-id="fictional-dashboard" tabindex="0"></div>';
    host.querySelector('.cmux-detached-dashboard-host')!.append(dashboard);
    for(const rule of [base,overlay]){
      const target=rule[1].trim().replace(':focus-visible','').replace('::after','');
      expect(outer.matches(target)).toBe(true);
      expect(dashboard.firstElementChild!.matches(target)).toBe(false);
      expect(host.querySelectorAll(target)).toHaveLength(1);
    }
  });

  it("gives every literal icon button in the affected surfaces an accessible name", () => {
    const dashboard = join(__dirname, "../../src/components/dashboard");
    const files = readdirSync(dashboard).filter(name => name.endsWith(".tsx")).map(name => join(dashboard, name));
    files.push(...["NativePaneShell.tsx", "DetachedPaneShell.tsx", "WindowControls.tsx", "TabGroupingPanel.tsx", "TabSweepPanel.tsx"]
      .map(name => join(__dirname, "../../src/components/layout", name)));
    const unnamed: string[] = [];
    function readable(node: ts.Node): boolean {
      if (ts.isJsxText(node)) return !!node.text.trim();
      if (ts.isJsxExpression(node)) return !!node.expression && readable(node.expression);
      if (ts.isConditionalExpression(node)) return readable(node.whenTrue) && readable(node.whenFalse);
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) return readable(node.left) && readable(node.right);
      if (ts.isJsxFragment(node)) return node.children.some(readable);
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return !!node.text.trim() && !/^[×✕✖↗▲▼▸▾]+$/.test(node.text.trim());
      if (ts.isIdentifier(node) || ts.isTemplateExpression(node) || ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) return true;
      if (ts.isJsxElement(node) && /^[a-z]/.test(node.openingElement.tagName.getText()) && node.openingElement.tagName.getText() !== "svg") return node.children.some(readable);
      return false;
    }
    for (const file of files) {
      const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
        if (opening && ["button", "summary"].includes(opening.tagName.getText())) {
          const named = (name: string) => opening.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText() === name && !!attr.initializer && (!ts.isStringLiteral(attr.initializer) || !!attr.initializer.text.trim()));
          const visible = ts.isJsxElement(node) && node.children.some(readable);
          if (!visible && !(named("aria-label") && named("title"))) unnamed.push(file + ":" + (tree.getLineAndCharacterOfPosition(node.pos).line + 1));
        }
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "DashboardIconButton"
          && !node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText() === "label")) unnamed.push(file + ":missing label");
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(unnamed).toEqual([]);
  });

  it("renders named actions and noninteractive, unframed state indicators with visible state words", async () => {
    await act(async () => root.render(<div className="cmux-dashboard-view">
      <DashboardIconButton icon={ArrowLeft} label="Return to terminal" />
      <DashboardStatusMark state="done" label="Completed" />
      <DashboardGlyph icon={ArrowLeft} label="Selection" />
    </div>));
    const button = host.querySelector("button")!;
    expect(button.title).toBe("Return to terminal");
    expect(button.getAttribute("aria-label")).toBe("Return to terminal");
    const mark = host.querySelector("[data-dashboard-status]")!;
    expect(mark.textContent).toBe("Completed");
    expect(mark.tagName).toBe("SPAN");
    expect(mark.hasAttribute("tabindex")).toBe(false);
    expect(mark.closest("button")).toBeNull();
    const css = source("components/dashboard/DashboardA.css");
    expect(css).toMatch(/:is\(\.cmux-dashboard-glyph, \.cmux-dashboard-status-mark, \.cmux-dashboard-count\)\s*\{\s*border:\s*0;[^}]*cursor:\s*default;/);
    expect(css).not.toMatch(/(?:glyph|status-mark|count):hover/);
  });

  it("opens and selects named menu actions with the keyboard and closes with Escape", async () => {
    const select = vi.fn();
    await act(async () => root.render(<details onKeyDown={dashboardMenuKeys}>
      <summary>History</summary><button onClick={select}>First</button><button disabled>Unavailable</button><button>Latest</button>
    </details>));
    const menu = host.querySelector("details")!;
    const summary = host.querySelector("summary")!;
    const buttons = host.querySelectorAll("button");
    summary.focus();
    await act(async () => summary.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(menu.open).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => buttons[0].click());
    expect(select).toHaveBeenCalledOnce();
    await act(async () => buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(buttons[2]);
    await act(async () => buttons[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("uses declared shared size tokens and keeps all responsive rules in the shared surface", () => {
    expect(source("components/dashboard/DashboardA.css")).toContain("max-block-size: none;");
    const css = source("global.css");
    const expected = {
      "control-size": "calc(var(--cmux-space-7) * 2)",
      "band-height": "calc(var(--cmux-space-7) * 2)",
      "header-height": "calc(var(--cmux-space-6) * 4)",
      "side-width": "calc(var(--cmux-space-7) * 13)",
      "reading-inset": "calc(var(--cmux-space-5) * 2)",
      "reading-line-height": "1.85",
      "card-min-height": "calc(var(--cmux-space-7) * 5)",
      "tile-min-height": "calc(var(--cmux-space-7) * 4)",
      "composer-min-height": "calc(var(--cmux-space-7) * 4)",
    };
    for (const [name, value] of Object.entries(expected)) expect(css).toContain(`--cmux-dashboard-${name}: ${value};`);
    expect(source("components/dashboard/DashboardView.tsx")).toContain('data-dashboard-compact={compact ? "true" : "false"}');
  });
});

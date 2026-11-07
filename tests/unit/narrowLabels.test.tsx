// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardStatusMark } from "../../src/components/dashboard/DashboardUi";
import { useThemeStore } from "../../src/stores/themeStore";
import { MinimapTabChip } from "../../src/components/dashboard/MinimapTabChip";
import { stateLabels } from "../../src/components/dashboard/stateLabels";

const read = (name: string) => readFileSync(`src/components/dashboard/${name}`, "utf8");
const surface = read("DashboardChatSurface.css");
const minimap = read("MinimapPanel.css");
let host: HTMLDivElement;
let style: HTMLStyleElement;
let root: Root | undefined;

beforeEach(() => {
  host = document.createElement("div");
  host.className = "cmux-dashboard-view";
  document.body.append(host);
  style = document.createElement("style");
  // The values checked here do not depend on the load order. In the production build
  // DashboardView.css is in the first CSS; MinimapPanel.css, DashboardChatSurface.css and
  // DashboardA.css are in the CSS loaded later. jsdom cannot evaluate container queries;
  // their narrow-label fallback is checked separately below.
  style.textContent = [read("DashboardUi.css"), readFileSync("src/global.css", "utf8"), read("MarkdownView.css"),
    minimap, read("DashboardView.css"), surface, read("DashboardA.css")].flatMap(source => {
    const rules: string[] = [];
    postcss.parse(source).walkRules(rule => { if (rule.parent?.type === "root") rules.push(rule.toString()); });
    return rules;
  }).join("\n");
  document.head.append(style);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host.remove(); style.remove(); vi.unstubAllGlobals(); });

describe("narrow dashboard labels", () => {
  it("ellipsizes the status text inside its shrinkable flex parents", () => {
    host.innerHTML = `<div class="cmux-dashboard-chat-identity"><div class="cmux-dashboard-chat-header-meta">${renderToStaticMarkup(
      <DashboardStatusMark state="done" label={stateLabels("done").tooltip} />,
    )}</div></div>`;
    for (const selector of [".cmux-dashboard-chat-identity", ".cmux-dashboard-chat-header-meta", ".cmux-dashboard-status-mark", ".cmux-dashboard-status-text"]) {
      const css = getComputedStyle(host.querySelector(selector)!);
      expect(css.minWidth, selector).toBe("0px");
      expect(css.overflow, selector).toBe("hidden");
      expect(css.whiteSpace, selector).toBe("nowrap");
    }
    expect(getComputedStyle(host.querySelector(".cmux-dashboard-chat-header-meta")!).flexShrink).toBe("1");
    expect(getComputedStyle(host.querySelector(".cmux-dashboard-status-text")!).textOverflow).toBe("ellipsis");
  });

  it.each(["done", "needsHuman", "noUpdate"] as const)("keeps the complete %s status available without a context menu", state => {
    const text = stateLabels(state).tooltip;
    host.innerHTML = renderToStaticMarkup(<DashboardStatusMark state={state} label={text} />);
    const mark = host.querySelector('[role="img"]')!;
    expect(mark.getAttribute("title")).toBe(text);
    expect(mark.getAttribute("aria-label")).toBe(text);
    expect(read("ChatColumn.tsx")).toContain('className="cmux-dashboard-chat-header-meta" title={stateLabels(displayState).tooltip}');
  });

  it("keeps the two-line budget and reserves the final glyph slot only for truncated expanded names", () => {
    host.innerHTML = '<div class="cmux-minimap-map is-expanded"><button class="cmux-minimap-chip is-label-truncated"><span class="cmux-minimap-label">Fictional sample</span></button></div><div class="cmux-minimap-map"><span class="cmux-minimap-label">Fictional sample</span></div>';
    const [expanded, collapsed] = host.querySelectorAll(".cmux-minimap-label");
    const css = getComputedStyle(expanded);
    expect(css.clipPath).toContain("calc(100% - 1em)");
    expect(css.overflow).toBe("hidden");
    expect(css.textOverflow).toBe("ellipsis");
    expect(css.maxBlockSize).toBe("2.7em");
    const marker = postcss.parse(minimap).nodes.find(node => node.type === "rule" && node.selector === ".cmux-minimap-map.is-expanded .cmux-minimap-chip.is-label-truncated::after");
    expect(marker?.toString()).toContain('content: "\\2026"');
    expect(marker?.toString()).toContain("width: 1em");
    expect(marker?.toString()).toContain("pointer-events: none");
    expect(getComputedStyle(collapsed).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(collapsed).textOverflow).toBe("ellipsis");
  });

  it("shows the overflow marker after layout measurement and clears it when the complete name fits", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { observers.push(callback); }
      observe() {} disconnect() {}
    });
    root = createRoot(host);
    const label = "Fictional sample with a long name";
    await act(async () => root!.render(<MinimapTabChip chip={{ tabId: "sample", sessionId: "sample-session", index: 0, label, typeGlyph: "", mark: null, isActiveTab: true, isPinned: false, declared: false }}
      workspaceId="sample-workspace" paneId="sample-pane" selected={false} open={false} selectedTabIds={new Set()} groupPulseTabIds={new Set()} displayState="done" collapsed={false}
      now={1700000000000} onSelect={() => {}} onSelectGroup={() => {}} />));
    const button = host.querySelector("button")!;
    const name = host.querySelector(".cmux-minimap-label")!;
    let height = 64;
    Object.defineProperties(name, { scrollHeight: { get: () => height }, clientHeight: { value: 32 }, scrollWidth: { value: 20 }, clientWidth: { value: 20 } });
    const resize = async () => act(async () => { for (const callback of observers) callback([], {} as ResizeObserver); });
    await resize();
    expect(button.classList.contains("is-label-truncated")).toBe(true);
    expect(name.textContent).toBe(label);
    height = 16;
    await resize();
    expect(button.classList.contains("is-label-truncated")).toBe(false);
    expect(button.title.split("\n")[0]).toBe(label);
  });

  it("re-measures the overflow marker when only the font family, scale or density changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const listeners = new Map<string, EventListener>();
    const fonts = { ready: Promise.resolve(), addEventListener: (type: string, fn: EventListener) => listeners.set(type, fn), removeEventListener: (type: string, fn: EventListener) => { if (listeners.get(type) === fn) listeners.delete(type); } };
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    try {
      root = createRoot(host);
      const chip = { tabId: "sample", sessionId: "sample-session", index: 0, label: "Fictional sample 2", typeGlyph: "", mark: null, isActiveTab: true, isPinned: false, declared: false };
      await act(async () => root!.render(<MinimapTabChip chip={chip}
        workspaceId="sample-workspace" paneId="sample-pane" selected={false} open={false} selectedTabIds={new Set()} groupPulseTabIds={new Set()} displayState="done" collapsed={false}
        now={1700000000000} onSelect={() => {}} onSelectGroup={() => {}} />));
      const button = host.querySelector("button")!;
      const name = host.querySelector(".cmux-minimap-label")!;
      let height = 16;
      Object.defineProperties(name, { scrollHeight: { get: () => height }, clientHeight: { value: 32 }, scrollWidth: { value: 20 }, clientWidth: { value: 20 } });
      const flag = () => button.classList.contains("is-label-truncated");
      expect(flag()).toBe(false);
      const original = useThemeStore.getState();
      for (const [key, value] of [["fontFamily", "Sample Family"], ["uiFontScale", 1.25], ["uiDensity", "relaxed"]] as const) {
        height = 64;
        await act(async () => useThemeStore.setState({ [key]: value } as never));
        expect(flag(), key).toBe(true);
        height = 16;
        await act(async () => useThemeStore.setState({ [key]: original[key] } as never));
        expect(flag(), `${key} back`).toBe(false);
      }
      height = 64;
      await act(async () => listeners.get("loadingdone")?.(new Event("loadingdone")));
      expect(flag()).toBe(true);
      await act(async () => root!.unmount());
      root = undefined;
      expect(listeners.has("loadingdone")).toBe(false);
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
  });

  it("reserves existing tile padding for the ellipsis when the name box is narrower than one glyph", () => {
    const css = postcss.parse(minimap);
    const query = css.nodes.find(node => node.type === "atrule" && node.name === "container" && node.params === "minimap-chip (max-width: 1em)");
    expect(query?.toString()).toContain("margin-inline: calc(-1 * var(--cmux-space-5))");
    const chip = css.nodes.find(node => node.type === "rule" && node.selector === ".cmux-dashboard-view .cmux-minimap-map.is-expanded .cmux-minimap-chip");
    expect(chip?.toString()).toContain("container: minimap-chip / inline-size");
  });

  it("keeps the borrowed label space inside the waiting band and the selection ring", () => {
    const css = postcss.parse(minimap);
    const query = css.nodes.find(node => node.type === "atrule" && node.name === "container" && node.params === "minimap-chip (max-width: 1em)") as postcss.AtRule;
    const rule = (selector: string) => query.nodes?.find(node => node.type === "rule" && node.selector === selector)?.toString() ?? "";
    const base = ".cmux-dashboard-view .cmux-minimap-map.is-expanded .cmux-minimap-chip";
    expect(rule(`${base}.is-waiting .cmux-minimap-label`)).toContain("margin-inline-start: calc(-1 * var(--cmux-space-5) + var(--minimap-waiting-band))");
    expect(rule(`${base}.is-selected .cmux-minimap-label`)).toBe("");
    const selected = rule(`${base}:is(.is-selected, .is-bundle-selected) .cmux-minimap-label`);
    expect(selected).toContain("margin-inline: calc(-1 * var(--cmux-space-5) + var(--minimap-selected-ring))");
    expect(query.nodes?.indexOf(query.nodes.find(n => n.type === "rule" && n.selector === `${base}.is-waiting .cmux-minimap-label`)!)).toBeGreaterThan(query.nodes!.indexOf(query.nodes.find(n => n.type === "rule" && n.selector === `${base}:is(.is-selected, .is-bundle-selected) .cmux-minimap-label`)!));
    expect(rule(`${base}:is(.is-selected, .is-bundle-selected).is-label-truncated::after`)).toContain("right: var(--minimap-selected-ring)");
    expect(minimap).toMatch(/\.is-bundle-selected \{[^}]*inset 0 0 0 var\(--minimap-selected-ring\) var\(--cmux-accent\)/);
    // The widths come from one place: the band and the ring that are actually drawn.
    expect(minimap).toContain("--minimap-waiting-band: 4px");
    expect(minimap).toContain("--minimap-selected-ring: 2px");
    expect(minimap).toContain("is-waiting::before { width: var(--minimap-waiting-band); }");
    expect(minimap).toContain("inset 0 0 0 var(--minimap-selected-ring) var(--cmux-accent)");
    expect(minimap).not.toMatch(/is-waiting::before \{ width: 4px/);
  });

  it.each([false, true])("keeps the whole tile name in hover and accessible names (collapsed=%s)", collapsed => {
    const label = "\u5317\u6597\u5b66\u9662 \u8cc7\u6599\u78ba\u8a8d - Fictional sample";
    host.innerHTML = renderToStaticMarkup(<MinimapTabChip chip={{ tabId: "sample", sessionId: "sample-session", index: 0, label, typeGlyph: "", mark: null, isActiveTab: true, isPinned: false, declared: false }}
      workspaceId="sample-workspace" paneId="sample-pane" selected={false} open={false} selectedTabIds={new Set()} groupPulseTabIds={new Set()} displayState="done" collapsed={collapsed}
      now={1700000000000} onSelect={() => {}} onSelectGroup={() => {}} />);
    const button = host.querySelector("button")!;
    expect(button.title.split("\n")[0]).toBe(label);
    expect(button.getAttribute("aria-label")).toContain(label);
    expect(host.querySelector(".cmux-minimap-label")?.textContent).toBe(label);
  });

  it("keeps normal word boundaries and an emergency wrap for long prose and URL tokens", () => {
    host.innerHTML = '<div class="cmux-dashboard-markdown">behavior in both windows</div><div class="cmux-dashboard-msg-plain">sample</div><a class="cmux-dashboard-content-link">https://example.test/long-token</a>';
    for (const element of host.children) {
      const css = getComputedStyle(element);
      expect(css.overflowWrap).toBe("anywhere");
      expect(css.wordBreak).not.toBe("break-all");
    }
  });
});

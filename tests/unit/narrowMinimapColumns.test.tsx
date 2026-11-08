// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import postcss from "postcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MinimapWorkspaceBlock } from "../../src/components/dashboard/MinimapWorkspaceBlock";
import { UI_DENSITY_TOKENS, useThemeStore } from "../../src/stores/themeStore";
import type { Workspace } from "../../src/types";

const read = (name: string) => readFileSync(`src/components/dashboard/${name}`, "utf8");
const css = postcss.parse(read("MinimapPanel.css"));
const workspace: Workspace = { id: "sample", name: "Sample workspace", status: "running", createdAt: 1,
  gridTemplateId: "custom", panes: Array.from({ length: 5 }, (_, i) => ({
    id: `pane-${i}`, sessionId: `session-${i}`, agentId: "codex", activeTabId: `tab-${i}`,
    tabs: [{ id: `tab-${i}`, sessionId: `session-${i}`, agentId: "codex", label: `Sample ${i}` }],
  })), splitColumns: Array.from({ length: 5 }, (_, i) => [`pane-${i}`]) };
afterEach(() => useThemeStore.setState({ uiDensity: "standard" }));

describe("N20 narrow minimap padding", () => {
  it.each(["compact", "standard", "relaxed"] as const)("uses the %s density cutoff only below a glyph's content width", density => {
    const tokens = UI_DENSITY_TOKENS[density];
    const cutoff = 4 * Math.round(10 * tokens.spaceScale) + 2 + parseFloat(tokens.fontSm);
    const query = css.nodes.find(node => node.type === "atrule" && node.name === "container"
      && node.params === `minimap-column (width < ${cutoff}px)`) as postcss.AtRule | undefined;
    expect(query).toBeDefined();
    const prefix = `.cmux-dashboard-view .cmux-minimap-map[data-minimap-tight-columns="true"][data-minimap-density="${density}"]`;
    const rules = query!.nodes.filter((node): node is postcss.Rule => node.type === "rule");
    expect(rules.map(rule => rule.selector)).toEqual([
      `${prefix} .cmux-minimap-cell`, `${prefix} .cmux-minimap-chip`, `${prefix} .cmux-minimap-chip.is-waiting`,
      `${prefix} .cmux-minimap-chip.is-collapsed .cmux-minimap-label`,
      `${prefix.replace(".cmux-minimap-map", ".cmux-minimap-map.is-expanded")} .cmux-minimap-chip .cmux-minimap-label`, `${prefix.replace(".cmux-minimap-map", ".cmux-minimap-map.is-expanded")} .cmux-minimap-chip.is-label-truncated::after`,
    ]);
    expect(rules.map(rule => (rule.nodes[0] as postcss.Declaration).value)).toEqual([
      "min(var(--cmux-space-1), max(0px, calc((100cqw - 2px - 4px - max(var(--cmux-font-size-sm), var(--cmux-dash-icon-md))) / 3)))", "min(var(--cmux-space-1), max(0px, calc((100cqw - 2px - 4px - max(var(--cmux-font-size-sm), var(--cmux-dash-icon-md))) / 3)))", "max(var(--minimap-waiting-band), var(--cmux-space-1))", "none", "0", "var(--cmux-space-1)",
    ]);
  });
  it.each(["compact", "standard", "relaxed"] as const)("exports actual column count and %s density for CSS", async density => {
    useThemeStore.setState({ uiDensity: density });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
    await act(async () => root.render(<MinimapWorkspaceBlock workspace={workspace} expanded selectedTabId="tab-0"
      selectedTabIds={new Set()} openColumnByTabId={new Map()} groupPulseTabIds={new Set()} displayStateByTabId={new Map()}
      activePaneId={null} now={1} onToggle={() => {}} onSelect={() => {}} onSelectGroup={() => {}} />));
    const markup = host.innerHTML;
    expect(markup).toContain('data-minimap-column-count="5"');
    expect(markup).toContain(`data-minimap-density="${density}"`);
    expect(markup).toContain('data-minimap-tight-columns="true"');
    expect(markup).toContain('title="Sample 0"');
    expect(markup).toContain('aria-label="Sample 0');
    await act(async () => useThemeStore.setState({ uiDensity: density === "standard" ? "relaxed" : "standard" }));
    expect(host.querySelector(".cmux-minimap-map")?.getAttribute("data-minimap-density")).not.toBe(density);
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
  });
  it.each([1, 2, 3, 4, 5, 6, 7])("limits the tight attribute to eligible densities at %i columns", async count => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const panes = Array.from({ length: count }, (_, i) => ({ ...workspace.panes[0], id: `pane-${i}` }));
    const sample = { ...workspace, panes, splitColumns: panes.map(pane => [pane.id]) };
    try {
      for (const density of ["compact", "standard", "relaxed"] as const) {
        useThemeStore.setState({ uiDensity: density });
        await act(async () => root.render(<MinimapWorkspaceBlock workspace={sample} expanded={false} selectedTabId={null}
          selectedTabIds={new Set()} openColumnByTabId={new Map()} groupPulseTabIds={new Set()} displayStateByTabId={new Map()}
          activePaneId={null} now={1} onToggle={() => {}} onSelect={() => {}} onSelectGroup={() => {}} />));
        expect(host.querySelector(".cmux-minimap-map")?.hasAttribute("data-minimap-tight-columns"), density)
          .toBe(count >= 5 || (density === "relaxed" && count === 4));
      }
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
  });
  it.each([[85, 15], [70, 15, 15], [55, 15, 15, 15]])("enables per-column tightening for unequal shares %j", async (...shares: number[]) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    const sample = { ...workspace, splitColumns: shares.map((_, column) => workspace.panes.filter((_, index) => index % shares.length === column).map(pane => pane.id)), columnWidths: shares };
    try {
      for (const density of ["compact", "standard", "relaxed"] as const) for (const expanded of [false, true]) {
        useThemeStore.setState({ uiDensity: density });
        await act(async () => root.render(<MinimapWorkspaceBlock workspace={sample} expanded={expanded} selectedTabId={null}
          selectedTabIds={new Set()} openColumnByTabId={new Map()} groupPulseTabIds={new Set()} displayStateByTabId={new Map()}
          activePaneId={null} now={1} onToggle={() => {}} onSelect={() => {}} onSelectGroup={() => {}} />));
        expect(host.querySelector(".cmux-minimap-map")?.getAttribute("data-minimap-tight-columns")).toBe("true");
        const columns = [...host.querySelectorAll<HTMLElement>(".cmux-minimap-column")];
        expect(columns.map(column => Number(column.style.flexGrow))).toEqual(shares.map(share => share / 100));
      }
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
  });
  it("keeps original padding, borrowed labels and selected-ring insets as the wide fallback", () => {
    expect(read("DashboardA.css")).toContain("padding: var(--cmux-space-5); font-size: var(--cmux-font-size-sm)");
    expect(read("MinimapPanel.css")).toContain("margin-inline: calc(-1 * var(--cmux-space-5) + var(--minimap-selected-ring))");
    expect(read("MinimapPanel.css")).toContain("right: var(--minimap-selected-ring)");
    const queries = css.nodes.filter(node => node.type === "atrule" && node.name === "container" && node.params.startsWith("minimap-column"));
    expect(queries).toHaveLength(3);
  });
});

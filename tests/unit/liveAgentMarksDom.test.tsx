// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { MinimapWorkspaceBlock } from "../../src/components/dashboard/MinimapWorkspaceBlock";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Workspace } from "../../src/types";

let root: Root;
let container: HTMLDivElement;
const workspace: Workspace = { id: "w", name: "Marks", gridTemplateId: "1x1", status: "running", createdAt: 1,
  splitColumns: [["p"]], panes: [{ id: "p", agentId: "claude-code", sessionId: "pty-mark", activeTabId: "t",
    tabs: [{ id: "t", sessionId: "pty-mark", type: "terminal", agentId: "claude-code", agentKind: "claude", label: "Seat" }] }] };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  useWorkspaceListStore.getState()._replaceWorkspaces([workspace]);
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); vi.unstubAllGlobals();
  useWorkspaceListStore.getState()._replaceWorkspaces([]);
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
});

describe("agent mark DOM authority", () => {
  it("renders saved, live and explicit null tab attributes from the actual volatile store", async () => {
    await act(async () => root.render(createElement(PaneTabBar, { pane: workspace.panes[0], workspaceId: "w", hasTerminalBuffer: () => false })));
    expect(container.querySelector('[data-mark-kind="claude"][data-mark-source="saved"]')).not.toBeNull();
    expect(container.querySelector('[data-mark-source="saved"][style*="opacity: 0.45"]')).not.toBeNull();
    await act(async () => usePaneMetadataStore.getState().setLiveAgent("pty-mark", "codex", true));
    expect(container.querySelector('[data-mark-kind="codex"][data-mark-source="live"]')).not.toBeNull();
    await act(async () => usePaneMetadataStore.getState().setLiveAgent("pty-mark", null, true));
    expect(container.querySelector('[data-mark-kind=""][data-mark-source="live"]')).not.toBeNull();
    expect(container.querySelector('[data-mark-kind="claude"]')).toBeNull();
    expect(container.querySelector('[data-mark-kind="codex"]')).toBeNull();
  });

  it("updates minimap marks immediately without a panel clock tick or output-driven rerender", async () => {
    const props = { workspace, selectedTabId: null, selectedTabIds: new Set<string>(),
      openColumnByTabId: new Map<string, number>(), groupPulseTabIds: new Set<string>(),
      displayStateByTabId: new Map(), expanded: true, activePaneId: null, now: 1000,
      onToggle: () => {}, onSelect: () => {}, onSelectGroup: () => {} };
    await act(async () => root.render(createElement(MinimapWorkspaceBlock, props)));
    expect(container.querySelector('[data-minimap-tab="t"]')?.getAttribute("data-mark-source")).toBe("saved");
    await act(async () => usePaneMetadataStore.getState().setLiveAgent("pty-mark", "hermes", true));
    expect(container.querySelector('[data-minimap-tab="t"]')?.getAttribute("data-mark-kind")).toBe("hermes");
    const chip = container.querySelector('[data-minimap-tab="t"]');
    await act(async () => usePaneMetadataStore.getState().setVolatileMetadata("pty-mark", { backendLastOutputAt: 2000 }));
    expect(container.querySelector('[data-minimap-tab="t"]')).toBe(chip);
    await act(async () => usePaneMetadataStore.getState().setLiveAgent("pty-mark", null, true));
    expect(container.querySelector('[data-minimap-tab="t"]')?.getAttribute("data-mark-kind")).toBe("");
    expect(container.querySelector(".cmux-minimap-agent")).toBeNull();
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, cleanup, mount, workspace, pane, content, pointer, root, host, mocks } from "./paneHoverFocusHarness";
import TerminalPane from "../../src/components/workspace/TerminalPane";
import PaneDragOverlay from "../../src/components/workspace/PaneDragOverlay";
import { paneDndStrings } from "../../src/components/workspace/paneDndStrings";
import { commitPaneDragDrop, resolveDropTargetAtPoint } from "../../src/hooks/usePaneDragSource";
import { usePaneDragStore, type PaneDragItem } from "../../src/stores/paneDragStore";
import { useDetachedDockStore } from "../../src/stores/detachedDockStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Workspace } from "../../src/types";

beforeEach(() => setup("click"));
afterEach(cleanup);

function renderWithOverlay(ws: Workspace) {
  root.render(<>{ws.panes.map(p => <TerminalPane key={p.id} pane={p} workspaceId={ws.id} />)}<PaneDragOverlay /></>);
}
function expectNoTabTransferChip() {
  expect(host.querySelector(".pane-handoff-drop-chip")).toBeNull();
  const attributes = [...host.querySelectorAll(".terminal-pane-border")].flatMap(el => el.getAttributeNames());
  expect(attributes.filter(name => name.includes("handoff"))).toEqual([]);
}

describe("agent tab and pane center merges", () => {
  it.each([
    ["tab", false], ["tab", true], ["pane", false], ["pane", true], ["bundle", false], ["bundle", true],
    ["minimap-pane", false], ["minimap-pane", true],
  ] as const)("merges %s and activates the incoming tab without changing the destination pin, pinned=%s", async (kind, pinned) => {
    const source = pane("a"), destination = pane("b");
    source.tabs.push({ id: "extra", sessionId: "extra", agentId: "shell", type: "terminal" });
    if (pinned) destination.pinnedTabId = "t-b";
    const ws = await mount(workspace([source, destination]));
    usePaneMetadataStore.setState({ metadata: {
      a: { agentKind: "claude", agentSessionId: "source-agent", cwd: "C:/demo/source" },
      extra: { agentKind: "claude", agentSessionId: "extra-agent", cwd: "C:/demo/source" },
      b: { agentKind: "codex", agentSessionId: "target-agent" },
    } });
    const item: PaneDragItem = kind === "tab"
      ? { kind: "tab", workspaceId: "w", paneId: "p-a", tabId: "t-a", label: "Agent" }
      : kind === "bundle"
        ? { kind: "tab-bundle", workspaceId: "w", paneId: "p-a", tabIds: ["t-a", "extra"], anchorTabId: "extra", label: "Agents", surface: "minimap" }
        : { kind: "pane", workspaceId: "w", paneId: "p-a", label: "Agents", tabCount: 2,
          ...(kind === "minimap-pane" ? { surface: "minimap" as const } : {}) };
    const minimap = item.surface === "minimap";
    if (minimap) Object.assign(host.querySelector<HTMLElement>("[data-dnd-pane-id='p-b']")!.dataset,
      { minimapDndWorkspaceId: "w", minimapDndPaneId: "p-b" });
    await act(async () => {
      renderWithOverlay(ws);
      usePaneDragStore.getState().beginDrag(item, { x: 200, y: 150 });
      pointer(content(), "pointermove", { clientX: 200, clientY: 150 });
    });
    const target = resolveDropTargetAtPoint(200, 150, item);
    expect(target).toEqual({ kind: "pane", workspaceId: "w", paneId: "p-b", zone: "center",
      ...(minimap ? { surface: "minimap" } : {}) });
    await act(async () => { usePaneDragStore.getState().setTarget(target); });
    expectNoTabTransferChip();
    if (!minimap) expect(host.querySelector(".pane-drop-result__label")?.textContent)
      .toBe(kind === "tab" ? paneDndStrings.attachTab : paneDndStrings.mergePane);
    await act(async () => { commitPaneDragDrop(item, target); });
    const merged = useWorkspaceListStore.getState().getWorkspace("w")!.panes.find(p => p.id === "p-b")!;
    expect(merged.tabs.map(tab => tab.id)).toEqual(kind === "tab" ? ["t-b", "t-a"] : ["t-b", "t-a", "extra"]);
    expect(merged.activeTabId).toBe(kind === "bundle" ? "extra" : "t-a");
    expect(merged.sessionId).toBe(kind === "bundle" ? "extra" : "a");
    expect(merged.pinnedTabId).toBe(pinned ? "t-b" : undefined);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "publish_savepoint")).toBe(false);
  });

  it.each([false, true])("shows the center merge preview over an agent for a detached window, singleTab=%s", async singleTab => {
    const ws = await mount();
    usePaneMetadataStore.setState({ metadata: { b: { agentKind: "codex", agentSessionId: "target-agent" } } });
    await act(async () => {
      useDetachedDockStore.setState({ active: { label: "child", workspaceId: "incoming", nativeSingleTab: singleTab },
        target: { kind: "pane-zone", workspaceId: "w", paneId: "p-b", zone: "center" } });
      renderWithOverlay(ws);
    });
    expect(host.querySelector(".pane-drop-result--merge")).not.toBeNull();
    expect(host.querySelector(".pane-drop-result__label")?.textContent).toBe(singleTab ? paneDndStrings.attachTab : paneDndStrings.mergePane);
    expectNoTabTransferChip();
  });
});

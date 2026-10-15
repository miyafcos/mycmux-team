// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useUiStore } from "../../src/stores/uiStore";
import type { Workspace } from "../../src/types";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

let root: Root;
let host: HTMLDivElement;
let anchorLeft: number;
let anchorTop: number;
let menuWidth: number;
let menuHeight: number;
let observers: Array<() => void>;
const selectTab = vi.fn();
const splitRight = vi.fn();
const workspace: Workspace = {
  id: "workspace", name: "Sample", gridTemplateId: "1x1", status: "running", createdAt: 1,
  panes: [{ id: "pane", sessionId: "active", agentId: "shell", activeTabId: "active", tabs: [
    { id: "active", sessionId: "active", agentId: "shell", type: "terminal", label: "Sample active", agentKind: "claude", agentSessionId: "sample-session" },
    { id: "hidden", sessionId: "hidden", agentId: "shell", type: "terminal", label: "Sample hidden" },
  ] }],
};
function Fixture({ visible = true }: { visible?: boolean }) {
  return <div data-dnd-workspace-id="workspace" data-dnd-pane-id="pane" style={{ position: "relative", overflow: "hidden" }}>
    <PaneTabBar pane={workspace.panes[0]} workspaceId="workspace" isVisible={visible}
      hasTerminalBuffer={() => false} onSelectTab={selectTab} onSplitRight={splitRight} />
  </div>;
}
const owner = () => host.querySelector<HTMLElement>("[data-dnd-pane-id]")!;
const trigger = () => owner().querySelector<HTMLButtonElement>(".pane-hidden-tabs")!;
const menu = () => host.querySelector<HTMLElement>("[role='menu']")!;
async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.click();
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  observers = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(update: () => void) { observers.push(update); }
    observe() {} disconnect() {}
  });
  anchorLeft = 600; anchorTop = 40; menuWidth = 300; menuHeight = 80;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const isMenu = this.matches("[role='menu'],[data-cmux-native-webview-occluder]");
    return new DOMRect(isMenu ? 0 : anchorLeft, isMenu ? 0 : anchorTop, isMenu ? menuWidth : 24, isMenu ? menuHeight : 24);
  });
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useUiStore.setState({ zoomedPaneId: null, activePaneId: "active" });
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true";
  document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Fixture />));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("pane menus escape split layers without losing their owner", () => {
  it("portals the list to its theme root and leaves selection clickable after mousedown", async () => {
    await click(trigger());
    expect(menu().parentElement).toBe(host);
    expect(owner().contains(menu())).toBe(false);
    expect(menu().dataset.paneFocusWorkspaceId).toBe("workspace");
    expect(menu().dataset.paneFocusPaneId).toBe("pane");
    await click(menu().querySelector<HTMLElement>("[data-menu-tab-id='hidden']")!);
    expect(selectTab).toHaveBeenCalledExactlyOnceWith("hidden");
    expect(menu()).toBeNull();
  });
  it("toggles with its trigger, dismisses outside, and returns focused menu input on Escape", async () => {
    await click(trigger()); await click(trigger()); expect(menu()).toBeNull();
    await click(trigger());
    await act(async () => menu().querySelector<HTMLElement>("[role='menuitem']")!.focus());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(menu()).toBeNull(); expect(document.activeElement).toBe(trigger());
    await click(trigger()); await click(host); expect(menu()).toBeNull();
  });
  it("repositions when the viewport, anchor, or menu size changes", async () => {
    await click(trigger()); expect(menu().style.left).toBe("324px");
    anchorLeft = 20; anchorTop = 700;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(menu().style.left).toBe("20px"); expect(menu().style.top).toBe("680px");
    menuHeight = 200;
    await act(async () => observers.forEach(update => update()));
    expect(menu().style.top).toBe("560px");
    anchorTop = 10;
    await act(async () => window.dispatchEvent(new Event("scroll")));
    expect(menu().style.top).toBe("40px");
    anchorLeft = 700;
    await act(async () => window.dispatchEvent(new Event("mycmux:terminal-layout-change")));
    expect(menu().style.left).toBe("424px");
  });
  it.each(["list", "actions", "context", "publish", "rename"])("does not leave the %s surface behind when its workspace hides", async kind => {
    if (kind === "list") await click(trigger());
    else if (kind === "rename") {
      await act(async () => owner().querySelector(".pane-active-heading")!.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })));
    }
    else if (kind === "context") {
      await act(async () => owner().querySelector(".pane-active-heading")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 900, clientY: 700 })));
    } else {
      await click(owner().querySelector<HTMLButtonElement>("button[aria-haspopup='menu']:not(.pane-hidden-tabs)")!);
      if (kind === "publish") await click(menu().querySelector<HTMLElement>("[data-pane-action='publish']")!);
    }
    const surface = host.querySelector<HTMLElement>("[role='menu'],[data-cmux-native-webview-occluder]")!;
    expect(surface.parentElement).toBe(host);
    expect(surface.dataset.paneFocusPaneId).toBe("pane");
    await act(async () => root.render(<Fixture visible={false} />));
    expect(surface.isConnected).toBe(false);
    await act(async () => root.render(<Fixture />));
    expect(host.querySelector("[role='menu'],[data-cmux-native-webview-occluder]")).toBeNull();
  });
  it("executes an action after pointer dismissal checks without closing early", async () => {
    await click(owner().querySelector<HTMLButtonElement>("button[aria-haspopup='menu']:not(.pane-hidden-tabs)")!);
    await click(menu().querySelector<HTMLElement>("[data-pane-action='split-right']")!);
    expect(splitRight).toHaveBeenCalledOnce(); expect(menu()).toBeNull();
  });
});

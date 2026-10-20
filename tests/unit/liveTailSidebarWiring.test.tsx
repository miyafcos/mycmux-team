// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TabBar from "../../src/components/layout/TabBar";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { disposeLiveTailObserver } from "../../src/stores/liveTailStore";
import { __resetLiveBriefStoreForTests } from "../../src/stores/liveBriefStore";
import { LIVE_TAIL_TEST_NOW, liveTailFixtureScene } from "../fixtures/liveTailList";
import { TERMINAL_IPC_TIMEOUT_MS } from "../../src/lib/terminalDeadline";

const mocks = vi.hoisted(() => ({
  targets: vi.fn(), outputs: vi.fn(), readPaneTail: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), unlisten: vi.fn(), jump: vi.fn(),
}));
vi.mock("../../src/lib/liveTail/targets", () => ({ loadLiveTailTargets: mocks.targets, loadLiveTailOutputs: mocks.outputs }));
vi.mock("../../src/components/layout/socketCommands", () => ({ readPaneTail: mocks.readPaneTail }));
vi.mock("../../src/lib/jumpToPaneTab", () => ({ jumpToPaneTab: mocks.jump }));
vi.mock("../../src/lib/livebrief", async () => ({
  ...await vi.importActual<typeof import("../../src/lib/livebrief")>("../../src/lib/livebrief"),
  getLiveBriefs: vi.fn(async () => []), subscribeLiveBriefs: mocks.subscribe, unsubscribeLiveBriefs: mocks.unsubscribe,
  onLiveBriefUpdate: vi.fn(async () => mocks.unlisten),
}));
let host: HTMLDivElement, root: Root;
let scene: ReturnType<typeof liveTailFixtureScene>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(LIVE_TAIL_TEST_NOW); vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  disposeLiveTailObserver(); __resetLiveBriefStoreForTests();
  scene = liveTailFixtureScene(["alive"]);
  useWorkspaceListStore.setState({ workspaces: [scene.workspace], activeWorkspaceId: scene.workspace.id });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useUiStore.setState({ sidebarCollapsed: false, zoomedPaneId: null, sidebarWidth: 220 });
  mocks.targets.mockResolvedValue([...scene.targets, { ...scene.targets[0], sessionId: "sample-foreign-session", workspaceId: "sample-foreign", tabId: "sample-foreign-tab" }]);
  mocks.outputs.mockResolvedValue({ "sample-session-0": LIVE_TAIL_TEST_NOW });
  mocks.readPaneTail.mockResolvedValue(["* Thinking… (1s · ↓ 10 tokens)"]);
  mocks.subscribe.mockResolvedValue(undefined); mocks.unsubscribe.mockResolvedValue(undefined);
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true"; document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); disposeLiveTailObserver(); __resetLiveBriefStoreForTests();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  useUiStore.setState({ sidebarCollapsed: false, zoomedPaneId: null });
  vi.unstubAllGlobals(); vi.useRealTimers();
});
async function render() { await act(async () => root.render(<TabBar onNewWorkspace={() => {}} onCloseWorkspace={() => {}} />)); }
async function advance(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }

describe("real sidebar live-tail wiring", () => {
  it("uses the same blue Hybrid glyph in the actual sidebar without starting or sending to the session", async () => {
    mocks.targets.mockResolvedValue(scene.targets.map(target => ({ ...target, agentKind: "claude-codex" })));
    await render(); await advance(0); await advance(2_000);
    const icon = host.querySelector('.live-tail-agent');
    expect(icon?.querySelector('path[fill="#7a9dff"]')).not.toBeNull();
    expect(icon?.querySelector('path[fill="#d97757"]')).toBeNull();
    expect(mocks.jump).not.toHaveBeenCalled();
    expect(mocks.readPaneTail.mock.calls.every(call => call[0] === "sample-session-0")).toBe(true);
  });
  it("reads only local pane tabs and preserves the configured width", async () => {
    await render(); await advance(0); await advance(2_000);
    expect(mocks.readPaneTail).toHaveBeenCalledTimes(2);
    expect(mocks.readPaneTail.mock.calls.every(call => call[0] === "sample-session-0")).toBe(true);
    expect(mocks.readPaneTail).toHaveBeenCalledWith("sample-session-0", 40, false,
      { headlessFetchTimeoutMs: TERMINAL_IPC_TIMEOUT_MS, purpose: "observation", isCurrent: expect.any(Function) });
    expect(useUiStore.getState().sidebarWidth).toBe(220);
    expect(host.querySelector(".live-tail-name")?.textContent).toBe("Sample alive");
  });
  it("also reads a local session in an inactive workspace while excluding detached-window targets", async () => {
    const inactive = liveTailFixtureScene(["alive"], "inactive-workspace");
    const pane = inactive.workspace.panes[0], tab = pane.tabs[0];
    pane.id = "inactive-pane"; tab.id = "inactive-tab"; tab.sessionId = "inactive-session";
    pane.sessionId = tab.sessionId; pane.activeTabId = tab.id;
    useWorkspaceListStore.setState({ workspaces: [scene.workspace, inactive.workspace], activeWorkspaceId: scene.workspace.id });
    mocks.targets.mockResolvedValue([...scene.targets, { ...inactive.targets[0], paneId: pane.id, tabId: tab.id, sessionId: tab.sessionId },
      { ...scene.targets[0], sessionId: "detached-session", workspaceId: "detached-workspace", tabId: "detached-tab" }]);
    mocks.outputs.mockResolvedValue({ "sample-session-0": LIVE_TAIL_TEST_NOW, "inactive-session": LIVE_TAIL_TEST_NOW });
    await render(); await advance(0); await advance(2_000);
    expect([...new Set(mocks.readPaneTail.mock.calls.map(call => call[0]))].sort()).toEqual(["inactive-session", "sample-session-0"]);
    expect(host.querySelectorAll(".live-tail-row")).toHaveLength(2);
  });
  it.each(["collapse", "zoom"] as const)("releases demand and hides rows when the actual sidebar is hidden by %s", async reason => {
    await render(); await advance(0); await advance(2_000);
    await act(async () => {
      if (reason === "collapse") useUiStore.getState().toggleSidebar();
      else useUiStore.getState().setZoomedPaneId("sample-pane");
    });
    expect(host.querySelector(".live-tail-row")).toBeNull();
    await advance(10_000);
    expect(mocks.readPaneTail).toHaveBeenCalledTimes(2);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1); expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().sidebarWidth).toBe(220);
  });
  it("keeps live-tail buttons outside the workspace drag and contextmenu target", async () => {
    await render(); await advance(0);
    const row = host.querySelector<HTMLButtonElement>(".live-tail-row")!;
    expect(row.closest("[data-dnd-workspace-target-id]")).toBeNull();
    await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull(); expect(mocks.jump).not.toHaveBeenCalled();
    await act(async () => row.click());
    expect(mocks.jump).toHaveBeenCalledExactlyOnceWith({ workspaceId: scene.workspace.id, paneId: "sample-pane", tab: scene.workspace.panes[0].tabs[0] });
  });
});

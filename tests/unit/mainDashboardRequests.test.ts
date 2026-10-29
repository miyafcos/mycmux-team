// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../src/types";
const mocks = vi.hoisted(() => ({ listen: vi.fn(), stop: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
import { connectMainDashboardRequests } from "../../src/lib/mainDashboardRequests";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";
import { usePeerWindowTabsStore } from "../../src/components/dashboard/peerWindowTabsStore";
import { peerIndex } from "./fixtures/peerWindowTabs";

const originalActions = {
  openView: useDashboardViewStore.getState().openView,
  focusChatColumn: useDashboardViewStore.getState().focusChatColumn,
  openTranscriptTurnRequest: useDashboardViewStore.getState().openTranscriptTurnRequest,
};

let disconnect: () => void;
function receive(payload: unknown) { mocks.listen.mock.calls[0][1]({ payload }); }
beforeEach(() => {
  vi.useFakeTimers(); mocks.listen.mockReset().mockResolvedValue(mocks.stop);
  __resetToastStoreForTests();
  usePeerWindowTabsStore.setState({ index: [], completedReads: 0, pollers: 0, reading: false, requestSequence: 0, handledRequestSequence: 0 });
  useDashboardViewStore.setState({ ...originalActions, open: false, pendingDashboardRequest: null, chatColumnTabIds: [], pinnedChatColumnTabIds: [], chatColumnLimit: 3,
    query: "filter", stateFilter: "running", workspaceFilter: "ws", agentFilter: "claude", userTurnRequests: {} });
  useWorkspaceListStore.setState({ workspaces: [{ id: "ws", panes: [{ id: "p", tabs: [{ id: "local", sessionId: "s" }] }] } as Workspace] });
  disconnect = connectMainDashboardRequests("main");
});
afterEach(() => { disconnect(); __resetToastStoreForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("main dashboard request receiver", () => {
  it("counts a read started synchronously by opening the dashboard as after receipt", async () => {
    usePeerWindowTabsStore.setState({ pollers: 1 });
    const original = useDashboardViewStore.getState().openView;
    vi.spyOn(useDashboardViewStore.getState(), "openView").mockImplementation(() => {
      original(); usePeerWindowTabsStore.getState().finishRead();
    });
    receive({ tabId: "absent" });
    usePeerWindowTabsStore.getState().finishRead();
    await vi.advanceTimersByTimeAsync(5000);
    expect(useDashboardViewStore.getState().pendingDashboardRequest).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
  it("resolves a peer request from the shared cache before the column filter runs", () => {
    const sequence = usePeerWindowTabsStore.getState().requestSequence;
    receive({ tabId: "peer-tab" });
    expect(usePeerWindowTabsStore.getState().requestSequence).toBe(sequence + 1);
    expect(useDashboardViewStore.getState().pendingDashboardRequest).not.toBeNull();
    usePeerWindowTabsStore.getState().acceptIndex(peerIndex());
    expect(useDashboardViewStore.getState()).toMatchObject({ selectedTabId: "peer-tab", pendingDashboardRequest: null });
  });
  it("waits for five seconds and two reads begun after receipt, with a ten-second cap", async () => {
    usePeerWindowTabsStore.setState({ pollers: 1, reading: true });
    receive({ tabId: "missing" });
    usePeerWindowTabsStore.getState().finishRead(); // This read began before receipt.
    await vi.advanceTimersByTimeAsync(5000);
    expect(useDashboardViewStore.getState().pendingDashboardRequest).not.toBeNull();
    usePeerWindowTabsStore.getState().finishRead();
    expect(useDashboardViewStore.getState().pendingDashboardRequest).not.toBeNull();
    usePeerWindowTabsStore.getState().finishRead();
    expect(useDashboardViewStore.getState().pendingDashboardRequest).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
    __resetToastStoreForTests();
    receive({ tabId: "never-finishes" }); await vi.advanceTimersByTimeAsync(10_000);
    expect(useDashboardViewStore.getState().pendingDashboardRequest).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
  it("rejects unknown IDs without touching columns, pins or toasts, and admits local, peer and special IDs", () => {
    useDashboardViewStore.setState({ chatColumnLimit: 1, chatColumnTabIds: ["local"], pinnedChatColumnTabIds: ["local"] });
    localStorage.setItem("mycmux:dashboard-chat-column-pins", '["local"]');
    const view = useDashboardViewStore.getState();
    const columns = view.chatColumnTabIds, pins = view.pinnedChatColumnTabIds;
    view.focusChatColumn("unknown");
    expect(view.openTranscriptTurnRequest("unknown", { kind: "latest" })).toBe(false);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useDashboardViewStore.getState().chatColumnTabIds).toBe(columns);
    expect(useDashboardViewStore.getState().pinnedChatColumnTabIds).toBe(pins);
    expect(localStorage.getItem("mycmux:dashboard-chat-column-pins")).toBe('["local"]');
    useDashboardViewStore.setState({ chatColumnLimit: 3, chatColumnTabIds: [], pinnedChatColumnTabIds: [] });
    view.focusChatColumn("local");
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual(["local"]);
    useDashboardViewStore.setState({ chatColumnTabIds: [] });
    usePeerWindowTabsStore.getState().acceptIndex(peerIndex());
    view.focusChatColumn("peer-tab");
    view.toggleChatColumnPin("peer-tab");
    const savedPins = localStorage.getItem("mycmux:dashboard-chat-column-pins");
    view.close(); view.openView();
    expect(useDashboardViewStore.getState().chatColumnTabIds).toContain("peer-tab");
    expect(localStorage.getItem("mycmux:dashboard-chat-column-pins")).toBe(savedPins);
    view.focusChatColumn("__mycmux_report_inbox__"); view.focusChatColumn("__mycmux_preview__");
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual(["peer-tab", "__mycmux_report_inbox__", "__mycmux_preview__"]);
    usePeerWindowTabsStore.getState().acceptIndex([]);
    view.close(); view.openView();
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual(["peer-tab", "__mycmux_report_inbox__", "__mycmux_preview__"]);
    expect(localStorage.getItem("mycmux:dashboard-chat-column-pins")).toBe(savedPins);
    disconnect();
    expect(useDashboardViewStore.getState().chatColumnIdFilter).toBeNull();
    view.focusChatColumn("unknown-without-filter");
    expect(useDashboardViewStore.getState().chatColumnTabIds).toContain("unknown-without-filter");
  });
  it("listens only to its addressed webview, opens without toggling and clears filters", () => {
    expect(mocks.listen).toHaveBeenCalledWith("mycmux://open-dashboard", expect.any(Function), { target: { kind: "Webview", label: "main" } });
    receive({ tabId: "local" }); receive({ sessionId: "s" });
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, selectedTabId: "local", query: "", stateFilter: null, workspaceFilter: null, agentFilter: null, pendingDashboardRequest: null });
  });
  it("uses only the turn entry and gives one full-column toast", () => {
    useDashboardViewStore.setState({ chatColumnLimit: 1, chatColumnTabIds: ["saved"], pinnedChatColumnTabIds: ["saved"] });
    const focus = vi.spyOn(useDashboardViewStore.getState(), "focusChatColumn");
    const turn = vi.spyOn(useDashboardViewStore.getState(), "openTranscriptTurnRequest");
    receive({ tabId: "local", turn: "latest" });
    expect(turn).toHaveBeenCalledOnce(); expect(focus).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
  it.each([null, [], { tabId: 12 }, { sessionId: "s".repeat(257) }, { tabId: "local", turn: "oldest" }])("only opens for invalid payload %j", payload => {
    receive(payload);
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, pendingDashboardRequest: null, chatColumnTabIds: [] });
  });
  it("holds a request until its tab arrives", () => {
    receive({ tabId: "arriving" });
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([]);
    useWorkspaceListStore.setState({ workspaces: [{ panes: [{ tabs: [{ id: "arriving", sessionId: "new" }] }] } as Workspace] });
    expect(useDashboardViewStore.getState()).toMatchObject({ selectedTabId: "arriving", pendingDashboardRequest: null });
  });
  it("expires stage-one peer requests at five seconds without a phantom column", async () => {
    receive({ tabId: "peer" }); await vi.advanceTimersByTimeAsync(5000);
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, pendingDashboardRequest: null, chatColumnTabIds: [] });
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
  it("silently cancels on close and replaces older requests", async () => {
    receive({ tabId: "old" }); await vi.advanceTimersByTimeAsync(3000);
    receive({ tabId: "new" }); await vi.advanceTimersByTimeAsync(3000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    useDashboardViewStore.getState().close(); await vi.advanceTimersByTimeAsync(10_000);
    expect(useDashboardViewStore.getState().pendingDashboardRequest).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
  it("leaves other AppShell windows without a listener or filter and does not reconcile requests", async () => {
    disconnect(); mocks.listen.mockClear();
    disconnect = connectMainDashboardRequests("mycmux-w1");
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(useDashboardViewStore.getState().chatColumnIdFilter).toBeNull();
    const pending = { tabId: "unknown", receivedAt: Date.now() };
    useDashboardViewStore.getState().setPendingDashboardRequest(pending);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useDashboardViewStore.getState().pendingDashboardRequest).toBe(pending);
    expect(useDashboardViewStore.getState().open).toBe(false);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
  it("catches listener failure, keeps the main filter until disconnect, and disconnects without throwing", async () => {
    disconnect(); mocks.listen.mockClear();
    mocks.listen.mockRejectedValueOnce(new Error("offline"));
    disconnect = connectMainDashboardRequests("main");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(useDashboardViewStore.getState().chatColumnIdFilter).toEqual(expect.any(Function));
    useDashboardViewStore.getState().focusChatColumn("unknown");
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([]);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(() => disconnect()).not.toThrow();
    expect(useDashboardViewStore.getState().chatColumnIdFilter).toBeNull();
  });
});

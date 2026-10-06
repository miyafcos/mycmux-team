import { beforeEach, describe, expect, it, vi } from "vitest";
const events = vi.hoisted(() => ({
  listen: vi.fn(async (..._args: unknown[]) => () => {}),
  emitTo: vi.fn(async (..._args: unknown[]) => {}),
  unminimize: vi.fn(async () => {}), show: vi.fn(async () => {}), setFocus: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: events.listen, emitTo: events.emitTo }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main", unminimize: events.unminimize, show: events.show, setFocus: events.setFocus }) }));
vi.mock("../../src/lib/focusController", async importActual => {
  const actual = await importActual<typeof import("../../src/lib/focusController")>();
  return { ...actual, focusController: { ...actual.focusController, request: vi.fn() } };
});
import { listenForOverviewNavigation, navigateOverviewCard, selectOverviewTarget } from "../../src/lib/workOverviewNavigation";
import type { OverviewCard } from "../../src/lib/workOverview";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { focusController } from "../../src/lib/focusController";
beforeEach(() => {
  vi.clearAllMocks();
  events.listen.mockImplementation(async () => () => {});
  events.emitTo.mockImplementation(async () => {});
});
describe("existing overview session navigation", () => {
  it("selects the existing tab/session and rejects stale identities without restarting it", () => {
    const tab = { id: "t", sessionId: "s", agentId: "shell-starter" };
    useWorkspaceListStore.setState({ activeWorkspaceId: "w", workspaces: [{
      id: "w", name: "作業", createdAt: 1, status: "running", gridTemplateId: "1x1",
      panes: [{ id: "p", agentId: "shell-starter", sessionId: "s", activeTabId: "t", tabs: [tab] }], splitColumns: [["p"]],
    }] });
    expect(selectOverviewTarget({ workspaceId: "w", paneId: "p", tab })).toBe(true);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0].sessionId).toBe("s");
    expect(focusController.request).toHaveBeenCalledWith("programmatic", { sessionId: "s", focus: true });
    expect(selectOverviewTarget({ workspaceId: "w", paneId: "p", tab: { ...tab, sessionId: "old" } })).toBe(false);
  });
  it("limits navigation requests to this window rather than any event target", async () => {
    await listenForOverviewNavigation();
    expect(events.listen).toHaveBeenCalledWith("mycmux://overview-open", expect.any(Function), { target: { kind: "Window", label: "main" } });
  });
  it("does not answer a request intended for another window", async () => {
    await listenForOverviewNavigation();
    const handler = events.listen.mock.calls[0][1] as (event: { payload: Record<string, string> }) => Promise<void>;
    await handler({ payload: { requestId: "request-1", replyWindow: "main", targetWindow: "peer", workspaceId: "foreign", paneId: "p", tabId: "t", sessionId: "s" } });
    expect(events.emitTo).not.toHaveBeenCalled();
    expect(focusController.request).not.toHaveBeenCalled();
  });
  it("accepts only the requested window's acknowledgement and unregisters the reply listener", async () => {
    const unlisten = vi.fn();
    let reply!: (event: { payload: { requestId: string; windowLabel: string; ok: boolean } }) => void;
    events.listen.mockImplementation(async (...args: unknown[]) => { reply = args[1] as typeof reply; return unlisten; });
    events.emitTo.mockImplementation(async (...args: unknown[]) => {
      const request = args[2] as { requestId: string };
      reply({ payload: { requestId: request.requestId, windowLabel: "unrelated", ok: false } });
      reply({ payload: { requestId: request.requestId, windowLabel: "peer", ok: true } });
    });
    const card = { windowLabel: "peer", peer: true, workspaceId: "peer-work", paneId: "peer-pane", tab: { id: "peer-tab", sessionId: "peer-session" } } as OverviewCard;
    await expect(navigateOverviewCard(card)).resolves.toBeUndefined();
    expect(events.listen).toHaveBeenCalledWith("mycmux://overview-open-result", expect.any(Function), { target: { kind: "Window", label: "main" } });
    expect(events.emitTo).toHaveBeenCalledWith("peer", "mycmux://overview-open", expect.objectContaining({ targetWindow: "peer", sessionId: "peer-session" }));
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

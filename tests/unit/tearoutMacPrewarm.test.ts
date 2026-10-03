// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ alive: vi.fn(), expect: vi.fn(), has: vi.fn(), dispose: vi.fn() }));
vi.mock("../../src/lib/ipc", () => ({ isSessionAlive: mocks.alive }));
vi.mock("../../src/lib/tearout/sessionAttachment", () => ({
  expectTearoutAttachments: mocks.expect, hasTearoutSessionAttachment: mocks.has,
}));
import { installMacTearoutPrewarm, macPrewarmCandidates, MAC_TEAROUT_PREWARM_LIMIT } from "../../src/lib/tearout/macPrewarm";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import type { Workspace } from "../../src/types";
let stop = () => {};
function workspace(id = "source", count = 2): Workspace {
  return { id, name: id, createdAt: 1, status: "running", gridTemplateId: "1x1", panes: [{
    id: "pane", agentId: "shell", sessionId: "pty-0", activeTabId: "tab-0",
    tabs: Array.from({ length: count }, (_, i) => ({ id: "tab-" + i, agentId: "shell", sessionId: "pty-" + i, type: "terminal" as const })),
  }] };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  useSettingsStore.setState({ nativePaneTearoutEnabled: true, macNativePaneTearoutEnabled: true });
  useWorkspaceListStore.setState({ workspaces: [workspace()], activeWorkspaceId: "source" });
  mocks.alive.mockResolvedValue(true); mocks.has.mockReturnValue(false);
  mocks.expect.mockImplementation(() => ({ ready: Promise.resolve(), dispose: mocks.dispose }));
});
afterEach(() => { stop(); stop = () => {}; vi.useRealTimers(); });
describe("bounded Mac live-session prewarm", () => {
  it("uses only the active owned workspace, unique PTY terminals and the cache bound", () => {
    const source = workspace("source", 20);
    source.panes[0].tabs.unshift({ ...source.panes[0].tabs[0], id: "duplicate" });
    source.panes[0].tabs.push({ ...source.panes[0].tabs[0], id: "web", type: "browser", sessionId: "pty-browser" });
    expect(macPrewarmCandidates([workspace("other"), source], "source"))
      .toEqual(Array.from({ length: MAC_TEAROUT_PREWARM_LIMIT }, (_, i) => "pty-" + i));
    expect(macPrewarmCandidates([source], null)).toEqual([]);
  });
  it.each(["Win32", "MacIntel"])("does not warm default or disabled operation on %s", async platform => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    if (platform === "MacIntel") useSettingsStore.setState({ macNativePaneTearoutEnabled: false });
    stop = installMacTearoutPrewarm(() => false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.alive).not.toHaveBeenCalled(); expect(mocks.expect).not.toHaveBeenCalled();
  });
  it("warms only live existing PTYs and releases the attachment entries after readiness", async () => {
    mocks.alive.mockImplementation(async id => id !== "pty-1");
    stop = installMacTearoutPrewarm(() => false);
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.alive.mock.calls.map(call => call[0])).toEqual(["pty-0", "pty-1"]);
    expect(mocks.expect).toHaveBeenCalledWith(["pty-0"]);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("stopping or disabling during the liveness check prevents any late attach", async () => {
    let live = (_value: boolean) => {};
    mocks.alive.mockReturnValue(new Promise<boolean>(resolve => { live = resolve; }));
    stop = installMacTearoutPrewarm(() => false);
    await vi.advanceTimersByTimeAsync(250);
    useSettingsStore.setState({ macNativePaneTearoutEnabled: false }); stop();
    live(true); await vi.advanceTimersByTimeAsync(1);
    expect(mocks.expect).not.toHaveBeenCalled();
  });
  it("a busy transfer or an existing expectation is never replaced by prewarm", async () => {
    let busy = true;
    stop = installMacTearoutPrewarm(() => busy);
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.alive).not.toHaveBeenCalled();
    busy = false; mocks.has.mockReturnValue(true);
    useWorkspaceListStore.setState(state => ({ workspaces: [...state.workspaces] }));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.expect).not.toHaveBeenCalled();
  });
  it("an unmounted view has a bounded attachment wait", async () => {
    mocks.expect.mockReturnValue({ ready: new Promise<void>(() => {}), dispose: mocks.dispose });
    stop = installMacTearoutPrewarm(() => false);
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});

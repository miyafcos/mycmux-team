import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSocketCommand, SOCKET_COMMAND_NAMES } from "../../src/components/layout/socketCommands";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { disposeLiveTailObserver, LIVE_TAIL_READ_TIMEOUT_MS } from "../../src/stores/liveTailStore";
import type { Workspace } from "../../src/types";

const mocks = vi.hoisted(() => ({ getSessionOutputSnapshot: vi.fn(), getPtyMetadataSnapshot: vi.fn(), getWindowFragments: vi.fn(), hasTerminalBuffer: vi.fn(), getTerminalBufferLines: vi.fn() }));
vi.mock("../../src/lib/ipc", () => mocks);
vi.mock("../../src/components/terminal/XTermWrapper", () => mocks);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); vi.clearAllMocks(); disposeLiveTailObserver();
  mocks.getSessionOutputSnapshot.mockResolvedValue({ session: Date.now() });
  mocks.getPtyMetadataSnapshot.mockResolvedValue({}); mocks.getWindowFragments.mockResolvedValue([]);
  mocks.hasTerminalBuffer.mockReturnValue(true);
  mocks.getTerminalBufferLines.mockReturnValue(["* Thinking\u2026 (1s \u00b7 \u2193 10 tokens)"]);
  useSessionAttentionStore.getState().resetForTests();
  usePaneMetadataStore.setState({ metadata: { session: { agentStatus: "working" } }, volatileMetadata: {} });
  const workspace: Workspace = { id: "workspace", name: "Sample Workspace", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "pane", agentId: "claude", sessionId: "session", activeTabId: "tab", tabs: [{ id: "tab", sessionId: "session", agentId: "claude", agentKind: "claude", label: "Sample Seat", type: "terminal" }] }] };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: "workspace", lastActivePaneByWorkspace: {} });
});
afterEach(() => { disposeLiveTailObserver(); vi.useRealTimers(); });

describe("pane.live_tails control API", () => {
  it("publishes both command names", () => {
    expect(SOCKET_COMMAND_NAMES).toContain("pane.live_tails"); expect(SOCKET_COMMAND_NAMES).toContain("live_tails");
  });
  for (const command of ["pane.live_tails", "live_tails"]) {
    it(`${command} observes before its first response and returns the specified shape`, async () => {
      const result = await handleSocketCommand(command, {}) as { generatedAt: number; tabs: unknown[] };
      expect(result.generatedAt).toBe(Date.now());
      expect(result.tabs).toEqual([expect.objectContaining({ sessionId: "session", workspaceId: "workspace", workspaceName: "Sample Workspace", paneId: "pane", tabId: "tab", name: "Sample Seat", agentKind: "claude", fact: expect.objectContaining({ kind: "alive" }), rows: ["* Thinking\u2026 (1s \u00b7 \u2193 10 tokens)"], lastOutputAt: Date.now(), readable: true, observedAt: Date.now(), waitingForReply: false })]);
      expect(mocks.getTerminalBufferLines).toHaveBeenCalledTimes(1);
    });
  }
  it("returns within the declared bound even when no first observation can complete", async () => {
    mocks.getWindowFragments.mockReturnValue(new Promise(() => {}));
    const result = handleSocketCommand("pane.live_tails", {});
    await vi.advanceTimersByTimeAsync(LIVE_TAIL_READ_TIMEOUT_MS);
    expect(await result).toMatchObject({ generatedAt: Date.now(), tabs: [] });
  });
  it("excludes declared and non-terminal targets without reading them", async () => {
    const ws = useWorkspaceListStore.getState().workspaces[0];
    ws.panes[0].tabs[0].lifecycle = "declared";
    ws.panes[0].tabs.push({ id: "web", sessionId: "web-session", agentId: "web", type: "web" });
    usePaneMetadataStore.setState({ metadata: { session: { agentStatus: "working" }, "web-session": { agentStatus: "working" } } });
    expect(await handleSocketCommand("pane.live_tails", {})).toMatchObject({ tabs: [] });
    expect(mocks.getTerminalBufferLines).not.toHaveBeenCalled();
  });
});

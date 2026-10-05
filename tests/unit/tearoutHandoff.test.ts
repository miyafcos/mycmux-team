// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ label: "peer", listeners: new Map<string, Function>(),
  emitTo: vi.fn(), publish: vi.fn(), join: vi.fn(), write: vi.fn(), consume: vi.fn(),
  windows: vi.fn(async () => [{ label: "main" }, { label: "peer" }]) }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo,
  listen: vi.fn(async (name, callback, options) => { mocks.listeners.set(name, callback); return () => mocks.listeners.delete(name); }) }));
vi.mock("@tauri-apps/api/window", () => ({ getAllWindows: mocks.windows }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => mocks.label, isMainWindow: () => mocks.label === "main" }));
vi.mock("../../src/lib/ipc", async (original) => ({ ...await original<typeof import("../../src/lib/ipc")>(),
  publishSavepoint: mocks.publish, joinSavepointSummary: mocks.join, writeToSession: mocks.write,
  isSessionAlive: vi.fn(async () => true) }));
import { installTearoutHandoff, publishTearoutHandoffDrag } from "../../src/lib/tearout/handoff";
import { capturePaneHandoffSource } from "../../src/lib/paneHandoffRuntime";
import { commitPaneDragDrop } from "../../src/hooks/usePaneDragSource";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useToastStore } from "../../src/stores/toastStore";
import type { Workspace } from "../../src/types";

const endpoint = { workspaceId: "original", paneId: "source-pane",
  tab: { id: "source-tab", sessionId: "source-pty", agentId: "shell", type: "terminal" as const },
  metadata: { agentKind: "claude-codex" as const, agentSessionId: "fake-agent-id", cwd: "C:/demo/source" } };
const context = { id: "drag", label: "child", sourceWindow: "main", endpoint };
const target = { kind: "handoff" as const, workspaceId: "receiver", paneId: "target-pane",
  tabId: "target-tab", sessionId: "target-pty", targetAgentKind: "codex" as const };
const request = { id: "drag", token: "request", requester: "main", approval: { receiver: "peer", token: "painted", target } };
const receiver = (): Workspace => ({ id: "receiver", name: "Receiver", createdAt: 1, status: "running", gridTemplateId: "1x1",
  panes: [{ id: "target-pane", agentId: "shell", sessionId: "target-pty", activeTabId: "target-tab",
    tabs: [{ id: "target-tab", sessionId: "target-pty", agentId: "shell", type: "terminal" }] }] });
let stop: () => void;
const dispatch = (event: string, payload: unknown) => mocks.listeners.get(`mycmux://tearout-handoff-${event}`)!({ payload });
beforeEach(async () => {
  vi.clearAllMocks(); mocks.listeners.clear(); mocks.label = "peer";
  mocks.publish.mockResolvedValue({ bundle_dir: "C:/demo/bundle" });
  mocks.join.mockResolvedValue({ handoff_path: "C:/demo/bundle/handoff.md", cwd_missing: false });
  mocks.write.mockResolvedValue(undefined); mocks.consume.mockReturnValue(true);
  mocks.emitTo.mockResolvedValue(undefined);
  useWorkspaceListStore.setState({ workspaces: [receiver()], activeWorkspaceId: "receiver" });
  usePaneMetadataStore.setState({ metadata: { "target-pty": { agentKind: "codex" } } });
  useToastStore.setState({ toasts: [] });
  const installed = installTearoutHandoff(mocks.consume); stop = installed.dispose; await installed.ready;
  dispatch("context", context);
});
afterEach(() => { stop(); vi.restoreAllMocks(); });
const received = () => vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("main", "mycmux://tearout-handoff-result",
  expect.objectContaining({ token: "request" })), { timeout: 1500 });

describe("receiver-owned native handoff", () => {
  it("uses the original agent session and the receiver's pinned terminal without adopting the source", async () => {
    dispatch("request", request); await received();
    expect(mocks.consume).toHaveBeenCalledWith("painted", target);
    expect(mocks.publish).toHaveBeenCalledWith({ cwd: "C:/demo/source", agentKind: "claude", agentSessionId: "fake-agent-id" });
    expect(mocks.write).toHaveBeenCalledWith("target-pty", expect.stringContaining("C:/demo/bundle/handoff.md"));
    expect(mocks.write.mock.calls[0][1]).not.toMatch(/[\r\n]/);
    expect(useWorkspaceListStore.getState().workspaces.map(ws => ws.id)).toEqual(["receiver"]);
    expect(mocks.emitTo).toHaveBeenCalledWith("main", "mycmux://tearout-handoff-result", { token: "request", ok: true });
  });
  it.each(["not-painted", "wrong-receiver", "wrong-source", "target-changed", "target-agent-changed", "active-tab-changed"])(
    "does not publish or paste for %s", async (mode) => {
      const payload = structuredClone(request);
      if (mode === "not-painted") mocks.consume.mockReturnValue(false);
      if (mode === "wrong-receiver") payload.approval.receiver = "elsewhere";
      if (mode === "wrong-source") payload.requester = "elsewhere";
      const pane = useWorkspaceListStore.getState().workspaces[0].panes[0];
      if (mode === "target-changed") pane.tabs[0].sessionId = "replacement-pty";
      if (mode === "target-agent-changed") usePaneMetadataStore.setState({ metadata: { "target-pty": { agentKind: "claude" } } });
      if (mode === "active-tab-changed") { pane.tabs.push({ id: "other", sessionId: "other-pty", agentId: "shell" }); pane.activeTabId = "other"; }
      dispatch("request", payload); await received();
      expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.emitTo).toHaveBeenCalledWith("main", "mycmux://tearout-handoff-result", { token: "request", ok: false });
    });
  it("handles duplicate delivery once", async () => {
    dispatch("request", request); dispatch("request", request); await received();
    expect(mocks.publish).toHaveBeenCalledTimes(1); expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it("reports a savepoint failure with the existing notice and no paste", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.publish.mockRejectedValueOnce(new Error("synthetic savepoint failure"));
    dispatch("request", request); await received();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.some(toast => toast.message.includes("synthetic savepoint failure"))).toBe(true);
    expect(mocks.emitTo).toHaveBeenCalledWith("main", "mycmux://tearout-handoff-result", { token: "request", ok: false });
  });
  it.each(["publish", "join"])("does not paste after cancellation while %s is pending", async (stage) => {
    let resolve!: (value: any) => void;
    const pending = new Promise(done => { resolve = done; });
    (stage === "publish" ? mocks.publish : mocks.join).mockReturnValueOnce(pending);
    dispatch("request", request);
    await vi.waitFor(() => expect(stage === "publish" ? mocks.publish : mocks.join).toHaveBeenCalled(), { timeout: 1500 });
    dispatch("cancel", { token: "request" });
    resolve(stage === "publish" ? { bundle_dir: "C:/demo/bundle" } : { handoff_path: "C:/demo/bundle/handoff.md" });
    await received(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it("clears drag metadata after the source restores", async () => {
    dispatch("context", { ...context, endpoint: null });
    dispatch("request", request); await received();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("fans out the snapshot to existing windows and removes it on cleanup", async () => {
    const clear = await publishTearoutHandoffDrag(context);
    expect(mocks.emitTo).toHaveBeenCalledWith("main", "mycmux://tearout-handoff-context", context);
    expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-handoff-context", context);
    await clear();
    expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-handoff-context", { ...context, endpoint: null });
  });
  it("captures a background source before it leaves and keeps legacy handoff working", async () => {
    const source = { ...receiver(), id: "original", panes: [{ ...receiver().panes[0], id: "source-pane",
      tabs: [{ id: "front", sessionId: "front-pty", agentId: "shell" }, endpoint.tab], activeTabId: "front" }] };
    useWorkspaceListStore.setState({ workspaces: [source, receiver()] });
    usePaneMetadataStore.setState({ metadata: { "source-pty": endpoint.metadata, "target-pty": { agentKind: "codex" } } });
    const item = { kind: "tab" as const, workspaceId: "original", paneId: "source-pane", tabId: "source-tab", label: "Source" };
    expect(capturePaneHandoffSource(item)).toEqual(endpoint);
    commitPaneDragDrop(item, { kind: "handoff", workspaceId: "receiver", paneId: "target-pane" });
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1), { timeout: 1500 });
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.map(tab => tab.id)).toEqual(["front", "source-tab"]);
  });
});

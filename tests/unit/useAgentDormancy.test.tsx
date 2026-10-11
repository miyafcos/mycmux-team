// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DormancyRecordReceipt, PtyMetadataSnapshot, SessionAttentionKind } from "../../src/lib/ipc";
import type { Workspace } from "../../src/types";

const mocks = vi.hoisted(() => ({ memory: vi.fn(), fragments: vi.fn(), metadata: vi.fn(), scrollback: vi.fn(),
  save: vi.fn(), kill: vi.fn(), lines: vi.fn(), evict: vi.fn(), live: new Map() }));
vi.mock("../../src/lib/ipc", async (original) => ({ ...await original<typeof import("../../src/lib/ipc")>(),
  getAvailableMemoryMiB: mocks.memory, getWindowFragments: mocks.fragments, getPtyMetadataSnapshot: mocks.metadata,
  getSessionScrollback: mocks.scrollback, saveAgentDormancyRecord: mocks.save, killSession: mocks.kill }));
vi.mock("../../src/components/terminal/headlessBuffer", () => ({ getHeadlessBufferLines: mocks.lines }));
vi.mock("../../src/components/terminal/terminalCache", async (original) => ({ ...await original<typeof import("../../src/components/terminal/terminalCache")>(), liveTerms: mocks.live, evictTerminalCache: mocks.evict }));
vi.mock("../../src/lib/agentDormancy", async (original) => ({ ...await original<typeof import("../../src/lib/agentDormancy")>(),
  fingerprintDormancySemanticState: async (lines: string[]) => lines.join("\n") }));
import { useAgentDormancy } from "../../src/hooks/useAgentDormancy";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore, isAttentionUnseen } from "../../src/stores/sessionAttentionStore";
import { useAgentDormancyStore } from "../../src/stores/agentDormancyStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";
import { useSavepointDragStore } from "../../src/stores/savepointDragStore";
import { DEFAULT_DORMANCY_PRESSURE_SETTINGS, markSessionFrontendActivity, clearSessionFrontendActivity } from "../../src/lib/agentDormancy";

const SID = "11111111-1111-4111-8111-111111111111";
const START = 100_000_000;
const receipt: DormancyRecordReceipt = { ptySessionId: "pty", agentKind: "claude", agentSessionId: SID, ptyGeneration: 7, savedAt: START, bytes: 200 };
const snapshot: PtyMetadataSnapshot = { pty: { session_id: "pty", cwd: "example", process_status: "idle",
  process_status_at: START - 1000, process_name: "claude", agent_active: true, agent_kind: "claude", agent_session_id: SID } };
function workspaces(): Workspace[] {
  return ["visible", "background"].map((id) => {
    const tab = id === "background" ? { id: "tab", sessionId: "pty", agentId: "claude", agentKind: "claude" as const, agentSessionId: SID }
      : { id: "shell-tab", sessionId: "shell", agentId: "shell" };
    return { id, name: id, gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [{ id: `${id}-pane`, agentId: tab.agentId, sessionId: tab.sessionId, tabs: [tab], activeTabId: tab.id }] };
  });
}
let host: HTMLDivElement;
let root: Root;
let revision: number;
const originalSettings = useSettingsStore.getState();
function attention(kind: SessionAttentionKind, working = false) {
  revision++;
  useSessionAttentionStore.getState().applyChanged({ v: 2, kind: "event", event: "status.changed", server_epoch: "server", seq: revision,
    session_id: "pty", session_revision: revision, status: { session_epoch: 7, lifecycle: "alive",
      ui_state: working ? "working" : kind === "done" ? "done" : kind === "none" ? "idle" : "waiting",
      attention: { kind, attention_id: kind === "none" ? null : `${kind}-id`, detail: null, state_since: START } } });
}
function Harness() { useAgentDormancy(true); return null; }
async function start(timeOnly = false) {
  if (timeOnly) useSettingsStore.setState({ dormancyPressureSettings: { ...DEFAULT_DORMANCY_PRESSURE_SETTINGS, enabled: false } });
  await act(async () => { root.render(<Harness />); await vi.advanceTimersByTimeAsync(0); });
}
async function advance(minutes: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(minutes * 60_000); });
}
async function approve() {
  await act(async () => { useAgentDormancyStore.getState().approve("pty"); await vi.advanceTimersByTimeAsync(0); });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); vi.resetAllMocks(); mocks.live.clear(); revision = 0;
  mocks.memory.mockResolvedValue(1500); mocks.fragments.mockResolvedValue([]);
  mocks.metadata.mockResolvedValue(snapshot); mocks.scrollback.mockResolvedValue({ data: "stable", startOffset: 0, endOffset: 10 });
  mocks.lines.mockResolvedValue(["Saved reply", "❯ "]); mocks.save.mockResolvedValue(receipt); mocks.kill.mockResolvedValue(undefined);
  useWorkspaceListStore.setState({ workspaces: workspaces(), activeWorkspaceId: "visible" });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSessionAttentionStore.getState().resetForTests(); useAskQuestionStore.getState().resetForTests();
  useAgentDormancyStore.setState({ sampled: false, proposals: [], approvals: {} }); useSavepointDragStore.setState({ item: null });
  useSettingsStore.setState({ dormancyPressureSettings: { ...DEFAULT_DORMANCY_PRESSURE_SETTINGS }, dormancyAllowUnreadCompletion: true });
  clearSessionFrontendActivity("pty"); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); useSettingsStore.setState(originalSettings);
  clearSessionFrontendActivity("pty"); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("dormancy sweep approval and final checks", () => {
  it("only proposes under pressure, even after the normal sixty-minute timeout", async () => {
    await start(); await advance(70);
    expect(useAgentDormancyStore.getState().proposals).toEqual([expect.objectContaining({ sessionId: "pty", stage: "pressure", label: expect.any(String) })]);
    expect(mocks.kill).not.toHaveBeenCalled();
    await approve(); expect(mocks.kill).toHaveBeenCalledWith("pty");
  });
  it("an unavailable memory sample keeps the original time-only timeout", async () => {
    mocks.memory.mockRejectedValue(new Error("unavailable")); await start(); await advance(50);
    expect(useAgentDormancyStore.getState().proposals).toHaveLength(0); expect(mocks.kill).not.toHaveBeenCalled();
    await advance(10); expect(mocks.kill).toHaveBeenCalledWith("pty");
  });
  it.each(["approval", "input", "error", "rate_limited"] as const)("strong pressure protects %s", async (kind) => {
    mocks.memory.mockResolvedValue(512); attention(kind); await start(); await advance(70);
    expect(useAgentDormancyStore.getState().proposals).toHaveLength(0); expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("canonical work protects an apparently idle process", async () => {
    attention("none", true); await start(); await advance(70); expect(mocks.kill).not.toHaveBeenCalled();
    expect(useAgentDormancyStore.getState().proposals).toHaveLength(0);
  });
  it.each(["permission", "output", "conversation", "frontend input"])("invalidates approval when %s changes", async (change) => {
    await start(); await advance(20);
    if (change === "permission") attention("approval");
    if (change === "output") mocks.lines.mockResolvedValue(["New output", "❯ "]);
    if (change === "conversation") mocks.metadata.mockResolvedValue({ pty: { ...snapshot.pty, agent_session_id: "other" } });
    if (change === "frontend input") markSessionFrontendActivity("pty");
    await approve(); expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("a permission request arriving during the very last output read prevents termination", async () => {
    await start(true); await advance(50);
    let reads = 0;
    mocks.scrollback.mockImplementation(async () => {
      if (++reads === 5) attention("approval");
      return { data: "stable", startOffset: 0, endOffset: 10 };
    });
    await advance(10); expect(reads).toBe(5); expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("changing the visible workspace during the last read prevents termination", async () => {
    await start(true); await advance(50);
    let reads = 0;
    mocks.scrollback.mockImplementation(async () => {
      if (++reads === 5) useWorkspaceListStore.setState({ activeWorkspaceId: "background" });
      return { data: "stable", startOffset: 0, endOffset: 10 };
    });
    await advance(10); expect(mocks.kill).not.toHaveBeenCalled();
  });
});

describe("completed process save ordering", () => {
  it("waits for the durable record, persists unread attention, then stops the process", async () => {
    attention("done"); let completeSave!: (value: DormancyRecordReceipt) => void;
    mocks.save.mockReturnValue(new Promise((resolve) => { completeSave = resolve; }));
    mocks.kill.mockImplementation(async () => {
      const state = useSessionAttentionStore.getState();
      expect(state.dormantCompletionsBySession.pty.receipt).toEqual(receipt);
      expect(isAttentionUnseen("tab", state.attentionBySession.pty, state.seenAttentionByTab)).toBe(true);
    });
    await start(true); await advance(60);
    expect(mocks.save).toHaveBeenCalledWith("pty", "claude", SID); expect(mocks.kill).not.toHaveBeenCalled();
    await act(async () => { completeSave(receipt); await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.kill).toHaveBeenCalledOnce();
    expect(useSessionAttentionStore.getState().seenAttentionByTab.has("tab")).toBe(false);
  });
  it("a failed transcript save keeps the process and its unread completion", async () => {
    attention("done"); mocks.save.mockRejectedValue(new Error("disk unavailable")); await start(true); await advance(60);
    expect(mocks.kill).not.toHaveBeenCalled();
    const state = useSessionAttentionStore.getState();
    expect(isAttentionUnseen("tab", state.attentionBySession.pty, state.seenAttentionByTab)).toBe(true);
  });
  it("a mismatched or empty receipt never authorizes termination", async () => {
    attention("done"); mocks.save.mockResolvedValue({ ...receipt, agentSessionId: "other", bytes: 0 });
    await start(true); await advance(60); expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("a failed unread-notification write keeps the process after the transcript is saved", async () => {
    attention("done"); await start(true); await advance(50);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await advance(10); expect(mocks.save).toHaveBeenCalledOnce(); expect(mocks.kill).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("a permission request appearing while the record is saved stays protected", async () => {
    attention("done"); mocks.save.mockImplementation(async () => { attention("approval"); return receipt; });
    await start(true); await advance(60); expect(mocks.kill).not.toHaveBeenCalled();
    expect(useSessionAttentionStore.getState().attentionBySession.pty.kind).toBe("approval");
  });
  it("the unread-completion opt-out prevents both saving and termination", async () => {
    useSettingsStore.setState({ dormancyAllowUnreadCompletion: false }); attention("done");
    await start(true); await advance(70); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled();
  });
});

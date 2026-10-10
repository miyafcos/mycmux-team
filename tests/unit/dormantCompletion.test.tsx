// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DormancyRecordReceipt, FeedSessionPayload, SessionAttentionKind } from "../../src/lib/ipc";
import { useSessionAttentionStore, isAttentionUnseen, DORMANT_COMPLETIONS_STORAGE_KEY, readDormantCompletions } from "../../src/stores/sessionAttentionStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { openDormantCompletionRecord } from "../../src/lib/dormantCompletion";
import { AGENT_DORMANT_DESCRIPTION } from "../../src/lib/agentDormancy";
import { ChatColumn } from "../../src/components/dashboard/ChatColumn";
import { DashboardCardRow } from "../../src/components/dashboard/DashboardCardRow";
import { buildDashboardCards } from "../../src/components/dashboard/dashboardModel";
import { mergeWebPaneTurns } from "../../src/lib/webPaneTranscript";
import type { Workspace } from "../../src/types";

const ipc = vi.hoisted(() => ({ getAgentDormancyRecord: vi.fn() }));
vi.mock("../../src/lib/ipc", async (original) => ({ ...await original<typeof import("../../src/lib/ipc")>(), ...ipc }));
const receipt: DormancyRecordReceipt = { ptySessionId: "pty", agentKind: "claude",
  agentSessionId: "11111111-1111-4111-8111-111111111111", ptyGeneration: 7, savedAt: 1000, bytes: 256 };
const tab = { id: "tab", sessionId: "pty", agentId: "claude", agentKind: "claude" as const, agentSessionId: receipt.agentSessionId };
function payload(kind: SessionAttentionKind = "done", revision = 1, epoch = 7): FeedSessionPayload {
  return { session_id: "pty", session_revision: revision, status: { lifecycle: "alive", session_epoch: epoch,
    ui_state: kind === "done" ? "done" : kind === "none" ? "idle" : "waiting",
    attention: { kind, attention_id: kind === "none" ? null : `${kind}-id`, detail: null, state_since: 100 } } };
}
function change(value: FeedSessionPayload) {
  useSessionAttentionStore.getState().applyChanged({ ...value, v: 2, kind: "event", event: "status.changed", server_epoch: "server", seq: value.session_revision });
}
function preserve() {
  return useSessionAttentionStore.getState().preserveDormantCompletion("pty", ["tab"], receipt, "done-id");
}
function unseen() {
  const store = useSessionAttentionStore.getState();
  return isAttentionUnseen("tab", store.attentionBySession.pty, store.seenAttentionByTab);
}
beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  useSessionAttentionStore.getState().resetForTests();
  useDashboardViewStore.setState({ open: false, chatColumnTabIds: [], pinnedChatColumnTabIds: [], chatColumnLimit: 4, query: "", stateFilter: null });
  vi.clearAllMocks();
  change(payload());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("a completion retained through process dormancy", () => {
  it("stays unread after exit, an empty snapshot, and local read-state hydration", () => {
    expect(preserve()).toBe(true);
    change({ ...payload("none", 2), status: { ...payload("none", 2).status, lifecycle: "exited" } });
    expect(unseen()).toBe(true);
    useSessionAttentionStore.getState().applySnapshot({ server_epoch: "server", seq: 3, sessions: [] });
    expect(unseen()).toBe(true);
    useSessionAttentionStore.getState().resetForTests();
    useSessionAttentionStore.getState().hydrateSeen();
    expect(unseen()).toBe(true);
    expect(readDormantCompletions().pty.receipt).toEqual(receipt);
  });
  it("keeps explicit read state across hydration without marking the notification again", () => {
    preserve();
    useSessionAttentionStore.getState().markSeen("tab", "done-id");
    useSessionAttentionStore.getState().resetForTests();
    useSessionAttentionStore.getState().hydrateSeen();
    expect(unseen()).toBe(false);
  });
  it.each(["input", "approval", "error", "rate_limited"] as const)("does not overwrite new %s attention with an old completion", (kind) => {
    preserve(); change(payload(kind, 2));
    expect(useSessionAttentionStore.getState().attentionBySession.pty.kind).toBe(kind);
    expect(useSessionAttentionStore.getState().dormantCompletionsBySession.pty).toBeUndefined();
    expect(preserve()).toBe(false);
  });
  it("drops the old record binding when a new process epoch appears", () => {
    preserve(); change(payload("none", 2, 8));
    expect(useSessionAttentionStore.getState().dormantCompletionsBySession.pty).toBeUndefined();
  });
  it("refuses a failed notification save so its caller can keep the process", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(preserve()).toBe(false);
    expect(useSessionAttentionStore.getState().dormantCompletionsBySession.pty).toBeUndefined();
    expect(unseen()).toBe(true);
  });
  it("rejects an empty receipt or a changed completion identity", () => {
    const store = useSessionAttentionStore.getState();
    expect(store.preserveDormantCompletion("pty", ["tab"], { ...receipt, bytes: 0 }, "done-id")).toBe(false);
    expect(store.preserveDormantCompletion("pty", ["tab"], receipt, "previous-id")).toBe(false);
    expect(store.preserveDormantCompletion("pty", ["tab"], { ...receipt, ptyGeneration: 8 }, "done-id")).toBe(false);
    expect(localStorage.getItem(DORMANT_COMPLETIONS_STORAGE_KEY)).toBeNull();
  });
  it("opens the saved conversation through the existing dashboard without reading the notification", () => {
    preserve(); useDashboardViewStore.getState().setQuery("unrelated");
    expect(openDormantCompletionRecord(tab, true)).toBe(true);
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, query: "", selectedTabId: "tab", chatColumnTabIds: ["tab"] });
    expect(unseen()).toBe(true);
    expect(openDormantCompletionRecord(tab, false)).toBe(false);
  });
  it("a full pinned dashboard handles the click without falling through to process launch", () => {
    preserve(); useDashboardViewStore.setState({ chatColumnLimit: 2, chatColumnTabIds: ["a", "b"], pinnedChatColumnTabIds: ["a", "b"] });
    expect(openDormantCompletionRecord(tab, true)).toBe(true);
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual(["a", "b"]);
    expect(unseen()).toBe(true);
  });
});

describe("the dormant conversation display", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); preserve(); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  function card() {
    const workspace: Workspace = { id: "ws", name: "Work", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [{ id: "pane", agentId: "claude", sessionId: "pty", tabs: [tab], activeTabId: "tab" }] };
    return buildDashboardCards([workspace], { metadataBySession: {}, volatileMetadataBySession: {},
      attentionBySession: useSessionAttentionStore.getState().attentionBySession, seenAttentionByTab: new Map(),
      stallsBySession: {}, lastLogBySession: {}, lastLogAtBySession: {}, doneMarkByTab: new Map(), hasTerminalBuffer: () => false, now: 1000 })[0];
  }
  it("reads saved replies and exposes the existing resume callback with the process-ended wording", async () => {
    const events = mergeWebPaneTurns([], [{ role: "user", text: "Please inspect" }, { role: "assistant", text: "Saved reply" }], "tab", 1000);
    ipc.getAgentDormancyRecord.mockResolvedValue({ events, telemetryHealth: "ended" });
    const onJump = vi.fn();
    await act(async () => { root.render(<ChatColumn card={card()} events={[]} now={1000} active pinned={false} dragging={false}
      dropPreview={false} motion={null} targetEventId={null} targetEventRequest={0} syntheticSource={null}
      onActivate={vi.fn()} onTogglePin={vi.fn()} onClose={vi.fn()} onFocusComposer={vi.fn()} onJump={onJump} onReorderKeyDown={vi.fn()} />); });
    expect(ipc.getAgentDormancyRecord).toHaveBeenCalledWith(receipt);
    expect(container.textContent).toContain("Saved reply");
    expect(container.textContent).toContain(AGENT_DORMANT_DESCRIPTION);
    const resume = [...container.querySelectorAll("button")].find((button) => button.textContent === "会話を再開")!;
    act(() => resume.click());
    expect(onJump).toHaveBeenCalledOnce();
    expect(unseen()).toBe(true);
  });
  it("shows the same dormancy explanation in the dashboard list", () => {
    act(() => root.render(<DashboardCardRow card={card()} selected={false} open={false} now={1000} hideWorkspaceBadge={false} onSelect={vi.fn()} onJump={vi.fn()} />));
    expect(container.querySelector(`[title="${AGENT_DORMANT_DESCRIPTION}"]`)?.textContent).toBe("休止中");
  });
});

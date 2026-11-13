// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), mappings: vi.fn(), send: vi.fn(), release: vi.fn(), connectRelease: vi.fn(), buildCards: vi.fn(),
  hold: vi.fn((_id: string) => mocks.release), connect: vi.fn(() => mocks.connectRelease),
}));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<typeof import("../../src/lib/ipc")>(), readAgentSessionMappings: mocks.mappings }));
vi.mock("../../src/stores/liveBriefStore", async original => ({ ...await original<typeof import("../../src/stores/liveBriefStore")>(), holdDetailSession: mocks.hold, connectLiveBriefStore: mocks.connect }));
vi.mock("../../src/components/layout/socketCommands", () => ({ handleSocketCommand: mocks.send }));
vi.mock("../../src/components/dashboard/dashboardModel", async original => {
  const actual = await original<typeof import("../../src/components/dashboard/dashboardModel")>();
  mocks.buildCards.mockImplementation(actual.buildDashboardCards);
  return { ...actual, buildDashboardCards: mocks.buildCards };
});
import { AgentTabConversation } from "../../src/components/terminal/AgentTabConversation";
import { TerminalTranscriptPanel } from "../../src/components/terminal/TerminalTranscriptPanel";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useComposerStore } from "../../src/stores/composerStore";
import { useAgentTabViewStore, AGENT_TAB_VIEW_KEY } from "../../src/stores/agentTabViewStore";
import { useAskQuestionStore, ingestAskQuestionLines } from "../../src/stores/askQuestionStore";
import { useUiStore } from "../../src/stores/uiStore";
import { agentTabStrings } from "../../src/components/terminal/agentTabStrings";
import type { LiveSessionBrief, SemanticEventEnvelope, TranscriptPage, ArchiveItem } from "../../src/lib/livebrief";
import { TranscriptHistoryReader } from "../../src/stores/transcriptHistoryStore";
import type { Workspace } from "../../src/types";
const sessionId = "s1", tabId = "t1";
const brief = (patch: Partial<LiveSessionBrief> = {}): LiveSessionBrief => ({
  ptySessionId: sessionId, agentSessionId: "agent-1", agentKind: "grok", ptyInstanceId: "instance", ptyGeneration: 1,
  sourceRevision: 1, ptyInputRevision: 1, serviceEpoch: "epoch", briefRevision: 1,
  task: null, latestInstruction: null, taskSourceEventIds: [], activityKind: null, activityText: null, activitySourceEventId: null,
  checkpoint: null, checkpointEvidenceEventIds: [], pendingInputKind: null, pendingPrompt: null, pendingOptions: [],
  promptEventId: null, promptHash: null, eventSeq: 1, operationalState: "running", telemetryHealth: "live",
  lastEventAt: Date.now(), lastSuccessfulReadAt: Date.now(), updatedAt: Date.now(), ...patch,
});
const events = (): SemanticEventEnvelope[] => [
  { eventId: "user", sourceRevision: 1, occurredAt: Date.now(), sourceByteStart: 0, sourceByteEnd: 10, kind: { type: "userMessage", kind: "taskStart", text: "first request", digest: "user" } },
  { eventId: "reply", sourceRevision: 2, occurredAt: Date.now(), sourceByteStart: 10, sourceByteEnd: 20, kind: { type: "agentMessage", text: "**formatted response**" } },
];
const workspace: Workspace = { id: "w", name: "Fixture", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [
  { id: "p", sessionId, agentId: "grok", activeTabId: tabId, tabs: [{ id: tabId, sessionId, agentId: "grok", agentKind: "grok", type: "terminal", label: "Fixture agent" }] },
] };
let host: HTMLDivElement, root: Root;
let input = createRef<HTMLTextAreaElement>();
const onTerminal = vi.fn(), onEscape = vi.fn(), onVisible = vi.fn();
async function render(options: { visible?: boolean; active?: boolean; kind?: string } = {}) {
  await act(async () => root.render(<div data-agent-tab-surface="true"><AgentTabConversation sessionId={sessionId} tabId={tabId}
    agentKind={options.kind ?? "grok"} visible={options.visible ?? true} active={options.active ?? true} inputRef={input}
    onTerminal={onTerminal} onEscape={onEscape} onVisible={onVisible} /></div>));
  if (host.querySelector(".terminal-transcript-panel--tab")) await act(async () => { await import("../../src/components/terminal/AgentTabConversationControls"); });
}
const panel = () => host.querySelector<HTMLElement>(".terminal-transcript-panel--tab")!;
const archiveItem = (kind: ArchiveItem["kind"], index: number, text: string = kind): ArchiveItem => ({
  occurrenceId: `archive:${index}:0`, sourceStart: String(index * 10), sourceEnd: String(index * 10 + 10), slot: 0,
  kind, timestamp: Date.now(), text, bodyRef: kind === "source" ? "source-body" : null, callId: null, tool: null, target: null, aliases: [],
});
const archivePage = (patch: Partial<TranscriptPage> = {}): TranscriptPage => ({
  readerId: "fix1-reader", sourceGeneration: "generation", snapshotEnd: "20000",
  items: [archiveItem("assistant", 0, "**archive response**")], olderCursor: null, newerCursor: "tail", latestCursor: "latest",
  scanContinuation: null, reachedStart: true, reachedFence: true, diagnostics: [], ...patch,
});
function setupArchive(page = archivePage()) {
  useSettingsStore.setState({ conversationHistoryMode: "manual" });
  mocks.mappings.mockResolvedValue({ [sessionId]: { agent_kind: "claude", session_id: "agent-1" } });
  mocks.invoke.mockImplementation(async command => command === "open_transcript_history" ? page
    : command === "refresh_transcript_history_tail" ? { ...page, items: [] }
    : command === "heartbeat_transcript_history" ? { hasNewBytes: false } : null);
}
function traceReader() {
  const visible = vi.spyOn(TranscriptHistoryReader.prototype, "setVisible");
  return () => visible.mock.contexts[0] as TranscriptHistoryReader;
}
async function renderReadableArchive() {
  await render({ kind: "claude" });
  await act(async () => vi.advanceTimersByTimeAsync(20));
  await render({ kind: "claude" });
  expect(panel()).not.toBeNull(); expect(input.current).not.toBeNull();
}
async function key(target: Element, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
  await act(async () => target.dispatchEvent(event));
  return event;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue(null);
  mocks.mappings.mockReset(); mocks.mappings.mockResolvedValue({});
  mocks.send.mockReset(); mocks.send.mockResolvedValue({ confirmed: true });
  for (const mock of [mocks.hold, mocks.release, mocks.connect, mocks.connectRelease, mocks.buildCards, onTerminal, onEscape, onVisible]) mock.mockClear();
  useSettingsStore.setState({ conversationHistoryMode: "legacy", agentTabContent: "conversation" });
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: "w" });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  useSessionAttentionStore.getState().resetForTests(); useAskQuestionStore.getState().resetForTests();
  useLiveBriefStore.getState().reset();
  useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief() }, eventsBySession: { [sessionId]: events() }, eventsFetchedAtBySession: { [sessionId]: Date.now() } });
  useDashboardViewStore.setState({ open: false, userTurnRequests: {}, userTurnRequestSeq: 0 });
  useComposerStore.setState({ draftBySession: {}, mentionTokensBySession: {}, commandKindBySession: {}, dashboardOptimisticMessagesBySession: {}, dashboardRetryBySession: {} });
  useAgentTabViewStore.setState({ views: {} });
  useUiStore.setState({ activePaneId: sessionId });
  input = createRef<HTMLTextAreaElement>();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("full-tab conversation", () => {
  it("renders formatted history, a reply field and a terminal button without a close button", async () => {
    await render();
    expect(panel()).not.toBeNull();
    expect(host.querySelector("strong")?.textContent).toBe("formatted response");
    expect(input.current).not.toBeNull(); expect(document.activeElement).toBe(input.current);
    expect(host.querySelector(".terminal-transcript-panel__close")).toBeNull();
    expect(host.querySelector(`button[aria-label="${agentTabStrings.toTerminal}"]`)).not.toBeNull();
    expect(host.querySelector(".cmux-dashboard-next-actions")).toBeNull();
    expect(host.querySelector("[data-transcript-search-input]")).toBeNull(); // Grok has the existing recent-event reader only.
  });
  it("focuses a newly selected tab, keeps editor/search Esc local, and forwards only a non-IME body Esc", async () => {
    await render({ active: false, kind: "claude" });
    expect(document.activeElement).not.toBe(input.current);
    await render({ kind: "claude" }); expect(document.activeElement).toBe(input.current);
    await key(input.current!, "Escape"); expect(onEscape).not.toHaveBeenCalled();
    panel().focus();
    await key(panel(), "Escape", { isComposing: true }); expect(onEscape).not.toHaveBeenCalled();
    const event = await key(panel(), "Escape"); expect(event.defaultPrevented).toBe(true);
    expect(onEscape).toHaveBeenCalledTimes(1);
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${agentTabStrings.search}"]`)!.click());
    const search = host.querySelector<HTMLInputElement>("[data-transcript-search-input]")!;
    search.focus(); await key(search, "Escape"); expect(onEscape).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input.current);
  });
  it("preserves a settings dialog's focus when records become readable", async () => {
    useLiveBriefStore.setState({ briefsBySession: {}, eventsBySession: {} });
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog");
    const field = document.createElement("input"); dialog.append(field); document.body.append(dialog); field.focus();
    try {
      await render();
      await act(async () => useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief() }, eventsBySession: { [sessionId]: events() } }));
      expect(panel()).not.toBeNull(); expect(document.activeElement).toBe(field);
    } finally { dialog.remove(); }
  });
  it("copies selected text without writing and ignores Ctrl+C without a selection", async () => {
    await render(); panel().focus();
    expect((await key(panel(), "c", { ctrlKey: true })).defaultPrevented).toBe(true);
    const range = document.createRange(); range.selectNodeContents(host.querySelector("strong")!);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    expect((await key(panel(), "c", { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(window.getSelection()?.toString()).toContain("formatted response");
    expect(onEscape).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it("redirects body text to the draft and leaves app shortcuts untouched", async () => {
    await render({ kind: "claude" }); panel().focus();
    await key(panel(), "/");
    expect(input.current!.value).toBe("/"); expect(document.activeElement).toBe(input.current);
    const global = vi.fn(); window.addEventListener("keydown", global);
    try {
      const event = await key(panel(), "w", { ctrlKey: true, altKey: true });
      expect(event.defaultPrevented).toBe(false); expect(global).toHaveBeenCalledTimes(1);
      await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${agentTabStrings.search}"]`)!.click());
      const search = host.querySelector<HTMLInputElement>("[data-transcript-search-input]")!;
      await key(search, "w", { ctrlKey: true, altKey: true }); expect(global).toHaveBeenCalledTimes(2);
    } finally { window.removeEventListener("keydown", global); }
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("uses the dashboard send and confirmation route with optimistic messages and echo collapse", async () => {
    await render();
    let resolve!: (value: unknown) => void; mocks.send.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await act(async () => useComposerStore.getState().setDraft(sessionId, "send from tab"));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="送信"]')!.click());
    expect(mocks.send).toHaveBeenCalledWith("pane.send_text", { sessionId, text: "\x1b[200~send from tab\x1b[201~", enter: true });
    expect(host.querySelector("[data-delivery-state=sending]")?.textContent).toContain("send from tab");
    await act(async () => resolve({ confirmed: true }));
    expect(host.querySelector("[data-delivery-state=sent]")).not.toBeNull();
    await act(async () => useLiveBriefStore.setState({ eventsBySession: { [sessionId]: [...events(), { ...events()[0], eventId: "echo", occurredAt: Date.now() + 100, kind: { type: "userMessage", kind: "taskStart", text: "send from tab", digest: "echo" } }] } }));
    expect(host.querySelector("[data-dashboard-optimistic-message]")).toBeNull();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("collapses the optimistic bubble when a human queued-command archive row arrives", async () => {
    vi.useFakeTimers();
    setupArchive();
    await renderReadableArchive();
    const text = "Add the final word.";
    await act(async () => {
      const id = useComposerStore.getState().addDashboardOptimisticMessage(sessionId, text);
      useComposerStore.getState().setDashboardOptimisticMessageState(sessionId, id, "sent", "unconfirmed");
    });
    expect(host.querySelectorAll("[data-dashboard-optimistic-message]")).toHaveLength(1);
    // enqueue supplies acceptance only; until absorption there is no archive row.
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(host.querySelectorAll("[data-dashboard-optimistic-message]")).toHaveLength(1);
    const queued = { ...archiveItem("user", 2000, text), timestamp: Date.now() + 100 };
    mocks.invoke.mockImplementation(async command => command === "refresh_transcript_history_tail"
      ? archivePage({ items: [queued], snapshotEnd: queued.sourceEnd, newerCursor: "tail-after-queue" })
      : command === "heartbeat_transcript_history" ? { hasNewBytes: false } : null);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    await vi.waitFor(() => expect(host.querySelector("[data-dashboard-optimistic-message]")).toBeNull(), { timeout: 5000 });
    expect(host.querySelectorAll('[data-archive-row="' + queued.occurrenceId + '"]')).toHaveLength(1);
    expect(host.querySelector('[data-archive-row="' + queued.occurrenceId + '"]')?.textContent).toContain(text);
    expect(useComposerStore.getState().dashboardOptimisticMessagesBySession[sessionId]).toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("keeps a possibly written message unconfirmed and never retries it automatically", async () => {
    mocks.send.mockResolvedValue({ sent: false, writeMayHaveOccurred: true, message: "delivery unknown" });
    await render();
    await act(async () => useComposerStore.getState().setDraft(sessionId, "uncertain delivery"));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="送信"]')!.click());
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-delivery-state=sent]")?.textContent).toContain("uncertain delivery");
    expect(host.querySelector(".cmux-dashboard-optimistic-retry")).toBeNull();
    expect(host.textContent).toContain("delivery unknown");
    await render();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("answers approvals through the existing QuestionCard intervention and offers terminal-only input once", async () => {
    const pending = brief({ operationalState: "needsHuman", pendingPrompt: "Allow operation?", pendingInputKind: "permission", pendingOptions: [{ id: "yes", label: "Allow" }], promptEventId: "question", promptHash: "hash" });
    useLiveBriefStore.setState({ briefsBySession: { [sessionId]: pending } }); mocks.invoke.mockResolvedValue({ type: "confirmed" });
    await render();
    expect(host.querySelector("[data-dashboard-question]")).not.toBeNull();
    expect(host.querySelector(".agent-tab-terminal-required")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".cmux-dashboard-qcard-option")!.click());
    expect(mocks.invoke).toHaveBeenCalledWith("send_intervention", expect.objectContaining({ action: { type: "choose", optionId: "yes" } }));
    await act(async () => useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief({ pendingInputKind: "choice" }) } }));
    const terminal = host.querySelector<HTMLButtonElement>(".agent-tab-terminal-required")!;
    expect(terminal.textContent).toBe(agentTabStrings.terminalRequired);
    await act(async () => terminal.click()); expect(onTerminal).toHaveBeenCalledTimes(1);
  });
  it("keeps a slash-shaped answer on the existing intervention route", async () => {
    useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief({
      operationalState: "needsHuman", pendingInputKind: "freeText", pendingPrompt: "Reply here", promptEventId: "slash-question", promptHash: "slash-hash",
    }) } });
    mocks.invoke.mockResolvedValue({ type: "confirmed" });
    await render();
    await act(async () => useComposerStore.getState().setDraft(sessionId, "/cost"));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="送信"]')!.click());
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("send_intervention", expect.objectContaining({ action: { type: "replyText", text: "/cost" } })), { timeout: 5000 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
    expect(host.querySelector("[data-dashboard-optimistic-message]")).toBeNull();
    expect(input.current!.value).toBe("");
  });
  it("keeps an ended conversation's old approval out of the active question area", async () => {
    useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief({ telemetryHealth: "ended", pendingPrompt: "Old approval", pendingInputKind: "permission", promptEventId: "old", promptHash: "old" }) } });
    await render();
    expect(panel()).not.toBeNull(); expect(host.querySelector("[data-dashboard-question]")).toBeNull();
    expect(host.querySelector(".agent-tab-terminal-required")).toBeNull();
  });
  it("renders the canonical screen question card without a terminal-only notice", async () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/askQuestionScreens.json"), "utf8")).single;
    ingestAskQuestionLines(sessionId, fixture);
    await render();
    expect(host.querySelector("[data-ask-question-session]")).not.toBeNull();
    expect(host.querySelector(".agent-tab-terminal-required")).toBeNull();
  });
  it("falls back without changing the remembered choice and restores after readable evidence arrives", async () => {
    useAgentTabViewStore.getState().setView(tabId, "conversation");
    const stored = localStorage.getItem(AGENT_TAB_VIEW_KEY);
    useLiveBriefStore.setState({ briefsBySession: {}, eventsBySession: {} });
    await render(); expect(host.querySelector("[data-agent-tab-fallback=empty]")).not.toBeNull();
    expect(panel()).toBeNull();
    await act(async () => useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief() }, eventsBySession: { [sessionId]: events() } }));
    expect(panel()).not.toBeNull();
    expect(useAgentTabViewStore.getState().views[tabId]).toBe("conversation");
    expect(localStorage.getItem(AGENT_TAB_VIEW_KEY)).toBe(stored);
  });
  it("shows a new bound Claude tab as empty and restores its remembered conversation after the record arrives", async () => {
    vi.useFakeTimers(); setupArchive();
    useAgentTabViewStore.getState().setView(tabId, "conversation");
    const stored = localStorage.getItem(AGENT_TAB_VIEW_KEY);
    useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief({ agentKind: "claude", telemetryHealth: "unavailable", telemetryDetail: "recordNotFound" }) }, eventsBySession: { [sessionId]: [] } });
    await render({ kind: "claude" });
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(host.querySelector("[data-agent-tab-fallback=empty]")?.textContent).toBe(agentTabStrings.fallback.empty);
    expect(panel()).toBeNull();
    expect(onVisible).toHaveBeenLastCalledWith(false, false);
    await act(async () => useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief({ agentKind: "claude" }) }, eventsBySession: { [sessionId]: events() } }));
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(panel()).not.toBeNull();
    expect(host.textContent).toContain("archive response");
    expect(onVisible).toHaveBeenLastCalledWith(true, false);
    expect(useAgentTabViewStore.getState().views[tabId]).toBe("conversation");
    expect(localStorage.getItem(AGENT_TAB_VIEW_KEY)).toBe(stored);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each([undefined, 0, 37])("positions fallback at the same content top as the conversation (%s)", async top => {
    useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief({ telemetryHealth: "unavailable", telemetryDetail: "recordNotFound" }) }, eventsBySession: { [sessionId]: [] } });
    const fullTab = { card: null, cards: [], active: false, inputRef: input, onEscape, onVisible, top };
    await act(async () => root.render(<TerminalTranscriptPanel sessionId={sessionId} tabId={tabId} agentKind="grok" onClose={onTerminal} fullTab={fullTab} />));
    const fallback = host.querySelector<HTMLElement>("[data-agent-tab-fallback=empty]")!;
    expect(fallback.style.top).toBe((top ?? 0) + "px");
    expect(panel()).toBeNull();
    await act(async () => useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief() }, eventsBySession: { [sessionId]: events() } }));
    expect(panel().style.top).toBe(fallback.style.top);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("takes detail holds only while visible, releases on hidden windows/dashboard, and leaves dashboard turn requests alone", async () => {
    await render({ visible: false }); expect(mocks.hold).not.toHaveBeenCalled();
    await render(); expect(mocks.hold).toHaveBeenCalledWith(sessionId);
    await act(async () => useDashboardViewStore.setState({ open: true }));
    expect(mocks.release).toHaveBeenCalledTimes(1);
    await act(async () => useDashboardViewStore.getState().requestUserTurnStep(tabId, -1));
    expect(useDashboardViewStore.getState().userTurnRequests[tabId]).toBeDefined();
    expect(panel()).toBeNull();
    await act(async () => useDashboardViewStore.setState({ open: false }));
    expect(mocks.hold).toHaveBeenCalledTimes(2);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.release).toHaveBeenCalledTimes(2);
    expect(panel()).toBeNull();
  });
  it("holds exactly nine visible sessions and no hidden sessions", async () => {
    const ids = Array.from({ length: 9 }, (_, index) => `nine-${index}`);
    const w: Workspace = { ...workspace, panes: ids.map(id => ({ id, sessionId: id, agentId: "grok", activeTabId: id,
      tabs: [{ id, sessionId: id, agentId: "grok", agentKind: "grok", type: "terminal" }] })) };
    useWorkspaceListStore.setState({ workspaces: [w] });
    useLiveBriefStore.setState({
      briefsBySession: Object.fromEntries(ids.map(id => [id, brief({ ptySessionId: id })])),
      eventsBySession: Object.fromEntries(ids.map(id => [id, events()])),
    });
    const inputs = ids.map(() => createRef<HTMLTextAreaElement>());
    const draw = (visible: boolean) => <div data-agent-tab-surface="true">{ids.map((id, index) => <AgentTabConversation key={id}
      sessionId={id} tabId={id} agentKind="grok" visible={visible} active={index === 0} inputRef={inputs[index]}
      onTerminal={onTerminal} onEscape={onEscape} onVisible={onVisible} />)}</div>;
    await act(async () => root.render(draw(true)));
    expect(host.querySelectorAll(".terminal-transcript-panel--tab")).toHaveLength(9);
    expect(mocks.hold.mock.calls.map(([id]) => id).sort()).toEqual([...ids].sort());
    expect(mocks.buildCards).toHaveBeenCalledTimes(1);
    mocks.buildCards.mockClear();
    await act(async () => usePaneMetadataStore.setState({ lastLog: { [ids[0]]: "new output" }, lastLogAt: { [ids[0]]: Date.now() } }));
    expect(mocks.buildCards).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll(".terminal-transcript-panel--tab")).toHaveLength(9);
    await act(async () => root.render(draw(false)));
    expect(mocks.release).toHaveBeenCalledTimes(9);
    expect(host.querySelectorAll(".terminal-transcript-panel--tab")).toHaveLength(0);
  });
  it("opens an archive only for visible content and recovers a missing record automatically", async () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ conversationHistoryMode: "manual" });
    mocks.mappings.mockResolvedValue({ [sessionId]: { agent_kind: "claude", session_id: "agent-1" } });
    const page: TranscriptPage = { readerId: "tab-reader", sourceGeneration: "generation", snapshotEnd: "20",
      items: [{ occurrenceId: "a:0:0", sourceStart: "0", sourceEnd: "20", slot: 0, kind: "assistant", timestamp: Date.now(), text: "**archive response**", bodyRef: null, callId: null, tool: null, target: null, aliases: [] }],
      olderCursor: null, newerCursor: "tail", latestCursor: "latest", scanContinuation: null, reachedStart: true, reachedFence: true, diagnostics: [] };
    let missing = true;
    mocks.invoke.mockImplementation(async command => {
      if (command === "open_transcript_history") { if (missing) throw new Error("recordMissing"); return page; }
      if (command === "heartbeat_transcript_history") return { hasNewBytes: false };
      if (command === "refresh_transcript_history_tail") return { ...page, items: [] };
      return null;
    });
    await render({ visible: false, kind: "claude" });
    expect(mocks.mappings).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled();
    await render({ kind: "claude" });
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(host.querySelector("[data-agent-tab-fallback=missing]")).not.toBeNull();
    missing = false;
    await act(async () => vi.advanceTimersByTimeAsync(3100));
    await vi.waitFor(() => expect(panel()).not.toBeNull(), { timeout: 5000 });
    expect(host.textContent).toContain("archive response");
  });
  it("shows mixed Claude metadata without reopening a healthy archive for page diagnostics", async () => {
    vi.useFakeTimers();
    const reopen = vi.spyOn(TranscriptHistoryReader.prototype, "reopen");
    const mixed = archivePage({ items: [archiveItem("user", 0, "request"),
      ...Array.from({ length: 1000 }, (_, index) => archiveItem("diagnostic", index + 1)),
      archiveItem("source", 1001), archiveItem("assistant", 1002, "**archive response**")],
      diagnostics: [{ reason: "incompleteRecord", sourceStart: "20000", sourceEnd: "20001" }] });
    setupArchive(mixed);
    await renderReadableArchive();
    expect(host.querySelector("[data-agent-tab-fallback]")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(reopen).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "open_transcript_history")).toHaveLength(1);
    expect(host.textContent).toContain("archive response");
  });
  it("backs off failed reads at 3, 6, 12, 24, 48, 60 and 60 seconds and resets after success", async () => {
    vi.useFakeTimers();
    const reader = traceReader();
    setupArchive();
    const healthy = mocks.invoke.getMockImplementation()!;
    let failed = true;
    const times: number[] = [];
    mocks.invoke.mockImplementation(async (command, ...args) => {
      if (command === "open_transcript_history") {
        times.push(Date.now());
        if (failed) throw new Error("recordMissing");
      }
      return healthy(command, ...args);
    });
    await render({ kind: "claude" });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(times).toHaveLength(1);
    for (const delay of [3000, 6000, 12000, 24000, 48000, 60000, 60000]) {
      const before = times.length;
      await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
      expect(times).toHaveLength(before);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(times).toHaveLength(before + 1);
      expect(times.at(-1)! - times.at(-2)!).toBe(delay);
    }
    failed = false;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await act(async () => vi.advanceTimersByTimeAsync(20));
    await render({ kind: "claude" });
    expect(panel()).not.toBeNull();
    failed = true;
    await act(async () => reader().freeze("permissionDenied"));
    const before = times.length;
    await act(async () => vi.advanceTimersByTimeAsync(2999));
    expect(times).toHaveLength(before);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(times).toHaveLength(before + 1);
  });
  it("keeps the last readable rows, panel, draft and reply focus during same-descriptor loading", async () => {
    vi.useFakeTimers();
    const reader = traceReader();
    setupArchive();
    await renderReadableArchive();
    await act(async () => { useComposerStore.getState().setDraft(sessionId, "draft in progress"); input.current!.focus(); });
    const previousPanel = panel(), previousInput = input.current;
    let complete!: (page: TranscriptPage) => void;
    const healthy = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, ...args) => command === "open_transcript_history"
      ? new Promise(resolve => { complete = resolve; }) : healthy(command, ...args));
    await act(async () => reader().reopen());
    expect(reader().snapshot.status).toBe("opening");
    expect(reader().snapshot.items).toHaveLength(0);
    expect(panel()).toBe(previousPanel);
    expect(host.textContent).toContain("archive response");
    expect(input.current).toBe(previousInput); expect(input.current!.value).toBe("draft in progress");
    expect(document.activeElement).toBe(previousInput);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(panel()).toBe(previousPanel); expect(document.activeElement).toBe(previousInput);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "open_transcript_history")).toHaveLength(2);
    await act(async () => complete(archivePage({ readerId: "reopened-reader", items: [archiveItem("assistant", 0, "updated archive response")] })));
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(host.textContent).toContain("updated archive response");
    expect(panel()).toBe(previousPanel); expect(document.activeElement).toBe(previousInput);
  });
  it("removes the retained conversation immediately when the descriptor changes", async () => {
    vi.useFakeTimers();
    setupArchive();
    await renderReadableArchive();
    const previousInput = input.current;
    const healthy = mocks.invoke.getMockImplementation()!;
    let complete!: (page: TranscriptPage) => void;
    mocks.invoke.mockImplementation((command, ...args) => command === "open_transcript_history"
      ? new Promise(resolve => { complete = resolve; }) : healthy(command, ...args));
    mocks.mappings.mockResolvedValue({ [sessionId]: { agent_kind: "claude", session_id: "agent-2" } });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(panel()).toBeNull(); expect(input.current).toBeNull();
    expect(previousInput!.isConnected).toBe(false);
    expect(host.textContent).not.toContain("archive response");
    expect(host.querySelector("[data-agent-tab-fallback]")).not.toBeNull();
    await act(async () => complete(archivePage({ readerId: "new-binding-reader", items: [archiveItem("assistant", 0, "new binding response")] })));
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(host.textContent).toContain("new binding response");
  });
  it.each(["missing", "unsupported", "unreadable", "empty", "partial"])("clears retained rows after a confirmed %s fallback", async reason => {
    vi.useFakeTimers();
    const reader = traceReader();
    setupArchive();
    await renderReadableArchive();
    const healthy = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, ...args) => {
      if (command === "open_transcript_history") {
        if (reason === "missing") throw new Error("recordMissing");
        if (reason === "unsupported") throw new Error("unsupportedAgent");
        if (reason === "unreadable") throw new Error("permissionDenied");
        return archivePage({ items: reason === "partial" ? [archiveItem("diagnostic", 0)] : [] });
      }
      return healthy(command, ...args);
    });
    await act(async () => reader().reopen());
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(host.querySelector(`[data-agent-tab-fallback="${reason}"]`)).not.toBeNull();
    expect(panel()).toBeNull();
    let complete!: (page: TranscriptPage) => void;
    mocks.invoke.mockImplementation((command, ...args) => command === "open_transcript_history"
      ? new Promise(resolve => { complete = resolve; }) : healthy(command, ...args));
    await act(async () => reader().reopen());
    expect(reader().snapshot.status).toBe("opening"); expect(panel()).toBeNull();
    await act(async () => complete(archivePage()));
    await act(async () => vi.advanceTimersByTimeAsync(20));
  });
  it("provides explicit wrapping rules for 181, 360 and 720px without changing overlay mode classes", async () => {
    const css = readFileSync(resolve(import.meta.dirname, "../../src/components/terminal/AgentTabConversation.css"), "utf8");
    expect(css).toContain("container: agent-conversation / inline-size");
    expect(css).toContain("@container agent-conversation (max-width: 360px)");
    expect(css).toContain("@container agent-conversation (max-width: 220px)");
    expect(css).toContain("overflow-wrap: anywhere"); expect(css).toContain("overflow-x: auto"); expect(css).toContain("overflow-x: hidden");
    await render();
    for (const width of [181, 360, 720]) {
      host.style.width = `${width}px`; expect(panel().classList.contains("terminal-transcript-panel--tab")).toBe(true);
    }
  });
});

describe("reading-view toolbar and attention", () => {
  it("keeps the view switch, navigation and optional search in one header", async () => {
    await render({ kind: "claude" });
    const head = host.querySelector(".terminal-transcript-panel__head")!;
    const switches = head.querySelectorAll(".agent-tab-view-switch button");
    expect([...switches].map(button => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(host.querySelector("[data-transcript-search-input]")).toBeNull();
    expect(head.querySelector(".cmux-dashboard-user-turn-nav")).not.toBeNull();
    await act(async () => head.querySelector<HTMLButtonElement>(`[aria-label="${agentTabStrings.search}"]`)!.click());
    const search = head.querySelector<HTMLInputElement>("[data-transcript-search-input]")!;
    expect(document.activeElement).toBe(search);
    expect(head.querySelector(".terminal-transcript-search__controls")).toBeNull();
    expect(head.querySelector("[data-transcript-search-status]")).toBeNull();
    await key(search, "Escape");
    expect(head.querySelector("[data-transcript-search-input]")).toBeNull();
    expect(document.activeElement).toBe(input.current);
    expect(onEscape).not.toHaveBeenCalled();
    await act(async () => head.querySelector<HTMLButtonElement>(`[aria-label="${agentTabStrings.search}"]`)!.click());
    await act(async () => head.querySelector<HTMLButtonElement>(`[aria-label="${agentTabStrings.closeSearch}"]`)!.click());
    expect(head.querySelector("[data-transcript-search-input]")).toBeNull();
    expect(document.activeElement).toBe(input.current);
  });
  it("shows search navigation and counts only after a query is typed", async () => {
    vi.useFakeTimers(); setupArchive();
    await renderReadableArchive();
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${agentTabStrings.search}"]`)!.click());
    const search = host.querySelector<HTMLInputElement>("[data-transcript-search-input]")!;
    expect(host.querySelector(".terminal-transcript-search__controls")).toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "response");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector('.terminal-transcript-search__controls [aria-label="前へ"]')).not.toBeNull();
    expect(host.querySelector('.terminal-transcript-search__controls [aria-label="次へ"]')).not.toBeNull();
    expect(host.querySelector("[data-transcript-search-status]")).not.toBeNull();
    await key(search, "Escape");
    expect(document.activeElement).toBe(input.current);
  });
  it.each(["pendingInputKind", "pendingPrompt", "input", "approval"])("uses the same %s question condition for its answer-waiting strip", async condition => {
    if (condition === "pendingInputKind") useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief({ pendingInputKind: "permission" }) } });
    else if (condition === "pendingPrompt") useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief({ pendingPrompt: "Unique question text" }) } });
    else useSessionAttentionStore.setState({ attentionBySession: { [sessionId]: { kind: condition } as never } });
    await render();
    expect(host.querySelector(".agent-tab-live-strip")!.textContent).toBe(agentTabStrings.liveAnswerWaiting);
    expect(host.querySelector(".agent-tab-live-strip")!.textContent).not.toContain("Unique question text");
  });
  it("keeps old questions and their strip out of an ended conversation", async () => {
    useLiveBriefStore.setState({ briefsBySession: { [sessionId]: brief({ telemetryHealth: "ended", pendingPrompt: "Old question" }) } });
    await render();
    expect(host.querySelector(".agent-tab-live-strip")).toBeNull();
  });
  it("marks new replies briefly at the bottom and offers new records while reading above it", async () => {
    vi.useFakeTimers();
    await render();
    const log = host.querySelector<HTMLElement>("[role=log]")!;
    const reply = (id: string) => ({ ...events()[1], eventId: id, kind: { type: "agentMessage", text: id } });
    await act(async () => useLiveBriefStore.setState({ eventsBySession: { [sessionId]: [...events(), reply("new reply")] as never } }));
    expect(host.querySelector('[data-agent-tab-arrival="true"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(host.querySelector('[data-agent-tab-arrival="true"]')).toBeNull();
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 500 } });
    await act(async () => { log.scrollTop = 100; log.dispatchEvent(new Event("scroll", { bubbles: false })); });
    await act(async () => useLiveBriefStore.setState({ eventsBySession: { [sessionId]: [...events(), reply("new reply"), reply("while reading")] as never } }));
    expect(log.scrollTop).toBe(100);
    expect(host.querySelector('[data-agent-tab-arrival="true"]')).toBeNull();
    expect(host.querySelector(".agent-tab-new-records")!.textContent).toContain(agentTabStrings.newRecords);
    await act(async () => host.querySelector<HTMLButtonElement>(".agent-tab-new-records")!.click());
    expect(host.querySelector(".agent-tab-new-records")).toBeNull();
  });
});

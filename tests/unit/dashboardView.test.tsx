// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  syncDashboardEvents: vi.fn(),
  stopEventPolling: vi.fn(),
  onSessionStatusChanged: vi.fn(() => Promise.resolve(() => {})),
  handleSocketCommand: vi.fn(),
}));

vi.mock("../../src/stores/liveBriefStore", async () => {
  const actual = await vi.importActual<typeof import("../../src/stores/liveBriefStore")>("../../src/stores/liveBriefStore");
  return {
    ...actual,
    connectLiveBriefStore: () => () => {},
    syncDashboardEvents: mocks.syncDashboardEvents,
    stopEventPolling: mocks.stopEventPolling,
  };
});

vi.mock("../../src/lib/focusController", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/focusController")>("../../src/lib/focusController");
  return {
    ...actual,
    focusController: { request: vi.fn(), focusSessionSoon: vi.fn() },
  };
});

vi.mock("../../src/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/ipc")>("../../src/lib/ipc");
  return { ...actual, onSessionStatusChanged: mocks.onSessionStatusChanged };
});

vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  getTerminalWriteCounter: () => 0,
  hasTerminalBuffer: () => true,
}));

vi.mock("../../src/components/dashboard/WatchStatusRow", () => ({
  WatchStatusRow: () => <div data-watch-status="true" />,
}));

import { clampDashboardChatDropIndicatorOffset, DashboardView } from "../../src/components/dashboard/DashboardView";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { useInterventionFeedbackStore } from "../../src/components/dashboard/interventionRouting";
import { createBatch, sealBatch } from "../../src/lib/dispatchBatch";
import { logicalSessionId } from "../../src/lib/logicalSessionId";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import type { SemanticEventEnvelope } from "../../src/lib/livebrief";
import {
  DASHBOARD_MINIMAP_DEFAULT_WIDTH,
  DASHBOARD_MINIMAP_MIN_WIDTH,
  DASHBOARD_MINIMAP_STORAGE_KEY,
  dashboardMinimapMaxWidth,
  useDashboardViewStore,
} from "../../src/stores/dashboardViewStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { __resetReportInboxStoreForTests, useReportInboxStore } from "../../src/stores/reportInboxStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useRecentInputStore } from "../../src/stores/recentInputStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { useSessionAttentionStore, type SessionAttention } from "../../src/stores/sessionAttentionStore";
import { useStallStore } from "../../src/stores/stallStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { PaneTab, Workspace } from "../../src/types";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");

function tab(id: string, sessionId: string, label: string): PaneTab {
  return { id, sessionId, agentId: "codex", agentKind: "codex", label, type: "terminal" };
}

function workspace(tabs: PaneTab[], activeTabId = tabs[0].id): Workspace {
  return {
    id: "ws-a",
    name: "Workspace A",
    gridTemplateId: "1x1",
    panes: [{ id: "pane-a", agentId: "codex", sessionId: tabs[0].sessionId, activeTabId, tabs }],
    status: "running",
    createdAt: NOW,
    splitColumns: [["pane-a"]],
  };
}

function brief(overrides: Partial<LiveSessionBrief> = {}): LiveSessionBrief {
  return {
    ptySessionId: "s-ask",
    agentSessionId: "agent-ask",
    agentKind: "codex",
    ptyInstanceId: "instance-ask",
    ptyGeneration: 1,
    sourceRevision: 1,
    ptyInputRevision: 1,
    task: "Answer the question",
    latestInstruction: null,
    taskSourceEventIds: [],
    activityKind: null,
    activityText: "Waiting for an answer",
    activitySourceEventId: null,
    checkpoint: null,
    checkpointEvidenceEventIds: [],
    pendingInputKind: "yesNo",
    pendingPrompt: "Continue?",
    pendingOptions: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    promptEventId: "prompt-ask",
    promptHash: "hash-ask",
    eventSeq: 1,
    operationalState: "needsHuman",
    telemetryHealth: "live",
    lastEventAt: NOW,
    lastSuccessfulReadAt: NOW,
    updatedAt: NOW,
    serviceEpoch: "epoch-a",
    briefRevision: 1,
    ...overrides,
  };
}

function doneAttention(sessionId: string): SessionAttention {
  return {
    sessionId,
    attentionId: `done-${sessionId}`,
    kind: "done",
    detail: null,
    sessionRevision: 1,
    uiState: "idle",
    stateSince: NOW - 60_000,
    occurrenceOrder: 1,
  };
}

function inputAttention(sessionId: string, occurrenceOrder: number): SessionAttention {
  return {
    sessionId,
    attentionId: `input-${sessionId}`,
    kind: "input",
    detail: "Needs an answer",
    sessionRevision: occurrenceOrder,
    uiState: "waiting",
    stateSince: NOW - 30_000,
    occurrenceOrder,
  };
}

function seedDashboard(input: {
  workspace: Workspace;
  selectedTabId: string;
  chatColumnTabIds?: string[];
  activeChatColumn?: number;
  attention?: Record<string, SessionAttention>;
  briefs?: LiveSessionBrief[];
}): void {
  useWorkspaceListStore.setState({ workspaces: [input.workspace], activeWorkspaceId: input.workspace.id });
  const lastLogAt = Object.fromEntries(input.workspace.panes.flatMap((pane) => pane.tabs.map((item) => [item.sessionId, NOW])));
  usePaneMetadataStore.setState({ metadata: {}, lastLog: {}, lastLogAt });
  useSessionAttentionStore.setState({
    attentionBySession: input.attention ?? {},
    seenAttentionByTab: new Map(),
  });
  useStallStore.getState().replaceEntries({});
  useLiveBriefStore.getState().reset();
  useLiveBriefStore.getState().applyBriefs(input.briefs ?? []);
  useDashboardViewStore.setState({
    open: true,
    query: "",
    workspaceFilter: null,
    agentFilter: null,
    stateFilter: null,
    selectedTabId: input.selectedTabId,
    chatColumnTabIds: input.chatColumnTabIds ?? [input.selectedTabId],
    activeChatColumn: input.activeChatColumn ?? 0,
    reportInboxOpen: false,
    highlightedEventId: null,
    highlightedEventRequest: 0,
  });
}

function centerBreadcrumb(container: HTMLElement): string | null {
  return container.querySelector<HTMLElement>("[data-dashboard-chat-column][data-active='true'] > header > span")?.textContent ?? null;
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

function dispatchPointer(target: HTMLElement, type: string, pointerId: number, clientX: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    isPrimary: { value: true },
    pointerId: { value: pointerId },
  });
  target.dispatchEvent(event);
}

function pointer(type: string, pointerId: number, clientX: number, clientY: number): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
    isPrimary: { value: true },
    pointerId: { value: pointerId },
    screenX: { value: clientX },
    screenY: { value: clientY },
  });
  return event as PointerEvent;
}

function stubElementFromPoint(element: Element | null): void {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => element),
  });
}

function stubChatColumnGeometry(bounds: readonly { left: number; right: number }[]): HTMLElement {
  const columnsRoot = container.querySelector<HTMLElement>(".cmux-dashboard-chat-columns")!;
  const columns = Array.from(columnsRoot.querySelectorAll<HTMLElement>("[data-dashboard-chat-column]"));
  const right = bounds.at(-1)?.right ?? 0;
  Object.defineProperty(columnsRoot, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, right, bottom: 120, width: right, height: 120 }),
  });
  for (const [index, column] of columns.entries()) {
    const rect = bounds[index]!;
    Object.defineProperty(column, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ ...rect, top: 0, bottom: 120, width: rect.right - rect.left, height: 120 }),
    });
  }
  stubElementFromPoint(columnsRoot);
  return columnsRoot;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setViewportWidth(1200);
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  mocks.syncDashboardEvents.mockClear();
  mocks.stopEventPolling.mockClear();
  mocks.onSessionStatusChanged.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useDashboardViewStore.setState({
    open: false,
    selectedTabId: null,
    chatColumnTabIds: [],
    activeChatColumn: 0,
    minimapWidth: DASHBOARD_MINIMAP_DEFAULT_WIDTH,
  });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  usePaneMetadataStore.setState({ metadata: {}, lastLog: {}, lastLogAt: {} });
  useSessionAttentionStore.getState().resetForTests();
  useStallStore.getState().replaceEntries({});
  useLiveBriefStore.getState().reset();
  __resetReportInboxStoreForTests();
  useInterventionFeedbackStore.getState().reset();
  useRecentInputStore.setState({ recentBySession: {} });
  usePaneDragStore.getState().clearDrag();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderDashboard(): Promise<void> {
  await act(async () => {
    root.render(<DashboardView onClose={vi.fn()} />);
    await Promise.resolve();
  });
}

describe("clampDashboardChatDropIndicatorOffset", () => {
  it("keeps a three-pixel indicator fully inside the root at either edge", () => {
    expect(clampDashboardChatDropIndicatorOffset(0, 100)).toBe(1.5);
    expect(clampDashboardChatDropIndicatorOffset(50, 100)).toBe(50);
    expect(clampDashboardChatDropIndicatorOffset(100, 100)).toBe(98.5);
    expect(clampDashboardChatDropIndicatorOffset(0, 0)).toBe(0);
  });
});

describe("DashboardView split3 selection", () => {
  it("toggles the per-card manual done mark and clears the attention seen state together", async () => {
    const target = tab("tab-manual-done", "s-manual-done", "Manual done target");
    const attention = inputAttention(target.sessionId, 1);
    seedDashboard({
      workspace: workspace([target]),
      selectedTabId: target.id,
      attention: { [target.sessionId]: attention },
    });
    await renderDashboard();

    const markButton = container.querySelector<HTMLButtonElement>(`[data-dashboard-manual-done-toggle='${target.id}']`);
    expect(markButton?.textContent).toBe(dashboardStrings.markDoneButton);
    await act(async () => markButton?.click());

    expect(useSessionAttentionStore.getState().doneMarkByTab.get(target.id)).toBe(NOW);
    expect(useSessionAttentionStore.getState().seenAttentionByTab.get(target.id)).toBe(attention.attentionId);
    expect(container.querySelector(`[data-dashboard-manual-done='${target.id}']`)?.textContent)
      .toBe(dashboardStrings.manualDoneBadge);
    expect(container.querySelector<HTMLButtonElement>(`[data-dashboard-manual-done-toggle='${target.id}']`)?.textContent)
      .toBe(dashboardStrings.unmarkDoneButton);

    await act(async () => container.querySelector<HTMLButtonElement>(`[data-dashboard-manual-done-toggle='${target.id}']`)?.click());
    expect(useSessionAttentionStore.getState().doneMarkByTab.has(target.id)).toBe(false);
    expect(container.querySelector(`[data-dashboard-manual-done='${target.id}']`)).toBeNull();
  });

  it("opens an immediate machine card's source event in the matching chat row", async () => {
    const target = tab("tab-report", "s-report", "Report target");
    const source: SemanticEventEnvelope = {
      eventId: "error-source-1",
      sourceRevision: 1,
      occurredAt: NOW,
      sourceByteStart: 0,
      sourceByteEnd: 24,
      kind: { type: "error", fingerprint: "report-error", text: "検証に失敗しました" },
    };
    seedDashboard({ workspace: workspace([target]), selectedTabId: target.id });
    useLiveBriefStore.setState({ listEventsBySession: { [target.sessionId]: [source] } });
    useReportInboxStore.getState().setReceiveMode(target.sessionId, "immediate");
    await renderDashboard();
    await act(async () => { await Promise.resolve(); });

    const inbox = container.querySelector<HTMLButtonElement>("[data-report-inbox-nav='true']");
    await act(async () => inbox?.click());
    const sourceButton = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-report-inbox-card] button"))
      .find((button) => button.textContent === "原文");
    expect(sourceButton).toBeDefined();
    expect(sourceButton?.disabled).toBe(false);
    await act(async () => sourceButton?.click());

    expect(useDashboardViewStore.getState().selectedTabId).toBe(target.id);
    expect(useDashboardViewStore.getState().reportInboxOpen).toBe(false);
    const sourceRow = container.querySelector<HTMLElement>("[data-dashboard-event='error-source-1']");
    expect(sourceRow?.classList.contains("is-source-highlighted")).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("keeps the list, chat, and minimap on the report source selected from the inbox", async () => {
    const current = tab("tab-current", "s-current", "Current target");
    const report = tab("tab-report", "s-report", "Report target");
    const source: SemanticEventEnvelope = {
      eventId: "error-source-report",
      sourceRevision: 1,
      occurredAt: NOW,
      sourceByteStart: 0,
      sourceByteEnd: 24,
      kind: { type: "error", fingerprint: "report-error", text: "Report source" },
    };
    seedDashboard({ workspace: workspace([current, report], current.id), selectedTabId: current.id });
    useLiveBriefStore.setState({ listEventsBySession: { [report.sessionId]: [source] } });
    useReportInboxStore.getState().setReceiveMode(report.sessionId, "immediate");
    await renderDashboard();
    await act(async () => { await Promise.resolve(); });

    await act(async () => container.querySelector<HTMLButtonElement>("[data-report-inbox-nav='true']")?.click());
    const sourceButton = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-report-inbox-card] button"))
      .find((button) => button.textContent === "原文");
    await act(async () => sourceButton?.click());

    expect(useDashboardViewStore.getState().selectedTabId).toBe(report.id);
    expect(centerBreadcrumb(container)).toBe("Workspace A › タブ2 › P1");
    expect(container.querySelector<HTMLElement>(`[data-dashboard-row="${report.id}"]`)?.style.boxShadow).toContain("var(--cmux-accent)");
    expect(container.querySelector<HTMLElement>(`[data-minimap-tab="${report.id}"]`)?.classList.contains("is-selected")).toBe(true);
    expect(container.querySelector<HTMLElement>(`[data-minimap-tab="${current.id}"]`)?.classList.contains("is-bundle-selected")).toBe(false);
    expect(container.querySelector<HTMLElement>("[data-dashboard-event='error-source-report']")?.classList.contains("is-source-highlighted")).toBe(true);
  });

  it("does not render an unusable source button for a closed tab and explains that the recorded signal stays readable", async () => {
    const active = tab("tab-active", "s-active", "Active target");
    const closedSessionId = "s-closed";
    seedDashboard({ workspace: workspace([active]), selectedTabId: active.id });
    useLiveBriefStore.setState({ listEventsBySession: {
      [closedSessionId]: [{
        eventId: "closed-source-1",
        sourceRevision: 1,
        occurredAt: NOW,
        sourceByteStart: 0,
        sourceByteEnd: 24,
        kind: { type: "error", fingerprint: "closed-report-error", text: "閉じたタブからの記録" },
      }],
    } });
    useReportInboxStore.getState().setReceiveMode(closedSessionId, "immediate");
    await renderDashboard();
    await act(async () => { await Promise.resolve(); });

    const inbox = container.querySelector<HTMLButtonElement>("[data-report-inbox-nav='true']");
    await act(async () => inbox?.click());
    const closedCard = container.querySelector<HTMLElement>("[data-report-inbox-card='livebrief:s-closed:closed-source-1']");
    const sourceButton = Array.from(closedCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent === "原文");
    expect(closedCard?.dataset.reportSourceAvailable).toBe("false");
    expect(sourceButton).toBeUndefined();
    expect(closedCard?.querySelector("[data-report-source-unavailable]")?.textContent).toContain("このタブは閉じています");
    expect(closedCard?.textContent).toContain("閉じたタブからの記録");
  });

  it("shows the session receive mode immediately and folds quiet records", async () => {
    const target = tab("tab-quiet", "s-quiet", "Quiet target");
    seedDashboard({ workspace: workspace([target]), selectedTabId: target.id });
    useLiveBriefStore.setState({ listEventsBySession: {
      [target.sessionId]: [{
        eventId: "quiet-source-1",
        sourceRevision: 1,
        occurredAt: NOW,
        sourceByteStart: 0,
        sourceByteEnd: 24,
        kind: { type: "error", fingerprint: "quiet-report-error", text: "記録する進捗" },
      }],
    } });
    useReportInboxStore.getState().setReceiveMode(target.sessionId, "immediate");
    await renderDashboard();
    await act(async () => { await Promise.resolve(); });

    const inbox = container.querySelector<HTMLButtonElement>("[data-report-inbox-nav='true']");
    await act(async () => inbox?.click());
    const card = container.querySelector<HTMLElement>("[data-report-inbox-card='livebrief:s-quiet:quiet-source-1']");
    expect(card?.querySelector("[data-report-receive-mode='immediate']")?.textContent).toContain("このセッションの受け方: すぐ言って");
    const select = card?.querySelector<HTMLSelectElement>("select");
    expect(select).not.toBeNull();
    await act(async () => {
      if (!select) return;
      select.value = "batch";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const batchFold = container.querySelector<HTMLDetailsElement>("[data-report-batch-fold]");
    expect(batchFold?.open).toBe(false);
    expect(batchFold?.querySelector("summary")?.textContent).toContain("区切りでまとめて · 1件");
    const quietSelect = batchFold?.querySelector<HTMLSelectElement>("select");
    await act(async () => {
      if (!quietSelect) return;
      quietSelect.value = "quiet";
      quietSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const quietFold = container.querySelector<HTMLDetailsElement>("[data-report-quiet-fold]");
    expect(quietFold?.open).toBe(false);
    expect(quietFold?.querySelector("summary")?.textContent).toContain("黙って記録 · 進捗 1件を記録");
    expect(quietFold?.querySelector("[data-report-receive-mode='quiet']")?.textContent).toContain("このセッションのカードを畳み");
  });

  it("shows a mechanical partial summary with every coverage count and never calls it all complete", async () => {
    const target = tab("tab-batch", "s-batch", "Batch target");
    seedDashboard({ workspace: workspace([target]), selectedTabId: target.id });
    const batch = sealBatch(createBatch([{
      logicalSessionId: logicalSessionId(target.id), instructionRef: target.sessionId, label: target.label,
    }], { batchId: "batch-ui" }));
    useReportInboxStore.getState().registerSealedDispatchBatch({
      batch,
      commandKind: "plain",
      members: [{
        logicalSessionId: logicalSessionId(target.id),
        ptySessionId: target.sessionId,
        label: target.label,
        delivery: { state: "confirmed", detail: "送達確認済み" },
      }],
    });
    await renderDashboard();
    await act(async () => { await Promise.resolve(); });

    const inbox = container.querySelector<HTMLButtonElement>("[data-report-inbox-nav='true']");
    await act(async () => inbox?.click());
    const summary = container.querySelector<HTMLElement>("[data-report-summary='batch-ui']");
    expect(summary?.dataset.reportPartial).toBe("true");
    expect(summary?.classList.contains("cmux-dashboard-qcard")).toBe(true);
    expect(summary?.textContent).toContain("対象1｜受領0｜まとめ反映0｜未受領1｜要判断0");
    expect(summary?.textContent).toContain("部分まとめ");
    expect(summary?.textContent).not.toContain("全員完了");
  });

  it("lists both conflicting completion evidences instead of collapsing them into complete", async () => {
    const target = tab("tab-conflict", "s-conflict", "Conflict target");
    seedDashboard({ workspace: workspace([target]), selectedTabId: target.id });
    const batch = sealBatch(createBatch([{
      logicalSessionId: logicalSessionId(target.id), instructionRef: target.sessionId, label: target.label,
    }], { batchId: "batch-conflict" }));
    useReportInboxStore.getState().registerSealedDispatchBatch({
      batch,
      commandKind: "plain",
      members: [{
        logicalSessionId: logicalSessionId(target.id), ptySessionId: target.sessionId, label: target.label,
        delivery: { state: "confirmed", detail: "送達確認済み" },
      }],
    });
    useReportInboxStore.getState().ingestBatchCompletionEvidence("batch-conflict", target.sessionId, {
      source: "ledger", kind: "done-marker", observedAt: NOW, sourceRef: "done-conflict",
    });
    useReportInboxStore.getState().ingestBatchCompletionEvidence("batch-conflict", target.sessionId, {
      source: "livebrief", kind: "turn-ended", observedAt: NOW + 1, sourceRef: "turn-conflict",
    });
    await renderDashboard();
    const inbox = container.querySelector<HTMLButtonElement>("[data-report-inbox-nav='true']");
    await act(async () => inbox?.click());
    expect(Array.from(container.querySelectorAll("[data-report-conflict-evidence]")).map((node) => node.textContent))
      .toEqual(expect.arrayContaining(["Conflict target: ledger/done-marker", "Conflict target: livebrief/turn-ended"]));
    expect(container.textContent).not.toContain("全員完了");
  });

  it("shows when repeated commands make a machine evidence unsafe to correlate", async () => {
    const target = tab("tab-ambiguous", "s-ambiguous", "Ambiguous target");
    seedDashboard({ workspace: workspace([target]), selectedTabId: target.id });
    const register = (batchId: string) => {
      const batch = sealBatch(createBatch([{
        logicalSessionId: logicalSessionId(target.id), instructionRef: target.sessionId, label: target.label,
      }], { batchId }));
      useReportInboxStore.getState().registerSealedDispatchBatch({
        batch,
        commandKind: "plain",
        members: [{
          logicalSessionId: logicalSessionId(target.id), ptySessionId: target.sessionId, label: target.label,
          delivery: { state: "confirmed", detail: "送達確認済み" },
        }],
      });
    };
    register("batch-old-ui");
    useReportInboxStore.getState().ingestBatchCompletionEvidence("batch-old-ui", target.sessionId, {
      source: "livebrief", kind: "turn-ended", observedAt: NOW, sourceRef: "old-turn",
    });
    register("batch-new-ui");
    useReportInboxStore.getState().ingestSemanticEvents(target.sessionId, [{
      eventId: "unsafe-correlation",
      sourceRevision: 1,
      occurredAt: NOW + 1,
      sourceByteStart: 0,
      sourceByteEnd: 1,
      kind: { type: "testResult", pass: 0, fail: 1 },
    }]);
    await renderDashboard();
    const inbox = container.querySelector<HTMLButtonElement>("[data-report-inbox-nav='true']");
    await act(async () => inbox?.click());
    const summary = container.querySelector<HTMLElement>("[data-report-summary='batch-new-ui']");
    expect(summary?.dataset.reportPartial).toBe("true");
    expect(summary?.textContent).toContain("要判断1");
    expect(summary?.querySelector("[data-report-correlation-warning]")?.textContent)
      .toContain("受領数に入れていません");
  });

  it("keeps j/k navigation in the frozen rendered attention-row order", async () => {
    const cardA = tab("tab-a", "s-a", "A");
    const cardB = tab("tab-b", "s-b", "B");
    const cardC = tab("tab-c", "s-c", "C");
    seedDashboard({
      workspace: workspace([cardA, cardB, cardC], cardB.id),
      selectedTabId: cardB.id,
    });
    await renderDashboard();

    const list = container.querySelector<HTMLElement>("[aria-label='セッション一覧']");
    expect(list).not.toBeNull();
    await act(async () => {
      list?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    await act(async () => {
      useSessionAttentionStore.setState({
        attentionBySession: { [cardB.sessionId]: inputAttention(cardB.sessionId, 2) },
      });
    });
    await act(async () => {
      useSessionAttentionStore.setState({
        attentionBySession: {
          [cardB.sessionId]: inputAttention(cardB.sessionId, 2),
          [cardA.sessionId]: inputAttention(cardA.sessionId, 1),
        },
      });
    });

    const renderedOrder = Array.from(container.querySelectorAll<HTMLElement>("[data-dashboard-row]"))
      .map((row) => row.dataset.dashboardRow);
    expect(renderedOrder).toEqual([cardB.id, cardA.id, cardC.id]);

    const region = container.querySelector<HTMLElement>("[role='region']");
    await act(async () => region?.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
    expect(useDashboardViewStore.getState().selectedTabId).toBe(cardA.id);
    await act(async () => region?.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
    expect(useDashboardViewStore.getState().selectedTabId).toBe(cardC.id);
    await act(async () => region?.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true })));
    expect(useDashboardViewStore.getState().selectedTabId).toBe(cardA.id);
  });

  it("keeps a completed card authoritative for click and j/k center navigation", async () => {
    const active = tab("tab-active", "s-active", "Active");
    const done = tab("tab-done", "s-done", "Done");
    seedDashboard({
      workspace: workspace([active, done], active.id),
      selectedTabId: active.id,
      attention: { [done.sessionId]: doneAttention(done.sessionId) },
    });
    await renderDashboard();

    expect(centerBreadcrumb(container)).toBe("Workspace A › タブ1 › P1");
    const doneRow = container.querySelector<HTMLElement>(`[data-dashboard-row="${done.id}"]`);
    expect(doneRow).not.toBeNull();

    await act(async () => doneRow?.click());
    expect(useDashboardViewStore.getState().selectedTabId).toBe(done.id);
    expect(centerBreadcrumb(container)).toBe("Workspace A › タブ2 › P1");

    const region = container.querySelector<HTMLElement>("[role='region']");
    expect(region).not.toBeNull();
    await act(async () => region?.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true })));
    expect(useDashboardViewStore.getState().selectedTabId).toBe(active.id);
    expect(centerBreadcrumb(container)).toBe("Workspace A › タブ1 › P1");

    await act(async () => region?.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
    expect(useDashboardViewStore.getState().selectedTabId).toBe(done.id);
    expect(centerBreadcrumb(container)).toBe("Workspace A › タブ2 › P1");
  });

  it("keeps the split3 center as the only question anchor", async () => {
    const asking = tab("tab-ask", "s-ask", "Asking");
    seedDashboard({ workspace: workspace([asking]), selectedTabId: asking.id, briefs: [brief()] });
    await renderDashboard();

    const anchors = container.querySelectorAll("#dashboard-question-s-ask");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].closest("[data-dashboard-center='true']")).not.toBeNull();
  });

  it("selects the same tab from the minimap and the left session list", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    seedDashboard({ workspace: workspace([first, second]), selectedTabId: first.id });
    await renderDashboard();

    const chip = container.querySelector<HTMLElement>(`[data-minimap-tab="${second.id}"]`);
    expect(chip).not.toBeNull();
    await act(async () => chip?.click());
    expect(useDashboardViewStore.getState().selectedTabId).toBe(second.id);
    const selectedRow = container.querySelector<HTMLElement>(`[data-dashboard-row="${second.id}"]`);
    expect(selectedRow?.style.boxShadow).toContain("var(--cmux-accent)");
    expect(centerBreadcrumb(container)).toBe("Workspace A › タブ2 › P1");
    expect(chip?.classList.contains("is-selected")).toBe(true);
  });

  it("expands the selected tab's workspace after a left-list selection", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    const wsA = workspace([first]);
    const wsB: Workspace = { ...workspace([second]), id: "ws-b", name: "Workspace B", panes: [{ ...workspace([second]).panes[0], id: "pane-b" }], splitColumns: [["pane-b"]] };
    seedDashboard({ workspace: wsA, selectedTabId: first.id });
    useWorkspaceListStore.setState({ workspaces: [wsA, wsB], activeWorkspaceId: wsA.id });
    usePaneMetadataStore.setState({ metadata: {}, lastLog: {}, lastLogAt: { [first.sessionId]: NOW, [second.sessionId]: NOW } });
    await renderDashboard();

    const secondRow = container.querySelector<HTMLElement>(`[data-dashboard-row="${second.id}"]`);
    await act(async () => secondRow?.click());
    expect(useDashboardViewStore.getState().selectedTabId).toBe(second.id);
    expect(secondRow?.style.boxShadow).toContain("var(--cmux-accent)");
    expect(centerBreadcrumb(container)).toBe("Workspace B › タブ1 › P1");
    const secondWorkspace = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-b']")!;
    expect(secondWorkspace.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(secondWorkspace.querySelector(`[data-minimap-tab='${second.id}']`)?.classList.contains("is-selected")).toBe(true);
  });

  it("keeps the terminal/chat toggle out of the central pane and shows the telemetry fallback", async () => {
    const unavailable = tab("tab-unavailable", "s-unavailable", "Unavailable");
    seedDashboard({
      workspace: workspace([unavailable]),
      selectedTabId: unavailable.id,
      briefs: [brief({ ptySessionId: unavailable.sessionId, telemetryHealth: "unavailable" })],
      attention: { [unavailable.sessionId]: inputAttention(unavailable.sessionId, 1) },
    });
    useRecentInputStore.setState({ recentBySession: { [unavailable.sessionId]: { text: "Check the log", at: NOW } } });
    usePaneMetadataStore.setState({ metadata: {}, lastLog: { [unavailable.sessionId]: "last terminal output" }, lastLogAt: { [unavailable.sessionId]: NOW } });
    await renderDashboard();

    const fallback = container.querySelector<HTMLElement>("[aria-label='端末から拾える情報']");
    expect(fallback?.textContent).toContain("履歴を読めません");
    expect(fallback?.textContent).toContain("Check the log");
    expect(fallback?.textContent).toContain("last terminal output");
    expect(fallback?.closest("[data-dashboard-center='true']")).not.toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "端末" || button.textContent === "チャット")).toBe(false);
  });

  it("keeps status, elapsed time, and controls on the single chat header without the old detail band", async () => {
    const asking = tab("tab-header", "s-header", "Header session");
    seedDashboard({ workspace: workspace([asking]), selectedTabId: asking.id, briefs: [brief({ ptySessionId: asking.sessionId })] });
    await renderDashboard();

    const header = container.querySelector<HTMLElement>("[data-dashboard-chat-column][data-active='true'] > header");
    expect(header?.textContent).toContain("Header session");
    expect(header?.textContent).toContain("要回答");
    expect(header?.textContent).toContain("0分");
    expect(header?.querySelector("button[aria-pressed]")).toBeNull();
    expect(container.querySelector(".cmux-dashboard-detail-drawer")).toBeNull();
    expect(container.querySelector("[data-dashboard-center='true'] nav")).toBeNull();
  });
});

vi.mock("../../src/components/layout/socketCommands", async () => {
  const actual = await vi.importActual<typeof import("../../src/components/layout/socketCommands")>("../../src/components/layout/socketCommands");
  return { ...actual, handleSocketCommand: mocks.handleSocketCommand };
});

describe("DashboardView Q1 chat columns", () => {
  it("replaces the active column on a list click without adding a column", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    seedDashboard({ workspace: workspace([first, second]), selectedTabId: first.id });
    await renderDashboard();

    await act(async () => container.querySelector<HTMLElement>(`[data-dashboard-row='${second.id}']`)?.click());

    const state = useDashboardViewStore.getState();
    expect(state.chatColumnTabIds).toEqual([second.id]);
    expect(state.activeChatColumn).toBe(0);
    expect(state.selectedTabId).toBe(second.id);
  });

  it("adds a column for a minimap drop, de-duplicates it, and closes the report inbox", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    seedDashboard({ workspace: workspace([first, second]), selectedTabId: first.id });
    await renderDashboard();
    useDashboardViewStore.getState().openReportInbox();
    const source = container.querySelector<HTMLElement>(`[data-minimap-tab='${second.id}']`)!;
    const dropTarget = container.querySelector<HTMLElement>("[data-dashboard-chat-drop-target='true']")!;
    stubElementFromPoint(dropTarget);

    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 71, 10, 10));
      window.dispatchEvent(pointer("pointermove", 71, 20, 20));
      window.dispatchEvent(pointer("pointerup", 71, 20, 20));
    });
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: [first.id, second.id],
      activeChatColumn: 1,
      selectedTabId: second.id,
      reportInboxOpen: false,
    });

    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 72, 10, 10));
      window.dispatchEvent(pointer("pointermove", 72, 20, 20));
      window.dispatchEvent(pointer("pointerup", 72, 20, 20));
    });
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([first.id, second.id]);
    expect(useDashboardViewStore.getState().activeChatColumn).toBe(1);
  });

  it("adds a column from a left-list drag without changing workspace layout", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    seedDashboard({ workspace: workspace([first, second]), selectedTabId: first.id });
    await renderDashboard();
    const source = container.querySelector<HTMLElement>(`[data-dashboard-row='${second.id}']`)!;
    const dropTarget = container.querySelector<HTMLElement>("[data-dashboard-chat-drop-target='true']")!;
    stubElementFromPoint(dropTarget);

    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 73, 10, 10));
      window.dispatchEvent(pointer("pointermove", 73, 20, 20));
      window.dispatchEvent(pointer("pointerup", 73, 20, 20));
    });

    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([second.id, first.id]);
    expect(useWorkspaceListStore.getState().getWorkspace("ws-a")?.panes[0].tabs.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it("shows central insert feedback at the left, right, and inter-column boundaries", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    const third = tab("tab-third", "s-third", "Third");
    const fourth = tab("tab-fourth", "s-fourth", "Fourth");
    seedDashboard({ workspace: workspace([first, second, third, fourth]), selectedTabId: first.id });
    await renderDashboard();

    stubChatColumnGeometry([{ left: 0, right: 100 }]);
    await act(async () => {
      usePaneDragStore.getState().beginDrag({ kind: "tab", surface: "minimap", workspaceId: "ws-a", paneId: "pane-a", tabId: third.id, label: third.label ?? third.id }, { x: 20, y: 20 });
      usePaneDragStore.getState().moveDrag({ x: 20, y: 20 });
    });
    const leftIndicator = container.querySelector<HTMLElement>(".cmux-dashboard-chat-drop-indicator");
    expect(leftIndicator?.dataset.dashboardChatInsertIndex).toBe("0");
    expect(Number(leftIndicator?.style.left.replace("px", ""))).toBeGreaterThan(0);

    await act(async () => usePaneDragStore.getState().moveDrag({ x: 80, y: 20 }));
    const rightIndicator = container.querySelector<HTMLElement>(".cmux-dashboard-chat-drop-indicator");
    expect(rightIndicator?.dataset.dashboardChatInsertIndex).toBe("1");
    expect(Number(rightIndicator?.style.left.replace("px", ""))).toBeLessThan(100);

    await act(async () => {
      useDashboardViewStore.setState({ chatColumnTabIds: [first.id, second.id], activeChatColumn: 0, selectedTabId: first.id });
      await Promise.resolve();
    });
    stubChatColumnGeometry([{ left: 0, right: 50 }, { left: 50, right: 100 }]);
    await act(async () => {
      usePaneDragStore.getState().beginDrag({ kind: "tab", surface: "minimap", workspaceId: "ws-a", paneId: "pane-a", tabId: third.id, label: third.label ?? third.id }, { x: 50, y: 20 });
      usePaneDragStore.getState().moveDrag({ x: 50, y: 20 });
    });
    expect(container.querySelector<HTMLElement>(".cmux-dashboard-chat-drop-indicator")?.dataset.dashboardChatInsertIndex).toBe("1");

    await act(async () => {
      usePaneDragStore.getState().beginDrag({ kind: "tab", surface: "minimap", workspaceId: "ws-a", paneId: "pane-a", tabId: first.id, label: first.label ?? first.id }, { x: 50, y: 20 });
      usePaneDragStore.getState().moveDrag({ x: 50, y: 20 });
    });
    expect(container.querySelector(".cmux-dashboard-chat-drop-indicator")).toBeNull();
    expect(container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${first.id}']`)?.classList.contains("is-drop-existing")).toBe(true);

    await act(async () => {
      useDashboardViewStore.setState({ chatColumnTabIds: [first.id, second.id, third.id], activeChatColumn: 0, selectedTabId: first.id });
      await Promise.resolve();
    });
    stubChatColumnGeometry([{ left: 0, right: 33 }, { left: 33, right: 66 }, { left: 66, right: 100 }]);
    await act(async () => {
      usePaneDragStore.getState().beginDrag({ kind: "tab", surface: "minimap", workspaceId: "ws-a", paneId: "pane-a", tabId: fourth.id, label: fourth.label ?? fourth.id }, { x: 50, y: 20 });
      usePaneDragStore.getState().moveDrag({ x: 50, y: 20 });
    });
    expect(container.querySelector(".cmux-dashboard-chat-drop-indicator")).toBeNull();
    expect(container.querySelector<HTMLElement>(".cmux-dashboard-chat-drop-capped")?.textContent).toBe("3列まで");
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([first.id, second.id, third.id]);
  });

  it("shows the same central insert feedback for a left-list session drag", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    seedDashboard({ workspace: workspace([first, second]), selectedTabId: first.id });
    await renderDashboard();
    stubChatColumnGeometry([{ left: 0, right: 100 }]);
    const source = container.querySelector<HTMLElement>(`[data-dashboard-row='${second.id}']`)!;

    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 901, 20, 20));
      window.dispatchEvent(pointer("pointermove", 901, 80, 20));
      await Promise.resolve();
    });
    expect(usePaneDragStore.getState().dashboardChatDropPreview).toMatchObject({ kind: "insert", index: 1 });
    const indicator = container.querySelector<HTMLElement>(".cmux-dashboard-chat-drop-indicator");
    expect(indicator?.dataset.dashboardChatInsertIndex).toBe("1");
    expect(Number(indicator?.style.left.replace("px", ""))).toBeGreaterThan(0);
    expect(Number(indicator?.style.left.replace("px", ""))).toBeLessThan(100);

    await act(async () => window.dispatchEvent(pointer("pointercancel", 901, 80, 20)));
    expect(container.querySelector(".cmux-dashboard-chat-drop-indicator")).toBeNull();
  });

  it("reorders chat columns by dragging their headers without remounting the moved column", async () => {
    const first = tab("tab-drag-first", "s-drag-first", "First");
    const second = tab("tab-drag-second", "s-drag-second", "Second");
    const third = tab("tab-drag-third", "s-drag-third", "Third");
    seedDashboard({
      workspace: workspace([first, second, third]),
      selectedTabId: first.id,
      chatColumnTabIds: [first.id, second.id, third.id],
    });
    await renderDashboard();
    stubChatColumnGeometry([{ left: 0, right: 50 }, { left: 50, right: 100 }, { left: 100, right: 150 }]);
    const firstElement = container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${first.id}']`)!;
    const handle = firstElement.querySelector<HTMLElement>("[data-dashboard-column-drag-handle='true']")!;

    await act(async () => {
      handle.dispatchEvent(pointer("pointerdown", 950, 10, 20));
      window.dispatchEvent(pointer("pointermove", 950, 95, 20));
      window.dispatchEvent(pointer("pointerup", 950, 95, 20));
    });

    expect(Array.from(container.querySelectorAll<HTMLElement>("[data-dashboard-chat-column]")).map((column) => column.dataset.dashboardChatColumn)).toEqual([second.id, first.id, third.id]);
    expect(container.querySelector(`[data-dashboard-chat-column='${first.id}']`)).toBe(firstElement);
  });

  it("keeps a short header click as activation and cancels a header drag with Escape", async () => {
    const first = tab("tab-header-first", "s-header-first", "First");
    const second = tab("tab-header-second", "s-header-second", "Second");
    seedDashboard({
      workspace: workspace([first, second]),
      selectedTabId: second.id,
      chatColumnTabIds: [first.id, second.id],
      activeChatColumn: 1,
    });
    await renderDashboard();
    stubChatColumnGeometry([{ left: 0, right: 50 }, { left: 50, right: 100 }]);
    const firstHandle = container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${first.id}'] [data-dashboard-column-drag-handle='true']`)!;

    await act(async () => {
      firstHandle.dispatchEvent(pointer("pointerdown", 951, 10, 20));
      window.dispatchEvent(pointer("pointermove", 951, 15, 20));
      window.dispatchEvent(pointer("pointerup", 951, 15, 20));
      firstHandle.click();
    });
    expect(useDashboardViewStore.getState()).toMatchObject({ chatColumnTabIds: [first.id, second.id], activeChatColumn: 0, selectedTabId: first.id });

    await act(async () => {
      firstHandle.dispatchEvent(pointer("pointerdown", 952, 10, 20));
      window.dispatchEvent(pointer("pointermove", 952, 95, 20));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([first.id, second.id]);
    expect(container.querySelector(".cmux-dashboard-chat-drop-indicator")).toBeNull();
  });

  it("does not start a column drag from the close button and supports Alt-arrow header reorder", async () => {
    const first = tab("tab-key-first", "s-key-first", "First");
    const second = tab("tab-key-second", "s-key-second", "Second");
    seedDashboard({
      workspace: workspace([first, second]),
      selectedTabId: first.id,
      chatColumnTabIds: [first.id, second.id],
    });
    await renderDashboard();
    stubChatColumnGeometry([{ left: 0, right: 50 }, { left: 50, right: 100 }]);
    const closeButton = container.querySelector<HTMLElement>(`[data-dashboard-chat-column-close='${first.id}']`)!;

    await act(async () => {
      closeButton.dispatchEvent(pointer("pointerdown", 953, 10, 20));
      window.dispatchEvent(pointer("pointermove", 953, 95, 20));
      window.dispatchEvent(pointer("pointerup", 953, 95, 20));
    });
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([first.id, second.id]);

    const firstHandle = container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${first.id}'] [data-dashboard-column-drag-handle='true']`)!;
    await act(async () => firstHandle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true, cancelable: true })));
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([second.id, first.id]);
    const movedHandle = container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${first.id}'] [data-dashboard-column-drag-handle='true']`)!;
    await act(async () => movedHandle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true })));
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([first.id, second.id]);
  });

  it("keeps an insert indicator inside the root for a minimap chip drag", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    const third = tab("tab-third", "s-third", "Third");
    seedDashboard({ workspace: workspace([first, second, third]), selectedTabId: first.id });
    await renderDashboard();
    stubChatColumnGeometry([{ left: 0, right: 100 }]);
    const source = container.querySelector<HTMLElement>(`[data-minimap-tab='${third.id}']`)!;

    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 902, 0, 20));
      window.dispatchEvent(pointer("pointermove", 902, 10, 20));
      await Promise.resolve();
    });

    const indicator = container.querySelector<HTMLElement>(".cmux-dashboard-chat-drop-indicator");
    const left = Number(indicator?.style.left.replace("px", ""));
    expect(indicator?.dataset.dashboardChatInsertIndex).toBe("0");
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(100);

    await act(async () => window.dispatchEvent(pointer("pointercancel", 902, 10, 20)));
  });

  it("keeps a minimap drop on the composer as an @ recipient instead of a chat column", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    seedDashboard({ workspace: workspace([first, second]), selectedTabId: first.id });
    await renderDashboard();
    const source = container.querySelector<HTMLElement>(`[data-minimap-tab='${second.id}']`)!;
    stubElementFromPoint(container.querySelector<HTMLElement>("[data-composer-pane-drop-target='true']"));

    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 731, 10, 10));
      window.dispatchEvent(pointer("pointermove", 731, 20, 20));
      window.dispatchEvent(pointer("pointerup", 731, 20, 20));
    });

    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([first.id]);
    expect(container.querySelector(".cmux-dashboard-mention-token")?.textContent).toContain(`@${second.label}`);
  });

  it("closes one column but keeps the final column open", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    seedDashboard({
      workspace: workspace([first, second]),
      selectedTabId: second.id,
      chatColumnTabIds: [first.id, second.id],
      activeChatColumn: 1,
    });
    await renderDashboard();

    await act(async () => container.querySelector<HTMLButtonElement>(`[data-dashboard-chat-column-close='${second.id}']`)?.click());
    expect(useDashboardViewStore.getState()).toMatchObject({ chatColumnTabIds: [first.id], activeChatColumn: 0, selectedTabId: first.id });
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-dashboard-chat-column-close='${first.id}']`)?.click());
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([first.id]);
  });

  it("animates existing and new columns together for one-to-two and two-to-three splits without remounting survivors", async () => {
    const first = tab("tab-motion-first", "s-motion-first", "First");
    const second = tab("tab-motion-second", "s-motion-second", "Second");
    const third = tab("tab-motion-third", "s-motion-third", "Third");
    setViewportWidth(1800);
    seedDashboard({ workspace: workspace([first, second, third]), selectedTabId: first.id });
    await renderDashboard();
    const firstElement = container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${first.id}']`)!;

    await act(async () => {
      useDashboardViewStore.getState().addChatColumn(second.id);
      await Promise.resolve();
    });
    const secondElement = container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${second.id}']`)!;
    expect(firstElement.dataset.dashboardChatColumnMotion).toBe("resize");
    expect(secondElement.dataset.dashboardChatColumnMotion).toBe("enter");
    await act(async () => { vi.advanceTimersByTime(180); });
    expect(firstElement.dataset.dashboardChatColumnMotion).toBe("idle");
    expect(secondElement.dataset.dashboardChatColumnMotion).toBe("idle");
    expect(container.querySelector(`[data-dashboard-chat-column='${first.id}']`)).toBe(firstElement);
    expect(container.querySelector(`[data-dashboard-chat-column='${second.id}']`)).toBe(secondElement);

    await act(async () => {
      useDashboardViewStore.getState().addChatColumn(third.id);
      await Promise.resolve();
    });
    expect(firstElement.dataset.dashboardChatColumnMotion).toBe("resize");
    expect(secondElement.dataset.dashboardChatColumnMotion).toBe("resize");
    expect(container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${third.id}']`)?.dataset.dashboardChatColumnMotion).toBe("enter");
  });

  it("keeps a closing column mounted while remaining columns expand", async () => {
    const first = tab("tab-close-motion-first", "s-close-motion-first", "First");
    const second = tab("tab-close-motion-second", "s-close-motion-second", "Second");
    setViewportWidth(1800);
    seedDashboard({
      workspace: workspace([first, second]),
      selectedTabId: second.id,
      chatColumnTabIds: [first.id, second.id],
      activeChatColumn: 1,
    });
    await renderDashboard();
    const firstElement = container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${first.id}']`)!;
    const secondElement = container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${second.id}']`)!;

    await act(async () => container.querySelector<HTMLButtonElement>(`[data-dashboard-chat-column-close='${second.id}']`)?.click());
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([first.id]);
    expect(firstElement.dataset.dashboardChatColumnMotion).toBe("expand");
    expect(secondElement.dataset.dashboardChatColumnMotion).toBe("exit");
    expect(container.querySelector(`[data-dashboard-chat-column='${first.id}']`)).toBe(firstElement);
    expect(container.querySelector(`[data-dashboard-chat-column='${second.id}']`)).toBe(secondElement);
    await act(async () => { vi.advanceTimersByTime(180); });
    expect(container.querySelector(`[data-dashboard-chat-column='${first.id}']`)).toBe(firstElement);
    expect(container.querySelector(`[data-dashboard-chat-column='${second.id}']`)).toBeNull();
  });

  it("applies split and close changes immediately when reduced motion is requested", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const first = tab("tab-reduced-first", "s-reduced-first", "First");
    const second = tab("tab-reduced-second", "s-reduced-second", "Second");
    setViewportWidth(1800);
    seedDashboard({ workspace: workspace([first, second]), selectedTabId: first.id });
    await renderDashboard();

    await act(async () => {
      useDashboardViewStore.getState().addChatColumn(second.id);
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${first.id}']`)?.dataset.dashboardChatColumnMotion).toBe("idle");
    expect(container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${second.id}']`)?.dataset.dashboardChatColumnMotion).toBe("idle");
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-dashboard-chat-column-close='${second.id}']`)?.click());
    expect(container.querySelector(`[data-dashboard-chat-column='${second.id}']`)).toBeNull();
  });

  it("keeps active-column selection aligned with the list and minimap highlights", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    setViewportWidth(1400);
    seedDashboard({
      workspace: workspace([first, second]),
      selectedTabId: second.id,
      chatColumnTabIds: [first.id, second.id],
      activeChatColumn: 1,
    });
    await renderDashboard();

    await act(async () => container.querySelector<HTMLElement>(`[data-dashboard-chat-column='${first.id}'] > header`)?.click());
    expect(useDashboardViewStore.getState()).toMatchObject({ activeChatColumn: 0, selectedTabId: first.id });
    expect(container.querySelector<HTMLElement>(`[data-dashboard-row='${first.id}']`)?.style.boxShadow).toContain("var(--cmux-accent)");
    expect(container.querySelector<HTMLElement>(`[data-minimap-tab='${first.id}']`)?.classList.contains("is-selected")).toBe(true);
  });

  it("routes direct composer input to the active column", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    mocks.handleSocketCommand.mockResolvedValue({ confirmed: true });
    seedDashboard({
      workspace: workspace([first, second]),
      selectedTabId: second.id,
      chatColumnTabIds: [first.id, second.id],
      activeChatColumn: 1,
    });
    await renderDashboard();

    expect(container.querySelector(".cmux-dashboard-composer-destination")?.textContent).toContain("入力先: Second（2/2列）");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "active column only");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(mocks.handleSocketCommand).toHaveBeenCalledWith("pane.send_text", {
      sessionId: "s-second",
      text: "active column only",
      enter: true,
    });
  });

  it("keeps three columns at the cap when a fourth session is dropped", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    const third = tab("tab-third", "s-third", "Third");
    const fourth = tab("tab-fourth", "s-fourth", "Fourth");
    seedDashboard({
      workspace: workspace([first, second, third, fourth]),
      selectedTabId: first.id,
      chatColumnTabIds: [first.id, second.id, third.id],
      activeChatColumn: 0,
    });
    await renderDashboard();
    const source = container.querySelector<HTMLElement>(`[data-minimap-tab='${fourth.id}']`)!;
    stubElementFromPoint(container.querySelector<HTMLElement>("[data-dashboard-chat-drop-target='true']"));

    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 74, 10, 10));
      window.dispatchEvent(pointer("pointermove", 74, 20, 20));
      window.dispatchEvent(pointer("pointerup", 74, 20, 20));
    });
    expect(useDashboardViewStore.getState()).toMatchObject({
      chatColumnTabIds: [first.id, second.id, third.id],
      activeChatColumn: 0,
      selectedTabId: first.id,
    });
  });

  it("renders every open chat column at narrow width without a temporary-hide UI", async () => {
    const first = tab("tab-first", "s-first", "First");
    const second = tab("tab-second", "s-second", "Second");
    const third = tab("tab-third", "s-third", "Third");
    setViewportWidth(1800);
    seedDashboard({
      workspace: workspace([first, second, third]),
      selectedTabId: third.id,
      chatColumnTabIds: [first.id, second.id, third.id],
      activeChatColumn: 2,
    });
    await renderDashboard();
    expect(container.querySelectorAll("[data-dashboard-chat-column]")).toHaveLength(3);

    await act(async () => {
      setViewportWidth(1100);
      window.dispatchEvent(new Event("resize"));
    });
    expect(Array.from(container.querySelectorAll<HTMLElement>("[data-dashboard-chat-column]")).map((column) => column.dataset.dashboardChatColumn)).toEqual([first.id, second.id, third.id]);
    expect(container.querySelector<HTMLElement>(".cmux-dashboard-chat-columns")?.dataset.visibleColumns).toBe("3");
    expect(container.querySelector(".cmux-dashboard-chat-hidden-columns")).toBeNull();
    expect(container.querySelector("[data-dashboard-hidden-chat-column]")).toBeNull();
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([first.id, second.id, third.id]);
  });
});

describe("DashboardView minimap resize", () => {
  it("drags the separator within its lower and readable-chat upper bounds", async () => {
    setViewportWidth(1200);
    const item = tab("tab-resize", "s-resize", "Resize target");
    seedDashboard({ workspace: workspace([item]), selectedTabId: item.id });
    await renderDashboard();

    const resizer = container.querySelector<HTMLElement>("[data-dashboard-resizer='true']")!;
    const shell = container.querySelector<HTMLElement>(".cmux-dashboard-shell")!;
    const maximum = dashboardMinimapMaxWidth(1200);
    expect(resizer.getAttribute("aria-valuenow")).toBe(String(DASHBOARD_MINIMAP_DEFAULT_WIDTH));

    await act(async () => dispatchPointer(resizer, "pointerdown", 1, 600));
    expect(resizer.classList.contains("is-resizing")).toBe(true);
    await act(async () => dispatchPointer(resizer, "pointermove", 1, 0));
    expect(useDashboardViewStore.getState().minimapWidth).toBe(maximum);
    expect(resizer.getAttribute("aria-valuenow")).toBe(String(maximum));

    await act(async () => dispatchPointer(resizer, "pointermove", 1, 1200));
    expect(useDashboardViewStore.getState().minimapWidth).toBe(DASHBOARD_MINIMAP_MIN_WIDTH);
    expect(shell.style.getPropertyValue("--dashboard-minimap-width")).toBe(`${DASHBOARD_MINIMAP_MIN_WIDTH}px`);
    await act(async () => dispatchPointer(resizer, "pointerup", 1, 1200));
    expect(resizer.classList.contains("is-resizing")).toBe(false);
  });

  it("resizes from the keyboard without changing the selected tab", async () => {
    setViewportWidth(1200);
    const item = tab("tab-keyboard-resize", "s-keyboard-resize", "Keyboard resize target");
    seedDashboard({ workspace: workspace([item]), selectedTabId: item.id });
    await renderDashboard();

    const resizer = container.querySelector<HTMLElement>("[data-dashboard-resizer='true']")!;
    await act(async () => resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    expect(useDashboardViewStore.getState().minimapWidth).toBe(352);
    await act(async () => resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true })));
    expect(useDashboardViewStore.getState().minimapWidth).toBe(320);
    await act(async () => resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    expect(useDashboardViewStore.getState().minimapWidth).toBe(DASHBOARD_MINIMAP_MIN_WIDTH);
    await act(async () => resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    expect(useDashboardViewStore.getState().minimapWidth).toBe(dashboardMinimapMaxWidth(1200));
    expect(useDashboardViewStore.getState().selectedTabId).toBe(item.id);
  });

  it("persists the width across overlay remounts and keeps all three content panes", async () => {
    setViewportWidth(1200);
    const item = tab("tab-remount-resize", "s-remount-resize", "Remount target");
    seedDashboard({ workspace: workspace([item]), selectedTabId: item.id });
    useDashboardViewStore.getState().setMinimapWidth(420);
    await renderDashboard();
    expect(window.localStorage.getItem(DASHBOARD_MINIMAP_STORAGE_KEY)).toBe("420");
    expect(container.querySelector<HTMLElement>(".cmux-dashboard-shell")?.style.getPropertyValue("--dashboard-minimap-width")).toBe("420px");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderDashboard();

    const shell = container.querySelector<HTMLElement>(".cmux-dashboard-shell")!;
    expect(shell.style.getPropertyValue("--dashboard-minimap-width")).toBe("420px");
    expect(shell.querySelector(".cmux-dash-list")).not.toBeNull();
    expect(shell.querySelector("[data-dashboard-center='true']")).not.toBeNull();
    expect(shell.querySelector(".cmux-dashboard-right-pane")).not.toBeNull();
    expect(shell.querySelector(`[data-minimap-tab='${item.id}']`)).not.toBeNull();
  });
});

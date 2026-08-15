// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  syncDashboardEvents: vi.fn(),
  stopEventPolling: vi.fn(),
  onSessionStatusChanged: vi.fn(() => Promise.resolve(() => {})),
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

import { DashboardView } from "../../src/components/dashboard/DashboardView";
import { useInterventionFeedbackStore } from "../../src/components/dashboard/interventionRouting";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import type { SemanticEventEnvelope } from "../../src/lib/livebrief";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { __resetReportInboxStoreForTests, useReportInboxStore } from "../../src/stores/reportInboxStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useRecentInputStore } from "../../src/stores/recentInputStore";
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
    reportInboxOpen: false,
    highlightedEventId: null,
    highlightedEventRequest: 0,
  });
}

function centerBreadcrumb(container: HTMLElement): string | null {
  return container.querySelector<HTMLElement>("[data-dashboard-center='true'] > header > span")?.textContent ?? null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  useDashboardViewStore.setState({ open: false, selectedTabId: null });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  usePaneMetadataStore.setState({ metadata: {}, lastLog: {}, lastLogAt: {} });
  useSessionAttentionStore.getState().resetForTests();
  useStallStore.getState().replaceEntries({});
  useLiveBriefStore.getState().reset();
  __resetReportInboxStoreForTests();
  useInterventionFeedbackStore.getState().reset();
  useRecentInputStore.setState({ recentBySession: {} });
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

describe("DashboardView split3 selection", () => {
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
    await act(async () => sourceButton?.click());

    expect(useDashboardViewStore.getState().selectedTabId).toBe(target.id);
    expect(useDashboardViewStore.getState().reportInboxOpen).toBe(false);
    const sourceRow = container.querySelector<HTMLElement>("[data-dashboard-event='error-source-1']");
    expect(sourceRow?.classList.contains("is-source-highlighted")).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("shows an unconnected batch fold without inventing coverage or a summary", async () => {
    const target = tab("tab-batch", "s-batch", "Batch target");
    const source: SemanticEventEnvelope = {
      eventId: "error-batch-1",
      sourceRevision: 1,
      occurredAt: NOW,
      sourceByteStart: 0,
      sourceByteEnd: 20,
      kind: { type: "error", fingerprint: "batch-error", text: "確認が必要です" },
    };
    seedDashboard({ workspace: workspace([target]), selectedTabId: target.id });
    useLiveBriefStore.setState({ listEventsBySession: { [target.sessionId]: [source] } });
    await renderDashboard();
    await act(async () => { await Promise.resolve(); });

    const inbox = container.querySelector<HTMLButtonElement>("[data-report-inbox-nav='true']");
    await act(async () => inbox?.click());
    expect(container.querySelector("[data-report-batch-unlinked]")?.textContent).toContain("まとめは未接続 1件");
    expect(container.textContent).not.toContain("対象1");
    expect(container.textContent).not.toContain("受領1");
    expect(container.textContent).not.toContain("要判断");
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

    const header = container.querySelector<HTMLElement>("[data-dashboard-center='true'] > header");
    expect(header?.textContent).toContain("Header session");
    expect(header?.textContent).toContain("要回答");
    expect(header?.textContent).toContain("0分");
    expect(header?.querySelector("button[aria-pressed]")).toBeNull();
    expect(container.querySelector(".cmux-dashboard-detail-drawer")).toBeNull();
    expect(container.querySelector("[data-dashboard-center='true'] nav")).toBeNull();
  });
});

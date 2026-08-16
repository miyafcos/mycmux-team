// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handleSocketCommand: vi.fn() }));

vi.mock("../../src/components/layout/socketCommands", () => ({
  handleSocketCommand: mocks.handleSocketCommand,
}));

import { ReplyComposer } from "../../src/components/dashboard/ReplyComposer";
import type { DashboardCardModel } from "../../src/components/dashboard/dashboardModel";
import { mentionTokenFromCandidate, buildMentionCandidates } from "../../src/lib/mentionModel";
import { useComposerStore } from "../../src/stores/composerStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { __resetReportInboxStoreForTests, useReportInboxStore } from "../../src/stores/reportInboxStore";
import type { LiveSessionBrief } from "../../src/lib/livebrief";

const NOW = Date.parse("2026-08-15T00:00:00.000Z");

function card(id: string, sessionId: string, label: string, running = true): DashboardCardModel {
  const workspace = {
    id: `ws-${id}`,
    name: `WS ${id}`,
    gridTemplateId: "1x1" as const,
    panes: [],
    status: "running" as const,
    createdAt: NOW,
  };
  const tab = { id, sessionId, agentId: "codex", agentKind: "codex" as const, label, type: "terminal" as const };
  const pane = { id: `pane-${id}`, sessionId, agentId: "codex", activeTabId: id, tabs: [tab] };
  workspace.panes = [pane];
  return {
    workspace,
    workspaceId: workspace.id,
    workspaceIndex: 0,
    pane,
    paneId: pane.id,
    paneIndex: 0,
    tab,
    tabIndex: 0,
    background: false,
    attentionCategory: null,
    group: running ? "working" : "idle",
    status: running ? "working" : "idle",
    lastActivityAt: NOW,
    label,
    agentKind: "codex",
    unobserved: false,
    neverStarted: false,
    telemetryHealth: "live",
    operationalState: running ? "running" : "idle",
    task: null,
    latestInstruction: null,
    activityText: null,
    checkpoint: null,
    noUpdateMinutes: 0,
  };
}

const first = card("tab-a", "session-a", "設計", true);
const second = card("tab-b", "session-b", "校正", false);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.handleSocketCommand.mockReset();
  useComposerStore.setState({ draftBySession: {}, mentionTokensBySession: {}, commandKindBySession: {} });
  useLiveBriefStore.getState().reset();
  usePaneDragStore.getState().clearDrag();
  __resetReportInboxStoreForTests();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useComposerStore.setState({ draftBySession: {}, mentionTokensBySession: {}, commandKindBySession: {} });
  useLiveBriefStore.getState().reset();
  usePaneDragStore.getState().clearDrag();
  __resetReportInboxStoreForTests();
  vi.unstubAllGlobals();
});

async function renderComposer(targets: DashboardCardModel[] = [first, second]): Promise<HTMLTextAreaElement> {
  await act(async () => {
    root.render(<ReplyComposer card={first} inputRef={createRef<HTMLTextAreaElement>()} mentionTargets={targets} />);
  });
  return container.querySelector("textarea")!;
}

async function input(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(textarea: HTMLTextAreaElement, keyName: string, options: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    const event = new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...options });
    textarea.dispatchEvent(event);
    await Promise.resolve();
  });
}

describe("ReplyComposer mentions", () => {
  it("opens @ suggestions and inserts the selected structured token with Enter", async () => {
    const textarea = await renderComposer();
    await input(textarea, "@");
    expect(container.textContent).toContain("@動いてる全員");
    await key(textarea, "ArrowDown");
    await key(textarea, "Enter");
    expect(container.textContent).toContain("@設計");
    expect(useComposerStore.getState().mentionTokensBySession["session-a"]?.[0]).toMatchObject({
      kind: "session",
      logicalSessionId: "tab-a",
      sessionId: "session-a",
      labelSnapshot: "設計",
    });
    expect(textarea.value).toBe("");
  });

  it("does not confirm a mention while Japanese IME composition is active", async () => {
    const textarea = await renderComposer();
    await input(textarea, "@");
    await act(async () => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      Object.defineProperty(event, "isComposing", { value: true });
      textarea.dispatchEvent(event);
    });
    expect(useComposerStore.getState().mentionTokensBySession["session-a"] ?? []).toHaveLength(0);
    expect(container.querySelector("[role='listbox']")).not.toBeNull();
  });

  it("keeps no-@ input on the selected session's existing direct route", async () => {
    mocks.handleSocketCommand.mockResolvedValue({ confirmed: true });
    const textarea = await renderComposer();
    await input(textarea, "直接送信");
    await key(textarea, "Enter");
    expect(mocks.handleSocketCommand).toHaveBeenCalledWith("pane.send_text", {
      sessionId: "session-a",
      text: "直接送信",
      enter: true,
    });
  });

  it("uses the shared Codex multiline input shape before sending", async () => {
    mocks.handleSocketCommand.mockResolvedValue({ confirmed: true });
    const textarea = await renderComposer();
    await input(textarea, "first\nsecond");
    await key(textarea, "Enter");
    expect(mocks.handleSocketCommand).toHaveBeenCalledWith("pane.send_text", {
      sessionId: "session-a",
      text: "first\x1b[13;2usecond",
      enter: true,
    });
  });

  it("uses the shared Claude bracketed-paste input shape before sending", async () => {
    const claudeCard: DashboardCardModel = {
      ...first,
      tab: { ...first.tab, agentId: "claude-code", agentKind: "claude" },
    };
    mocks.handleSocketCommand.mockResolvedValue({ confirmed: true });
    await act(async () => {
      root.render(<ReplyComposer card={claudeCard} inputRef={createRef<HTMLTextAreaElement>()} mentionTargets={[claudeCard, second]} />);
    });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await input(textarea, "first\nsecond");
    await key(textarea, "Enter");
    expect(mocks.handleSocketCommand).toHaveBeenCalledWith("pane.send_text", {
      sessionId: "session-a",
      text: "\x1b[200~first\nsecond\x1b[201~",
      enter: true,
    });
  });

  it("identifies an unmounted target instead of claiming screen confirmation", async () => {
    mocks.handleSocketCommand.mockResolvedValue({ confirmed: false, reason: "target_unmounted" });
    const textarea = await renderComposer();
    await input(textarea, "確認できない送信");
    await key(textarea, "Enter");
    const note = container.querySelector<HTMLElement>(".cmux-dashboard-composer-note");
    expect(note?.getAttribute("role")).toBe("status");
    expect(note?.textContent).toBe("入力をキューに追加しましたが、対象タブが未マウントのため画面で確認できませんでした");
    expect(note?.textContent).not.toContain("送信を画面で確認しました");
  });

  it("does not submit on modified Enter", async () => {
    const textarea = await renderComposer();
    await input(textarea, "残す下書き");
    await key(textarea, "Enter", { ctrlKey: true });
    expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    expect(textarea.value).toBe("残す下書き");
  });

  it("rejects a QuestionCard reply after its questionId and revision no longer match", async () => {
    const latest = {
      ptySessionId: "session-a",
      agentSessionId: "agent-a",
      agentKind: "codex",
      ptyInstanceId: "instance-a",
      ptyGeneration: 1,
      sourceRevision: 2,
      ptyInputRevision: 4,
      task: null,
      latestInstruction: null,
      taskSourceEventIds: [],
      activityKind: null,
      activityText: null,
      activitySourceEventId: null,
      checkpoint: null,
      checkpointEvidenceEventIds: [],
      pendingInputKind: "freeText",
      pendingPrompt: "現在の質問",
      pendingOptions: [],
      promptEventId: "question-new",
      promptHash: "hash-new",
      eventSeq: 2,
      operationalState: "needsHuman",
      telemetryHealth: "live",
      lastEventAt: NOW,
      lastSuccessfulReadAt: NOW,
      updatedAt: NOW,
      serviceEpoch: "epoch-a",
      briefRevision: 2,
    } satisfies LiveSessionBrief;
    useLiveBriefStore.getState().applyBriefs([latest]);
    useComposerStore.setState({
      draftBySession: { "session-a": "古い回答" },
      mentionTokensBySession: {},
      commandKindBySession: { "session-a": "answer-forward" },
      questionGuardBySession: { "session-a": { questionId: "question-old", revision: 3 } },
    });
    const textarea = await renderComposer();
    await key(textarea, "Enter");
    expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    expect(container.textContent).toContain("質問が更新されたため送信していません");
  });

  it("sends @ recipients as a sealed batch and retries only pre-write failures", async () => {
    const candidates = buildMentionCandidates([
      { logicalSessionId: "tab-a", sessionId: "session-a", label: "設計", workspaceName: "WS a", statusLabel: "作業中", isWorking: true },
      { logicalSessionId: "tab-b", sessionId: "session-b", label: "校正", workspaceName: "WS b", statusLabel: "待機", isWorking: false },
    ]);
    useComposerStore.setState({
      draftBySession: { "session-a": "分配" },
      mentionTokensBySession: {
        "session-a": [mentionTokenFromCandidate(candidates[1]), mentionTokenFromCandidate(candidates[2])],
      },
      commandKindBySession: { "session-a": "plain" },
    });
    mocks.handleSocketCommand.mockImplementation((_: string, input: { sessionId: string }) => (
      input.sessionId === "session-a" ? Promise.resolve({ confirmed: true }) : Promise.reject(new Error("offline"))
    ));
    const textarea = await renderComposer();
    expect(textarea.getAttribute("placeholder")).toBe("ここに指示をタイプ");
    const preview = container.querySelector<HTMLElement>(".cmux-dashboard-dispatch-preview");
    expect(preview?.textContent).toBe("2件へ送ります:");
    expect(container.querySelectorAll(".cmux-dashboard-mention-token")).toHaveLength(2);
    expect(container.querySelectorAll(".cmux-dashboard-dispatch-recipient")).toHaveLength(0);
    await key(textarea, "Enter");
    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(2);
    const [report] = Object.values(useReportInboxStore.getState().dispatchBatchesById);
    expect(report?.batch.status).toBe("sealed");
    expect(report?.batch.assignments.map((assignment) => assignment.instructionRef)).toEqual(["session-a", "session-b"]);
    expect(report?.batch.assignments).toHaveLength(2);
    expect(Object.values(report?.membersByAssignmentId ?? {}).map((member) => member.delivery.state).sort())
      .toEqual(["confirmed", "failed"]);
    expect(container.textContent).toContain("失敗した 1件だけ再送");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("失敗した 1件だけ再送"));
    await act(async () => { retry?.click(); await Promise.resolve(); });
    expect(mocks.handleSocketCommand.mock.calls.filter(([, input]) => input.sessionId === "session-a")).toHaveLength(1);
    expect(mocks.handleSocketCommand.mock.calls.filter(([, input]) => input.sessionId === "session-b")).toHaveLength(2);
    expect(Object.values(useReportInboxStore.getState().dispatchBatchesById)[0]?.batch.assignments).toHaveLength(2);
  });

  it("never retries an unconfirmed payload that may already have been written", async () => {
    const candidates = buildMentionCandidates([
      { logicalSessionId: "tab-a", sessionId: "session-a", label: "設計", workspaceName: "WS a", statusLabel: "作業中", isWorking: true },
      { logicalSessionId: "tab-b", sessionId: "session-b", label: "校正", workspaceName: "WS b", statusLabel: "待機", isWorking: false },
    ]);
    useComposerStore.setState({
      draftBySession: { "session-a": "分配" },
      mentionTokensBySession: { "session-a": [mentionTokenFromCandidate(candidates[1]), mentionTokenFromCandidate(candidates[2])] },
      commandKindBySession: { "session-a": "plain" },
    });
    mocks.handleSocketCommand.mockImplementation((_: string, input: { sessionId: string }) => (
      input.sessionId === "session-a" ? Promise.resolve({ confirmed: false, reason: "submit_unconfirmed" }) : Promise.reject(new Error("offline"))
    ));
    const textarea = await renderComposer();
    await key(textarea, "Enter");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("失敗した 1件だけ再送"));
    await act(async () => { retry?.click(); await Promise.resolve(); });
    expect(mocks.handleSocketCommand.mock.calls.filter(([, input]) => input.sessionId === "session-a")).toHaveLength(1);
    expect(mocks.handleSocketCommand.mock.calls.filter(([, input]) => input.sessionId === "session-b")).toHaveLength(2);
    expect(container.textContent).toContain("書き込み結果は未確認");
  });

  it("accepts a minimap-tab drop without changing the layout drag store", async () => {
    const textarea = await renderComposer();
    const target = container.querySelector<HTMLElement>("[data-composer-pane-drop-target='true']")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    usePaneDragStore.getState().beginDrag({ kind: "tab", surface: "minimap", workspaceId: "ws-tab-b", paneId: "pane-tab-b", tabId: "tab-b", label: "old label" }, { x: 1, y: 1 });
    await act(async () => {
      const event = new Event("pointerup", { bubbles: true });
      Object.defineProperties(event, { clientX: { value: 1 }, clientY: { value: 1 } });
      window.dispatchEvent(event);
    });
    expect(useComposerStore.getState().mentionTokensBySession["session-a"]?.[0]).toMatchObject({ logicalSessionId: "tab-b", sessionId: "session-b" });
    expect(usePaneDragStore.getState().item?.tabId).toBe("tab-b");
    expect(textarea.disabled).toBe(false);
  });

  it("accepts a minimap tab-bundle drop as ordered mentions without changing the layout drag store", async () => {
    const textarea = await renderComposer();
    const target = container.querySelector<HTMLElement>("[data-composer-pane-drop-target='true']")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    usePaneDragStore.getState().beginDrag({
      kind: "tab-bundle",
      surface: "minimap",
      workspaceId: "ws-tab-a",
      paneId: "pane-tab-a",
      tabIds: ["tab-a", "tab-b"],
      anchorTabId: "tab-a",
      label: "設計",
    }, { x: 1, y: 1 });
    await act(async () => {
      const event = new Event("pointerup", { bubbles: true });
      Object.defineProperties(event, { clientX: { value: 1 }, clientY: { value: 1 } });
      window.dispatchEvent(event);
    });
    expect(useComposerStore.getState().mentionTokensBySession["session-a"]?.map((token) => token.logicalSessionId)).toEqual(["tab-a", "tab-b"]);
    expect(usePaneDragStore.getState().item).toMatchObject({ kind: "tab-bundle", tabIds: ["tab-a", "tab-b"] });
    expect(textarea.disabled).toBe(false);
  });
});

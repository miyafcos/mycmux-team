import { dashboardText } from "../helpers/dashboardA11y";
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRef } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handleSocketCommand: vi.fn(), peek: vi.fn(), cached: vi.fn(), refresh: vi.fn(), terminal: vi.fn() }));

vi.mock("../../src/components/layout/socketCommands", () => ({
  handleSocketCommand: mocks.handleSocketCommand,
}));

vi.mock("../../src/lib/skillsApi", () => ({ skillsApi: { peek: mocks.peek, cached: mocks.cached, refresh: mocks.refresh } }));
vi.mock("../../src/components/terminal/AgentTabLiveStrip", () => ({ AgentTabLiveStrip: () => null }));
import type { SkillCatalog, SkillRow } from "../../src/lib/skillsApi";
import { AgentTabConversationControls } from "../../src/components/terminal/AgentTabConversationControls";
import { AGENT_TAB_SLASH_RECENT_KEY, resetAgentTabSlashSkillsForTest } from "../../src/components/terminal/agentTabSlashSuggest";

import { ReplyComposer } from "../../src/components/dashboard/ReplyComposer";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { resolveDisplayState, type DashboardCardModel } from "../../src/components/dashboard/dashboardModel";
import { DashboardCardRow } from "../../src/components/dashboard/DashboardCardRow";
import { stateLabels } from "../../src/components/dashboard/stateLabels";
import { buildDashboardMentionCandidates } from "../../src/components/dashboard/dashboardMentionCandidates";
import { mentionTokenFromCandidate, buildMentionCandidates } from "../../src/lib/mentionModel";
import { useComposerStore } from "../../src/stores/composerStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { __resetReportInboxStoreForTests, useReportInboxStore } from "../../src/stores/reportInboxStore";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import { ingestAskQuestionLines, useAskQuestionStore } from "../../src/stores/askQuestionStore";

const NOW = Date.parse("2026-08-15T00:00:00.000Z");
const askFixture = (JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../fixtures/askQuestionScreens.json"), "utf8"),
) as { single: string[] }).single;

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
  resetAgentTabSlashSkillsForTest();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.handleSocketCommand.mockReset();
  mocks.peek.mockReturnValue(null);
  mocks.cached.mockResolvedValue(null);
  useComposerStore.setState({ draftBySession: {}, mentionTokensBySession: {}, commandKindBySession: {} });
  useLiveBriefStore.getState().reset();
  usePaneDragStore.getState().clearDrag();
  __resetReportInboxStoreForTests();
  useAskQuestionStore.getState().resetForTests();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useComposerStore.setState({ draftBySession: {}, mentionTokensBySession: {}, commandKindBySession: {} });
  useLiveBriefStore.getState().reset();
  usePaneDragStore.getState().clearDrag();
  __resetReportInboxStoreForTests();
  useAskQuestionStore.getState().resetForTests();
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
  it.each([
    "needsHuman", "error", "running", "noUpdate", "done", "acknowledged",
    "idle", "stopped", "delegated", "delegationUnknown", "unknown",
  ] as const)("keeps %s mention menu and selected token marks aligned with the session row", async (state) => {
    const target = card("state-target", "state-session", "State target", false);
    target.now = NOW;
    if (state === "needsHuman") target.operationalState = "needsHuman";
    if (state === "error") target.attentionCategory = "error";
    if (state === "running") target.operationalState = "running";
    if (state === "noUpdate") target.noUpdateMinutes = 45;
    if (state === "acknowledged") target.manualDoneAt = NOW;
    if (state === "stopped") target.telemetryHealth = "ended";
    if (state === "done" || state === "delegated" || state === "delegationUnknown") {
      target.attentionCategory = "done";
      if (state !== "done") {
        target.tab = { ...target.tab, delegatedByTabId: "parent", delegatedByAgentSessionId: "parent-agent" };
        if (state === "delegated") target.delegationParent = {
          tabId: "parent", label: "Parent", alive: true, state: "alive", checkedAt: NOW, agentSessionId: "parent-agent",
        };
      }
    }
    if (state === "unknown") target.statusSignals = {
      activity: "unknown", health: "unknown", lastOutputAt: null, lastMonitorAt: null,
      lastEvidenceAt: null, processStartedAt: null,
    };
    expect(resolveDisplayState(target)).toBe(state);
    const candidates = buildDashboardMentionCandidates([target]);
    const candidate = candidates.find((item) => item.kind === "session")!;
    expect(candidate.displayState).toBe(state);
    expect(candidate.statusLabel).toBe(stateLabels(state).tooltip);

    const textarea = await renderComposer([target]);
    await input(textarea, "@State");
    const option = container.querySelector<HTMLElement>("[role=option]")!;
    const glyph = option.querySelector<HTMLElement>("[data-dashboard-status]")!;
    expect(glyph.dataset.dashboardStatus).toBe(state);
    if (state === "unknown" || state === "noUpdate") {
      expect(glyph.querySelector("svg,[data-status-shape]")).toBeNull();
      expect(option.querySelector("small")?.getAttribute("title")).toBe(stateLabels(state).tooltip);
    } else {
      expect(glyph.querySelector("svg")).not.toBeNull();
    }
    expect(glyph.getAttribute("title")).toBe(stateLabels(state).tooltip);
    expect(glyph.getAttribute("aria-label")).toBe(stateLabels(state).tooltip);

    const rowHost = document.createElement("div");
    const rowRoot = createRoot(rowHost);
    try {
      await act(async () => rowRoot.render(<DashboardCardRow card={target} selected={false} open={false}
        now={NOW} hideWorkspaceBadge={false} onSelect={() => undefined} onJump={() => undefined} />));
      const rowGlyph = rowHost.querySelector("[data-dashboard-status]")!;
      expect(glyph.querySelector("svg")?.innerHTML).toBe(rowGlyph.querySelector("svg")?.innerHTML);
      await key(textarea, "Enter");
      const selected = container.querySelector<HTMLElement>(".cmux-dashboard-mention-token [data-dashboard-status]")!;
      expect(selected.dataset.dashboardStatus).toBe(state);
      expect(selected.querySelector("svg")?.innerHTML).toBe(rowGlyph.querySelector("svg")?.innerHTML);
      expect(selected.getAttribute("title")).toBe(stateLabels(state).tooltip);
      expect(selected.getAttribute("aria-label")).toBe(stateLabels(state).tooltip);
    } finally {
      await act(async () => rowRoot.unmount());
    }
    expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
  });

  it("uses the running mark for the working-all menu and selected token", async () => {
    const textarea = await renderComposer();
    await input(textarea, "@");
    const option = container.querySelector<HTMLElement>("[role=option]")!;
    expect(option.querySelector("[data-dashboard-status=running]")).not.toBeNull();
    const label = buildMentionCandidates([])[0].statusLabel;
    expect(option.querySelector("[role=img]")?.getAttribute("aria-label")).toBe(label);
    expect(option.querySelector("[role=img]")?.getAttribute("title")).toBe(label);
    await key(textarea, "Enter");
    const selected = container.querySelector(".cmux-dashboard-mention-token")!;
    expect(selected.querySelector("[data-dashboard-status=running]")).not.toBeNull();
    expect(selected.querySelector("[role=img]")?.getAttribute("aria-label")).toBe(label);
    expect(selected.querySelector("[role=img]")?.getAttribute("title")).toBe(label);
    expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
  });

  it("opens @ suggestions and inserts the selected structured token with Enter", async () => {
    const textarea = await renderComposer();
    await input(textarea, "@");
    expect(dashboardText(container)).toContain("@動いてる全員");
    await key(textarea, "ArrowDown");
    await key(textarea, "Enter");
    expect(dashboardText(container)).toContain("@設計");
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
    expect(container.querySelector(".cmux-dashboard-composer-target")?.textContent).toContain("送信先：このタブ（");
    await input(textarea, "直接送信");
    await key(textarea, "Enter");
    expect(mocks.handleSocketCommand).toHaveBeenCalledWith("pane.send_text", {
      sessionId: "session-a",
      text: "直接送信",
      enter: true,
    });
  });

  it("blocks a direct composer send while the target has an active AskUserQuestion", async () => {
    ingestAskQuestionLines(first.tab.sessionId, askFixture, NOW, 1);
    const textarea = await renderComposer();
    await input(textarea, "質問カードを迂回する指示");
    await key(textarea, "Enter");
    expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    expect(dashboardText(container)).toContain("質問カードで回答するまで通常の指示は送信できません");
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
    expect(note?.querySelector("[data-dashboard-status]")?.getAttribute("data-dashboard-status")).toBe("unknown");
    expect(note?.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("入力をキューに追加しましたが、対象タブが未マウントのため画面で確認できませんでした");
    expect(note?.querySelector("[role=img]")?.getAttribute("aria-label")).not.toContain("送信を画面で確認しました");
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
    expect(dashboardText(container)).toContain("質問が更新されたため送信していません");
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
    expect(textarea.getAttribute("placeholder")).toBe("メッセージを入力");
    expect(container.querySelector(".cmux-dashboard-composer-target")?.textContent).toBe("送信先：@で指定したタブ（2 件）");
    const preview = container.querySelector<HTMLElement>(".cmux-dashboard-dispatch-preview");
    expect(preview?.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("2件へ送ります");
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
    expect(dashboardText(container)).toContain("失敗した 1件だけ再送");
    const retry = [...container.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent)?.includes("失敗した 1件だけ再送"));
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
    const retry = [...container.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent)?.includes("失敗した 1件だけ再送"));
    await act(async () => { retry?.click(); await Promise.resolve(); });
    expect(mocks.handleSocketCommand.mock.calls.filter(([, input]) => input.sessionId === "session-a")).toHaveLength(1);
    expect(mocks.handleSocketCommand.mock.calls.filter(([, input]) => input.sessionId === "session-b")).toHaveLength(2);
    expect(dashboardText(container)).toContain("書き込み結果は未確認");
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

describe("review fix 1: batch post-write refusal", () => {
  it.each([{ textWritten: true }, { writeMayHaveOccurred: true }])("keeps possibly written members out of retry (%j)", async (written) => {
    const candidates = buildMentionCandidates([
      { logicalSessionId: "tab-a", sessionId: "session-a", label: "設計", workspaceName: "WS a", statusLabel: "作業中", isWorking: true },
      { logicalSessionId: "tab-b", sessionId: "session-b", label: "校正", workspaceName: "WS b", statusLabel: "待機", isWorking: false },
    ]);
    useComposerStore.setState({ draftBySession: { "session-a": "分配" },
      mentionTokensBySession: { "session-a": [mentionTokenFromCandidate(candidates[1]), mentionTokenFromCandidate(candidates[2])] } });
    mocks.handleSocketCommand.mockImplementation((_: string, args: { sessionId: string }) => args.sessionId === "session-a"
      ? Promise.resolve({ sent: false, ...written, message: "再送せず確認" }) : Promise.reject(new Error("before write")));
    const textarea = await renderComposer(); await key(textarea, "Enter");
    const report = Object.values(useReportInboxStore.getState().dispatchBatchesById)[0];
    expect(Object.values(report.membersByAssignmentId).find((member) => member.ptySessionId === "session-a")?.delivery.state).toBe("unconfirmed");
    const retry = [...container.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent)?.includes("失敗した 1件だけ再送"));
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); await Promise.resolve(); });
    expect(mocks.handleSocketCommand.mock.calls.filter(([, args]) => args.sessionId === "session-a")).toHaveLength(1);
    expect(mocks.handleSocketCommand.mock.calls.filter(([, args]) => args.sessionId === "session-b")).toHaveLength(2);
  });
});

describe("tab composer note space", () => {
  it.each([
    { label: "confirmation", outcome: { confirmed: true }, role: "status", live: "polite", text: dashboardStrings.sendConfirmedOnScreen },
    { label: "long error", outcome: { sent: false, message: "A long pre-write error. ".repeat(30) }, role: "alert", live: "assertive", text: "A long pre-write error. ".repeat(30) },
  ])("retains one silent slot through a $label and back to no note", async ({ outcome, role, live, text }) => {
    const draw = (target: DashboardCardModel) => <ReplyComposer card={target} inputRef={createRef()} mentionTargets={[first, second]} tabSessionId={target.tab.sessionId} showSuggestions={false} />;
    await act(async () => root.render(draw(first)));
    const slot = container.querySelector<HTMLElement>(".cmux-dashboard-composer-note")!;
    const composer = container.querySelector(".cmux-dashboard-composer")!;
    const childCount = composer.children.length;
    expect(slot).not.toBeNull();
    expect(slot.childNodes).toHaveLength(0);
    expect(slot.getAttribute("role")).toBeNull();
    expect(slot.getAttribute("aria-live")).toBeNull();
    let complete!: (value: unknown) => void;
    mocks.handleSocketCommand.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await input(textarea, "new tab message");
    await key(textarea, "Enter");
    expect(container.querySelector(".cmux-dashboard-composer-note")).toBe(slot);
    expect(composer.children).toHaveLength(childCount);
    expect(slot.getAttribute("role")).toBeNull();
    await act(async () => complete(outcome));
    expect(container.querySelectorAll(".cmux-dashboard-composer-note")).toHaveLength(1);
    expect(container.querySelector(".cmux-dashboard-composer-note")).toBe(slot);
    expect(composer.children).toHaveLength(childCount);
    expect(slot.getAttribute("role")).toBe(role);
    expect(slot.getAttribute("aria-live")).toBe(live);
    expect(slot.getAttribute("title")).toBe(text);
    expect(slot.querySelector("[role=img]")?.getAttribute("aria-label")).toBe(text);
    expect(slot.textContent).toBe(text);
    await act(async () => root.render(draw(second)));
    expect(container.querySelector(".cmux-dashboard-composer-note")).toBe(slot);
    expect(composer.children).toHaveLength(childCount);
    expect(slot.childNodes).toHaveLength(0);
    expect(slot.getAttribute("role")).toBeNull();
    expect(slot.getAttribute("aria-live")).toBeNull();
    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(1);
  });
  it("leaves a dashboard composer without a note element until there is a note", async () => {
    mocks.handleSocketCommand.mockResolvedValue({ confirmed: true });
    const textarea = await renderComposer();
    expect(container.querySelector(".cmux-dashboard-composer-note")).toBeNull();
    await input(textarea, "dashboard message");
    await key(textarea, "Enter");
    expect(container.querySelector(".cmux-dashboard-composer-note")?.getAttribute("role")).toBe("status");
    await act(async () => root.render(<ReplyComposer card={second} inputRef={createRef()} mentionTargets={[first, second]} />));
    expect(container.querySelector(".cmux-dashboard-composer-note")).toBeNull();
  });
});

describe("destination display in a tab", () => {
  it("omits only this tab's resolved destination and keeps dashboard defaults", async () => {
    await act(async () => root.render(<ReplyComposer card={first} inputRef={createRef()} mentionTargets={[first, second]} tabSessionId="session-a" />));
    expect(container.querySelector(".cmux-dashboard-composer-target")).toBeNull();
    await renderComposer();
    expect(container.querySelector(".cmux-dashboard-composer-target")!.textContent).toContain("送信先：このタブ");
  });
  it("shows another tab's destination when mentioned", async () => {
    const candidates = buildMentionCandidates([{ logicalSessionId: "tab-b", sessionId: "session-b", label: "校正", workspaceName: "WS b", statusLabel: "待機", isWorking: false }]);
    useComposerStore.setState({ mentionTokensBySession: { "session-a": [mentionTokenFromCandidate(candidates[1])] } });
    await act(async () => root.render(<ReplyComposer card={first} inputRef={createRef()} mentionTargets={[first, second]} tabSessionId="session-a" />));
    expect(container.querySelector(".cmux-dashboard-composer-target")!.textContent).toContain("@で指定したタブ");
  });
  it("retains unknown-target protection and the draft", async () => {
    useComposerStore.getState().setDraft("session-a", "retain this draft");
    await act(async () => root.render(<ReplyComposer card={null} inputRef={createRef()} mentionTargets={[first]} tabSessionId="session-a" />));
    expect(container.querySelector(".cmux-dashboard-composer-target")).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);
    expect(useComposerStore.getState().draftBySession["session-a"]).toBe("retain this draft");
    expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
  });
});


describe("in-tab slash command submission", () => {
  let onSlashCommandSent: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    onSlashCommandSent = vi.fn();
    useComposerStore.setState({ dashboardOptimisticMessagesBySession: {}, dashboardRetryBySession: {}, questionGuardBySession: {} });
  });

  async function renderTabComposer(inTab = true, target = first): Promise<HTMLTextAreaElement> {
    await act(async () => root.render(<ReplyComposer card={target} inputRef={createRef()} mentionTargets={[target, second]}
      tabSessionId={inTab ? target.tab.sessionId : undefined} onSlashCommandSent={onSlashCommandSent} showSuggestions={false} />));
    return container.querySelector<HTMLTextAreaElement>("textarea")!;
  }
  const messages = () => useComposerStore.getState().dashboardOptimisticMessagesBySession["session-a"] ?? [];
  const note = () => container.querySelector<HTMLElement>(".cmux-dashboard-composer-note");

  it.each(["codex", "claude"] as const)("sends /cost exactly once with the existing %s payload and switches only after the response", async kind => {
    const target: DashboardCardModel = { ...first, tab: { ...first.tab, agentId: kind, agentKind: kind } };
    let complete!: (value: unknown) => void;
    mocks.handleSocketCommand.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const textarea = await renderTabComposer(true, target);
    await input(textarea, " /cost ");
    await key(textarea, "Enter");
    expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", {
      sessionId: "session-a", text: kind === "claude" ? "\x1b[200~ /cost\x1b[201~" : " /cost", enter: true,
    });
    expect(messages()).toHaveLength(0);
    expect(textarea.value).toBe("");
    expect(onSlashCommandSent).not.toHaveBeenCalled();
    await act(async () => complete({ sent: true, confirmed: true }));
    await vi.waitFor(() => expect(onSlashCommandSent).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(messages()).toHaveLength(0);
    expect(note()?.childNodes).toHaveLength(0);
    expect(note()?.getAttribute("role")).toBeNull();
    expect(useComposerStore.getState().draftBySession["session-a"] ?? "").toBe("");
    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "no outcome", outcome: undefined },
    { label: "null outcome", outcome: null },
    { label: "unconfirmed submit", outcome: { confirmed: false, reason: "submit_unconfirmed", message: "delivery unknown" } },
    { label: "possible write", outcome: { confirmed: false, writeMayHaveOccurred: true, message: "delivery unknown" } },
    { label: "text written before refusal", outcome: { sent: false, textWritten: true, message: "delivery unknown" } },
    { label: "possible write before refusal", outcome: { sent: false, writeMayHaveOccurred: true, message: "delivery unknown" } },
    { label: "Enter written before refusal", outcome: { sent: false, enterWritten: true, message: "delivery unknown" } },
  ])("switches without a bubble or unconfirmed note for $label and never resends", async ({ outcome }) => {
    mocks.handleSocketCommand.mockResolvedValue(outcome);
    const textarea = await renderTabComposer();
    await input(textarea, "/cost");
    await key(textarea, "Enter");
    await vi.waitFor(() => expect(onSlashCommandSent).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(messages()).toHaveLength(0);
    expect(note()?.childNodes).toHaveLength(0);
    expect(note()?.getAttribute("role")).toBeNull();
    expect(textarea.value).toBe("");
    await renderTabComposer();
    expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId: "session-a", text: "/cost", enter: true });
    expect(onSlashCommandSent).toHaveBeenCalledTimes(1);
  });

  it.each(["refusal", "exception"] as const)("keeps a pre-write %s in conversation with its draft and failure note", async failure => {
    if (failure === "exception") mocks.handleSocketCommand.mockRejectedValueOnce(new Error("offline"));
    else mocks.handleSocketCommand.mockResolvedValueOnce({ sent: false, textWritten: false, enterWritten: false, writeMayHaveOccurred: false, message: "before write" });
    const textarea = await renderTabComposer();
    await input(textarea, "/cost");
    await key(textarea, "Enter");
    await vi.waitFor(() => expect(note()?.getAttribute("role")).toBe("alert"), { timeout: 5000 });
    expect(onSlashCommandSent).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(0);
    expect(textarea.value).toBe("/cost");
    expect(note()?.getAttribute("title")).toBe(failure === "exception" ? `${dashboardStrings.sendFailedBeforeWrite} (offline)` : "before write");
    await renderTabComposer();
    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["refusal", "exception"] as const)("preserves a newer draft on a late pre-write %s", async failure => {
    let complete!: () => void;
    mocks.handleSocketCommand.mockImplementationOnce(() => new Promise((resolve, reject) => {
      complete = () => failure === "exception" ? reject(new Error("offline")) : resolve({ sent: false, message: "before write" });
    }));
    const textarea = await renderTabComposer();
    await input(textarea, "/cost");
    await key(textarea, "Enter");
    await act(async () => useComposerStore.getState().setDraft("session-a", "newer draft"));
    await act(async () => complete());
    await vi.waitFor(() => expect(note()?.getAttribute("role")).toBe("alert"), { timeout: 5000 });
    expect(textarea.value).toBe("newer draft");
    expect(onSlashCommandSent).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(0);
    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(1);
  });

  it("clears an earlier failure note when a manually resubmitted slash command reaches the writer", async () => {
    mocks.handleSocketCommand.mockResolvedValueOnce({ sent: false, message: "before write" });
    const textarea = await renderTabComposer();
    await input(textarea, "/cost");
    await key(textarea, "Enter");
    expect(note()?.getAttribute("role")).toBe("alert");
    mocks.handleSocketCommand.mockResolvedValueOnce({ confirmed: false, reason: "submit_unconfirmed" });
    await key(textarea, "Enter");
    await vi.waitFor(() => expect(onSlashCommandSent).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(note()?.childNodes).toHaveLength(0);
    expect(note()?.getAttribute("role")).toBeNull();
    expect(messages()).toHaveLength(0);
    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(2);
  });

  it.each([
    { text: "こんにちは", body: "こんにちは" },
    { text: "/cost\nmore", body: "/cost\x1b[13;2umore" },
  ])("keeps ordinary tab text $text on the existing optimistic route", async ({ text, body }) => {
    mocks.handleSocketCommand.mockResolvedValue({ confirmed: false, reason: "submit_unconfirmed" });
    const textarea = await renderTabComposer();
    await input(textarea, text);
    await key(textarea, "Enter");
    expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId: "session-a", text: body, enter: true });
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({ text, state: "sent", error: dashboardStrings.sendSubmitUnconfirmed });
    expect(note()?.getAttribute("title")).toBe(dashboardStrings.sendSubmitUnconfirmed);
    expect(onSlashCommandSent).not.toHaveBeenCalled();
  });

  it("keeps dashboard /cost on the existing optimistic route even when given the callback", async () => {
    mocks.handleSocketCommand.mockResolvedValue({ confirmed: false, reason: "submit_unconfirmed" });
    const textarea = await renderTabComposer(false);
    await input(textarea, "/cost");
    await key(textarea, "Enter");
    expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId: "session-a", text: "/cost", enter: true });
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({ text: "/cost", state: "sent", error: dashboardStrings.sendSubmitUnconfirmed });
    expect(note()?.getAttribute("title")).toBe(dashboardStrings.sendSubmitUnconfirmed);
    expect(onSlashCommandSent).not.toHaveBeenCalled();
  });

  it.each(["session-a", "session-b"])("keeps a slash command addressed to @%s on the sealed batch route", async recipientSessionId => {
    const candidate = buildDashboardMentionCandidates([first, second]).find(candidate => candidate.kind === "session" && candidate.sessionId === recipientSessionId)!;
    useComposerStore.getState().addMentionToken("session-a", mentionTokenFromCandidate(candidate));
    mocks.handleSocketCommand.mockResolvedValue({ confirmed: true });
    const textarea = await renderTabComposer();
    await input(textarea, "/cost");
    await key(textarea, "Enter");
    expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId: recipientSessionId, text: "/cost", enter: true });
    const batch = Object.values(useReportInboxStore.getState().dispatchBatchesById)[0];
    expect(Object.values(batch.membersByAssignmentId)).toEqual([expect.objectContaining({ ptySessionId: recipientSessionId, delivery: expect.objectContaining({ state: "confirmed" }) })]);
    expect(messages()).toHaveLength(0);
    expect(onSlashCommandSent).not.toHaveBeenCalled();
  });
});

describe("Claude slash suggestions in tab composers", () => {
  const sessionId = "slash-session";
  const skill = (name: string, patch: Partial<SkillRow> = {}): SkillRow =>
    ({ id: name, calls: { claude: "/" + name }, line: "\u4f5c\u696d\u3092\u9032\u3081\u308b", lastUsedAt: null, ...patch } as SkillRow);
  const catalog = (skills: SkillRow[] = []): SkillCatalog =>
    ({ generatedAt: "", categories: [], skills, hiddenCount: 0, newCount: 0 });
  const target = (kind = "claude"): DashboardCardModel => {
    const tab = { id: "slash-tab", sessionId, agentId: kind, agentKind: kind as "claude", type: "terminal" as const, label: "Slash" };
    const pane = { id: "slash-pane", sessionId, agentId: kind, activeTabId: tab.id, tabs: [tab] };
    const workspace = { id: "slash-ws", name: "Slash", gridTemplateId: "1x1" as const, panes: [pane], status: "running" as const, createdAt: 1 };
    return { tab, pane, workspace, workspaceId: workspace.id, workspaceIndex: 0, paneId: pane.id, paneIndex: 0,
      tabIndex: 0, background: false, attentionCategory: null, group: "working", status: "working", lastActivityAt: 1,
      label: "Slash", agentKind: kind as "claude", unobserved: false, neverStarted: false, telemetryHealth: "live",
      operationalState: "running", task: null, latestInstruction: null, activityText: null, checkpoint: null, noUpdateMinutes: 0 };
  };
  let host: HTMLDivElement, root: Root;
  const inputRef = createRef<HTMLTextAreaElement>();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    vi.resetAllMocks();
    mocks.handleSocketCommand.mockResolvedValue({ confirmed: false, reason: "submit_unconfirmed", message: "delivery unknown" });
    mocks.peek.mockReturnValue(catalog());
    mocks.cached.mockResolvedValue(catalog());
    useComposerStore.setState({ draftBySession: {}, mentionTokensBySession: {}, commandKindBySession: {}, questionGuardBySession: {},
      dashboardOptimisticMessagesBySession: {}, dashboardRetryBySession: {} });
    useLiveBriefStore.getState().reset();
    useAskQuestionStore.getState().resetForTests();
    usePaneDragStore.getState().clearDrag();
    localStorage.removeItem(AGENT_TAB_SLASH_RECENT_KEY);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });
  async function render(kind = "claude", inTab = true, actualKind?: string, controls = false) {
    const card = target(kind);
    await act(async () => root.render(controls
      ? <AgentTabConversationControls sessionId={sessionId} tabId={card.tab.id} agentKind={actualKind ?? kind} live={false}
        events={[]} card={card} cards={[card]} inputRef={inputRef} active={false} onTerminal={mocks.terminal} />
      : <ReplyComposer card={card} inputRef={inputRef} mentionTargets={[card]} tabSessionId={inTab ? sessionId : undefined}
        tabAgentKind={actualKind} onSlashCommandSent={mocks.terminal} showSuggestions={false} />));
    return host.querySelector<HTMLTextAreaElement>("textarea")!;
  }
  async function input(textarea: HTMLTextAreaElement, value: string, composing = false) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: composing }));
    });
  }
  async function key(textarea: HTMLTextAreaElement, name: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
    await act(async () => { textarea.dispatchEvent(event); });
    return event;
  }
  async function select(textarea: HTMLTextAreaElement, cursor: number) {
    await act(async () => {
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
  async function composition(textarea: HTMLTextAreaElement, type: "compositionstart" | "compositionend") {
    await act(async () => { textarea.dispatchEvent(new CompositionEvent(type, { bubbles: true })); });
  }
  const menu = () => host.querySelector<HTMLElement>(".agent-tab-slash-menu");
  const options = () => [...host.querySelectorAll<HTMLButtonElement>(".agent-tab-slash-menu [role=option]")];
  const names = () => options().map(option => option.querySelector(".agent-tab-slash-name")!.textContent!);
  const selected = () => menu()?.querySelector('[aria-selected="true"] .agent-tab-slash-name')?.textContent;
  const note = () => host.querySelector(".cmux-dashboard-composer-note");
  async function clickSend() {
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="\u9001\u4fe1"]')!.click());
  }
  const noBubbleOrNote = () => {
    expect(useComposerStore.getState().dashboardOptimisticMessagesBySession[sessionId] ?? []).toHaveLength(0);
    expect(note()?.childNodes).toHaveLength(0);
    expect(note()?.getAttribute("role")).toBeNull();
  };

  describe("Claude in-tab slash menu", () => {
    it("shows built-ins with accessible options, hints, short Japanese descriptions and eight scrollable rows", async () => {
      const textarea = await render();
      await input(textarea, "/");
      expect(menu()?.getAttribute("role")).toBe("listbox");
      expect(menu()?.getAttribute("aria-label")).toBe("\u30b9\u30e9\u30c3\u30b7\u30e5\u30b3\u30de\u30f3\u30c9\u306e\u5019\u88dc");
      expect(options()).toHaveLength(94);
      expect(names()[0]).toBe("/add-dir");
      expect(options()[0].querySelector("small")?.textContent).toBe("<path>");
      expect(options()[0].querySelector(".agent-tab-slash-description")?.textContent).toBe("\u4f5c\u696d\u30d5\u30a9\u30eb\u30c0\u3092\u8ffd\u52a0");
      expect(textarea.getAttribute("aria-controls")).toBe(menu()?.id);
      expect(textarea.getAttribute("aria-activedescendant")).toBe(options()[0].id);
      expect(options()[0].getAttribute("aria-selected")).toBe("true");
      const css = readFileSync(resolve(import.meta.dirname, "../../src/components/terminal/AgentTabConversation.css"), "utf8");
      expect(css).toMatch(/\.agent-tab-slash-menu \{[^}]*grid-auto-rows: 32px;[^}]*max-height: calc\(8 \* 32px\);[^}]*overflow-y: auto;/);
    });
    it("wraps arrow navigation in both directions and updates the accessible active option", async () => {
      const textarea = await render(); await input(textarea, "/");
      await key(textarea, "ArrowUp"); expect(selected()).toBe(names().at(-1));
      await key(textarea, "ArrowDown"); expect(selected()).toBe(names()[0]);
      await key(textarea, "ArrowDown"); expect(selected()).toBe(names()[1]);
      expect(textarea.getAttribute("aria-activedescendant")).toBe(options()[1].id);
    });
    it.each([["/hel", "/help"], ["/add-d", "/add-dir "], ["/eff", "/effort "]])("Tab completes %s to %s without sending", async (text, expected) => {
      const textarea = await render(); await input(textarea, text); await key(textarea, "Tab");
      expect(textarea.value).toBe(expected); expect(textarea.selectionStart).toBe(expected.length);
      expect(menu()).toBeNull(); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    });
    it("clicks complete without sending and pointerdown preserves editor focus", async () => {
      const textarea = await render(); await input(textarea, "/add-d"); textarea.focus();
      const option = options()[0];
      const down = new Event("pointerdown", { bubbles: true, cancelable: true });
      await act(async () => { option.dispatchEvent(down); option.click(); });
      expect(down.defaultPrevented).toBe(true); expect(document.activeElement).toBe(textarea);
      expect(textarea.value).toBe("/add-dir "); expect(menu()).toBeNull(); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    });
    it("Escape keeps the draft; another edit reopens, while a closed menu leaves arrows alone", async () => {
      const textarea = await render(); await input(textarea, "/he"); await key(textarea, "Escape");
      expect(menu()).toBeNull(); expect(textarea.value).toBe("/he");
      expect((await key(textarea, "ArrowDown")).defaultPrevented).toBe(false);
      expect((await key(textarea, "Tab")).defaultPrevented).toBe(false);
      await input(textarea, "/hel"); expect(menu()).not.toBeNull(); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    });
    it("closes for arguments and newlines and opens only with the caret back in the name", async () => {
      const textarea = await render();
      await input(textarea, "/help argument"); expect(menu()).toBeNull();
      await select(textarea, 3);
      await vi.waitFor(() => expect(menu()).not.toBeNull(), { timeout: 5000 });
      await select(textarea, 8);
      await vi.waitFor(() => expect(menu()).toBeNull(), { timeout: 5000 });
      await input(textarea, "/help\nmore"); expect(menu()).toBeNull();
      await input(textarea, "/help\u2028more"); expect(menu()).toBeNull();
    });
    it("keeps existing arguments when completing a command name in the middle of a draft", async () => {
      const textarea = await render(); await input(textarea, "/add-d C:/existing"); await select(textarea, 4);
      await vi.waitFor(() => expect(menu()).not.toBeNull(), { timeout: 5000 });
      await key(textarea, "Tab"); expect(textarea.value).toBe("/add-dir C:/existing");
    });
    it("keeps slash and mention menus mutually exclusive without changing mention Enter completion", async () => {
      const textarea = await render(); await input(textarea, "/hel"); expect(menu()).not.toBeNull();
      await input(textarea, "@"); expect(menu()).toBeNull();
      expect(host.querySelectorAll("[role=listbox]")).toHaveLength(1);
      await key(textarea, "ArrowDown"); await key(textarea, "Enter");
      expect(useComposerStore.getState().mentionTokensBySession[sessionId]).toHaveLength(1);
      expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
      await input(textarea, "/hel"); expect(host.querySelectorAll("[role=listbox]")).toHaveLength(1); expect(menu()).not.toBeNull();
    });
    it("adds cached skills after a slow read without delaying built-ins or refreshing on keystrokes", async () => {
      let finish!: (catalog: SkillCatalog) => void;
      mocks.peek.mockReturnValue(null);
      mocks.cached.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const textarea = await render(); await input(textarea, "/"); expect(options()).toHaveLength(94);
      await input(textarea, "/plu"); await input(textarea, "/plugin:mine");
      expect(menu()).toBeNull();
      await act(async () => finish(catalog([skill("mine", { calls: { claude: "/plugin:mine" } }), skill("hidden", { listedIn: { claude: false, codex: null } })])));
      expect(names()).toEqual(["/plugin:mine"]);
      expect(options()[0].querySelector(".agent-tab-slash-description")?.textContent).toBe("\u4f5c\u696d\u3092\u9032\u3081\u308b");
      await input(textarea, "/"); expect(options()).toHaveLength(95);
      expect(mocks.cached).toHaveBeenCalledTimes(1); expect(mocks.refresh).not.toHaveBeenCalled();
    });
    it("picks up a catalog populated elsewhere after the initial cache read returned null", async () => {
      mocks.peek.mockReturnValue(null); mocks.cached.mockResolvedValue(null);
      mocks.refresh.mockImplementation(() => new Promise<SkillCatalog>(() => {}));
      const textarea = await render(); await input(textarea, "/plugin:late"); expect(menu()).toBeNull();
      mocks.peek.mockReturnValue(catalog([skill("late", { calls: { claude: "/plugin:late" } })]));
      await input(textarea, "/plugin:lat");
      expect(names()).toEqual(["/plugin:late"]);
      expect(mocks.cached).toHaveBeenCalledTimes(1); expect(mocks.refresh).toHaveBeenCalledTimes(1);
    });
    it("defers a late catalog result until IME composition ends", async () => {
      let finish!: (value: SkillCatalog) => void;
      mocks.peek.mockReturnValue(null);
      mocks.cached.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const textarea = await render(); await input(textarea, "/plugin:late"); expect(menu()).toBeNull();
      await composition(textarea, "compositionstart");
      await act(async () => finish(catalog([skill("late", { calls: { claude: "/plugin:late" } })])));
      expect(menu()).toBeNull();
      expect((await key(textarea, "Enter")).defaultPrevented).toBe(false);
      await composition(textarea, "compositionend");
      expect(names()).toEqual(["/plugin:late"]); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    });
    it("resets composition when the actual agent kind changes", async () => {
      const textarea = await render(); await input(textarea, "/h"); await composition(textarea, "compositionstart");
      await render("claude", true, "codex");
      const next = await render("claude", true, "claude");
      await input(next, "/hel"); await key(next, "Tab");
      expect(next.value).toBe("/help"); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    });
    it("keeps built-ins usable when reading the skill catalog fails", async () => {
      mocks.cached.mockRejectedValue(new Error("not available"));
      const textarea = await render(); await input(textarea, "/hel"); expect(names()).toEqual(["/help"]);
      await key(textarea, "Tab"); expect(textarea.value).toBe("/help");
    });
    it.each(["ArrowDown", "ArrowUp", "Tab", "Enter", "Escape"])("does not intercept %s or open/close a menu during IME composition", async name => {
      const textarea = await render(); await input(textarea, "/h"); const before = names();
      await composition(textarea, "compositionstart"); await input(textarea, "/zzzz", true);
      expect(names()).toEqual(before);
      expect((await key(textarea, name)).defaultPrevented).toBe(false);
      expect((await key(textarea, name, { isComposing: true })).defaultPrevented).toBe(false);
      expect((await key(textarea, name, { keyCode: 229 })).defaultPrevented).toBe(false);
      expect(names()).toEqual(before); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
      await composition(textarea, "compositionend"); expect(menu()).toBeNull();
    });
    it("leaves a closed menu closed until composition ends, and preserves Shift+Enter", async () => {
      const textarea = await render(); await composition(textarea, "compositionstart"); await input(textarea, "/", true);
      expect(menu()).toBeNull(); await composition(textarea, "compositionend"); expect(menu()).not.toBeNull();
      expect((await key(textarea, "Enter", { shiftKey: true })).defaultPrevented).toBe(false);
      expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    });
    it.each(["codex", "claude-codex", "grok"])("leaves %s tabs without slash suggestions or catalog reads", async kind => {
      const textarea = await render(kind); await input(textarea, "/"); expect(menu()).toBeNull();
      expect((await key(textarea, "Tab")).defaultPrevented).toBe(false);
      expect(mocks.peek).not.toHaveBeenCalled(); expect(mocks.cached).not.toHaveBeenCalled();
    });
    it("leaves the Claude dashboard composer without slash suggestions", async () => {
      const textarea = await render("claude", false); await input(textarea, "/"); expect(menu()).toBeNull();
      expect(mocks.peek).not.toHaveBeenCalled(); expect(mocks.cached).not.toHaveBeenCalled();
      await input(textarea, "/help"); await key(textarea, "Enter");
      expect(useComposerStore.getState().dashboardOptimisticMessagesBySession[sessionId]).toHaveLength(1);
      expect(mocks.terminal).not.toHaveBeenCalled();
    });
    it("takes the real agentKind from tab controls even if the dashboard card is stale", async () => {
      const textarea = await render("claude", true, "codex", true); await input(textarea, "/");
      expect(menu()).toBeNull(); expect(mocks.cached).not.toHaveBeenCalled();
      const next = await render("codex", true, "claude", true); await input(next, "/hel");
      expect(names()).toEqual(["/help"]);
    });
  });

  describe("lazy slash skill catalog", () => {
    beforeEach(() => {
      mocks.peek.mockReturnValue(null);
      mocks.cached.mockResolvedValue(null);
      mocks.refresh.mockImplementation(() => new Promise<SkillCatalog>(() => {}));
    });
    it("does not scan on mount or ordinary input without a slash query", async () => {
      const textarea = await render();
      await input(textarea, "ordinary input"); await input(textarea, "hello /comp");
      expect(mocks.cached).toHaveBeenCalledTimes(1);
      expect(mocks.refresh).not.toHaveBeenCalled(); expect(menu()).toBeNull();
    });
    it("shows built-ins immediately, then adds skills after the first missing-cache scan", async () => {
      let finish!: (value: SkillCatalog) => void;
      mocks.refresh.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const textarea = await render();
      expect(mocks.refresh).not.toHaveBeenCalled();
      await input(textarea, "/");
      expect(options()).toHaveLength(94); expect(textarea.disabled).toBe(false);
      await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(mocks.cached).toHaveBeenCalledTimes(1);
      expect(mocks.cached.mock.invocationCallOrder[0]).toBeLessThan(mocks.refresh.mock.invocationCallOrder[0]);
      const data = catalog([skill("loaded", { calls: { claude: "/plugin:loaded" } })]);
      await act(async () => { mocks.peek.mockReturnValue(data); finish(data); });
      expect(names()).toContain("/plugin:loaded"); expect(options()).toHaveLength(95);
      expect(textarea.value).toBe("/"); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    });
    it("shares one pending scan across two composers and repeated slash queries", async () => {
      let finish!: (value: SkillCatalog) => void;
      mocks.refresh.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const cards = [target(), card("slash-second", "slash-second-session", "Second")];
      const refs = cards.map(() => createRef<HTMLTextAreaElement>());
      await act(async () => root.render(<>{cards.map((card, index) => <ReplyComposer key={card.tab.id} card={card}
        inputRef={refs[index]} mentionTargets={cards} tabSessionId={card.tab.sessionId} tabAgentKind="claude" showSuggestions={false} />)}</>));
      const textareas = [...host.querySelectorAll<HTMLTextAreaElement>("textarea")];
      for (const textarea of textareas) {
        await input(textarea, "/"); await input(textarea, "/c"); await input(textarea, "/co"); await input(textarea, "/");
      }
      await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(mocks.cached).toHaveBeenCalledTimes(2);
      const menus = () => [...host.querySelectorAll<HTMLElement>(".agent-tab-slash-menu")];
      expect(menus()).toHaveLength(2);
      for (const menu of menus()) expect(menu.querySelectorAll("[role=option]")).toHaveLength(94);
      const data = catalog([skill("shared", { calls: { claude: "/plugin:shared" } })]);
      await act(async () => { mocks.peek.mockReturnValue(data); finish(data); });
      for (const menu of menus()) expect([...menu.querySelectorAll(".agent-tab-slash-name")].map(row => row.textContent)).toContain("/plugin:shared");
      await input(textareas[0], "/co"); await input(textareas[1], "/c");
      expect(mocks.refresh).toHaveBeenCalledTimes(1); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    });
    it("uses a returned cache without scanning even if peek is still empty", async () => {
      mocks.cached.mockResolvedValue(catalog([skill("cached", { calls: { claude: "/plugin:cached" } })]));
      const textarea = await render(); await input(textarea, "/");
      expect(names()).toContain("/plugin:cached");
      expect(mocks.cached).toHaveBeenCalledTimes(1); expect(mocks.refresh).not.toHaveBeenCalled();
    });
    it("does not retry a failed scan after edits or a composer remount", async () => {
      mocks.refresh.mockRejectedValue(new Error("scan unavailable"));
      let textarea = await render(); await input(textarea, "/");
      await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1), { timeout: 5000 });
      for (const text of ["/c", "/co", "", "/"]) await input(textarea, text);
      expect(options()).toHaveLength(94); expect(textarea.value).toBe("/");
      await act(async () => root.render(null));
      textarea = await render(); await input(textarea, "/c"); await input(textarea, "/");
      expect(options()).toHaveLength(94); expect(mocks.cached).toHaveBeenCalledTimes(2);
      expect(mocks.refresh).toHaveBeenCalledTimes(1); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    });
    it("defers a scanned catalog while IME composition is active", async () => {
      let finish!: (value: SkillCatalog) => void;
      mocks.refresh.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const textarea = await render(); await input(textarea, "/plugin:ime");
      await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(menu()).toBeNull(); await composition(textarea, "compositionstart");
      const data = catalog([skill("ime", { calls: { claude: "/plugin:ime" } })]);
      await act(async () => { mocks.peek.mockReturnValue(data); finish(data); });
      expect(menu()).toBeNull(); expect((await key(textarea, "Enter")).defaultPrevented).toBe(false);
      await composition(textarea, "compositionend");
      expect(names()).toEqual(["/plugin:ime"]); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    });
    it("waits until IME composition ends before loading the first slash query", async () => {
      const textarea = await render(); await composition(textarea, "compositionstart"); await input(textarea, "/", true);
      expect(mocks.refresh).not.toHaveBeenCalled(); expect(menu()).toBeNull();
      await composition(textarea, "compositionend");
      await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(options()).toHaveLength(94);
    });
    it.each([["codex", true], ["claude-codex", true], ["grok", true], ["claude", false]] as const)
      ("does not read or scan for %s with inTab=%s", async (kind, inTab) => {
        const textarea = await render(kind, inTab);
        for (const text of ["/", "/c", "/co"]) await input(textarea, text);
        expect(menu()).toBeNull(); expect(mocks.peek).not.toHaveBeenCalled();
        expect(mocks.cached).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
      });
    it("ignores a pending scan after switching the actual tab kind away from Claude", async () => {
      let finish!: (value: SkillCatalog) => void;
      mocks.refresh.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const textarea = await render(); await input(textarea, "/");
      await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1), { timeout: 5000 });
      await render("claude", true, "codex");
      await act(async () => finish(catalog([skill("late")])));
      expect(menu()).toBeNull(); expect(mocks.refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe("slash selection and sent text", () => {
    it.each(["/comp", "/compact"])("Enter sends optional compact completion %s as /compact", async typed => {
      const textarea = await render(); await input(textarea, typed);
      expect(selected()).toBe("/compact"); await key(textarea, "Enter");
      expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId, text: "\x1b[200~/compact\x1b[201~", enter: true });
      expect(textarea.value).toBe(""); expect(mocks.terminal).toHaveBeenCalledTimes(1); noBubbleOrNote();
    });
    it("Tab still completes compact with a trailing space without sending", async () => {
      const textarea = await render(); await input(textarea, "/comp"); await key(textarea, "Tab");
      expect(textarea.value).toBe("/compact "); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
    });
    it("Enter sends the selected no-argument completion through the existing payload exactly once", async () => {
      const textarea = await render(); await input(textarea, "/vers"); await key(textarea, "Enter");
      expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId, text: "\x1b[200~/version\x1b[201~", enter: true });
      expect(mocks.terminal).toHaveBeenCalledTimes(1); expect(textarea.value).toBe(""); noBubbleOrNote();
      expect(JSON.parse(localStorage.getItem(AGENT_TAB_SLASH_RECENT_KEY)!)).toEqual(["version"]);
    });
    it.each([["/ini", "/init"], ["/plugin:mi", "/plugin:mine"]])("sends prompt or skill completion %s while staying in conversation", async (typed, completed) => {
      const data = catalog([skill("mine", { calls: { claude: "/plugin:mine" } })]);
      mocks.peek.mockReturnValue(data); mocks.cached.mockResolvedValue(data);
      const textarea = await render(); await input(textarea, typed); await key(textarea, "Enter");
      expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId, text: String.fromCharCode(27) + "[200~" + completed + String.fromCharCode(27) + "[201~", enter: true });
      expect(mocks.terminal).not.toHaveBeenCalled(); noBubbleOrNote();
    });
    it("Enter completes a required argument without sending, then sends the author's full argument verbatim", async () => {
      const textarea = await render(); await input(textarea, "/add-d"); await key(textarea, "Enter");
      expect(textarea.value).toBe("/add-dir "); expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
      await input(textarea, "/add-dir C:/my path"); await key(textarea, "Enter");
      expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId, text: "\x1b[200~/add-dir C:/my path\x1b[201~", enter: true });
      expect(JSON.parse(localStorage.getItem(AGENT_TAB_SLASH_RECENT_KEY)!)).toEqual(["add-dir"]);
    });
    it.each(["/add-dir", "/cost"])("Enter sends an exact name or alias %s unchanged", async text => {
      const textarea = await render(); await input(textarea, text); await key(textarea, "Enter");
      expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId, text: "\x1b[200~" + text + "\x1b[201~", enter: true });
      expect(mocks.terminal).toHaveBeenCalledTimes(1);
    });
    it("sends the arrow-selected candidate and an optional-argument completion, using the completed body", async () => {
      const textarea = await render(); await input(textarea, "/b"); await key(textarea, "ArrowDown");
      expect(selected()).toBe("/branch"); await key(textarea, "Enter");
      expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId, text: "\x1b[200~/branch\x1b[201~", enter: true });
    });
    it("sends an unmatched name as authored, without forcing a completion", async () => {
      const textarea = await render(); await input(textarea, "/zz-unknown");
      expect(menu()).toBeNull(); await key(textarea, "Enter");
      expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId, text: "\x1b[200~/zz-unknown\x1b[201~", enter: true });
      expect(mocks.terminal).toHaveBeenCalledTimes(1);
    });
    it.each([
      ["/help", true], ["/clear", true], ["/init", false], ["/insights", false], ["/statusline", false],
      ["/team-onboarding", false], ["/plugin:mine", false], ["/cost", true], ["/zz-unknown", true],
    ])("classifies manual send %s from its first token rather than menu selection", async (text, switches) => {
      const data = catalog([skill("mine", { calls: { claude: "/plugin:mine" } })]);
      mocks.peek.mockReturnValue(data); mocks.cached.mockResolvedValue(data);
      const textarea = await render(); await input(textarea, text); await key(textarea, "Escape"); await clickSend();
      expect(mocks.handleSocketCommand).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId, text: "\x1b[200~" + text + "\x1b[201~", enter: true });
      expect(mocks.terminal).toHaveBeenCalledTimes(switches ? 1 : 0); noBubbleOrNote();
    });
    it.each([{ sent: false, textWritten: true }, { sent: false, enterWritten: true }, { writeMayHaveOccurred: true }])
      ("keeps a prompt command in conversation on a possible write %j, without automatic resend", async outcome => {
        mocks.handleSocketCommand.mockResolvedValue(outcome);
        const textarea = await render(); await input(textarea, "/init"); await key(textarea, "Enter");
        expect(mocks.terminal).not.toHaveBeenCalled(); noBubbleOrNote(); expect(textarea.value).toBe("");
        await render(); expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(1);
      });
    it.each(["refusal", "exception"])("preserves a pre-write %s and never records it in command history", async failure => {
      if (failure === "exception") mocks.handleSocketCommand.mockRejectedValue(new Error("offline"));
      else mocks.handleSocketCommand.mockResolvedValue({ sent: false, message: "before write" });
      const textarea = await render(); await input(textarea, "/init"); await key(textarea, "Enter");
      expect(textarea.value).toBe("/init"); expect(note()?.getAttribute("role")).toBe("alert");
      expect(mocks.terminal).not.toHaveBeenCalled(); expect(localStorage.getItem(AGENT_TAB_SLASH_RECENT_KEY)).toBeNull();
      await render(); expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(1);
    });
    it("updates and reloads recent command ordering across composer mounts without persisting arguments", async () => {
      localStorage.setItem(AGENT_TAB_SLASH_RECENT_KEY, JSON.stringify(["version", "help", "usage"]));
      let textarea = await render(); await input(textarea, "/");
      expect(names().slice(0, 3)).toEqual(["/version", "/help", "/usage"]);
      await input(textarea, "/cost private"); await key(textarea, "Enter");
      await act(async () => root.render(null));
      textarea = await render(); await input(textarea, "/");
      expect(names().slice(0, 3)).toEqual(["/usage", "/version", "/help"]);
      expect(localStorage.getItem(AGENT_TAB_SLASH_RECENT_KEY)).not.toContain("private");
    });
    it("tolerates storage read/write failures in the rendered composer", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
      const textarea = await render(); await input(textarea, "/init"); await key(textarea, "Enter");
      expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(1); noBubbleOrNote(); expect(mocks.terminal).not.toHaveBeenCalled();
      await input(textarea, "/"); expect(names()[0]).toBe("/init");
    });
  });
});

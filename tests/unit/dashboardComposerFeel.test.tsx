// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handleSocketCommand: vi.fn() }));

vi.mock("../../src/components/layout/socketCommands", () => ({
  handleSocketCommand: mocks.handleSocketCommand,
}));

import { ChatColumn } from "../../src/components/dashboard/ChatColumn";
import { ReplyComposer } from "../../src/components/dashboard/ReplyComposer";
import type { DashboardCardModel } from "../../src/components/dashboard/dashboardModel";
import type { SemanticEventEnvelope } from "../../src/lib/livebrief";
import { useComposerStore } from "../../src/stores/composerStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { __resetReportInboxStoreForTests } from "../../src/stores/reportInboxStore";

const NOW = Date.parse("2026-08-16T00:00:00.000Z");

function card(id = "tab-feel", sessionId = "session-feel"): DashboardCardModel {
  const workspace = {
    id: "ws-feel",
    name: "Feel workspace",
    gridTemplateId: "1x1" as const,
    panes: [],
    status: "running" as const,
    createdAt: NOW,
  };
  const tab = { id, sessionId, agentId: "codex", agentKind: "codex" as const, label: "Target", type: "terminal" as const };
  const pane = { id: "pane-feel", sessionId, agentId: "codex", activeTabId: id, tabs: [tab] };
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
    group: "working",
    status: "working",
    lastActivityAt: NOW,
    label: "Target",
    agentKind: "codex",
    unobserved: false,
    neverStarted: false,
    telemetryHealth: "live",
    operationalState: "running",
    task: null,
    latestInstruction: null,
    activityText: null,
    checkpoint: null,
    noUpdateMinutes: 0,
  };
}

function transcript(text: string): SemanticEventEnvelope {
  return {
    eventId: `echo-${text}`,
    sourceRevision: 1,
    occurredAt: NOW + 1,
    sourceByteStart: 0,
    sourceByteEnd: text.length,
    kind: { type: "userMessage", kind: "answer", text, digest: "echo" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const target = card();
const inputRef = createRef<HTMLTextAreaElement>();

function FeelHarness({ events = [] }: { events?: readonly SemanticEventEnvelope[] }) {
  return <>
    <ChatColumn
      card={target}
      events={events}
      now={NOW}
      active
      dragging={false}
      dropPreview={false}
      motion={null}
      targetEventId={null}
      targetEventRequest={0}
      syntheticSource={null}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onFocusComposer={vi.fn()}
      onJump={vi.fn()}
      onReorderKeyDown={vi.fn()}
    />
    <ReplyComposer card={target} inputRef={inputRef} mentionTargets={[target]} />
  </>;
}

let container: HTMLDivElement;
let root: Root;

function resetComposerStore(): void {
  useComposerStore.setState({
    draftBySession: {},
    mentionTokensBySession: {},
    commandKindBySession: {},
    questionGuardBySession: {},
    dashboardOptimisticMessagesBySession: {},
    dashboardRetryBySession: {},
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.handleSocketCommand.mockReset();
  resetComposerStore();
  useLiveBriefStore.getState().reset();
  usePaneDragStore.getState().clearDrag();
  __resetReportInboxStoreForTests();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetComposerStore();
  useLiveBriefStore.getState().reset();
  usePaneDragStore.getState().clearDrag();
  __resetReportInboxStoreForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderFeel(events: readonly SemanticEventEnvelope[] = []): Promise<HTMLTextAreaElement> {
  await act(async () => {
    root.render(<FeelHarness events={events} />);
    await Promise.resolve();
  });
  return container.querySelector<HTMLTextAreaElement>("textarea")!;
}

async function input(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function send(textarea: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

describe("dashboard optimistic composer feedback", () => {
  it("clears the editor and immediately shows a sending message in its chat column", async () => {
    const pending = deferred<{ confirmed: boolean }>();
    mocks.handleSocketCommand.mockReturnValueOnce(pending.promise);
    const textarea = await renderFeel();

    await input(textarea, "今すぐ見せる");
    await send(textarea);

    const message = container.querySelector<HTMLElement>("[data-dashboard-optimistic-message]");
    expect(textarea.value).toBe("");
    expect(message?.dataset.deliveryState).toBe("sending");
    expect(message?.textContent).toContain("今すぐ見せる");
    expect(message?.textContent).toContain("送信中");
  });

  it("marks a successful send as sent and collapses it when the matching transcript arrives", async () => {
    const pending = deferred<{ confirmed: boolean }>();
    mocks.handleSocketCommand.mockReturnValueOnce(pending.promise);
    const textarea = await renderFeel();

    await input(textarea, "エコーを待つ");
    await send(textarea);
    await act(async () => {
      pending.resolve({ confirmed: true });
      await pending.promise;
    });
    expect(container.querySelector<HTMLElement>("[data-dashboard-optimistic-message]")?.dataset.deliveryState).toBe("sent");

    await renderFeel([transcript("エコーを待つ")]);
    expect(container.querySelector("[data-dashboard-optimistic-message]")).toBeNull();
    expect(container.querySelectorAll(".cmux-dashboard-msg.is-user")).toHaveLength(1);
  });

  it("shows a failure and resends the preserved text when requested", async () => {
    mocks.handleSocketCommand
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ confirmed: true });
    const textarea = await renderFeel();

    await input(textarea, "失敗した送信");
    await send(textarea);
    await act(async () => { await Promise.resolve(); });
    const message = container.querySelector<HTMLElement>("[data-dashboard-optimistic-message]");
    expect(message?.dataset.deliveryState).toBe("failed");
    expect(message?.textContent).toContain("再送");

    await act(async () => {
      message?.querySelector<HTMLButtonElement>("button")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.handleSocketCommand).toHaveBeenCalledTimes(2);
    expect(mocks.handleSocketCommand).toHaveBeenLastCalledWith("pane.send_text", {
      sessionId: "session-feel",
      text: "失敗した送信",
      enter: true,
    });
    expect(container.querySelector<HTMLElement>("[data-dashboard-optimistic-message]")?.dataset.deliveryState).toBe("sent");
  });

  it("keeps the state visible without adding the motion class when reduced motion is requested", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const pending = deferred<{ confirmed: boolean }>();
    mocks.handleSocketCommand.mockReturnValueOnce(pending.promise);
    const textarea = await renderFeel();

    await input(textarea, "動きを止める");
    await send(textarea);

    const message = container.querySelector<HTMLElement>("[data-dashboard-optimistic-message]");
    expect(message?.dataset.deliveryState).toBe("sending");
    expect(message?.dataset.optimisticMotion).toBeUndefined();
    expect(message?.classList.contains("is-optimistic-motion")).toBe(false);
  });
});

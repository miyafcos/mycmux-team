// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/ipc");
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  isMaximized: async () => false, onResized: async () => () => {}, onMoved: async () => () => {},
}) }));
vi.mock("../../src/components/settings/SettingsDialog", () => ({ default: () => null }));
vi.mock("../../src/components/ailog/AiLogButton", () => ({ AiLogButton: () => null }));
vi.mock("../../src/components/dashboard/DashboardButton", () => ({ DashboardButton: () => null }));
vi.mock("../../src/components/layout/AccountsButton", () => ({ AccountsButton: () => null }));
vi.mock("../../src/hooks/useAccountsPolling", () => ({ useAccountsPolling: () => {} }));
vi.mock("../../src/hooks/useCliLoginEvents", () => ({ useCliLoginEvents: () => {} }));
import TitleBar from "../../src/components/layout/TitleBar";
import NotificationPanel from "../../src/components/layout/NotificationPanel";
import { notificationPanelStrings as strings } from "../../src/components/layout/notificationPanelStrings";
import { useWorkspaceListStore, useWorkspaceLayoutStore, usePaneMetadataStore } from "../../src/stores/workspaceStore";
import { useSessionAttentionStore, type SessionAttention } from "../../src/stores/sessionAttentionStore";
import { focusController } from "../../src/lib/focusController";
import type { Workspace } from "../../src/types";

import { useLiveBriefStore, connectLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";
import type { LiveSessionBrief } from "../../src/lib/livebrief";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const close = vi.fn();
const state = (kind: SessionAttention["kind"], stateSince: number): SessionAttention => ({
  sessionId: "session", sessionEpoch: 1, attentionId: "attention", kind, detail: null,
  sessionRevision: 1, uiState: "WaitingInput", stateSince, occurrenceOrder: 1,
});
const workspaces = [
  { id: "here", name: "Current workspace", panes: [{ id: "pane", tabs: [
    { id: "q", sessionId: "q", agentId: "shell-starter", agentKind: "codex", label: "Question seat" },
    { id: "d", sessionId: "d", agentId: "shell-starter", agentKind: "claude", label: "Completion seat" },
  ] }] },
  { id: "away", name: "Other workspace", panes: [{ id: "other-pane", tabs: [
    { id: "a", sessionId: "a", agentId: "shell-starter", agentKind: "codex", label: "Approval seat" },
    { id: "r", sessionId: "r", agentId: "shell-starter", label: "Resolved seat" },
  ] }] },
] as Workspace[];

const rows = () => [...host.querySelectorAll<HTMLButtonElement>(".cmux-notification-item")];
const sections = () => [...host.querySelectorAll("section")];
async function render(closing = false) {
  await act(async () => root.render(<><button data-trigger>Bell</button><NotificationPanel closing={closing} onClose={close} /></>));
}
// jsdom has no native button keyboard activation; emulate the uncancelled default only.
async function key(value: string) {
  const target = document.activeElement as HTMLElement;
  await act(async () => {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    if (!event.defaultPrevented && value === "Enter" && target instanceof HTMLButtonElement) target.click();
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useLiveBriefStore.getState().reset();
  useAskQuestionStore.getState().resetForTests();
  useWorkspaceListStore.setState({ workspaces, activeWorkspaceId: "here" });
  usePaneMetadataStore.setState({ metadata: { q: { notificationCount: 5 }, a: { workDoneCount: 4 }, d: { workDoneCount: 2 }, r: { notificationCount: 1 } }, volatileMetadata: {}, lastLog: { d: "Result arrived" } });
  useSessionAttentionStore.setState({ attentionBySession: { q: state("input", 10), a: state("approval", 20) } });
  vi.spyOn(useWorkspaceListStore.getState(), "setActiveWorkspace").mockImplementation(() => {});
  vi.spyOn(useWorkspaceLayoutStore.getState(), "setActivePaneTab").mockImplementation(() => {});
  vi.spyOn(focusController, "request").mockImplementation(() => {});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("notification panel", () => {
  it("renders named sections, counts, marks, actions and only foreign workspace names", async () => {
    await render();
    expect(host.textContent).toContain(strings.attentionHeading(2, 1, 1));
    expect(host.textContent).toContain(strings.unreadHeading(3));
    expect(rows()).toHaveLength(4);
    expect(rows()[0].querySelector("svg")).not.toBeNull();
    expect(rows()[0].textContent).toContain(strings.input);
    expect(rows()[1].textContent).toContain(strings.approval);
    expect(rows()[0].textContent).not.toContain("Current workspace");
    expect(rows()[1].textContent).toContain("Other workspace");
    expect(rows()[2].textContent).toContain("Result arrived");
    expect(sections()[0].querySelectorAll("button")).toHaveLength(2);
    expect(sections()[0].textContent).not.toContain(strings.clearUnread);
    expect(rows()[0].textContent).toContain(strings.answer);
    expect(rows()[2].textContent).toContain(strings.open);
  });

  it("marks only the lower section read, preserving upper counters until resolution", async () => {
    const clear = vi.spyOn(usePaneMetadataStore.getState(), "clearNotification");
    await render();
    await act(async () => (sections()[1].querySelector("button") as HTMLButtonElement).click());
    expect(clear.mock.calls).toEqual([["d"], ["r"]]);
    expect(usePaneMetadataStore.getState().metadata.q.notificationCount).toBe(5);
    expect(usePaneMetadataStore.getState().metadata.a.workDoneCount).toBe(4);
    expect(sections()[0].querySelectorAll("button")).toHaveLength(2);
    expect(sections()[1].textContent).toContain(strings.noUnread);
    await act(async () => useSessionAttentionStore.setState({ attentionBySession: {} }));
    expect(sections()[0].textContent).toContain(strings.noAttention);
    expect(sections()[1].textContent).toContain(strings.unreadHeading(9));
  });

  it("crosses both section boundaries with arrows, wraps, and opens an upper row without clearing", async () => {
    const clear = vi.spyOn(usePaneMetadataStore.getState(), "clearNotification");
    await render();
    expect(document.activeElement).toBe(rows()[0]);
    await key("ArrowUp"); expect(document.activeElement).toBe(rows()[3]);
    await key("ArrowDown"); expect(document.activeElement).toBe(rows()[0]);
    await key("ArrowDown"); await key("ArrowDown"); expect(document.activeElement).toBe(rows()[2]);
    await key("ArrowUp"); expect(document.activeElement).toBe(rows()[1]);
    await key("Enter");
    expect(rows()[1].getAttribute("aria-expanded")).toBe("true");
    expect(close).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>("[data-notification-open]")!.click());
    expect(useWorkspaceListStore.getState().setActiveWorkspace).toHaveBeenCalledExactlyOnceWith("away");
    expect(useWorkspaceLayoutStore.getState().setActivePaneTab).toHaveBeenCalledExactlyOnceWith("away", "other-pane", "a");
    expect(focusController.request).toHaveBeenCalledExactlyOnceWith("programmatic", { sessionId: "a", focus: true });
    expect(clear).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    expect(rows().filter((row) => row.getAttribute("aria-expanded") === "true")).toHaveLength(1);
  });

  it("opens and clears only the selected unread row, in activation order", async () => {
    const clear = vi.spyOn(usePaneMetadataStore.getState(), "clearNotification");
    await render(); await act(async () => rows()[2].focus()); await key("Enter");
    expect(clear).toHaveBeenCalledExactlyOnceWith("d");
    const setActive = vi.mocked(useWorkspaceListStore.getState().setActiveWorkspace);
    const setTab = vi.mocked(useWorkspaceLayoutStore.getState().setActivePaneTab);
    expect(setActive.mock.invocationCallOrder[0]).toBeLessThan(setTab.mock.invocationCallOrder[0]);
    expect(setTab.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(focusController.request).mock.invocationCallOrder[0]);
    expect(vi.mocked(focusController.request).mock.invocationCallOrder[0]).toBeLessThan(clear.mock.invocationCallOrder[0]);
    expect(usePaneMetadataStore.getState().metadata.r.notificationCount).toBe(1);
  });

  it("survives focus-style clearing and removes upper rows only when state or live tab disappears", async () => {
    await render();
    await act(async () => usePaneMetadataStore.getState().clearNotification("q"));
    expect(sections()[0].querySelectorAll("button")).toHaveLength(2);
    await act(async () => useSessionAttentionStore.setState({ attentionBySession: { a: state("approval", 20) } }));
    expect(sections()[0].querySelectorAll("button")).toHaveLength(1);
    await act(async () => useWorkspaceListStore.setState({ workspaces: [workspaces[0]] }));
    expect(sections()[0].textContent).toContain(strings.noAttention);
  });

  it("closes on Escape and restores the bell focus without clearing", async () => {
    const clear = vi.spyOn(usePaneMetadataStore.getState(), "clearNotification");
    await render(); await key("Escape");
    expect(close).toHaveBeenCalledOnce(); expect(clear).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(host.querySelector("[data-trigger]"));
  });

  it("keeps outside dismissal, empty states and the closing inert lifecycle", async () => {
    useSessionAttentionStore.setState({ attentionBySession: {} });
    usePaneMetadataStore.setState({ metadata: {} });
    await render();
    expect(host.textContent).toContain(strings.noAttention); expect(host.textContent).toContain(strings.noUnread);
    expect(rows()).toHaveLength(0);
    await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(close).toHaveBeenCalledOnce(); close.mockClear();
    await render(true); await key("Escape"); expect(close).not.toHaveBeenCalled();
    expect(host.querySelector("[inert][aria-hidden='true']")).not.toBeNull();
  });

  it.each([240, 300, 1200])("clamps the anchored popover inside a %ipx viewport and scrolls vertically", async (width) => {
    vi.stubGlobal("innerWidth", width); vi.stubGlobal("innerHeight", 180);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ left: 80, bottom: 36 } as DOMRect);
    await render();
    const panel = host.querySelector<HTMLElement>(".cmux-popover-panel")!;
    expect(panel.style.width).toBe("380px");
    expect(panel.style.maxWidth).toBe("calc(100vw - 16px)");
    expect(Number.parseFloat(panel.style.left) + Math.min(380, width - 16)).toBeLessThanOrEqual(width - 8);
    expect(panel.style.maxHeight).toBe("calc(100dvh - 48px)");
    expect(panel.style.overflowY).toBe("auto"); expect(panel.style.overflowX).toBe("hidden");
  });
});


describe("notification bell", () => {
  it("shows attention N in yellow, switches to unread M after resolution, and shares panel counts", async () => {
    await act(async () => root.render(<TitleBar onOpenOnlinePanel={() => {}} />));
    const bell = host.querySelector<HTMLButtonElement>('button[title="Notifications"]')!;
    expect(bell.textContent).toBe("2");
    expect(bell.querySelector("span")?.style.background).toBe("var(--cmux-yellow)");
    await act(async () => usePaneMetadataStore.getState().clearNotification("q"));
    expect(bell.textContent).toBe("2");
    await act(async () => bell.click());
    expect(host.textContent).toContain(strings.attentionHeading(2, 1, 1));
    expect(host.textContent).toContain(strings.unreadHeading(3));
    await act(async () => useSessionAttentionStore.setState({ attentionBySession: {} }));
    expect(bell.textContent).toBe("7");
    expect(bell.querySelector("span")?.style.background).toBe("var(--notification-color)");
    expect(host.textContent).toContain(strings.unreadHeading(7));
    await act(async () => usePaneMetadataStore.setState({ metadata: {} }));
    expect(bell.textContent).toBe("");
    expect(bell.querySelector("span")).toBeNull();
  });

  it("ignores orphan states and updates the badge when the window loses its live tabs", async () => {
    await act(async () => root.render(<TitleBar onOpenOnlinePanel={() => {}} />));
    const bell = host.querySelector<HTMLButtonElement>('button[title="Notifications"]')!;
    await act(async () => useSessionAttentionStore.setState({ attentionBySession: {
      q: state("input", 1), a: state("approval", 2), orphan: state("input", 3),
    } }));
    expect(bell.textContent).toBe("2");
    await act(async () => useWorkspaceListStore.setState({ workspaces: [] }));
    expect(bell.textContent).toBe("");
  });
});

function approvalBrief(): LiveSessionBrief {
  return {
    ptySessionId: "a", agentSessionId: "agent", agentKind: "claude", ptyInstanceId: "instance",
    ptyGeneration: 1, sourceRevision: 7, ptyInputRevision: 4, task: null, latestInstruction: null,
    taskSourceEventIds: [], activityKind: null, activityText: null, activitySourceEventId: null,
    checkpoint: null, checkpointEvidenceEventIds: [], pendingInputKind: "permission",
    pendingPrompt: "Approve command?", pendingOptions: [{ id: "once", label: "Once" }],
    promptEventId: "prompt", promptHash: "hash", eventSeq: 1, operationalState: "needsHuman",
    telemetryHealth: "live", lastEventAt: Date.now(), lastSuccessfulReadAt: Date.now(),
    updatedAt: Date.now(), serviceEpoch: "epoch", briefRevision: 1,
  };
}

describe("inline notification rows", () => {
  it("expands only one row and toggles the same row closed without navigation", async () => {
    await render();
    await act(async () => rows()[0].click());
    expect(rows()[0].getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.hasAttribute("data-notification-answer")).toBe(true);
    await act(async () => rows()[1].click());
    expect(rows()[0].getAttribute("aria-expanded")).toBe("false");
    expect(rows()[1].getAttribute("aria-expanded")).toBe("true");
    const visible = [...host.querySelectorAll("[data-notification-answer]")].filter((node) => !node.closest("[hidden]"));
    expect(visible).toHaveLength(1);
    await act(async () => rows()[1].click());
    expect(rows().every((row) => row.getAttribute("aria-expanded") !== "true")).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(focusController.request).not.toHaveBeenCalled();
  });

  it("collapses with Escape to its row, then closes with the next Escape", async () => {
    await render(); await key("Enter");
    expect(rows()[0].getAttribute("aria-expanded")).toBe("true");
    await key("Escape");
    expect(rows()[0].getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(rows()[0]);
    expect(close).not.toHaveBeenCalled();
    await key("Escape");
    expect(close).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(host.querySelector("[data-trigger]"));
  });

  it("moves from expanded controls across both sections with arrows", async () => {
    await render();
    await act(async () => rows()[1].click());
    const open = host.querySelector<HTMLButtonElement>("[data-notification-open]")!;
    await act(async () => open.focus());
    await key("ArrowDown"); expect(document.activeElement).toBe(rows()[2]);
    await key("ArrowUp"); expect(document.activeElement).toBe(rows()[1]);
    await key("ArrowUp"); expect(document.activeElement).toBe(rows()[0]);
    expect(close).not.toHaveBeenCalled();
  });

  it("preserves the approval send lock and counters across collapse and re-expansion", async () => {
    useLiveBriefStore.getState().applyBrief(approvalBrief());
    const core = await import("@tauri-apps/api/core");
    let finish!: (value: unknown) => void;
    vi.mocked(core.invoke).mockImplementation(async (command) => {
      if (command === "send_intervention") return new Promise((resolve) => { finish = resolve; });
      return [] as never;
    });
    const clear = vi.spyOn(usePaneMetadataStore.getState(), "clearNotification");
    await render(); await act(async () => rows()[1].click());
    const firstOption = () => host.querySelector<HTMLButtonElement>("[data-notification-option='1']")!;
    await act(async () => firstOption().click());
    expect(rows()[1].textContent).toContain(strings.sending);
    await key("Escape");
    await act(async () => rows()[1].click());
    await act(async () => firstOption().click());
    expect(vi.mocked(core.invoke).mock.calls.filter(([name]) => name === "send_intervention")).toHaveLength(1);
    await act(async () => finish({ type: "confirmed", matchedEventId: "done" }));
    await key("Escape"); await act(async () => rows()[1].click()); await act(async () => firstOption().click());
    expect(vi.mocked(core.invoke).mock.calls.filter(([name]) => name === "send_intervention")).toHaveLength(1);
    expect(clear).not.toHaveBeenCalled();
    expect(usePaneMetadataStore.getState().metadata.a.workDoneCount).toBe(4);
  });

  it("removes resolved expanded attention and does not reopen a later occurrence automatically", async () => {
    await render(); await key("Enter");
    await act(async () => useSessionAttentionStore.setState({ attentionBySession: { a: state("approval", 20) } }));
    expect(rows().filter((row) => row.getAttribute("aria-expanded") === "true")).toHaveLength(0);
    await act(async () => useSessionAttentionStore.setState({ attentionBySession: { q: state("input", 30), a: state("approval", 20) } }));
    expect(rows().filter((row) => row.getAttribute("aria-expanded") === "true")).toHaveLength(0);
  });

  it("rebuilds a new question in the same row and retains keyboard focus", async () => {
    const screen = (question: string) => ({
      kind: "single" as const, multiSelect: false, tabs: [], question,
      options: [{ index: 1, label: "One", current: true, role: "option" as const }],
    });
    useAskQuestionStore.getState().applyScan("q", screen("First question"), 1, 1);
    await render(); await key("Enter");
    expect(host.textContent).toContain("First question");
    const oldBody = host.querySelector("[data-notification-answer]");
    await act(async () => useAskQuestionStore.getState().applyScan("q", screen("Second question"), 2, 2));
    expect(host.textContent).toContain("Second question");
    expect(host.textContent).not.toContain("First question");
    expect(host.querySelector("[data-notification-answer]")).not.toBe(oldBody);
    expect(document.activeElement).toBe(host.querySelector("[data-notification-answer]"));
    await key("ArrowDown"); expect(document.activeElement).toBe(rows()[1]);
  });

  it("subscribes only while open and preserves a concurrent dashboard subscription", async () => {
    const core = await import("@tauri-apps/api/core");
    const releaseDashboard = connectLiveBriefStore();
    try {
      await render();
      expect(vi.mocked(core.invoke).mock.calls.filter(([name]) => name === "subscribe_live_briefs")).toHaveLength(1);
      expect(vi.mocked(core.invoke).mock.calls.some(([name]) => name === "get_live_briefs")).toBe(true);
      await render(true);
      expect(vi.mocked(core.invoke).mock.calls.filter(([name]) => name === "unsubscribe_live_briefs")).toHaveLength(0);
    } finally {
      await act(async () => releaseDashboard());
    }
    expect(vi.mocked(core.invoke).mock.calls.filter(([name]) => name === "unsubscribe_live_briefs")).toHaveLength(1);
  });

  it("unsubscribes when the popover closes without another subscriber", async () => {
    const core = await import("@tauri-apps/api/core");
    await render(); await render(true);
    expect(vi.mocked(core.invoke).mock.calls.filter(([name]) => name === "subscribe_live_briefs")).toHaveLength(1);
    expect(vi.mocked(core.invoke).mock.calls.filter(([name]) => name === "unsubscribe_live_briefs")).toHaveLength(1);
  });
});

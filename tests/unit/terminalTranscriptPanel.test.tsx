// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  syncDashboardEvents: vi.fn(),
  stopEventPolling: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

vi.mock("../../src/stores/liveBriefStore", async (importActual) => {
  const actual = await importActual<typeof import("../../src/stores/liveBriefStore")>();
  return {
    ...actual,
    connectLiveBriefStore: () => () => {},
    syncDashboardEvents: mocks.syncDashboardEvents,
    stopEventPolling: mocks.stopEventPolling,
  };
});

import { TerminalTranscriptPanel } from "../../src/components/terminal/TerminalTranscriptPanel";
import { terminalTurnStrings } from "../../src/components/terminal/terminalTurnStrings";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = "pty-session-a";
const TAB = "tab-a";
let root: Root | null = null;

function event(id: string, text: string, seq = 1) {
  return {
    eventId: id,
    sourceRevision: seq,
    occurredAt: 1_788_000_000_000 + seq,
    sourceByteStart: 0,
    sourceByteEnd: text.length,
    kind: { type: "userMessage", kind: "prompt", text, digest: id },
  } as never;
}

async function mountPanel(onClose = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<TerminalTranscriptPanel sessionId={SESSION} tabId={TAB} onClose={onClose} />);
  });
  return onClose;
}

beforeEach(() => {
  mocks.syncDashboardEvents.mockClear();
  mocks.stopEventPolling.mockClear();
  useDashboardViewStore.setState({ open: false, userTurnRequests: {}, userTurnRequestSeq: 0 });
  useLiveBriefStore.setState({
    eventsBySession: { [SESSION]: [event("e1", "最初の指示", 1), event("e2", "次の指示", 2)] },
    listEventsBySession: {},
  } as never);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("TerminalTranscriptPanel", () => {
  it("renders the session's conversation inside the pane", async () => {
    await mountPanel();
    expect(document.querySelector("[data-terminal-transcript-panel]")).not.toBeNull();
    expect(document.body.textContent).toContain("最初の指示");
    expect(document.body.textContent).toContain("次の指示");
    expect(document.body.textContent).toContain(terminalTurnStrings.conversationHistory);
  });

  it("borrows the detail poll while open and hands it back on close", async () => {
    await mountPanel();
    expect(mocks.syncDashboardEvents).toHaveBeenCalledWith({ selectedId: SESSION, visibleIds: [SESSION] });
    expect(mocks.stopEventPolling).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
    root = null;
    expect(mocks.stopEventPolling).toHaveBeenCalled();
  });

  it("leaves the poll alone while the dashboard owns it", async () => {
    useDashboardViewStore.setState({ open: true });
    await mountPanel();
    expect(mocks.syncDashboardEvents).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const onClose = await mountPanel();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps its Dashboard link as an explicit way out", async () => {
    const onOpenDashboard = vi.fn();
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TerminalTranscriptPanel
          sessionId={SESSION}
          tabId={TAB}
          onClose={vi.fn()}
          onOpenDashboard={onOpenDashboard}
        />,
      );
    });
    const link = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === terminalTurnStrings.openInDashboard);
    expect(link).toBeTruthy();
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenDashboard).toHaveBeenCalled();
  });
});

describe("queueTranscriptTurnRequest", () => {
  it("records the turn request without opening the dashboard", () => {
    useDashboardViewStore.setState({ open: false, userTurnRequests: {}, userTurnRequestSeq: 0 });
    const queued = useDashboardViewStore.getState().queueTranscriptTurnRequest(TAB, { kind: "latest" });
    expect(queued).toBe(true);
    expect(useDashboardViewStore.getState().open).toBe(false);
    expect(useDashboardViewStore.getState().userTurnRequests[TAB]?.kind).toBe("latest");
  });

  it("still opens the dashboard for the explicit request", () => {
    useDashboardViewStore.setState({ open: false, userTurnRequests: {}, userTurnRequestSeq: 0 });
    useDashboardViewStore.getState().openTranscriptTurnRequest(TAB, { kind: "latest" });
    expect(useDashboardViewStore.getState().open).toBe(true);
  });
});

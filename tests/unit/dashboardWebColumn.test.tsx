// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatColumn } from "../../src/components/dashboard/ChatColumn";
import { ReplyComposer } from "../../src/components/dashboard/ReplyComposer";
import type { DashboardCardModel } from "../../src/components/dashboard/dashboardModel";
import { buildDashboardCards } from "../../src/components/dashboard/dashboardModel";
import { mergeWebPaneTurns } from "../../src/lib/webPaneTranscript";
import { resolveTabMark } from "../../src/lib/tabMark";
import type { PaneTab, Workspace } from "../../src/types";
import type { WebPaneTranscriptEntry } from "../../src/stores/webPaneTranscriptStore";

const NOW = Date.parse("2026-09-09T02:00:00.000Z");

function webTab(): PaneTab {
  return { id: "tab-web", sessionId: "session-web", agentId: "shell-starter", type: "web", presetId: "chatgpt", label: "ChatGPT" };
}

function webWorkspace(): Workspace {
  const tab = webTab();
  return {
    id: "ws-web",
    name: "Web workspace",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    panes: [{ id: "pane-web", agentId: tab.agentId, sessionId: tab.sessionId, tabs: [tab], activeTabId: tab.id }],
    splitColumns: [["pane-web"]],
  };
}

function webCard(): DashboardCardModel {
  const [card] = buildDashboardCards([webWorkspace()], {
    metadataBySession: {},
    volatileMetadataBySession: {},
    attentionBySession: {},
    seenAttentionByTab: new Map(),
    stallsBySession: {},
    lastLogBySession: {},
    lastLogAtBySession: {},
    doneMarkByTab: new Map(),
    hasTerminalBuffer: () => false,
    now: NOW,
  });
  return card;
}

function transcriptEntry(overrides: Partial<WebPaneTranscriptEntry> = {}): WebPaneTranscriptEntry {
  return {
    events: mergeWebPaneTurns([], [
      { role: "user", text: "この資料を要約して" },
      { role: "assistant", text: "3点にまとめました" },
    ], "tab-web", NOW),
    fetchedAt: NOW,
    error: null,
    loading: false,
    url: "https://chatgpt.com/c/abc",
    title: "ChatGPT",
    signedOut: false,
    generating: false,
    truncated: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderColumn(entry: WebPaneTranscriptEntry, onRefresh = vi.fn()) {
  const card = webCard();
  act(() => root.render(<ChatColumn
    card={card}
    events={entry.events}
    now={NOW}
    active
    pinned={false}
    dragging={false}
    dropPreview={false}
    motion={null}
    targetEventId={null}
    targetEventRequest={0}
    syntheticSource={null}
    onActivate={vi.fn()}
    onTogglePin={vi.fn()}
    onClose={vi.fn()}
    onFocusComposer={vi.fn()}
    onJump={vi.fn()}
    onReorderKeyDown={vi.fn()}
    webTranscript={entry}
    onRefreshWebTranscript={onRefresh}
    detailLoaded
  />));
  return { card, onRefresh };
}

describe("a Web tab's conversation in the dashboard", () => {
  it("shows the turns the pane is displaying", () => {
    renderColumn(transcriptEntry());
    const bubbles = Array.from(container.querySelectorAll(".cmux-dashboard-msg"));
    expect(bubbles.map((bubble) => bubble.textContent)).toEqual([
      expect.stringContaining("この資料を要約して"),
      expect.stringContaining("3点にまとめました"),
    ]);
    expect(container.querySelector("[data-dashboard-chat-empty]")).toBeNull();
  });

  it("states that the turns came from reading the page, and when", () => {
    renderColumn(transcriptEntry());
    const status = container.querySelector("[data-dashboard-web-transcript-status]");
    expect(status?.textContent).toContain("ページから読み取り");
    expect(status?.textContent).toContain("取得");
    // Telemetry belongs to PTY sessions; a Web tab must not be told it is unlinked.
    expect(container.querySelector(".cmux-dashboard-telemetry-fallback")).toBeNull();
  });

  it("surfaces a failed read without emptying the column", () => {
    renderColumn(transcriptEntry({ error: "このタブのページをまだ開いていないため読めません" }));
    expect(container.querySelector(".cmux-dashboard-web-transcript-error")?.textContent)
      .toBe("このタブのページをまだ開いていないため読めません");
    expect(container.querySelectorAll(".cmux-dashboard-msg")).toHaveLength(2);
  });

  it("re-reads on demand", () => {
    const { onRefresh } = renderColumn(transcriptEntry());
    const button = container.querySelector<HTMLButtonElement>("[data-dashboard-web-transcript-refresh]")!;
    act(() => button.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("is not labelled 未起動 just because it has no terminal buffer", () => {
    const card = webCard();
    expect(card.neverStarted).toBe(false);
    expect(card.unobserved).toBe(false);
    expect(card.mark).toEqual(resolveTabMark(webTab()));
  });

  it("blocks the composer with the reason, since a page has no PTY to write to", () => {
    const card = webCard();
    const inputRef = createRef<HTMLTextAreaElement>();
    act(() => root.render(<ReplyComposer card={card} inputRef={inputRef} mentionTargets={[card]} />));
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(container.textContent).toContain("Web ページには送信できません");
  });
});

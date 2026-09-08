import { describe, expect, it } from "vitest";
import { ALL_BELL_NOTIFICATIONS, buildNotificationPanelModel, type NotificationBellFilter } from "../../src/lib/notificationPanelModel";
import { collectNotificationEntries } from "../../src/lib/notificationEntries";
import type { PaneMetadata } from "../../src/stores/paneMetadataStore";
import type { SessionAttention } from "../../src/stores/sessionAttentionStore";
import type { Workspace } from "../../src/types";

function attention(kind: SessionAttention["kind"], stateSince: number, occurrenceOrder = 1): SessionAttention {
  return { sessionId: "session", sessionEpoch: 1, attentionId: "attention", kind, detail: null,
    sessionRevision: 1, uiState: "WaitingInput", stateSince, occurrenceOrder };
}

function fixture() {
  const tabs = Array.from({ length: 11 }, (_, i) => ({
    id: `tab-${i}`, sessionId: `s${i}`, agentId: "shell-starter", label: `Seat ${i}`, agentKind: "codex" as const,
  }));
  const workspaces = [
    { id: "here", name: "Current", panes: [{ id: "p0", tabs: tabs.slice(0, 6) }] },
    { id: "away", name: "Other workspace", panes: [{ id: "p1", tabs: tabs.slice(6) }] },
  ] as Workspace[];
  const states = { s0: attention("input", 30), s6: attention("input", 10), s1: attention("approval", 20) };
  const metadata: Record<string, PaneMetadata> = {
    s0: { notificationCount: 5, workDoneCount: 2 }, s6: {}, s1: { notificationCount: 3 },
    s2: { workDoneCount: 1 }, s7: { workDoneCount: 1 }, s3: { notificationCount: 1 },
  };
  return { workspaces, states, metadata };
}

describe("notification panel model", () => {
  it("partitions eleven seats: two questions, one approval, two completions, one resolved unread and five normal", () => {
    const { workspaces, states, metadata } = fixture();
    const model = buildNotificationPanelModel(workspaces, states, metadata);
    expect(model).toMatchObject({ attentionCount: 3, questionCount: 2, approvalCount: 1, unreadCount: 3 });
    expect(model.attention.map((row) => row.tabId)).toEqual(["tab-6", "tab-1", "tab-0"]);
    expect(model.unread.map((row) => row.tabId)).toEqual(["tab-2", "tab-3", "tab-7"]);
    const all = [...model.attention, ...model.unread];
    expect(new Set(all.map((row) => row.tabId)).size).toBe(6);
    expect(model.attention[0]).toMatchObject({ workspaceId: "away", workspaceName: "Other workspace", paneId: "p1", agentKind: "codex" });
    expect(model.unread[2].workspaceName).toBe("Other workspace");
  });

  it("keeps active questions after reading and exposes their counters only after resolution", () => {
    const { workspaces, states, metadata } = fixture();
    const read = buildNotificationPanelModel(workspaces, states, { ...metadata, s0: {} });
    expect(read.attentionCount).toBe(3);
    expect(read.unreadCount).toBe(3);
    const { s0: _answered, ...resolved } = states;
    const model = buildNotificationPanelModel(workspaces, resolved, metadata);
    expect(model.attentionCount).toBe(2);
    expect(model.unreadCount).toBe(10);
    expect(model.unread[0]).toMatchObject({ tabId: "tab-0", count: 7 });
  });

  it("ignores orphan states and metadata, closed tabs and replaced session identities", () => {
    const { workspaces, states, metadata } = fixture();
    const model = buildNotificationPanelModel([], states, metadata);
    expect(model.attentionCount).toBe(0);
    expect(model.unreadCount).toBe(0);
    const updated = structuredClone(workspaces);
    updated[0].panes[0].tabs[0].sessionId = "replacement";
    updated[1].panes[0].tabs = [];
    const changed = buildNotificationPanelModel(updated, { ...states, orphan: attention("approval", 1) }, { ...metadata, orphan: { notificationCount: 99 } });
    expect(changed.attention.map((row) => row.tabId)).toEqual(["tab-1"]);
    expect(changed.unreadCount).toBe(2);
  });

  it("uses ADR time, occurrence order and stable ID rather than unread count or input/approval grouping", () => {
    const { workspaces, metadata } = fixture();
    const model = buildNotificationPanelModel(workspaces, {
      s0: attention("input", 10, 2), s1: attention("approval", 10, 1), s6: attention("input", 10, 2),
    }, metadata);
    expect(model.attention.map((row) => row.tabId)).toEqual(["tab-1", "tab-0", "tab-6"]);
  });

  it("deduplicates by tab ID without merging different tabs within a pane", () => {
    const { workspaces, states, metadata } = fixture();
    workspaces[0].panes[0].tabs.push(workspaces[0].panes[0].tabs[0]);
    const model = buildNotificationPanelModel(workspaces, states, metadata);
    expect(model.attentionCount).toBe(3);
    expect(model.unread).toHaveLength(3);
  });

  it("reuses every collector label fallback for both sections and does not mutate inputs", () => {
    const { workspaces, states, metadata } = fixture();
    workspaces[0].panes[0].tabs.forEach((tab) => { delete (tab as { label?: string }).label; });
    metadata.s1 = { cwd: "/project/approval" };
    metadata.s3 = { notificationCount: 1, cwd: "/project/result" };
    const volatile = { s0: { processTitle: "Question title" }, s2: { processTitle: "Completed title" } };
    const before = JSON.stringify({ workspaces, states, metadata, volatile });
    const model = buildNotificationPanelModel(workspaces, states, metadata, volatile);
    const expected = collectNotificationEntries(workspaces, Object.fromEntries(
      workspaces.flatMap((ws) => ws.panes.flatMap((pane) => pane.tabs.map((tab) =>
        [tab.sessionId, { ...metadata[tab.sessionId], notificationCount: 1 }],
      ))),
    ), volatile);
    for (const row of [...model.attention, ...model.unread]) {
      expect(row.label).toBe(expected.find((entry) => entry.tabId === row.tabId)?.label);
    }
    expect(JSON.stringify({ workspaces, states, metadata, volatile })).toBe(before);
  });

  it("drops a blocked row the person already dismissed, and brings back the next question", () => {
    const { workspaces, states, metadata } = fixture();
    const seen = new Map([["tab-0", "attention"]]);
    // s0 carries counters too: dismissing zeroes them, so the row leaves the
    // panel entirely instead of sliding down into the unread section.
    const model = buildNotificationPanelModel(workspaces, states, { ...metadata, s0: {} }, {}, { seenAttentionByTab: seen });
    expect(model.attention.map((row) => row.tabId)).toEqual(["tab-6", "tab-1"]);
    expect(model.unread.map((row) => row.tabId)).not.toContain("tab-0");
    expect(model).toMatchObject({ attentionCount: 2, questionCount: 1, approvalCount: 1 });
    const asked = { ...states, s0: { ...states.s0, attentionId: "next" } };
    expect(buildNotificationPanelModel(workspaces, asked, metadata, {}, { seenAttentionByTab: seen })
      .attention.map((row) => row.tabId)).toEqual(["tab-6", "tab-1", "tab-0"]);
  });

  it("keeps a dismissed but still-counting row visible as unread", () => {
    const { workspaces, states, metadata } = fixture();
    const model = buildNotificationPanelModel(workspaces, states, metadata, {},
      { seenAttentionByTab: new Map([["tab-0", "attention"]]) });
    expect(model.attention.map((row) => row.tabId)).toEqual(["tab-6", "tab-1"]);
    expect(model.unread.find((row) => row.tabId === "tab-0")).toMatchObject({ kind: "unread", count: 7, attentionId: null });
  });

  it("exposes the attention id blocked rows are dismissed by", () => {
    const { workspaces, states, metadata } = fixture();
    const model = buildNotificationPanelModel(workspaces, states, metadata);
    expect(model.attention.every((row) => row.attentionId === "attention")).toBe(true);
    expect(model.unread.every((row) => row.attentionId === null)).toBe(true);
  });

  it("reports only the kinds the bell filter allows, counters included", () => {
    const { workspaces, states, metadata } = fixture();
    const filtered = (filter: Partial<NotificationBellFilter>) => buildNotificationPanelModel(
      workspaces, states, metadata, {}, { filter: { ...ALL_BELL_NOTIFICATIONS, ...filter } },
    );
    expect(filtered({ question: false })).toMatchObject({ attentionCount: 1, questionCount: 0, approvalCount: 1 });
    expect(filtered({ approval: false })).toMatchObject({ attentionCount: 2, questionCount: 2, approvalCount: 0 });
    // s0 has 5 waiting + 2 completion counters; muting completions leaves the 5.
    expect(filtered({ question: false, workDone: false }).unread.find((row) => row.tabId === "tab-0"))
      .toMatchObject({ count: 5 });
    // tab-2 is completion-only, so it disappears rather than showing a zero.
    expect(filtered({ workDone: false }).unread.map((row) => row.tabId)).toEqual(["tab-3"]);
    expect(filtered({ unread: false }).unread.map((row) => row.tabId)).toEqual(["tab-2", "tab-7"]);
    const silent = filtered({ question: false, approval: false, workDone: false, unread: false });
    expect(silent).toMatchObject({ attentionCount: 0, unreadCount: 0 });
    expect([...silent.attention, ...silent.unread]).toEqual([]);
  });

  it("leaves an identity-less question in the unread section, where it can still be cleared", () => {
    const { workspaces, states, metadata } = fixture();
    const anonymous = { ...states, s0: { ...states.s0, attentionId: null } };
    const model = buildNotificationPanelModel(workspaces, anonymous, metadata);
    expect(model.attention.map((row) => row.tabId)).toEqual(["tab-6", "tab-1"]);
    expect(model.unread.find((row) => row.tabId === "tab-0")).toMatchObject({ kind: "unread", count: 7 });
  });

  it("does not turn non-actionable attention into an upper row or invent completion/report types", () => {
    const { workspaces, metadata } = fixture();
    const model = buildNotificationPanelModel(workspaces, { s0: attention("none", 10) }, metadata);
    expect(model.attention).toEqual([]);
    expect(model.unread.every((row) => row.kind === "unread")).toBe(true);
    expect(model.unreadCount).toBe(13);
  });
});

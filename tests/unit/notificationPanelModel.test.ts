import { describe, expect, it } from "vitest";
import { buildNotificationPanelModel } from "../../src/lib/notificationPanelModel";
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

  it("does not turn non-actionable attention into an upper row or invent completion/report types", () => {
    const { workspaces, metadata } = fixture();
    const model = buildNotificationPanelModel(workspaces, { s0: attention("none", 10) }, metadata);
    expect(model.attention).toEqual([]);
    expect(model.unread.every((row) => row.kind === "unread")).toBe(true);
    expect(model.unreadCount).toBe(13);
  });
});

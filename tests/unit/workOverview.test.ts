import { describe, expect, it } from "vitest";
import { buildOverviewSnapshot, buildOverviewSuggestions, overviewGatherPlan, overviewVisibleKeys } from "../../src/lib/workOverview";
import type { PaneTab, Workspace } from "../../src/types";
import type { SessionAttention } from "../../src/stores/sessionAttentionStore";
import { loadGroupingInternalsForTests } from "./helpers/groupingTestEntrypoint";
function tab(id: string, extra: Partial<PaneTab> = {}): PaneTab {
  return { id, sessionId: "s-" + id, type: "terminal", agentId: "shell-starter",
    label: "toolx-solar-" + id, cwd: "C:/demo/solar", ...extra };
}
function layout(): Workspace[] {
  return [{ id: "w", name: "今日の開発", status: "running", gridTemplateId: "2x1", createdAt: 1,
    splitColumns: [["a"], ["b"]], columnWidths: [40, 60], rowHeightsPerCol: [[100], [100]],
    panes: [
      { id: "a", cwd: "C:/demo/solar", agentId: "shell-starter", sessionId: "s-one", activeTabId: "one", tabs: [tab("one"), tab("two")] },
      { id: "b", cwd: "C:/demo/solar", agentId: "shell-starter", sessionId: "s-three", activeTabId: "three", tabs: [tab("three")] },
    ] }];
}
function attention(id: string, kind: SessionAttention["kind"], uiState: SessionAttention["uiState"]): SessionAttention {
  return { sessionId: "s-" + id, sessionEpoch: 1, attentionId: kind === "none" ? null : "notice-1",
    kind, uiState, stateSince: 100, sessionRevision: 1, detail: null, occurrenceOrder: 1 };
}
const snapshot = (workspaces = layout(), values: Record<string, SessionAttention> = {}) =>
  buildOverviewSnapshot({ workspaces, ownWindow: "main", attention: values });
describe("work overview", () => {
  it("shows all local and peer sessions once, with canonical counts and unknowns", () => {
    const local = layout();
    const result = buildOverviewSnapshot({ workspaces: local, ownWindow: "main",
      attention: { "s-one": attention("one", "none", "working"), "s-two": attention("two", "none", "idle"), "s-three": attention("three", "done", "done") },
      fragments: [{ window_label: "main", workspaces: [] }, { window_label: "mycmux-w1", workspaces: [{
        id: "peer", name: "別の作業", grid_template_id: "1x1", created_at: 1, panes: [{
          pane_id: "peer-pane", agent_id: "shell-starter", label: "別窓のタブ",
          tabs: [{ tab_id: "four", session_id: "s-four", agent_id: "shell-starter", display_name: "月のレビュー" }],
        }],
      }] }], peerConfirmedAt: 200 });
    expect(result.cards.map(card => card.key)).toEqual(["one", "two", "three", "four"]);
    expect(result.counts).toEqual({ waiting: 0, working: 1, idle: 1, done: 1, unknown: 1 });
    expect(result.cards[3]).toMatchObject({ peer: true, windowLabel: "mycmux-w1", peerConfirmedAt: 200 });
    expect(result.cards[3].tab.displayName).toBe("月のレビュー");
  });
  it("folds only the acknowledged completion; the next notice and questions resurface", () => {
    const values = { "s-three": attention("three", "done", "done") };
    const cards = snapshot(layout(), values).cards;
    const fold = buildOverviewSuggestions(cards, []).find(suggestion => suggestion.kind === "fold")!;
    expect(fold.kind).toBe("fold");
    const folded = { three: cards[2].notificationKey! };
    expect(overviewVisibleKeys(cards, "all", folded)).toEqual(["one", "two"]);
    values["s-three"] = { ...values["s-three"], attentionId: "notice-2" };
    expect(overviewVisibleKeys(snapshot(layout(), values).cards, "all", folded)).toContain("three");
    values["s-three"] = attention("three", "input", "waiting");
    expect(snapshot(layout(), values).counts.waiting).toBe(1);
    expect(overviewVisibleKeys(snapshot(layout(), values).cards, "all", folded)).toContain("three");
  });
  it("retains filtered row membership and order when states change", () => {
    const before = snapshot(layout(), { "s-one": attention("one", "none", "working") }).cards;
    const keys = overviewVisibleKeys(before, "working", {});
    const after = snapshot(layout(), { "s-one": attention("one", "done", "done"), "s-two": attention("two", "input", "waiting") }).cards;
    expect(overviewVisibleKeys(after, "working", {}, keys)).toEqual(["one"]);
    expect(overviewVisibleKeys(after, "waiting", {})).toEqual(["two"]);
  });
  it("requires two strong materials and prefers the larger existing tab over a registry home", () => {
    const registry = [{ section: "開発", label: "Solar", path: "C:/demo/solar" }];
    const workspaces = layout();
    workspaces.push({ ...layout()[0], id: "home", name: "Solar", panes: [], splitColumns: [] });
    const suggestions = buildOverviewSuggestions(snapshot(workspaces).cards, registry);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ kind: "gather", tabId: "three", sourcePaneId: "b", targetPaneId: "a", targetWorkspaceId: "w" });
    if (suggestions[0].kind !== "gather") throw new Error("gather expected");
    expect(suggestions[0].evidence.length).toBeGreaterThanOrEqual(2);
    expect(suggestions[0].title).toContain("toolx-solar-three");
  });
  it("does not gather with a single material, a home folder, or year-only overlap", () => {
    const workspaces = layout();
    workspaces[0].panes.forEach(pane => pane.tabs.forEach(tab => { tab.label = "2026-" + tab.id; }));
    expect(buildOverviewSuggestions(snapshot(workspaces).cards, [])).toEqual([]);
    workspaces[0].panes.forEach(pane => pane.tabs.forEach(tab => { tab.cwd = "C:/Users/sample"; tab.label = "toolx-solar-" + tab.id; }));
    expect(buildOverviewSuggestions(snapshot(workspaces).cards, [])).toEqual([]);
  });
  it("protects human names and pins and never proposes a peer transfer", () => {
    const workspaces = layout();
    workspaces[0].panes[1].pinnedTabId = "three";
    expect(buildOverviewSuggestions(snapshot(workspaces).cards, [])).toEqual([]);
    delete workspaces[0].panes[1].pinnedTabId;
    workspaces[0].panes[1].tabs[0].labelSource = "user";
    expect(buildOverviewSuggestions(snapshot(workspaces).cards, [])).toEqual([]);
    delete workspaces[0].panes[1].tabs[0].labelSource;
    const cards = snapshot(workspaces).cards.map(card => card.paneId === "b" ? { ...card, peer: true, windowLabel: "mycmux-w2" } : card);
    expect(buildOverviewSuggestions(cards, [])).toEqual([]);
  });
  it("limits proposals to five and leaves tied existing groups alone", () => {
    const workspaces = layout();
    workspaces[0].panes[1].tabs.push(tab("four"));
    expect(buildOverviewSuggestions(snapshot(workspaces).cards, [])).toEqual([]);
    const values: Record<string, SessionAttention> = {};
    workspaces[0].panes[0].tabs = Array.from({ length: 8 }, (_, i) => {
      const id = "done" + i; values["s-" + id] = attention(id, "done", "done"); return tab(id);
    });
    expect(buildOverviewSuggestions(snapshot(workspaces, values).cards, []).length).toBe(5);
  });
  it("compiles, commits and undoes one proposal with identical ids, order, active tabs and geometry", async () => {
    const m = await loadGroupingInternalsForTests();
    m.runtime.__resetGroupingRuntimeForTests();
    m.persistence.__resetPersistenceCoordinatorForTests();
    m.persistence.markPersistentSchemaSupported(1);
    m.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
    const workspaces = layout();
    m.workspaceStore.useWorkspaceListStore.setState({ workspaces: structuredClone(workspaces), activeWorkspaceId: "w" });
    m.uiStore.useUiStore.setState({ activePaneId: "s-three", lastActivePaneId: "s-three" });
    const suggestion = buildOverviewSuggestions(snapshot(workspaces).cards, [])[0];
    if (suggestion.kind !== "gather") throw new Error("gather expected");
    const plan = overviewGatherPlan(suggestion, workspaces)!;
    const { groupingBoundary } = await import("../../src/components/layout/groupingBoundary");
    const context = { baseline: workspaces.flatMap(ws => ws.panes.flatMap(pane => pane.tabs.map(tab => ({
      workspaceId: ws.id, paneId: pane.id, tabId: tab.id, sessionId: tab.sessionId,
    })))), activeWorkspaceId: "w", activeSessionId: "s-three", allocationSeed: "overview-test", createdAt: 1 };
    const before = structuredClone(m.workspaceStore.useWorkspaceListStore.getState().workspaces);
    const prepared = groupingBoundary.prepare(plan, context);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    expect(prepared.ok).toBe(true);
    const result = groupingBoundary.commit(plan, prepared.ticket);
    expect(result.commit.ok).toBe(true);
    expect(m.workspaceStore.useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.map(tab => tab.id)).toEqual(["one", "two", "three"]);
    expect(groupingBoundary.undo().ok).toBe(true);
    expect(JSON.parse(JSON.stringify(m.workspaceStore.useWorkspaceListStore.getState().workspaces))).toEqual(before);
    expect(m.uiStore.useUiStore.getState().activePaneId).toBe("s-three");
    m.runtime.__resetGroupingRuntimeForTests();
    m.persistence.__resetPersistenceCoordinatorForTests();
  });
});

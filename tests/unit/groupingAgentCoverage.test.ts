import { beforeEach, expect, it, vi } from "vitest";
import { scanGroupingContext, type GroupingScanSource } from "../../src/components/layout/tabGrouping";
import { composeEvidencePlans } from "../../src/components/layout/evidenceGrouping";
import { resolvePaneIdentities } from "../../src/lib/paneIdentity";
import { AGENT_CATALOG } from "../../src/lib/agentCatalog";
import { withSessionTitles, resetSessionTitlesForTest, sessionHistoryStatusLabel } from "../../src/lib/sessionTitles";
import type { PaneTab, Workspace } from "../../src/types";
import { createGroupingEngine, persistentLayoutProjection, type GroupingEngineDependencies, type GroupingSelectionState } from "./helpers/groupingTestEntrypoint";
import type { GroupingUndoRecord } from "../../src/stores/groupingRuntimeStore";

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: transport.invoke }));
const targets = AGENT_CATALOG.filter(entry => entry.kind === "agent");
function source(): GroupingScanSource {
  const tabs: PaneTab[] = targets.map(entry => ({ id: entry.target, sessionId: "pty-" + entry.target,
    type: "terminal", agentId: "shell-starter", label: "Harbor " + entry.label, labelSource: "user",
    cwd: "C:/Users/sample", agentKind: entry.agentKind, agentSessionId: entry.agentKind ? "chat-" + entry.target : undefined,
    launchEnv: { MYCMUX_LAUNCH_TARGET: entry.target } }));
  tabs.push({ ...tabs.find(tab => tab.id === "claude-codex")!, id: "wrapper-resume", sessionId: "pty-wrapper-resume", agentSessionId: "saved-wrapper",
    launchEnv: { MYCMUX_RESUME: "claude-codex", MYCMUX_AGENT_KIND: "claude-codex", MYCMUX_SESSION_ID: "saved-wrapper" } });
  tabs.push({ ...tabs.find(tab => tab.id === "codex")!, id: "codex-resume", sessionId: "pty-codex-resume", agentSessionId: "saved-codex",
    launchEnv: { MYCMUX_RESUME: "codex", MYCMUX_AGENT_KIND: "codex", MYCMUX_SESSION_ID: "saved-codex" } });
  tabs.push({ id: "unknown", sessionId: "pty-unknown", agentId: "shell-starter", type: "terminal", label: "Unknown task", cwd: "C:/Users/sample" });
  const workspace: Workspace = { id: "today", name: "今日", status: "running", createdAt: 1, gridTemplateId: "1x1",
    splitColumns: [["place"]], columnWidths: [100], rowHeightsPerCol: [[100]],
    panes: [{ id: "place", tabs, activeTabId: tabs[0].id, sessionId: tabs[0].sessionId, agentId: "shell-starter", agentKind: "claude",
      agentSessionId: tabs[0].agentSessionId, cwd: tabs[0].cwd, launchEnv: tabs[0].launchEnv }] };
  return { workspaces: [workspace], metadata: {}, processMetadata: Object.fromEntries(tabs.map(tab => [tab.sessionId,
    { session_id: tab.sessionId, cwd: tab.cwd!, process_status: "working", agent_active: true }])),
    processMetadataAvailable: true, lastOutputBySession: {}, readTail: async () => [], now: 1 };
}
const registry = [{ section: "開発", label: "Harbor", path: "C:/work/harbor" },
  ...Array.from({ length: 10 }, (_, index) => ({ section: "別枠", label: "Sample" + index, path: "C:/other/" + index }))];
beforeEach(() => { resetSessionTitlesForTest(); transport.invoke.mockReset().mockResolvedValue([]); });

it("G2 preserves catalog launch kinds without borrowing the active tab kind", async () => {
  const input = source();
  const scan = await scanGroupingContext(input);
  expect(scan.tabs).toHaveLength(targets.length + 3);
  expect(new Set(scan.tabs.map(tab => tab.id)).size).toBe(scan.tabs.length);
  for (const entry of targets) {
    const expected = entry.target === "agy" ? "antigravity" : entry.target;
    expect(scan.tabs.find(tab => tab.id === entry.target)?.agentKind).toBe(expected);
  }
  expect(scan.tabs.find(tab => tab.id === "unknown")?.agentKind).toBe("");
});

it("G2 takes kind and conversation ID together from the latest native metadata", async () => {
  const input = source();
  input.metadata["pty-claude-codex"] = { agentKind: "claude", agentSessionId: "old-chat", cwd: "" };
  Object.assign(input.processMetadata["pty-claude-codex"], { agent_kind: "claude-codex", agent_session_id: "current-wrapper", cwd: "C:/work/harbor" });
  Object.assign(input.processMetadata["pty-claude"], { live_agent_kind: "codex", agent_kind: "codex" });
  Object.assign(input.processMetadata["pty-codex"], { agent_kind: "codex" });
  Object.assign(input.processMetadata["pty-grok"], { live_agent_kind: "claude-codex", agent_kind: "grok", agent_session_id: "old-grok" });
  const scan = await scanGroupingContext(input);
  expect(scan.tabs.find(tab => tab.id === "claude-codex")).toMatchObject({ agentKind: "claude-codex", agentSessionId: "current-wrapper", cwd: "C:/work/harbor" });
  expect(scan.tabs.find(tab => tab.id === "claude")).toMatchObject({ agentKind: "codex", agentSessionId: undefined });
  expect(scan.tabs.find(tab => tab.id === "codex")).toMatchObject({ agentKind: "codex", agentSessionId: undefined });
  expect(scan.tabs.find(tab => tab.id === "grok")).toMatchObject({ agentKind: "claude-codex", agentSessionId: undefined });
});

it("G2 keeps unknown liveness instead of treating a failed snapshot as dead", async () => {
  const input = source(); input.processMetadata = {}; input.processMetadataAvailable = false;
  const scan = await scanGroupingContext(input);
  expect(scan.tabs.map(tab => tab.id)).toEqual(input.workspaces[0].panes[0].tabs.map(tab => tab.id));
});

it("G4 uses readable labels when transcripts and a project cwd are unavailable", async () => {
  const scan = await scanGroupingContext(source());
  const identity = resolvePaneIdentities({ registry, allowLabelProjects: true, workspaces: scan.workspaces, tabs: scan.tabs });
  for (const tab of scan.tabs.filter(tab => tab.id !== "unknown")) {
    expect(identity.tabs.get(tab.id)).toMatchObject({ project: { key: "Harbor" }, projectReason: "readable_label" });
  }
  const plans = composeEvidencePlans(scan, registry);
  for (const plan of plans) {
    const ids = plan.groups.flatMap(group => group.tabIds).concat(plan.unassignedTabIds);
    expect(ids.sort()).toEqual(scan.tabs.map(tab => tab.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
  }
  expect(plans[1].groups.filter(group => group.disposition === "reorganize").flatMap(group => group.tabIds)).toHaveLength(targets.length + 2);
  expect(plans[1].groups.find(group => group.disposition === "keep")?.tabIds).toEqual(["unknown"]);
});

it("G5 carries unavailable and unsupported history without dropping any catalog target", async () => {
  const scan = await scanGroupingContext(source());
  transport.invoke.mockImplementation(async (_command, args) => args.requests.map((request: { tab_id: string; agent_kind: string }) => ({
    tab_id: request.tab_id, session_title: null, task_title: null,
    history_status: ["claude", "claude-codex", "codex"].includes(request.agent_kind) ? "unavailable" : "unsupported",
  })));
  const hydrated = await withSessionTitles(scan);
  expect(hydrated.tabs.map(tab => tab.id)).toEqual(scan.tabs.map(tab => tab.id));
  expect((hydrated.tabs.find(tab => tab.id === "codex") as any).historyStatus).toBe("unavailable");
  expect((hydrated.tabs.find(tab => tab.id === "grok") as any).historyStatus).toBe("unsupported");
  expect((hydrated.tabs.find(tab => tab.id === "hermes") as any).historyStatus).toBe("unsupported");
});

it("G5 exposes history fallback reasons after a reader failure without trusting a cwd title", async () => {
  const input = source();
  delete input.workspaces[0].panes[0].tabs.find(tab => tab.id === "codex")!.agentSessionId;
  const scan = await scanGroupingContext(input);
  transport.invoke.mockRejectedValue(new Error("offline"));
  const result = await withSessionTitles(scan);
  expect(result.tabs).toHaveLength(scan.tabs.length);
  expect(sessionHistoryStatusLabel(result.tabs.find(tab => tab.id === "codex")?.historyStatus)).toBe("会話IDを未取得");
  expect(sessionHistoryStatusLabel(result.tabs.find(tab => tab.id === "claude-codex")?.historyStatus)).toBe("会話を未取得");
  expect(sessionHistoryStatusLabel(result.tabs.find(tab => tab.id === "grok")?.historyStatus)).toBe("会話読取は未対応");
  expect(sessionHistoryStatusLabel("available")).toBe("会話を確認済み");
});

it("G6 previews, applies and undoes every mixed agent while preserving PTY and conversation identity", async () => {
  const scan = await scanGroupingContext(source());
  const plan = composeEvidencePlans(scan, registry)[1];
  const engine = createGroupingEngine();
  let workspaces = structuredClone(scan.workspaces);
  let selection: GroupingSelectionState = { activeWorkspaceId: "today", activeSessionId: "pty-claude", lastActivePaneByWorkspace: { today: "pty-claude" } };
  let undo: GroupingUndoRecord | null = null;
  const context = { baseline: scan.baseline, activeWorkspaceId: selection.activeWorkspaceId, activeSessionId: selection.activeSessionId,
    allocationSeed: "mixed-agents", createdAt: 1, newWorkspaceDefaults: { status: "running" as const, pet: "clawd" } };
  const dependencies: GroupingEngineDependencies = {
    boundaryToken: {}, getWorkspaces: () => workspaces, getSelection: () => structuredClone(selection),
    replaceWorkspaces: next => { workspaces = structuredClone(next); }, applySelection: next => { selection = structuredClone(next); },
    restoreGroupingState: snapshot => { workspaces = structuredClone(snapshot.workspaces); selection = structuredClone(snapshot.selection); },
    getLayoutRevision: () => 0,
    undo: { get: () => undo, set: value => { undo = structuredClone(value); },
      expire: reason => { if (undo) undo = { ...undo, status: "expired", expireReason: reason }; }, clear: () => { undo = null; } },
  };
  const identities = (items: Workspace[]) => items.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs.map(tab => ({
    tabId: tab.id, sessionId: tab.sessionId, agentKind: tab.agentKind, agentSessionId: tab.agentSessionId,
    launchEnv: tab.launchEnv, commandArgv: tab.commandArgv,
  })))).sort((left, right) => left.tabId.localeCompare(right.tabId));
  const before = identities(workspaces);
  const beforeLayout = persistentLayoutProjection(workspaces);
  const preview = engine.compileGroupingPlan(plan, workspaces, context);
  expect(preview.ok, preview.ok ? "" : preview.errors.join("; ")).toBe(true);
  if (!preview.ok) throw new Error(preview.errors.join("; "));
  const prepared = engine.prepareGroupingCommit(plan, workspaces, context);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.errors.join("; "));
  const committed = engine.commitPreparedGrouping(plan, prepared.ticket, dependencies);
  expect(committed.ok).toBe(true);
  expect(identities(workspaces)).toEqual(before);
  expect(persistentLayoutProjection(workspaces)).toEqual(persistentLayoutProjection(preview.transaction.workspaces));
  expect(new Set(identities(workspaces).map(tab => tab.sessionId)).size).toBe(before.length);
  expect(transport.invoke).not.toHaveBeenCalled();
  expect(engine.restoreGroupingUndo(dependencies)).toEqual({ ok: true });
  expect(persistentLayoutProjection(workspaces)).toEqual(beforeLayout);
  expect(identities(workspaces)).toEqual(before);
  expect(transport.invoke).not.toHaveBeenCalled();
});

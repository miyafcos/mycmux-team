import type { PaneCloseOwner, PaneCloseTarget } from "./paneClosePreflight";
import { preflightPaneClose } from "./paneClosePreflight";
import { confirmPaneClose } from "./paneCloseConfirmation";
import { collectPaneCloseVictims } from "./paneCloseImpact";
import { confirm } from "./appConfirmation";
import { isDeclaredTab } from "./tabLifecycle";
import { killSession } from "./ipc";
import { evictTerminalCache } from "../components/terminal/terminalCache";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { pushClosedTab } from "../stores/closedPaneStore";
import { beforePaneClose } from "./paneCloseLifecycle";
import { useToastStore } from "../stores/toastStore";
import { useUiStore } from "../stores/uiStore";
import { applyLayoutMutation, type MutationSummary } from "./layoutMutation";
import { getTabDisplayLabel } from "./tabDisplayLabel";

export const PANE_CLOSE_TIMEOUT_MS = 10_000;
export type PaneCloseSource = "ui" | "cli";
export interface PaneCloseResult {
  status: "closed" | "refused" | "cancelled" | "failed" | "pending";
  reason?: "last" | "missing" | "busy";
  error?: unknown;
  summary?: MutationSummary;
  closedTabIds?: string[];
}
interface CloseOperation {
  target: PaneCloseTarget;
  source: PaneCloseSource;
  owners: PaneCloseOwner[];
  promise: Promise<PaneCloseResult>;
  phase: "confirming" | "terminating";
  started: Promise<void>;
  startTermination: () => void;
  toastId?: string;
}
const operations = new Map<string, CloseOperation>();
// Keep acknowledged kills only while their tabs remain visible after a partial failure.
const terminatedSessions = new Set<string>();

function keyOf(target: PaneCloseTarget): string {
  return target.kind === "tabs" ? `tabs:${[...new Set(target.tabIds)].sort().join("\0")}`
    : `${target.kind}:${target.workspaceId}:${target.paneId}:${target.kind === "tab" ? target.tabId : ""}`;
}
function readPlan(target: PaneCloseTarget, own?: CloseOperation) {
  const reserved = new Set([...operations.values()].filter(op => op !== own).flatMap(op => op.owners.map(owner => owner.tab.id)));
  // Reserve the last remaining target across overlapping async close requests.
  const projected = useWorkspaceListStore.getState().workspaces.map(workspace => ({
    ...workspace,
    panes: workspace.panes.filter(pane => !pane.tabs.length || !pane.tabs.every(tab => reserved.has(tab.id))).map(pane => ({
      ...pane, tabs: pane.tabs.filter(tab => !reserved.has(tab.id)),
    })),
  }));
  const projectedPlan = preflightPaneClose(projected, target);
  if (!projectedPlan.ok) return projectedPlan;
  return preflightPaneClose(useWorkspaceListStore.getState().workspaces, target);
}
function fingerprint(plan: Extract<ReturnType<typeof preflightPaneClose>, { ok: true }>): string {
  const metadata = usePaneMetadataStore.getState();
  return JSON.stringify({
    targets: plan.owners.map(({ workspace, pane, tab }) => [workspace.id, pane.id, tab.id, tab.sessionId, tab.type, tab.lifecycle, tab.isDirty]),
    victims: collectPaneCloseVictims(plan.panes, metadata.metadata, metadata.volatileMetadata),
  });
}
function ownsPty({ tab }: PaneCloseOwner): boolean {
  return (tab.type === undefined || tab.type === "terminal") && !isDeclaredTab(tab);
}
function showFailure(op: CloseOperation, pending: boolean): void {
  if (op.toastId) return;
  op.toastId = useToastStore.getState().pushToast(pending
    ? "\u7d42\u4e86\u306e\u5fdc\u7b54\u3092\u5f85\u3063\u3066\u3044\u307e\u3059\u3002\u30da\u30a4\u30f3\u306f\u7d50\u679c\u304c\u5c4a\u304f\u307e\u3067\u6b8b\u3057\u307e\u3059\u3002"
    : "\u7d42\u4e86\u3067\u304d\u306a\u304b\u3063\u305f\u305f\u3081\u3001\u30da\u30a4\u30f3\u3092\u6b8b\u3057\u307e\u3057\u305f\u3002\u3082\u3046\u4e00\u5ea6\u9589\u3058\u308b\u3053\u3068\u304c\u3067\u304d\u307e\u3059\u3002",
  "error", {
    label: pending ? "\u7d50\u679c\u3092\u78ba\u8a8d" : "\u3082\u3046\u4e00\u5ea6\u9589\u3058\u308b",
    run: () => { void closePaneOperation(op.target, op.source); },
  });
}

async function execute(op: CloseOperation): Promise<PaneCloseResult> {
  let plan = readPlan(op.target, op);
  if (!plan.ok) return { status: "refused", reason: plan.reason };
  while (true) {
    op.owners = plan.owners;
    const before = fingerprint(plan);
    if (op.source === "ui") {
      if (!await confirmPaneClose(plan.panes, op.target.kind === "tab" ? "tab" : "pane")) return { status: "cancelled" };
      for (const { tab } of plan.owners) {
        if (tab.type === "browser" && tab.isDirty && !await confirm(`${getTabDisplayLabel(tab)} has unsaved edits. Close it anyway?`)) return { status: "cancelled" };
      }
    }
    const current = readPlan(op.target, op);
    if (!current.ok) return { status: "refused", reason: current.reason };
    if (fingerprint(current) === before) { plan = current; break; }
    plan = current;
  }
  op.owners = plan.owners;
  op.phase = "terminating";
  op.startTermination();
  const sessions = [...new Set(plan.owners.filter(ownsPty).map(owner => owner.tab.sessionId))];
  const results = await Promise.allSettled(sessions.map(async sessionId => {
    if (!terminatedSessions.has(sessionId)) {
      await killSession(sessionId);
      terminatedSessions.add(sessionId);
    }
  }));
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") {
    if (op.toastId) { useToastStore.getState().dismissToast(op.toastId); op.toastId = undefined; }
    showFailure(op, false);
    return { status: "failed", error: failure.reason };
  }
  // No await from here through the layout commit: never remove a newly spawned
  // or moved replacement because it reused a tab/pane id while kills were pending.
  const live = useWorkspaceListStore.getState().workspaces;
  const currentOwners = live.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs.map(tab => ({ workspace, pane, tab }))));
  const closing = currentOwners.filter(owner => plan.owners.some(original =>
    original.tab.id === owner.tab.id && original.tab.sessionId === owner.tab.sessionId));
  const closedTabIds = closing.map(owner => owner.tab.id);
  const layout = useWorkspaceLayoutStore.getState();
  let summary: MutationSummary | undefined;
  const target = op.target;
  if (target.kind === "tabs") {
    const mutation = applyLayoutMutation(live, { kind: "close-tabs", operationId: crypto.randomUUID(), tabIds: closedTabIds }, 0);
    summary = mutation.summary;
    summary.skipped = [...new Set(target.tabIds)].filter(id => !closedTabIds.includes(id));
    for (const owner of closing) recordTab(owner);
    useWorkspaceListStore.getState()._replaceWorkspaces(mutation.workspaces);
  } else {
    const wholePane = target.kind === "pane" && live.find(w => w.id === target.workspaceId)?.panes.find(p => p.id === target.paneId);
    if (wholePane && wholePane.tabs.every(tab => closedTabIds.includes(tab.id))
      && live.find(w => w.id === target.workspaceId)!.panes.length > 1) {
      beforePaneClose(wholePane);
      layout.removePaneFromWorkspace(target.workspaceId, target.paneId);
    } else {
      for (const owner of closing) {
        const allowed = preflightPaneClose(useWorkspaceListStore.getState().workspaces, {
          kind: "tab", workspaceId: owner.workspace.id, paneId: owner.pane.id, tabId: owner.tab.id,
        });
        if (!allowed.ok) {
          showFailure(op, false);
          return { status: "failed", error: new Error("Close target changed while termination was pending") };
        }
        recordTab(owner);
        layout.removeTabFromPane(owner.workspace.id, owner.pane.id, owner.tab.id);
      }
    }
  }
  const activeSession = useUiStore.getState().activePaneId;
  const remaining = useWorkspaceListStore.getState();
  if (activeSession && closing.some(owner => owner.tab.sessionId === activeSession)
    && !remaining.workspaces.some(workspace => workspace.panes.some(pane => pane.tabs.some(tab => tab.sessionId === activeSession)))) {
    const workspace = remaining.workspaces.find(workspace => workspace.id === remaining.activeWorkspaceId);
    const previousIndex = closing.find(owner => owner.tab.sessionId === activeSession)?.workspace.panes.findIndex(pane => pane.tabs.some(tab => tab.sessionId === activeSession)) ?? 0;
    const nextPane = workspace?.panes[Math.min(Math.max(previousIndex, 0), workspace.panes.length - 1)];
    const nextTab = nextPane?.tabs.find(tab => tab.id === nextPane.activeTabId) ?? nextPane?.tabs[0];
    useUiStore.getState().setActivePaneId(nextTab?.sessionId ?? null);
  }
  for (const owner of closing) {
    if (ownsPty(owner)) evictTerminalCache(owner.tab.sessionId);
    usePaneMetadataStore.getState().removeMetadata(owner.tab.sessionId);
    terminatedSessions.delete(owner.tab.sessionId);
  }
  if (op.toastId) useToastStore.getState().dismissToast(op.toastId);
  return { status: "closed", closedTabIds, summary };
}

function recordTab({ workspace, pane, tab }: PaneCloseOwner): void {
  if (tab.type === undefined || tab.type === "terminal") pushClosedTab(pane, tab, { workspaceId: workspace.id, workspaceName: workspace.name });
}

async function observe(op: CloseOperation): Promise<PaneCloseResult> {
  // Confirmation itself has no deadline; an unanswered user prompt never kills.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PaneCloseResult>(resolve => {
    void op.started.then(() => {
      timer = setTimeout(() => {
        showFailure(op, true); resolve({ status: "pending" });
      }, PANE_CLOSE_TIMEOUT_MS);
    });
  });
  try { return await Promise.race([op.promise, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** GUI and explicit CLI closes share the same preflight and commit-after-kill path. */
export async function closePaneOperation(target: PaneCloseTarget, source: PaneCloseSource): Promise<PaneCloseResult> {
  const key = keyOf(target);
  const existing = operations.get(key);
  if (existing) {
    // Explicit automation never waits on a GUI prompt already in progress.
    if (source === "cli" && existing.source === "ui" && existing.phase === "confirming") return { status: "refused", reason: "busy" };
    return observe(existing);
  }
  const plan = readPlan(target);
  if (!plan.ok) return { status: "refused", reason: plan.reason };
  const overlap = [...operations.values()].some(op => op.owners.some(owner => plan.owners.some(candidate => candidate.tab.id === owner.tab.id)));
  if (overlap) return { status: "refused", reason: "busy" };
  let startTermination!: () => void;
  const started = new Promise<void>(resolve => { startTermination = resolve; });
  const op: CloseOperation = { target, source, owners: plan.owners, phase: "confirming", started, startTermination, promise: Promise.resolve({ status: "pending" }) };
  operations.set(key, op);
  op.promise = execute(op).catch(error => { showFailure(op, false); return { status: "failed", error } as PaneCloseResult; }).finally(() => { operations.delete(key); });
  return observe(op);
}

export function resetPaneCloseOperationsForTests(): void {
  operations.clear(); terminatedSessions.clear();
}

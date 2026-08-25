import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OverlayShell } from "../common/OverlayShell";
import { tabGroupingStrings } from "../dashboard/dashboardStrings";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import { useUiStore } from "../../stores/uiStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import type { Workspace } from "../../types";
import { formatJudgeError } from "./tabSweep";
import {
  addGroup,
  clonePlanForEdit,
  commitGroupingPlan,
  compileGroupingPlan,
  defaultCommitDependencies,
  dismissGroupingUndo,
  findTabLocation,
  formatGroupingAiNote,
  getGroupingUndoMemory,
  planCardStats,
  previewKindForTab,
  reassignTabs,
  recallGroupingUndo,
  restoreGroupingUndo,
  runGroupingAnalysis,
  scanGroupingContext,
  setGroupAdopted,
  setGroupDestination,
  subscribeGroupingUndo,
  validateEditedPlan,
  type GroupingDestination,
  type GroupingPlan,
  type GroupingScan,
  type LayoutTransaction,
  type ParseGroupingResult,
  type StaleIssue,
  type TabPreviewKind,
} from "./tabGrouping";
import "./TabGroupingPanel.css";

type GroupingMode = "compare" | "edit" | "confirm";
type ConfirmView = "current" | "after" | "diff";

export interface TabGroupingPanelProps {
  open: boolean;
  visible: boolean;
  closing?: boolean;
  onClose: () => void;
}

function requestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-grouping-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function strategyLabel(strategy: GroupingPlan["strategy"]): string {
  if (strategy === "project") return tabGroupingStrings.strategyProject;
  if (strategy === "role") return tabGroupingStrings.strategyRole;
  if (strategy === "minimal_move") return tabGroupingStrings.strategyMinimal;
  return tabGroupingStrings.strategyMixed;
}

function tabName(label: string | undefined): string {
  return label?.trim() || tabGroupingStrings.unnamedTab;
}

function PreviewWorkspaces({
  workspaces,
  current,
  plan,
  view,
  highlightMoved,
  selectedTabIds,
  onToggleTab,
}: {
  workspaces: Workspace[];
  current: Workspace[];
  plan: GroupingPlan | null;
  view: ConfirmView;
  highlightMoved: boolean;
  selectedTabIds?: ReadonlySet<string>;
  onToggleTab?: (tabId: string) => void;
}) {
  return (
    <div>
      {workspaces.map((workspace) => {
        const isNew = !current.some((item) => item.id === workspace.id);
        const empty = workspace.panes.every((pane) => pane.tabs.length === 0);
        return (
          <section
            key={workspace.id}
            className={`cmux-tab-grouping-workspace${isNew ? " is-new" : ""}${empty ? " is-empty" : ""}`}
          >
            <div className="cmux-tab-grouping-workspace-head">
              <span>{workspace.name}</span>
              {isNew ? <span className="cmux-tab-grouping-badge">{tabGroupingStrings.newBadge}</span> : null}
              {empty ? <span className="cmux-tab-grouping-badge">{tabGroupingStrings.notDeleted}</span> : null}
            </div>
            <div className="cmux-tab-grouping-columns">
              {(workspace.splitColumns ?? [workspace.panes.map((pane) => pane.id)]).map((column, columnIndex) => (
                <div key={`${workspace.id}-${columnIndex}`}>
                  {column.map((paneId) => {
                    const pane = workspace.panes.find((item) => item.id === paneId);
                    if (!pane) return null;
                    return (
                      <div key={pane.id} className="cmux-tab-grouping-pane">
                        {pane.tabs.map((tab) => {
                          const kind: TabPreviewKind = plan ? previewKindForTab(plan, tab.id) : "untouched";
                          const from = view === "diff" ? findTabLocation(current, tab.id) : null;
                          const selected = selectedTabIds?.has(tab.id) ?? false;
                          const className = `cmux-tab-grouping-chip is-${kind}${selected ? " is-selected" : ""}${highlightMoved && kind === "moved" ? " is-highlight" : ""}`;
                          const body = (
                            <>
                              <span>{tabName(tab.label)}</span>
                              {from && (from.workspaceId !== workspace.id || from.paneId !== pane.id) ? (
                                <span className="cmux-tab-grouping-from">
                                  {current.find((item) => item.id === from.workspaceId)?.name ?? from.workspaceId}
                                </span>
                              ) : null}
                            </>
                          );
                          return onToggleTab ? (
                            <button
                              type="button"
                              key={tab.id}
                              className={className}
                              aria-pressed={selected}
                              onClick={() => onToggleTab(tab.id)}
                            >
                              {body}
                            </button>
                          ) : (
                            <div key={tab.id} className={className}>{body}</div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function TabGroupingPanel({ open, visible, closing = false, onClose }: TabGroupingPanelProps) {
  const activeRequestRef = useRef<string | null>(null);
  const analyzeGenerationRef = useRef(0);
  const [mode, setMode] = useState<GroupingMode>("compare");
  const [confirmView, setConfirmView] = useState<ConfirmView>("diff");
  const [showCurrent, setShowCurrent] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [highlightMoved, setHighlightMoved] = useState(false);
  const [status, setStatus] = useState<string>(tabGroupingStrings.analyzing);
  const [scan, setScan] = useState<GroupingScan | null>(null);
  const [plans, setPlans] = useState<GroupingPlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [editedByPlan, setEditedByPlan] = useState<Record<string, GroupingPlan>>({});
  const [comparisonInsufficient, setComparisonInsufficient] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(new Set());
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [stale, setStale] = useState<StaleIssue[]>([]);
  const [applyErrors, setApplyErrors] = useState<string[]>([]);
  const [applied, setApplied] = useState<LayoutTransaction | null>(null);
  const [reviewApplied, setReviewApplied] = useState(false);
  const [undoRevision, setUndoRevision] = useState(0);
  const aiProvider = useAiSettingsStore((state) => state.aiProvider);
  const aiModel = useAiSettingsStore((state) => state.aiModel);
  const aiEnabled = useAiSettingsStore((state) => state.aiEnabled);
  const workspaces = useWorkspaceListStore((state) => state.workspaces);

  useEffect(() => subscribeGroupingUndo(() => setUndoRevision((value) => value + 1)), []);
  const undo = getGroupingUndoMemory();

  const edited = selectedPlanId ? editedByPlan[selectedPlanId] ?? plans.find((plan) => plan.planId === selectedPlanId) ?? null : null;
  const selectedGroup = edited?.groups.find((group) => group.groupId === selectedGroupId) ?? edited?.groups[0] ?? null;

  const updateEdited = useCallback((planId: string, next: GroupingPlan) => {
    setEditedByPlan((current) => ({ ...current, [planId]: next }));
  }, []);

  const cancelJudge = useCallback(() => {
    const id = activeRequestRef.current;
    activeRequestRef.current = null;
    if (id) void invoke<boolean>("abort_tab_sweep_judge", { requestId: id }).catch(() => {});
  }, []);

  const resetTransientUi = useCallback(() => {
    setSelectedPlanId(null);
    setEditedByPlan({});
    setSelectedGroupId(null);
    setSelectedTabIds(new Set());
    setDestinationOpen(false);
    setMoveOpen(false);
    setStale([]);
    setApplyErrors([]);
    setApplied(null);
    setReviewApplied(false);
    setComparisonInsufficient(false);
  }, []);

  const analyze = useCallback(async () => {
    const generation = ++analyzeGenerationRef.current;
    cancelJudge();
    setAnalyzing(true);
    setParseError(null);
    setRaw("");
    setPlans([]);
    resetTransientUi();
    setMode("compare");
    setStatus(tabGroupingStrings.analyzing);
    try {
      const result = await runGroupingAnalysis({
        scan: scanGroupingContext,
        requestId,
        judge: async (prompt, id) => {
          activeRequestRef.current = id;
          return invoke<string>("run_tab_sweep_judge", { prompt, requestId: id, mode: "grouping" });
        },
      });
      if (generation !== analyzeGenerationRef.current) return;
      setScan(result.scan);
      setRaw(result.raw);
      if (result.parsed.status === "invalid") {
        setParseError(result.parsed.reason);
        setPlans([]);
        setStatus(result.parsed.reason);
        return;
      }
      const parsed: ParseGroupingResult = result.parsed;
      setPlans(parsed.plans);
      setEditedByPlan(Object.fromEntries(parsed.plans.map((plan) => [plan.planId, clonePlanForEdit(plan)])));
      setSelectedPlanId(parsed.plans[0]?.planId ?? null);
      setSelectedGroupId(parsed.plans[0]?.groups[0]?.groupId ?? null);
      setComparisonInsufficient(parsed.comparisonInsufficient);
      setStatus(parsed.comparisonInsufficient ? tabGroupingStrings.comparisonInsufficient : tabGroupingStrings.analyzed);
    } catch (error) {
      if (generation !== analyzeGenerationRef.current) return;
      const presented = formatJudgeError(error, aiProvider);
      setParseError(presented.summary);
      setRaw(presented.raw);
      setStatus(presented.summary);
    } finally {
      if (generation === analyzeGenerationRef.current) {
        activeRequestRef.current = null;
        setAnalyzing(false);
      }
    }
  }, [aiProvider, cancelJudge, resetTransientUi]);

  useEffect(() => {
    if (!open) {
      cancelJudge();
      return;
    }
    void analyze();
    return () => cancelJudge();
  }, [analyze, cancelJudge, open]);

  const compiled = useMemo(() => {
    if (applied) return { ok: true as const, transaction: applied };
    if (!edited || !scan) return null;
    return compileGroupingPlan(edited, workspaces, {
      baseline: scan.baseline,
      activeWorkspaceId: useWorkspaceListStore.getState().activeWorkspaceId,
      activeSessionId: useUiStore.getState().activePaneId ?? useUiStore.getState().lastActivePaneId,
    });
  }, [applied, edited, scan, workspaces]);

  const editErrors = useMemo(() => {
    if (!edited || !scan) return [];
    return validateEditedPlan(
      edited,
      scan.tabs.map((tab) => tab.id),
      workspaces.map((item) => item.id),
      workspaces.map((item) => item.name),
    );
  }, [edited, scan, workspaces]);

  const apply = useCallback(() => {
    if (!edited || !scan || applying || applied) return;
    if (!compiled || !compiled.ok) return;
    if (compiled.transaction.expected.movedTabIds.length === 0) {
      setStatus(tabGroupingStrings.applyZeroMoves);
      return;
    }
    setApplying(true);
    setStatus(tabGroupingStrings.applying);
    const result = commitGroupingPlan(edited, scan.baseline, defaultCommitDependencies(), compiled.transaction);
    if (!result.ok) {
      setStale(result.stale ?? []);
      setApplyErrors(result.errors);
      setParseError(result.errors[0] ?? tabGroupingStrings.applyBlocked);
      setStatus(result.stale?.length ? tabGroupingStrings.applyBlocked : (result.errors[0] ?? tabGroupingStrings.applyBlocked));
      setApplying(false);
      setMode("edit");
      return;
    }
    setStale([]);
    setApplyErrors([]);
    setApplied(result.transaction);
    setHighlightMoved(true);
    setStatus(tabGroupingStrings.undoApplied(result.report.moved.length));
    window.setTimeout(() => {
      setHighlightMoved(false);
      setApplying(false);
    }, 0);
  }, [applied, applying, compiled, edited, scan]);

  if (!visible) return null;

  const previewCurrent = reviewApplied && undo ? undo.snapshot.workspaces : workspaces;
  const previewAfter = reviewApplied && undo
    ? undo.appliedWorkspaces
    : compiled?.ok ? compiled.transaction.workspaces : workspaces;
  const showBefore = (showCurrent && mode === "compare") || (confirmView === "current" && mode === "confirm");
  const previewWorkspaces = showBefore ? previewCurrent : previewAfter;

  return (
    <OverlayShell
      open={open}
      closing={closing}
      onClose={onClose}
      onEscape={() => {
        if (destinationOpen || moveOpen) {
          setDestinationOpen(false);
          setMoveOpen(false);
          return true;
        }
        return false;
      }}
      size="full"
      ariaLabel={tabGroupingStrings.panelAriaLabel}
      id="tab-grouping-panel"
    >
      <div className={`cmux-tab-grouping${applying ? " is-applying" : ""}`}>
        <header className="cmux-tab-grouping-header">
          <div>
            <div className="cmux-tab-grouping-title">{tabGroupingStrings.title}</div>
            <div className="cmux-tab-grouping-status" role="status">{status}</div>
          </div>
          <nav className="cmux-tab-grouping-steps" aria-label="手順">
            {([
              ["compare", tabGroupingStrings.stepCompare],
              ["edit", tabGroupingStrings.stepEdit],
              ["confirm", tabGroupingStrings.stepConfirm],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`cmux-tab-grouping-step${mode === id ? " is-active" : ""}`}
                aria-current={mode === id ? "step" : undefined}
                disabled={plans.length === 0 || applying}
                onClick={() => setMode(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <button type="button" className="cmux-tab-grouping-button is-ghost" disabled={applying} onClick={onClose}>{tabGroupingStrings.close}</button>
        </header>

        <div className={`cmux-tab-grouping-body is-${mode}${applying ? " is-locked" : ""}`}>
          {mode === "compare" ? (
            <>
              <div className="cmux-tab-grouping-col">
                {analyzing ? <div className="cmux-tab-grouping-note">{tabGroupingStrings.analyzing}</div> : null}
                {comparisonInsufficient ? <div className="cmux-tab-grouping-note">{tabGroupingStrings.comparisonInsufficient}</div> : null}
                {parseError ? <div className="cmux-tab-grouping-error">{parseError}</div> : null}
                {raw && parseError ? <pre className="cmux-tab-grouping-raw">{raw}</pre> : null}
                {plans.map((plan) => {
                  const stats = planCardStats(editedByPlan[plan.planId] ?? plan, scan?.baseline ?? []);
                  return (
                    <button
                      type="button"
                      key={plan.planId}
                      role="radio"
                      aria-checked={selectedPlanId === plan.planId}
                      className={`cmux-tab-grouping-card${selectedPlanId === plan.planId ? " is-selected" : ""}`}
                      onClick={() => {
                        setSelectedPlanId(plan.planId);
                        setSelectedGroupId((editedByPlan[plan.planId] ?? plan).groups[0]?.groupId ?? null);
                        setSelectedTabIds(new Set());
                        setMoveOpen(false);
                        setDestinationOpen(false);
                      }}
                    >
                      <div className="cmux-tab-grouping-card-title">{plan.title}</div>
                      <div>{plan.rationale}</div>
                      <div className="cmux-tab-grouping-meta">
                        <span>{strategyLabel(plan.strategy)}</span>
                        <span>{tabGroupingStrings.movedCount(stats.moved)}</span>
                        <span>{tabGroupingStrings.newWorkspaceCount(stats.newWorkspaces)}</span>
                        <span>{tabGroupingStrings.keptCount(stats.kept)}</span>
                        <span>{tabGroupingStrings.warningCount(stats.warnings)}</span>
                      </div>
                      {(editedByPlan[plan.planId] ?? plan).warnings.length > 0 ? (
                        <ul className="cmux-tab-grouping-note">
                          {(editedByPlan[plan.planId] ?? plan).warnings.map((warning, index) => (
                            <li key={`${plan.planId}-${warning.code}-${index}`}>
                              {warning.code}: {warning.message} ({warning.tabIds.join(", ")})
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <div className="cmux-tab-grouping-col">
                <div className="cmux-tab-grouping-actions">
                  <button type="button" className="cmux-tab-grouping-button" onClick={() => setShowCurrent((value) => !value)}>
                    {showCurrent ? tabGroupingStrings.showAfter : tabGroupingStrings.showCurrent}
                  </button>
                </div>
                {edited ? (
                  <PreviewWorkspaces
                    workspaces={previewWorkspaces}
                    current={previewCurrent}
                    plan={edited}
                    view={showCurrent ? "current" : "after"}
                    highlightMoved={highlightMoved}
                  />
                ) : null}
              </div>
            </>
          ) : null}

          {mode === "edit" && edited && selectedPlanId ? (
            <>
              <div className="cmux-tab-grouping-col">
                {edited.groups.map((group) => (
                  <div
                    key={group.groupId}
                    className={`cmux-tab-grouping-group${selectedGroup?.groupId === group.groupId ? " is-selected" : ""}${group.adopted ? "" : " is-deferred"}${editErrors.some((error) => error.includes(group.title) || error.includes(group.groupId)) ? " is-error" : ""}`}
                    onClick={() => setSelectedGroupId(group.groupId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") setSelectedGroupId(group.groupId);
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="cmux-tab-grouping-group-title">{group.title}</div>
                    <div className="cmux-tab-grouping-meta">
                      <span>{group.adopted ? tabGroupingStrings.adopt : tabGroupingStrings.defer}</span>
                      <span>{group.tabIds.length}タブ</span>
                    </div>
                    <div className="cmux-tab-grouping-actions">
                      <button
                        type="button"
                        className="cmux-tab-grouping-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          updateEdited(selectedPlanId, setGroupAdopted(edited, group.groupId, !group.adopted));
                        }}
                      >
                        {group.adopted ? tabGroupingStrings.defer : tabGroupingStrings.adopt}
                      </button>
                    </div>
                    {!group.adopted ? <div className="cmux-tab-grouping-note">{tabGroupingStrings.deferredHint}</div> : null}
                  </div>
                ))}
                <div className="cmux-tab-grouping-group">
                  <div className="cmux-tab-grouping-group-title">{tabGroupingStrings.unassignedTitle}</div>
                  {edited.unassignedTabIds.map((tabId) => {
                    const tab = scan?.tabs.find((item) => item.id === tabId);
                    return (
                      <button
                        type="button"
                        key={tabId}
                        aria-pressed={selectedTabIds.has(tabId)}
                        className={`cmux-tab-grouping-chip is-unassigned${selectedTabIds.has(tabId) ? " is-selected" : ""}`}
                        onClick={() => setSelectedTabIds((current) => {
                          const next = new Set(current);
                          if (next.has(tabId)) next.delete(tabId);
                          else next.add(tabId);
                          return next;
                        })}
                      >
                        {tabName(tab?.label)}
                      </button>
                    );
                  })}
                </div>
                {editErrors.map((error) => <div key={error} className="cmux-tab-grouping-error">{error}</div>)}
                {stale.map((issue) => <div key={`${issue.code}-${issue.tabId ?? issue.workspaceId}`} className="cmux-tab-grouping-error">{issue.message}</div>)}
                {applyErrors.map((error) => <div key={error} className="cmux-tab-grouping-error">{error}</div>)}
              </div>
              <div className="cmux-tab-grouping-col">
                {selectedGroup ? (
                  <>
                    <div className="cmux-tab-grouping-actions">
                      <span>
                        {(() => {
                          const destination = selectedGroup.destination;
                          if (destination.kind === "new_workspace") return destination.proposedName;
                          if (destination.kind === "existing_workspace") {
                            return workspaces.find((item) => item.id === destination.workspaceId)?.name ?? destination.workspaceId;
                          }
                          return tabGroupingStrings.destinationCurrent;
                        })()}
                      </span>
                      <button type="button" className="cmux-tab-grouping-button" onClick={() => setDestinationOpen((value) => !value)}>
                        {tabGroupingStrings.changeDestination}
                      </button>
                    </div>
                    {destinationOpen ? (
                      <div className="cmux-tab-grouping-popover">
                        {([
                          { kind: "current_locations" } satisfies GroupingDestination,
                          ...workspaces.map((item) => ({ kind: "existing_workspace", workspaceId: item.id }) as GroupingDestination),
                          { kind: "new_workspace", proposedName: selectedGroup.title } satisfies GroupingDestination,
                        ]).map((destination) => (
                          <button
                            type="button"
                            key={JSON.stringify(destination)}
                            className="cmux-tab-grouping-button"
                            onClick={() => {
                              updateEdited(selectedPlanId, setGroupDestination(edited, selectedGroup.groupId, destination));
                              setDestinationOpen(false);
                            }}
                          >
                            {destination.kind === "current_locations"
                              ? tabGroupingStrings.destinationCurrent
                              : destination.kind === "new_workspace"
                                ? tabGroupingStrings.destinationNew
                                : workspaces.find((item) => item.id === destination.workspaceId)?.name ?? destination.workspaceId}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {(selectedGroup.layout?.columns ?? [{ panes: [{ title: selectedGroup.title, role: "unspecified" as const, tabIds: selectedGroup.tabIds }] }]).map((column, columnIndex) => (
                      <div key={columnIndex} className="cmux-tab-grouping-pane">
                        {column.panes.map((pane) => (
                          <div key={pane.title}>
                            <div className="cmux-tab-grouping-note">{pane.title}</div>
                            {pane.tabIds.map((tabId) => {
                              const tab = scan?.tabs.find((item) => item.id === tabId);
                              return (
                                <button
                                  type="button"
                                  key={tabId}
                                  className={`cmux-tab-grouping-chip${selectedTabIds.has(tabId) ? " is-selected" : ""}`}
                                  onClick={() => setSelectedTabIds((current) => {
                                    const next = new Set(current);
                                    if (next.has(tabId)) next.delete(tabId);
                                    else next.add(tabId);
                                    return next;
                                  })}
                                >
                                  {tabName(tab?.label)}
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    ))}
                    {selectedTabIds.size > 0 ? (
                      <div className="cmux-tab-grouping-selectbar">
                        <span>{tabGroupingStrings.selectedTabs(selectedTabIds.size)}</span>
                        <button type="button" className="cmux-tab-grouping-button" aria-haspopup="dialog" aria-expanded={moveOpen} onClick={() => setMoveOpen((value) => !value)}>
                          {tabGroupingStrings.moveSelected}
                        </button>
                        {moveOpen ? (
                          <div className="cmux-tab-grouping-popover" role="dialog" aria-label={tabGroupingStrings.moveSelected}>
                            {edited.groups.flatMap((group) => {
                              const paneTitles = group.layout?.columns.flatMap((column) => column.panes.map((pane) => pane.title)) ?? [group.title];
                              return paneTitles.map((paneTitle) => (
                                <button
                                  type="button"
                                  key={`${group.groupId}-${paneTitle}`}
                                  className="cmux-tab-grouping-button"
                                  onClick={() => {
                                    updateEdited(selectedPlanId, reassignTabs(edited, [...selectedTabIds], { kind: "group", groupId: group.groupId, paneTitle }));
                                    setSelectedTabIds(new Set());
                                    setMoveOpen(false);
                                  }}
                                >
                                  {group.title} / {paneTitle}
                                </button>
                              ));
                            })}
                            <button
                              type="button"
                              className="cmux-tab-grouping-button"
                              onClick={() => {
                                updateEdited(selectedPlanId, reassignTabs(edited, [...selectedTabIds], { kind: "unassigned" }));
                                setSelectedTabIds(new Set());
                                setMoveOpen(false);
                              }}
                            >
                              {tabGroupingStrings.moveToUnassigned}
                            </button>
                            <button
                              type="button"
                              className="cmux-tab-grouping-button"
                              onClick={() => {
                                const withGroup = addGroup(edited, "新しいグループ");
                                const created = withGroup.groups[withGroup.groups.length - 1];
                                updateEdited(
                                  selectedPlanId,
                                  reassignTabs(withGroup, [...selectedTabIds], { kind: "group", groupId: created.groupId }),
                                );
                                setSelectedTabIds(new Set());
                                setMoveOpen(false);
                              }}
                            >
                              {tabGroupingStrings.newGroup}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </>
          ) : null}

          {mode === "confirm" && edited ? (
            <div className="cmux-tab-grouping-col">
              <div className="cmux-tab-grouping-actions">
                {(["diff", "after", "current"] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`cmux-tab-grouping-button${confirmView === id ? " is-primary" : ""}`}
                    aria-pressed={confirmView === id}
                    onClick={() => setConfirmView(id)}
                  >
                    {id === "diff" ? tabGroupingStrings.confirmDiff : id === "after" ? tabGroupingStrings.confirmAfter : tabGroupingStrings.confirmCurrent}
                  </button>
                ))}
              </div>
              {compiled && !compiled.ok ? (
                <div className="cmux-tab-grouping-error">
                  {compiled.stale.length > 0 ? tabGroupingStrings.applyBlocked : compiled.errors.join(" / ")}
                  {compiled.stale.map((issue) => <div key={`${issue.code}-${issue.tabId ?? issue.workspaceId}`}>{issue.message}</div>)}
                </div>
              ) : null}
              {compiled?.ok ? (
                <div className="cmux-tab-grouping-meta">
                  <span>{tabGroupingStrings.movedCount(compiled.transaction.expected.movedTabIds.length)}</span>
                  <span>{tabGroupingStrings.keptCount(compiled.transaction.expected.keptTabIds.length)}</span>
                  {compiled.transaction.expected.emptyWorkspaceIds.length > 0 ? (
                    <span>{tabGroupingStrings.emptyWorkspaces(compiled.transaction.expected.emptyWorkspaceIds.length)}</span>
                  ) : null}
                </div>
              ) : null}
              <PreviewWorkspaces
                workspaces={previewWorkspaces}
                current={previewCurrent}
                plan={edited}
                view={confirmView}
                highlightMoved={highlightMoved}
              />
            </div>
          ) : null}
        </div>

        <footer className="cmux-tab-grouping-footer">
          <div className="cmux-tab-grouping-note">
            {formatGroupingAiNote(aiProvider, aiModel, aiEnabled)}
            {editErrors.length > 0 ? ` / ${editErrors.join(" / ")}` : ""}
            {stale.length > 0 ? ` / ${stale.map((issue) => issue.message).join(" / ")}` : ""}
            {applyErrors.length > 0 ? ` / ${applyErrors.join(" / ")}` : ""}
          </div>
          <div className="cmux-tab-grouping-actions">
            <button type="button" className="cmux-tab-grouping-button" disabled={analyzing || applying} onClick={() => void analyze()}>
              {tabGroupingStrings.analyzeAgain}
            </button>
            {undo?.hidden ? (
              <button type="button" className="cmux-tab-grouping-button" onClick={() => recallGroupingUndo()}>
                {tabGroupingStrings.recallUndo}
              </button>
            ) : null}
            <button
              type="button"
              className="cmux-tab-grouping-button is-primary"
              disabled={!edited || analyzing || applying || Boolean(applied) || plans.length === 0 || Boolean(parseError) || editErrors.length > 0 || Boolean(compiled && !compiled.ok) || (compiled?.ok === true && compiled.transaction.expected.movedTabIds.length === 0)}
              onClick={() => {
                if (mode !== "confirm") {
                  setMode("confirm");
                  return;
                }
                apply();
              }}
            >
              {mode === "confirm" ? tabGroupingStrings.apply : tabGroupingStrings.stepConfirm}
            </button>
          </div>
        </footer>
        {undo && !undo.hidden ? (
          <div className="cmux-tab-grouping-undo" data-undo-revision={undoRevision}>
            <span>{undo.expired ? (undo.expireReason ?? tabGroupingStrings.undoExpired) : tabGroupingStrings.undoApplied(undo.report.moved.length)}</span>
            {undo.report.emptyWorkspaceIds.length > 0 ? (
              <span>{tabGroupingStrings.emptyWorkspaces(undo.report.emptyWorkspaceIds.length)} {tabGroupingStrings.notDeleted}</span>
            ) : null}
            <div className="cmux-tab-grouping-actions">
              <button type="button" className="cmux-tab-grouping-button" disabled={undo.expired} onClick={() => restoreGroupingUndo()}>
                {tabGroupingStrings.undo}
              </button>
              <button type="button" className="cmux-tab-grouping-button" onClick={() => { setReviewApplied(true); setMode("confirm"); }}>
                {tabGroupingStrings.undoReview}
              </button>
              <button type="button" className="cmux-tab-grouping-button is-ghost" onClick={() => dismissGroupingUndo()}>×</button>
            </div>
          </div>
        ) : null}
      </div>
    </OverlayShell>
  );
}

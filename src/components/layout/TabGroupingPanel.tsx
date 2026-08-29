import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { OverlayShell } from "../common/OverlayShell";
import { tabGroupingStrings } from "../dashboard/dashboardStrings";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import { useGroupingRuntimeStore } from "../../stores/groupingRuntimeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { layoutStructureRevision } from "../../lib/layoutMutation";
import {
  generateForegroundGroupingAnalysis,
  markGroupingInterest,
  peekGroupingPrecompute,
  requestGroupingPrecomputeRefresh,
} from "../../lib/groupingPrecompute";
import { attentionCategory, useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import type { Pane, PaneTab, Workspace } from "../../types";
import { formatJudgeError, formatLastOutputAgeCompact } from "./tabSweep";
import {
  choosePetForNewWorkspace,
  clonePlanForEdit,
  findTabLocation,
  formatGroupingAiNote,
  planCardStats,
  previewKindForTab,
  TAB_GROUPING_NAME_MAX,
  validateEditedPlan,
  type GroupingPlan,
  type GroupingAnalysisResult,
  type GroupingAnalysisStage,
  type GroupingDestination,
  type GroupingScan,
  type LayoutTransaction,
  type ParseGroupingResult,
  type StaleIssue,
  type TabPreviewKind,
} from "./tabGrouping";
import {
  applyEditCommand,
  beginGroupingEdit,
  canUndoGroupingEdit,
  isGroupingEditDirty,
  paneRefKey,
  resetGroupingEditToAi,
  undoGroupingEdit,
  type EditCommand,
  type GroupingEditSession,
  type GroupingEditTarget,
  type GroupingPaneRef,
} from "./groupingEdit";
import { groupingBoundary } from "./groupingBoundary";
import {
  groupingMoveLineColor,
  groupingMoveLineDrawPaths,
  groupingMeasuredMoveLines,
  groupingMoveDiffs,
  groupingMoveLines,
  groupingRelativeRect,
  groupingSideBySideOrientation,
  groupingWithinWorkspaceMoveLines,
  type GroupingLineRect,
  type MeasuredGroupingMoveLine,
} from "./groupingMoveLines";
import {
  sampleGroupingApplyPath,
  startGroupingApplyAnimation,
  type GroupingApplyAnimationCallbacks,
  type GroupingApplyAnimationController,
  type GroupingApplyAnimationPoint,
  type GroupingApplyAnimationStarter,
} from "./groupingApplyAnimation";
import { requestGroupingLandingFlight } from "./GroupingFlightHost";
import { groupingExitTangent } from "./groupingLandingFlight";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import {
  groupingLineageNodes,
  groupingTabLocations,
  type GroupingLineageNode,
} from "./groupingLineage";
import { GroupingLiveChipBadge, useGroupingLiveInfo } from "./GroupingLiveChip";
import { acquireGroupingPanelOpen } from "./groupingPanelPresence";
import { groupingDropIdForTarget, resolveGroupingDropTarget } from "./groupingDrag";
import { useGroupingDrag } from "../../hooks/useGroupingDrag";
import "./TabGroupingPanel.css";

export type GroupingStepId = "compare" | "edit" | "confirm";
export type GroupingStepState = "current" | "done" | "todo" | "locked";
type GroupingMode = GroupingStepId;
type GroupingAnalysisFreshness = "fresh" | "soft-stale";
type ConfirmView = "side-by-side" | "current" | "after" | "diff";
type GroupingNameEditTarget =
  | { kind: "group"; groupId: string }
  | { kind: "workspace"; groupId: string }
  | { kind: "pane"; pane: GroupingPaneRef };
type GroupingPrepareResult = ReturnType<typeof groupingBoundary.prepare>;
type GroupingPrepareFailure = Extract<GroupingPrepareResult, { ok: false }>;
type GroupingPreviewResult = ReturnType<typeof groupingBoundary.preview>;
type GroupingPreviewFailure = Extract<GroupingPreviewResult, { ok: false }>;
type GroupingCommitFailure = Extract<ReturnType<typeof groupingBoundary.commit>["commit"], { ok: false }>;
type GroupingUndoFailure = Extract<ReturnType<typeof groupingBoundary.undo>, { ok: false }>;
type GroupingTicket = Extract<GroupingPrepareResult, { ok: true }>["ticket"];
type GroupingCommitAttempt =
  | { kind: "result"; result: ReturnType<typeof groupingBoundary.commit> }
  | { kind: "throw"; error: unknown };

const GROUPING_STEPS: readonly GroupingStepId[] = ["compare", "edit", "confirm"];

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (
    typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  ));
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}
const GROUPING_LIVE_CLOCK_MS = 30_000;
const groupingLiveClockListeners = new Set<() => void>();
let groupingLiveClockNow = Date.now();
let groupingLiveClockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeGroupingLiveClock(listener: () => void): () => void {
  if (groupingLiveClockListeners.size === 0) groupingLiveClockNow = Date.now();
  groupingLiveClockListeners.add(listener);
  if (groupingLiveClockTimer === null) {
    groupingLiveClockTimer = setInterval(() => {
      groupingLiveClockNow = Date.now();
      for (const notify of groupingLiveClockListeners) notify();
    }, GROUPING_LIVE_CLOCK_MS);
  }
  return () => {
    groupingLiveClockListeners.delete(listener);
    if (groupingLiveClockListeners.size === 0 && groupingLiveClockTimer !== null) {
      clearInterval(groupingLiveClockTimer);
      groupingLiveClockTimer = null;
    }
  };
}

const GroupingLiveClockBadge = memo(function GroupingLiveClockBadge({
  sessionId,
  declared,
  attentionCategory,
  tabAgentKind,
}: {
  sessionId: string;
  declared: boolean;
  attentionCategory: "waiting" | "error" | "done" | null | undefined;
  tabAgentKind: string | null;
}) {
  const live = useGroupingLiveInfo(sessionId, { declared, attentionCategory, tabAgentKind });
  useSyncExternalStore(
    subscribeGroupingLiveClock,
    () => formatLastOutputAgeCompact(live.lastOutputAt, groupingLiveClockNow),
    () => formatLastOutputAgeCompact(live.lastOutputAt, groupingLiveClockNow),
  );
  return (
    <GroupingLiveChipBadge
      sessionId={sessionId}
      declared={declared}
      attentionCategory={attentionCategory}
      tabAgentKind={tabAgentKind}
      now={groupingLiveClockNow}
    />
  );
});

export const GROUPING_STRATEGY_ORDER = ["project", "role", "minimal_move", "mixed"] as const;

export function groupingStepStates(input: {
  mode: GroupingStepId;
  hasPlans: boolean;
  analyzing: boolean;
  applying: boolean;
  applied: boolean;
}): Record<GroupingStepId, GroupingStepState> {
  if (!input.hasPlans || input.analyzing || input.applying || input.applied) {
    return { compare: "locked", edit: "locked", confirm: "locked" };
  }
  const currentIndex = GROUPING_STEPS.indexOf(input.mode);
  return Object.fromEntries(GROUPING_STEPS.map((step, index) => [
    step,
    index === currentIndex ? "current" : index < currentIndex ? "done" : "todo",
  ])) as Record<GroupingStepId, GroupingStepState>;
}

export function nextGroupingStep(mode: GroupingStepId): GroupingStepId | null {
  const index = GROUPING_STEPS.indexOf(mode);
  return GROUPING_STEPS[index + 1] ?? null;
}

export function previousGroupingStep(mode: GroupingStepId): GroupingStepId | null {
  const index = GROUPING_STEPS.indexOf(mode);
  return index > 0 ? GROUPING_STEPS[index - 1] : null;
}

export function orderGroupingPlansForDisplay(plans: readonly GroupingPlan[]): GroupingPlan[] {
  const order = new Map(GROUPING_STRATEGY_ORDER.map((strategy, index) => [strategy, index]));
  return plans.map((plan, sourceIndex) => ({ plan, sourceIndex }))
    .sort((a, b) => (order.get(a.plan.strategy) ?? GROUPING_STRATEGY_ORDER.length)
      - (order.get(b.plan.strategy) ?? GROUPING_STRATEGY_ORDER.length)
      || a.sourceIndex - b.sourceIndex)
    .map(({ plan }) => plan);
}

export function groupingChangedWorkspaceIds(
  before: readonly Workspace[],
  after: readonly Workspace[],
): Set<string> {
  const beforeById = new Map(before.map((workspace) => [workspace.id, workspace]));
  const tabSequence = (workspace: Workspace) => workspace.panes
    .flatMap((pane) => pane.tabs.map((tab) => tab.id))
    .join("\0");
  return new Set(after.flatMap((workspace) => {
    const current = beforeById.get(workspace.id);
    return !current || tabSequence(current) !== tabSequence(workspace) ? [workspace.id] : [];
  }));
}

export function groupingEditDropTargets(
  plan: GroupingPlan | null,
  after: readonly Workspace[],
  stashedLayouts: GroupingEditSession["stashedLayouts"] = {},
): Map<string, Exclude<GroupingEditTarget, { kind: "unassigned" }>> {
  const targets = new Map<string, Exclude<GroupingEditTarget, { kind: "unassigned" }>>();
  if (!plan) return targets;
  for (const group of plan.groups) {
    if (
      group.layout === null
      && group.tabIds.length === 0
      && stashedLayouts[group.groupId] !== undefined
    ) {
      const target = { kind: "group" as const, groupId: group.groupId };
      targets.set(groupingDropIdForTarget(target), target);
      continue;
    }
    if (!group.adopted
      || group.disposition !== "reorganize"
      || !group.layout
      || group.destination.kind === "current_locations") continue;
    group.layout.columns.forEach((column, columnIndex) => {
      column.panes.forEach((pane, paneIndex) => {
        const firstTabId = pane.tabIds[0];
        if (!firstTabId) return;
        const projectedPane = after.flatMap((workspace) => workspace.panes)
          .find((candidate) => candidate.tabs.some((tab) => tab.id === firstTabId));
        if (!projectedPane || targets.has(projectedPane.id)) return;
        targets.set(projectedPane.id, {
          kind: "pane",
          groupId: group.groupId,
          columnIndex,
          paneIndex,
        });
      });
    });
  }
  return targets;
}

function groupingDropIdFromClick(event: ReactMouseEvent<HTMLElement>): string | null {
  const target = event.target;
  if (!(target instanceof Element)
    || target.closest("[data-tab-id], [data-grouping-drop-control]")) return null;
  const dropTarget = target.closest<HTMLElement>("[data-drop-id]");
  return dropTarget === event.currentTarget ? dropTarget.dataset.dropId ?? null : null;
}

const GROUPING_COMMIT_FAILURE_MESSAGES = {
  preview_stale: tabGroupingStrings.applyBlocked,
  plan_changed: tabGroupingStrings.applyPlanChanged,
  invalid_input: tabGroupingStrings.applyInvalidInput,
  commit_mismatch: tabGroupingStrings.applyMismatch,
  rollback_failed: tabGroupingStrings.statusPoisoned,
  boundary_poisoned: tabGroupingStrings.statusPoisoned,
  schema_incompatible: tabGroupingStrings.applySchemaIncompatible,
  operation_in_progress: tabGroupingStrings.applyOperationInProgress,
} satisfies Record<GroupingCommitFailure["kind"], string>;

const GROUPING_PREPARE_FAILURE_MESSAGES = {
  schema_incompatible: tabGroupingStrings.applySchemaIncompatible,
  boundary_poisoned: tabGroupingStrings.statusPoisoned,
  operation_in_progress: tabGroupingStrings.applyOperationInProgress,
  unexpected_error: tabGroupingStrings.prepareFailed,
} satisfies Record<NonNullable<GroupingPrepareFailure["kind"]>, string>;

const GROUPING_UNDO_FAILURE_MESSAGES = {
  missing: tabGroupingStrings.undoMissing,
  expired: tabGroupingStrings.undoExpired,
  restore_failed: tabGroupingStrings.undoRestoreFailed,
  boundary_poisoned: tabGroupingStrings.statusPoisoned,
  schema_incompatible: tabGroupingStrings.applySchemaIncompatible,
  operation_in_progress: tabGroupingStrings.applyOperationInProgress,
  invalid_layout: tabGroupingStrings.undoRestoreFailed,
  unexpected_error: tabGroupingStrings.undoRestoreFailed,
  post_undo_failed: tabGroupingStrings.undoPostFailed,
} satisfies Record<GroupingUndoFailure["kind"], string>;

export function shouldInvalidateGroupingTicket(input: {
  preparedLayoutRevision: number | null;
  currentLayoutRevision: number;
  applying: boolean;
  applied: boolean;
}): boolean {
  if (input.preparedLayoutRevision === null || input.applying || input.applied) return false;
  return input.currentLayoutRevision !== input.preparedLayoutRevision;
}

export function groupingCommitFailureMessage(failure: GroupingCommitFailure): string {
  return GROUPING_COMMIT_FAILURE_MESSAGES[failure.kind];
}

export function groupingPrepareFailureMessage(failure: GroupingPrepareFailure): string {
  if (failure.kind === undefined) return failure.errors[0] || tabGroupingStrings.prepareFailed;
  return GROUPING_PREPARE_FAILURE_MESSAGES[failure.kind];
}

export function groupingPreviewFailureMessage(failure: GroupingPreviewFailure): string {
  if ("kind" in failure) return GROUPING_PREPARE_FAILURE_MESSAGES[failure.kind];
  return failure.errors.join(" / ") || tabGroupingStrings.prepareFailed;
}

export function groupingUndoFailureMessage(failure: GroupingUndoFailure): string {
  if (failure.kind === "expired" && failure.reason) return failure.reason;
  return GROUPING_UNDO_FAILURE_MESSAGES[failure.kind];
}

export interface TabGroupingPanelProps {
  open: boolean;
  visible: boolean;
  closing?: boolean;
  intent?: "review" | null;
  onClose: () => void;
}

function requestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-grouping-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function groupingPreparedTime(generatedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(generatedAt));
}

function groupingPreparedStatus(
  freshness: GroupingAnalysisFreshness,
  generatedAt: number,
): string {
  const time = groupingPreparedTime(generatedAt);
  return freshness === "fresh"
    ? `現在の状態・${time}に準備済み`
    : `${time}時点の案（参考表示）`;
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

function handleMenuKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  close: () => void,
  restoreFocus: () => void,
) {
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  if (items.length === 0) return;
  const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  let target: HTMLButtonElement | undefined;
  if (event.key === "ArrowDown") target = items[(activeIndex + 1 + items.length) % items.length];
  if (event.key === "ArrowUp") target = items[(activeIndex - 1 + items.length) % items.length];
  if (event.key === "Home") target = items[0];
  if (event.key === "End") target = items[items.length - 1];
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    restoreFocus();
    return;
  }
  if (!target) return;
  event.preventDefault();
  target.focus();
}

function rectsEqual(left: GroupingLineRect | null, right: GroupingLineRect | null): boolean {
  if (left === right) return true;
  return Boolean(left && right
    && left.left === right.left
    && left.top === right.top
    && left.width === right.width
    && left.height === right.height);
}

function measuredLinesEqual(left: MeasuredGroupingMoveLine[], right: MeasuredGroupingMoveLine[]): boolean {
  return left.length === right.length && left.every((line, index) => {
    const other = right[index];
    return line.tabId === other.tabId
      && line.fromWorkspaceId === other.fromWorkspaceId
      && line.toWorkspaceId === other.toWorkspaceId
      && rectsEqual(line.fromRect, other.fromRect)
      && rectsEqual(line.toRect, other.toRect)
      && rectsEqual(line.destinationRect, other.destinationRect)
      && rectsEqual(line.leadIn, other.leadIn)
      && JSON.stringify(line.routePoints) === JSON.stringify(other.routePoints);
  });
}

interface GroupingMoveContext {
  fromWorkspaceName: string;
  toWorkspaceName: string;
}

interface GroupingMoveBadge {
  detail: string;
  ariaLabel: string;
}

interface GroupingLineageTree {
  tab: PaneTab;
  node: GroupingLineageNode;
  detached: boolean;
  children: GroupingLineageTree[];
}

function paneLineageTrees(
  pane: Pane,
  lineageByTabId: ReadonlyMap<string, GroupingLineageNode>,
): GroupingLineageTree[] {
  const tabById = new Map(pane.tabs.map((tab) => [tab.id, tab]));
  const visited = new Set<string>();
  const build = (tab: PaneTab): GroupingLineageTree | null => {
    if (visited.has(tab.id)) return null;
    visited.add(tab.id);
    const node = lineageByTabId.get(tab.id) ?? {
      tabId: tab.id,
      parentTabId: null,
      rootTabId: tab.id,
      depth: 0,
      childTabIds: [],
      orphan: false,
      cycleBroken: false,
    };
    const children = node.childTabIds.flatMap((childTabId) => {
      const child = tabById.get(childTabId);
      if (!child || lineageByTabId.get(childTabId)?.cycleBroken) return [];
      const tree = build(child);
      return tree ? [tree] : [];
    });
    return {
      tab,
      node,
      detached: Boolean(node.parentTabId && !tabById.has(node.parentTabId)),
      children,
    };
  };
  const roots = pane.tabs.filter((tab) => {
    const node = lineageByTabId.get(tab.id);
    return !node?.parentTabId || !tabById.has(node.parentTabId) || node.cycleBroken;
  });
  const trees = roots.flatMap((tab) => {
    const tree = build(tab);
    return tree ? [tree] : [];
  });
  for (const tab of pane.tabs) {
    const tree = build(tab);
    if (tree) trees.push(tree);
  }
  return trees;
}

function flattenLineageTrees(trees: readonly GroupingLineageTree[]): GroupingLineageTree[] {
  return trees.flatMap((tree) => [tree, ...flattenLineageTrees(tree.children)]);
}

function groupingStateLabel(kind: TabPreviewKind): string | null {
  if (kind === "moved") return tabGroupingStrings.stateMoved;
  if (kind === "kept") return tabGroupingStrings.stateKept;
  if (kind === "unassigned") return tabGroupingStrings.stateUnassigned;
  return null;
}

function LineagePaneTabs({
  trees,
  workspace,
  pane,
  current,
  plan,
  view,
  highlightMoved,
  selectedTabIds,
  onToggleTab,
  onTabPointerDown,
  showState,
  side,
  registerChip,
  onChipHover,
  onChipFocus,
  focusedTabIds,
  pinnedTabIds,
  movedTabIds,
  moveContexts,
  moveBadges,
  onChipActivate,
  tabLocations,
  workspaceNames,
  attentionCategoryByTabId,
  activeRovingKey,
  onRovingKeyDown,
  onRovingFocus,
}: {
  trees: readonly GroupingLineageTree[];
  workspace: Workspace;
  pane: Pane;
  current: Workspace[];
  plan: GroupingPlan | null;
  view: ConfirmView;
  highlightMoved: boolean;
  selectedTabIds?: ReadonlySet<string>;
  onToggleTab?: (tabId: string) => void;
  onTabPointerDown?: (event: ReactPointerEvent<HTMLElement>, tabId: string) => void;
  showState?: boolean;
  side?: "before" | "after";
  registerChip?: (key: string, element: HTMLElement | null) => void;
  onChipHover?: (tabId: string | null) => void;
  onChipFocus?: (tabId: string | null) => void;
  focusedTabIds?: ReadonlySet<string>;
  pinnedTabIds?: ReadonlySet<string>;
  movedTabIds?: ReadonlySet<string>;
  moveContexts?: ReadonlyMap<string, GroupingMoveContext>;
  moveBadges?: ReadonlyMap<string, GroupingMoveBadge>;
  onChipActivate?: (tabId: string) => void;
  tabLocations: ReturnType<typeof groupingTabLocations>;
  workspaceNames: ReadonlyMap<string, string>;
  attentionCategoryByTabId: Readonly<Record<string, "waiting" | "error" | "done" | null | undefined>>;
  activeRovingKey: string | null;
  onRovingKeyDown: (event: ReactKeyboardEvent<HTMLElement>, key: string) => void;
  onRovingFocus: (key: string) => void;
}) {
  const renderTree = (tree: GroupingLineageTree) => {
    const { tab, node } = tree;
    const kind: TabPreviewKind = movedTabIds
      ? (movedTabIds.has(tab.id) ? "moved" : "untouched")
      : plan ? previewKindForTab(plan, tab.id) : "untouched";
    const from = view === "diff" ? findTabLocation(current, tab.id) : null;
    const selected = selectedTabIds?.has(tab.id) ?? false;
    const lineFocused = focusedTabIds?.has(tab.id) ?? false;
    const linePinned = pinnedTabIds?.has(tab.id) ?? false;
    const moveContext = moveContexts?.get(tab.id);
    const moveBadge = moveBadges?.get(tab.id);
    const moveDescription = side && kind === "moved" && moveContext
      ? tabGroupingStrings.sideBySideMoveAriaDescription(
        moveContext.fromWorkspaceName,
        moveContext.toWorkspaceName,
      )
      : null;
    const parentLocation = tree.detached && node.parentTabId
      ? tabLocations.get(node.parentTabId)
      : undefined;
    const parentWorkspaceName = parentLocation && parentLocation.workspaceId !== workspace.id
      ? workspaceNames.get(parentLocation.workspaceId) ?? parentLocation.workspaceId
      : null;
    const parentName = parentLocation ? tabName(parentLocation.label) : null;
    const className = `cmux-tab-grouping-chip is-${kind}${selected ? " is-selected" : ""}${highlightMoved && kind === "moved" ? " is-highlight" : ""}${lineFocused ? " is-line-focused" : ""}${linePinned ? " is-line-pinned" : ""}`;
    const rovingTarget = side && kind === "moved" ? `tab:${tab.id}` : null;
    const stateLabel = showState ? groupingStateLabel(kind) : null;
    const body = (
      <>
        <GroupingLiveClockBadge
          sessionId={tab.sessionId}
          declared={tab.lifecycle === "declared"}
          attentionCategory={attentionCategoryByTabId[tab.id]}
          tabAgentKind={tab.agentKind ?? null}
        />
        <span>{tabName(tab.label)}</span>
        {parentLocation && parentName ? (
          <span
            className="cmux-tab-grouping-from"
            role="img"
            aria-label={tabGroupingStrings.liveParentRefAriaLabel(parentName, parentWorkspaceName)}
          >
            {tabGroupingStrings.liveParentRef(parentName, parentWorkspaceName)}
          </span>
        ) : null}
        {from && (from.workspaceId !== workspace.id || from.paneId !== pane.id) ? (
          <span className="cmux-tab-grouping-from">
            {current.find((item) => item.id === from.workspaceId)?.name ?? from.workspaceId}
          </span>
        ) : null}
        {side === "after" && kind === "moved" && moveContext ? (
          <span className="cmux-tab-grouping-movectx" aria-hidden="true">
            {moveContext.fromWorkspaceName} → {moveContext.toWorkspaceName}
          </span>
        ) : null}
        {side === "after" && kind === "moved" && moveBadge ? (
          <span className="cmux-tab-grouping-movebadge" aria-label={moveBadge.ariaLabel}>
            {moveBadge.detail}
          </span>
        ) : null}
        {stateLabel ? <span className="cmux-tab-grouping-state" data-state={kind}>{stateLabel}</span> : null}
      </>
    );
    const chip = onToggleTab && !(showState && kind === "untouched") ? (
      <button
        type="button"
        className={className}
        data-tab-id={tab.id}
        aria-pressed={selected}
        onPointerDown={onTabPointerDown ? (event) => onTabPointerDown(event, tab.id) : undefined}
        onClick={(event) => {
          if (onTabPointerDown && event.detail !== 0) return;
          onToggleTab(tab.id);
        }}
      >
        {onTabPointerDown ? <span className="cmux-tab-grouping-grip" aria-hidden="true" /> : null}
        {body}
      </button>
    ) : (
      <div
        className={className}
        data-tab-id={tab.id}
        data-grouping-side={side}
        ref={side ? (element) => registerChip?.(`${side}:${tab.id}`, element) : undefined}
        tabIndex={rovingTarget ? (activeRovingKey === rovingTarget ? 0 : -1) : undefined}
        role={rovingTarget ? "button" : undefined}
        aria-pressed={rovingTarget ? linePinned : undefined}
        aria-description={moveDescription ?? undefined}
        onMouseEnter={rovingTarget ? () => onChipHover?.(tab.id) : undefined}
        onMouseLeave={rovingTarget ? () => onChipHover?.(null) : undefined}
        onClick={rovingTarget ? () => onChipActivate?.(tab.id) : undefined}
        onFocus={rovingTarget ? () => {
          onRovingFocus(rovingTarget);
          onChipFocus?.(tab.id);
        } : undefined}
        onBlur={rovingTarget ? () => onChipFocus?.(null) : undefined}
        onKeyDown={rovingTarget ? (event) => onRovingKeyDown(event, rovingTarget) : undefined}
      >
        {body}
      </div>
    );
    return (
      <li
        key={tab.id}
        className="cmux-tab-grouping-lineage-item"
        data-lineage-depth={node.depth}
        data-lineage-child={tab.origin?.parentTabId ? "true" : undefined}
        data-lineage-detached={tree.detached ? "true" : undefined}
        data-lineage-orphan={node.orphan ? "true" : undefined}
        data-lineage-cycle={node.cycleBroken ? "true" : undefined}
        data-lineage-parent-ref={parentLocation ? node.parentTabId ?? undefined : undefined}
        data-lineage-parent-scope={parentLocation ? (parentLocation.workspaceId === workspace.id ? "pane" : "workspace") : undefined}
      >
        {chip}
        {tree.children.length > 0 ? (
          <ul className="cmux-tab-grouping-lineage" role="list">
            {tree.children.map(renderTree)}
          </ul>
        ) : null}
      </li>
    );
  };
  return <ul className="cmux-tab-grouping-lineage" role="list">{trees.map(renderTree)}</ul>;
}

function PreviewWorkspaces({
  workspaces,
  current,
  plan,
  view,
  highlightMoved,
  selectedTabIds,
  onToggleTab,
  onTabPointerDown,
  showState,
  dropTargets,
  onDropTargetClick,
  renderPaneHeading,
  side,
  registerChip,
  registerWorkspace,
  registerPane,
  registerWorkspaceFocus,
  onChipHover,
  onChipFocus,
  onWorkspaceHover,
  onWorkspaceFocus,
  onWorkspaceEscape,
  focusedTabIds,
  pinnedTabIds,
  movedTabIds,
  destinationColors,
  moveContexts,
  moveBadges,
  pinnedWorkspaceId,
  onChipActivate,
  onWorkspaceActivate,
  attentionCategoryByTabId,
  rovingKey,
  onRovingKeyChange,
  focusRovingTarget,
  onRovingActivate,
}: {
  workspaces: Workspace[];
  current: Workspace[];
  plan: GroupingPlan | null;
  view: ConfirmView;
  highlightMoved: boolean;
  selectedTabIds?: ReadonlySet<string>;
  onToggleTab?: (tabId: string) => void;
  onTabPointerDown?: (event: ReactPointerEvent<HTMLElement>, tabId: string) => void;
  showState?: boolean;
  dropTargets?: ReadonlyMap<string, Exclude<GroupingEditTarget, { kind: "unassigned" }>>;
  onDropTargetClick?: (dropId: string) => void;
  renderPaneHeading?: (target: GroupingPaneRef, title: string) => ReactNode;
  side?: "before" | "after";
  registerChip?: (key: string, element: HTMLElement | null) => void;
  registerWorkspace?: (key: string, element: HTMLElement | null) => void;
  registerPane?: (key: string, element: HTMLElement | null) => void;
  registerWorkspaceFocus?: (key: string, element: HTMLElement | null) => void;
  onChipHover?: (tabId: string | null) => void;
  onChipFocus?: (tabId: string | null) => void;
  onWorkspaceHover?: (workspaceId: string | null) => void;
  onWorkspaceFocus?: (workspaceId: string | null) => void;
  onWorkspaceEscape?: () => boolean | void;
  focusedTabIds?: ReadonlySet<string>;
  pinnedTabIds?: ReadonlySet<string>;
  movedTabIds?: ReadonlySet<string>;
  destinationColors?: ReadonlyMap<string, string>;
  moveContexts?: ReadonlyMap<string, GroupingMoveContext>;
  moveBadges?: ReadonlyMap<string, GroupingMoveBadge>;
  pinnedWorkspaceId?: string | null;
  onChipActivate?: (tabId: string) => void;
  onWorkspaceActivate?: (workspaceId: string) => void;
  attentionCategoryByTabId: Readonly<Record<string, "waiting" | "error" | "done" | null | undefined>>;
  rovingKey?: string | null;
  onRovingKeyChange?: (key: string) => void;
  focusRovingTarget?: (key: string) => void;
  onRovingActivate?: (key: string) => void;
}) {
  const lineageByTabId = useMemo(() => groupingLineageNodes(workspaces), [workspaces]);
  const tabLocations = useMemo(() => groupingTabLocations(workspaces), [workspaces]);
  const workspaceNames = useMemo(() => new Map(
    workspaces.map((workspace) => [workspace.id, workspace.name]),
  ), [workspaces]);
  const treesByPaneId = useMemo(() => new Map(workspaces.flatMap((workspace) => (
    workspace.panes.map((pane) => [pane.id, paneLineageTrees(pane, lineageByTabId)] as const)
  ))), [lineageByTabId, workspaces]);
  const rovingKeys = useMemo(() => side ? workspaces.flatMap((workspace) => {
    const tabKeys = (workspace.splitColumns ?? [workspace.panes.map((pane) => pane.id)]).flatMap((column) => (
      column.flatMap((paneId) => flattenLineageTrees(treesByPaneId.get(paneId) ?? [])
        .filter((tree) => (movedTabIds
          ? (movedTabIds.has(tree.tab.id) ? "moved" : "untouched")
          : plan ? previewKindForTab(plan, tree.tab.id) : "untouched") === "moved")
        .map((tree) => `tab:${tree.tab.id}`))
    ));
    return [`ws:${workspace.id}`, ...tabKeys];
  }) : [], [movedTabIds, plan, side, treesByPaneId, workspaces]);
  const activeRovingKey = rovingKey && rovingKeys.includes(rovingKey) ? rovingKey : rovingKeys[0] ?? null;
  const handleRovingKeyDown = (event: ReactKeyboardEvent<HTMLElement>, key: string) => {
    if (event.key === "Escape") {
      const consumed = onWorkspaceEscape?.();
      if (consumed) {
        event.preventDefault();
        event.stopPropagation();
      }
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRovingActivate?.(key);
      return;
    }
    const currentIndex = rovingKeys.indexOf(key);
    if (currentIndex < 0 || rovingKeys.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1) % rovingKeys.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + rovingKeys.length) % rovingKeys.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = rovingKeys.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextKey = rovingKeys[nextIndex];
    onRovingKeyChange?.(nextKey);
    focusRovingTarget?.(nextKey);
  };
  return (
    <div>
      {workspaces.map((workspace) => {
        const isNew = !current.some((item) => item.id === workspace.id);
        const empty = workspace.panes.every((pane) => pane.tabs.length === 0);
        return (
          <section
            key={workspace.id}
            className={`cmux-tab-grouping-workspace${isNew ? " is-new" : ""}${empty ? " is-empty" : ""}`}
            data-workspace-id={workspace.id}
            ref={side ? (element) => registerWorkspace?.(`${side}:${workspace.id}`, element) : undefined}
          >
            <div
              className="cmux-tab-grouping-workspace-head"
              ref={side ? (element) => registerWorkspaceFocus?.(`${side}:${workspace.id}`, element) : undefined}
              tabIndex={side ? (activeRovingKey === `ws:${workspace.id}` ? 0 : -1) : undefined}
              role={side ? "button" : undefined}
              aria-pressed={side ? pinnedWorkspaceId === workspace.id : undefined}
              onMouseEnter={side ? () => onWorkspaceHover?.(workspace.id) : undefined}
              onMouseLeave={side ? () => onWorkspaceHover?.(null) : undefined}
              onFocus={side ? () => {
                onRovingKeyChange?.(`ws:${workspace.id}`);
                onWorkspaceFocus?.(workspace.id);
              } : undefined}
              onBlur={side ? () => onWorkspaceFocus?.(null) : undefined}
              onClick={side ? () => onWorkspaceActivate?.(workspace.id) : undefined}
              onKeyDown={side ? (event) => handleRovingKeyDown(event, `ws:${workspace.id}`) : undefined}
            >
              {side === "after" ? (
                <span
                  className="cmux-tab-grouping-workspace-color"
                  aria-hidden="true"
                  style={{ backgroundColor: destinationColors?.get(workspace.id) }}
                />
              ) : null}
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
                    const candidateDropTarget = dropTargets?.get(pane.id);
                    const dropTarget = candidateDropTarget?.kind === "pane" ? candidateDropTarget : undefined;
                    const dropId = dropTarget ? groupingDropIdForTarget(dropTarget) : undefined;
                    const planPane = dropTarget
                      ? plan?.groups.find((group) => group.groupId === dropTarget.groupId)
                        ?.layout?.columns[dropTarget.columnIndex]?.panes[dropTarget.paneIndex]
                      : null;
                    return (
                      <div
                        key={pane.id}
                        className={`cmux-tab-grouping-pane${dropTarget ? " is-droppable" : ""}`}
                        data-drop-id={dropId}
                        data-grouping-pane={side ? `${side}:${pane.id}` : undefined}
                        ref={side ? (element) => registerPane?.(`${side}:${pane.id}`, element) : undefined}
                        role={dropTarget ? "button" : undefined}
                        tabIndex={dropTarget ? 0 : undefined}
                        aria-label={dropTarget ? tabGroupingStrings.dropTargetLabel(workspace.name, planPane?.title ?? pane.id) : undefined}
                        onClick={dropTarget ? (event) => {
                          if (groupingDropIdFromClick(event) !== dropId) return;
                          onDropTargetClick?.(dropId);
                        } : undefined}
                        onKeyDown={dropTarget ? (event) => {
                          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                          event.preventDefault();
                          if (!dropId) return;
                          onDropTargetClick?.(dropId);
                        } : undefined}
                      >
                        {dropTarget && planPane && renderPaneHeading
                          ? renderPaneHeading(dropTarget, planPane.title)
                          : null}
                        <LineagePaneTabs
                          trees={treesByPaneId.get(pane.id) ?? []}
                          workspace={workspace}
                          pane={pane}
                          current={current}
                          plan={plan}
                          view={view}
                          highlightMoved={highlightMoved}
                          selectedTabIds={selectedTabIds}
                          onToggleTab={onToggleTab}
                          onTabPointerDown={onTabPointerDown}
                          showState={showState}
                          side={side}
                          registerChip={registerChip}
                          onChipHover={onChipHover}
                          onChipFocus={onChipFocus}
                          focusedTabIds={focusedTabIds}
                          pinnedTabIds={pinnedTabIds}
                          movedTabIds={movedTabIds}
                          moveContexts={moveContexts}
                          moveBadges={moveBadges}
                          onChipActivate={onChipActivate}
                          tabLocations={tabLocations}
                          workspaceNames={workspaceNames}
                          attentionCategoryByTabId={attentionCategoryByTabId}
                          activeRovingKey={activeRovingKey}
                          onRovingKeyDown={handleRovingKeyDown}
                          onRovingFocus={(key) => onRovingKeyChange?.(key)}
                        />
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

const GroupingMoveLineGroup = memo(function GroupingMoveLineGroup({
  line,
  tab,
  attentionCategory,
  active,
  focused,
  pinned,
  color,
  orientation,
}: {
  line: MeasuredGroupingMoveLine;
  tab: PaneTab;
  attentionCategory: "waiting" | "error" | "done" | null | undefined;
  active: boolean;
  focused: boolean;
  pinned: boolean;
  color: string | undefined;
  orientation: ReturnType<typeof groupingSideBySideOrientation>;
}) {
  const live = useGroupingLiveInfo(tab.sessionId, {
    declared: tab.lifecycle === "declared",
    attentionCategory,
    tabAgentKind: tab.agentKind ?? null,
  });
  if (!line.fromRect || !line.toRect) return null;
  const stateClasses = `${active && focused ? " is-focused" : ""}${pinned ? " is-pinned" : ""}${active && !focused ? " is-dimmed" : ""}${live.status === "working" ? " is-live" : ""}`;
  const paths = groupingMoveLineDrawPaths(line, orientation);
  const linePath = paths.mainPath;
  const start = line.routePoints?.[0] ?? (orientation === "horizontal"
    ? { x: line.fromRect.left + line.fromRect.width, y: line.fromRect.top + line.fromRect.height / 2 }
    : { x: line.fromRect.left + line.fromRect.width / 2, y: line.fromRect.top + line.fromRect.height });
  const routeEnd = line.routePoints?.[line.routePoints.length - 1];
  const routeBeforeEnd = line.routePoints?.[line.routePoints.length - 2];
  const end = routeEnd ?? (orientation === "horizontal"
    ? { x: line.destinationRect.left, y: line.destinationRect.top + line.destinationRect.height / 2 }
    : { x: line.destinationRect.left + line.destinationRect.width / 2, y: line.destinationRect.top });
  const direction = routeBeforeEnd
    ? { x: Math.sign(end.x - routeBeforeEnd.x), y: Math.sign(end.y - routeBeforeEnd.y) }
    : orientation === "horizontal" ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const arrowPath = direction.x !== 0
    ? `M ${end.x} ${end.y} L ${end.x - direction.x * 7} ${end.y - 4} L ${end.x - direction.x * 7} ${end.y + 4} Z`
    : `M ${end.x} ${end.y} L ${end.x - 4} ${end.y - direction.y * 7} L ${end.x + 4} ${end.y - direction.y * 7} Z`;
  return (
    <g style={{ "--grouping-line-color": color } as CSSProperties}>
      <path className={`cmux-tab-grouping-line-halo${stateClasses}`} d={linePath} />
      <path
        className={`cmux-tab-grouping-line${stateClasses}`}
        data-tab-id={line.tabId}
        data-from-ws={line.fromWorkspaceId}
        data-to-ws={line.toWorkspaceId}
        data-route-source-lane={line.routePoints
          ? (orientation === "horizontal" ? line.routePoints[1]?.x : line.routePoints[1]?.y)
          : undefined}
        data-route-destination-edge={routeEnd
          ? (orientation === "horizontal"
            ? (routeEnd.x === line.destinationRect.left ? "near" : "far")
            : (routeEnd.y === line.destinationRect.top ? "near" : "far"))
          : undefined}
        d={linePath}
      />
      {paths.leadInPath ? (
        <>
          <path className={`cmux-tab-grouping-line-halo is-leadin${stateClasses}`} d={paths.leadInPath} />
          <path
            className={`cmux-tab-grouping-leadin${stateClasses}`}
            data-tab-id={line.tabId}
            d={paths.leadInPath}
          />
        </>
      ) : null}
      {pinned ? (
        <>
          <circle className="cmux-tab-grouping-line-start" cx={start.x} cy={start.y} r="3" />
          <path className="cmux-tab-grouping-line-arrow" d={arrowPath} />
        </>
      ) : null}
    </g>
  );
});

interface GroupingFlightRenderItem {
  tabId: string;
  label: string;
  width: number;
  height: number;
  sourceCenter: { x: number; y: number };
  destinationCenter: { x: number; y: number };
  pathSegments: readonly string[];
  color: string | undefined;
  sourceElement: HTMLElement;
  destinationElement: HTMLElement;
}

interface GroupingFlightRenderState {
  id: number;
  items: readonly GroupingFlightRenderItem[];
}

interface GroupingLandingDraftItem {
  tabId: string;
  label: string;
  color: string | undefined;
  width: number;
  height: number;
  destinationCenter: { x: number; y: number };
  samples: readonly GroupingApplyAnimationPoint[];
}

/**
 * Frozen at diagram-flight start so a successful commit can hand the proxies
 * over to the resident GroupingFlightHost in viewport coordinates.
 */
interface GroupingLandingDraft {
  items: readonly GroupingLandingDraftItem[];
  container: HTMLElement | null;
}

function GroupingSideBySide({
  before,
  after,
  plan,
  highlightMoved,
  attentionCategoryByTabId,
  onLineFocusChange,
  clearFocusRef,
  applyAnimationEnabled,
  startApplyAnimationRef,
  landingDraftRef,
}: {
  before: Workspace[];
  after: Workspace[];
  plan: GroupingPlan | null;
  highlightMoved: boolean;
  attentionCategoryByTabId: Readonly<Record<string, "waiting" | "error" | "done" | null | undefined>>;
  onLineFocusChange?: (active: boolean) => void;
  clearFocusRef?: MutableRefObject<(() => void) | null>;
  applyAnimationEnabled: boolean;
  startApplyAnimationRef?: MutableRefObject<GroupingApplyAnimationStarter<GroupingCommitAttempt> | null>;
  landingDraftRef?: MutableRefObject<GroupingLandingDraft | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef(new Map<string, HTMLElement>());
  const workspaceRefs = useRef(new Map<string, HTMLElement>());
  const paneRefs = useRef(new Map<string, HTMLElement>());
  const workspaceFocusRefs = useRef(new Map<string, HTMLElement>());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [measured, setMeasured] = useState<MeasuredGroupingMoveLine[]>([]);
  const [flightRender, setFlightRender] = useState<GroupingFlightRenderState | null>(null);
  const flightGenerationRef = useRef(0);
  const flightActiveRef = useRef(false);
  const flightProxyRefs = useRef(new Map<string, HTMLElement>());
  const flightCallbacksRef = useRef<GroupingApplyAnimationCallbacks<GroupingCommitAttempt> | null>(null);
  const flightControllerRef = useRef<GroupingApplyAnimationController | null>(null);
  const [hoverLineFocus, setHoverLineFocus] = useState<{ tabId: string | null; workspaceId: string | null }>(
    { tabId: null, workspaceId: null },
  );
  const [keyboardLineFocus, setKeyboardLineFocus] = useState<{ tabId: string | null; workspaceId: string | null }>(
    { tabId: null, workspaceId: null },
  );
  const [pinnedLineFocus, setPinnedLineFocus] = useState<{ tabId: string | null; workspaceId: string | null }>(
    { tabId: null, workspaceId: null },
  );
  const [rovingKey, setRovingKey] = useState<{ before: string | null; after: string | null }>(
    { before: null, after: null },
  );
  const diffs = useMemo(() => groupingMoveDiffs(before, after), [before, after]);
  const crossWorkspaceLines = useMemo(() => groupingMoveLines(before, after), [before, after]);
  const withinWorkspaceLines = useMemo(() => groupingWithinWorkspaceMoveLines(before, after), [before, after]);
  const lines = useMemo(
    () => [...crossWorkspaceLines, ...withinWorkspaceLines],
    [crossWorkspaceLines, withinWorkspaceLines],
  );
  const lineIds = useMemo(() => new Set(lines.map((line) => line.tabId)), [lines]);
  const movedTabIds = useMemo(() => new Set(diffs.map((diff) => diff.tabId)), [diffs]);
  const tabById = useMemo(() => new Map(
    [...before, ...after].flatMap((workspace) => (
      workspace.panes.flatMap((pane) => pane.tabs.map((tab) => [tab.id, tab] as const))
    )),
  ), [after, before]);
  const destinationColors = useMemo(() => new Map(
    after.map((workspace, index) => [workspace.id, groupingMoveLineColor(after, index)]),
  ), [after]);
  const moveContexts = useMemo(() => new Map(lines.map((line) => [
    line.tabId,
    {
      fromWorkspaceName: before.find((workspace) => workspace.id === line.fromWorkspaceId)?.name ?? line.fromWorkspaceId,
      toWorkspaceName: after.find((workspace) => workspace.id === line.toWorkspaceId)?.name ?? line.toWorkspaceId,
    },
  ])), [after, before, lines]);
  const moveBadges = useMemo(() => new Map(diffs.flatMap((diff) => {
    if (diff.kind !== "within-workspace") return [];
    const fromPane = before.find((workspace) => workspace.id === diff.fromWorkspaceId)
      ?.panes.find((pane) => pane.id === diff.fromPaneId);
    const toPane = after.find((workspace) => workspace.id === diff.toWorkspaceId)
      ?.panes.find((pane) => pane.id === diff.toPaneId);
    const detail = diff.fromColumnIndex !== diff.toColumnIndex
      ? tabGroupingStrings.moveBadgeColumns(diff.fromColumnIndex + 1, diff.toColumnIndex + 1)
      : tabGroupingStrings.moveBadgePanes(
        fromPane?.label?.trim() || diff.fromPaneId,
        toPane?.label?.trim() || diff.toPaneId,
      );
    return [[diff.tabId, {
      detail,
      ariaLabel: tabGroupingStrings.moveBadgeAriaLabel(diff.label, detail),
    }] as const];
  })), [after, before, diffs]);
  const registerChip = useCallback((key: string, element: HTMLElement | null) => {
    if (element) chipRefs.current.set(key, element);
    else chipRefs.current.delete(key);
  }, []);
  const registerWorkspace = useCallback((key: string, element: HTMLElement | null) => {
    if (element) workspaceRefs.current.set(key, element);
    else workspaceRefs.current.delete(key);
  }, []);
  const registerPane = useCallback((key: string, element: HTMLElement | null) => {
    if (element) paneRefs.current.set(key, element);
    else paneRefs.current.delete(key);
  }, []);
  const registerWorkspaceFocus = useCallback((key: string, element: HTMLElement | null) => {
    if (element) workspaceFocusRefs.current.set(key, element);
    else workspaceFocusRefs.current.delete(key);
  }, []);
  const focusRovingTarget = useCallback((side: "before" | "after", key: string) => {
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    const target = kind === "ws"
      ? workspaceFocusRefs.current.get(`${side}:${id}`)
      : chipRefs.current.get(`${side}:${id}`);
    target?.focus();
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const sourcePaneIds = new Map(lines.flatMap((line) => {
      const location = findTabLocation(before, line.tabId);
      return location ? [[line.tabId, `before:${location.paneId}`] as const] : [];
    }));
    const destinationPaneIds = new Map(lines.flatMap((line) => {
      const location = findTabLocation(after, line.tabId);
      return location ? [[line.tabId, `after:${location.paneId}`] as const] : [];
    }));
    const fromRects = new Map<string, GroupingLineRect>();
    const toRects = new Map<string, GroupingLineRect>();
    const afterChipRects = new Map<string, GroupingLineRect>();
    const paneRects = new Map<string, GroupingLineRect>();
    const workspaceRects = new Map<string, GroupingLineRect>();
    let containerRect = container.getBoundingClientRect();
    let currentOrientation = groupingSideBySideOrientation(container.clientWidth);

    const measureAll = () => {
      containerRect = container.getBoundingClientRect();
      const nextSize = { width: container.clientWidth, height: container.clientHeight };
      setSize((current) => current.width === nextSize.width && current.height === nextSize.height ? current : nextSize);
      currentOrientation = groupingSideBySideOrientation(nextSize.width);
      fromRects.clear();
      toRects.clear();
      afterChipRects.clear();
      paneRects.clear();
      workspaceRects.clear();
      for (const [key, element] of chipRefs.current) {
        if (!key.startsWith("after:")) continue;
        afterChipRects.set(key.slice("after:".length), groupingRelativeRect(element.getBoundingClientRect(), containerRect));
      }
      for (const line of lines) {
        const from = chipRefs.current.get(`before:${line.tabId}`);
        if (from) fromRects.set(line.tabId, groupingRelativeRect(from.getBoundingClientRect(), containerRect));
        const toRect = afterChipRects.get(line.tabId);
        if (toRect) toRects.set(line.tabId, toRect);
      }
      for (const [key, element] of paneRefs.current) {
        paneRects.set(key, groupingRelativeRect(element.getBoundingClientRect(), containerRect));
      }
      for (const workspaceId of new Set(crossWorkspaceLines.map((line) => line.toWorkspaceId))) {
        const workspace = workspaceRefs.current.get(`after:${workspaceId}`);
        if (workspace) {
          workspaceRects.set(workspaceId, groupingRelativeRect(workspace.getBoundingClientRect(), containerRect));
        }
      }
      const commonInput = {
        fromRects,
        toRects,
        afterChipRects,
        paneRects,
        sourcePaneIds,
        destinationPaneIds,
        orientation: currentOrientation,
      };
      const nextMeasured = [
        ...groupingMeasuredMoveLines({
          ...commonInput,
          lines: crossWorkspaceLines,
          workspaceRects,
        }),
        ...groupingMeasuredMoveLines({
          ...commonInput,
          lines: withinWorkspaceLines,
          workspaceRects: new Map(),
        }),
      ];
      setMeasured((current) => measuredLinesEqual(current, nextMeasured) ? current : nextMeasured);
    };

    const measureChangedAnchors = (elements: ReadonlySet<Element>) => {
      const beforeAnchorsOnly = [...elements].every((element) => (
        element instanceof HTMLElement
        && element.dataset.groupingSide === "before"
        && Boolean(element.dataset.tabId && lineIds.has(element.dataset.tabId))
      ));
      if (!beforeAnchorsOnly) {
        measureAll();
        return;
      }
      const changedTabIds = new Set<string>();
      for (const element of elements) {
        if (!(element instanceof HTMLElement)) continue;
        const tabId = element.dataset.tabId;
        const side = element.dataset.groupingSide;
        if (!tabId || (side !== "before" && side !== "after")) continue;
        const rect = groupingRelativeRect(element.getBoundingClientRect(), containerRect);
        if (side === "before") {
          fromRects.set(tabId, rect);
          if (lineIds.has(tabId)) changedTabIds.add(tabId);
        } else {
          afterChipRects.set(tabId, rect);
          if (lineIds.has(tabId)) {
            toRects.set(tabId, rect);
            changedTabIds.add(tabId);
          }
        }
      }
      if (changedTabIds.size === 0) return;
      const commonInput = {
        fromRects,
        toRects,
        afterChipRects,
        paneRects,
        sourcePaneIds,
        destinationPaneIds,
        orientation: currentOrientation,
      };
      const nextMeasured = [
        ...groupingMeasuredMoveLines({
          ...commonInput,
          lines: crossWorkspaceLines,
          workspaceRects,
        }),
        ...groupingMeasuredMoveLines({
          ...commonInput,
          lines: withinWorkspaceLines,
          workspaceRects: new Map(),
        }),
      ];
      setMeasured((current) => measuredLinesEqual(current, nextMeasured) ? current : nextMeasured);
    };

    measureAll();
    let animationFrame: number | null = null;
    let disposed = false;
    let measureAllPending = false;
    const changedElements = new Set<Element>();
    const scheduleMeasure = (elements?: readonly Element[]) => {
      if (flightActiveRef.current) return;
      if (!elements || elements.length === 0 || elements.includes(container)) measureAllPending = true;
      else for (const element of elements) changedElements.add(element);
      if (disposed || animationFrame !== null) return;
      if (typeof requestAnimationFrame === "undefined") {
        if (measureAllPending) measureAll();
        else measureChangedAnchors(changedElements);
        measureAllPending = false;
        changedElements.clear();
        return;
      }
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        if (disposed) return;
        if (measureAllPending) measureAll();
        else measureChangedAnchors(changedElements);
        measureAllPending = false;
        changedElements.clear();
      });
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      scheduleMeasure(entries.map((entry) => entry.target));
    });
    const observed = new Set<Element>([container]);
    for (const line of lines) {
      const from = chipRefs.current.get(`before:${line.tabId}`);
      if (from) observed.add(from);
    }
    for (const [key, element] of chipRefs.current) {
      if (key.startsWith("after:")) observed.add(element);
    }
    for (const [, element] of paneRefs.current) {
      observed.add(element);
    }
    for (const [key, element] of workspaceRefs.current) {
      if (key.startsWith("after:")) observed.add(element);
    }
    for (const element of observed) resizeObserver?.observe(element);
    const scrollContainer = container.closest(".cmux-tab-grouping-col");
    const handleScroll = () => scheduleMeasure();
    scrollContainer?.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      disposed = true;
      if (animationFrame !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(animationFrame);
      }
      for (const element of observed) resizeObserver?.unobserve(element);
      resizeObserver?.disconnect();
      scrollContainer?.removeEventListener("scroll", handleScroll);
    };
  }, [after, crossWorkspaceLines, lines, withinWorkspaceLines]);

  const orientation = groupingSideBySideOrientation(size.width);
  const pinActive = pinnedLineFocus.tabId !== null || pinnedLineFocus.workspaceId !== null;
  const keyboardFocusActive = keyboardLineFocus.tabId !== null || keyboardLineFocus.workspaceId !== null;
  const lineFocus = pinActive ? pinnedLineFocus : keyboardFocusActive ? keyboardLineFocus : hoverLineFocus;
  const focusedTabIds = useMemo(() => new Set(diffs.filter((diff) => (
    lineFocus.tabId === diff.tabId
      || (lineFocus.workspaceId !== null
        && (diff.fromWorkspaceId === lineFocus.workspaceId || diff.toWorkspaceId === lineFocus.workspaceId))
  )).map((diff) => diff.tabId)), [diffs, lineFocus]);
  const pinnedTabIds = useMemo(() => new Set(diffs.filter((diff) => (
    pinnedLineFocus.tabId === diff.tabId
      || (pinnedLineFocus.workspaceId !== null
        && (diff.fromWorkspaceId === pinnedLineFocus.workspaceId || diff.toWorkspaceId === pinnedLineFocus.workspaceId))
  )).map((diff) => diff.tabId)), [diffs, pinnedLineFocus]);
  const active = focusedTabIds.size > 0;
  const hoverTab = (tabId: string | null) => setHoverLineFocus({ tabId, workspaceId: null });
  const focusTab = (tabId: string | null) => setKeyboardLineFocus({ tabId, workspaceId: null });
  const hoverWorkspace = (workspaceId: string | null) => setHoverLineFocus({ tabId: null, workspaceId });
  const focusWorkspace = (workspaceId: string | null) => setKeyboardLineFocus({ tabId: null, workspaceId });
  const togglePinnedTab = (tabId: string) => setPinnedLineFocus((current) => (
    current.tabId === tabId && current.workspaceId === null
      ? { tabId: null, workspaceId: null }
      : { tabId, workspaceId: null }
  ));
  const togglePinnedWorkspace = (workspaceId: string) => setPinnedLineFocus((current) => (
    current.workspaceId === workspaceId && current.tabId === null
      ? { tabId: null, workspaceId: null }
      : { tabId: null, workspaceId }
  ));
  const activateRovingTarget = (key: string) => {
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (kind === "ws") togglePinnedWorkspace(id);
    if (kind === "tab") togglePinnedTab(id);
  };
  const clearWorkspaceFocus = useCallback(() => {
    const consumed = pinnedLineFocus.tabId !== null || pinnedLineFocus.workspaceId !== null;
    setHoverLineFocus({ tabId: null, workspaceId: null });
    setKeyboardLineFocus({ tabId: null, workspaceId: null });
    setPinnedLineFocus({ tabId: null, workspaceId: null });
    return consumed;
  }, [pinnedLineFocus]);
  useEffect(() => {
    onLineFocusChange?.(active);
  }, [active, onLineFocusChange]);
  useEffect(() => {
    if (!clearFocusRef) return;
    clearFocusRef.current = clearWorkspaceFocus;
    return () => {
      clearFocusRef.current = null;
    };
  }, [clearFocusRef, clearWorkspaceFocus]);

  const startFlight = useCallback<GroupingApplyAnimationStarter<GroupingCommitAttempt>>((callbacks) => {
    if (!applyAnimationEnabled || flightRender || flightControllerRef.current) return false;
    if (lines.length === 0 || measured.length !== lines.length) return false;
    const items: GroupingFlightRenderItem[] = [];
    const draftItems: GroupingLandingDraftItem[] = [];
    for (const line of measured) {
      if (!line.fromRect || !line.toRect) return false;
      const sourceElement = chipRefs.current.get(`before:${line.tabId}`);
      const destinationElement = chipRefs.current.get(`after:${line.tabId}`);
      const tab = tabById.get(line.tabId);
      if (!sourceElement || !destinationElement || !tab) return false;
      const paths = groupingMoveLineDrawPaths(line, orientation);
      const pathSegments = [paths.mainPath, paths.leadInPath].filter((path): path is string => Boolean(path));
      let samples: readonly GroupingApplyAnimationPoint[];
      try {
        samples = sampleGroupingApplyPath(pathSegments);
      } catch {
        return false;
      }
      const label = line.label || tab.label || line.tabId;
      const width = line.fromRect.width;
      const height = line.fromRect.height;
      const destinationCenter = {
        x: line.destinationRect.left + line.destinationRect.width / 2,
        y: line.destinationRect.top + line.destinationRect.height / 2,
      };
      const color = destinationColors.get(line.toWorkspaceId);
      items.push({
        tabId: line.tabId,
        label,
        width,
        height,
        sourceCenter: {
          x: line.fromRect.left + line.fromRect.width / 2,
          y: line.fromRect.top + line.fromRect.height / 2,
        },
        destinationCenter,
        pathSegments,
        color,
        sourceElement,
        destinationElement,
      });
      draftItems.push({ tabId: line.tabId, label, color, width, height, destinationCenter, samples });
    }
    flightCallbacksRef.current = callbacks;
    flightActiveRef.current = true;
    if (landingDraftRef) landingDraftRef.current = { items: draftItems, container: containerRef.current };
    const id = flightGenerationRef.current + 1;
    flightGenerationRef.current = id;
    setFlightRender({ id, items });
    return true;
  }, [applyAnimationEnabled, destinationColors, flightRender, landingDraftRef, lines.length, measured, orientation, tabById]);

  useEffect(() => {
    if (!startApplyAnimationRef) return;
    startApplyAnimationRef.current = startFlight;
    return () => {
      if (startApplyAnimationRef.current === startFlight) startApplyAnimationRef.current = null;
    };
  }, [startApplyAnimationRef, startFlight]);

  useLayoutEffect(() => {
    if (!flightRender || flightControllerRef.current) return;
    const callbacks = flightCallbacksRef.current;
    if (!callbacks) {
      setFlightRender(null);
      return;
    }
    const animationItems = flightRender.items.flatMap((item) => {
      const proxyElement = flightProxyRefs.current.get(item.tabId);
      return proxyElement ? [{ ...item, proxyElement }] : [];
    });
    const finish = (outcome: GroupingCommitAttempt) => {
      flightActiveRef.current = false;
      flightControllerRef.current = null;
      flightCallbacksRef.current = null;
      setFlightRender((current) => current?.id === flightRender.id ? null : current);
      callbacks.onFinished(outcome);
    };
    if (animationItems.length !== flightRender.items.length) {
      if (landingDraftRef) landingDraftRef.current = null;
      const outcome = callbacks.onCommit();
      finish(outcome);
      return;
    }
    const controller = startGroupingApplyAnimation({
      items: animationItems,
      onCommit: callbacks.onCommit,
      commitSucceeded: callbacks.commitSucceeded,
      shouldReverse: callbacks.shouldReverse,
      onFinished: finish,
    });
    if (!controller) {
      if (landingDraftRef) landingDraftRef.current = null;
      const outcome = callbacks.onCommit();
      finish(outcome);
      return;
    }
    flightControllerRef.current = controller;
  }, [flightRender]);

  useEffect(() => {
    if (!applyAnimationEnabled) flightControllerRef.current?.settleImmediately();
  }, [applyAnimationEnabled]);

  useEffect(() => () => {
    flightActiveRef.current = false;
    flightControllerRef.current?.cancel();
    flightControllerRef.current = null;
    flightCallbacksRef.current = null;
  }, []);

  return (
    <>
      <div className="cmux-tab-grouping-note">{tabGroupingStrings.sideBySideLegend}</div>
      {diffs.length > 0 ? (
        <div className="cmux-tab-grouping-note">
          {tabGroupingStrings.sideBySideDiffCount(crossWorkspaceLines.length, withinWorkspaceLines.length)}
        </div>
      ) : null}
      <div className="cmux-tab-grouping-note">{tabGroupingStrings.liveLegendWithParentRef}</div>
      <div
        className={`cmux-tab-grouping-sidebyside${orientation === "vertical" ? " is-stacked" : ""}`}
        data-move-count={diffs.length}
        data-line-count={lines.length}
        ref={containerRef}
      >
        <div
          className="cmux-tab-grouping-sidebyside-pane is-before"
          role="group"
          aria-label={tabGroupingStrings.sideBySideGroupAriaLabel(tabGroupingStrings.confirmCurrent)}
        >
          <div className="cmux-tab-grouping-sidebyside-head">{tabGroupingStrings.confirmCurrent}</div>
          <PreviewWorkspaces
            workspaces={before}
            current={before}
            plan={plan}
            view="current"
            highlightMoved={highlightMoved}
            side="before"
            registerChip={registerChip}
            registerWorkspace={registerWorkspace}
            registerPane={registerPane}
            registerWorkspaceFocus={registerWorkspaceFocus}
            onChipHover={hoverTab}
            onChipFocus={focusTab}
            onWorkspaceHover={hoverWorkspace}
            onWorkspaceFocus={focusWorkspace}
            onWorkspaceEscape={clearWorkspaceFocus}
            focusedTabIds={focusedTabIds}
            pinnedTabIds={pinnedTabIds}
            movedTabIds={movedTabIds}
            pinnedWorkspaceId={pinnedLineFocus.workspaceId}
            onChipActivate={togglePinnedTab}
            onWorkspaceActivate={togglePinnedWorkspace}
            moveContexts={moveContexts}
            attentionCategoryByTabId={attentionCategoryByTabId}
            rovingKey={rovingKey.before}
            onRovingKeyChange={(key) => setRovingKey((current) => ({ ...current, before: key }))}
            focusRovingTarget={(key) => focusRovingTarget("before", key)}
            onRovingActivate={activateRovingTarget}
          />
        </div>
        <div
          className="cmux-tab-grouping-sidebyside-pane is-after"
          role="group"
          aria-label={tabGroupingStrings.sideBySideGroupAriaLabel(tabGroupingStrings.confirmAfter)}
        >
          <div className="cmux-tab-grouping-sidebyside-head">{tabGroupingStrings.confirmAfter}</div>
          <PreviewWorkspaces
            workspaces={after}
            current={before}
            plan={plan}
            view="after"
            highlightMoved={highlightMoved}
            side="after"
            registerChip={registerChip}
            registerWorkspace={registerWorkspace}
            registerPane={registerPane}
            registerWorkspaceFocus={registerWorkspaceFocus}
            onChipHover={hoverTab}
            onChipFocus={focusTab}
            onWorkspaceHover={hoverWorkspace}
            onWorkspaceFocus={focusWorkspace}
            onWorkspaceEscape={clearWorkspaceFocus}
            focusedTabIds={focusedTabIds}
            pinnedTabIds={pinnedTabIds}
            movedTabIds={movedTabIds}
            pinnedWorkspaceId={pinnedLineFocus.workspaceId}
            onChipActivate={togglePinnedTab}
            onWorkspaceActivate={togglePinnedWorkspace}
            destinationColors={destinationColors}
            moveContexts={moveContexts}
            moveBadges={moveBadges}
            attentionCategoryByTabId={attentionCategoryByTabId}
            rovingKey={rovingKey.after}
            onRovingKeyChange={(key) => setRovingKey((current) => ({ ...current, after: key }))}
            focusRovingTarget={(key) => focusRovingTarget("after", key)}
            onRovingActivate={activateRovingTarget}
          />
        </div>
        {diffs.length === 0 ? (
          <div className="cmux-tab-grouping-sidebyside-note">{tabGroupingStrings.sideBySideNoMoves}</div>
        ) : null}
        {lines.length > 0 ? (
          <svg
            className="cmux-tab-grouping-lines"
            aria-hidden="true"
            focusable="false"
            viewBox={`0 0 ${size.width} ${size.height}`}
            preserveAspectRatio="none"
          >
            {measured.map((line) => {
              if (!lineIds.has(line.tabId)) return null;
              const tab = tabById.get(line.tabId);
              if (!tab) return null;
              return (
                <GroupingMoveLineGroup
                  key={line.tabId}
                  line={line}
                  tab={tab}
                  attentionCategory={attentionCategoryByTabId[line.tabId]}
                  active={active}
                  focused={focusedTabIds.has(line.tabId)}
                  pinned={pinnedTabIds.has(line.tabId)}
                  color={destinationColors.get(line.toWorkspaceId)}
                  orientation={orientation}
                />
              );
            })}
          </svg>
        ) : null}
        {flightRender ? (
          <div className="cmux-tab-grouping-flight-layer" aria-hidden="true">
            {flightRender.items.map((item) => (
              <div
                key={`${flightRender.id}:${item.tabId}`}
                ref={(element) => {
                  if (element) flightProxyRefs.current.set(item.tabId, element);
                  else flightProxyRefs.current.delete(item.tabId);
                }}
                className="cmux-tab-grouping-flight-chip"
                data-flight-tab-id={item.tabId}
                data-flight-path={JSON.stringify(item.pathSegments)}
                style={{
                  width: item.width,
                  height: item.height,
                  transform: `translate3d(${item.sourceCenter.x - item.width / 2}px, ${item.sourceCenter.y - item.height / 2}px, 0)`,
                  "--grouping-flight-color": item.color,
                } as CSSProperties}
              >
                <span className="cmux-tab-grouping-flight-label">{item.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function TabGroupingPanel({ open, visible, closing = false, intent = null, onClose }: TabGroupingPanelProps) {
  const analyzeGenerationRef = useRef(0);
  const applyInFlightRef = useRef(false);
  const revisionReprepareRef = useRef(false);
  const destinationTriggerRef = useRef<HTMLButtonElement>(null);
  const destinationMenuRef = useRef<HTMLDivElement>(null);
  const moveTriggerRef = useRef<HTMLButtonElement>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  const sideBySideLineFocusRef = useRef(false);
  const clearSideBySideFocusRef = useRef<(() => void) | null>(null);
  const startApplyAnimationRef = useRef<GroupingApplyAnimationStarter<GroupingCommitAttempt> | null>(null);
  const landingDraftRef = useRef<GroupingLandingDraft | null>(null);
  const editMapRef = useRef<HTMLDivElement>(null);
  const dropPickerActiveIdRef = useRef<string | null>(null);
  const dropPickerEngagedRef = useRef(false);
  const previousSelectedCountRef = useRef(0);
  const [mode, setMode] = useState<GroupingMode>("compare");
  const [confirmView, setConfirmView] = useState<ConfirmView>("side-by-side");
  const [showCurrent, setShowCurrent] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisStage, setAnalysisStage] = useState<GroupingAnalysisStage>("scanning");
  const [analysisElapsedSeconds, setAnalysisElapsedSeconds] = useState(0);
  const [applying, setApplying] = useState(false);
  const [highlightMoved, setHighlightMoved] = useState(false);
  const [status, setStatus] = useState<string>(tabGroupingStrings.analyzing);
  const [scan, setScan] = useState<GroupingScan | null>(null);
  const [plans, setPlans] = useState<GroupingPlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [editedByPlan, setEditedByPlan] = useState<Record<string, GroupingEditSession>>({});
  const [comparisonInsufficient, setComparisonInsufficient] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [analysisFreshness, setAnalysisFreshness] = useState<GroupingAnalysisFreshness | null>(null);
  const [analysisGeneratedAt, setAnalysisGeneratedAt] = useState<number | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(new Set());
  const [changedOnly, setChangedOnly] = useState(false);
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [nameEdit, setNameEdit] = useState<GroupingNameEditTarget | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [stale, setStale] = useState<StaleIssue[]>([]);
  const [applyErrors, setApplyErrors] = useState<string[]>([]);
  const [applied, setApplied] = useState<LayoutTransaction | null>(null);
  const [reviewApplied, setReviewApplied] = useState(false);
  const [undoDismissed, setUndoDismissed] = useState(false);
  const [ticket, setTicket] = useState<GroupingTicket | null>(null);
  const [preparedPlan, setPreparedPlan] = useState<GroupingPlan | null>(null);
  const [preparedLayoutRevision, setPreparedLayoutRevision] = useState<number | null>(null);
  const [commitDurability, setCommitDurability] = useState<ReturnType<typeof groupingBoundary.commit>["durability"] | null>(null);
  const [liveAnnounce, setLiveAnnounce] = useState("");
  const [analysisIdentity, setAnalysisIdentity] = useState(() => ({
    allocationSeed: requestId(),
    createdAt: Date.now(),
  }));
  const [newWorkspaceDefaults, setNewWorkspaceDefaults] = useState<{ pet: Workspace["pet"] } | null>(() => {
    const pet = choosePetForNewWorkspace();
    return pet === undefined ? null : { pet };
  });
  const aiProvider = useAiSettingsStore((state) => state.aiProvider);
  const aiModel = useAiSettingsStore((state) => state.aiModel);
  const aiEnabled = useAiSettingsStore((state) => state.aiEnabled);
  const groupingApplyAnimationEnabled = useSettingsStore((state) => state.groupingApplyAnimationEnabled);
  const prefersReducedMotion = usePrefersReducedMotion();
  const applyMotionEnabled = groupingApplyAnimationEnabled && !prefersReducedMotion;
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
  const layoutRevision = useWorkspaceListStore((state) => state.layoutRevision);
  const dragLayoutRevision = useMemo(() => layoutStructureRevision(workspaces), [workspaces]);
  const undo = useGroupingRuntimeStore((state) => state.undo);
  const runtimeDurability = useGroupingRuntimeStore((state) => state.durability);
  const groupingOperation = useGroupingRuntimeStore((state) => state.operation);
  const attentionBySession = useSessionAttentionStore((state) => state.attentionBySession);
  const seenAttentionByTab = useSessionAttentionStore((state) => state.seenAttentionByTab);

  const displayedPlans = useMemo(() => orderGroupingPlansForDisplay(plans), [plans]);
  const editSession = selectedPlanId ? editedByPlan[selectedPlanId] ?? null : null;
  const edited = editSession?.plan
    ?? (selectedPlanId ? plans.find((plan) => plan.planId === selectedPlanId) ?? null : null);
  const selectedGroup = edited?.groups.find((group) => group.groupId === selectedGroupId) ?? edited?.groups[0] ?? null;
  const stepStates = groupingStepStates({
    mode,
    hasPlans: plans.length > 0 && Boolean(edited),
    analyzing,
    applying,
    applied: Boolean(applied),
  });
  const confirmationInvalidated = shouldInvalidateGroupingTicket({
    preparedLayoutRevision,
    currentLayoutRevision: layoutRevision,
    applying,
    applied: Boolean(applied),
  });
  const currentPlanStats = edited && scan ? planCardStats(edited, scan.baseline) : null;
  const resultReadOnly = analysisFreshness === "soft-stale";
  // The runtime store expires this record as soon as its structural signature
  // stops matching. The Panel consumes that public state instead of bypassing
  // the groupingBoundary facade to recompute an engine signature.
  const canReviewUndo = undo?.status === "available";
  const canReviewApplied = canReviewUndo;
  const analysisProgress = tabGroupingStrings.analysisProgress(analysisStage, analysisElapsedSeconds);

  useEffect(() => {
    if (!analyzing || !open) return;
    const startedAt = Date.now();
    setAnalysisElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setAnalysisElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [analyzing, open]);

  const runEditCommand = useCallback((planId: string, command: EditCommand) => {
    const session = editedByPlan[planId];
    if (!session) return;
    const next = applyEditCommand(session, command, {
      existingWorkspaceNames: workspaces.map((workspace) => workspace.name),
    });
    if (next === session) return;
    setEditedByPlan((current) => (
      current[planId] === session ? { ...current, [planId]: next } : current
    ));
  }, [editedByPlan, workspaces]);

  const commitNameEdit = useCallback(() => {
    const target = nameEdit;
    const planId = selectedPlanId;
    const title = nameDraft.trim();
    setNameEdit(null);
    setNameDraft("");
    if (!target || !planId || !title) return;
    if (target.kind === "group") {
      runEditCommand(planId, { kind: "rename_group", groupId: target.groupId, title });
    } else if (target.kind === "workspace") {
      runEditCommand(planId, {
        kind: "rename_new_workspace",
        groupId: target.groupId,
        proposedName: title,
      });
    } else {
      runEditCommand(planId, { kind: "rename_pane", pane: target.pane, title });
    }
  }, [nameDraft, nameEdit, runEditCommand, selectedPlanId]);

  const renderNameInput = () => (
    <input
      autoFocus
      aria-label={tabGroupingStrings.renameLabel}
      maxLength={TAB_GROUPING_NAME_MAX}
      value={nameDraft}
      onChange={(event) => setNameDraft(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={commitNameEdit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setNameEdit(null);
          setNameDraft("");
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          commitNameEdit();
        }
      }}
    />
  );

  const cancelJudge = useCallback(() => {
    analyzeGenerationRef.current += 1;
  }, []);

  const resetTransientUi = useCallback(() => {
    applyInFlightRef.current = false;
    revisionReprepareRef.current = false;
    setSelectedPlanId(null);
    setEditedByPlan({});
    setSelectedGroupId(null);
    setSelectedTabIds(new Set());
    setDestinationOpen(false);
    setMoveOpen(false);
    setNameEdit(null);
    setNameDraft("");
    setStale([]);
    setApplyErrors([]);
    setApplied(null);
    setReviewApplied(false);
    setTicket(null);
    setPreparedPlan(null);
    setPreparedLayoutRevision(null);
    setCommitDurability(null);
    setComparisonInsufficient(false);
  }, []);

  const hydrateAnalysis = useCallback((
    result: GroupingAnalysisResult,
    freshness: GroupingAnalysisFreshness,
    generatedAt: number,
  ) => {
    setAnalysisIdentity({ allocationSeed: requestId(), createdAt: Date.now() });
    const pet = choosePetForNewWorkspace();
    setNewWorkspaceDefaults(pet === undefined ? null : { pet });
    resetTransientUi();
    setMode("compare");
    setScan(result.scan);
    setRaw(result.raw);
    setAnalysisFreshness(freshness);
    setAnalysisGeneratedAt(generatedAt);
    if (result.parsed.status === "invalid") {
      setParseError(result.parsed.reason);
      setPlans([]);
      setStatus(result.parsed.reason);
      return;
    }
    const parsed: ParseGroupingResult = result.parsed;
    const orderedPlans = orderGroupingPlansForDisplay(parsed.plans);
    setParseError(null);
    setPlans(parsed.plans);
    setEditedByPlan(Object.fromEntries(parsed.plans.map((plan) => [
      plan.planId,
      beginGroupingEdit(clonePlanForEdit(plan)),
    ])));
    setSelectedPlanId(orderedPlans[0]?.planId ?? null);
    setSelectedGroupId(orderedPlans[0]?.groups[0]?.groupId ?? null);
    setComparisonInsufficient(parsed.comparisonInsufficient);
    setStatus(groupingPreparedStatus(freshness, generatedAt));
  }, [resetTransientUi]);

  const analyze = useCallback(async (force = true, options?: { keepCurrent?: boolean }) => {
    cancelJudge();
    const generation = ++analyzeGenerationRef.current;
    setAnalyzing(true);
    setAnalysisStage("scanning");
    setAnalysisElapsedSeconds(0);
    // keepCurrent: a structure-stale plan stays on screen (read-only) while
    // the judge re-derives it, instead of the panel going blank for the
    // whole judge run.
    if (!options?.keepCurrent) {
      setParseError(null);
      setRaw("");
      setPlans([]);
      setAnalysisFreshness(null);
      setAnalysisGeneratedAt(null);
      resetTransientUi();
      setMode("compare");
    }
    setStatus(tabGroupingStrings.analyzing);
    try {
      const produced = await generateForegroundGroupingAnalysis(force, (stage) => {
        if (generation === analyzeGenerationRef.current) setAnalysisStage(stage);
      });
      if (generation !== analyzeGenerationRef.current) return;
      if (produced.kind === "obsolete") {
        setStatus("状態が変わったため、もう一度分析してください");
        return;
      }
      hydrateAnalysis(produced.analysis, "fresh", produced.generatedAt);
    } catch (error) {
      if (generation !== analyzeGenerationRef.current) return;
      const presented = formatJudgeError(error, aiProvider);
      setParseError(presented.summary);
      setRaw(presented.raw);
      setStatus(presented.summary);
    } finally {
      if (generation === analyzeGenerationRef.current) {
        setAnalyzing(false);
      }
    }
  }, [aiProvider, cancelJudge, hydrateAnalysis, resetTransientUi]);

  useEffect(() => {
    if (!open) {
      cancelJudge();
      return;
    }
    if (intent === "review" && useGroupingRuntimeStore.getState().undo?.status === "available") return;
    markGroupingInterest();
    const cached = peekGroupingPrecompute();
    if (cached.kind === "fresh" || cached.kind === "soft-stale") {
      hydrateAnalysis(cached.analysis, cached.kind, cached.generatedAt);
      if (cached.kind === "soft-stale") {
        // Layout moved under the plan: someone is waiting at an open panel, so
        // re-judge in the foreground while the old plan stays visible. Mere
        // output drift only needs the background refresh.
        if (cached.reason === "structure") void analyze(false, { keepCurrent: true });
        else requestGroupingPrecomputeRefresh();
      }
    } else {
      void analyze(false);
    }
    return () => cancelJudge();
  }, [analyze, cancelJudge, hydrateAnalysis, intent, open]);

  useEffect(() => {
    if (!open
      || intent !== "review"
      || useGroupingRuntimeStore.getState().undo?.status !== "available") return;
    analyzeGenerationRef.current += 1;
    cancelJudge();
    resetTransientUi();
    setAnalyzing(false);
    setReviewApplied(true);
    setMode("confirm");
    setStatus(tabGroupingStrings.undoAppliedUnknown);
  }, [cancelJudge, intent, open, resetTransientUi]);

  useEffect(() => {
    if (!open || closing) return;
    return acquireGroupingPanelOpen();
  }, [closing, open]);

  useEffect(() => {
    if (!destinationOpen) return;
    destinationMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [destinationOpen]);

  useEffect(() => {
    if (!moveOpen) return;
    moveMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [moveOpen]);

  useEffect(() => {
    if (mode !== "confirm" || !edited || !scan || applying || applied) return;
    if (ticket) {
      if (preparedPlan === edited) return;
      revisionReprepareRef.current = false;
      setTicket(null);
      setPreparedLayoutRevision(null);
      return;
    }
    if (preparedPlan === edited) return;

    setPreparedPlan(edited);
    const result = groupingBoundary.prepare(edited, {
      baseline: scan.baseline,
      activeWorkspaceId: useWorkspaceListStore.getState().activeWorkspaceId,
      activeSessionId: useUiStore.getState().activePaneId ?? useUiStore.getState().lastActivePaneId,
      allocationSeed: analysisIdentity.allocationSeed,
      createdAt: analysisIdentity.createdAt,
      ...(newWorkspaceDefaults ? { newWorkspaceDefaults } : {}),
    });
    if (!result.ok) {
      const message = groupingPrepareFailureMessage(result);
      setStale(result.stale);
      setApplyErrors([message, ...result.errors.filter((error) => error !== message)]);
      setStatus(revisionReprepareRef.current ? tabGroupingStrings.ticketInvalidated : message);
      return;
    }
    setStale([]);
    setApplyErrors([]);
    setTicket(result.ticket);
    setPreparedLayoutRevision(useWorkspaceListStore.getState().layoutRevision);
    revisionReprepareRef.current = false;
  }, [analysisIdentity, applied, applying, edited, mode, newWorkspaceDefaults, preparedPlan, scan, ticket]);

  useEffect(() => {
    if (!confirmationInvalidated) return;
    revisionReprepareRef.current = true;
    setTicket(null);
    setPreparedPlan(null);
    setPreparedLayoutRevision(null);
    setMode("confirm");
    setStatus(tabGroupingStrings.ticketInvalidated);
  }, [confirmationInvalidated]);

  const compiled = useMemo(() => {
    if (applied) return { ok: true as const, transaction: applied };
    if (mode === "confirm") return null;
    if (!edited || !scan) return null;
    // preview reads the live workspaces through the facade; `workspaces` stays in the deps
    // so the memo recomputes when the layout changes.
    return groupingBoundary.preview(edited, {
      baseline: scan.baseline,
      activeWorkspaceId: useWorkspaceListStore.getState().activeWorkspaceId,
      activeSessionId: useUiStore.getState().activePaneId ?? useUiStore.getState().lastActivePaneId,
      allocationSeed: analysisIdentity.allocationSeed,
      createdAt: analysisIdentity.createdAt,
      ...(newWorkspaceDefaults ? { newWorkspaceDefaults } : {}),
    });
  }, [analysisIdentity, applied, edited, groupingOperation, mode, newWorkspaceDefaults, scan, workspaces]);

  const displayedCompiled = applied
    ? { ok: true as const, transaction: applied }
    : mode === "confirm"
      ? ticket && preparedPlan === edited && !confirmationInvalidated
        ? { ok: true as const, transaction: ticket.transaction }
        : null
      : compiled;

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
    if (applyInFlightRef.current || !edited || !ticket || preparedPlan !== edited || applying || applied) return;
    if (preparedLayoutRevision !== useWorkspaceListStore.getState().layoutRevision) return;
    if (ticket.transaction.expected.movedTabIds.length === 0) {
      setStatus(tabGroupingStrings.applyZeroMoves);
      return;
    }
    applyInFlightRef.current = true;
    setApplying(true);
    setStatus(tabGroupingStrings.applying);
    const commit = (): GroupingCommitAttempt => {
      try {
        return { kind: "result", result: groupingBoundary.commit(edited, ticket) };
      } catch (error) {
        return { kind: "throw", error };
      }
    };
    const finish = (attempt: GroupingCommitAttempt) => {
      if (attempt.kind === "throw") {
        const message = attempt.error instanceof Error ? attempt.error.message : String(attempt.error);
        setTicket(null);
        setPreparedPlan(null);
        setPreparedLayoutRevision(null);
        setApplyErrors([message]);
        setMode("edit");
        setStatus(message);
        setApplying(false);
        queueMicrotask(() => {
          applyInFlightRef.current = false;
        });
        return;
      }
      const result = attempt.result;
      setCommitDurability(result.durability);
      setTicket(null);
      setPreparedPlan(null);
      setPreparedLayoutRevision(null);
      if (!result.commit.ok) {
        const message = groupingCommitFailureMessage(result.commit);
        setStale(result.commit.stale ?? []);
        setApplyErrors([message, ...result.commit.errors.filter((error) => error !== message)]);
        setApplying(false);
        queueMicrotask(() => {
          applyInFlightRef.current = false;
        });
        if (result.commit.kind === "preview_stale") {
          setMode("confirm");
          setStatus(tabGroupingStrings.ticketInvalidated);
        } else {
          setMode("edit");
          setStatus(message);
        }
        return;
      }
      setStale([]);
      setApplyErrors([]);
      setApplied(result.commit.transaction);
      setReviewApplied(true);
      setUndoDismissed(false);
      setHighlightMoved(true);
      setStatus(tabGroupingStrings.undoApplied(result.commit.report.moved.length));
      const draft = landingDraftRef.current;
      landingDraftRef.current = null;
      const expected = result.commit.transaction.expected;
      const containerRect = draft?.container?.getBoundingClientRect() ?? null;
      if (applyMotionEnabled && draft && containerRect) {
        const movedById = new Map(result.commit.report.moved.map((entry) => [entry.tabId, entry]));
        const items = draft.items.flatMap((item) => {
          const moved = movedById.get(item.tabId);
          if (!moved) return [];
          return [{
            tabId: item.tabId,
            label: item.label,
            color: item.color,
            width: item.width,
            height: item.height,
            exitCenter: {
              x: containerRect.left + item.destinationCenter.x,
              y: containerRect.top + item.destinationCenter.y,
            },
            exitTangent: groupingExitTangent(item.samples),
            destination: moved.to.workspaceId === expected.focusWorkspaceId
              ? { kind: "pane" as const, workspaceId: moved.to.workspaceId, paneId: moved.to.paneId }
              : { kind: "workspace" as const, workspaceId: moved.to.workspaceId },
          }];
        });
        if (items.length > 0) {
          requestGroupingLandingFlight({
            items,
            movedCount: result.commit.report.moved.length,
            focusWorkspaceId: expected.focusWorkspaceId,
          });
        }
      }
      window.setTimeout(() => {
        setHighlightMoved(false);
        applyInFlightRef.current = false;
        setApplying(false);
      }, 0);
      // The apply succeeded: the panel and Dashboard retire together so what
      // the user watches is the landing flight (or, with motion off, the
      // settled real layout). Undo stays reachable — it lives in the runtime
      // store and reappears when the panel is reopened.
      onClose();
      useDashboardViewStore.getState().close();
    };
    const callbacks: GroupingApplyAnimationCallbacks<GroupingCommitAttempt> = {
      onCommit: commit,
      commitSucceeded: (attempt) => attempt.kind === "result" && attempt.result.commit.ok,
      shouldReverse: (attempt) => (
        attempt.kind === "throw"
          || (!attempt.result.commit.ok && attempt.result.commit.kind !== "rollback_failed")
      ),
      onFinished: finish,
    };
    const animationStarted = applyMotionEnabled && (startApplyAnimationRef.current?.(callbacks) ?? false);
    if (!animationStarted) finish(commit());
  }, [applied, applying, applyMotionEnabled, edited, onClose, preparedLayoutRevision, preparedPlan, ticket]);

  const undoGrouping = useCallback(() => {
    const result = groupingBoundary.undo();
    if (!result.ok) {
      const message = groupingUndoFailureMessage(result);
      setApplyErrors([message]);
      setStatus(message);
      if (result.kind === "post_undo_failed") {
        setApplied(null);
        setReviewApplied(false);
        setTicket(null);
        setPreparedPlan(edited);
        setHighlightMoved(false);
      }
      return;
    }
    setStale([]);
    setApplyErrors([]);
    setApplied(null);
    setReviewApplied(false);
    setTicket(null);
    setPreparedPlan(edited);
    setCommitDurability(null);
    setHighlightMoved(false);
    setStatus(tabGroupingStrings.undoRestored);
  }, [edited]);

  const previewCurrent = reviewApplied && undo && canReviewApplied ? undo.snapshot.workspaces : workspaces;
  const previewAfter = reviewApplied && undo && canReviewApplied
    ? applied?.workspaces ?? workspaces
    : mode === "confirm" && ticket && preparedPlan === edited
      ? ticket.transaction.workspaces
      : displayedCompiled?.ok ? displayedCompiled.transaction.workspaces : workspaces;
  const confirmationMovedTabIds = useMemo(
    () => new Set(groupingMoveDiffs(previewCurrent, previewAfter).map((diff) => diff.tabId)),
    [previewAfter, previewCurrent],
  );
  const showBefore = (showCurrent && mode === "compare") || (confirmView === "current" && mode === "confirm");
  const previewWorkspaces = showBefore ? previewCurrent : previewAfter;
  const changedWorkspaceIds = groupingChangedWorkspaceIds(workspaces, previewAfter);
  const editMapWorkspaces = changedOnly
    ? previewAfter.filter((workspace) => changedWorkspaceIds.has(workspace.id))
    : previewAfter;
  const editDropTargets = useMemo(
    () => groupingEditDropTargets(edited, previewAfter, editSession?.stashedLayouts),
    [editSession?.stashedLayouts, edited, previewAfter],
  );
  const targetsByDropId = useMemo(() => {
    const targets = new Map<string, GroupingEditTarget>([["keep-current", { kind: "unassigned" }]]);
    for (const target of editDropTargets.values()) {
      targets.set(groupingDropIdForTarget(target), target);
    }
    return targets;
  }, [editDropTargets]);
  const validDropIds = useMemo(() => new Set(targetsByDropId.keys()), [targetsByDropId]);
  const dropNames = useMemo(() => {
    const names = new Map<string, string>([["keep-current", tabGroupingStrings.unassignedTitle]]);
    for (const [mapKey, target] of editDropTargets) {
      const group = edited?.groups.find((candidate) => candidate.groupId === target.groupId);
      if (target.kind === "group") {
        names.set(groupingDropIdForTarget(target), group?.title ?? target.groupId);
        continue;
      }
      const workspace = previewAfter.find((candidate) => (
        candidate.panes.some((pane) => pane.id === mapKey)
      ));
      const paneTitle = group?.layout?.columns[target.columnIndex]?.panes[target.paneIndex]?.title
        ?? mapKey;
      names.set(
        groupingDropIdForTarget(target),
        tabGroupingStrings.dropDestinationLabel(workspace?.name ?? group?.title ?? target.groupId, paneTitle),
      );
    }
    return names;
  }, [editDropTargets, edited, previewAfter]);
  const tabLabels = useMemo(() => new Map(
    (scan?.tabs ?? []).map((tab) => [tab.id, tabName(tab.label)]),
  ), [scan]);
  const toggleTabSelection = useCallback((tabId: string) => {
    if (!edited || previewKindForTab(edited, tabId) === "untouched") return;
    setSelectedTabIds((current) => {
      const next = new Set(current);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });
  }, [edited]);
  const moveTabs = useCallback((
    tabIds: readonly string[],
    target: GroupingEditTarget,
    announce: string,
  ) => {
    if (!selectedPlanId || tabIds.length === 0) return;
    runEditCommand(
      selectedPlanId,
      target.kind === "unassigned"
        ? { kind: "keep_current", tabIds: [...tabIds] }
        : { kind: "reassign_tabs", tabIds: [...tabIds], target },
    );
    setSelectedTabIds(new Set());
    setLiveAnnounce(announce);
  }, [runEditCommand, selectedPlanId]);
  const moveSelectedToTarget = useCallback((
    target: GroupingEditTarget,
    destinationName: string,
  ) => {
    const tabIds = [...selectedTabIds];
    moveTabs(
      tabIds,
      target,
      target.kind === "unassigned"
        ? tabGroupingStrings.keepAnnounce(tabIds.length)
        : tabGroupingStrings.moveAnnounce(tabIds.length, destinationName),
    );
  }, [moveTabs, selectedTabIds]);
  const moveSelectionTo = useCallback((dropId: string) => {
    const target = resolveGroupingDropTarget(dropId, validDropIds, targetsByDropId);
    if (!target) return;
    moveSelectedToTarget(target, dropNames.get(dropId) ?? dropId);
  }, [dropNames, moveSelectedToTarget, targetsByDropId, validDropIds]);
  useEffect(() => {
    if (previousSelectedCountRef.current === 0 && selectedTabIds.size > 0) {
      setLiveAnnounce(tabGroupingStrings.dropPickerHint);
    }
    previousSelectedCountRef.current = selectedTabIds.size;
  }, [selectedTabIds.size]);
  useLayoutEffect(() => {
    const root = editMapRef.current;
    if (mode !== "edit" || !root) return;
    const zones = [...root.querySelectorAll<HTMLElement>("[data-drop-id]")];
    if (zones.length === 0) {
      dropPickerActiveIdRef.current = null;
      dropPickerEngagedRef.current = false;
      return;
    }
    const idOf = (zone: HTMLElement): string => zone.getAttribute("data-drop-id") ?? "";
    let activeId = dropPickerActiveIdRef.current;
    if (!activeId || !zones.some((zone) => idOf(zone) === activeId)) activeId = idOf(zones[0]);
    dropPickerActiveIdRef.current = activeId;
    const applyRovingState = (nextId: string, focus: boolean): void => {
      dropPickerActiveIdRef.current = nextId;
      dropPickerEngagedRef.current = true;
      for (const zone of zones) {
        const active = idOf(zone) === nextId;
        zone.tabIndex = active ? 0 : -1;
        zone.setAttribute("aria-describedby", "cmux-tab-grouping-drop-picker-hint");
        zone.setAttribute("data-grouping-drop-state", active ? "active" : "idle");
        if (active && focus) zone.focus();
      }
    };
    const cleanups: Array<() => void> = [];
    for (const zone of zones) {
      const id = idOf(zone);
      zone.tabIndex = id === activeId ? 0 : -1;
      zone.setAttribute("aria-describedby", "cmux-tab-grouping-drop-picker-hint");
      zone.setAttribute("data-grouping-drop-state", "idle");
      const handleFocus = (): void => applyRovingState(id, false);
      const handleKeyDown = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
          event.preventDefault();
          dropPickerEngagedRef.current = true;
          return;
        }
        const currentIndex = zones.indexOf(zone);
        let nextIndex: number | null = null;
        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          nextIndex = Math.min(zones.length - 1, currentIndex + 1);
        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          nextIndex = Math.max(0, currentIndex - 1);
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = zones.length - 1;
        }
        if (nextIndex === null) return;
        event.preventDefault();
        applyRovingState(idOf(zones[nextIndex]), true);
      };
      zone.addEventListener("focus", handleFocus);
      zone.addEventListener("keydown", handleKeyDown);
      cleanups.push(() => {
        zone.removeEventListener("focus", handleFocus);
        zone.removeEventListener("keydown", handleKeyDown);
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [editDropTargets, edited, mode]);
  const exitDropPicker = useCallback((): boolean => {
    if (!dropPickerEngagedRef.current) return false;
    dropPickerEngagedRef.current = false;
    const root = editMapRef.current;
    for (const zone of root?.querySelectorAll<HTMLElement>("[data-drop-id]") ?? []) {
      zone.setAttribute("data-grouping-drop-state", "idle");
    }
    const selectedChip = [...(root?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [])]
      .find((chip) => selectedTabIds.has(chip.getAttribute("data-tab-id") ?? ""));
    selectedChip?.focus();
    return true;
  }, [selectedTabIds]);
  const { onTabPointerDown, ghost, active: groupingDragActive } = useGroupingDrag({
    enabled: visible && open && !closing && mode === "edit",
    mode,
    plan: edited,
    selectedTabIds,
    validDropIds,
    targetsByDropId,
    dropNames,
    tabLabels,
    revisionToken: edited,
    layoutRevision: dragLayoutRevision,
    onToggleTab: toggleTabSelection,
    onMove: moveTabs,
    onCancel: (reason, announce) => {
      if (!announce) return;
      setLiveAnnounce(
        reason === "noop"
          ? tabGroupingStrings.dragNoopAnnounce
          : reason === "target-gone" || reason === "stale-selection"
            ? tabGroupingStrings.dragTargetGoneAnnounce
            : tabGroupingStrings.dragCancelAnnounce,
      );
    },
  });
  const requestClose = useCallback(() => {
    if (groupingDragActive) return;
    onClose();
  }, [groupingDragActive, onClose]);
  const editStats = edited ? planCardStats(edited, scan?.baseline ?? []) : null;
  const durabilityStatus = runtimeDurability.status !== "idle"
    ? runtimeDurability.status
    : commitDurability ?? "idle";
  const durabilityMessage = durabilityStatus === "pending"
    ? tabGroupingStrings.durabilityPending
    : durabilityStatus === "deferred" || durabilityStatus === "failed"
      ? tabGroupingStrings.statusDurabilityWarning
      : null;
  const attentionCategoryByTabId = useMemo(() => {
    const categories: Record<string, "waiting" | "error" | "done" | null | undefined> = {};
    for (const workspace of [...previewCurrent, ...previewAfter]) {
      for (const pane of workspace.panes) {
        for (const tab of pane.tabs) {
          if (Object.prototype.hasOwnProperty.call(categories, tab.id)) continue;
          categories[tab.id] = attentionCategory(
            tab.id,
            attentionBySession[tab.sessionId],
            seenAttentionByTab,
          );
        }
      }
    }
    return categories;
  }, [attentionBySession, previewAfter, previewCurrent, seenAttentionByTab]);
  if (!visible) return null;
  const nextStep = nextGroupingStep(mode);
  const previousStep = previousGroupingStep(mode);
  const selectedDestination = selectedGroup?.destination;
  const selectedDestinationName = selectedDestination
    ? selectedDestination.kind === "new_workspace"
      ? selectedDestination.proposedName
      : selectedDestination.kind === "existing_workspace"
        ? workspaces.find((workspace) => workspace.id === selectedDestination.workspaceId)?.name
          ?? selectedDestination.workspaceId
        : tabGroupingStrings.destinationCurrent
    : tabGroupingStrings.destinationCurrent;
  const enterMode = (target: GroupingStepId) => {
    if (target !== "edit") {
      setSelectedTabIds(new Set());
      setMoveOpen(false);
      setDestinationOpen(false);
    }
    if (target === "confirm" && !ticket) setPreparedPlan(null);
    setMode(target);
  };
  const keepSelectionCurrent = () => {
    moveSelectionTo("keep-current");
  };

  return (
    <OverlayShell
      open={open}
      closing={closing}
      onClose={requestClose}
      closeOnBackdrop={!groupingDragActive}
      onEscape={() => {
        if (exitDropPicker()) return true;
        if (destinationOpen) {
          setDestinationOpen(false);
          destinationTriggerRef.current?.focus();
          return true;
        }
        if (moveOpen) {
          setMoveOpen(false);
          moveTriggerRef.current?.focus();
          return true;
        }
        if (nameEdit) {
          setNameEdit(null);
          setNameDraft("");
          return true;
        }
        if (selectedTabIds.size > 0) {
          setSelectedTabIds(new Set());
          return true;
        }
        if (sideBySideLineFocusRef.current) {
          sideBySideLineFocusRef.current = false;
          clearSideBySideFocusRef.current?.();
          return true;
        }
        return false;
      }}
      size="full"
      ariaLabel={tabGroupingStrings.panelAriaLabel}
      id="tab-grouping-panel"
    >
      <div
        className={`cmux-tab-grouping${applying ? " is-applying" : ""}`}
        onContextMenu={(event) => event.preventDefault()}
      >
        <header className="cmux-tab-grouping-header">
          <div className="cmux-tab-grouping-heading">
            <div className="cmux-tab-grouping-title">{tabGroupingStrings.title}</div>
            <div className="cmux-tab-grouping-header-copy">
              <div className="cmux-tab-grouping-status" role="status">
                {analyzing ? tabGroupingStrings.analysisStage(analysisStage) : status}
              </div>
              <div className="cmux-tab-grouping-headmeta">
                {mode === "edit" && edited
                  ? tabGroupingStrings.planEditing(edited.title)
                  : tabGroupingStrings.headCounts(scan?.tabs.length ?? workspaces.flatMap((item) => item.panes.flatMap((pane) => pane.tabs)).length, workspaces.length)}
                {analysisGeneratedAt !== null
                  ? ` / ${groupingPreparedTime(analysisGeneratedAt)}${resultReadOnly ? "時点・参考表示" : "生成"}`
                  : ""}
              </div>
            </div>
          </div>
          <nav className="cmux-tab-grouping-steps" aria-label={tabGroupingStrings.stepsAriaLabel}>
            {([
              ["compare", tabGroupingStrings.stepCompare],
              ["edit", tabGroupingStrings.stepEdit],
              ["confirm", tabGroupingStrings.stepConfirm],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`cmux-tab-grouping-step${stepStates[id] === "current" ? " is-active" : ""}${stepStates[id] === "done" ? " is-done" : ""}`}
                aria-current={stepStates[id] === "current" ? "step" : undefined}
                disabled={stepStates[id] === "locked"}
                onClick={() => enterMode(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <button type="button" className="cmux-tab-grouping-button is-ghost" disabled={applying} onClick={requestClose}>{tabGroupingStrings.close}</button>
        </header>
        <div className="cmux-tab-grouping-announcer" role="status" aria-live="polite">
          {liveAnnounce}
        </div>
        <div id="cmux-tab-grouping-drop-picker-hint" className="cmux-tab-grouping-announcer">
          {tabGroupingStrings.dropPickerHint}
        </div>

        <div className={`cmux-tab-grouping-body is-${mode}${applying ? " is-locked" : ""}`}>
          {mode === "compare" ? (
            <>
              <div className="cmux-tab-grouping-col">
                {analyzing ? (
                  <div className="cmux-tab-grouping-note">
                    <div>{analysisProgress}</div>
                    {analysisElapsedSeconds >= 60 ? <div>{tabGroupingStrings.analysisSlowHint}</div> : null}
                  </div>
                ) : null}
                {comparisonInsufficient ? <div className="cmux-tab-grouping-note">{tabGroupingStrings.comparisonInsufficient}</div> : null}
                {parseError ? <div className="cmux-tab-grouping-error">{parseError}</div> : null}
                {raw && parseError ? <pre className="cmux-tab-grouping-raw">{raw}</pre> : null}
                {displayedPlans.map((plan) => {
                  const displayedPlan = editedByPlan[plan.planId]?.plan ?? plan;
                  const stats = planCardStats(displayedPlan, scan?.baseline ?? []);
                  return (
                    <button
                      type="button"
                      key={plan.planId}
                      role="radio"
                      aria-checked={selectedPlanId === plan.planId}
                      data-strategy={plan.strategy}
                      className={`cmux-tab-grouping-card${selectedPlanId === plan.planId ? " is-selected" : ""}`}
                      onClick={() => {
                        setSelectedPlanId(plan.planId);
                        setSelectedGroupId(displayedPlan.groups[0]?.groupId ?? null);
                        setSelectedTabIds(new Set());
                        setMoveOpen(false);
                        setDestinationOpen(false);
                      }}
                    >
                      <div className="cmux-tab-grouping-card-title">
                        <span>{plan.title}</span>
                        <span className="cmux-tab-grouping-meta">{strategyLabel(plan.strategy)}</span>
                      </div>
                      <div>{plan.rationale}</div>
                      <div className="cmux-tab-grouping-stats">
                        <span className="cmux-tab-grouping-stat">{tabGroupingStrings.movedCount(stats.moved)}</span>
                        <span className="cmux-tab-grouping-stat">{tabGroupingStrings.newWorkspaceCount(stats.newWorkspaces)}</span>
                        <span className="cmux-tab-grouping-stat">{tabGroupingStrings.keptCount(stats.kept)}</span>
                        {displayedPlan.unassignedTabIds.length > 0 ? (
                          <span className="cmux-tab-grouping-stat is-warn">{tabGroupingStrings.unassignedCount(displayedPlan.unassignedTabIds.length)}</span>
                        ) : null}
                        {stats.warnings > 0 ? <span className="cmux-tab-grouping-stat">{tabGroupingStrings.warningCount(stats.warnings)}</span> : null}
                      </div>
                      {displayedPlan.warnings.length > 0 ? (
                        <ul className="cmux-tab-grouping-note">
                          {displayedPlan.warnings.map((warning, index) => (
                            <li key={`${plan.planId}-${warning.code}-${index}`}>
                              {warning.message} ({warning.tabIds.map((tabId) => tabName(scan?.tabs.find((item) => item.id === tabId)?.label)).join(", ")})
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <div className="cmux-tab-grouping-col">
                <div className="cmux-tab-grouping-preview-head">
                  <span>{showCurrent ? tabGroupingStrings.confirmCurrent : tabGroupingStrings.confirmAfter}</span>
                  <button
                    type="button"
                    className={`cmux-tab-grouping-button${showCurrent ? " is-primary" : ""}`}
                    aria-pressed={showCurrent}
                    onClick={() => setShowCurrent((value) => !value)}
                  >
                    {showCurrent ? tabGroupingStrings.showAfter : tabGroupingStrings.showCurrent}
                  </button>
                </div>
                <div className="cmux-tab-grouping-note">{tabGroupingStrings.previewLegend}</div>
                {edited ? (
                  <PreviewWorkspaces
                    workspaces={previewWorkspaces}
                    current={previewCurrent}
                    plan={edited}
                    view={showCurrent ? "current" : "after"}
                    highlightMoved={highlightMoved}
                    attentionCategoryByTabId={attentionCategoryByTabId}
                  />
                ) : null}
              </div>
            </>
          ) : null}

          {mode === "edit" && edited && selectedPlanId ? (
            <>
              <div className="cmux-tab-grouping-col">
                {editStats ? (
                  <div className="cmux-tab-grouping-editsummary">
                    {tabGroupingStrings.editSummary(
                      editStats.moved,
                      Math.max(0, editStats.kept - edited.unassignedTabIds.length),
                      edited.unassignedTabIds.length,
                    )}
                    {selectedTabIds.size > 0 ? ` / ${tabGroupingStrings.selectedTabs(selectedTabIds.size)}` : ""}
                  </div>
                ) : null}
                {selectedGroup ? (
                  <div className="cmux-tab-grouping-dest">
                    <strong>{tabGroupingStrings.destinationHeading(selectedDestinationName)}</strong>
                    <span className="cmux-tab-grouping-note">{tabGroupingStrings.selectHint}</span>
                    <button
                      ref={destinationTriggerRef}
                      type="button"
                      className="cmux-tab-grouping-button"
                      aria-haspopup="menu"
                      aria-expanded={destinationOpen}
                      onClick={() => setDestinationOpen((value) => !value)}
                    >
                      {tabGroupingStrings.changeDestination}
                    </button>
                    {destinationOpen ? (
                      <div
                        ref={destinationMenuRef}
                        className="cmux-tab-grouping-popover"
                        role="menu"
                        aria-label={tabGroupingStrings.changeDestination}
                        onKeyDown={(event) => handleMenuKeyDown(
                          event,
                          () => setDestinationOpen(false),
                          () => destinationTriggerRef.current?.focus(),
                        )}
                      >
                        {([
                          { kind: "current_locations" } satisfies GroupingDestination,
                          ...workspaces.map((workspace) => ({
                            kind: "existing_workspace",
                            workspaceId: workspace.id,
                          }) as GroupingDestination),
                          {
                            kind: "new_workspace",
                            proposedName: selectedGroup.destination.kind === "new_workspace"
                              ? selectedGroup.destination.proposedName
                              : selectedGroup.title,
                          } satisfies GroupingDestination,
                        ]).map((destination) => (
                          <button
                            type="button"
                            role="menuitem"
                            key={JSON.stringify(destination)}
                            className="cmux-tab-grouping-button"
                            onClick={() => {
                              runEditCommand(selectedPlanId, {
                                kind: "set_group_destination",
                                groupId: selectedGroup.groupId,
                                destination,
                              });
                              setDestinationOpen(false);
                              destinationTriggerRef.current?.focus();
                            }}
                          >
                            {destination.kind === "current_locations"
                              ? tabGroupingStrings.destinationCurrent
                              : destination.kind === "new_workspace"
                                ? tabGroupingStrings.destinationNew
                                : workspaces.find((workspace) => workspace.id === destination.workspaceId)?.name
                                  ?? destination.workspaceId}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {edited.groups.map((group) => {
                  const isReorganize = group.adopted && group.disposition === "reorganize";
                  const reorganizeDestination = group.destination.kind !== "current_locations"
                    ? group.destination
                    : { kind: "new_workspace" as const, proposedName: group.title };
                  const beginGroupRename = () => {
                    setSelectedGroupId(group.groupId);
                    setNameEdit({ kind: "group", groupId: group.groupId });
                    setNameDraft(group.title);
                  };
                  return (
                    <div
                      key={group.groupId}
                      className={`cmux-tab-grouping-group${selectedGroup?.groupId === group.groupId ? " is-selected" : ""}${isReorganize ? "" : " is-deferred"}${editErrors.some((error) => error.includes(group.title) || error.includes(group.groupId)) ? " is-error" : ""}`}
                      onClick={() => setSelectedGroupId(group.groupId)}
                      onKeyDown={(event) => {
                        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                          setSelectedGroupId(group.groupId);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="cmux-tab-grouping-group-head">
                        <div className="cmux-tab-grouping-group-title" onDoubleClick={(event) => {
                          event.stopPropagation();
                          beginGroupRename();
                        }}>
                          {nameEdit?.kind === "group" && nameEdit.groupId === group.groupId
                            ? renderNameInput()
                            : group.title}
                        </div>
                        <button
                          type="button"
                          className="cmux-tab-grouping-button is-ghost"
                          aria-label={`${tabGroupingStrings.renameLabel}: ${group.title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            beginGroupRename();
                          }}
                        >
                          ✎
                        </button>
                      </div>
                      <div className="cmux-tab-grouping-choice" role="radiogroup" aria-label={tabGroupingStrings.dispositionLabel(group.title)}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={isReorganize}
                          className={`cmux-tab-grouping-choice-item${isReorganize ? " is-active" : ""}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!isReorganize) runEditCommand(selectedPlanId, {
                              kind: "set_group_destination",
                              groupId: group.groupId,
                              destination: reorganizeDestination,
                            });
                          }}
                        >
                          {tabGroupingStrings.dispositionReorganize}
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={!isReorganize}
                          className={`cmux-tab-grouping-choice-item${!isReorganize ? " is-active" : ""}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (isReorganize) runEditCommand(selectedPlanId, {
                              kind: "set_group_destination",
                              groupId: group.groupId,
                              destination: { kind: "current_locations" },
                            });
                          }}
                        >
                          {tabGroupingStrings.dispositionKeep}
                        </button>
                      </div>
                      {isReorganize && group.destination.kind === "new_workspace" ? (
                        <div className="cmux-tab-grouping-dest">
                          <strong onClick={(event) => {
                            event.stopPropagation();
                            setSelectedGroupId(group.groupId);
                            setNameEdit({ kind: "workspace", groupId: group.groupId });
                            setNameDraft(group.destination.kind === "new_workspace" ? group.destination.proposedName : "");
                          }}>
                            {nameEdit?.kind === "workspace" && nameEdit.groupId === group.groupId
                              ? renderNameInput()
                              : tabGroupingStrings.destinationHeading(group.destination.proposedName)}
                          </strong>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                <div
                  className="cmux-tab-grouping-tray"
                  data-drop-id="keep-current"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    if (groupingDropIdFromClick(event) === "keep-current") keepSelectionCurrent();
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                    event.preventDefault();
                    keepSelectionCurrent();
                  }}
                >
                  <div className="cmux-tab-grouping-group-title">{tabGroupingStrings.unassignedTitle}</div>
                  <div className="cmux-tab-grouping-note">{tabGroupingStrings.keepTrayHint}</div>
                  {edited.unassignedTabIds.map((tabId) => {
                    const tab = scan?.tabs.find((item) => item.id === tabId);
                    return (
                      <button
                          type="button"
                          key={tabId}
                          data-grouping-drop-control="chip"
                          aria-pressed={selectedTabIds.has(tabId)}
                          className={`cmux-tab-grouping-chip is-unassigned${selectedTabIds.has(tabId) ? " is-selected" : ""}`}
                          onClick={() => toggleTabSelection(tabId)}
                      >
                        {tabName(tab?.label)}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="cmux-tab-grouping-button"
                  disabled={!editSession || !canUndoGroupingEdit(editSession)}
                  onClick={() => {
                    if (!editSession) return;
                    const next = undoGroupingEdit(editSession);
                    if (next === editSession) return;
                    setEditedByPlan((current) => (
                      current[selectedPlanId] === editSession
                        ? { ...current, [selectedPlanId]: next }
                        : current
                    ));
                  }}
                >
                  {tabGroupingStrings.undoEdit}
                </button>
                <button
                  type="button"
                  className="cmux-tab-grouping-button"
                  disabled={!editSession || !isGroupingEditDirty(editSession)}
                  onClick={() => {
                    if (!editSession) return;
                    const next = resetGroupingEditToAi(editSession);
                    if (next === editSession) return;
                    setEditedByPlan((current) => (
                      current[selectedPlanId] === editSession
                        ? { ...current, [selectedPlanId]: next }
                        : current
                    ));
                  }}
                >
                  {tabGroupingStrings.resetToAiPlan}
                </button>
                {editErrors.map((error) => <div key={error} className="cmux-tab-grouping-error">{error}</div>)}
                {stale.map((issue) => <div key={`${issue.code}-${issue.tabId ?? issue.workspaceId}`} className="cmux-tab-grouping-error">{issue.message}</div>)}
                {applyErrors.map((error) => <div key={error} className="cmux-tab-grouping-error">{error}</div>)}
              </div>
              <div className="cmux-tab-grouping-col">
                <div className="cmux-tab-grouping-preview-head">
                  <span>{tabGroupingStrings.confirmAfter}</span>
                  <button
                    type="button"
                    className={`cmux-tab-grouping-button${changedOnly ? " is-primary" : ""}`}
                    aria-pressed={changedOnly}
                    onClick={() => setChangedOnly((value) => !value)}
                  >
                    {tabGroupingStrings.changedOnly}
                  </button>
                </div>
                <div className="cmux-tab-grouping-note">{tabGroupingStrings.editMapLegend}</div>
                <div ref={editMapRef} className="cmux-tab-grouping-editmap">
                  <PreviewWorkspaces
                    workspaces={editMapWorkspaces}
                    current={workspaces}
                    plan={edited}
                    view="diff"
                    highlightMoved={false}
                    selectedTabIds={selectedTabIds}
                    onToggleTab={toggleTabSelection}
                    onTabPointerDown={onTabPointerDown}
                    showState
                    dropTargets={editDropTargets}
                    onDropTargetClick={moveSelectionTo}
                    renderPaneHeading={(paneRef, title) => {
                      const editing = nameEdit?.kind === "pane" && paneRefKey(nameEdit.pane) === paneRefKey(paneRef);
                      return (
                        <div
                          className="cmux-tab-grouping-editpane-head"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (editing) return;
                            setNameEdit({ kind: "pane", pane: paneRef });
                            setNameDraft(title);
                          }}
                        >
                          {editing ? renderNameInput() : title}
                        </div>
                      );
                    }}
                    attentionCategoryByTabId={attentionCategoryByTabId}
                  />
                  {[...editDropTargets.entries()].flatMap(([dropId, target]) => {
                    if (target.kind !== "group") return [];
                    const group = edited.groups.find((candidate) => candidate.groupId === target.groupId);
                    return [(
                      <div
                        key={dropId}
                        className="cmux-tab-grouping-empty-group-drop"
                        data-drop-id={dropId}
                        role="button"
                        tabIndex={0}
                        aria-label={`${group?.title ?? target.groupId} ${tabGroupingStrings.emptyGroupDropHint}`}
                        onClick={(event) => {
                          if (groupingDropIdFromClick(event) === dropId) moveSelectionTo(dropId);
                        }}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                          event.preventDefault();
                          moveSelectionTo(dropId);
                        }}
                      >
                        <div className="cmux-tab-grouping-group-title">{group?.title ?? target.groupId}</div>
                        <div className="cmux-tab-grouping-note">{tabGroupingStrings.emptyGroupDropHint}</div>
                      </div>
                    )];
                  })}
                  {ghost}
                </div>
                {selectedTabIds.size > 0 ? (
                      <div className="cmux-tab-grouping-selectbar">
                        <span>{tabGroupingStrings.selectedTabs(selectedTabIds.size)}</span>
                        <button
                          type="button"
                          className="cmux-tab-grouping-button"
                          onClick={keepSelectionCurrent}
                        >
                          {tabGroupingStrings.excludeToCurrent}
                        </button>
                        <button
                          ref={moveTriggerRef}
                          type="button"
                          className="cmux-tab-grouping-button"
                          aria-haspopup="menu"
                          aria-expanded={moveOpen}
                          onClick={() => setMoveOpen((value) => !value)}
                        >
                          {tabGroupingStrings.moveSelected}
                        </button>
                        {moveOpen ? (
                          <div
                            ref={moveMenuRef}
                            className="cmux-tab-grouping-popover"
                            role="menu"
                            aria-label={tabGroupingStrings.moveSelected}
                            onKeyDown={(event) => handleMenuKeyDown(
                              event,
                              () => setMoveOpen(false),
                              () => moveTriggerRef.current?.focus(),
                            )}
                          >
                            {edited.groups.flatMap((group) => {
                              const paneTargets = group.layout
                                ? group.layout.columns.flatMap((column, columnIndex) => (
                                  column.panes.map((pane, paneIndex) => {
                                    const ref = { groupId: group.groupId, columnIndex, paneIndex };
                                    return {
                                      paneTitle: pane.title,
                                      target: { kind: "pane" as const, ...ref },
                                    };
                                  })
                                ))
                                : [{
                                  paneTitle: group.title,
                                  target: { kind: "group" as const, groupId: group.groupId },
                                }];
                              return paneTargets.map(({ paneTitle, target }) => (
                                  <button
                                    type="button"
                                    role="menuitem"
                                  key={groupingDropIdForTarget(target)}
                                  className="cmux-tab-grouping-button"
                                  onClick={() => {
                                    moveSelectedToTarget(
                                      target,
                                      tabGroupingStrings.dropDestinationLabel(group.title, paneTitle),
                                    );
                                    setMoveOpen(false);
                                    moveTriggerRef.current?.focus();
                                  }}
                                >
                                  {group.title} / {paneTitle}
                                </button>
                              ));
                            })}
                            <button
                              type="button"
                              role="menuitem"
                              className="cmux-tab-grouping-button"
                              onClick={() => {
                                keepSelectionCurrent();
                                setMoveOpen(false);
                                moveTriggerRef.current?.focus();
                              }}
                            >
                              {tabGroupingStrings.destinationCurrent}
                            </button>
                            <div className="cmux-tab-grouping-popover-sep" role="separator" />
                            <button
                              type="button"
                              role="menuitem"
                              className="cmux-tab-grouping-button"
                              onClick={() => {
                                runEditCommand(selectedPlanId, {
                                  kind: "create_group",
                                  title: tabGroupingStrings.newGroupTitle,
                                  tabIds: [...selectedTabIds],
                                });
                                setSelectedTabIds(new Set());
                                setMoveOpen(false);
                                moveTriggerRef.current?.focus();
                              }}
                            >
                              {tabGroupingStrings.newGroup}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
              </div>
            </>
          ) : null}

          {mode === "confirm" && (edited || reviewApplied) ? (
            <div className="cmux-tab-grouping-col">
              <div className="cmux-tab-grouping-actions">
                {(["side-by-side", "current", "after", "diff"] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`cmux-tab-grouping-button${confirmView === id ? " is-primary" : ""}`}
                    aria-pressed={confirmView === id}
                    onClick={() => setConfirmView(id)}
                  >
                    {id === "side-by-side"
                      ? tabGroupingStrings.confirmSideBySide
                      : id === "diff"
                        ? tabGroupingStrings.confirmDiff
                        : id === "after"
                          ? tabGroupingStrings.confirmAfter
                          : tabGroupingStrings.confirmCurrent}
                  </button>
                ))}
                {!applied
                  && !applying
                  && !ticket
                  && preparedPlan === edited
                  && applyErrors.length > 0 ? (
                  <button
                    type="button"
                    className="cmux-tab-grouping-button"
                    onClick={() => {
                      setPreparedPlan(null);
                      setTicket(null);
                      setPreparedLayoutRevision(null);
                      setApplyErrors([]);
                      setStale([]);
                    }}
                  >
                    {tabGroupingStrings.retryPrepare}
                  </button>
                ) : null}
              </div>
              {status === tabGroupingStrings.ticketInvalidated && applyErrors.length > 0 ? (
                <div className="cmux-tab-grouping-error">
                  <div>{tabGroupingStrings.ticketInvalidated}</div>
                  <div>{stale[0]?.message ?? applyErrors[0]}</div>
                </div>
              ) : null}
              {displayedCompiled && !displayedCompiled.ok ? (
                <div className="cmux-tab-grouping-error">
                  {displayedCompiled.stale.length > 0
                    ? tabGroupingStrings.applyBlocked
                    : "kind" in displayedCompiled
                      ? groupingPreviewFailureMessage(displayedCompiled)
                      : displayedCompiled.errors.join(" / ")}
                  {displayedCompiled.stale.map((issue) => <div key={`${issue.code}-${issue.tabId ?? issue.workspaceId}`}>{issue.message}</div>)}
                </div>
              ) : null}
              {applied && editErrors.length > 0 ? (
                <div className="cmux-tab-grouping-error">{editErrors[0]}</div>
              ) : null}
              {!applied && displayedCompiled?.ok && edited ? (
                <div className="cmux-tab-grouping-summary">
                  <div>
                    {tabGroupingStrings.confirmSummary(
                      displayedCompiled.transaction.expected.movedTabIds.length,
                      edited.groups.filter((group) => group.adopted && group.disposition === "reorganize" && group.destination.kind === "new_workspace").length,
                      displayedCompiled.transaction.expected.keptTabIds.length,
                    )}
                  </div>
                  <div>{tabGroupingStrings.confirmSummaryNote}</div>
                  {displayedCompiled.transaction.expected.emptyWorkspaceIds.length > 0 ? (
                    <div>{tabGroupingStrings.emptyWorkspaces(displayedCompiled.transaction.expected.emptyWorkspaceIds.length)} {tabGroupingStrings.notDeleted}</div>
                  ) : null}
                </div>
              ) : null}
              {confirmView === "side-by-side" ? (
                <GroupingSideBySide
                  key={`side-by-side-${confirmationMovedTabIds.size}`}
                  before={previewCurrent}
                  after={previewAfter}
                  plan={edited}
                  highlightMoved={highlightMoved}
                  attentionCategoryByTabId={attentionCategoryByTabId}
                  applyAnimationEnabled={applyMotionEnabled}
                  startApplyAnimationRef={startApplyAnimationRef}
                  landingDraftRef={landingDraftRef}
                  onLineFocusChange={(active) => {
                    sideBySideLineFocusRef.current = active;
                  }}
                  clearFocusRef={clearSideBySideFocusRef}
                />
              ) : (
                <PreviewWorkspaces
                  workspaces={previewWorkspaces}
                  current={previewCurrent}
                  plan={edited}
                  view={confirmView}
                  highlightMoved={confirmView !== "current" && highlightMoved}
                  movedTabIds={confirmView === "current" ? new Set<string>() : confirmationMovedTabIds}
                  attentionCategoryByTabId={attentionCategoryByTabId}
                />
              )}
            </div>
          ) : null}
        </div>

        {applying ? (
          <div className="cmux-tab-grouping-announcer" aria-live="polite">
            {tabGroupingStrings.applying}
          </div>
        ) : null}

        <footer className="cmux-tab-grouping-footer">
          <div className="cmux-tab-grouping-footer-left">
            <button type="button" className="cmux-tab-grouping-button" disabled={analyzing || applying} onClick={() => void analyze(true)}>
              {tabGroupingStrings.analyzeAgain}
            </button>
            <div className="cmux-tab-grouping-note">
              {mode === "compare" && currentPlanStats ? `${tabGroupingStrings.planMoveNote(currentPlanStats.moved)} / ` : ""}
              {formatGroupingAiNote(aiProvider, aiModel, aiEnabled)}
              {editErrors.length > 0 ? ` / ${editErrors.join(" / ")}` : ""}
              {status !== tabGroupingStrings.ticketInvalidated && stale.length > 0
                ? ` / ${stale.map((issue) => issue.message).join(" / ")}`
                : ""}
              {status !== tabGroupingStrings.ticketInvalidated && applyErrors.length > 0
                ? ` / ${applyErrors.join(" / ")}`
                : ""}
            </div>
          </div>
          <div className="cmux-tab-grouping-actions">
            {undo && undoDismissed ? (
              <button type="button" className="cmux-tab-grouping-button" onClick={() => setUndoDismissed(false)}>
                {tabGroupingStrings.recallUndo}
              </button>
            ) : null}
            {previousStep ? (
              <button
                type="button"
                className="cmux-tab-grouping-button"
                disabled={stepStates[previousStep] === "locked"}
                onClick={() => enterMode(previousStep)}
              >
                {mode === "edit" ? tabGroupingStrings.backToCompare : tabGroupingStrings.backToEdit}
              </button>
            ) : null}
            {mode === "compare" ? (
              <>
                <button
                  type="button"
                  className="cmux-tab-grouping-button is-primary"
                  disabled={resultReadOnly || !edited || analyzing || applying || Boolean(applied) || plans.length === 0 || Boolean(parseError) || editErrors.length > 0 || Boolean(displayedCompiled && !displayedCompiled.ok) || (displayedCompiled?.ok === true && displayedCompiled.transaction.expected.movedTabIds.length === 0)}
                  onClick={() => enterMode("confirm")}
                >
                  {tabGroupingStrings.confirmPlan}
                </button>
                <button
                  type="button"
                  className="cmux-tab-grouping-button"
                  disabled={resultReadOnly || !edited || analyzing || applying || Boolean(applied) || plans.length === 0 || Boolean(parseError)}
                  onClick={() => enterMode("edit")}
                >
                  {tabGroupingStrings.editPlan}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="cmux-tab-grouping-button is-primary"
                disabled={resultReadOnly || !edited || analyzing || applying || Boolean(applied) || plans.length === 0 || Boolean(parseError) || editErrors.length > 0 || (mode === "confirm" && (!ticket || preparedPlan !== edited || confirmationInvalidated)) || Boolean(displayedCompiled && !displayedCompiled.ok) || (displayedCompiled?.ok === true && displayedCompiled.transaction.expected.movedTabIds.length === 0)}
                onClick={() => {
                  if (mode === "confirm") apply();
                  else if (nextStep) enterMode(nextStep);
                }}
              >
                {mode === "edit" ? tabGroupingStrings.goConfirm : tabGroupingStrings.apply}
              </button>
            )}
          </div>
        </footer>
        {undo && !undoDismissed ? (
          <div className={`cmux-tab-grouping-undo${canReviewUndo ? "" : " is-expired"}`} data-undo-revision={undo.recordId}>
            <span>{canReviewUndo ? (undo.report ? tabGroupingStrings.undoApplied(undo.report.movedTabCount) : tabGroupingStrings.undoAppliedUnknown) : (undo.expireReason ?? tabGroupingStrings.undoExpired)}</span>
            {undo.report && undo.report.emptyWorkspaceIds.length > 0 ? (
              <span>{tabGroupingStrings.emptyWorkspaces(undo.report.emptyWorkspaceIds.length)} {tabGroupingStrings.notDeleted}</span>
            ) : null}
            {durabilityMessage ? (
              <span className="cmux-tab-grouping-note" data-durability={durabilityStatus}>{durabilityMessage}</span>
            ) : null}
            <div className="cmux-tab-grouping-actions">
              <button type="button" className="cmux-tab-grouping-button" disabled={!canReviewUndo} onClick={undoGrouping}>
                {tabGroupingStrings.undo}
              </button>
              <button type="button" className="cmux-tab-grouping-button" disabled={!canReviewApplied} onClick={() => { setReviewApplied(true); setMode("confirm"); }}>
                {tabGroupingStrings.undoReview}
              </button>
              <button type="button" className="cmux-tab-grouping-button is-ghost" aria-label={tabGroupingStrings.undoDismissLabel} onClick={() => setUndoDismissed(true)}>×</button>
            </div>
          </div>
        ) : null}
      </div>
    </OverlayShell>
  );
}

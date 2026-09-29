import { useEffect, useMemo, useRef, useState } from "react";

import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import {
  buildMentionCandidates,
  type MentionCandidate,
  type MentionToken,
} from "../../lib/mentionModel";
import {
  workorderCancel,
  workorderCreateDraft,
  workorderGo,
  workorderPreview,
  workorderRefreshSources,
  workorderRetrySpawn,
  type WorkOrderPreview,
} from "../../lib/workOrderCommands";
import { useComposerStore } from "../../stores/composerStore";
import { useWorkOrderStore, type WorkOrderContractState } from "../../stores/workOrderStore";
import type { DashboardCardModel } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";
import {
  buildContractDraft,
  compileWorkOrderPlan,
  integratorProblem,
  shouldOfferContract,
  type ContractDraft,
  type ContractParticipant,
  type ContractRole,
} from "./workOrderModel";

const EMPTY_TOKENS: MentionToken[] = [];
const newIntegratorId = "integrator-pending";
const inputDebounceMs = 500;
const launchPollMs = 1_000;
const replacementQueueBySession = new Map<string, Promise<void>>();

interface ContractCoverage {
  target: number;
  acquired: number;
  missing: number;
  failed: number;
}

type SetContract = ReturnType<typeof useWorkOrderStore.getState>["setContract"];

function roleName(role: ContractRole): string {
  if (role === "material") return dashboardStrings.contractRoleMaterial;
  if (role === "work") return dashboardStrings.contractRoleWork;
  if (role === "integrator") return dashboardStrings.contractRoleIntegrator;
  return dashboardStrings.contractRoleReview;
}

function coverageFor(draft: ContractDraft, candidates: readonly MentionCandidate[], preview: WorkOrderPreview | null): ContractCoverage {
  const materials = draft.participants.filter((participant) => participant.role === "material");
  const sourceBySession = new Map((preview?.sources ?? []).map((source) => [source.logicalSessionId, source]));
  let acquired = 0;
  let failed = 0;
  for (const participant of materials) {
    const candidate = candidates.find((entry) => String(entry.logicalSessionId) === participant.logicalSessionId);
    const source = candidate ? sourceBySession.get(candidate.sessionId) : undefined;
    if (source?.acquired) acquired += 1;
    else if (source?.failureReason) failed += 1;
  }
  return {
    target: materials.length,
    acquired,
    failed,
    missing: Math.max(0, materials.length - acquired - failed),
  };
}

function referenceText(draft: ContractDraft, candidates: readonly MentionCandidate[], preview: WorkOrderPreview | null): string {
  const sources = new Map((preview?.sources ?? []).map((source) => [source.logicalSessionId, source]));
  const references = draft.participants
    .filter((participant) => participant.role === "material")
    .flatMap((participant) => {
      const candidate = candidates.find((entry) => String(entry.logicalSessionId) === participant.logicalSessionId);
      const eventId = candidate ? sources.get(candidate.sessionId)?.snapshotEventId : null;
      return eventId ? [dashboardStrings.contractReference(participant.label, eventId)] : [];
    });
  return references.length ? references.join(dashboardStrings.contractReferenceSeparator) : dashboardStrings.contractReferencePending;
}

function updateRole(draft: ContractDraft, logicalSessionId: string, role: ContractRole): ContractDraft {
  if (logicalSessionId === newIntegratorId) {
    return { ...draft, needsNewIntegrator: role === "integrator" };
  }
  return {
    ...draft,
    participants: draft.participants.map((participant) => (
      participant.logicalSessionId === logicalSessionId ? { ...participant, role } : participant
    )),
  };
}

function applyManualRoles(
  draft: ContractDraft,
  manualRoles: WorkOrderContractState["manualRoles"],
): ContractDraft {
  const pendingRole = manualRoles[newIntegratorId];
  return {
    ...draft,
    participants: draft.participants.map((participant) => ({
      ...participant,
      role: manualRoles[participant.logicalSessionId] ?? participant.role,
    })),
    needsNewIntegrator: pendingRole ? pendingRole === "integrator" : draft.needsNewIntegrator,
  };
}

function roleAssignmentKey(draft: ContractDraft): string {
  return [
    ...draft.participants.map((participant) => `${participant.logicalSessionId}:${participant.role}`),
    `${newIntegratorId}:${draft.needsNewIntegrator ? "integrator" : "none"}`,
  ].join("|");
}

function initialState(
  sourceSignature: string,
  draft: ContractDraft,
  manualRoles: WorkOrderContractState["manualRoles"],
  requestRevision: number,
  phase: WorkOrderContractState["phase"],
): WorkOrderContractState {
  return {
    sourceSignature,
    previewKey: `${sourceSignature}\n${roleAssignmentKey(draft)}`,
    requestRevision,
    draft,
    manualRoles,
    workOrderId: null,
    preview: null,
    phase,
    error: null,
    notice: null,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function userFacingError(error: unknown): string {
  const raw = errorText(error);
  if (/not a git repository/i.test(raw)) return dashboardStrings.contractRepositoryUnavailable;
  if (/source snapshots not ready|no livebrief snapshot|source.+not ready/i.test(raw)) {
    return dashboardStrings.contractSourceAcquisitionFailed;
  }
  if (/already.?sealed|already started/i.test(raw)) return dashboardStrings.contractAlreadyStarted;
  return dashboardStrings.contractOperationFailed;
}

function redactPathFragments(value: string): string {
  const hidden = dashboardStrings.contractHiddenPath;
  return value
    .replace(/(?:\\\\\?\\)?[A-Za-z]:[\\/][^\s"'`]+/g, hidden)
    .replace(/\\\\[^\\\s]+\\[^\s"'`]+/g, hidden)
    .replace(/(^|[\s([{:;=])\.\.?[\\/][^\s"'`]+/gm, (_match, prefix: string) => `${prefix}${hidden}`)
    .replace(/(^|[\s([{:;=])\/[^\s"'`]+/gm, (_match, prefix: string) => `${prefix}${hidden}`);
}

function safeDisplayText(value: string): string {
  return redactPathFragments(value)
    .replace(/\bwork[ _-]?orders?\b/gi, "実行契約")
    .replace(/\bworktrees?\b/gi, "作業フォルダ")
    .replace(/\boutbox(?:es)?\b/gi, "起動要求")
    .replace(/\bintegrators?\b/gi, "統合役")
    .replace(/\bsources?\b/gi, "素材")
    .replace(/\bcoverages?\b/gi, "取得状況")
    .replace(/\bseal(?:ed)?\b/gi, "確定済み");
}

function launchFailureReason(reason: string | null): string {
  if (!reason) return dashboardStrings.contractLaunchFailureUnknown;
  if (/frontend failed|did not return a session id/i.test(reason)) return dashboardStrings.contractLaunchFailureFrontend;
  if (/\bemit\s+work[ _-]?orders?\s+spawn\s+request\b|\bspawn\s+request\b/i.test(reason)) {
    return dashboardStrings.contractLaunchFailureUnknown;
  }
  return safeDisplayText(reason);
}

function retryFailureReason(error: unknown): string {
  const raw = errorText(error);
  const classified = userFacingError(error);
  if (classified !== dashboardStrings.contractOperationFailed) return classified;
  return /[A-Za-z]/.test(raw) ? dashboardStrings.contractLaunchFailureUnknown : safeDisplayText(raw);
}

function promptFailureReason(reason: string): string {
  if (/no livebrief snapshot for pty session/i.test(reason)) return dashboardStrings.contractPromptSnapshotUnavailable;
  if (/livebrief telemetry is\b/i.test(reason)) return dashboardStrings.contractPromptTelemetryUnavailable;
  return dashboardStrings.contractPromptStatusUnavailable;
}

function formatIntegratorPrompt(value: string, candidates: readonly MentionCandidate[]): string {
  const labelBySessionId = new Map(candidates.map((candidate) => [candidate.sessionId, candidate.label]));
  const sourceName = (sessionId: string): string => labelBySessionId.get(sessionId) ?? dashboardStrings.contractSourceNameUnknown;
  const formatted = value
    .replace(/^(###\s*素材\d+:\s*)([^\r\n]+)$/gm, (_match, prefix: string, sessionId: string) => `${prefix}${sourceName(sessionId)}`)
    .replace(/(素材\d+\s*\()([^)\r\n]+)(\))/g, (_match, prefix: string, sessionId: string, suffix: string) => `${prefix}${sourceName(sessionId)}${suffix}`)
    .replace(/^理由:\s*.*$/gm, (_match) => `理由: ${promptFailureReason(_match.slice("理由:".length).trim())}`);
  return safeDisplayText(formatted);
}

function launchRequest(preview: WorkOrderPreview | null): WorkOrderPreview["outbox"][number] | null {
  return preview?.outbox.find((entry) => entry.intentKind === "spawn") ?? null;
}

async function cancelQuietly(workOrderId: string): Promise<void> {
  try {
    await workorderCancel(workOrderId);
  } catch {
    // A stale draft must not replace the active card even if cleanup fails.
  }
}

async function replaceContractPreview({
  sessionId,
  next,
  previousWorkOrderId,
  candidates,
  cwd,
  setContract,
}: {
  sessionId: string;
  next: WorkOrderContractState;
  previousWorkOrderId: string | null;
  candidates: readonly MentionCandidate[];
  cwd: string | null;
  setContract: SetContract;
}): Promise<void> {
  const isCurrent = () => {
    const current = useWorkOrderStore.getState().contractDraftBySession[sessionId];
    return current?.previewKey === next.previewKey && current.requestRevision === next.requestRevision;
  };
  let createdWorkOrderId: string | null = null;
  try {
    if (previousWorkOrderId) await workorderCancel(previousWorkOrderId);
    if (!isCurrent()) return;
    if (integratorProblem(next.draft) !== "none") {
      setContract(sessionId, { ...next, phase: "ready" });
      return;
    }
    const created = await workorderCreateDraft(compileWorkOrderPlan(next.draft, candidates));
    createdWorkOrderId = created.workOrderId;
    if (!isCurrent()) {
      await cancelQuietly(created.workOrderId);
      return;
    }
    await workorderRefreshSources(created.workOrderId);
    if (!isCurrent()) {
      await cancelQuietly(created.workOrderId);
      return;
    }
    const preview = await workorderPreview(created.workOrderId, cwd);
    if (!isCurrent()) {
      await cancelQuietly(created.workOrderId);
      return;
    }
    setContract(sessionId, {
      ...next,
      workOrderId: created.workOrderId,
      preview,
      phase: "ready",
    });
  } catch (error) {
    if (!isCurrent()) {
      if (createdWorkOrderId) await cancelQuietly(createdWorkOrderId);
      return;
    }
    if (createdWorkOrderId) await cancelQuietly(createdWorkOrderId);
    setContract(sessionId, { ...next, phase: "error", error: userFacingError(error) });
  }
}

function queueContractPreview(args: Parameters<typeof replaceContractPreview>[0]): void {
  const previous = replacementQueueBySession.get(args.sessionId) ?? Promise.resolve();
  const queued = previous.then(
    () => replaceContractPreview(args),
    () => replaceContractPreview(args),
  );
  replacementQueueBySession.set(args.sessionId, queued);
  void queued.then(() => {
    if (replacementQueueBySession.get(args.sessionId) === queued) replacementQueueBySession.delete(args.sessionId);
  });
}

function ContractRoleChip({
  participant,
  open,
  onOpen,
  onClose,
  onChoose,
}: {
  participant: ContractParticipant;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChoose: (role: ContractRole) => void;
}) {
  const roles: ContractRole[] = ["material", "work", "integrator", "review"];
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const focusTrigger = () => requestAnimationFrame(() => triggerRef.current?.focus());

  useDismissOnOutside(open, rootRef, (reason) => {
    onClose();
    if (reason === "escape") focusTrigger();
  }, { preventDefaultOnEscape: true });

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return <span ref={rootRef} className="cmux-dashboard-contract-chip-wrap">
    <button
      ref={triggerRef}
      type="button"
      className="cmux-dashboard-mention-token cmux-dashboard-contract-role-chip"
      data-contract-role-for={participant.logicalSessionId}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={dashboardStrings.contractRoleMenuFor(participant.label)}
      onClick={onOpen}
    >
      {/* The "@" marks an existing session. A session that is still to be
          created has no handle to mention, so it is named plainly. */}
      <span>{participant.logicalSessionId === newIntegratorId ? participant.label : `@${participant.label}`}</span>
      <small>{roleName(participant.role)} {dashboardStrings.contractRoleCaret}</small>
    </button>
    {open ? <span
      ref={menuRef}
      className="cmux-dashboard-contract-role-menu"
      role="menu"
      aria-label={dashboardStrings.contractRoleMenuFor(participant.label)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? []);
        const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = (currentIndex + direction + items.length) % items.length;
        items[nextIndex]?.focus();
      }}
    >
      {roles.map((role) => <button
        key={role}
        type="button"
        role="menuitem"
        onClick={() => {
          onChoose(role);
          focusTrigger();
        }}
      >{roleName(role)}</button>)}
    </span> : null}
  </span>;
}

export function WorkOrderContract({
  card,
  mentionTargets,
  reportInboxOpen,
  onFix,
}: {
  card: DashboardCardModel | null;
  mentionTargets: readonly DashboardCardModel[];
  reportInboxOpen: boolean;
  onFix: () => void;
}) {
  const sessionId = card?.tab.sessionId ?? null;
  const text = useComposerStore((state) => (sessionId ? state.draftBySession[sessionId] ?? "" : ""));
  const storedTokens = useComposerStore((state) => (sessionId ? state.mentionTokensBySession[sessionId] : undefined));
  const tokens = storedTokens ?? EMPTY_TOKENS;
  const entry = useWorkOrderStore((state) => (sessionId ? state.contractDraftBySession[sessionId] : undefined));
  const dismissedSignature = useWorkOrderStore((state) => (sessionId ? state.dismissedSignatureBySession[sessionId] : undefined));
  const setContract = useWorkOrderStore((state) => state.setContract);
  const updateContract = useWorkOrderStore((state) => state.updateContract);
  const dismissContract = useWorkOrderStore((state) => state.dismissContract);
  const clearContract = useWorkOrderStore((state) => state.clearContract);
  const [openRoleId, setOpenRoleId] = useState<string | null>(null);
  const [correctionHint, setCorrectionHint] = useState(false);
  const [debouncedInput, setDebouncedInput] = useState({ sessionId, text });
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);

  const candidates = useMemo(() => buildMentionCandidates(mentionTargets.map((target) => ({
    logicalSessionId: target.tab.id,
    sessionId: target.tab.sessionId,
    label: target.label,
    workspaceName: target.workspace.name,
    statusLabel: target.status,
    isWorking: target.status === "working",
  }))).filter((candidate): candidate is MentionCandidate => candidate.kind === "session"), [mentionTargets]);

  useEffect(() => {
    if (debouncedInput.sessionId !== sessionId) {
      setDebouncedInput({ sessionId, text });
      return;
    }
    if (debouncedInput.text === text) return;
    const timer = window.setTimeout(() => setDebouncedInput({ sessionId, text }), inputDebounceMs);
    return () => window.clearTimeout(timer);
  }, [debouncedInput.sessionId, debouncedInput.text, sessionId, text]);

  const effectiveText = debouncedInput.sessionId === sessionId ? debouncedInput.text : text;
  const sessionTokenCount = tokens.filter((token) => token.kind === "session").length;
  const offered = Boolean(sessionId) && shouldOfferContract(effectiveText, sessionTokenCount);
  const sourceSignature = useMemo(() => [
    effectiveText,
    ...tokens.map((token) => token.kind === "session" ? `${token.logicalSessionId}:${token.sessionId}` : token.labelSnapshot),
    ...candidates.map((candidate) => `${candidate.logicalSessionId}:${candidate.sessionId}:${candidate.label}`),
  ].join("\n"), [candidates, effectiveText, tokens]);
  const inferredDraft = useMemo(() => buildContractDraft(effectiveText, [...tokens], candidates), [candidates, effectiveText, tokens]);

  useEffect(() => {
    if (!sessionId || !offered || dismissedSignature === sourceSignature) return;
    const current = useWorkOrderStore.getState().contractDraftBySession[sessionId];
    if (current?.sourceSignature === sourceSignature) return;
    // Once a contract has started, the composer belongs to the running work
    // again. Editing it must not replace the only view of what is running.
    if (current?.phase === "running") return;
    const manualRoles = current?.manualRoles ?? {};
    const draft = applyManualRoles(inferredDraft, manualRoles);
    const next = initialState(sourceSignature, draft, manualRoles, (current?.requestRevision ?? 0) + 1, "preparing");
    setContract(sessionId, next);
    queueContractPreview({
      sessionId,
      next,
      previousWorkOrderId: current?.workOrderId ?? null,
      candidates,
      cwd: card?.metadata?.cwd ?? null,
      setContract,
    });
  }, [candidates, card?.metadata?.cwd, dismissedSignature, inferredDraft, offered, sessionId, setContract, sourceSignature]);

  useEffect(() => {
    if (!sessionId || offered || !entry || entry.phase === "running") return;
    const previousWorkOrderId = entry.workOrderId;
    clearContract(sessionId);
    if (previousWorkOrderId) void cancelQuietly(previousWorkOrderId);
  }, [clearContract, entry, offered, sessionId]);

  const currentLaunch = launchRequest(entry?.preview ?? null);
  useEffect(() => {
    if (!sessionId || entry?.phase !== "running" || !entry.workOrderId) return;
    if (currentLaunch?.status === "delivered" || currentLaunch?.status === "failed") return;
    const workOrderId = entry.workOrderId;
    let active = true;
    const refresh = async () => {
      try {
        const preview = await workorderPreview(workOrderId, card?.metadata?.cwd ?? null);
        if (!active) return;
        updateContract(sessionId, (current) => current.workOrderId === workOrderId
          ? { ...current, preview, notice: current.notice }
          : current);
      } catch (error) {
        if (!active) return;
        updateContract(sessionId, (current) => current.workOrderId === workOrderId
          ? { ...current, notice: userFacingError(error) }
          : current);
      }
    };
    const timer = window.setInterval(() => { void refresh(); }, launchPollMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [card?.metadata?.cwd, currentLaunch?.status, entry?.phase, entry?.workOrderId, sessionId, updateContract]);

  if (!card || !sessionId || !offered || reportInboxOpen || dismissedSignature === sourceSignature) return null;

  // A started contract keeps its own view even once the composer text has moved
  // on: the run in progress is the only thing this card can still report on.
  const state = entry && (entry.phase === "running" || entry.sourceSignature === sourceSignature)
    ? entry
    : initialState(sourceSignature, inferredDraft, {}, 0, "preparing");
  const coverage = coverageFor(state.draft, candidates, state.preview);
  const problem = integratorProblem(state.draft);
  const cwd = card.metadata?.cwd ?? null;
  const missingSources = coverage.missing > 0 || coverage.failed > 0;
  const writeUnavailable = Boolean(state.preview?.writeTarget && "unavailable" in state.preview.writeTarget);
  const blocker = problem === "missing"
    ? dashboardStrings.contractMissingIntegrator
    : problem === "multiple"
      ? dashboardStrings.contractMultipleIntegrators
      : state.phase === "refreshing"
        ? dashboardStrings.contractRefreshing
        : state.phase === "preparing"
          ? dashboardStrings.contractPreparing
          : state.error
            ? state.error
            : !cwd
              ? dashboardStrings.contractWorkingDirectoryUnavailable
              : writeUnavailable
                ? dashboardStrings.contractRepositoryUnavailable
                : missingSources
                  ? dashboardStrings.contractMissingSources
                  : null;

  const setRole = (logicalSessionId: string, role: ContractRole) => {
    setOpenRoleId(null);
    setCorrectionHint(false);
    const current = useWorkOrderStore.getState().contractDraftBySession[sessionId];
    if (!current) return;
    const manualRoles = { ...current.manualRoles, [logicalSessionId]: role };
    const draft = updateRole(current.draft, logicalSessionId, role);
    const next = initialState(
      current.sourceSignature,
      draft,
      manualRoles,
      current.requestRevision + 1,
      integratorProblem(draft) === "none" ? "refreshing" : "ready",
    );
    setContract(sessionId, next);
    queueContractPreview({
      sessionId,
      next,
      previousWorkOrderId: current.workOrderId,
      candidates,
      cwd,
      setContract,
    });
  };

  const cancel = () => {
    void (async () => {
      try {
        if (state.workOrderId) await workorderCancel(state.workOrderId);
        dismissContract(sessionId, sourceSignature);
        clearContract(sessionId);
      } catch (error) {
        updateContract(sessionId, (current) => ({ ...current, phase: "error", error: userFacingError(error) }));
      }
    })();
  };

  const go = () => {
    if (blocker || state.phase === "running" || !state.workOrderId) return;
    void (async () => {
      try {
        const response = await workorderGo(state.workOrderId!, {
          cwd: cwd!,
          agentKind: card.agentKind === "none" ? "codex" : card.agentKind,
          overrideMissingSources: false,
        });
        const preview = await workorderPreview(state.workOrderId!, cwd);
        setContract(sessionId, {
          ...state,
          preview,
          phase: "running",
          error: null,
          notice: response.sealed === "alreadySealed" || !response.spawnRequestId
            ? dashboardStrings.contractAlreadyStarted
            : null,
        });
      } catch (error) {
        setContract(sessionId, { ...state, phase: "error", error: userFacingError(error), notice: null });
      }
    })();
  };

  const retryLaunch = () => {
    if (!state.workOrderId || retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    void (async () => {
      try {
        await workorderRetrySpawn(state.workOrderId!);
        const preview = await workorderPreview(state.workOrderId!, cwd);
        updateContract(sessionId, (current) => current.workOrderId === state.workOrderId
          ? { ...current, preview, notice: null }
          : current);
      } catch (error) {
        updateContract(sessionId, (current) => current.workOrderId === state.workOrderId
          ? { ...current, notice: retryFailureReason(error) }
          : current);
      } finally {
        retryingRef.current = false;
        setRetrying(false);
      }
    })();
  };

  const dismissRunning = () => {
    dismissContract(sessionId, sourceSignature);
    clearContract(sessionId);
  };

  if (state.phase === "running") {
    const request = launchRequest(state.preview);
    const requestStatus = request?.status ?? null;
    const launchLabel = requestStatus === "pending"
      ? dashboardStrings.contractLaunchPending
      : requestStatus === "in_flight"
        ? dashboardStrings.contractLaunchChecking
        : requestStatus === "delivered"
          ? dashboardStrings.contractLaunchDelivered
          : requestStatus === "failed"
            ? dashboardStrings.contractLaunchFailed
            : dashboardStrings.contractLaunchUnknown;
    const sourceStatus = coverage.missing > 0 || coverage.failed > 0
      ? dashboardStrings.contractRunSourcesPartial
      : dashboardStrings.contractRunSourcesAcquired(coverage.acquired);
    return <section className="cmux-dashboard-contract is-running" aria-label={dashboardStrings.contractAfterGoAriaLabel}>
      <header className="cmux-dashboard-contract-head">
        <strong>{state.draft.purpose}</strong>
        {/* A failed launch must not wear the colour of a finished one. */}
        <span className={requestStatus === "failed"
          ? "cmux-dashboard-next-actions-machine-tag is-error"
          : "cmux-dashboard-next-actions-machine-tag"}>{launchLabel}</span>
        <span className="cmux-dashboard-contract-head-note">{dashboardStrings.contractPlanSealed}</span>
      </header>
      <div className="cmux-dashboard-contract-running-list">
        <div><i className={coverage.missing === 0 && coverage.failed === 0 ? "is-complete" : "is-error"} /><span>{dashboardStrings.contractRunSources}</span><small>{sourceStatus}</small></div>
        <div><i className={requestStatus === "delivered" ? "is-complete" : requestStatus === "in_flight" ? "is-active" : requestStatus === "failed" ? "is-error" : ""} /><span>{dashboardStrings.contractRunSession}</span><small>{requestStatus === "failed" ? `${launchLabel}: ${launchFailureReason(request?.reason ?? null)}` : launchLabel}</small></div>
        <div><i /><span>{dashboardStrings.contractRunTests}</span><small>{dashboardStrings.contractRunUnknown}</small></div>
        <div><i /><span>{dashboardStrings.contractRunMerge}</span><small>{dashboardStrings.contractHumanApprovalRequired}</small></div>
      </div>
      <p className="cmux-dashboard-contract-note" role="status" aria-live="polite" aria-atomic="true">{state.notice ?? ""}</p>
      <footer className="cmux-dashboard-contract-foot">
        <span className="cmux-dashboard-contract-spacer" />
        {requestStatus === "failed" ? <button
          type="button"
          className="cmux-dashboard-contract-button is-go"
          disabled={retrying || !state.workOrderId}
          onClick={retryLaunch}
        >{dashboardStrings.contractRetryLaunch}</button> : null}
        <button type="button" className="cmux-dashboard-contract-button" onClick={dismissRunning}>{dashboardStrings.contractDismissRunning}</button>
      </footer>
    </section>;
  }

  const assignedIntegrators = state.draft.participants.filter((participant) => participant.role === "integrator");
  const pendingRole = state.manualRoles[newIntegratorId];
  const pendingParticipant: ContractParticipant | null = assignedIntegrators.length === 0 && (state.draft.needsNewIntegrator || pendingRole)
    ? { logicalSessionId: newIntegratorId, label: dashboardStrings.contractNewSession, role: pendingRole ?? "integrator" }
    : null;
  const writeTarget = state.preview?.writeTarget ?? null;
  const writeText = state.phase === "refreshing"
    ? dashboardStrings.contractWriteRefreshing
    : writeTarget && "unavailable" in writeTarget
      ? dashboardStrings.contractWriteUnavailable
      : writeTarget && "path" in writeTarget
        ? dashboardStrings.contractWriteTarget
        : dashboardStrings.contractWritePending;
  const reference = state.phase === "refreshing"
    ? dashboardStrings.contractReferenceRefreshing
    : referenceText(state.draft, candidates, state.preview);

  return <section className="cmux-dashboard-contract" aria-label={dashboardStrings.contractAriaLabel}>
    <header className="cmux-dashboard-contract-head">
      <strong>{dashboardStrings.contractTitle}</strong>
      <span className="cmux-dashboard-next-actions-ai-tag">{dashboardStrings.contractAiPlan}</span>
      <span className="cmux-dashboard-next-actions-machine-tag">{dashboardStrings.contractMachineNumbers}</span>
      <span className="cmux-dashboard-contract-head-note">{dashboardStrings.contractBeforeGo}</span>
    </header>
    <dl className="cmux-dashboard-contract-rows">
      <dt>{dashboardStrings.contractPurpose}</dt><dd>{state.draft.purpose}</dd>
      <dt>{dashboardStrings.contractMaterials}</dt><dd className="cmux-dashboard-contract-chip-list">
        {state.draft.participants.map((participant) => <ContractRoleChip
          key={participant.logicalSessionId}
          participant={participant}
          open={openRoleId === participant.logicalSessionId}
          onOpen={() => setOpenRoleId((current) => current === participant.logicalSessionId ? null : participant.logicalSessionId)}
          onClose={() => setOpenRoleId(null)}
          onChoose={(role) => setRole(participant.logicalSessionId, role)}
        />)}
      </dd>
      <dt>{dashboardStrings.contractExecution}</dt><dd className="cmux-dashboard-contract-execution">
        {assignedIntegrators.map((participant) => <span key={participant.logicalSessionId} className="cmux-dashboard-contract-new-session">@{participant.label}</span>)}
        {pendingParticipant ? <ContractRoleChip
          participant={pendingParticipant}
          open={openRoleId === pendingParticipant.logicalSessionId}
          onOpen={() => setOpenRoleId((current) => current === pendingParticipant.logicalSessionId ? null : pendingParticipant.logicalSessionId)}
          onClose={() => setOpenRoleId(null)}
          onChoose={(role) => setRole(pendingParticipant.logicalSessionId, role)}
        /> : null}
        <small>{dashboardStrings.contractExecutionDetail(card.agentKind === "none" ? "codex" : card.agentKind)}</small>
      </dd>
      <dt>{dashboardStrings.contractReferenceLabel}</dt><dd className="cmux-dashboard-contract-mono">{reference}</dd>
      <dt>{dashboardStrings.contractWrite}</dt><dd>{writeText} <small>{dashboardStrings.contractBranchProtection}</small></dd>
      <dt>{dashboardStrings.contractCompletion}</dt><dd>{state.draft.doneCondition.join(" ＋ ")}</dd>
      <dt>{dashboardStrings.contractCoverage}</dt><dd className="cmux-dashboard-contract-mono">{dashboardStrings.contractCoverageSummary(coverage.target, coverage.acquired, coverage.missing, coverage.failed)}</dd>
    </dl>
    <details className="cmux-dashboard-contract-fold">
      <summary>{dashboardStrings.contractPromptSummary}</summary>
      <pre>{state.preview ? formatIntegratorPrompt(state.preview.integratorPrompt, candidates) : dashboardStrings.contractPromptPending}</pre>
    </details>
    <p className="cmux-dashboard-contract-note" role="status" aria-live="polite" aria-atomic="true">{blocker ?? (correctionHint ? dashboardStrings.contractCorrectionHint : "")}</p>
    <footer className="cmux-dashboard-contract-foot">
      <span>{dashboardStrings.contractNoSourceSend}</span>
      <span className="cmux-dashboard-contract-spacer" />
      <button type="button" className="cmux-dashboard-contract-button" onClick={() => { setCorrectionHint(true); onFix(); }}>{dashboardStrings.contractFix}</button>
      <button type="button" className="cmux-dashboard-contract-button" onClick={cancel}>{dashboardStrings.contractCancel}</button>
      <button type="button" className="cmux-dashboard-contract-button is-go" disabled={Boolean(blocker)} onClick={go}>{dashboardStrings.contractGo}</button>
    </footer>
  </section>;
}

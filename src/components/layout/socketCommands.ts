import {
  writeToSession,
  writeToSessionGuarded,
  type PtyMetadataSnapshot,
  type SessionOutputSnapshot,
  type SessionStatusSnapshotPayload,
} from "../../lib/ipc";
import type { AgentSessionKind, Pane, PaneTab, Workspace } from "../../types";
import { isDeclaredTab, isRestorableTab, type RestorablePaneTab } from "../../lib/tabLifecycle";
import type { PaneMetadata } from "../../stores/paneMetadataStore";
import { deriveEffectiveStatus } from "../../lib/notificationStatus";
import { paneContainsSession, workspaceContainsSession } from "../../stores/workspaceListStore";
import {
  DEFAULT_LAYOUT_SIZE,
  columnWidthsMatch,
  rowHeightsMatch,
} from "../../lib/layoutMetrics";
import {
  normalizeReadableSplitColumns,
  reconcileSplitColumnsForPanes,
} from "../../lib/layoutColumns";
import { applyLayoutMutation } from "../../lib/layoutMutation";
import { collectPaneCloseVictims } from "../../lib/paneCloseImpact";

type SocketArgs = Record<string, unknown> | null | undefined;
type SpawnTarget = AgentSessionKind | "shell";
export type SpawnMode = "handoff" | "prompt" | "resume" | "shell" | "launch";

export interface SpawnPlan {
  target: SpawnTarget;
  mode: SpawnMode;
  launchEnv?: Record<string, string>;
  paneOptions: {
    agentId: "shell-starter";
    label?: string;
    cwd?: string;
    agentKind?: AgentSessionKind;
    agentSessionId?: string;
    launchEnv?: Record<string, string>;
    activate?: boolean;
  };
}

export interface SpawnTabPlan {
  mode: SpawnMode | "command";
  paneOptions: SpawnPlan["paneOptions"] & {
    commandArgv?: string[];
  };
}

interface ActivationLocation {
  workspace: Workspace;
  pane: Pane;
  tab: PaneTab;
}

export interface ActivationSessionIdentity {
  server_epoch: string;
  session_epoch: number | null;
  pane_id: string;
  tab_id: string;
}

interface ActivationTokenInput {
  previous_session_id: string | null;
  target_session_id: string;
  focus_revision: number;
  previous_session_identity: ActivationSessionIdentity | null;
  target_session_identity: ActivationSessionIdentity;
}

export interface ActivationToken extends ActivationTokenInput {
  /** Socket activation never moves the operator's foreground selection. */
  foreground_changed: false;
  /** True only when a tab was activated inside a non-visible workspace. */
  activation_applied: boolean;
}

function socketArgString(args: SocketArgs, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function socketArgBoolean(args: SocketArgs, key: string, fallback: boolean): boolean {
  const value = args?.[key];
  return typeof value === "boolean" ? value : fallback;
}

function isAgentKind(value: string): value is AgentSessionKind {
  return value === "claude" || value === "codex" || value === "claude-codex" || value === "grok";
}

function spawnTarget(args: SocketArgs): SpawnTarget {
  const target = socketArgString(args, "target");
  if (!target) throw new Error("pane.spawn requires target");
  if (target !== "shell" && !isAgentKind(target)) {
    throw new Error(`unsupported pane.spawn target: ${target}`);
  }
  return target;
}

function optionalAgentKind(args: SocketArgs, ...keys: string[]): AgentSessionKind | undefined {
  const value = socketArgString(args, ...keys);
  if (!value) return undefined;
  if (!isAgentKind(value)) throw new Error(`unsupported agent kind: ${value}`);
  return value;
}

export function resolveSpawnPlan(args: SocketArgs, handoffPromptPath?: string): SpawnPlan {
  const target = spawnTarget(args);
  const label = socketArgString(args, "label");
  const cwd = socketArgString(args, "cwd");
  const handoffFromSessionId = socketArgString(
    args,
    "handoffFromSessionId",
    "handoff_from_session_id",
  );
  const promptFile = socketArgString(args, "promptFile", "prompt_file");
  const resumeSessionId = socketArgString(args, "resumeSessionId", "resume_session_id");
  const paneOptions: SpawnPlan["paneOptions"] = {
    agentId: "shell-starter",
    ...(label ? { label } : {}),
    ...(cwd ? { cwd } : {}),
  };

  if (handoffFromSessionId) {
    if (target === "shell") throw new Error("pane.spawn handoff requires an agent target");
    if (!handoffPromptPath) throw new Error("pane.spawn handoff prompt path is unavailable");
    const handoffFromKind = optionalAgentKind(
      args,
      "handoffFromKind",
      "handoff_from_kind",
    );
    const launchEnv: Record<string, string> = {
      MYCMUX_AGENT_KIND: target,
      MYCMUX_HANDOFF: target,
      MYCMUX_HANDOFF_PROMPT_FILE: handoffPromptPath,
      MYCMUX_HANDOFF_FROM_SESSION: handoffFromSessionId,
      ...(handoffFromKind ? { MYCMUX_HANDOFF_FROM: handoffFromKind } : {}),
    };
    return { target, mode: "handoff", launchEnv, paneOptions: { ...paneOptions, launchEnv } };
  }

  if (promptFile) {
    if (target === "shell") throw new Error("pane.spawn prompt requires an agent target");
    const fromSessionId = socketArgString(args, "fromSessionId", "from_session_id") ?? "external";
    const fromKind = optionalAgentKind(args, "fromKind", "from_kind");
    const launchEnv: Record<string, string> = {
      MYCMUX_AGENT_KIND: target,
      MYCMUX_HANDOFF: target,
      MYCMUX_HANDOFF_PROMPT_FILE: promptFile,
      MYCMUX_HANDOFF_FROM_SESSION: fromSessionId,
      ...(fromKind ? { MYCMUX_HANDOFF_FROM: fromKind } : {}),
    };
    return { target, mode: "prompt", launchEnv, paneOptions: { ...paneOptions, launchEnv } };
  }

  if (resumeSessionId) {
    if (target === "shell") throw new Error("pane.spawn resume requires an agent target");
    const launchEnv: Record<string, string> = {
      MYCMUX_AGENT_KIND: target,
      MYCMUX_RESUME: target,
      MYCMUX_SESSION_ID: resumeSessionId,
    };
    return {
      target,
      mode: "resume",
      launchEnv,
      paneOptions: {
        ...paneOptions,
        agentKind: target,
        agentSessionId: resumeSessionId,
        launchEnv,
      },
    };
  }

  if (target === "shell") return { target, mode: "shell", paneOptions };

  const launchEnv = { MYCMUX_LAUNCH_TARGET: target };
  return { target, mode: "launch", launchEnv, paneOptions: { ...paneOptions, launchEnv } };
}

function socketArgInteger(args: SocketArgs, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
      return value;
    }
  }
  return undefined;
}

function hasSocketArg(args: SocketArgs, ...keys: string[]): boolean {
  return keys.some((key) => args != null && Object.prototype.hasOwnProperty.call(args, key));
}

/**
 * A raw command spawn, shared by pane.spawn and pane.spawn_tab. Both accept
 * commandArgv: `spawn-tab --detach` puts a long-running agent in its own pane
 * so closing the caller's pane cannot take it down, and that only helps if the
 * agent can be launched by argv the way the same-pane route already allows.
 */
function resolveCommandArgvPlan(args: SocketArgs, command: string): SpawnTabPlan {
  const value = args?.commandArgv ?? args?.command_argv;
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`${command} commandArgv must be a non-empty array of non-empty strings`);
  }
  const label = socketArgString(args, "label");
  const cwd = socketArgString(args, "cwd");
  return {
    mode: "command",
    paneOptions: {
      agentId: "shell-starter",
      ...(label ? { label } : {}),
      ...(cwd ? { cwd } : {}),
      commandArgv: value,
    },
  };
}

export function resolveSpawnTabPlan(
  args: SocketArgs,
  handoffPromptPath?: string,
): SpawnTabPlan {
  const hasCommandArgv = hasSocketArg(args, "commandArgv", "command_argv");
  const target = socketArgString(args, "target");
  if (hasCommandArgv && target) {
    throw new Error("pane.spawn_tab accepts either commandArgv or target, not both");
  }

  if (hasCommandArgv) return resolveCommandArgvPlan(args, "pane.spawn_tab");

  if (!target) throw new Error("pane.spawn_tab requires commandArgv or target");
  const plan = resolveSpawnPlan(args, handoffPromptPath);
  return { mode: plan.mode, paneOptions: plan.paneOptions };
}

export function resolveSpawnPanePlan(
  args: SocketArgs,
  handoffPromptPath?: string,
): SpawnTabPlan {
  const hasCommandArgv = hasSocketArg(args, "commandArgv", "command_argv");
  const target = socketArgString(args, "target");
  if (hasCommandArgv && target) {
    throw new Error("pane.spawn accepts either commandArgv or target, not both");
  }
  if (hasCommandArgv) return resolveCommandArgvPlan(args, "pane.spawn");
  const plan = resolveSpawnPlan(args, handoffPromptPath);
  return { mode: plan.mode, paneOptions: plan.paneOptions };
}

export function clampPaneReadLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 80;
  return Math.min(400, Math.max(1, Math.trunc(value)));
}

function serializeWorkspaceForSocket(
  workspace: Workspace,
  activeWorkspaceId: string | null,
) {
  return {
    id: workspace.id,
    name: workspace.name,
    active: workspace.id === activeWorkspaceId,
    status: workspace.status,
    gridTemplateId: workspace.gridTemplateId,
    paneCount: workspace.panes.length,
    tabCount: workspace.panes.reduce((count, pane) => count + pane.tabs.length, 0),
  };
}

export function findPaneBySessionId(
  workspaces: Workspace[],
  sessionId: string,
): { workspace: Workspace; pane: Pane } | null {
  for (const workspace of workspaces) {
    const pane = workspace.panes.find((candidate) => paneContainsSession(candidate, sessionId));
    if (pane) return { workspace, pane };
  }
  return null;
}

function findTabBySessionId(workspaces: Workspace[], sessionId: string): ActivationLocation | null {
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((candidate) => candidate.sessionId === sessionId);
      if (tab) return { workspace, pane, tab };
    }
  }
  return null;
}

function findActiveTabLocation(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  activeSessionId: string | null,
): ActivationLocation | null {
  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId);
  if (!workspace || !activeSessionId) return null;
  const pane = workspace.panes.find((candidate) => paneContainsSession(candidate, activeSessionId));
  if (!pane) return null;
  const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId);
  return tab ? { workspace, pane, tab } : null;
}

function isTerminalLocation(location: ActivationLocation): boolean {
  return location.tab.type === undefined || location.tab.type === "terminal";
}

function snapshotSession(
  snapshot: SessionStatusSnapshotPayload,
  sessionId: string,
) {
  return snapshot.sessions.find((session) => session.session_id === sessionId);
}

function sessionEpoch(
  snapshot: SessionStatusSnapshotPayload,
  sessionId: string,
): number | null {
  return snapshotSession(snapshot, sessionId)?.status.session_epoch ?? null;
}

async function activationSnapshot(
  target: ActivationLocation,
  getSnapshot: () => Promise<SessionStatusSnapshotPayload>,
  initialSnapshot: SessionStatusSnapshotPayload,
): Promise<SessionStatusSnapshotPayload> {
  let snapshot = initialSnapshot;
  if (!isTerminalLocation(target)) return snapshot;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = snapshotSession(snapshot, target.tab.sessionId)?.status;
    if (status?.lifecycle === "alive" && status.session_epoch !== null) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      snapshot = await getSnapshot();
    } catch {
      continue;
    }
  }
  return snapshot;
}

function activationIdentity(
  location: ActivationLocation,
  snapshot: SessionStatusSnapshotPayload,
): ActivationSessionIdentity {
  return {
    server_epoch: snapshot.server_epoch,
    session_epoch: sessionEpoch(snapshot, location.tab.sessionId),
    pane_id: location.pane.id,
    tab_id: location.tab.id,
  };
}

function parseActivationIdentity(value: unknown, name: string): ActivationSessionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`pane.restore_activation requires ${name}`);
  }
  const identity = value as Record<string, unknown>;
  const serverEpoch = identity.server_epoch;
  const sessionEpochValue = identity.session_epoch;
  const paneId = identity.pane_id;
  const tabId = identity.tab_id;
  if (
    typeof serverEpoch !== "string"
    || !serverEpoch
    || (sessionEpochValue !== null
      && (typeof sessionEpochValue !== "number"
        || !Number.isFinite(sessionEpochValue)
        || !Number.isInteger(sessionEpochValue)))
    || typeof paneId !== "string"
    || !paneId
    || typeof tabId !== "string"
    || !tabId
  ) {
    throw new Error(`pane.restore_activation has invalid ${name}`);
  }
  return {
    server_epoch: serverEpoch,
    session_epoch: sessionEpochValue as number | null,
    pane_id: paneId,
    tab_id: tabId,
  };
}

function parseActivationToken(args: SocketArgs): ActivationTokenInput {
  const previousSessionIdValue = args?.previous_session_id;
  const targetSessionId = socketArgString(args, "target_session_id");
  const focusRevision = socketArgInteger(args, "focus_revision");
  if (
    previousSessionIdValue !== null
    && (typeof previousSessionIdValue !== "string" || !previousSessionIdValue.trim())
  ) {
    throw new Error("pane.restore_activation has invalid previous_session_id");
  }
  if (!targetSessionId) {
    throw new Error("pane.restore_activation requires target_session_id");
  }
  if (focusRevision === undefined || focusRevision < 0) {
    throw new Error("pane.restore_activation requires focus_revision");
  }
  const previousIdentityValue = args?.previous_session_identity;
  const previousIdentity = previousSessionIdValue === null
    ? null
    : parseActivationIdentity(previousIdentityValue, "previous_session_identity");
  if (previousSessionIdValue === null && previousIdentityValue !== null) {
    throw new Error("pane.restore_activation has invalid previous_session_identity");
  }
  return {
    previous_session_id: previousSessionIdValue,
    target_session_id: targetSessionId,
    focus_revision: focusRevision,
    previous_session_identity: previousIdentity,
    target_session_identity: parseActivationIdentity(
      args?.target_session_identity,
      "target_session_identity",
    ),
  };
}

function activateLocation(
  location: ActivationLocation,
  stores: typeof import("../../stores/workspaceStore"),
): { activationApplied: boolean } {
  const { useWorkspaceLayoutStore, useWorkspaceListStore } = stores;
  const workspaceState = useWorkspaceListStore.getState();
  // A socket request must never replace the tab the operator is looking at.
  // Background workspaces may still keep their own active tab for later use.
  if (workspaceState.activeWorkspaceId === location.workspace.id) {
    return { activationApplied: false };
  }
  useWorkspaceLayoutStore.getState().setActivePaneTab(
    location.workspace.id,
    location.pane.id,
    location.tab.id,
  );
  return { activationApplied: true };
}

export function serializeWorkspaceLayoutForSocket(workspace: Workspace) {
  const splitColumns = reconcileSplitColumnsForPanes(
    normalizeReadableSplitColumns(workspace.splitColumns ?? []),
    workspace.panes.map((pane) => pane.id),
  );
  const columnWidths = columnWidthsMatch(splitColumns, workspace.columnWidths)
    ? [...workspace.columnWidths!]
    : splitColumns.map(() => DEFAULT_LAYOUT_SIZE);
  const rowHeightsPerCol = rowHeightsMatch(splitColumns, workspace.rowHeightsPerCol)
    ? workspace.rowHeightsPerCol!.map((row) => [...row])
    : splitColumns.map((column) => column.map(() => DEFAULT_LAYOUT_SIZE));
  return {
    splitColumns,
    columnWidths,
    rowHeightsPerCol,
    gridTemplateId: workspace.gridTemplateId,
  };
}

interface PaneSocketSerializationContext {
  activeSessionId: string | null;
  metadata: Record<string, PaneMetadata>;
  processMetadata: PtyMetadataSnapshot;
  processMetadataAvailable: boolean;
  lastOutputBySession: SessionOutputSnapshot;
  isTerminalMounted: (sessionId: string) => boolean;
}

interface ProcessMetadataSnapshotResult {
  metadata: PtyMetadataSnapshot;
  available: boolean;
}

async function loadProcessMetadataSnapshot(): Promise<ProcessMetadataSnapshotResult> {
  try {
    const { getPtyMetadataSnapshot } = await import("../../lib/ipc");
    return { metadata: await getPtyMetadataSnapshot(), available: true };
  } catch {
    return { metadata: {}, available: false };
  }
}

async function loadSessionOutputSnapshot(): Promise<SessionOutputSnapshot> {
  try {
    const { getSessionOutputSnapshot } = await import("../../lib/ipc");
    return await getSessionOutputSnapshot();
  } catch {
    return {};
  }
}

export function processStatusReasonForTab(
  type: PaneTab["type"],
  process: PtyMetadataSnapshot[string] | undefined,
  snapshotAvailable: boolean,
): string | null {
  if (type === "browser" || type === "online" || process?.process_status) return null;
  if (process) return "no_foreground_process";
  return snapshotAvailable ? "no_live_pty_session" : "snapshot_unavailable";
}

export function serializePaneForSocket(
  pane: Pane,
  context: PaneSocketSerializationContext,
  workspace?: Pick<Workspace, "id" | "name">,
) {
  const {
    activeSessionId,
    metadata,
    processMetadata,
    processMetadataAvailable,
    lastOutputBySession,
    isTerminalMounted,
  } = context;
  return {
    ...(workspace ? { workspaceId: workspace.id, workspaceName: workspace.name } : {}),
    id: pane.id,
    active: pane.sessionId === activeSessionId
      || pane.tabs.some((tab) => tab.sessionId === activeSessionId),
    label: pane.label,
    cwd: pane.cwd,
    agentId: pane.agentId,
    agentKind: pane.agentKind,
    tabCount: pane.tabs.length,
    activeTabId: pane.activeTabId,
    tabs: pane.tabs.map((tab) => {
      const tabMetadata = metadata[tab.sessionId];
      const process = processMetadata[tab.sessionId];
      const screenObserved = isTerminalMounted(tab.sessionId);
      return {
        id: tab.id,
        sessionId: tab.sessionId,
        label: tab.label,
        type: tab.type,
        cwd: tab.cwd,
        agentId: tab.agentId,
        agentKind: tab.agentKind,
        claudeSessionId: tab.claudeSessionId,
        agentSessionId: tab.agentSessionId,
        lifecycle: tab.lifecycle,
        declaredTarget: tab.declaredTarget,
        lastProcess: tab.lastProcess,
        agentStatus: tabMetadata?.agentStatus ?? deriveEffectiveStatus(tabMetadata),
        agentStatusAt: tabMetadata?.agentStatusAt ?? null,
        agentStatusStale: !screenObserved,
        processStatus: process?.process_status ?? null,
        // This is the foreground process start time, not an activity observation.
        processStatusAt: process?.process_status_at ?? null,
        lastOutputAt: lastOutputBySession[tab.sessionId] ?? null,
        processStatusReason: processStatusReasonForTab(
          tab.type,
          process,
          processMetadataAvailable,
        ),
        screenStatus: screenObserved ? tabMetadata?.agentStatus ?? null : null,
        screenStatusAt: screenObserved ? tabMetadata?.screenStatusAt ?? null : null,
        screenObserved,
      };
    }),
  };
}

export async function startBackgroundTabSession(tab: RestorablePaneTab, pane: Pane): Promise<void> {
  const [{ getAgent, getDefaultAgent }, { ackFrontendData, createSession }] = await Promise.all([
    import("../../lib/agents"),
    import("../../lib/ipc"),
  ]);
  const agent = getAgent(tab.agentId) ?? getDefaultAgent();
  const command = tab.commandArgv?.[0] ?? agent.command;
  const commandArgs = tab.commandArgv?.length ? tab.commandArgv.slice(1) : agent.args;
  const launchEnv: Record<string, string> = {
    ...(tab.launchEnv ?? pane.launchEnv ?? {}),
    MYCMUX_PANE_SESSION_ID: tab.sessionId,
    MYCMUX_TAB_ID: tab.id,
  };
  if (tab.agentId === "shell-starter") {
    launchEnv.__CMUX_LAUNCHER_DONE = "1";
  }

  await createSession(
    tab.sessionId,
    command,
    commandArgs,
    80,
    24,
    (batch) => {
      void ackFrontendData(tab.sessionId, batch.generation, batch.seq, batch.bytes)
        .catch((error) => {
          if (import.meta.env.DEV) {
            console.warn(`[mycmux-diag socket] headless PTY ack failed: ${tab.sessionId}`, error);
          }
        });
    },
    tab.cwd ?? pane.cwd,
    launchEnv,
  );
}

function isKnownPaneSession(workspaces: Workspace[], sessionId: string): boolean {
  return findPaneBySessionId(workspaces, sessionId) !== null;
}

async function resolveHandoffPromptPath(args: SocketArgs): Promise<string | undefined> {
  const handoffFromSessionId = socketArgString(
    args,
    "handoffFromSessionId",
    "handoff_from_session_id",
  );
  if (!handoffFromSessionId) return undefined;

  const { crsmCreateHandoff } = await import("../../lib/ipc");
  const target = spawnTarget(args);
  if (target === "shell") throw new Error("pane.spawn handoff requires an agent target");
  const handoffFromKind = optionalAgentKind(
    args,
    "handoffFromKind",
    "handoff_from_kind",
  );
  const result = await crsmCreateHandoff(
    handoffFromSessionId,
    handoffFromKind as AgentSessionKind,
    target,
    20,
  );
  return result.path;
}

async function spawnPane(args: SocketArgs) {
  const {
    useUiStore,
    useWorkspaceLayoutStore,
    useWorkspaceListStore,
  } = await import("../../stores/workspaceStore");
  const hasCommandArgv = hasSocketArg(args, "commandArgv", "command_argv");
  const handoffPromptPath = hasCommandArgv
    ? undefined
    : await resolveHandoffPromptPath(args);

  const plan = resolveSpawnPanePlan(args, handoffPromptPath);
  const workspaceState = useWorkspaceListStore.getState();
  // Prefer the caller's own location over whatever the human is looking at.
  // Falling straight back to activeWorkspaceId meant an agent sitting in a
  // background workspace split the pane the operator was working in.
  const callerSessionId = socketArgString(args, "anchorSessionId", "anchor_session_id");
  const callerWorkspaceId = callerSessionId
    ? workspaceState.workspaces.find((candidate) =>
        workspaceContainsSession(candidate, callerSessionId),
      )?.id
    : undefined;
  const workspaceId = socketArgString(args, "workspaceId", "workspace_id")
    ?? callerWorkspaceId
    ?? workspaceState.activeWorkspaceId
    ?? undefined;
  if (!workspaceId) throw new Error("pane.spawn requires an active workspace or workspaceId");
  const workspace = workspaceState.getWorkspace(workspaceId);
  if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
  if (workspace.panes.length === 0) throw new Error("pane.spawn requires a workspace with panes");

  const requestedAnchorId = socketArgString(args, "anchorPaneId", "anchor_pane_id");
  const activeSessionId = useUiStore.getState().activePaneId;
  const anchorPane = requestedAnchorId
    ? workspace.panes.find((pane) => pane.id === requestedAnchorId)
    : (callerSessionId
        ? workspace.panes.find((pane) => paneContainsSession(pane,callerSessionId))
        : undefined)
      ?? (activeSessionId
        ? workspace.panes.find((pane) => paneContainsSession(pane,activeSessionId))
        : undefined)
      ?? workspace.panes[0];
  if (!anchorPane) throw new Error("pane.spawn anchor pane not found");

  const directionArg = socketArgString(args, "direction") ?? "right";
  if (directionArg !== "right" && directionArg !== "down") {
    throw new Error(`unsupported pane.spawn direction: ${directionArg}`);
  }

  // Snapshot straight from the store, not from the `workspace` read above: the
  // handoff round-trip earlier in this function gives other socket clients a
  // window to add or remove panes.
  const beforePaneIds = new Set(
    (useWorkspaceListStore.getState().getWorkspace(workspaceId)?.panes ?? [])
      .map((pane) => pane.id),
  );
  const activate = socketArgBoolean(args, "activate", false);
  useWorkspaceLayoutStore.getState().addPaneToWorkspaceWithOptions(
    workspaceId,
    anchorPane.id,
    directionArg,
    { ...plan.paneOptions, activate, activationSource: "socket" },
  );
  const updatedWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
  const newPanes = updatedWorkspace?.panes.filter((pane) => !beforePaneIds.has(pane.id)) ?? [];
  // A pane left behind by a failed spawn has no PTY, so it sits there until
  // somebody clicks it and unwittingly starts the stale spec. Undo before
  // reporting the failure.
  const rollbackNewPanes = () => {
    for (const pane of newPanes) {
      useWorkspaceLayoutStore.getState().removePaneFromWorkspace(workspaceId, pane.id);
    }
  };
  if (newPanes.length !== 1) {
    rollbackNewPanes();
    throw new Error("pane.spawn could not identify the new pane");
  }
  const newPane = newPanes[0];

  return {
    workspaceId,
    paneId: newPane.id,
    sessionId: newPane.sessionId,
    mode: plan.mode,
    foregroundChanged: false,
    activationRequested: activate,
  };
}

async function spawnTab(args: SocketArgs) {
  const { useWorkspaceLayoutStore, useWorkspaceListStore } = await import(
    "../../stores/workspaceStore"
  );
  const anchorSessionId = socketArgString(args, "anchorSessionId", "anchor_session_id");
  if (!anchorSessionId) throw new Error("pane.spawn_tab requires anchorSessionId");

  const owner = findPaneBySessionId(
    useWorkspaceListStore.getState().workspaces,
    anchorSessionId,
  );
  if (!owner) throw new Error("pane.spawn_tab anchor session not found");

  const target = socketArgString(args, "target");
  const hasCommandArgv = hasSocketArg(args, "commandArgv", "command_argv");
  const plan = hasCommandArgv || !target
    ? resolveSpawnTabPlan(args)
    : resolveSpawnTabPlan(args, await resolveHandoffPromptPath(args));
  // Re-resolve after the handoff round-trip above: `owner` was read before that
  // await, so its tab list can already be stale by the time we diff it.
  const current = findPaneBySessionId(
    useWorkspaceListStore.getState().workspaces,
    anchorSessionId,
  ) ?? owner;
  const { workspace, pane } = current;
  const beforeTabIds = new Set(pane.tabs.map((tab) => tab.id));
  const activate = socketArgBoolean(args, "activate", false);
  useWorkspaceLayoutStore.getState().addTabToPaneWithOptions(
    workspace.id,
    pane.id,
    {
      ...plan.paneOptions,
      activate,
      activationSource: "socket",
    },
  );
  const updatedPane = useWorkspaceListStore.getState()
    .getWorkspace(workspace.id)
    ?.panes.find((candidate) => candidate.id === pane.id);
  const newTabs = updatedPane?.tabs.filter((tab) => !beforeTabIds.has(tab.id)) ?? [];
  // A tab left behind by a failed spawn has no PTY, so it sits there until
  // somebody clicks it and unwittingly starts the stale spec. Undo before
  // reporting the failure.
  const rollbackNewTabs = () => {
    for (const tab of newTabs) {
      useWorkspaceLayoutStore.getState().removeTabFromPane(workspace.id, pane.id, tab.id);
    }
  };
  if (newTabs.length !== 1) {
    rollbackNewTabs();
    throw new Error("pane.spawn_tab could not identify the new tab");
  }
  const newTab = newTabs[0];
  if (!isRestorableTab(newTab)) {
    rollbackNewTabs();
    throw new Error("pane.spawn_tab created a non-restorable tab");
  }
  if (updatedPane) {
    try {
      await startBackgroundTabSession(newTab, updatedPane);
    } catch (error) {
      rollbackNewTabs();
      throw error;
    }
  }
  return {
    workspaceId: workspace.id,
    paneId: pane.id,
    tabId: newTab.id,
    sessionId: newTab.sessionId,
    mode: plan.mode,
    foregroundChanged: false,
    activationRequested: activate,
    activationApplied: activate && useWorkspaceListStore.getState().activeWorkspaceId !== workspace.id,
  };
}

type DeclaredLaunchResult = {
  ok: boolean;
  reason?: "flag-disabled" | "not-found" | "not-declared";
  tabId?: string;
  sessionId?: string;
  pending?: boolean;
};
const declaredLaunchRequests = new Map<string, Promise<DeclaredLaunchResult>>();
const DECLARED_LAUNCH_REQUEST_LIMIT = 256;

function retainDeclaredLaunchRequest(requestId: string, result: Promise<DeclaredLaunchResult>): void {
  declaredLaunchRequests.set(requestId, result);
  if (declaredLaunchRequests.size > DECLARED_LAUNCH_REQUEST_LIMIT) {
    const oldest = declaredLaunchRequests.keys().next().value;
    if (oldest) declaredLaunchRequests.delete(oldest);
  }
}

function findTabById(workspaces: Workspace[], tabId: string): { workspace: Workspace; pane: Pane; tab: PaneTab } | null {
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((candidate) => candidate.id === tabId);
      if (tab) return { workspace, pane, tab };
    }
  }
  return null;
}

async function declareTab(args: SocketArgs) {
  const { useWorkspaceLayoutStore, useWorkspaceListStore } = await import("../../stores/workspaceStore");
  const paneId = socketArgString(args, "paneId", "pane_id");
  const sessionId = socketArgString(args, "sessionId", "session_id");
  const label = socketArgString(args, "label");
  if (!label) throw new Error("pane.declare_tab requires a non-empty label");
  const match = paneId
    ? useWorkspaceListStore.getState().workspaces.map((workspace) => ({ workspace, pane: workspace.panes.find((candidate) => candidate.id === paneId) })).find((candidate) => candidate.pane)
    : sessionId ? findPaneBySessionId(useWorkspaceListStore.getState().workspaces, sessionId) : null;
  if (!match?.pane) throw new Error("pane.declare_tab requires paneId or sessionId");
  const originKind = socketArgString(args, "origin") === "agent" ? "agent" : "human";
  const parentTabId = socketArgString(args, "parentTabId", "parent_tab_id");
  const tab = useWorkspaceLayoutStore.getState().declareTab(match.workspace.id, match.pane.id, {
    label,
    declaredPrompt: socketArgString(args, "declaredPrompt", "declared_prompt"),
    declaredTarget: socketArgString(args, "declaredTarget", "declared_target"),
    origin: { kind: originKind, parentTabId },
  });
  if (!tab) throw new Error("pane.declare_tab could not add tab");
  return { tabId: tab.id, workspaceId: match.workspace.id, paneId: match.pane.id };
}

/** Socket-declared launches never replace the operator's active tab. */
async function launchDeclared(args: SocketArgs): Promise<DeclaredLaunchResult> {
  const tabId = socketArgString(args, "tabId", "tab_id");
  const requestId = socketArgString(args, "requestId", "request_id");
  if (!tabId || !requestId) throw new Error("pane.launch_declared requires tabId and requestId");
  const cached = declaredLaunchRequests.get(requestId);
  if (cached) return cached;
  const run = (async (): Promise<DeclaredLaunchResult> => {
    const { useSettingsStore } = await import("../../stores/settingsStore");
    if (!useSettingsStore.getState().declaredLaunchEnabled) return { ok: false, reason: "flag-disabled" };
    const { useWorkspaceLayoutStore, useWorkspaceListStore } = await import("../../stores/workspaceStore");
    const owner = findTabById(useWorkspaceListStore.getState().workspaces, tabId);
    if (!owner) return { ok: false, reason: "not-found" };
    if (!isDeclaredTab(owner.tab)) return { ok: false, reason: "not-declared" };
    const backgroundWorkspace = useWorkspaceListStore.getState().activeWorkspaceId !== owner.workspace.id;
    const launched = useWorkspaceLayoutStore.getState().launchDeclaredTab(
      owner.workspace.id,
      owner.pane.id,
      tabId,
      { activationSource: "socket" },
    );
    if (!launched) return { ok: false, reason: "not-declared" };
    return {
      ok: true,
      tabId: launched.id,
      sessionId: launched.sessionId,
      // A background workspace can record its active tab for later. In the
      // displayed workspace the operator must choose the newly launched tab.
      pending: backgroundWorkspace,
    };
  })();
  retainDeclaredLaunchRequest(requestId, run);
  void run.then(
    (result) => {
      if (!result.ok && declaredLaunchRequests.get(requestId) === run) {
        declaredLaunchRequests.delete(requestId);
      }
    },
    () => {
      if (declaredLaunchRequests.get(requestId) === run) {
        declaredLaunchRequests.delete(requestId);
      }
    },
  );
  return run;
}

async function activateTab(args: SocketArgs): Promise<ActivationToken> {
  const sessionId = socketArgString(args, "sessionId", "session_id");
  if (!sessionId) throw new Error("pane.activate_tab requires sessionId");
  const [stores, { getSessionStatusSnapshot }] = await Promise.all([
    import("../../stores/workspaceStore"),
    import("../../lib/ipc"),
  ]);
  const initialSnapshot = await getSessionStatusSnapshot();
  const { useUiStore, useWorkspaceListStore } = stores;
  const workspaceState = useWorkspaceListStore.getState();
  const target = findTabBySessionId(workspaceState.workspaces, sessionId);
  if (!target) throw new Error("pane.activate_tab session not found");

  const uiState = useUiStore.getState();
  const previous = findActiveTabLocation(
    workspaceState.workspaces,
    workspaceState.activeWorkspaceId,
    uiState.activePaneId,
  );
  const previousSessionId = previous?.tab.sessionId ?? null;
  const activation = activateLocation(target, stores);
  const focusRevision = useUiStore.getState().focusRevision;
  const snapshot = await activationSnapshot(target, getSessionStatusSnapshot, initialSnapshot);
  return {
    previous_session_id: previousSessionId,
    target_session_id: target.tab.sessionId,
    focus_revision: focusRevision,
    previous_session_identity: previous ? activationIdentity(previous, initialSnapshot) : null,
    target_session_identity: activationIdentity(target, snapshot),
    foreground_changed: false,
    activation_applied: activation.activationApplied,
  };
}

async function restoreActivation(args: SocketArgs) {
  parseActivationToken(args);
  return {
    restored: false,
    reason: "foreground_preserved",
    foreground_changed: false,
  };
}

async function closeTab(args: SocketArgs) {
  const { useWorkspaceListStore } = await import("../../stores/workspaceStore");
  const sessionId = socketArgString(args, "sessionId", "session_id");
  if (!sessionId) throw new Error("pane.close_tab requires sessionId");

  let owner: { workspace: Workspace; pane: Pane; tab: Pane["tabs"][number] } | null = null;
  for (const workspace of useWorkspaceListStore.getState().workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((candidate) => candidate.sessionId === sessionId);
      if (tab) {
        owner = { workspace, pane, tab };
        break;
      }
    }
    if (owner) break;
  }
  if (!owner) throw new Error("pane.close_tab session not found");

  const { workspace, pane, tab } = owner;
  if (tab.type !== "terminal") throw new Error("pane.close_tab requires a terminal tab");
  if (pane.tabs.length === 1 && workspace.panes.length === 1) {
    throw new Error("refusing to close the last tab of the last pane");
  }

  const { pushClosedTab } = await import("../../stores/closedPaneStore");
  pushClosedTab(pane, tab);
  const [
    { evictTerminalCache },
    { killSession },
    { usePaneMetadataStore, useWorkspaceLayoutStore },
  ] = await Promise.all([
    import("../terminal/XTermWrapper"),
    import("../../lib/ipc"),
    import("../../stores/workspaceStore"),
  ]);
  evictTerminalCache(sessionId);
  killSession(sessionId).catch((err) =>
    console.warn("[mycmux] killSession failed", sessionId, err),
  );
  usePaneMetadataStore.getState().removeMetadata(sessionId);
  useWorkspaceLayoutStore.getState().removeTabFromPane(workspace.id, pane.id, tab.id);
  return { workspaceId: workspace.id, paneId: pane.id, tabId: tab.id };
}

/**
 * Applies one close-tabs layout mutation. If every pane in a multi-pane
 * workspace becomes empty, cleanup retains one empty pane for the workspace.
 */
async function closeTabs(args: SocketArgs) {
  const tabIds = Array.isArray(args?.tabIds)
    ? args.tabIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  if (tabIds.length === 0) throw new Error("pane.close_tabs requires tabIds");
  const { usePaneMetadataStore, useUiStore, useWorkspaceListStore } = await import("../../stores/workspaceStore");
  const before = useWorkspaceListStore.getState().workspaces;
  const selected = new Set(tabIds);
  for (const workspace of before) {
    if (workspace.panes.length !== 1) continue;
    const [onlyPane] = workspace.panes;
    if (onlyPane.tabs.length > 0 && onlyPane.tabs.every((tab) => selected.has(tab.id))) {
      throw new Error("refusing to close the last tab of the last pane");
    }
  }
  const ownerByTabId = new Map(before.flatMap((workspace) => workspace.panes.flatMap((pane) => (
    pane.tabs.map((tab) => [tab.id, { workspace, pane, tab }] as const)
  ))));
  const selectedPanes = before.flatMap((workspace) => workspace.panes.map((pane) => ({
    ...pane,
    tabs: pane.tabs.filter((tab) => selected.has(tab.id)),
  }))).filter((pane) => pane.tabs.length > 0);
  const victims = collectPaneCloseVictims(selectedPanes, usePaneMetadataStore.getState().metadata);
  if (victims.length > 0) console.warn(`[pane.close_tabs] closing ${victims.length} active/agent tab(s)`);
  const { workspaces, summary } = applyLayoutMutation(before, {
    kind: "close-tabs",
    operationId: crypto.randomUUID(),
    tabIds,
  }, 0);
  const closedOwners = summary.closed
    .map((tabId) => ownerByTabId.get(tabId))
    .filter((owner): owner is NonNullable<typeof owner> => owner !== undefined);
  const { pushClosedTab } = await import("../../stores/closedPaneStore");
  for (const { workspace, pane, tab } of closedOwners) {
    pushClosedTab(pane, tab, { workspaceId: workspace.id, workspaceName: workspace.name });
  }
  const focusedSessionId = useUiStore.getState().activePaneId;
  const killedFocusedSession = closedOwners.some(({ tab }) => (
    tab.type === "terminal" && !isDeclaredTab(tab) && tab.sessionId === focusedSessionId
  ));
  useWorkspaceListStore.getState()._replaceWorkspaces(workspaces);
  if (killedFocusedSession) useUiStore.getState().bumpFocusRevision();
  const liveOwners = closedOwners.filter(({ tab }) => tab.type === "terminal" && !isDeclaredTab(tab));
  if (liveOwners.length === 0) return { ...summary, victims };
  const [{ evictTerminalCache }, { killSession }] = await Promise.all([
    import("../terminal/terminalCache"),
    import("../../lib/ipc"),
  ]);
  for (const { tab } of liveOwners) {
    evictTerminalCache(tab.sessionId);
    usePaneMetadataStore.getState().removeMetadata(tab.sessionId);
    void killSession(tab.sessionId).catch((error) => console.warn("[mycmux] killSession failed", tab.sessionId, error));
  }
  return { ...summary, victims };
}

async function renameTab(args: SocketArgs) {
  const sessionId = socketArgString(args, "sessionId", "session_id");
  if (!sessionId) throw new Error("pane.rename_tab requires sessionId");
  const label = args?.label;
  if (typeof label !== "string") throw new Error("pane.rename_tab requires label");

  const { useWorkspaceLayoutStore, useWorkspaceListStore } = await import(
    "../../stores/workspaceStore"
  );
  for (const workspace of useWorkspaceListStore.getState().workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((candidate) => candidate.sessionId === sessionId);
      if (!tab) continue;
      useWorkspaceLayoutStore.getState().setTabLabel(
        workspace.id,
        pane.id,
        tab.id,
        label,
      );
      return {
        workspaceId: workspace.id,
        paneId: pane.id,
        tabId: tab.id,
        sessionId,
        label: label.trim() || null,
      };
    }
  }
  throw new Error("pane.rename_tab session not found");
}

const SEND_CONFIRM_LINES = 24;
const SEND_CONFIRM_POLL_MS = 50;
const SEND_TEXT_SETTLE_TIMEOUT_MS = 2_000;
const SEND_ENTER_CONFIRM_TIMEOUT_MS = 1_200;
const SEND_ENTER_MAX_ATTEMPTS = 3;
const SEND_SNAPSHOT_TIMEOUT_MS = 250;
const SEND_UNVERIFIED_NOTE = "no delivery verification; use --enter or --key to get confirmation";

const SEND_KEY_BYTES = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  "ctrl-c": "\x03",
  space: " ",
  backspace: "\x7f",
} as const;

type SendKey = keyof typeof SEND_KEY_BYTES;

function socketSendKey(value: unknown): SendKey | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !(value in SEND_KEY_BYTES)) {
    throw new Error("pane.send_text key is not supported");
  }
  return value as SendKey;
}

function waitForSendConfirmationPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SEND_CONFIRM_POLL_MS));
}

interface PaneSnapshot {
  text: string | null;
  targetMounted: boolean;
}

async function readPaneSnapshot(sessionId: string): Promise<PaneSnapshot> {
  const { hasMountedTerminal } = await import("../terminal/XTermWrapper");
  const targetMounted = hasMountedTerminal(sessionId);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = readPaneTail(sessionId, SEND_CONFIRM_LINES, !targetMounted);
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("pane snapshot timed out")), SEND_SNAPSHOT_TIMEOUT_MS);
    });
    return { text: JSON.stringify(await Promise.race([read, deadline])), targetMounted };
  } catch {
    return { text: null, targetMounted };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForTypedTextToSettle(
  sessionId: string,
  before: PaneSnapshot,
): Promise<{ snapshot: string | null; settled: boolean; targetMounted: boolean }> {
  if (before.text === null) return { snapshot: null, settled: false, targetMounted: before.targetMounted };

  let last = before.text;
  let targetMounted = before.targetMounted;
  let observedEcho = false;
  let stableSamples = 0;
  const polls = Math.ceil(SEND_TEXT_SETTLE_TIMEOUT_MS / SEND_CONFIRM_POLL_MS);
  for (let poll = 0; poll < polls; poll += 1) {
    await waitForSendConfirmationPoll();
    const current = await readPaneSnapshot(sessionId);
    targetMounted = current.targetMounted;
    if (current.text === null) continue;
    if (current.text !== before.text) observedEcho = true;
    stableSamples = observedEcho && current.text === last ? stableSamples + 1 : 0;
    last = current.text;
    if (stableSamples >= 1) return { snapshot: current.text, settled: true, targetMounted };
  }
  return { snapshot: last, settled: false, targetMounted };
}

async function waitForPaneToAdvance(
  sessionId: string,
  beforeEnter: string,
  targetMountedAtStart: boolean,
): Promise<{ outcome: "advanced" | "unchanged" | "unavailable"; targetMounted: boolean }> {
  let readable = false;
  let unavailable = false;
  let targetMounted = targetMountedAtStart;
  const polls = Math.ceil(SEND_ENTER_CONFIRM_TIMEOUT_MS / SEND_CONFIRM_POLL_MS);
  for (let poll = 0; poll < polls; poll += 1) {
    await waitForSendConfirmationPoll();
    const current = await readPaneSnapshot(sessionId);
    targetMounted = current.targetMounted;
    if (current.text === null) {
      unavailable = true;
      continue;
    }
    readable = true;
    if (current.text !== beforeEnter) return { outcome: "advanced", targetMounted };
  }
  return { outcome: readable && !unavailable ? "unchanged" : "unavailable", targetMounted };
}

function unavailableSendReason(targetMounted: boolean): "target_unmounted" | "verification_unavailable" {
  return targetMounted ? "verification_unavailable" : "target_unmounted";
}

const paneSendTails = new Map<string, Promise<unknown>>();

async function serializePaneSend<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = paneSendTails.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  paneSendTails.set(sessionId, current);
  try {
    return await current;
  } finally {
    if (paneSendTails.get(sessionId) === current) paneSendTails.delete(sessionId);
  }
}

function optionalExpectationString(
  args: SocketArgs,
  snake: string,
  camel: string,
): string | null | undefined {
  const hasSnake = hasSocketArg(args, snake);
  const hasCamel = hasSocketArg(args, camel);
  if (hasSnake && hasCamel && args?.[snake] !== args?.[camel]) {
    throw new Error(`pane.send_text ${snake} and ${camel} must match`);
  }
  const value = hasCamel ? args?.[camel] : hasSnake ? args?.[snake] : undefined;
  if (value === undefined) return undefined;
  if (value !== null && typeof value !== "string") {
    throw new Error(`pane.send_text ${snake} must be a string or null`);
  }
  return value;
}

function optionalExpectationInteger(args: SocketArgs, snake: string, camel: string): number | undefined {
  const hasSnake = hasSocketArg(args, snake);
  const hasCamel = hasSocketArg(args, camel);
  if (hasSnake && hasCamel && args?.[snake] !== args?.[camel]) {
    throw new Error(`pane.send_text ${snake} and ${camel} must match`);
  }
  const value = hasCamel ? args?.[camel] : hasSnake ? args?.[snake] : undefined;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`pane.send_text ${snake} must be a non-negative integer`);
  }
  return value;
}

function guardedWriteExpectations(args: SocketArgs): {
  expectedAttentionId?: string | null;
  expectedSessionEpoch?: number;
  expectedSessionRevision?: number;
  expectedInputRevision?: number;
} {
  return {
    expectedAttentionId: optionalExpectationString(
      args,
      "expected_attention_id",
      "expectedAttentionId",
    ),
    expectedSessionEpoch: optionalExpectationInteger(
      args,
      "expected_session_epoch",
      "expectedSessionEpoch",
    ),
    expectedSessionRevision: optionalExpectationInteger(
      args,
      "expected_session_revision",
      "expectedSessionRevision",
    ),
    expectedInputRevision: optionalExpectationInteger(
      args,
      "expected_input_revision",
      "expectedInputRevision",
    ),
  };
}

function guardedWriteIsPartial(args: SocketArgs): boolean {
  const values = Object.values(guardedWriteExpectations(args));
  const provided = values.filter((value) => value !== undefined).length;
  return provided > 0 && provided < values.length;
}

/**
 * Frontend bridge for the native atomic optimistic lock. Any guarded send must
 * carry the complete screen-bound expectation tuple; partial locks fail closed.
 */
function staleSendTextFromFrontend(
  args: SocketArgs,
  attention: { attentionId: string | null; kind: string; sessionEpoch: number | null; sessionRevision: number } | undefined,
): { sent: false; reason: string; current: unknown } | null {
  const {
    expectedAttentionId,
    expectedSessionEpoch,
    expectedSessionRevision,
    expectedInputRevision,
  } = guardedWriteExpectations(args);
  if (
    expectedAttentionId === undefined
    && expectedSessionEpoch === undefined
    && expectedSessionRevision === undefined
    && expectedInputRevision === undefined
  ) {
    return null;
  }
  if (guardedWriteIsPartial(args)) {
    return { sent: false, reason: "incomplete_expectations", current: null };
  }
  if (!attention) {
    return { sent: false, reason: "unknown_session", current: null };
  }
  if (attention.attentionId !== expectedAttentionId) {
    return { sent: false, reason: "attention_id", current: null };
  }
  if (attention.sessionEpoch !== expectedSessionEpoch) {
    return { sent: false, reason: "session_epoch", current: null };
  }
  if (attention.sessionRevision !== expectedSessionRevision) {
    return { sent: false, reason: "session_revision", current: null };
  }
  return null;
}

async function writePaneBytes(
  sessionId: string,
  data: string,
  args: SocketArgs,
  expectedInputRevision?: number,
): Promise<{ sent: false; reason: string } | null> {
  const { expectedAttentionId, expectedSessionEpoch, expectedSessionRevision } = guardedWriteExpectations(args);
  if (
    expectedAttentionId === undefined
    && expectedSessionEpoch === undefined
    && expectedSessionRevision === undefined
    && expectedInputRevision === undefined
  ) {
    await writeToSession(sessionId, data);
    return null;
  }
  if (
    expectedAttentionId === undefined
    || expectedSessionEpoch === undefined
    || expectedSessionRevision === undefined
    || expectedInputRevision === undefined
  ) {
    return { sent: false, reason: "incomplete_expectations" };
  }
  const result = await writeToSessionGuarded(
    sessionId,
    data,
    expectedAttentionId,
    expectedSessionEpoch,
    expectedSessionRevision,
    expectedInputRevision,
  );
  return result.sent ? null : { sent: false, reason: result.reason ?? "ambiguous" };
}

async function sendPaneText(args: SocketArgs) {
  const { useWorkspaceListStore } = await import("../../stores/workspaceStore");
  const { recordRecentInputText } = await import("../../stores/recentInputStore");
  const { clearTurnDraft, noteTurnSubmit } = await import("../terminal/terminalTurnMarkers");
  const { turnLabelFrom } = await import("../terminal/terminalTurnModel");
  const { useSessionAttentionStore } = await import("../../stores/sessionAttentionStore");
  const sessionId = socketArgString(args, "sessionId", "session_id");
  if (!sessionId) throw new Error("pane.send_text requires sessionId");
  const textValue = args?.text;
  const enterValue = args?.enter;
  const key = socketSendKey(args?.key);
  if (enterValue !== undefined && typeof enterValue !== "boolean") {
    throw new Error("pane.send_text enter must be a boolean");
  }
  const enter = enterValue ?? false;
  if (key !== null && enter) {
    throw new Error("pane.send_text key cannot be combined with enter");
  }
  if (typeof textValue !== "string" || (!textValue && !enter && key === null)) {
    throw new Error("pane.send_text requires text, unless enter or key is set");
  }
  const workspaces = useWorkspaceListStore.getState().workspaces;
  const target = findTabBySessionId(workspaces, sessionId);
  if (target && isDeclaredTab(target.tab)) {
    throw new Error("pane.send_text cannot target a declared tab");
  }
  if (!isKnownPaneSession(workspaces, sessionId)) {
    throw new Error("pane.send_text session is not a known pane");
  }
  return serializePaneSend(sessionId, async () => {
    const {
      expectedAttentionId,
      expectedSessionEpoch,
      expectedSessionRevision,
      expectedInputRevision,
    } = guardedWriteExpectations(args);
    const guarded = expectedAttentionId !== undefined
      || expectedSessionEpoch !== undefined
      || expectedSessionRevision !== undefined
      || expectedInputRevision !== undefined;
    const stale = staleSendTextFromFrontend(
      args,
      useSessionAttentionStore.getState().attentionBySession[sessionId],
    );
    if (stale) return stale;
    const keyBytes = key === null ? "\r" : SEND_KEY_BYTES[key];
    const bytes = textValue.length + (enter || key !== null ? keyBytes.length : 0);
    if (!enter && key === null) {
      const rejected = await writePaneBytes(sessionId, textValue, args, expectedInputRevision);
      if (rejected) return rejected;
      return {
        sessionId,
        queuedBytes: new TextEncoder().encode(textValue).byteLength,
        unverified: true,
        note: SEND_UNVERIFIED_NOTE,
      };
    }

    const beforeText = await readPaneSnapshot(sessionId);
    let beforeEnter = beforeText.text;
    let canConfirm = beforeEnter !== null;
    let targetMounted = beforeText.targetMounted;
    if (textValue) {
      const rejected = await writePaneBytes(sessionId, textValue, args, expectedInputRevision);
      if (rejected) return rejected;
      const settled = await waitForTypedTextToSettle(sessionId, beforeText);
      beforeEnter = settled.snapshot;
      canConfirm = settled.settled && beforeEnter !== null;
      targetMounted = settled.targetMounted;
    }

    let inputRevision = expectedInputRevision;
    if (guarded && textValue) inputRevision = inputRevision === undefined ? undefined : inputRevision + 1;

    if (!canConfirm || beforeEnter === null) {
      const rejected = await writePaneBytes(sessionId, keyBytes, args, inputRevision);
      if (rejected) return rejected;
      if (textValue) {
        recordRecentInputText(sessionId, textValue);
        noteTurnSubmit(sessionId, turnLabelFrom(textValue));
        clearTurnDraft(sessionId);
      }
      return {
        sessionId,
        bytes,
        ok: false,
        confirmed: false,
        attempts: 1,
        reason: unavailableSendReason(targetMounted),
      };
    }

    const maxAttempts = key === null ? SEND_ENTER_MAX_ATTEMPTS : 1;
    for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
      const rejected = await writePaneBytes(sessionId, keyBytes, args, inputRevision);
      if (rejected) return rejected;
      if (guarded && inputRevision !== undefined) inputRevision += 1;
      if (attempts === 1 && textValue) {
        recordRecentInputText(sessionId, textValue);
        noteTurnSubmit(sessionId, turnLabelFrom(textValue));
        clearTurnDraft(sessionId);
      }
      const advance = await waitForPaneToAdvance(sessionId, beforeEnter, targetMounted);
      targetMounted = advance.targetMounted;
      if (advance.outcome === "advanced") {
        return { sessionId, bytes, ok: true, confirmed: true, attempts };
      }
      if (advance.outcome === "unavailable") {
        return {
          sessionId,
          bytes,
          ok: false,
          confirmed: false,
          attempts,
          reason: unavailableSendReason(targetMounted),
        };
      }
    }

    return {
      sessionId,
      bytes,
      ok: false,
      confirmed: false,
      attempts: maxAttempts,
      reason: "submit_unconfirmed",
    };
  });
}

async function readPane(args: SocketArgs) {
  const { useWorkspaceListStore } = await import("../../stores/workspaceStore");
  const sessionId = socketArgString(args, "sessionId", "session_id");
  if (!sessionId) throw new Error("pane.read requires sessionId");
  const workspaces = useWorkspaceListStore.getState().workspaces;
  const target = findTabBySessionId(workspaces, sessionId);
  if (target && isDeclaredTab(target.tab)) {
    throw new Error("pane.read cannot target a declared tab");
  }
  if (!isKnownPaneSession(workspaces, sessionId)) {
    throw new Error("pane.read session is not a known pane");
  }
  return { sessionId, lines: await readPaneTail(sessionId, args?.lines) };
}

export async function readPaneTail(
  sessionId: string,
  lines: unknown,
  preferHeadless = false,
): Promise<string[]> {
  const { getTerminalBufferLines, hasTerminalBuffer } = await import("../terminal/XTermWrapper");
  if (!preferHeadless && hasTerminalBuffer(sessionId)) {
    return getTerminalBufferLines(sessionId, clampPaneReadLines(lines));
  }

  const [{ getSessionScrollback }, { getHeadlessBufferLines }] = await Promise.all([
    import("../../lib/ipc"),
    import("../terminal/headlessBuffer"),
  ]);
  let snapshot;
  try {
    snapshot = await getSessionScrollback(sessionId);
  } catch {
    throw new Error("no terminal buffer for session");
  }
  if (snapshot.data.byteLength === 0) throw new Error("no terminal buffer for session");
  return getHeadlessBufferLines(sessionId, snapshot, clampPaneReadLines(lines));
}

async function movePane(args: SocketArgs) {
  const sessionId = socketArgString(args, "sessionId", "session_id");
  const paneId = socketArgString(args, "paneId", "pane_id");
  if (Boolean(sessionId) === Boolean(paneId)) {
    throw new Error("pane.move requires exactly one of sessionId or paneId");
  }
  const toColumn = socketArgInteger(args, "toColumn", "to_column");
  const toRow = socketArgInteger(args, "toRow", "to_row");
  if (toColumn === undefined) throw new Error("pane.move requires integer toColumn");
  if (toRow === undefined) throw new Error("pane.move requires integer toRow");

  const { useWorkspaceLayoutStore, useWorkspaceListStore } = await import(
    "../../stores/workspaceStore"
  );
  const workspaceState = useWorkspaceListStore.getState();
  const requestedWorkspaceId = socketArgString(args, "workspaceId", "workspace_id");
  const workspaces = requestedWorkspaceId
    ? workspaceState.workspaces.filter((workspace) => workspace.id === requestedWorkspaceId)
    : workspaceState.workspaces;
  if (requestedWorkspaceId && workspaces.length === 0) {
    throw new Error(`workspace not found: ${requestedWorkspaceId}`);
  }

  const match = paneId
    ? workspaces
      .map((workspace) => ({
        workspace,
        pane: workspace.panes.find((candidate) => candidate.id === paneId),
      }))
      .find((candidate) => candidate.pane)
    : findPaneBySessionId(workspaces, sessionId!);
  if (!match?.pane) {
    throw new Error(`pane not found: ${paneId ?? sessionId}`);
  }

  const splitColumns = useWorkspaceLayoutStore.getState().movePaneToPosition(
    match.workspace.id,
    match.pane.id,
    toColumn,
    toRow,
  );
  if (!splitColumns) throw new Error(`pane not found: ${match.pane.id}`);
  return {
    workspaceId: match.workspace.id,
    paneId: match.pane.id,
    splitColumns,
  };
}

export async function handleSocketCommand(cmd: string, args: SocketArgs): Promise<unknown> {
  const { usePaneMetadataStore, useUiStore, useWorkspaceListStore } = await import(
    "../../stores/workspaceStore"
  );
  const workspaceState = useWorkspaceListStore.getState();

  switch (cmd) {
    case "workspace.list":
    case "list_workspaces":
      return {
        activeWorkspaceId: workspaceState.activeWorkspaceId,
        workspaces: workspaceState.workspaces.map((workspace) =>
          serializeWorkspaceForSocket(workspace, workspaceState.activeWorkspaceId),
        ),
      };

    case "workspace.select":
    case "select_workspace": {
      const workspaceId = socketArgString(args, "workspaceId", "workspace_id", "id");
      if (!workspaceId) throw new Error("workspace.select requires workspaceId");
      const workspace = workspaceState.getWorkspace(workspaceId);
      if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
      return {
        activeWorkspaceId: workspaceState.activeWorkspaceId,
        requestedWorkspaceId: workspaceId,
        foregroundChanged: false,
      };
    }

    case "workspace.rename":
    case "rename_workspace": {
      const workspaceId = socketArgString(args, "workspaceId", "workspace_id", "id");
      const name = socketArgString(args, "name");
      if (!workspaceId) throw new Error("workspace.rename requires workspaceId");
      if (!name) throw new Error("workspace.rename requires name");
      const workspace = workspaceState.getWorkspace(workspaceId);
      if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
      workspaceState.renameWorkspace(workspaceId, name);
      return { id: workspaceId, name };
    }

    case "pane.list":
    case "list_panes": {
      const workspaceId = socketArgString(args, "workspaceId", "workspace_id", "id")
        ?? workspaceState.activeWorkspaceId
        ?? undefined;
      if (!workspaceId) throw new Error("pane.list requires an active workspace or workspaceId");
      const workspace = workspaceState.getWorkspace(workspaceId);
      if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
      const activePaneId = useUiStore.getState().activePaneId;
      const paneMetadata = usePaneMetadataStore.getState().metadata;
      const { liveTerms } = await import("../terminal/terminalCache");
      const [processSnapshot, lastOutputBySession] = await Promise.all([
        loadProcessMetadataSnapshot(),
        loadSessionOutputSnapshot(),
      ]);
      const serializationContext: PaneSocketSerializationContext = {
        activeSessionId: activePaneId,
        metadata: paneMetadata,
        processMetadata: processSnapshot.metadata,
        processMetadataAvailable: processSnapshot.available,
        lastOutputBySession,
        isTerminalMounted: (sessionId) => liveTerms.has(sessionId),
      };
      return {
        workspaceId,
        activePaneId,
        activeSessionId: activePaneId,
        ...serializeWorkspaceLayoutForSocket(workspace),
        panes: workspace.panes.map((pane) =>
          serializePaneForSocket(pane, serializationContext)
        ),
      };
    }

    case "pane.list_all":
    case "list_all_panes": {
      const activePaneId = useUiStore.getState().activePaneId;
      const paneMetadata = usePaneMetadataStore.getState().metadata;
      const { liveTerms } = await import("../terminal/terminalCache");
      const [processSnapshot, lastOutputBySession] = await Promise.all([
        loadProcessMetadataSnapshot(),
        loadSessionOutputSnapshot(),
      ]);
      const serializationContext: PaneSocketSerializationContext = {
        activeSessionId: activePaneId,
        metadata: paneMetadata,
        processMetadata: processSnapshot.metadata,
        processMetadataAvailable: processSnapshot.available,
        lastOutputBySession,
        isTerminalMounted: (sessionId) => liveTerms.has(sessionId),
      };
      return {
        activeWorkspaceId: workspaceState.activeWorkspaceId,
        activePaneId,
        activeSessionId: activePaneId,
        workspaces: workspaceState.workspaces.map((workspace) => ({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          ...serializeWorkspaceLayoutForSocket(workspace),
        })),
        panes: workspaceState.workspaces.flatMap((workspace) =>
          workspace.panes.map((pane) =>
            serializePaneForSocket(pane, serializationContext, workspace)
          )
        ),
      };
    }

    case "pane.spawn":
      return spawnPane(args);
    case "pane.spawn_tab":
      return spawnTab(args);
    case "pane.declare_tab":
      return declareTab(args);
    case "pane.launch_declared":
      return launchDeclared(args);
    case "pane.activate_tab":
      return activateTab(args);
    case "pane.restore_activation":
      return restoreActivation(args);
    case "pane.close_tab":
      return closeTab(args);
    case "pane.close_tabs":
      return closeTabs(args);
    case "pane.rename_tab":
      return renameTab(args);
    case "pane.send_text":
      return sendPaneText(args);
    case "pane.read":
      return readPane(args);
    case "pane.move":
      return movePane(args);
    default:
      throw new Error(`Unknown socket command: ${cmd}`);
  }
}

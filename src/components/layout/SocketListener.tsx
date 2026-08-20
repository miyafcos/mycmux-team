import { useEffect, useRef } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  useWorkspaceListStore,
  useWorkspaceLayoutStore,
  useUiStore,
  usePaneMetadataStore,
} from "../../stores/workspaceStore";
import {
  loadPersistentData,
  claimLeader,
  savePersistentData,
  readAgentSessionMappings,
  setAppFrontendVisible,
  getPtyMetadataSnapshot,
  quitApp,
  sendSocketResponse,
  getAppSettings,
  getWindowFragments,
  publishWindowFragment,
  releaseWorkspaces,
  takePendingAdoption,
  discardSessionScrollback,
  WINDOW_ADOPT_EVENT,
  type AgentSessionMapping,
  type PtyMetadata,
  type PaneConfig,
  type PaneTabConfig,
  type WindowAdoptPayload,
  type WindowFragment,
  type WorkspaceConfig,
  listPets,
} from "../../lib/ipc";
import { candidatesFromListedPets } from "../../lib/pets";
import type { AgentSessionKind, SuppressedAgentSession, TurnMarkPersistSnapshot, Workspace } from "../../types";
import { useThemeStore } from "../../stores/themeStore";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { usePetSettingsStore } from "../../stores/petSettingsStore";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import { normalizeAiProvider } from "../../lib/aiModels";
import { isShellProcess } from "../../lib/notificationStatus";
import { confirmAgentSessionClear } from "../../lib/agentSessionClearGuard";
import { agentCloseDialogOptions } from "../../lib/agentCloseDialog";
import { makeSessionId } from "../../lib/constants";
import { normalizeReadableSplitColumns, reconcileSplitColumnsForPanes } from "../../lib/layoutColumns";
import { reconcileColumnWidths, reconcileRowHeightsPerCol } from "../../lib/layoutMetrics";
import { focusController } from "../../lib/focusController";
import { getTerminalBufferLines, getTerminalWriteCounter, hasTerminalBuffer } from "../terminal/XTermWrapper";
import { useToastStore } from "../../stores/toastStore";
import {
  agentSessionIdentityKey,
  paneContainsSession,
  workspaceContainsSession,
} from "../../stores/workspaceListStore";
import {
  agentIdForSessionKind,
  declaredAgentKind,
  declaredAgentSessionId,
  type AgentSessionConfigFields,
} from "../../lib/agentSessionConfig";
import {
  filterConflictingAgentMappings,
  resolvePersistedSelection,
} from "../../lib/sessionRestoreSafety";
import { handleSocketCommand } from "./socketCommands";
import { handleWorkOrderSpawnRequest, type SpawnRequest } from "../../lib/workOrderBridge";
import { isMainWindow, windowLabel, MAIN_WINDOW_LABEL } from "../../lib/windowContext";
import { mergeWindowFragmentWorkspaces } from "../../lib/windowFragments";
import {
  filterAlreadyRestoredConfigs,
  restoreWorkspaceConfigs,
} from "../../lib/workspaceRestore";
import { isDeclaredTab, isRestorableTab } from "../../lib/tabLifecycle";
import {
  capTurnMarkPersistSnapshots,
  getTurnMarkPersistSnapshot,
} from "../terminal/terminalTurnMarkers";

// Socket dispatch lives in socketCommands.ts. Keep these command markers here
// for the frontend bridge contract: case "workspace.list":, case "pane.list":,
// and the Unknown socket command fallback.

const SAVE_FAILURE_TOAST_DEBOUNCE_MS = 10000;
const MAX_SUPPRESSED_AGENT_SESSIONS = 5;
/**
 * Same 500ms the leader uses for its autosave debounce. It bounds how stale a
 * non-main window's contribution to `data.json` can be — the close path
 * publishes synchronously before releasing, so a merge-back is never stale.
 */
const WINDOW_FRAGMENT_PUBLISH_DEBOUNCE_MS = 500;
let lastSaveFailureToastAt = 0;

/**
 * Backoff ladder for autosave retries. A failed save only sets `dirty` back to
 * true, so without a self-scheduled retry the write would wait for the next
 * store mutation — which may never come on an idle workspace.
 */
export const SAVE_RETRY_DELAYS_MS = [5000, 15000, 30000] as const;

/** `failureCount` is the number of consecutive failures already seen (0-based). */
export function saveRetryDelayMs(failureCount: number): number {
  const index = Math.min(Math.max(failureCount, 0), SAVE_RETRY_DELAYS_MS.length - 1);
  return SAVE_RETRY_DELAYS_MS[index];
}

interface AgentSessionLocation {
  workspaceId: string;
  paneId: string | null;
  tabId: string | null;
}

export interface AgentSessionDedupeConflict {
  key: string;
  reason: "active" | "self-owned" | "order";
  winner: AgentSessionLocation;
  loser: AgentSessionLocation;
}

export interface AgentSessionDedupeResult {
  configs: WorkspaceConfig[];
  conflicts: AgentSessionDedupeConflict[];
  discardScrollbackSessionIds: string[];
}

let reportedAgentSessionDedupeConflicts = new Set<string>();

function dedupeConflictSignature(conflict: AgentSessionDedupeConflict): string {
  const { loser } = conflict;
  return `${conflict.key}|${loser.workspaceId}|${loser.paneId ?? ""}|${loser.tabId ?? ""}`;
}

export function reportAgentSessionDedupeConflicts(conflicts: AgentSessionDedupeConflict[]): void {
  const currentSignatures = new Set(conflicts.map(dedupeConflictSignature));
  const freshSignatures = new Set<string>();
  const freshConflicts = conflicts.filter((conflict) => {
    const signature = dedupeConflictSignature(conflict);
    if (reportedAgentSessionDedupeConflicts.has(signature) || freshSignatures.has(signature)) {
      return false;
    }
    freshSignatures.add(signature);
    return true;
  });
  reportedAgentSessionDedupeConflicts = currentSignatures;
  if (freshConflicts.length === 0) return;

  console.warn("[persist] duplicate agent session ownership:", freshConflicts);
  useToastStore
    .getState()
    .pushToast(
      `同じ会話が複数のタブに割り当てられていたため、1つだけを復元対象に残し、${freshConflicts.length}件を退避しました`,
      "warning",
    );
}

export function __resetAgentSessionDedupeReporterForTests(): void {
  reportedAgentSessionDedupeConflicts = new Set<string>();
}

function normalizeSplitColumns(ws: Workspace): string[][] | null {
  const sourceColumns = ws.splitColumns ?? [ws.panes.map((pane) => pane.id)];
  const columns = sourceColumns
    ?.map((col) => col.filter((id) => ws.panes.some((pane) => pane.id === id)))
    .filter((col) => col.length > 0);
  if (!columns || columns.length === 0) return null;
  return reconcileSplitColumnsForPanes(
    normalizeReadableSplitColumns(columns),
    ws.panes.map((pane) => pane.id),
  );
}

function normalizeColumnWidths(
  splitColumns: string[][] | null,
  columnWidths: number[] | undefined,
): number[] | null {
  if (!splitColumns || !columnWidths || columnWidths.length !== splitColumns.length) {
    return null;
  }
  return columnWidths;
}

function normalizeRowHeightsPerCol(
  splitColumns: string[][] | null,
  rowHeightsPerCol: number[][] | undefined,
): number[][] | null {
  if (!splitColumns || !rowHeightsPerCol) {
    return null;
  }
  const rows = splitColumns.map((col, idx) => {
    const saved = rowHeightsPerCol[idx];
    return saved && saved.length === col.length ? saved : [];
  });
  return rows.some((row) => row.length > 0) ? rows : null;
}

function inferAgentKindFromAgentId(agentId?: string | null): AgentSessionKind | null {
  if (agentId === "claude-code") return "claude";
  if (agentId === "codex") return "codex";
  if (agentId === "grok") return "grok";
  if (agentId === "claude-codex") return "claude-codex";
  return null;
}

type TerminalSnapshotCacheEntry = {
  writeCounter: number;
  lines: string[];
};

const terminalSnapshotCache = new Map<string, TerminalSnapshotCacheEntry>();

function persistTurnMarksForTab(
  sessionId: string,
  stored: TurnMarkPersistSnapshot[] | undefined,
): TurnMarkPersistSnapshot[] | null {
  const live = getTurnMarkPersistSnapshot(sessionId);
  if (live !== null) {
    return live.length > 0 ? live : null;
  }
  if (!stored || stored.length === 0) return null;
  return capTurnMarkPersistSnapshots(stored);
}

function ptySessionIdForDedupeLocation(location: AgentSessionLocation): string | null {
  if (!location.paneId) return null;
  return location.tabId
    ? makeSessionId(location.workspaceId, `${location.paneId}-${location.tabId}`)
    : makeSessionId(location.workspaceId, location.paneId);
}

function collectDiscardScrollbackSessionIds(
  conflicts: AgentSessionDedupeConflict[],
): string[] {
  const sessionIds = new Set<string>();
  for (const conflict of conflicts) {
    const sessionId = ptySessionIdForDedupeLocation(conflict.loser);
    if (sessionId) sessionIds.add(sessionId);
  }
  return [...sessionIds];
}

function discardDedupeLoserScrollbacks(sessionIds: string[]): void {
  for (const sessionId of sessionIds) {
    void discardSessionScrollback(sessionId).catch((error) => {
      console.warn("[persist] Failed to discard loser scrollback:", sessionId, error);
    });
  }
}

function getTerminalSnapshot(sessionId: string): string[] | undefined {
  if (!hasTerminalBuffer(sessionId)) {
    terminalSnapshotCache.delete(sessionId);
    return undefined;
  }
  const writeCounter = getTerminalWriteCounter(sessionId);
  const cached = terminalSnapshotCache.get(sessionId);
  if (cached && cached.writeCounter === writeCounter) {
    return cached.lines;
  }
  const lines = getTerminalBufferLines(sessionId, 160, { excludeInitialReplay: true });
  terminalSnapshotCache.set(sessionId, { writeCounter, lines });
  return lines;
}

function toSuppressedAgentSessionConfigs(values: SuppressedAgentSession[] | undefined) {
  if (!values || values.length === 0) return null;
  return values.map((value) => ({
    agent_kind: value.agentKind,
    agent_session_id: value.agentSessionId,
    claude_session_id: value.claudeSessionId ?? null,
  }));
}

function appendSuppressedAgentSession(
  existing: PaneConfig["suppressed_agent_sessions"],
  value: NonNullable<PaneConfig["suppressed_agent_sessions"]>[number],
) {
  const values = existing ?? [];
  const existingIndex = values.findIndex((candidate) =>
    candidate.agent_kind === value.agent_kind
    && candidate.agent_session_id === value.agent_session_id,
  );
  if (existingIndex === -1) {
    return [...values, value].slice(-MAX_SUPPRESSED_AGENT_SESSIONS);
  }
  const stored = values[existingIndex];
  if (stored.claude_session_id || !value.claude_session_id) return values;
  return values.map((candidate, index) => index === existingIndex
    ? { ...candidate, claude_session_id: value.claude_session_id }
    : candidate);
}

const STARTUP_RESTORE_AUTOSAVE_BASE_HOLD_MS = 1400;
const STARTUP_RESTORE_AUTOSAVE_PER_WORKSPACE_MS = 700;
const STARTUP_RESTORE_AUTOSAVE_PER_PANE_MS = 500;
const STARTUP_RESTORE_AUTOSAVE_MAX_HOLD_MS = 30000;

/**
 * Reject session ids that cannot have come from an agent.
 *
 * Pre-fix handoff panes wrote `<kind>-handoff:<source pane id>` into the pane
 * mapping file; older readers surfaced the whole line as a session id and this
 * component persisted it. Restore then failed to validate it and downgraded to
 * `claude --continue`, adopting another tab's conversation in the same cwd.
 *
 * The test is deliberately loose: only characters no real id carries. Claude
 * ids are UUIDv4 and codex ids UUIDv7 (verified against ~/.mycmux/pane-sessions
 * and the persisted config), so a stricter UUID match would risk discarding a
 * legitimate id from a future agent.
 */
export function isJunkAgentSessionId(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return /[:\s/\\]/.test(sessionId);
}

function getMappingKind(
  mapping: AgentSessionMapping | undefined,
  existingKind: AgentSessionKind | null,
): AgentSessionKind | null {
  if (!mapping?.session_id || isJunkAgentSessionId(mapping.session_id)) return null;
  return mapping.agent_kind ?? existingKind ?? "claude";
}

function getTabConfigKind(
  tabConfig: PaneTabConfig,
  fallbackAgentId?: string | null,
): AgentSessionKind | null {
  return declaredAgentKind(tabConfig)
    ?? inferAgentKindFromAgentId(tabConfig.agent_id || fallbackAgentId);
}

function getTabConfigSessionId(tabConfig: PaneTabConfig): string | null {
  return declaredAgentSessionId(tabConfig);
}

function getPaneConfigKind(paneConfig: PaneConfig): AgentSessionKind | null {
  return declaredAgentKind(paneConfig) ?? inferAgentKindFromAgentId(paneConfig.agent_id);
}

function getPaneConfigSessionId(paneConfig: PaneConfig): string | null {
  return declaredAgentSessionId(paneConfig);
}

function applyMappingToTabConfig(
  tabConfig: PaneTabConfig,
  mapping: AgentSessionMapping | undefined,
  fallbackAgentId?: string | null,
): PaneTabConfig {
  const existingKind = getTabConfigKind(tabConfig, fallbackAgentId);
  const existingSessionId = getTabConfigSessionId(tabConfig);
  const mappingKind = getMappingKind(mapping, existingKind);
  if (!mapping?.session_id || !mappingKind) return tabConfig;
  if (existingSessionId && existingSessionId !== mapping.session_id) return tabConfig;
  if (existingKind && existingKind !== mappingKind) return tabConfig;

  return {
    ...tabConfig,
    agent_kind: tabConfig.agent_kind ?? mappingKind,
    agent_session_id: tabConfig.agent_session_id ?? mapping.session_id,
    claude_session_id: mappingKind === "claude"
      ? tabConfig.claude_session_id ?? mapping.session_id
      : tabConfig.claude_session_id,
  };
}

function applyMappingToPaneConfig(
  paneConfig: PaneConfig,
  mapping: AgentSessionMapping | undefined,
): PaneConfig {
  const existingKind = getPaneConfigKind(paneConfig);
  const existingSessionId = getPaneConfigSessionId(paneConfig);
  const mappingKind = getMappingKind(mapping, existingKind);
  if (!mapping?.session_id || !mappingKind) return paneConfig;
  if (existingSessionId && existingSessionId !== mapping.session_id) return paneConfig;
  if (existingKind && existingKind !== mappingKind) return paneConfig;

  return {
    ...paneConfig,
    agent_kind: paneConfig.agent_kind ?? mappingKind,
    agent_session_id: paneConfig.agent_session_id ?? mapping.session_id,
    claude_session_id: mappingKind === "claude"
      ? paneConfig.claude_session_id ?? mapping.session_id
      : paneConfig.claude_session_id,
  };
}

export function applyMappingsToConfig(
  cfg: WorkspaceConfig,
  agentMappings: Record<string, AgentSessionMapping>,
): WorkspaceConfig {
  return {
    ...cfg,
    panes: cfg.panes.map((paneConfig) => {
      const paneId = paneConfig.pane_id;
      if (!paneId) return paneConfig;

      const paneSessionId = makeSessionId(cfg.id, paneId);
      const paneMapping = agentMappings[paneSessionId];
      const tabs = paneConfig.tabs?.map((tabConfig, index) => {
        if (!isRestorableTab(tabConfig)) return tabConfig;
        const tabId = tabConfig.tab_id;
        if (!tabId) return tabConfig;
        const tabSessionId = makeSessionId(cfg.id, `${paneId}-${tabId}`);
        const tabMapping = agentMappings[tabSessionId];
        const isActiveTab = paneConfig.active_tab_id
          ? tabId === paneConfig.active_tab_id
          : index === 0;
        return applyMappingToTabConfig(
          tabConfig,
          tabMapping ?? (isActiveTab ? paneMapping : undefined),
          paneConfig.agent_id,
        );
      });

      const mappedPane = applyMappingToPaneConfig(paneConfig, paneMapping);
      return tabs ? { ...mappedPane, tabs } : mappedPane;
    }),
  };
}

export function collectWorkspaceConfigSessionIds(configs: WorkspaceConfig[]): string[] {
  const sessionIds = new Set<string>();
  for (const config of configs) {
    for (const pane of config.panes) {
      if (!pane.pane_id) continue;
      sessionIds.add(makeSessionId(config.id, pane.pane_id));
      for (const tab of pane.tabs ?? []) {
        if (isRestorableTab(tab) && tab.tab_id) {
          sessionIds.add(makeSessionId(config.id, `${pane.pane_id}-${tab.tab_id}`));
        }
      }
    }
  }
  return Array.from(sessionIds);
}

export function collectLiveTerminalSessionIds(): string[] {
  const sessionIds = new Set<string>();
  for (const workspace of useWorkspaceListStore.getState().workspaces) {
    for (const pane of workspace.panes) {
      const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
      if (!activeTab || !isDeclaredTab(activeTab)) sessionIds.add(pane.sessionId);
      for (const tab of pane.tabs) {
        if (tab.type === "terminal" && isRestorableTab(tab)) sessionIds.add(tab.sessionId);
      }
    }
  }
  return Array.from(sessionIds);
}

function tabConfigHasRestorableAgentSession(tab: PaneTabConfig): boolean {
  return isRestorableTab(tab) && Boolean((tab.agent_kind && tab.agent_session_id) || tab.claude_session_id);
}

type SocketRequestPayload = {
  id: number;
  cmd: string;
  args?: Record<string, unknown> | null;
};

function paneConfigHasRestorableAgentSession(pane: PaneConfig): boolean {
  return Boolean(
    (pane.agent_kind && pane.agent_session_id)
    || pane.claude_session_id
    || pane.tabs?.some(tabConfigHasRestorableAgentSession),
  );
}

function workspaceConfigHasRestorableAgentSession(cfg: WorkspaceConfig): boolean {
  return cfg.panes.some(paneConfigHasRestorableAgentSession);
}

function paneConfigRestorableAgentSessionCount(pane: PaneConfig): number {
  const tabCount = pane.tabs?.filter(tabConfigHasRestorableAgentSession).length ?? 0;
  if (tabCount > 0) return tabCount;
  return paneConfigHasRestorableAgentSession(pane) ? 1 : 0;
}

function workspaceConfigRestorableAgentSessionCount(cfg: WorkspaceConfig): number {
  return cfg.panes.reduce(
    (count, pane) => count + paneConfigRestorableAgentSessionCount(pane),
    0,
  );
}

function getConfigAgentSessionKey(
  kind: AgentSessionKind | null | undefined,
  sessionId: string | null | undefined,
): string | null {
  if (!kind || !sessionId) return null;
  return `${kind}:${sessionId}`;
}

function getTabAgentSessionKey(tab: PaneTabConfig): string | null {
  if (!isRestorableTab(tab)) return null;
  return getConfigAgentSessionKey(declaredAgentKind(tab), declaredAgentSessionId(tab));
}

function getPaneAgentSessionKey(pane: PaneConfig): string | null {
  return getConfigAgentSessionKey(getPaneConfigKind(pane), getPaneConfigSessionId(pane));
}

function clearDuplicateTabAgentSession(tab: PaneTabConfig): PaneTabConfig {
  const kind = declaredAgentKind(tab);
  const sessionId = declaredAgentSessionId(tab);
  return {
    ...tab,
    suppressed_agent_sessions: kind && sessionId
      ? appendSuppressedAgentSession(tab.suppressed_agent_sessions, {
          agent_kind: kind,
          agent_session_id: sessionId,
          claude_session_id: tab.claude_session_id ?? null,
        })
      : tab.suppressed_agent_sessions ?? null,
    claude_session_id: null,
    agent_kind: null,
    agent_session_id: null,
    terminal_snapshot: null,
    turn_marks: null,
  };
}

function clearDuplicatePaneAgentSession(pane: PaneConfig): PaneConfig {
  const kind = getPaneConfigKind(pane);
  const sessionId = getPaneConfigSessionId(pane);
  return {
    ...pane,
    suppressed_agent_sessions: kind && sessionId
      ? appendSuppressedAgentSession(pane.suppressed_agent_sessions, {
          agent_kind: kind,
          agent_session_id: sessionId,
          claude_session_id: pane.claude_session_id ?? null,
        })
      : pane.suppressed_agent_sessions ?? null,
    claude_session_id: null,
    agent_kind: null,
    agent_session_id: null,
  };
}

function clearAgentTerminalSnapshot(tab: PaneTabConfig): PaneTabConfig {
  return {
    ...tab,
    terminal_snapshot: null,
  };
}

function clearStaleAgentErrorSnapshot(tab: PaneTabConfig): PaneTabConfig {
  const hasStaleAgentError = (tab.terminal_snapshot ?? []).some((line) =>
    /Session ID .*already in use/i.test(line),
  );
  return hasStaleAgentError ? clearAgentTerminalSnapshot(tab) : tab;
}

function normalizeAgentSessionTab(tab: PaneTabConfig): PaneTabConfig {
  const agentId = agentIdForSessionKind(declaredAgentKind(tab));
  return {
    ...clearAgentTerminalSnapshot(tab),
    agent_id: agentId ?? tab.agent_id,
  };
}

function normalizeAgentSessionPane(pane: PaneConfig): PaneConfig {
  const agentId = agentIdForSessionKind(getPaneConfigKind(pane));
  return {
    ...pane,
    agent_id: agentId ?? pane.agent_id,
  };
}

function syncPaneAgentSessionFromActiveTab(pane: PaneConfig, tabs: PaneTabConfig[] | null | undefined): PaneConfig {
  if (!tabs || tabs.length === 0) {
    return pane;
  }
  const activeTab = tabs.find((tab) => tab.tab_id === pane.active_tab_id) ?? tabs[0];
  const kind = declaredAgentKind(activeTab);
  const sessionId = declaredAgentSessionId(activeTab);
  return {
    ...pane,
    tabs,
    agent_id: activeTab.agent_id ?? pane.agent_id,
    claude_session_id: kind === "claude" ? sessionId : null,
    agent_kind: sessionId ? kind : null,
    agent_session_id: sessionId,
  };
}

function tabConfigWithPaneAgentSessionFallback(tab: PaneTabConfig, pane: PaneConfig): PaneTabConfig {
  if (tab.lifecycle === "declared") {
    return {
      ...tab,
      claude_session_id: null,
      agent_kind: null,
      agent_session_id: null,
      suppressed_agent_sessions: null,
      terminal_snapshot: null,
      turn_marks: null,
    };
  }
  if (!isRestorableTab(tab)) return tab;
  if (getTabAgentSessionKey(tab)) return tab;
  const paneKind = getPaneConfigKind(pane);
  const paneSessionId = getPaneConfigSessionId(pane);
  if (!paneKind || !paneSessionId) return tab;
  return {
    ...tab,
    agent_kind: tab.agent_kind ?? paneKind,
    agent_session_id: tab.agent_session_id ?? paneSessionId,
    claude_session_id: paneKind === "claude"
      ? tab.claude_session_id ?? paneSessionId
      : tab.claude_session_id,
  };
}

/**
 * Drop agent-session ids that cannot be real (see isJunkAgentSessionId). Runs on
 * both the load and the save path, so a config already poisoned by the pre-fix
 * handoff branches is neutralised on the next launch instead of driving another
 * `claude --continue` hijack.
 */
function clearJunkAgentSessionFields<T extends AgentSessionConfigFields>(config: T): T {
  const junkAgentSessionId = isJunkAgentSessionId(config.agent_session_id);
  const junkClaudeSessionId = isJunkAgentSessionId(config.claude_session_id);
  if (!junkAgentSessionId && !junkClaudeSessionId) return config;
  return {
    ...config,
    agent_kind: junkAgentSessionId ? null : config.agent_kind,
    agent_session_id: junkAgentSessionId ? null : config.agent_session_id,
    claude_session_id: junkClaudeSessionId ? null : config.claude_session_id,
  };
}

function clearJunkAgentSessionsInConfig(cfg: WorkspaceConfig): WorkspaceConfig {
  return {
    ...cfg,
    panes: cfg.panes.map((pane) => {
      const sanitizedPane = clearJunkAgentSessionFields(pane);
      const tabs = pane.tabs?.map(clearJunkAgentSessionFields);
      return tabs ? { ...sanitizedPane, tabs } : sanitizedPane;
    }),
  };
}

export function dedupeAgentSessionsInConfigs(
  inputConfigs: WorkspaceConfig[],
  activeWorkspaceId: string | null | undefined,
  activePaneId: string | null | undefined,
  activeTabId: string | null | undefined,
): AgentSessionDedupeResult {
  const configs = inputConfigs.map(clearJunkAgentSessionsInConfig);
  const winningCandidateIds = new Set<string>();
  const claimedKeys = new Set<string>();
  const candidates: Array<{
    candidateId: string;
    key: string;
    isActive: boolean;
    selfOwned: boolean;
    order: number;
    location: AgentSessionLocation;
  }> = [];
  let order = 0;

  configs.forEach((cfg, workspaceIndex) => {
    const isActiveWorkspace = cfg.id === activeWorkspaceId;
    cfg.panes.forEach((pane, paneIndex) => {
      const tabs = pane.tabs ?? [];
      if (tabs.length === 0) {
        const key = getPaneAgentSessionKey(pane);
        if (!key) return;
        const isActivePane = isActiveWorkspace && pane.pane_id === activePaneId;
        candidates.push({
          candidateId: `${workspaceIndex}:${paneIndex}:pane`,
          key,
          isActive: isActivePane,
          selfOwned: false,
          order: order++,
          location: {
            workspaceId: cfg.id,
            paneId: pane.pane_id ?? null,
            tabId: null,
          },
        });
        return;
      }
      const activeTabConfigId = pane.active_tab_id ?? tabs[0]?.tab_id ?? null;
      const tabsWithPaneFallback = tabs.map((tab) =>
        tab.tab_id === activeTabConfigId ? tabConfigWithPaneAgentSessionFallback(tab, pane) : tab,
      );
      tabsWithPaneFallback.forEach((tab, tabIndex) => {
        const key = getTabAgentSessionKey(tab);
        if (!key) return;
        const isActivePane = isActiveWorkspace && pane.pane_id === activePaneId;
        const isActiveTab = isActiveWorkspace && tab.tab_id === activeTabId;
        const isPaneActiveTab = isActivePane && tab.tab_id === pane.active_tab_id;
        candidates.push({
          candidateId: `${workspaceIndex}:${paneIndex}:${tabIndex}`,
          key,
          isActive: isActiveTab || isPaneActiveTab,
          selfOwned: tab.tab_id === declaredAgentSessionId(tab),
          order: order++,
          location: {
            workspaceId: cfg.id,
            paneId: pane.pane_id ?? null,
            tabId: tab.tab_id ?? null,
          },
        });
      });
    });
  });

  const winnerByKey = new Map<string, typeof candidates[number]>();
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  candidates
    .sort((a, b) =>
      Number(b.isActive) - Number(a.isActive)
      || Number(b.selfOwned) - Number(a.selfOwned)
      || a.order - b.order,
    )
    .forEach((candidate) => {
      if (claimedKeys.has(candidate.key)) return;
      claimedKeys.add(candidate.key);
      winningCandidateIds.add(candidate.candidateId);
      winnerByKey.set(candidate.key, candidate);
    });

  const conflicts: AgentSessionDedupeConflict[] = [];
  const recordConflict = (candidateId: string, key: string) => {
    const winner = winnerByKey.get(key);
    const loser = candidateById.get(candidateId);
    if (!winner || !loser) return;
    const reason = winner.isActive !== loser.isActive
      ? "active"
      : winner.selfOwned !== loser.selfOwned
        ? "self-owned"
        : "order";
    conflicts.push({ key, reason, winner: winner.location, loser: loser.location });
  };

  const dedupedConfigs = configs.map((cfg, workspaceIndex) => ({
    ...cfg,
    panes: cfg.panes.map((pane, paneIndex) => {
      if (!pane.tabs || pane.tabs.length === 0) {
        const key = getPaneAgentSessionKey(pane);
        if (!key) return pane;
        const candidateId = `${workspaceIndex}:${paneIndex}:pane`;
        if (winningCandidateIds.has(candidateId)) {
          return normalizeAgentSessionPane(pane);
        }
        recordConflict(candidateId, key);
        return clearDuplicatePaneAgentSession(pane);
      }
      const activeTabConfigId = pane.active_tab_id ?? pane.tabs[0]?.tab_id ?? null;
      const sourceTabs = pane.tabs.map((tab) =>
        tab.tab_id === activeTabConfigId ? tabConfigWithPaneAgentSessionFallback(tab, pane) : tab,
      );
      const tabs = sourceTabs.map((tab, tabIndex) => {
        const cleanedTab = clearStaleAgentErrorSnapshot(tab);
        const key = getTabAgentSessionKey(cleanedTab);
        if (!key) return cleanedTab;
        const candidateId = `${workspaceIndex}:${paneIndex}:${tabIndex}`;
        if (winningCandidateIds.has(candidateId)) {
          return normalizeAgentSessionTab(cleanedTab);
        }
        recordConflict(candidateId, key);
        return clearDuplicateTabAgentSession(cleanedTab);
      });
      return syncPaneAgentSessionFromActiveTab(pane, tabs);
    }),
  }));
  return {
    configs: dedupedConfigs,
    conflicts,
    discardScrollbackSessionIds: collectDiscardScrollbackSessionIds(conflicts),
  };
}

function dropEmptyTabPanesFromConfig(cfg: WorkspaceConfig): WorkspaceConfig {
  const indexMap = new Map<number, number>();
  const panes = cfg.panes.filter((pane, oldIndex) => {
    const keepPane = !pane.tabs || pane.tabs.length > 0;
    if (keepPane) {
      indexMap.set(oldIndex, indexMap.size);
    }
    return keepPane;
  });

  if (panes.length === cfg.panes.length) {
    return cfg;
  }

  const split_columns = cfg.split_columns
    ?.map((col) => col.map((index) => indexMap.get(index)).filter((index): index is number => index !== undefined))
    .filter((col) => col.length > 0) ?? null;

  return {
    ...cfg,
    panes,
    split_columns,
    column_widths: null,
    row_heights_per_col: null,
  };
}

// Must stay in sync with the remove_var() list in src-tauri/src/lib.rs::run().
// Anything that lib.rs strips at startup must also be stripped before persistence,
// otherwise saved launch_env can re-inject MYCMUX_* into a freshly spawned pane on
// next launch (env-pollution → unintended agent auto-resume).
const EPHEMERAL_LAUNCH_ENV_KEYS = new Set([
  "MYCMUX_RESUME",
  "MYCMUX_SESSION_ID",
  "MYCMUX_AGENT_KIND",
  "MYCMUX_RESUME_FORK",
  "MYCMUX_LAUNCH_TARGET",
  "MYCMUX_HANDOFF",
  "MYCMUX_HANDOFF_FROM",
  "MYCMUX_HANDOFF_PROMPT_FILE",
  "MYCMUX_HANDOFF_FROM_SESSION",
  "MYCMUX_PANE_SESSION_ID",
  "MYCMUX_TAB_ID",
  "MYCMUX_HTML_OUT",
  "MYCMUX_MARKDOWN_OUT",
  "MYCMUX_ARTIFACTS_DIR",
  "MYCMUX_RUNTIME_DIR",
  "__CMUX_LAUNCHER_DONE",
]);

function stripEphemeralLaunchEnv(
  env: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!EPHEMERAL_LAUNCH_ENV_KEYS.has(k.toUpperCase())) {
      filtered[k] = v;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}

function mirrorPtyMetadataForPersistence(meta: PtyMetadata): void {
  const processIsShell = isShellProcess(meta.process_name ?? undefined);
  const agentActive = meta.agent_active === true;
  const paneMetadataStore = usePaneMetadataStore.getState();
  const workspaceListStore = useWorkspaceListStore.getState();
  const clearSuppressed = paneMetadataStore.metadata[meta.session_id]?.agentStatus === "waiting";
  // Shares the consecutive-observation guard with the live listener in
  // App.tsx — a single flappy shell reading (agent running a tool
  // subprocess) must not wipe the persisted session markers on save.
  if (confirmAgentSessionClear(meta.session_id, processIsShell, agentActive, clearSuppressed)) {
    paneMetadataStore.clearAgentSessionId(meta.session_id);
    paneMetadataStore.clearClaudeSessionId(meta.session_id);
    workspaceListStore.setPaneAgentSessionFromMetadata(meta.session_id, null);
  }
  const sessionPayload = agentActive && (meta.claude_session_id || meta.agent_session_id)
    ? {
        claudeSessionId: meta.claude_session_id ?? undefined,
        agentKind: meta.agent_kind ?? undefined,
        agentSessionId: meta.agent_session_id ?? undefined,
      }
    : null;
  const sessionClaim = sessionPayload
    ? workspaceListStore.setPaneAgentSessionFromMetadata(meta.session_id, sessionPayload)
    : null;
  const sessionClaimAccepted = sessionClaim?.accepted ?? true;
  if (sessionClaim?.conflict) {
    const currentMeta = paneMetadataStore.metadata[meta.session_id];
    const currentMetaKey = agentSessionIdentityKey(
      currentMeta?.agentKind,
      currentMeta?.agentSessionId,
      currentMeta?.claudeSessionId,
    );
    if (currentMetaKey === sessionClaim.conflict.key) {
      paneMetadataStore.clearAgentSessionId(meta.session_id);
      paneMetadataStore.clearClaudeSessionId(meta.session_id);
    }
  }
  paneMetadataStore.setMetadata(meta.session_id, {
    cwd: meta.cwd,
    gitBranch: meta.git_branch,
    processIsShell,
    claudeSessionId: sessionClaimAccepted && agentActive ? meta.claude_session_id ?? undefined : undefined,
    agentKind: sessionClaimAccepted && agentActive ? meta.agent_kind ?? undefined : undefined,
    agentSessionId: sessionClaimAccepted && agentActive ? meta.agent_session_id ?? undefined : undefined,
  });
  paneMetadataStore.setVolatileMetadata(meta.session_id, {
    processTitle: meta.process_name ?? undefined,
  });
}

async function flushPtyMetadataSnapshotForPersistence(): Promise<void> {
  const snapshot = await getPtyMetadataSnapshot();
  for (const meta of Object.values(snapshot)) {
    mirrorPtyMetadataForPersistence(meta);
  }
}

export function toConfig(ws: Workspace, _agentMappings: Record<string, AgentSessionMapping> = {}): WorkspaceConfig {
  const metaState = usePaneMetadataStore.getState().metadata;
  const paneEntries = ws.panes
    .map((pane) => {
      // Ephemeral tabs (isolated CLI login) are dropped alongside browser tabs:
      // their staging directory is gone by the next launch, so restoring them
      // would revive a terminal pointed at nothing.
      const persistedTabs = pane.tabs.filter((tab) => tab.type !== "browser" && !tab.ephemeral);
      if (persistedTabs.length === 0) return null;
      const terminalTabs = persistedTabs.filter((tab) => tab.type !== "online");
      if (terminalTabs.length === 0) return null;
      const activeTab = terminalTabs.find((tab) => tab.id === pane.activeTabId) ?? terminalTabs[0];
      return { pane, activeTab, persistedTabs: terminalTabs };
    })
    .filter((entry): entry is {
      pane: Workspace["panes"][number];
      activeTab: Workspace["panes"][number]["tabs"][number];
      persistedTabs: Workspace["panes"][number]["tabs"];
    } => entry !== null);

  const previousSplitColumns = normalizeSplitColumns(ws) ?? [];
  const paneIdToIndex = new Map(paneEntries.map((entry, i) => [entry.pane.id, i]));
  const persistedPaneIds = new Set(paneEntries.map((entry) => entry.pane.id));
  const splitColumns = reconcileSplitColumnsForPanes(
    previousSplitColumns
      .map((col) => col.filter((id) => persistedPaneIds.has(id)))
      .filter((col) => col.length > 0),
    paneEntries.map((entry) => entry.pane.id),
  );
  const split_columns = splitColumns
    ?.map((col) => col.map((id) => paneIdToIndex.get(id)).filter((i): i is number => i !== undefined))
    .filter((col) => col.length > 0) ?? null;
  // Retired persistence contract retained for the static layout stability audit:
  // const droppedEphemeralPane = paneEntries.length !== ws.panes.length;
  // column_widths: droppedEphemeralPane ? null : normalizeColumnWidths(ws, splitColumns),
  // row_heights_per_col: droppedEphemeralPane ? null : normalizeRowHeightsPerCol(ws, splitColumns),
  const columnWidths = normalizeColumnWidths(
    splitColumns,
    reconcileColumnWidths(previousSplitColumns, ws.columnWidths, splitColumns),
  );
  const rowHeightsPerCol = normalizeRowHeightsPerCol(
    splitColumns,
    reconcileRowHeightsPerCol(previousSplitColumns, ws.rowHeightsPerCol, splitColumns),
  );

  return {
    id: ws.id,
    name: ws.name,
    grid_template_id: ws.gridTemplateId,
    // Workspace color must round-trip: it is the only sidebar grouping cue and
    // silently dropping it here would reset every group on restart.
    color: ws.color ?? null,
    pet: ws.pet ?? null,
    panes: paneEntries.map(({ pane: p, activeTab, persistedTabs }) => {
      const paneMeta = metaState[p.sessionId];
      const activeTabMeta = activeTab ? metaState[activeTab.sessionId] : undefined;
      const activeTabDeclared = isDeclaredTab(activeTab);
      const paneCwd = paneMeta?.cwd ?? activeTab?.cwd ?? p.cwd ?? null;
      // 4-level fallback so live agent session metadata never disappears even
      // if the workspaceListStore mirror lags one event behind:
      //   1. activeTab.{claudeSessionId,agentKind,agentSessionId}
      //   2. Pane mirror.{...}
      //   3. paneMetadataStore[pane.sessionId]
      //   4. paneMetadataStore[activeTab.sessionId]
      const liveClaudeId = activeTabDeclared
        ? null
        : activeTab.claudeSessionId
          ?? p.claudeSessionId
          ?? paneMeta?.claudeSessionId
          ?? activeTabMeta?.claudeSessionId
          ?? null;
      const liveKind = activeTabDeclared
        ? null
        : activeTab.agentKind
          ?? p.agentKind
          ?? paneMeta?.agentKind
          ?? activeTabMeta?.agentKind
          ?? null;
      const liveAgentId = activeTabDeclared
        ? null
        : activeTab.agentSessionId
          ?? p.agentSessionId
          ?? paneMeta?.agentSessionId
          ?? activeTabMeta?.agentSessionId
          ?? null;
      return {
        pane_id: p.id,
        agent_id: activeTab?.agentId ?? p.agentId,
        label: p.label ?? null,
        cwd: paneCwd,
        last_process: null,
        claude_session_id: liveClaudeId,
        agent_kind: liveKind,
        agent_session_id: liveAgentId,
        suppressed_agent_sessions: activeTabDeclared
          ? null
          : toSuppressedAgentSessionConfigs(
            activeTab.suppressedAgentSessions ?? p.suppressedAgentSessions,
          ),
        launch_env: stripEphemeralLaunchEnv(p.launchEnv ?? activeTab?.launchEnv),
        active_tab_id: activeTab.id,
        // A pin aimed at a browser/online tab has no persisted counterpart, so
        // it must save as null instead of a dangling id.
        pinned_tab_id: persistedTabs.some((t) => t.id === p.pinnedTabId)
          ? p.pinnedTabId ?? null
          : null,
        tabs: persistedTabs.map((tab) => {
          const tabMeta = metaState[tab.sessionId];
          const declared = isDeclaredTab(tab);
          const isActivePersistedTab = tab.id === activeTab.id;
          const tabKind = declared
            ? null
            : tab.agentKind ?? tabMeta?.agentKind ?? (isActivePersistedTab ? liveKind : null);
          const tabAgentId = declared
            ? null
            : tab.agentSessionId
              ?? tabMeta?.agentSessionId
              ?? (isActivePersistedTab ? liveAgentId ?? liveClaudeId : null);
          const tabClaudeId = declared
            ? null
            : tab.claudeSessionId
              ?? tabMeta?.claudeSessionId
              ?? (isActivePersistedTab && tabKind === "claude" ? tabAgentId ?? liveClaudeId : null);
          return {
            tab_id: tab.id,
            agent_id: tab.agentId,
            label: tab.label ?? null,
            label_source: tab.labelSource ?? null,
            type: "terminal" as const,
            cwd: tabMeta?.cwd ?? tab.cwd ?? paneCwd,
            last_process: null,
            claude_session_id: tabClaudeId,
            agent_kind: tabKind,
            agent_session_id: tabAgentId,
            suppressed_agent_sessions: declared
              ? null
              : toSuppressedAgentSessionConfigs(tab.suppressedAgentSessions),
            launch_env: stripEphemeralLaunchEnv(tab.launchEnv),
            terminal_snapshot: declared
              ? null
              : getTerminalSnapshot(tab.sessionId) ?? tab.terminalSnapshot ?? null,
            turn_marks: declared ? null : persistTurnMarksForTab(tab.sessionId, tab.turnMarks),
            lifecycle: tab.lifecycle ?? null,
            origin: tab.origin
              ? { kind: tab.origin.kind, parent_tab_id: tab.origin.parentTabId ?? null }
              : null,
            declared_prompt: tab.declaredPrompt ?? null,
            declared_target: tab.declaredTarget ?? null,
          };
        }),
      };
    }),
    created_at: ws.createdAt,
    split_columns,
    column_widths: columnWidths,
    row_heights_per_col: rowHeightsPerCol,
  };
}

let _resolveLoaded: () => void;
export const persistLoaded = new Promise<void>((resolve) => {
  _resolveLoaded = resolve;
});

/**
 * Take over workspaces handed to this window by another one (Phase 3b):
 * a child booting after a tear-out, or main after a merge-back.
 *
 * Restore — not respawn. The configs carry the original pane/tab ids, so
 * `makeSessionId` reproduces the same session ids and `create_session` takes
 * the reattach branch in `pty/manager.rs`. Nothing here may kill a session.
 */
function adoptWorkspaceConfigs(configs: WorkspaceConfig[]): string[] {
  const restorable = filterAlreadyRestoredConfigs(configs)
    .map(dropEmptyTabPanesFromConfig)
    .filter((cfg) => cfg.panes.length > 0);
  if (restorable.length === 0) return [];

  const hadWorkspaces = useWorkspaceListStore.getState().workspaces.length > 0;
  const { restoredWorkspaceIds } = restoreWorkspaceConfigs(restorable);

  // Only an empty window auto-selects. A merge-back into a working main window
  // must not yank the user off whatever they were looking at.
  const firstAdoptedId = restoredWorkspaceIds[0];
  if (!hadWorkspaces && firstAdoptedId) {
    const listStore = useWorkspaceListStore.getState();
    listStore.setActiveWorkspace(firstAdoptedId);
    focusController.request("programmatic", {
      sessionId: listStore.getWorkspace(firstAdoptedId)?.panes[0]?.sessionId ?? null,
      focus: false,
    });
  }
  return restoredWorkspaceIds;
}

/**
 * External pets live on disk and are only known through `list_pets`. Without
 * this startup load the catalog is just the bundled pet, so every workspace
 * assigned an external pet silently renders as Clawd until the Pet settings
 * tab happens to mount and rescan — which made the pet appear to "change"
 * after opening and closing settings.
 */
async function loadPetCatalog(): Promise<void> {
  try {
    const listed = await listPets();
    usePetSettingsStore.getState().setPets(candidatesFromListedPets(listed).candidates);
  } catch (error) {
    console.warn("[pets] Failed to load pet catalog at startup:", error);
  }
}

/**
 * Child-window boot. No `data.json` read (that stays main's), no leadership
 * claim: settings/theme/keybindings come from `get_app_settings`, workspaces
 * from the adoption queue the tear-out filled before this window existed.
 */
async function hydrateChildWindow(): Promise<void> {
  const settings = await getAppSettings();
  useThemeStore.getState().hydrateSettings({
    themeId: settings.theme_id,
    fontSize: settings.font_size,
    lineHeight: settings.line_height,
    fontFamily: settings.font_family,
    themeTweaks: settings.theme_tweaks,
    uiDensity: settings.ui_density,
    uiFontScale: settings.ui_font_scale,
  });
  useKeybindingStore.getState().hydrateOverrides(settings.keybindings ?? {});
  usePetSettingsStore.getState().hydratePetSettings({
    petDisplayMode: settings.pet_display_mode,
    petNewWorkspaceMode: settings.pet_new_ws_mode,
    petDisabled: settings.pet_disabled,
    petFixedId: settings.pet_fixed_id ?? undefined,
  });
  useAiSettingsStore.getState().hydrateAiSettings({
    aiProvider: normalizeAiProvider(settings.ai_provider),
    aiModel: settings.ai_model,
    aiEnabled: settings.ai_enabled,
  });
  void loadPetCatalog();

  const adopted = await takePendingAdoption(windowLabel());
  if (adopted.length > 0) {
    adoptWorkspaceConfigs(adopted);
  }
}

/** This window's current workspaces, in the shape `data.json` stores. */
function buildWindowFragment(): WindowFragment {
  const state = useWorkspaceListStore.getState();
  const uiState = useUiStore.getState();
  const activeSessionId = uiState.activePaneId;
  const activeWorkspace = state.workspaces.find((workspace) =>
    workspaceContainsSession(workspace, activeSessionId),
  ) ?? state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null;
  const activePane = activeWorkspace?.panes.find((pane) =>
    paneContainsSession(pane, activeSessionId),
  ) ?? null;
  const activeTab = activePane?.tabs.find((tab) => tab.sessionId === activeSessionId)
    ?? activePane?.tabs.find((tab) => tab.id === activePane.activeTabId)
    ?? null;

  return {
    window_label: windowLabel(),
    workspaces: state.workspaces
      .map((workspace) => toConfig(workspace))
      .filter((config) => config.panes.length > 0),
    active_workspace_id: activeWorkspace?.id ?? null,
    active_pane_id: activePane?.id ?? null,
    active_tab_id: activeTab?.id ?? null,
  };
}

export function useWorkspacePersist() {
  const loaded = useRef(false);
  const isLeader = useRef(false);
  const lastActivePaneSessionId = useRef<string | null>(null);
  const startupAutosaveHoldUntil = useRef(0);

  useEffect(() => {
    const reportVisibility = () => {
      void setAppFrontendVisible(document.visibilityState !== "hidden").catch(() => {});
    };
    reportVisibility();
    document.addEventListener("visibilitychange", reportVisibility);
    return () => document.removeEventListener("visibilitychange", reportVisibility);
  }, []);

  useEffect(() => {
    // `claimLeader` is a one-shot bootstrap operation. The existing ref is
    // therefore the authoritative leader state for this event, rather than
    // attempting a second claim for every WorkOrder spawn request.
    if (!isMainWindow()) return;

    const unlisten = listen<SpawnRequest>("workorder://spawn-request", (event) => {
      if (!isLeader.current) {
        return;
      }
      void handleWorkOrderSpawnRequest(event.payload);
    });

    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  // Load on mount — only leader bootstraps
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    // Multi-window: the persistence engine is a main-window singleton. Child
    // windows must not even *attempt* leadership — claiming it is a one-shot
    // compare_exchange, so a child that raced ahead of main would take the
    // flag and main would then load nothing. A child hydrates from
    // get_app_settings + its adoption queue instead (Phase 3b).
    if (!isMainWindow()) {
      isLeader.current = false;
      hydrateChildWindow()
        .catch((err) => {
          console.warn("[persist] Failed to hydrate child window:", err);
        })
        .finally(() => {
          _resolveLoaded();
        });
      return;
    }

    claimLeader()
      .then((gotLeadership) => {
        isLeader.current = gotLeadership;
        if (!gotLeadership) {
          _resolveLoaded();
          return;
        }
        // Leader: load persisted data
        return loadPersistentData().then(async (data) => {
          let startupAgentMappings: Record<string, AgentSessionMapping> = {};
          try {
            startupAgentMappings = await readAgentSessionMappings(
              collectWorkspaceConfigSessionIds(data.workspaces),
            );
          } catch (err) {
            console.warn("[persist] Failed to read startup agent session mappings:", err);
          }
          useThemeStore.getState().hydrateSettings({
            themeId: data.settings.theme_id,
            fontSize: data.settings.font_size,
            lineHeight: data.settings.line_height,
            fontFamily: data.settings.font_family,
            themeTweaks: data.settings.theme_tweaks,
            uiDensity: data.settings.ui_density,
            uiFontScale: data.settings.ui_font_scale,
          });
          useKeybindingStore.getState().hydrateOverrides(data.settings.keybindings ?? {});
          usePetSettingsStore.getState().hydratePetSettings({
            petDisplayMode: data.settings.pet_display_mode,
            petNewWorkspaceMode: data.settings.pet_new_ws_mode,
            petDisabled: data.settings.pet_disabled,
            petFixedId: data.settings.pet_fixed_id ?? undefined,
          });
          useAiSettingsStore.getState().hydrateAiSettings({
            aiProvider: normalizeAiProvider(data.settings.ai_provider),
            aiModel: data.settings.ai_model,
            aiEnabled: data.settings.ai_enabled,
          });
          void loadPetCatalog();

          if (data.workspaces.length > 0) {
            const listStore = useWorkspaceListStore.getState();
            let restoredActivePaneSessionId: string | null = null;
            const bootstrapWorkspaceIds = new Set(listStore.workspaces.map((ws) => ws.id));
            const persistedConfigs = data.workspaces
              .map(dropEmptyTabPanesFromConfig)
              .filter((cfg) => cfg.panes.length > 0);
            const safeStartupMappings = filterConflictingAgentMappings(
              persistedConfigs,
              startupAgentMappings,
            );
            const restoredDedupe = dedupeAgentSessionsInConfigs(
              persistedConfigs.map((cfg) => applyMappingsToConfig(cfg, safeStartupMappings)),
              data.active_workspace_id,
              data.active_pane_id,
              data.active_tab_id,
            );
            const restoredConfigs = restoredDedupe.configs;
            reportAgentSessionDedupeConflicts(restoredDedupe.conflicts);
            discardDedupeLoserScrollbacks(restoredDedupe.discardScrollbackSessionIds);
            const startupRestoreTargetWorkspaceCount = restoredConfigs.filter(workspaceConfigHasRestorableAgentSession).length;
            const startupRestoreTargetPaneCount = restoredConfigs.reduce(
              (count, cfg) => count + workspaceConfigRestorableAgentSessionCount(cfg),
              0,
            );
            startupAutosaveHoldUntil.current = startupRestoreTargetPaneCount > 0
              ? Date.now() + Math.min(
                  STARTUP_RESTORE_AUTOSAVE_MAX_HOLD_MS,
                  STARTUP_RESTORE_AUTOSAVE_BASE_HOLD_MS
                    + startupRestoreTargetWorkspaceCount * STARTUP_RESTORE_AUTOSAVE_PER_WORKSPACE_MS
                    + startupRestoreTargetPaneCount * STARTUP_RESTORE_AUTOSAVE_PER_PANE_MS,
                )
              : 0;

            if (listStore.workspaces.length <= 1) {
              // Shared with the multi-window adoption paths (child boot after a
              // tear-out, main after a merge-back) — see lib/workspaceRestore.ts.
              restoredActivePaneSessionId = restoreWorkspaceConfigs(restoredConfigs, {
                activeWorkspaceId: data.active_workspace_id,
                activePaneId: data.active_pane_id,
                activeTabId: data.active_tab_id,
              }).activePaneSessionId;
              const restoredWorkspaceIds = new Set(restoredConfigs.map((cfg) => cfg.id));
              for (const bootstrapId of bootstrapWorkspaceIds) {
                if (!restoredWorkspaceIds.has(bootstrapId)) {
                  listStore.removeWorkspace(bootstrapId);
                }
              }

              const fallbackWorkspaceId = restoredConfigs[restoredConfigs.length - 1]?.id ?? null;
              const nextActiveWorkspaceId =
                data.active_workspace_id && restoredWorkspaceIds.has(data.active_workspace_id)
                  ? data.active_workspace_id
                  : fallbackWorkspaceId ?? restoredConfigs[0]?.id ?? null;

              if (nextActiveWorkspaceId) {
                useWorkspaceListStore.getState().setActiveWorkspace(nextActiveWorkspaceId);
              }
              if (!restoredActivePaneSessionId && nextActiveWorkspaceId) {
                restoredActivePaneSessionId =
                  useWorkspaceListStore.getState().getWorkspace(nextActiveWorkspaceId)?.panes[0]?.sessionId ?? null;
              }
              lastActivePaneSessionId.current = restoredActivePaneSessionId;
              focusController.request("programmatic", {
                sessionId: restoredActivePaneSessionId,
                focus: false,
              });
            }
          }
          _resolveLoaded();
        });
      })
      .catch((err) => {
        console.warn("[persist] Failed to load:", err);
        _resolveLoaded();
      });
  }, []);

  // Auto-save — only leader saves. Dirty-flag + debounce (interval retired).
  useEffect(() => {
    // Multi-window (Phase 3a): main is the sole data.json writer AND the sole
    // owner of the quit path. A child window registers neither the store
    // subscriptions/autosave nor the onCloseRequested handler below, so
    // closing a child just closes that window — quitApp() (kill_all + exit)
    // is unreachable from here, and the PTY sessions of the other windows
    // survive. Phase 3b replaces the plain close with merge-back to main.
    if (!isMainWindow()) return;

    let dirty = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let syncInFlight: Promise<boolean> | null = null;
    let closing = false;
    let closePromptOpen = false;
    let saveFailureStreak = 0;
    let saveRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let cachedAgentMappings: Record<string, AgentSessionMapping> = {};
    let cachedMappingSessionIds = "";
    let agentMappingsDirty = true;
    let lastWrittenSnapshot: string | null = null;

    const buildSnapshot = (
      agentMappings: Record<string, AgentSessionMapping> = {},
      windowFragments: WindowFragment[] = [],
    ) => {
      const state = useWorkspaceListStore.getState();
      const uiState = useUiStore.getState();
      const activeWorkspaceId = state.activeWorkspaceId ?? null;
      const activeWorkspace = activeWorkspaceId
        ? state.workspaces.find((ws) => ws.id === activeWorkspaceId)
        : null;
      const activeSessionId = uiState.activePaneId ?? lastActivePaneSessionId.current;
      const activePane = activeWorkspace?.panes.find((pane) =>
        paneContainsSession(pane, activeSessionId),
      ) ?? activeWorkspace?.panes[0] ?? null;
      const activeTab = activePane?.tabs.find((tab) => tab.sessionId === activeSessionId)
        ?? activePane?.tabs.find((tab) => tab.id === activePane.activeTabId)
        ?? activePane?.tabs[0]
        ?? null;
      const fallbackSessionId = lastActivePaneSessionId.current;
      const fallbackWorkspace = fallbackSessionId
        ? state.workspaces.find((workspace) => workspaceContainsSession(workspace, fallbackSessionId))
        : null;
      const fallbackPane = fallbackWorkspace?.panes.find((pane) =>
        paneContainsSession(pane, fallbackSessionId),
      ) ?? null;
      const fallbackTab = fallbackPane?.tabs.find((tab) => tab.sessionId === fallbackSessionId)
        ?? fallbackPane?.tabs.find((tab) => tab.id === fallbackPane.activeTabId)
        ?? fallbackPane?.tabs[0]
        ?? null;
      const themeState = useThemeStore.getState();
      const keybindingState = useKeybindingStore.getState();
      const petSettings = usePetSettingsStore.getState();
      const aiSettings = useAiSettingsStore.getState();

      // Mappings written by launcher.sh during this session (pane-sessions/*.txt)
      // are applied at save time too — App.tsx only refreshes them at startup /
      // restore-complete / a one-shot 15s fallback, so agents launched later
      // would otherwise miss the persisted snapshot. applyMappingToTabConfig
      // never overwrites live values; it only fills gaps.
      // Multi-window (Phase 3b): main is still the sole data.json writer, but
      // after a tear-out it no longer holds every workspace. Appending the
      // other windows' published fragments keeps data.json (and the phone
      // remote, which reads it for workspace names) complete.
      const rawConfigs = mergeWindowFragmentWorkspaces(
        state.workspaces
          .map((workspace) => toConfig(workspace))
          .filter((config) => config.panes.length > 0),
        windowFragments,
      );
      const safeMappings = filterConflictingAgentMappings(rawConfigs, agentMappings);
      const mappedConfigs = rawConfigs.map((config) => applyMappingsToConfig(config, safeMappings));
      const persistedSelection = resolvePersistedSelection(
        mappedConfigs,
        {
          workspaceId: activeWorkspaceId,
          paneId: activePane?.id,
          tabId: activeTab?.id,
        },
        {
          workspaceId: fallbackWorkspace?.id,
          paneId: fallbackPane?.id,
          tabId: fallbackTab?.id,
        },
      );
      const dedupeResult = dedupeAgentSessionsInConfigs(
        mappedConfigs,
        persistedSelection.workspaceId,
        persistedSelection.paneId,
        persistedSelection.tabId,
      );
      const workspaces = dedupeResult.configs;
      reportAgentSessionDedupeConflicts(dedupeResult.conflicts);
      discardDedupeLoserScrollbacks(dedupeResult.discardScrollbackSessionIds);
      const finalSelection = resolvePersistedSelection(workspaces, persistedSelection);

      return {
        schema_version: 1,
        workspaces,
        settings: {
          theme_id: themeState.themeId,
          font_size: themeState.fontSize,
          line_height: themeState.lineHeight,
          font_family: themeState.fontFamily,
          theme_tweaks: themeState.themeTweaks,
          keybindings: keybindingState.overrides,
          ui_density: themeState.uiDensity,
          ui_font_scale: themeState.uiFontScale,
          pet_display_mode: petSettings.petDisplayMode,
          pet_new_ws_mode: petSettings.petNewWorkspaceMode,
          pet_disabled: petSettings.petDisabled,
          pet_fixed_id: petSettings.petFixedId ?? null,
          ai_provider: aiSettings.aiProvider,
          ai_model: aiSettings.aiModel,
          ai_enabled: aiSettings.aiEnabled,
        },
        active_workspace_id: finalSelection.workspaceId,
        active_pane_id: finalSelection.paneId,
        active_tab_id: finalSelection.tabId,
      };
    };

    const sync = async (force = false): Promise<boolean> => {
      if (!isLeader.current) return true;
      if (syncInFlight) {
        await syncInFlight.catch(() => {});
      }
      if (!dirty && !force) return true;
      const startupHoldRemainingMs = startupAutosaveHoldUntil.current - Date.now();
      if (!force && startupHoldRemainingMs > 0) {
        dirty = true;
        scheduleSync(startupHoldRemainingMs + 100);
        return true;
      }
      const mappingSessionIds = [...collectLiveTerminalSessionIds()].sort();
      const mappingSessionKey = mappingSessionIds.join("\0");
      if (agentMappingsDirty || cachedMappingSessionIds !== mappingSessionKey) {
        try {
          cachedAgentMappings = await readAgentSessionMappings(mappingSessionIds);
          cachedMappingSessionIds = mappingSessionKey;
          agentMappingsDirty = false;
        } catch (err) {
          agentMappingsDirty = true;
          console.warn("[persist] Failed to read agent session mappings:", err);
        }
      }
      const agentMappings = cachedAgentMappings;
      let windowFragments: WindowFragment[] = [];
      try {
        windowFragments = await getWindowFragments();
      } catch (err) {
        console.warn("[persist] Failed to read other windows' workspaces:", err);
      }
      const snapshot = buildSnapshot(agentMappings, windowFragments);
      const serializedSnapshot = JSON.stringify(snapshot);
      if (serializedSnapshot === lastWrittenSnapshot) {
        dirty = false;
        return true;
      }
      dirty = false;
      const run = savePersistentData(snapshot)
        .then(() => {
          lastWrittenSnapshot = serializedSnapshot;
          // Streak broken: drop the pending retry and reset the ladder.
          clearSaveRetry();
          saveFailureStreak = 0;
          return true;
        })
        .catch((err) => {
          dirty = true; // allow next trigger to retry
          console.warn("[persist] Failed to save:", err);
          const now = Date.now();
          const firstOfStreak = saveFailureStreak === 0;
          if (firstOfStreak && now - lastSaveFailureToastAt >= SAVE_FAILURE_TOAST_DEBOUNCE_MS) {
            lastSaveFailureToastAt = now;
            useToastStore.getState().pushToast("Workspace save failed — check before restarting", "error");
          }
          scheduleSaveRetry();
          saveFailureStreak += 1;
          return false;
        });
      syncInFlight = run;
      try {
        return await run;
      } finally {
        if (syncInFlight === run) {
          syncInFlight = null;
        }
      }
    };

    function scheduleSync(delayMs = 500): void {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void sync();
      }, delayMs);
    }

    function clearSaveRetry(): void {
      if (saveRetryTimer) {
        clearTimeout(saveRetryTimer);
        saveRetryTimer = null;
      }
    }

    // A failed save leaves `dirty = true` but nothing scheduled, so an idle
    // workspace would never write again. Keep at most one retry pending and let
    // `sync()` re-check leadership / in-flight coalescing when it fires.
    function scheduleSaveRetry(): void {
      if (saveRetryTimer || closing) return;
      saveRetryTimer = setTimeout(() => {
        saveRetryTimer = null;
        void sync();
      }, saveRetryDelayMs(saveFailureStreak));
    }

    const debouncedSync = () => {
      scheduleSync(500);
    };

    const markDirty = () => {
      dirty = true;
      debouncedSync();
    };

    const countLiveAgentSessions = () => {
      const { workspaces } = useWorkspaceListStore.getState();
      const { metadata } = usePaneMetadataStore.getState();
      const sessionIds = new Set<string>();

      for (const workspace of workspaces) {
        for (const pane of workspace.panes) {
          if (pane.tabs.length === 0) {
            sessionIds.add(pane.sessionId);
            continue;
          }
          for (const tab of pane.tabs) {
            sessionIds.add(tab.sessionId);
          }
        }
      }

      let agentCount = 0;
      for (const sessionId of sessionIds) {
        const pane = metadata[sessionId];
        if (pane?.processIsShell === false && pane.agentKind) {
          agentCount += 1;
        }
      }
      return agentCount;
    };

    const promptAfterFinalSaveFailure = async (): Promise<"retry" | "quit-anyway"> => {
      const retry = await confirm(
        "The final workspace save failed. Retry saving before quitting?",
        {
          title: "mycmux workspace save failed",
          kind: "warning",
          okLabel: "Retry",
          cancelLabel: "Quit anyway",
        },
      );
      return retry ? "retry" : "quit-anyway";
    };

    const unsubList = useWorkspaceListStore.subscribe(markDirty);
    const unsubLayout = useWorkspaceLayoutStore.subscribe(markDirty);
    const unsubMeta = usePaneMetadataStore.subscribe((state, previousState) => {
      // lastLog is a high-frequency UI-only slice. It is intentionally absent
      // from buildSnapshot, so terminal streaming must not keep resetting the
      // workspace autosave debounce timer.
      if (state.metadata !== previousState.metadata) {
        markDirty();
        agentMappingsDirty = true;
      }
    });
    const unsubTheme = useThemeStore.subscribe(markDirty);
    const unsubKeys = useKeybindingStore.subscribe(markDirty);
    const unsubPets = usePetSettingsStore.subscribe((state, previousState) => {
      if (
        state.petDisplayMode !== previousState.petDisplayMode
        || state.petNewWorkspaceMode !== previousState.petNewWorkspaceMode
        || state.petDisabled !== previousState.petDisabled
        || state.petFixedId !== previousState.petFixedId
      ) markDirty();
    });
    const unsubAi = useAiSettingsStore.subscribe((state, previousState) => {
      if (
        state.aiProvider !== previousState.aiProvider
        || state.aiModel !== previousState.aiModel
        || state.aiEnabled !== previousState.aiEnabled
      ) markDirty();
    });
    const unsubUi = useUiStore.subscribe((state, prevState) => {
      if (state.activePaneId) {
        const activeTerminalExists = useWorkspaceListStore.getState().workspaces.some((workspace) =>
          workspace.panes.some((pane) => pane.tabs.some((tab) =>
            tab.sessionId === state.activePaneId && tab.type === "terminal",
          )),
        );
        if (activeTerminalExists) {
          lastActivePaneSessionId.current = state.activePaneId;
        }
      }
      if (state.activePaneId !== prevState.activePaneId) markDirty();
    });

    const handleBeforeUnload = () => {
      if (dirty) {
        // Flush synchronously on unload — debounce timer won't fire in time.
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        clearSaveRetry();
        void sync(true);
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    const unlistenCloseRequested = getCurrentWindow().onCloseRequested(async (event) => {
      if (closing || closePromptOpen) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      try {
        await flushPtyMetadataSnapshotForPersistence();
      } catch (err) {
        console.warn("[persist] Failed to refresh pty metadata before close prompt:", err);
      }
      const agentCount = countLiveAgentSessions();

      if (agentCount > 0) {
        closePromptOpen = true;
        let shouldQuit = false;
        try {
          shouldQuit = await confirm(
            `実行中のエージェントが ${agentCount} 件あります。終了しますか？`,
            agentCloseDialogOptions("mycmux を終了"),
          );
        } catch (err) {
          console.warn("[persist] Failed to show quit confirmation:", err);
          return;
        } finally {
          closePromptOpen = false;
        }
        if (!shouldQuit) return;
      }

      closing = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      clearSaveRetry();
      let shouldQuitAfterSave = false;
      try {
        while (true) {
          try {
            await flushPtyMetadataSnapshotForPersistence();
          } catch (err) {
            console.warn("[persist] Failed to flush pty metadata snapshot:", err);
          }
          const saved = await sync(true);
          if (saved) {
            shouldQuitAfterSave = true;
            break;
          }

          closePromptOpen = true;
          let choice: "retry" | "quit-anyway";
          try {
            choice = await promptAfterFinalSaveFailure();
          } catch (err) {
            console.warn("[persist] Failed to show final save failure prompt:", err);
            return;
          } finally {
            closePromptOpen = false;
          }
          if (choice === "quit-anyway") {
            shouldQuitAfterSave = true;
            break;
          }
        }
      } finally {
        if (shouldQuitAfterSave) {
          await quitApp();
        } else {
          closing = false;
        }
      }
    });

    return () => {
      unsubList();
      unsubLayout();
      unsubMeta();
      unsubTheme();
      unsubKeys();
      unsubPets();
      unsubAi();
      unsubUi();
      if (debounceTimer) clearTimeout(debounceTimer);
      clearSaveRetry();
      window.removeEventListener("beforeunload", handleBeforeUnload);
      unlistenCloseRequested.then((f) => f()).catch(() => {});
    };
  }, []);

  // Multi-window (Phase 3b): a child window publishes its workspaces to the
  // Rust registry instead of writing data.json — main merges every fragment
  // into its own snapshot. Mirrors the leader's markDirty/debounce above.
  useEffect(() => {
    if (isMainWindow()) return;

    let publishTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let closing = false;

    const clearPublishTimer = () => {
      if (publishTimer) {
        clearTimeout(publishTimer);
        publishTimer = null;
      }
    };

    const publishNow = async (): Promise<void> => {
      clearPublishTimer();
      try {
        await publishWindowFragment(buildWindowFragment());
      } catch (err) {
        console.warn("[persist] Failed to publish window fragment:", err);
      }
    };

    const markDirty = () => {
      if (disposed || closing) return;
      clearPublishTimer();
      publishTimer = setTimeout(() => {
        publishTimer = null;
        void publishNow();
      }, WINDOW_FRAGMENT_PUBLISH_DEBOUNCE_MS);
    };

    // Publish once as soon as adoption is done, without waiting for the first
    // debounce tick: a window closed immediately after a tear-out must still
    // have something the registry can hand back to main.
    void persistLoaded.then(() => {
      if (!disposed) void publishNow();
    });

    const unsubList = useWorkspaceListStore.subscribe(markDirty);
    const unsubLayout = useWorkspaceLayoutStore.subscribe(markDirty);
    const unsubMeta = usePaneMetadataStore.subscribe((state, previousState) => {
      if (state.metadata !== previousState.metadata) markDirty();
    });
    const unsubUi = useUiStore.subscribe((state, previousState) => {
      if (state.activePaneId !== previousState.activePaneId) markDirty();
    });

    // Merge-back. Closing a child window must not take its workspaces (or
    // their live agents) with it, so it hands them to main before it goes.
    // Nothing here kills a session: kill_all stays bound to the *main*
    // window's Destroyed event (lib.rs), and the Rust registry re-adopts on
    // behalf of a child that dies without getting this far.
    const unlistenCloseRequested = getCurrentWindow().onCloseRequested(async (event) => {
      if (closing) return;
      event.preventDefault();
      closing = true;
      clearPublishTimer();
      try {
        // Publish first — release can only move what the registry knows about.
        await publishWindowFragment(buildWindowFragment());
        const workspaceIds = useWorkspaceListStore
          .getState()
          .workspaces.map((workspace) => workspace.id);
        if (workspaceIds.length > 0) {
          await releaseWorkspaces(windowLabel(), workspaceIds, MAIN_WINDOW_LABEL);
        }
      } catch (err) {
        console.warn("[persist] Failed to hand workspaces back to the main window:", err);
      }
      await getCurrentWindow().destroy();
    });

    return () => {
      disposed = true;
      clearPublishTimer();
      unsubList();
      unsubLayout();
      unsubMeta();
      unsubUi();
      unlistenCloseRequested.then((f) => f()).catch(() => {});
    };
  }, []);

  // Multi-window (Phase 3b): every window drains its own adoption queue —
  // a child on boot (tear-out), main on `window-adopt` (a child closed or
  // died holding workspaces) and once at startup for an event that fired
  // before this listener existed.
  useEffect(() => {
    let disposed = false;

    const drain = async () => {
      // Never race the startup restore: adopting into a half-restored store
      // would fight the `workspaces.length <= 1` bootstrap reconciliation.
      await persistLoaded;
      if (disposed) return;
      try {
        const adopted = await takePendingAdoption(windowLabel());
        if (!disposed && adopted.length > 0) {
          adoptWorkspaceConfigs(adopted);
        }
      } catch (err) {
        console.warn("[persist] Failed to adopt workspaces from another window:", err);
      }
    };

    void drain();
    const unlisten = listen<WindowAdoptPayload>(WINDOW_ADOPT_EVENT, (event) => {
      if (event.payload.to_label !== windowLabel()) return;
      void drain();
    });

    return () => {
      disposed = true;
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    // Multi-window (Phase 3a): Rust broadcasts socket-request to every window
    // (`app.emit("socket-request", &req)` in socket.rs — deliberately NOT
    // emit_to, see test_socket_api_contract.py). Exactly one window may run
    // the command or every socket call would execute N times and N responses
    // would race for the same request id. Main handles them; children return
    // before subscribing.
    if (!isMainWindow()) return;

    const unlisten = listen<SocketRequestPayload>("socket-request", async (event) => {
      const { id, cmd, args } = event.payload;
      try {
        const result = await handleSocketCommand(cmd, args);
        await sendSocketResponse(id, result, null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await sendSocketResponse(id, null, message);
      }
    });

    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  // Surface recovery from a broken agent-restore request (session jsonl missing),
  // whether via a suppressed fallback id or `--continue` / `resume --last`.
  useEffect(() => {
    // Multi-window (Phase 3a): another broadcast emit. Child windows own no
    // sessions yet, so the store rewrite below would be a no-op there while the
    // toast fired once per open window. Phase 3b routes this by owning window.
    if (!isMainWindow()) return;

    const unlisten = listen<{
      session_id: string;
      kind: string;
      reason: string;
      fallback_session_id?: string;
    }>(
      "agent-restore-downgraded",
      (event) => {
        console.warn("[mycmux] agent restore recovered:", event.payload);
        const fallbackId = event.payload.fallback_session_id;
        let staleIdCleared = false;
        if (!fallbackId) {
          // Full downgrade (no fallback id to resume instead): the saved
          // session id was invalid, so clear it now — otherwise every future
          // launch of this pane (including reattach-triggered remounts)
          // would keep pointing at the same dead id and re-emit this warning.
          staleIdCleared = useWorkspaceLayoutStore
            .getState()
            .clearTabAgentSessionBySessionId(event.payload.session_id);
        } else {
          // A fallback conversation WAS resumed: repoint the persisted
          // markers at it, or the tab keeps referencing the dead original id
          // and every future launch downgrades (and warns) all over again.
          useWorkspaceLayoutStore
            .getState()
            .repointTabAgentSessionBySessionId(
              event.payload.session_id,
              event.payload.kind,
              fallbackId,
            );
        }
        useToastStore
          .getState()
          .pushToast(
            fallbackId
              ? `セッション復元: 保存されていたIDが無効だったため、退避されていた会話 (${fallbackId.slice(0, 8)}) で再開しました`
              : `セッション復元: 前回の ${event.payload.kind} セッションが見つからなかったため、直近の会話で再開しました${staleIdCleared ? " (無効になった保存IDはリセット済み)" : ""}`,
            "warning",
          );
      },
    );
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);
}

export default function SocketListener() {
  return null;
}

import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  beginSessionAttach,
  getCurrentSessionEpoch,
  type FrontendDataBatch,
} from "./attachEpoch";
import {
  decodeFrontendDataBatch,
  decodeScrollbackSnapshot,
} from "./terminalWire";
import type { AgentSessionKind, ArtifactSourceKind, ThemeTweaks, TurnMarkPersistSnapshot } from "../types";
import type { OnlineSavepointEntry } from "../components/online/onlineSavepoints";
import { markSessionFrontendActivity } from "./agentDormancy";
import { windowLabel } from "./windowContext";

export { getCurrentSessionEpoch, type FrontendDataBatch };

interface SessionIdArgs { sessionId: string }
interface WorkspaceIdArgs { workspaceId: string }
interface PathArgs { path: string }
interface SourcePathArgs { sourcePath: string }
interface BundleDirArgs { bundleDir: string }
interface DuplicateAgentSessionArgs {
  kind: AgentSessionKind;
  sessionId: string;
  cwd?: string;
}
interface EnabledArgs { enabled: boolean }
interface CreateSessionArgs {
  sessionId: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  onData: Channel<ArrayBuffer>;
  cwd: string | null;
  env: Record<string, string> | null;
  restoreFallbackSessionIds: string[];
}
interface AckFrontendDataArgs extends SessionIdArgs { generation: number; seq: number; bytes: number }
interface SetFrontendVisibleArgs extends SessionIdArgs { visible: boolean }
interface SetAppFrontendVisibleArgs { visible: boolean }
interface WriteToSessionArgs extends SessionIdArgs { data: string }
interface ResizeSessionArgs extends SessionIdArgs { cols: number; rows: number }
interface ArtifactUriArgs extends SessionIdArgs { uri: string }
interface SaveEditableArtifactArgs extends SourcePathArgs { sourceKind: ArtifactSourceKind; content: string }
interface ExportSavepointTransferArgs extends BundleDirArgs { destinationPath: string }
interface PublishSavepointArgs {
  cwd: string;
  agentKind: "claude" | "codex";
  agentSessionId: string;
  claudeSessionId: string | null;
  summary: string | null;
  nextStep: string | null;
  /** Scope the progress stream to the window that started the publish. */
  windowLabel: string | null;
}
interface FinalizeSavepointArgs extends PublishSavepointArgs { closedReason: SavepointCloseReason }
interface CrsmListSessionsArgs { query: string | null; limit: number; refresh: boolean }
interface CrsmCreateHandoffArgs {
  sessionId: string;
  fromKind: CrsmSessionEntry["kind"];
  targetKind: CrsmSessionEntry["kind"];
  recentTurns: number;
}
interface SessionIdsArgs { sessionIds: string[] }
interface SavePersistentDataArgs { data: PersistentData }
interface SocketResponseArgs { id: number; result: any; error: string | null }
interface CandidatesArgs { candidates: string[] }
interface UriArgs { uri: string }
interface CaptureCliAccountArgs { provider: CliProvider; label?: string }
interface SwitchCliAccountArgs { provider: CliProvider; profileId: string }
interface ProfileIdArgs { profileId: string }
interface RenameCliAccountArgs extends ProfileIdArgs { label: string }
interface ResolveCliAccountOrphanArgs {
  orphanId: string;
  action: CliOrphanAction;
  label?: string;
}
interface BeginCliLoginArgs {
  provider: CliProvider;
  mode: CliLoginMode;
  expectedProfileId?: string;
}
interface LoginIdArgs { loginId: string }

const sessionCreateTails = new Map<string, Promise<void>>();

export interface DispatchEntry {
  slug: string;
  label?: string | null;
  dir?: string | null;
  cwd?: string | null;
  tabSessionId?: string | null;
  tabId?: string | null;
  target?: string | null;
  status?: string | null;
  verify?: string | null;
  workstream?: string | null;
  stage?: string | null;
  ts?: string | null;
  hasDone: boolean;
  hasAsk: boolean;
  hasVerdict: boolean;
  doneMtimeMs?: number | null;
  askMtimeMs?: number | null;
  verdictMtimeMs?: number | null;
  dirMtimeMs?: number | null;
  sessionLogName?: string | null;
  sessionLogAgeMinutes: number;
  liveState: "CLOSED" | "DONE" | "DONE_NEEDS_REVIEW" | "ASK" | "NO_LOG" | "RUNNING" | "RATE_LIMITED" | "STALL";
}

export async function dispatchScan(includeClosed?: boolean): Promise<DispatchEntry[]> {
  return invoke<DispatchEntry[]>("dispatch_scan", { includeClosed: includeClosed ?? null });
}

export async function dispatchClaimWatchdog(ttlMs: number): Promise<boolean> {
  return invoke<boolean>("dispatch_claim_watchdog", { ttlMs });
}

export interface WorkOrderSpawnResult {
  sessionId?: string;
  error?: string;
}

export type WorkOrderSessionRole = "source" | "worker" | "integrator" | "reviewer";
export type WorkOrderState = "draft" | "awaiting_go" | "running" | "needs_decision" | "integrating" | "verifying" | "done" | "failed" | "cancelled";
export type WorkOrderItemState = "pending" | "ready" | "dispatched" | "running" | "reported" | "verified" | "failed" | "cancelled";

export interface WorkOrderCriterion {
  id: string;
  description: string;
}

export interface WorkOrderSessionBinding {
  logicalSessionId: string;
  roles: WorkOrderSessionRole[];
  labelSnapshot: string | null;
  snapshotEventId: string | null;
}

export interface WorkOrderArtifactSpec {
  path: string;
  description: string;
}

export interface WorkOrderPathScope {
  pathPrefix: string;
  worktree: string | null;
  branch: string | null;
}

export interface WorkOrderGate {
  id: string;
  description: string;
}

export interface WorkOrderItem {
  id: string;
  objective: string;
  assignee: string | null;
  dependencies: string[];
  expectedArtifacts: WorkOrderArtifactSpec[];
  writeScope: WorkOrderPathScope[];
  gates: WorkOrderGate[];
  required: boolean;
  state: WorkOrderItemState;
}

export interface WorkOrderBudget {
  maxNewPty: number;
  maxWorkItems: number;
  maxReplans: number;
  maxPackets: number;
  maxRoundtripsPerEdge: number;
}

export interface WorkOrderPlanDraft {
  goal: string;
  acceptanceCriteria: WorkOrderCriterion[];
  bindings: WorkOrderSessionBinding[];
  workItems: WorkOrderItem[];
  budgets: WorkOrderBudget;
}

export interface WorkOrderPlanSnapshot extends WorkOrderPlanDraft {
  id: string;
  planVersion: number;
  sealedAt: number | null;
}

export interface WorkOrderSourceDigest {
  logicalSessionId: string;
  label: string | null;
  snapshotEventId: string | null;
  currentTask: string | null;
  latestInstruction: string | null;
  activity: string | null;
  openQuestions: string[];
  acquired: boolean;
  failureReason: string | null;
}

export interface WorkOrderCoverage {
  target: number;
  acquired: number;
  missing: number;
  failed: number;
}

export interface WorkOrderOutboxStatus {
  workItemId: string;
  intentKind: "spawn" | "send";
  status: "pending" | "in_flight" | "delivered" | "failed";
  reason: string | null;
}

export type WorkOrderWriteTarget = { branch: string; path: string } | { unavailable: string } | null;

export interface WorkOrderPreview {
  plan: WorkOrderPlanSnapshot;
  coverage: WorkOrderCoverage;
  outbox: WorkOrderOutboxStatus[];
  sources: WorkOrderSourceDigest[];
  integratorPrompt: string;
  writeTarget: WorkOrderWriteTarget;
}

export interface WorkOrderGoOptions {
  cwd: string;
  overrideMissingSources?: boolean;
  agentKind?: AgentSessionKind;
}

export interface WorkOrderIdResponse {
  workOrderId: string;
}

export interface WorkOrderSourcesResponse {
  coverage: WorkOrderCoverage;
  sources: WorkOrderSourceDigest[];
}

export interface WorkOrderGoResponse {
  sealed: "sealed" | "alreadySealed";
  spawnRequestId: string | null;
  coverage: WorkOrderCoverage;
}

export interface WorkOrderCancelResponse {
  deletedDraft: boolean;
  stopTargets: string[];
}

export interface WorkOrderRetrySpawnResponse {
  spawnRequestId: string;
}

export async function workorderSpawnResult(
  requestId: string,
  result: WorkOrderSpawnResult,
): Promise<void> {
  return invoke<void>("workorder_spawn_result", { requestId, result });
}

export async function workorderCreateDraft(plan: WorkOrderPlanDraft): Promise<WorkOrderIdResponse> {
  return invoke<WorkOrderIdResponse>("workorder_create_draft", { plan });
}

export async function workorderRefreshSources(id: string): Promise<WorkOrderSourcesResponse> {
  return invoke<WorkOrderSourcesResponse>("workorder_refresh_sources", { id });
}

export async function workorderPreview(id: string, cwd: string): Promise<WorkOrderPreview> {
  return invoke<WorkOrderPreview>("workorder_preview", { id, cwd });
}

export async function workorderGo(
  id: string,
  options: WorkOrderGoOptions,
): Promise<WorkOrderGoResponse> {
  return invoke<WorkOrderGoResponse>("workorder_go", { id, options });
}

export async function workorderCancel(id: string): Promise<WorkOrderCancelResponse> {
  return invoke<WorkOrderCancelResponse>("workorder_cancel", { id });
}

export async function workorderActivateVersion(id: string, planVersion: number): Promise<void> {
  return invoke<void>("workorder_activate_version", { id, planVersion });
}

export async function workorderRetrySpawn(workOrderId: string): Promise<WorkOrderRetrySpawnResponse> {
  return invoke<WorkOrderRetrySpawnResponse>("workorder_retry_spawn", { workOrderId });
}

export async function createSession(
  sessionId: string,
  command: string,
  args: string[],
  cols: number,
  rows: number,
  onData: (batch: FrontendDataBatch) => void,
  cwd?: string,
  env?: Record<string, string>,
  restoreFallbackSessionIds?: string[],
): Promise<void> {
  const previous = sessionCreateTails.get(sessionId) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    let staleNoticeCount = 0;
    const attach = beginSessionAttach(sessionId, {
      deliver: onData,
      ackStale: (batch, current) => {
        ackFrontendData(sessionId, batch.generation, batch.seq, batch.bytes).catch((err) => {
          if (import.meta.env.DEV) {
            console.warn("[mycmux-diag ipc] failed to ack stale PTY batch:", err);
          }
        });
        // Throttle stale notices: log every 25 stale messages to avoid console flood.
        // Debug builds only (Vite drops this in production).
        if (import.meta.env.DEV && staleNoticeCount % 25 === 0) {
          console.log(
            `[mycmux-diag ipc] stale_message session=${sessionId} attached_epoch=${attach.epoch} current=${current ?? "none"} stale_count=${staleNoticeCount + 1} bytes_this_msg=${batch.bytes}`,
          );
        }
        staleNoticeCount += 1;
      },
    });
    const channel = new Channel<ArrayBuffer>();

    channel.onmessage = (frame) => {
      try {
        attach.ingest(decodeFrontendDataBatch(frame));
      } catch (error) {
        console.error("[mycmux] Invalid PTY data frame:", error);
      }
    };
    if (import.meta.env.DEV) {
      console.log(
        `[mycmux-diag ipc] create_session session=${sessionId} epoch=${attach.epoch} prev_messages=${attach.messageCount}`,
      );
    }
    try {
      await invoke<void>("create_session", {
        sessionId,
        command,
        args,
        cols,
        rows,
        onData: channel,
        cwd: cwd ?? null,
        env: env ?? null,
        restoreFallbackSessionIds: restoreFallbackSessionIds ?? [],
      } satisfies CreateSessionArgs);
      attach.commit();
    } catch (err) {
      attach.fail();
      throw err;
    }
  });
  sessionCreateTails.set(sessionId, operation);
  try {
    await operation;
  } finally {
    if (sessionCreateTails.get(sessionId) === operation) {
      sessionCreateTails.delete(sessionId);
    }
  }
}

export async function ackFrontendData(
  sessionId: string,
  generation: number,
  seq: number,
  bytes: number,
): Promise<void> {
  return invoke<void>("ack_frontend_data", { sessionId, generation, seq, bytes } satisfies AckFrontendDataArgs);
}

export async function setFrontendVisible(sessionId: string, visible: boolean): Promise<void> {
  return invoke<void>("set_frontend_visible", { sessionId, visible } satisfies SetFrontendVisibleArgs);
}

export async function setAppFrontendVisible(visible: boolean): Promise<void> {
  return invoke<void>("set_app_frontend_visible", { visible } satisfies SetAppFrontendVisibleArgs);
}

export interface ScrollbackSnapshot {
  data: Uint8Array;
  startOffset: number;
  endOffset: number;
}

export async function getSessionScrollback(sessionId: string): Promise<ScrollbackSnapshot> {
  const frame = await invoke<ArrayBuffer>("get_session_scrollback", { sessionId } satisfies SessionIdArgs);
  return decodeScrollbackSnapshot(frame);
}

export async function hasPersistedScrollback(sessionId: string): Promise<boolean> {
  return invoke<boolean>("has_persisted_scrollback", { sessionId } satisfies SessionIdArgs);
}

export async function writeToSession(
  sessionId: string,
  data: string,
): Promise<void> {
  markSessionFrontendActivity(sessionId);
  return invoke<void>("write_to_session", { sessionId, data } satisfies WriteToSessionArgs);
}

export async function isSessionAlive(sessionId: string): Promise<boolean> {
  return invoke<boolean>("is_session_alive", { sessionId } satisfies SessionIdArgs);
}

export async function resizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("resize_session", { sessionId, cols, rows } satisfies ResizeSessionArgs);
}

export async function killSession(sessionId: string): Promise<void> {
  return invoke<void>("kill_session", { sessionId } satisfies SessionIdArgs);
}

export async function removeWorkspaceScrollback(workspaceId: string): Promise<void> {
  return invoke<void>("remove_workspace_scrollback", { workspaceId } satisfies WorkspaceIdArgs);
}

export async function discardSessionScrollback(sessionId: string): Promise<void> {
  return invoke<void>("discard_session_scrollback", { sessionId } satisfies SessionIdArgs);
}

export interface PreviewArtifactInfo {
  previewPath: string;
  sourcePath: string;
  sourceKind: ArtifactSourceKind;
}

export interface EditableArtifactSource {
  sourcePath: string;
  sourceKind: ArtifactSourceKind;
  content: string;
  rawContent?: string;
}

export interface SaveEditableArtifactResult {
  sourcePath: string;
  backupPath: string;
  previewPath: string;
}

export async function previewArtifactUriForSessionV2(
  sessionId: string,
  uri: string,
): Promise<PreviewArtifactInfo> {
  return invoke<PreviewArtifactInfo>("preview_artifact_uri_for_session_v2", { sessionId, uri } satisfies ArtifactUriArgs);
}

export async function readEditableArtifact(sourcePath: string): Promise<EditableArtifactSource> {
  return invoke<EditableArtifactSource>("read_editable_artifact", { sourcePath } satisfies SourcePathArgs);
}

export async function saveEditableArtifact(
  sourcePath: string,
  sourceKind: ArtifactSourceKind,
  content: string,
): Promise<SaveEditableArtifactResult> {
  return invoke<SaveEditableArtifactResult>("save_editable_artifact", { sourcePath, sourceKind, content } satisfies SaveEditableArtifactArgs);
}

export function onPtyExit(
  sessionId: string,
  callback: () => void,
): Promise<UnlistenFn> {
  return listen(`pty-exit-${sessionId}`, () => {
    callback();
  });
}

export interface PtyMetadata {
  session_id: string;
  cwd: string;
  git_branch?: string;
  process_name?: string;
  process_status?: "working" | "idle";
  process_status_at?: number;
  last_output_at?: number;
  agent_active: boolean;
  claude_session_id?: string;
  agent_kind?: AgentSessionKind;
  agent_session_id?: string;
}

export type PtyMetadataSnapshot = Record<string, PtyMetadata>;
export type SessionOutputSnapshot = Record<string, number | null>;

export type SessionAttentionKind = "none" | "input" | "approval" | "rate_limited" | "error" | "done";
export type SessionUiState = "working" | "idle" | "waiting" | "done" | "unknown";
export type SessionLifecycle = "alive" | "exited" | "orphaned" | "unknown";

export interface SessionAttentionPayload {
  attention_id: string | null;
  kind: SessionAttentionKind;
  detail: string | null;
  state_since: number;
}

export interface SessionStatusPayload {
  session_epoch: number | null;
  lifecycle: SessionLifecycle;
  attention: SessionAttentionPayload;
  ui_state: SessionUiState;
}

export interface FeedSessionPayload {
  session_id: string;
  session_revision: number;
  status: SessionStatusPayload;
}

export interface SessionStatusSnapshotPayload {
  server_epoch: string;
  seq: number;
  sessions: FeedSessionPayload[];
}

export interface SessionStatusChangedPayload extends FeedSessionPayload {
  v: number;
  kind: "event";
  event: "status.changed";
  server_epoch: string;
  seq: number;
}

export async function getPtyMetadataSnapshot(): Promise<PtyMetadataSnapshot> {
  return invoke<PtyMetadataSnapshot>("get_pty_metadata_snapshot");
}

export async function getSessionOutputSnapshot(): Promise<SessionOutputSnapshot> {
  return invoke<SessionOutputSnapshot>("get_session_output_snapshot");
}

export async function getSessionStatusSnapshot(): Promise<SessionStatusSnapshotPayload> {
  return invoke<SessionStatusSnapshotPayload>("get_session_status_snapshot");
}

export function onSessionStatusChanged(
  callback: (payload: SessionStatusChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SessionStatusChangedPayload>("mycmux://session-status-changed", (event) => {
    callback(event.payload);
  });
}

export function onPtyMetadata(
  callback: (meta: PtyMetadata) => void,
): Promise<UnlistenFn> {
  return listen<PtyMetadata>("pty_metadata", (event) => {
    callback(event.payload);
  });
}

export interface PtyWorkDone {
  session_id: string;
  prev_process: string;
  current_process: string;
}

export function onPtyWorkDone(
  callback: (evt: PtyWorkDone) => void,
): Promise<UnlistenFn> {
  return listen<PtyWorkDone>("pty_work_done", (event) => {
    callback(event.payload);
  });
}

// ─── Terminal config ─────────────────────────────────────────────────────────

export interface TerminalConfig {
  font_family: string;
  font_size: number;
  shell: string;
  background: string;
  foreground: string;
  ansi: string[];
  windows_build_number: number | null;
}

export async function getTerminalConfig(): Promise<TerminalConfig> {
  return invoke<TerminalConfig>("get_terminal_config");
}

// Preload config so it's cached before first terminal mounts
let _configCache: Promise<TerminalConfig> | null = null;
export function preloadTerminalConfig(): void {
  if (!_configCache) {
    _configCache = getTerminalConfig().catch(() => null as never);
  }
}

// ─── Path utilities ─────────────────────────────────────────────────────────

export async function isDirectory(path: string): Promise<boolean> {
  return invoke<boolean>("is_directory", { path } satisfies PathArgs);
}

export async function getLaunchCwd(): Promise<string | null> {
  return invoke<string | null>("get_launch_cwd");
}

export interface JoinSavepointSummaryResult {
  resolved_cwd: string;
  handoff_path: string;
  cwd_missing: boolean;
  source_checkpoint_id?: string | null;
}

export interface JoinSavepointFullResult {
  resolved_cwd: string;
  cwd_missing: boolean;
  resume_session_id: string | null;
  command_argv: string[];
  agent_kind: "claude" | "codex";
  source_checkpoint_id?: string | null;
}

export interface ToggleSavepointPinResult {
  pinned: boolean;
}

export interface CleanupOnlineSavepointsResult {
  online_dir: string;
  machine: string;
  deleted_count: number;
  expired_count: number;
  stale_count: number;
  kept_count: number;
}

export interface SavepointStorageSettings {
  directory: string | null;
  directory_exists: boolean;
  legacy_directory: string | null;
}

export interface ExportSavepointTransferResult {
  path: string;
  transfer_id: string;
}

export interface ImportSavepointTransferResult {
  bundle_dir: string;
  transfer_id: string;
  summary_line: string;
  imported: boolean;
}

export async function listOnlineSavepoints(): Promise<OnlineSavepointEntry[]> {
  return invoke<OnlineSavepointEntry[]>("list_online_savepoints");
}

export async function listTrashedOnlineSavepoints(): Promise<OnlineSavepointEntry[]> {
  return invoke<OnlineSavepointEntry[]>("list_trashed_online_savepoints");
}

export async function getSavepointStorageSettings(): Promise<SavepointStorageSettings> {
  return invoke<SavepointStorageSettings>("get_savepoint_storage_settings");
}

export async function exportSavepointTransfer(
  bundleDir: string,
  destinationPath: string,
): Promise<ExportSavepointTransferResult> {
  return invoke<ExportSavepointTransferResult>("export_savepoint_transfer", { bundleDir, destinationPath } satisfies ExportSavepointTransferArgs);
}

export async function importSavepointTransfer(
  sourcePath: string,
): Promise<ImportSavepointTransferResult> {
  return invoke<ImportSavepointTransferResult>("import_savepoint_transfer", { sourcePath } satisfies SourcePathArgs);
}

export async function joinSavepointSummary(bundleDir: string): Promise<JoinSavepointSummaryResult> {
  return invoke<JoinSavepointSummaryResult>("join_savepoint_summary", { bundleDir } satisfies BundleDirArgs);
}

export async function joinSavepointFull(bundleDir: string): Promise<JoinSavepointFullResult> {
  return invoke<JoinSavepointFullResult>("join_savepoint_full", { bundleDir } satisfies BundleDirArgs);
}

export interface DuplicateAgentSessionResult {
  agent_kind: AgentSessionKind;
  source_session_id: string;
  new_session_id: string;
  resolved_cwd: string;
}

export async function duplicateAgentSession(
  kind: AgentSessionKind,
  sessionId: string,
  cwd?: string,
): Promise<DuplicateAgentSessionResult> {
  return invoke<DuplicateAgentSessionResult>(
    "duplicate_agent_session",
    { kind, sessionId, cwd } satisfies DuplicateAgentSessionArgs,
  );
}

export async function toggleSavepointPin(bundleDir: string): Promise<ToggleSavepointPinResult> {
  return invoke<ToggleSavepointPinResult>("toggle_savepoint_pin", { bundleDir } satisfies BundleDirArgs);
}

export async function cleanupOnlineSavepoints(): Promise<CleanupOnlineSavepointsResult> {
  return invoke<CleanupOnlineSavepointsResult>("cleanup_online_savepoints");
}

export interface PublishSavepointResult {
  bundle_dir: string;
  session_id: string;
  summary_line: string;
  files_written: number;
  files_read: number;
  warnings: string[];
  updated: boolean;
  record_kind: "current" | "final";
  checkpoint_id: string;
  parent_checkpoint_id?: string | null;
}

export type SavepointCloseReason =
  | "manual"
  | "tab_closed"
  | "pane_closed"
  | "workspace_closed"
  | "app_closed";

export type SavepointPublishStage = "digest" | "handoff" | "bundle" | "register" | "done";

export interface SavepointPublishProgress {
  stage: SavepointPublishStage;
  agent_kind: "claude" | "codex";
  agent_session_id: string;
  claude_session_id?: string | null;
}

export function onSavepointPublishProgress(
  callback: (progress: SavepointPublishProgress) => void,
): Promise<UnlistenFn> {
  return listen<SavepointPublishProgress>("mycmux:savepoint-publish-progress", (event) => {
    callback(event.payload);
  });
}

export async function publishSavepoint(options: {
  cwd: string;
  agentKind: "claude" | "codex";
  agentSessionId: string;
  summary?: string;
  nextStep?: string;
}): Promise<PublishSavepointResult> {
  return invoke<PublishSavepointResult>("publish_savepoint", {
    cwd: options.cwd,
    agentKind: options.agentKind,
    agentSessionId: options.agentSessionId,
    claudeSessionId: options.agentKind === "claude" ? options.agentSessionId : null,
    summary: options.summary ?? null,
    nextStep: options.nextStep ?? null,
    windowLabel: windowLabel(),
  } satisfies PublishSavepointArgs);
}

export async function finalizeSavepoint(options: {
  cwd: string;
  agentKind: "claude" | "codex";
  agentSessionId: string;
  summary?: string;
  nextStep?: string;
  closedReason?: SavepointCloseReason;
}): Promise<PublishSavepointResult> {
  return invoke<PublishSavepointResult>("finalize_savepoint", {
    cwd: options.cwd,
    agentKind: options.agentKind,
    agentSessionId: options.agentSessionId,
    claudeSessionId: options.agentKind === "claude" ? options.agentSessionId : null,
    summary: options.summary ?? null,
    nextStep: options.nextStep ?? null,
    closedReason: options.closedReason ?? "manual",
    windowLabel: windowLabel(),
  } satisfies FinalizeSavepointArgs);
}

// ─── CRSM commands ─────────────────────────────────────────────────────────

export interface CrsmSessionEntry {
  kind: "claude" | "codex" | "claude-codex" | "grok";
  id: string;
  cwd: string;
  label: string;
  preview: string;
  last_activity: string;
  started_at?: string | null;
  source: string;
  source_path: string;
  transcript_path?: string | null;
  summary_file?: string | null;
  files_modified: string[];
  incomplete_tasks: string[];
  has_user_messages?: boolean;
}

export interface CrsmHandoffResult {
  path: string;
  bootstrap_prompt: string;
  from_kind: "claude" | "codex" | "claude-codex" | "grok";
  target_kind: "claude" | "codex" | "claude-codex" | "grok";
  from_session_id: string;
  cwd: string;
}

export async function crsmListSessions(
  query?: string,
  limit = 200,
  refresh = false,
): Promise<CrsmSessionEntry[]> {
  return invoke<CrsmSessionEntry[]>("crsm_list_sessions", {
    query: query?.trim() ? query : null,
    limit,
    refresh,
  } satisfies CrsmListSessionsArgs);
}

export async function crsmCreateHandoff(
  sessionId: string,
  fromKind: CrsmSessionEntry["kind"],
  targetKind: CrsmSessionEntry["kind"],
  recentTurns = 20,
): Promise<CrsmHandoffResult> {
  return invoke<CrsmHandoffResult>("crsm_create_handoff", {
    sessionId,
    fromKind,
    targetKind,
    recentTurns,
  } satisfies CrsmCreateHandoffArgs);
}

// ─── Remote access commands ─────────────────────────────────────────────────

export interface RemoteClientInfo {
  id: number;
  peer_addr: string;
  connected_at: number;
  attached_session_id?: string | null;
}

export interface RemoteInfo {
  url: string;
  token_suffix: string;
  qr_svg: string;
  connected_clients: RemoteClientInfo[];
}

export async function getRemoteInfo(): Promise<RemoteInfo> {
  return invoke<RemoteInfo>("get_remote_info");
}

export async function rotateRemoteToken(): Promise<RemoteInfo> {
  return invoke<RemoteInfo>("rotate_remote_token");
}

/**
 * Whether the remote terminal server should bind 0.0.0.0 (LAN/Tailscale
 * reachable) instead of 127.0.0.1-only. Persisted; a change takes effect on
 * the next app restart.
 */
export async function getRemoteBindAll(): Promise<boolean> {
  return invoke<boolean>("get_remote_bind_all");
}

export async function setRemoteBindAll(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_remote_bind_all", { enabled } satisfies EnabledArgs);
}

export async function getRemoteEnabled(): Promise<boolean> {
  return invoke<boolean>("get_remote_enabled");
}

export async function setRemoteEnabled(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_remote_enabled", { enabled } satisfies EnabledArgs);
}

export interface AgentSessionMapping {
  agent_kind?: AgentSessionKind | null;
  session_id: string;
}

export async function readAgentSessionMappings(
  sessionIds: string[],
): Promise<Record<string, AgentSessionMapping>> {
  return invoke<Record<string, AgentSessionMapping>>("read_agent_session_mappings", { sessionIds: Array.from(new Set(sessionIds)) } satisfies SessionIdsArgs);
}

export interface DefaultShellInfo {
  command: string;
  args: string[];
}

export async function getDefaultShell(): Promise<DefaultShellInfo> {
  return invoke<DefaultShellInfo>("get_default_shell");
}

// ─── Window / leader election ────────────────────────────────────────────────

export async function claimLeader(): Promise<boolean> {
  return invoke<boolean>("claim_leader");
}

export async function revealMainWindow(): Promise<void> {
  return invoke<void>("reveal_main_window");
}

export async function quitApp(): Promise<void> {
  return invoke<void>("quit_app");
}

export interface OpenChildWindowOptions {
  /** `mycmux-w<n>`; omit to take the lowest free index. */
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * Phase 3a: open an additional (child) app window and return its label. The
 * window boots hidden and reveals itself after first paint — see App.tsx.
 */
export async function openChildWindow(
  options: OpenChildWindowOptions = {},
): Promise<string> {
  return invoke<string>("open_child_window", {
    label: options.label ?? null,
    x: options.x ?? null,
    y: options.y ?? null,
    width: options.width ?? null,
    height: options.height ?? null,
  });
}

// ─── Multi-window workspace registry (Phase 3b) ──────────────────────────────

/** Broadcast revision counter — ownership changed somewhere. */
export const WINDOW_REGISTRY_CHANGED_EVENT = "mycmux://window-registry-changed";
/** Targeted at the window that has workspaces waiting in its adoption queue. */
export const WINDOW_ADOPT_EVENT = "mycmux://window-adopt";

/** One window's published workspace list + its active selection. */
export interface WindowFragment {
  window_label: string;
  /** Synthetic entry: workspaces queued for that window but not yet adopted. */
  pending?: boolean;
  workspaces: WorkspaceConfig[];
  active_workspace_id?: string | null;
  active_pane_id?: string | null;
  active_tab_id?: string | null;
}

export interface WindowAdoptPayload {
  from_label: string;
  to_label: string;
  workspace_ids: string[];
}

export interface OpenWorkspaceWindowOptions extends OpenChildWindowOptions {
  /** The window handing the workspaces over (`windowLabel()`). */
  fromLabel: string;
  /** Serialized workspaces — the same shape `save_persistent_data` stores. */
  workspaces: WorkspaceConfig[];
}

/**
 * Open a window that adopts `workspaces` on boot, and return its label. The
 * caller removes them from its own stores afterwards **without killing any
 * session** — see `tearOutWorkspaceToNewWindow`.
 */
export async function openWorkspaceWindow(
  options: OpenWorkspaceWindowOptions,
): Promise<string> {
  return invoke<string>("open_workspace_window", {
    fromLabel: options.fromLabel,
    workspaces: options.workspaces,
    label: options.label ?? null,
    x: options.x ?? null,
    y: options.y ?? null,
    width: options.width ?? null,
    height: options.height ?? null,
  });
}

/**
 * Every window publishes its own workspaces here. Main merges the non-main
 * fragments into `data.json`; children never call `savePersistentData`.
 */
export async function publishWindowFragment(fragment: WindowFragment): Promise<void> {
  return invoke<void>("publish_window_fragment", { fragment });
}

/** Drain (and thereby claim) the workspaces queued for a window. */
export async function takePendingAdoption(label: string): Promise<WorkspaceConfig[]> {
  return invoke<WorkspaceConfig[]>("take_pending_adoption", { label });
}

/** Hand workspaces to another window; returns how many actually moved. */
export async function releaseWorkspaces(
  fromLabel: string,
  workspaceIds: string[],
  toLabel: string,
): Promise<number> {
  return invoke<number>("release_workspaces", { fromLabel, workspaceIds, toLabel });
}

export async function getWindowFragments(): Promise<WindowFragment[]> {
  return invoke<WindowFragment[]>("get_window_fragments");
}

/** Settings-only hydration for windows that must not load workspaces. */
export async function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

// ─── Persistence commands ────────────────────────────────────────────────────

export interface SuppressedAgentSessionConfig {
  agent_kind: AgentSessionKind;
  agent_session_id: string;
  claude_session_id?: string | null;
}

export interface PaneTabConfig {
  tab_id?: string | null;
  agent_id: string;
  label?: string | null;
  label_source?: "user" | "ai" | null;
  type?: "terminal" | null;
  cwd?: string | null;
  last_process?: string | null;
  claude_session_id?: string | null;
  agent_kind?: AgentSessionKind | null;
  agent_session_id?: string | null;
  suppressed_agent_sessions?: SuppressedAgentSessionConfig[] | null;
  launch_env?: Record<string, string> | null;
  terminal_snapshot?: string[] | null;
  turn_marks?: TurnMarkPersistSnapshot[] | null;
  lifecycle?: "declared" | null;
  origin?: { kind: "human" | "agent"; parent_tab_id?: string | null } | null;
  declared_prompt?: string | null;
  declared_target?: string | null;
}

export interface PaneConfig {
  pane_id?: string | null;
  agent_id: string;
  label: string | null;
  cwd?: string | null;
  last_process?: string | null;
  claude_session_id?: string | null;
  agent_kind?: AgentSessionKind | null;
  agent_session_id?: string | null;
  suppressed_agent_sessions?: SuppressedAgentSessionConfig[] | null;
  launch_env?: Record<string, string> | null;
  active_tab_id?: string | null;
  pinned_tab_id?: string | null;
  tabs?: PaneTabConfig[] | null;
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  grid_template_id: string;
  panes: PaneConfig[];
  created_at: number;
  color?: string | null;
  pet?: string | null;
  split_columns?: number[][] | null;
  column_widths?: number[] | null;
  row_heights_per_col?: number[][] | null;
  // Legacy fields (read-only, for migration from older data formats)
  split_rows?: number[][] | null;
  row_sizes?: number[] | null;
  column_sizes?: number[][] | null;
  layout_tree?: unknown | null;
}

export interface AppSettings {
  font_size: number;
  line_height: number;
  font_family: string;
  theme_id: string;
  theme_tweaks?: ThemeTweaks;
  keybindings?: Record<string, string>;
  ui_density?: string;
  ui_font_scale?: number;
  sidebar_width?: number;
  pet_display_mode?: "ws" | "both" | "none";
  pet_new_ws_mode?: "random" | "choose" | "fixed";
  pet_disabled?: string[];
  pet_fixed_id?: string | null;
  ai_provider?: string;
  ai_model?: string;
  ai_enabled?: boolean;
}

export interface PersistentData {
  schema_version?: number;
  workspaces: WorkspaceConfig[];
  settings: AppSettings;
  active_workspace_id?: string | null;
  active_pane_id?: string | null;
  active_tab_id?: string | null;
}

export async function loadPersistentData(): Promise<PersistentData> {
  return invoke<PersistentData>("load_persistent_data");
}

export async function savePersistentData(data: PersistentData): Promise<void> {
  return invoke<void>("save_persistent_data", { data } satisfies SavePersistentDataArgs);
}

import type { ListedPet } from "./pets";
export type { ListedPet } from "./pets";

export async function listPets(): Promise<ListedPet[]> {
  return invoke<ListedPet[]>("list_pets");
}

export interface GalleryPet {
  id: string;
  displayName: string;
  description: string;
  tags: string[];
  likeCount: number;
  downloadCount: number;
  /** The whole animation side by side — thousands of px wide, not a thumbnail. */
  previewUrl: string;
  /** A single frame: this is the one to show on a card. */
  posterUrl: string;
  atlasSize: string;
  statesDetected: number;
}

export interface GalleryPage {
  pets: GalleryPet[];
  total: number;
}

export interface QuarantinedPet {
  folder: string;
  name: string;
  atlas_width?: number | null;
  atlas_height?: number | null;
  rows?: number | null;
  valid: boolean;
  warning?: string | null;
}

export async function fetchPetGallery(query = "", page = 1, pageSize = 24, sort = "new"): Promise<GalleryPage> {
  return invoke<GalleryPage>("fetch_pet_gallery", { query: query.trim() || null, page, pageSize, sort });
}

export async function fetchPetPreview(previewUrl: string): Promise<string> {
  return invoke<string>("fetch_pet_preview", { previewUrl });
}

export async function installPetFromGallery(id: string): Promise<ListedPet> {
  return invoke<ListedPet>("install_pet_from_gallery", { id });
}

export async function quarantinePet(folder: string): Promise<string> {
  return invoke<string>("quarantine_pet", { folder });
}

export async function restorePet(folder: string): Promise<void> {
  return invoke<void>("restore_pet", { folder });
}

export async function listQuarantinedPets(): Promise<QuarantinedPet[]> {
  return invoke<QuarantinedPet[]>("list_quarantined_pets");
}

export async function sendSocketResponse(id: number, result: any, error: string | null): Promise<void> {
  return invoke<void>("socket_response", { id, result, error } satisfies SocketResponseArgs);
}

// ─── Local path commands ─────────────────────────────────────────────────────

export interface ResolvedLocalPathLink {
  existingPrefix: string;
  isDir: boolean;
}

export async function resolveLocalPathLinks(
  candidates: string[],
): Promise<Array<ResolvedLocalPathLink | null>> {
  return invoke<Array<ResolvedLocalPathLink | null>>("resolve_local_path_links", { candidates } satisfies CandidatesArgs);
}

export async function revealInExplorer(path: string): Promise<void> {
  return invoke<void>("reveal_in_explorer", { path } satisfies PathArgs);
}

export async function revealPathInExplorer(uri: string): Promise<void> {
  return invoke<void>("reveal_path_in_explorer", { uri } satisfies UriArgs);
}

export async function openPathWithDefaultApp(uri: string): Promise<void> {
  return invoke<void>("open_path_with_default_app", { uri } satisfies UriArgs);
}

export async function openWithDefault(path: string): Promise<void> {
  return invoke<void>("open_with_default", { path } satisfies PathArgs);
}

// ─── Usage / usage accounts ─────────────────────────────────────────────────

export interface WindowStat {
  pct: number;
  resets_at: string;
}

/** A usage window the API named beyond the fixed four (per-model limits etc.). */
export interface NamedWindowStat {
  key: string;
  window: WindowStat;
}

export type UsageRowState = "ok" | "wait_for_cli" | "cooldown" | "needs_relogin" | "unsupported" | "error";

export interface ProfileUsage {
  profile_id: string;
  provider: CliProvider;
  label: string;
  email: string | null;
  plan: string | null;
  registered: boolean;
  is_active: boolean;
  needs_relogin: boolean;
  state: UsageRowState;
  five_hour: WindowStat | null;
  seven_day: WindowStat | null;
  seven_day_sonnet: WindowStat | null;
  seven_day_opus: WindowStat | null;
  model_windows: NamedWindowStat[];
  error_code: string | null;
  retry_at: string | null;
  fetched_at: string;
}

export interface AccountUsageReport {
  accounts: ProfileUsage[];
  generated_at: string;
}

export async function getAccountUsage(): Promise<AccountUsageReport> {
  return invoke<AccountUsageReport>("get_account_usage");
}

export type CliProvider = "claude" | "codex" | "grok";

export interface CliAccountProfile {
  id: string;
  provider: CliProvider;
  label: string;
  email: string | null;
  identity_key: string;
  plan: string | null;
  org_name: string | null;
  captured_at: string;
  last_switched_at: string | null;
  needs_relogin: boolean;
}

export interface CliLiveLogin {
  provider: CliProvider;
  present: boolean;
  email: string | null;
  identity_key: string | null;
  plan: string | null;
  org_name: string | null;
  matched_profile_id: string | null;
  error: string | null;
}

export interface CliAccountActivePointers {
  claude: string | null;
  codex: string | null;
  grok: string | null;
}

export interface CliOrphanSnapshot {
  id: string;
  provider: CliProvider | null;
  captured_at: string | null;
  email: string | null;
  identity_key: string | null;
  plan: string | null;
  org_name: string | null;
  needs_relogin: boolean;
  error: string | null;
}

export interface CliAccountsSnapshot {
  profiles: CliAccountProfile[];
  live: CliLiveLogin[];
  active: CliAccountActivePointers;
  orphans: CliOrphanSnapshot[];
  backup_root: string;
  generated_at: string;
}

export interface CliSwitchResult {
  profile: CliAccountProfile;
  wrote_back_to: string | null;
  backup_dir: string;
  warnings: string[];
}

export async function listCliAccounts(): Promise<CliAccountsSnapshot> {
  return invoke<CliAccountsSnapshot>("list_cli_accounts");
}

export async function captureCliAccount(provider: CliProvider, label?: string): Promise<CliAccountProfile> {
  return invoke<CliAccountProfile>("capture_cli_account", { provider, label } satisfies CaptureCliAccountArgs);
}

export async function switchCliAccount(provider: CliProvider, profileId: string): Promise<CliSwitchResult> {
  return invoke<CliSwitchResult>("switch_cli_account", { provider, profileId } satisfies SwitchCliAccountArgs);
}

export async function removeCliAccount(profileId: string): Promise<void> {
  return invoke<void>("remove_cli_account", { profileId } satisfies ProfileIdArgs);
}

export async function renameCliAccount(profileId: string, label: string): Promise<CliAccountProfile> {
  return invoke<CliAccountProfile>("rename_cli_account", { profileId, label } satisfies RenameCliAccountArgs);
}

export type CliOrphanAction = "register" | "discard";

export async function resolveCliAccountOrphan(
  orphanId: string,
  action: CliOrphanAction,
  label?: string,
): Promise<CliAccountProfile | null> {
  return invoke<CliAccountProfile | null>("resolve_cli_account_orphan", {
    orphanId,
    action,
    label,
  } satisfies ResolveCliAccountOrphanArgs);
}

// ─── Isolated CLI login (add an account without touching the live one) ───────

export type CliLoginMode = "new" | "reauth";

/**
 * How the backend wants the CLI launched. The command, arguments and
 * environment are decided in Rust because the isolation guarantee rests
 * entirely on the config-directory override — never rebuild them here, pass
 * them through to the pane as they arrive.
 */
export interface CliLoginSession {
  login_id: string;
  provider: CliProvider;
  command: string;
  args: string[];
  env: Record<string, string>;
  staging_dir: string;
}

export interface CliLoginSessionStatus {
  login_id: string;
  provider: CliProvider;
  mode: string;
  staging_dir: string;
  elapsed_secs: number;
}

export interface CliLoginCompletedPayload {
  login_id: string;
  profile: CliAccountProfile;
  updated_existing: boolean;
}

export interface CliLoginFailedPayload {
  login_id: string;
  code: string;
}

export interface CliLoginIdentityMismatchPayload {
  login_id: string;
  email: string | null;
}

export const CLI_LOGIN_COMPLETED_EVENT = "mycmux://cli-login-completed";
export const CLI_LOGIN_FAILED_EVENT = "mycmux://cli-login-failed";
export const CLI_LOGIN_IDENTITY_MISMATCH_EVENT = "mycmux://cli-login-identity-mismatch";

/** Rust gives up on an unfinished login after this long and emits login_timeout. */
export const CLI_LOGIN_TIMEOUT_MS = 600_000;

export async function beginCliLogin(
  provider: CliProvider,
  mode: CliLoginMode,
  expectedProfileId?: string,
): Promise<CliLoginSession> {
  return invoke<CliLoginSession>("begin_cli_login", {
    provider,
    mode,
    expectedProfileId,
  } satisfies BeginCliLoginArgs);
}

export async function cancelCliLogin(loginId: string): Promise<void> {
  return invoke<void>("cancel_cli_login", { loginId } satisfies LoginIdArgs);
}

export async function listCliLoginSessions(): Promise<CliLoginSessionStatus[]> {
  return invoke<CliLoginSessionStatus[]>("list_cli_login_sessions");
}

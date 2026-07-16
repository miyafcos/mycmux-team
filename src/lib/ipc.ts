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
import type { AgentSessionKind, ArtifactSourceKind, ThemeTweaks } from "../types";
import type { OnlineSavepointEntry } from "../components/online/onlineSavepoints";

export { getCurrentSessionEpoch, type FrontendDataBatch };

const sessionCreateTails = new Map<string, Promise<void>>();

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
      await invoke("create_session", {
        sessionId,
        command,
        args,
        cols,
        rows,
        onData: channel,
        cwd: cwd ?? null,
        env: env ?? null,
        restoreFallbackSessionIds: restoreFallbackSessionIds ?? [],
      });
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
  return invoke("ack_frontend_data", { sessionId, generation, seq, bytes });
}

export async function setFrontendVisible(sessionId: string, visible: boolean): Promise<void> {
  return invoke("set_frontend_visible", { sessionId, visible });
}

export interface ScrollbackSnapshot {
  data: Uint8Array;
  startOffset: number;
  endOffset: number;
}

export async function getSessionScrollback(sessionId: string): Promise<ScrollbackSnapshot> {
  const frame = await invoke<ArrayBuffer>("get_session_scrollback", { sessionId });
  return decodeScrollbackSnapshot(frame);
}

export async function writeToSession(
  sessionId: string,
  data: string,
): Promise<void> {
  return invoke("write_to_session", { sessionId, data });
}

export async function isSessionAlive(sessionId: string): Promise<boolean> {
  return invoke("is_session_alive", { sessionId });
}

export async function resizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("resize_session", { sessionId, cols, rows });
}

export async function killSession(sessionId: string): Promise<void> {
  return invoke("kill_session", { sessionId });
}

export async function previewArtifactForSession(sessionId: string): Promise<string> {
  return invoke("preview_artifact_for_session", { sessionId });
}

export async function previewArtifactUriForSession(sessionId: string, uri: string): Promise<string> {
  return invoke("preview_artifact_uri_for_session", { sessionId, uri });
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
  return invoke("preview_artifact_uri_for_session_v2", { sessionId, uri });
}

export async function readEditableArtifact(sourcePath: string): Promise<EditableArtifactSource> {
  return invoke("read_editable_artifact", { sourcePath });
}

export async function saveEditableArtifact(
  sourcePath: string,
  sourceKind: ArtifactSourceKind,
  content: string,
): Promise<SaveEditableArtifactResult> {
  return invoke("save_editable_artifact", { sourcePath, sourceKind, content });
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
  agent_active: boolean;
  claude_session_id?: string;
  agent_kind?: AgentSessionKind;
  agent_session_id?: string;
}

export type PtyMetadataSnapshot = Record<string, PtyMetadata>;

export async function getPtyMetadataSnapshot(): Promise<PtyMetadataSnapshot> {
  return invoke("get_pty_metadata_snapshot");
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
  return invoke("get_terminal_config");
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
  return invoke("is_directory", { path });
}

export async function getLaunchCwd(): Promise<string | null> {
  return invoke("get_launch_cwd");
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
  return invoke("list_online_savepoints");
}

export async function listTrashedOnlineSavepoints(): Promise<OnlineSavepointEntry[]> {
  return invoke("list_trashed_online_savepoints");
}

export async function getSavepointStorageSettings(): Promise<SavepointStorageSettings> {
  return invoke("get_savepoint_storage_settings");
}

export async function exportSavepointTransfer(
  bundleDir: string,
  destinationPath: string,
): Promise<ExportSavepointTransferResult> {
  return invoke("export_savepoint_transfer", { bundleDir, destinationPath });
}

export async function importSavepointTransfer(
  sourcePath: string,
): Promise<ImportSavepointTransferResult> {
  return invoke("import_savepoint_transfer", { sourcePath });
}

export async function joinSavepointSummary(bundleDir: string): Promise<JoinSavepointSummaryResult> {
  return invoke("join_savepoint_summary", { bundleDir });
}

export async function joinSavepointFull(bundleDir: string): Promise<JoinSavepointFullResult> {
  return invoke("join_savepoint_full", { bundleDir });
}

export async function toggleSavepointPin(bundleDir: string): Promise<ToggleSavepointPinResult> {
  return invoke("toggle_savepoint_pin", { bundleDir });
}

export async function cleanupOnlineSavepoints(): Promise<CleanupOnlineSavepointsResult> {
  return invoke("cleanup_online_savepoints");
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
  return invoke("publish_savepoint", {
    cwd: options.cwd,
    agentKind: options.agentKind,
    agentSessionId: options.agentSessionId,
    claudeSessionId: options.agentKind === "claude" ? options.agentSessionId : null,
    summary: options.summary ?? null,
    nextStep: options.nextStep ?? null,
  });
}

export async function finalizeSavepoint(options: {
  cwd: string;
  agentKind: "claude" | "codex";
  agentSessionId: string;
  summary?: string;
  nextStep?: string;
  closedReason?: SavepointCloseReason;
}): Promise<PublishSavepointResult> {
  return invoke("finalize_savepoint", {
    cwd: options.cwd,
    agentKind: options.agentKind,
    agentSessionId: options.agentSessionId,
    claudeSessionId: options.agentKind === "claude" ? options.agentSessionId : null,
    summary: options.summary ?? null,
    nextStep: options.nextStep ?? null,
    closedReason: options.closedReason ?? "manual",
  });
}

// ─── CRSM commands ─────────────────────────────────────────────────────────

export interface CrsmSessionEntry {
  kind: "claude" | "codex" | "claude-codex";
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
  from_kind: "claude" | "codex" | "claude-codex";
  target_kind: "claude" | "codex" | "claude-codex";
  from_session_id: string;
  cwd: string;
}

export async function crsmListSessions(
  query?: string,
  limit = 200,
  refresh = false,
): Promise<CrsmSessionEntry[]> {
  return invoke("crsm_list_sessions", {
    query: query?.trim() ? query : null,
    limit,
    refresh,
  });
}

export async function crsmCreateHandoff(
  sessionId: string,
  fromKind: CrsmSessionEntry["kind"],
  targetKind: CrsmSessionEntry["kind"],
  recentTurns = 20,
): Promise<CrsmHandoffResult> {
  return invoke("crsm_create_handoff", {
    sessionId,
    fromKind,
    targetKind,
    recentTurns,
  });
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
  return invoke("get_remote_info");
}

export async function rotateRemoteToken(): Promise<RemoteInfo> {
  return invoke("rotate_remote_token");
}

/**
 * Whether the remote terminal server should bind 0.0.0.0 (LAN/Tailscale
 * reachable) instead of 127.0.0.1-only. Persisted; a change takes effect on
 * the next app restart.
 */
export async function getRemoteBindAll(): Promise<boolean> {
  return invoke("get_remote_bind_all");
}

export async function setRemoteBindAll(enabled: boolean): Promise<boolean> {
  return invoke("set_remote_bind_all", { enabled });
}

export interface AgentSessionMapping {
  agent_kind?: AgentSessionKind | null;
  session_id: string;
}

export async function readAgentSessionMappings(
  sessionIds: string[],
): Promise<Record<string, AgentSessionMapping>> {
  return invoke("read_agent_session_mappings", { sessionIds: Array.from(new Set(sessionIds)) });
}

export interface DefaultShellInfo {
  command: string;
  args: string[];
}

export async function getDefaultShell(): Promise<DefaultShellInfo> {
  return invoke("get_default_shell");
}

// ─── Window / leader election ────────────────────────────────────────────────

export async function claimLeader(): Promise<boolean> {
  return invoke("claim_leader");
}

export async function getWindowCount(): Promise<number> {
  return invoke("get_window_count");
}

export async function revealMainWindow(): Promise<void> {
  return invoke("reveal_main_window");
}

export async function quitApp(): Promise<void> {
  return invoke("quit_app");
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
  type?: "terminal" | null;
  cwd?: string | null;
  last_process?: string | null;
  claude_session_id?: string | null;
  agent_kind?: AgentSessionKind | null;
  agent_session_id?: string | null;
  suppressed_agent_sessions?: SuppressedAgentSessionConfig[] | null;
  launch_env?: Record<string, string> | null;
  terminal_snapshot?: string[] | null;
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
  tabs?: PaneTabConfig[] | null;
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  grid_template_id: string;
  panes: PaneConfig[];
  created_at: number;
  color?: string | null;
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
  font_family: string;
  theme_id: string;
  theme_tweaks?: ThemeTweaks;
  keybindings?: Record<string, string>;
}

export interface PersistentData {
  schema_version?: number;
  workspaces: WorkspaceConfig[];
  settings: AppSettings;
  active_workspace_id?: string | null;
  active_pane_id?: string | null;
  active_tab_id?: string | null;
  pinned_roots?: PinnedRoot[];
}

export async function loadPersistentData(): Promise<PersistentData> {
  return invoke("load_persistent_data");
}

export async function savePersistentData(data: PersistentData): Promise<void> {
  return invoke("save_persistent_data", { data });
}

export async function saveWorkspaces(
  workspaces: WorkspaceConfig[],
  activeWorkspaceId?: string | null,
  activePaneId?: string | null,
): Promise<void> {
  return invoke("save_workspaces", {
    workspaces,
    activeWorkspaceId: activeWorkspaceId ?? null,
    activePaneId: activePaneId ?? null,
  });
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  return invoke("save_settings", { settings });
}


export async function sendSocketResponse(id: number, result: any, error: string | null): Promise<void> {
  return invoke("socket_response", { id, result, error });
}

// ─── File explorer commands ──────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  modified?: number;
}

export interface PinnedRoot {
  id: string;
  path: string;
  name: string;
}

export async function listDirectory(path: string): Promise<FileEntry[]> {
  return invoke("list_directory", { path });
}

export async function walkTree(
  root: string,
  excludes: string[] = [],
  maxDepth?: number,
  limit?: number,
  includeHidden = false,
): Promise<FileEntry[]> {
  return invoke("walk_tree", {
    root,
    excludes,
    maxDepth: maxDepth ?? null,
    limit: limit ?? null,
    includeHidden,
  });
}

export async function normalizePath(path: string): Promise<string> {
  return invoke("normalize_path", { path });
}

export interface ResolvedLocalPathLink {
  existingPrefix: string;
  isDir: boolean;
}

export async function resolveLocalPathLinks(
  candidates: string[],
): Promise<Array<ResolvedLocalPathLink | null>> {
  return invoke("resolve_local_path_links", { candidates });
}

export async function savePinnedRoots(pinnedRoots: PinnedRoot[]): Promise<void> {
  return invoke("save_pinned_roots", { pinnedRoots });
}

export async function watchRoot(path: string): Promise<void> {
  return invoke("watch_root", { path });
}

export async function unwatchRoot(path: string): Promise<void> {
  return invoke("unwatch_root", { path });
}

export async function revealInExplorer(path: string): Promise<void> {
  return invoke("reveal_in_explorer", { path });
}

export async function revealPathInExplorer(uri: string): Promise<void> {
  return invoke("reveal_path_in_explorer", { uri });
}

export async function openWithDefault(path: string): Promise<void> {
  return invoke("open_with_default", { path });
}

export async function createFile(parent: string, name: string): Promise<string> {
  return invoke("create_file", { parent, name });
}

export async function createFolder(parent: string, name: string): Promise<string> {
  return invoke("create_folder", { parent, name });
}

export interface FsChangedPayload {
  path: string;
}

export function onFsChanged(
  callback: (payload: FsChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<FsChangedPayload>("fs_changed", (event) => {
    callback(event.payload);
  });
}

// ─── Usage / usage accounts ─────────────────────────────────────────────────

export interface WindowStat {
  pct: number;
  resets_at: string;
}

export interface UsageSummary {
  claude_5h: WindowStat | null;
  claude_7d: WindowStat | null;
  claude_7d_sonnet: WindowStat | null;
  claude_7d_opus: WindowStat | null;
  codex_5h: WindowStat | null;
  codex_7d: WindowStat | null;
  claude_available: boolean;
  codex_available: boolean;
  claude_error: string | null;
  codex_error: string | null;
  generated_at: string;
}

export interface UsageAccountMeta {
  account_id: string;
  label: string;
  email?: string | null;
  enabled: boolean;
  needs_reauth: boolean;
  created_at?: string;
}

export interface AccountUsage {
  account_id: string;
  label: string;
  enabled: boolean;
  needs_reauth: boolean;
  five_hour: WindowStat | null;
  seven_day: WindowStat | null;
  seven_day_sonnet: WindowStat | null;
  seven_day_opus: WindowStat | null;
  error: string | null;
  fetched_at: string;
}

export interface OauthLoginStart {
  authorize_url: string;
  login_id: string;
}

export async function getUsageSummary(): Promise<UsageSummary> {
  return invoke("get_usage_summary");
}

export async function getMultiUsage(): Promise<AccountUsage[]> {
  return invoke("get_multi_usage");
}

export async function startOauthLogin(): Promise<OauthLoginStart> {
  return invoke("start_oauth_login");
}

export async function completeOauthLogin(
  loginId: string,
  pastedCode: string,
): Promise<UsageAccountMeta> {
  return invoke("complete_oauth_login", { loginId, pastedCode });
}

export async function listUsageAccounts(): Promise<UsageAccountMeta[]> {
  return invoke("list_usage_accounts");
}

export async function removeUsageAccount(accountId: string): Promise<void> {
  return invoke("remove_usage_account", { accountId });
}

export async function setUsageAccountEnabled(
  accountId: string,
  enabled: boolean,
): Promise<void> {
  return invoke("set_usage_account_enabled", { accountId, enabled });
}

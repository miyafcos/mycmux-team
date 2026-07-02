import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentSessionKind, ArtifactSourceKind, ThemeTweaks } from "../types";

// v0.7.1 diag: per-session committed attach epoch.
// createSession() reserves a unique next epoch, but only publishes it after the
// backend attach succeeds. Older onmessage closures keep rendering until that
// commit; after commit they ACK/drop stale batches so old attachments cannot
// write into the terminal.
const sessionAttachEpoch = new Map<string, number>();
const sessionAttachNextEpoch = new Map<string, number>();

export type FrontendDataBatch = {
  generation: number;
  seq: number;
  bytes: number;
  data: number[] | ArrayBuffer | Uint8Array;
};

export function getCurrentSessionEpoch(sessionId: string): number {
  return sessionAttachEpoch.get(sessionId) ?? 0;
}

function reserveSessionAttachEpoch(sessionId: string): number {
  const current = sessionAttachEpoch.get(sessionId) ?? 0;
  const next = (sessionAttachNextEpoch.get(sessionId) ?? current) + 1;
  sessionAttachNextEpoch.set(sessionId, next);
  return next;
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
): Promise<void> {
  const previousEpoch = sessionAttachEpoch.get(sessionId) ?? 0;
  const epoch = reserveSessionAttachEpoch(sessionId);
  const consumerId = `${epoch}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const channel = new Channel<FrontendDataBatch>();
  const pendingBatches: FrontendDataBatch[] = [];
  let messageCount = 0;
  let staleNoticeCount = 0;
  let attachResolved = false;
  let attachFailed = false;

  const ackStaleBatch = (batch: FrontendDataBatch, current: number | undefined): void => {
    ackFrontendData(sessionId, batch.generation, batch.seq, batch.bytes).catch((err) => {
      if (import.meta.env.DEV) {
        console.warn("[mycmux-diag ipc] failed to ack stale PTY batch:", err);
      }
    });
    // Throttle stale notices: log every 25 stale messages to avoid console flood.
    // Debug builds only (Vite drops this in production).
    if (import.meta.env.DEV && staleNoticeCount % 25 === 0) {
      console.log(
        `[mycmux-diag ipc] stale_message session=${sessionId} attached_epoch=${epoch} current=${current ?? "none"} stale_count=${staleNoticeCount + 1} bytes_this_msg=${batch.bytes}`,
      );
    }
    staleNoticeCount += 1;
  };

  const flushPendingBatches = (): void => {
    const pending = pendingBatches.splice(0);
    for (const batch of pending) {
      const current = sessionAttachEpoch.get(sessionId);
      if (current === epoch) {
        onData(batch);
      } else {
        ackStaleBatch(batch, current);
      }
    }
  };

  channel.onmessage = (batch) => {
    messageCount += 1;
    const current = sessionAttachEpoch.get(sessionId);
    if (current !== epoch) {
      if (!attachResolved && !attachFailed && (current ?? 0) === previousEpoch) {
        pendingBatches.push(batch);
      } else {
        ackStaleBatch(batch, current);
      }
      return;
    }
    onData(batch);
  };
  if (import.meta.env.DEV) {
    console.log(
      `[mycmux-diag ipc] create_session session=${sessionId} epoch=${epoch} prev_messages=${messageCount}`,
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
      consumerId,
      cwd: cwd ?? null,
      env: env ?? null,
    });
    attachResolved = true;
    sessionAttachEpoch.set(sessionId, epoch);
    flushPendingBatches();
  } catch (err) {
    attachFailed = true;
    for (const batch of pendingBatches.splice(0)) {
      ackStaleBatch(batch, sessionAttachEpoch.get(sessionId));
    }
    throw err;
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

export async function writeToSession(
  sessionId: string,
  data: string,
): Promise<void> {
  return invoke("write_to_session", { sessionId, data });
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

export interface AgentSessionMapping {
  agent_kind?: AgentSessionKind | null;
  session_id: string;
}

export async function readAgentSessionMappings(): Promise<Record<string, AgentSessionMapping>> {
  return invoke("read_agent_session_mappings");
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

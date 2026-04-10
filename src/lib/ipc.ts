import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export async function createSession(
  sessionId: string,
  command: string,
  args: string[],
  cols: number,
  rows: number,
  onData: (data: ArrayBuffer) => void,
  cwd?: string,
  env?: Record<string, string>,
): Promise<void> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = onData;
  return invoke("create_session", {
    sessionId,
    command,
    args,
    cols,
    rows,
    onData: channel,
    cwd: cwd ?? null,
    env: env ?? null,
  });
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
}

export function onPtyMetadata(
  callback: (meta: PtyMetadata) => void,
): Promise<UnlistenFn> {
  return listen<PtyMetadata>("pty_metadata", (event) => {
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

export async function getAllCwds(): Promise<Record<string, string>> {
  return invoke("get_all_cwds");
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

// ─── Persistence commands ────────────────────────────────────────────────────

export interface PaneTabConfig {
  tab_id?: string | null;
  agent_id: string;
  label?: string | null;
  type?: "terminal" | null;
  cwd?: string | null;
  last_process?: string | null;
  claude_session_id?: string | null;
}

export interface PaneConfig {
  pane_id?: string | null;
  agent_id: string;
  label: string | null;
  cwd?: string | null;
  last_process?: string | null;
  claude_session_id?: string | null;
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
  split_rows?: number[][] | null;
  row_sizes?: number[] | null;
  column_sizes?: number[][] | null;
}

export interface AppSettings {
  font_size: number;
  theme_id: string;
  keybindings?: Record<string, string>;
}

export interface PersistentData {
  workspaces: WorkspaceConfig[];
  settings: AppSettings;
  active_workspace_id?: string | null;
  active_pane_id?: string | null;
}

export async function loadPersistentData(): Promise<PersistentData> {
  return invoke("load_persistent_data");
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

export async function writeRestoreManifest(entries: [string, string][]): Promise<void> {
  return invoke("write_restore_manifest", { entries });
}

export async function getClaudeSessionId(cwd: string): Promise<string | null> {
  return invoke("get_claude_session_id", { cwd });
}

export async function readPaneSessionMappings(): Promise<Record<string, string>> {
  return invoke("read_pane_session_mappings");
}

export async function sendSocketResponse(id: number, result: any, error: string | null): Promise<void> {
  return invoke("socket_response", { id, result, error });
}

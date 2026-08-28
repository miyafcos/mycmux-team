export type GridTemplateId =
  | "1x1"
  | "2x1"
  | "3x1"
  | "4x1"
  | "1x2"
  | "2x2"
  | "3x2"
  | "2x3"
  | "3x3"
  | "4x4";

export interface GridTemplate {
  id: GridTemplateId;
  label: string;
  rows: number;
  cols: number;
  /** Total number of panes */
  paneCount: number;
}

export interface SuppressedAgentSession {
  agentKind: AgentSessionKind;
  agentSessionId: string;
  claudeSessionId?: string;
}

/** Bottom-relative turn-chip snapshot persisted on PaneTabConfig. */
export interface TurnMarkPersistSnapshot {
  label: string;
  at: number;
  lines_from_bottom: number;
}

export interface PaneTab {
  id: string;
  sessionId: string;
  agentId: string;
  label?: string;
  /** Who set `label`. Absent means user-set (pre-migration data is treated as user-set). */
  labelSource?: "user" | "ai";
  type?: "terminal" | "browser" | "online";
  cwd?: string;
  lastProcess?: string;
  claudeSessionId?: string;
  agentKind?: AgentSessionKind;
  agentSessionId?: string;
  /** Duplicate restore identity retained for manual recovery; never auto-resumed. */
  suppressedAgentSessions?: SuppressedAgentSession[];
  launchEnv?: Record<string, string>;
  /** Ephemeral prompt appended to the first agent launch; not persisted. */
  initialPrompt?: string;
  /** Ephemeral command override for the first agent launch; not persisted. */
  commandArgv?: string[];
  /**
   * One-shot tab (isolated CLI login and the like). Excluded from layout
   * persistence so a restart never resurrects a terminal pointing at a staging
   * directory that no longer exists.
   */
  ephemeral?: boolean;
  terminalSnapshot?: string[];
  /** Restored turn chips; seed → reanchor after persisted scrollback replay. */
  turnMarks?: TurnMarkPersistSnapshot[];
  /** Browser tabs: local file path (already normalized, no file:// prefix). */
  htmlPath?: string;
  /** Browser tabs: original editable artifact path. */
  sourcePath?: string;
  /** Browser tabs: original editable artifact format. */
  sourceKind?: ArtifactSourceKind;
  /** Browser tabs: rendered preview path used by the iframe. */
  previewPath?: string;
  /** Browser tabs: true while edit mode has unsaved DOM changes. */
  isDirty?: boolean;
  /** Browser tabs: bump to force <iframe> remount when the same htmlPath is re-emitted. */
  reloadCounter?: number;
  /** A declared tab is visible in planning UI but must not be restored or launched. */
  lifecycle?: "declared";
  /** Stable ownership metadata for dashboard grouping; runtime session ids are not used here. */
  origin?: { kind: "human" | "agent"; parentTabId?: string };
  /** Intent captured before a declared tab is launched. */
  declaredPrompt?: string;
  /** Intended agent or execution target captured before launch. */
  declaredTarget?: string;
}

export interface Pane {
  id: string;
  /** Default agent for new tabs */
  agentId: string;
  /** Active tab session ID — kept for backward compat */
  sessionId: string;
  tabs: PaneTab[];
  activeTabId: string;
  /** Custom label override */
  label?: string;
  cwd?: string;
  gitBranch?: string;
  lastProcess?: string;
  claudeSessionId?: string;
  agentKind?: AgentSessionKind;
  agentSessionId?: string;
  /** Active tab's duplicate restore identity retained for manual recovery. */
  suppressedAgentSessions?: SuppressedAgentSession[];
  launchEnv?: Record<string, string>;
  /** Tab that keeps display ownership on merge; always sorts first. */
  pinnedTabId?: string;
}

export type AgentSessionKind = "claude" | "codex" | "claude-codex" | "grok";

export type ArtifactSourceKind = "html" | "markdown" | "office";

export type WorkspaceStatus = "setup" | "running" | "stopped";

export interface Workspace {
  id: string;
  name: string;
  gridTemplateId: GridTemplateId;
  panes: Pane[];
  status: WorkspaceStatus;
  createdAt: number;
  color?: string;
  /** Assigned pet id; undefined is the lazy-choice state for a new workspace. */
  pet?: string;
  /** Each entry is a column of pane IDs for dynamic split tracking (column-first layout) */
  splitColumns?: string[][];
  /** Saved widths for top-level columns (outer horizontal Allotment) */
  columnWidths?: number[];
  /** Saved row heights within each column (inner vertical Allotment per column) */
  rowHeightsPerCol?: number[][];
}

/** Raw fields excluded from persistent layout state. Keep this list explicit. */
export type WorkspaceNonPersistentKey = never;
export type PaneNonPersistentKey = never;
export type PaneTabNonPersistentKey = never;

export type PersistentWorkspaceKey = Exclude<keyof Workspace, WorkspaceNonPersistentKey>;
export type PersistentPaneKey = Exclude<keyof Pane, PaneNonPersistentKey>;
export type PersistentPaneTabKey = Exclude<keyof PaneTab, PaneTabNonPersistentKey>;

export type GridTemplateId =
  | "1x1"
  | "2x1"
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

export interface PaneTab {
  id: string;
  sessionId: string;
  agentId: string;
  label?: string;
  type?: "terminal";
  cwd?: string;
  lastProcess?: string;
  claudeSessionId?: string;
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
}

export type WorkspaceStatus = "setup" | "running" | "stopped";

export interface Workspace {
  id: string;
  name: string;
  gridTemplateId: GridTemplateId;
  panes: Pane[];
  status: WorkspaceStatus;
  createdAt: number;
  color?: string;
  /** Each entry is a column of pane IDs for dynamic split tracking (column-first layout) */
  splitColumns?: string[][];
  /** Saved widths for top-level columns (outer horizontal Allotment) */
  columnWidths?: number[];
  /** Saved row heights within each column (inner vertical Allotment per column) */
  rowHeightsPerCol?: number[][];
}

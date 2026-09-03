/**
 * Workspace bootstrap helpers — shared by the startup path (App.tsx) and the
 * empty-state panel (EmptyWorkspaceState.tsx).
 *
 * Both entry points need the exact same "build panes → stamp a cwd → create the
 * workspace" sequence, so it lives here instead of being duplicated. The pure
 * pieces (path normalization, name derivation, empty-state resolution) are kept
 * free of store access so they can be unit tested in the node environment.
 */
import type { GridTemplateId, Pane } from "../types";
import type { PaneLaunchSpec } from "./agentCatalog";
import {
  usePaneMetadataStore,
  useUiStore,
  useWorkspaceLayoutStore,
  useWorkspaceListStore,
} from "../stores/workspaceStore";

export const DEFAULT_WORKSPACE_NAME = "Terminal";
export const DEFAULT_WORKSPACE_GRID: GridTemplateId = "1x1";

const PATH_SEPARATOR = /[\\/]/;
const DRIVE_ROOT = /^[A-Za-z]:$/;

/**
 * Strips decorative trailing separators while keeping filesystem roots intact.
 * A trailing separator survives into the PTY launch cwd and shell quoting, so
 * "C:/work/" and "C:/work" must not produce two different workspaces.
 */
export function normalizeCwd(cwd: string | null | undefined): string {
  const trimmed = (cwd ?? "").trim();
  if (!trimmed) return "";
  const stripped = trimmed.replace(/[\\/]+$/, "");
  if (!stripped) return trimmed.slice(0, 1);
  if (DRIVE_ROOT.test(stripped)) return `${stripped}\\`;
  return stripped;
}

/** Derives a human workspace name from a directory path (its last segment). */
export function workspaceNameFromCwd(cwd: string | null | undefined): string {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return DEFAULT_WORKSPACE_NAME;
  const segments = normalized.split(PATH_SEPARATOR).filter(Boolean);
  // A bare drive root ("C:\") keeps its drive letter as the name.
  const last = segments[segments.length - 1];
  return last || DEFAULT_WORKSPACE_NAME;
}

/**
 * Stamps a cwd onto every pane and its tabs. Operates on the freshly built pane
 * array from buildInitialPanes (not yet handed to any store), which is why
 * in-place mutation is safe here.
 */
export function applyCwdToPanes(panes: Pane[], cwd: string): Pane[] {
  for (const pane of panes) {
    pane.cwd = cwd;
    for (const tab of pane.tabs) {
      tab.cwd = cwd;
    }
  }
  return panes;
}

export interface CreateWorkspaceAtCwdOptions {
  name?: string;
  gridTemplateId?: GridTemplateId;
  /** Per-pane agent / model / effort. Absent panes open the launcher menu. */
  paneSpecs?: Record<number, PaneLaunchSpec>;
}

/**
 * Folder names repeat, and the one-click path uses the folder name verbatim, so
 * a second workspace in the same folder would be indistinguishable in the
 * sidebar. Numbers the duplicate instead.
 *
 * ponytail: gives up after 99 and reuses the base name — past that the sidebar
 * is the real problem, not the suffix. Switch to a counter on the store if
 * anyone ever gets there.
 */
export function uniqueWorkspaceName(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 99; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/**
 * The folder the user is currently looking at, used to seed a new workspace so
 * the one-click path lands where they already are instead of in the home
 * directory. Prefers the live PTY cwd — the monitor keeps it current as the
 * shell cds — and falls back to the cwd a pane was launched with.
 */
export function activeWorkspaceCwd(): string {
  const listState = useWorkspaceListStore.getState();
  const workspace = listState.workspaces.find((w) => w.id === listState.activeWorkspaceId);
  if (!workspace) return "";

  const activeSessionId = useUiStore.getState().activePaneId;
  if (activeSessionId) {
    const liveCwd = usePaneMetadataStore.getState().metadata[activeSessionId]?.cwd;
    if (liveCwd) return liveCwd;
  }

  for (const pane of workspace.panes) {
    for (const tab of pane.tabs) {
      if (tab.sessionId !== activeSessionId) continue;
      const tabCwd = tab.cwd ?? pane.cwd;
      if (tabCwd) return tabCwd;
    }
  }
  // The active pane may be a web tab or a pane that never reported a cwd; any
  // pane of this workspace is still a better guess than the home directory.
  for (const pane of workspace.panes) {
    const paneCwd = pane.cwd ?? pane.tabs.find((tab) => tab.cwd)?.cwd;
    if (paneCwd) return paneCwd;
  }
  return "";
}

/**
 * Creates a workspace rooted at `cwd` using the standard store actions.
 * Returns the new workspace id.
 */
export function createWorkspaceAtCwd(
  cwd: string | null | undefined,
  options: CreateWorkspaceAtCwdOptions = {},
): string {
  const gridTemplateId = options.gridTemplateId ?? DEFAULT_WORKSPACE_GRID;
  const normalizedCwd = normalizeCwd(cwd);
  const workspaceId = crypto.randomUUID();
  const { panes, splitColumns } = useWorkspaceLayoutStore
    .getState()
    .buildInitialPanes(workspaceId, gridTemplateId, options.paneSpecs);

  if (normalizedCwd) {
    applyCwdToPanes(panes, normalizedCwd);
  }

  useWorkspaceListStore.getState().createWorkspace(
    options.name ?? DEFAULT_WORKSPACE_NAME,
    gridTemplateId,
    panes,
    splitColumns,
    { id: workspaceId },
  );

  return workspaceId;
}

export type EmptyWorkspaceVariant = "first-run" | "returning";

export interface EmptyWorkspaceStateInput {
  workspaceCount: number;
  /** True while the WorkspaceSetup modal owns the workspace area. */
  setupOpen: boolean;
  /** True once this session has seen at least one workspace. */
  hasCreatedWorkspace: boolean;
}

/**
 * Decides whether the empty-state panel is shown and which copy it uses.
 * Returns null when the workspace area has real content (or the setup modal is
 * already covering it).
 */
export function resolveEmptyWorkspaceState(
  input: EmptyWorkspaceStateInput,
): EmptyWorkspaceVariant | null {
  if (input.workspaceCount > 0) return null;
  if (input.setupOpen) return null;
  return input.hasCreatedWorkspace ? "returning" : "first-run";
}

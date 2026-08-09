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
import { useWorkspaceLayoutStore, useWorkspaceListStore } from "../stores/workspaceStore";

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
    .buildInitialPanes(workspaceId, gridTemplateId);

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

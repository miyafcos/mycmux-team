import type { WindowFragment, WorkspaceConfig } from "./ipc";
import { MAIN_WINDOW_LABEL } from "./windowContext";

/**
 * Leader union merge (Phase 3b).
 *
 * Main is the only window that writes `data.json`, but after a tear-out it no
 * longer holds every workspace. Persisting only its own list would drop the
 * torn-out ones from disk — and the phone remote reads that file for workspace
 * names (`remote/mod.rs`), so they would vanish there too. `buildSnapshot`
 * therefore appends every other window's last published fragment.
 *
 * Staleness is bounded by the publishing debounce (500ms, same as main's own
 * autosave); the final flush on a child's close happens before it releases, so
 * a merge-back never persists a stale copy.
 */
export function mergeWindowFragmentWorkspaces(
  ownWorkspaces: WorkspaceConfig[],
  fragments: readonly WindowFragment[],
  ownLabel: string = MAIN_WINDOW_LABEL,
): WorkspaceConfig[] {
  const merged = [...ownWorkspaces];
  // Defensive dedupe: a workspace mid-move can briefly be in both this
  // window's store and the source window's last fragment. The live store wins
  // — it is the copy whose panes are actually mounted.
  const seen = new Set(ownWorkspaces.map((workspace) => workspace.id));

  for (const fragment of fragments) {
    if (!fragment) continue;
    // Own published fragment is redundant with the live store. A *pending*
    // entry for this window is not: during a merge-back the workspaces sit in
    // this window's adoption queue and are in no store yet, so skipping them
    // would drop them from disk for that stretch.
    if (fragment.window_label === ownLabel && !fragment.pending) continue;
    for (const workspace of fragment.workspaces ?? []) {
      if (!workspace?.id || seen.has(workspace.id)) continue;
      seen.add(workspace.id);
      merged.push(workspace);
    }
  }

  return merged;
}

# Workspace store boundary redesign

Date: 2026-07-25

## Decision required

Choose one ownership model before renaming or moving any action:

1. Preferred: one workspace domain store owns workspace records, pane structure, active workspace/pane state, and size metrics. UI-only transient state remains separate.
2. Transitional: keep two stores, make workspace structure mutations a documented public port, and stop calling `_updateWorkspacePanes` directly outside its owner.

The current names are inverted in practice: `workspaceListStore` owns persisted workspace records and update mechanics, while `workspaceLayoutStore` exposes most structural actions. Renaming alone would touch high-density contract pins without changing behavior.

## Proposed ownership

- Workspace domain:
  - workspace records and ordering;
  - pane/tab structure and split columns;
  - active workspace and last-active pane;
  - all atomic pane/tab mutations;
  - serialization-facing normalized state.
- UI state:
  - zoom, dialogs, transient drag previews, local menus;
  - derived display measurements that do not persist.
- Runtime services:
  - PTY create/kill, socket calls, persistence scheduling;
  - invoked through explicit effects after a domain mutation result.

## Migration sequence

1. Characterize the 32 `_updateWorkspacePanes` call sites by operation and side effect.
2. Add behavior tests for close, move, split, restore, active-tab fallback, and cross-workspace moves.
3. Introduce named public mutation ports while retaining old actions as delegating adapters.
4. Migrate one operation family per commit; do not rename stores yet.
5. Remove direct `.getState()` calls from render paths and hooks where selectors or injected callbacks are sufficient.
6. After all callers use the ports, decide whether the two stores still provide a useful transactional boundary.
7. Rename or merge only in a final mechanical commit with contract-path updates and no logic changes.

## Required gates

- Existing workspace move/split Vitest suite remains green.
- Add close/restore/concurrent persistence behavior tests before moving ownership.
- Preserve `PersistentData` schema and all socket payloads.
- Preserve active pane/tab fallback order and attach epoch behavior.
- Run TypeScript, Vitest, Rust, and pytest baselines after every migration slice.

## Non-goals

- No store merge in this proposal phase.
- No persisted schema rename.
- No `_updateWorkspacePanes` visibility change until the product owner selects an ownership model.

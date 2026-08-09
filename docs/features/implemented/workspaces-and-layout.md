# Workspaces & Layout

## Workspace Model

```typescript
interface Workspace {
  id: string;
  name: string;
  gridTemplateId: GridTemplateId;   // "1x1" | "2x1" | ... | "4x4"
  panes: Pane[];
  status: "setup" | "running" | "stopped";
  createdAt: number;
  color?: string;                   // auto-assigned from 6-color palette
  splitRows?: string[][];           // dynamic split tracking
}
```

## Grid Templates

| ID | Layout | Pane Count |
|----|--------|-----------|
| `1x1` | Single pane | 1 |
| `2x1` | 2 columns | 2 |
| `1x2` | 2 rows | 2 |
| `2x2` | 2×2 grid | 4 |
| `3x2` | 3 columns × 2 rows | 6 |
| `2x3` | 2 columns × 3 rows | 6 |
| `3x3` | 3×3 grid | 9 |
| `4x4` | 4×4 grid | 16 |

Template selected during workspace creation via `GridPicker` component.

## Split Layout (Allotment)

`TerminalGrid` uses nested `<Allotment>` components:

```
Allotment (vertical) — rows
  └── Allotment.Pane × N
      └── Allotment (horizontal) — columns per row
          └── Allotment.Pane × M
              └── TerminalPane
```

Two layout modes:
1. **Template layout**: Panes arranged by grid template (rows × cols)
2. **Dynamic layout**: When `splitRows` exists or pane count exceeds template — uses `splitRows` array for freeform arrangements

## Dynamic Splitting

`addPaneToWorkspace(workspaceId, afterPaneId, direction)`:

- **Split right**: Inserts new pane ID after target in its row
- **Split down**: Inserts new row after the row containing target

`splitRows` is a `string[][]` where each inner array is a row of pane IDs.

## Tab-per-Pane Model

Each pane supports multiple tabs:

```typescript
interface Pane {
  tabs: PaneTab[];         // ordered list of tabs
  activeTabId: string;     // currently visible tab
  sessionId: string;       // active tab's session (kept for compat)
}

interface PaneTab {
  id: string;
  sessionId: string;
  agentId: string;
  type?: "terminal" | "browser";
}
```

Tab actions:
- **Add tab**: `onAddTab(agentId, type)` — creates new PTY or browser
- **Close tab**: removes tab; if last tab, removes entire pane
- **Switch tab**: sets `activeTabId`; only the active terminal tab mounts its renderer. Inactive terminal tabs keep their PTY session running and restore scrollback when selected.
- **Cycle tabs**: `Ctrl+Alt+PageDown` / `Ctrl+Alt+PageUp` (`pane.tab.next` / `pane.tab.prev`, v0.15.0)
- **Reorder tabs**: drag a pill along its strip; an insertion indicator marks the slot and `reorderPaneTab` commits the drop. Sidebar workspace rows reorder by drag the same way.
- **Middle-click close**: middle-clicking a tab pill closes it through the same path as the pill's ×, so `Ctrl+Shift+T` can reopen it.

### Adaptive compact tab bar (v0.15.0)

`PaneTabBar` switches to a compact layout when the pane is narrower than 360px and
restores the full layout at 400px (hysteresis via `resolvePaneTabBarMode`, exported
for unit tests). Compact mode shows the active tab label, an `n/m` dropdown listing
all tabs (select / close), and a kebab menu hosting New tab / Publish / Split /
Zoom / Close pane — every action stays within two clicks at any pane width. The
dropdown and the full-mode overflow menu share `PaneTabListMenu`.

## Workspace Lifecycle

1. **Create**: `WorkspaceSetup` modal → choose name, grid, agent assignments → `createWorkspace()`
2. **Run**: Panes spawned, PTY sessions created on mount
3. **Close**: `handleCloseWorkspace()` kills all PTY sessions → `removeWorkspace()`

## Workspace Colors

A fixed 8-entry palette (`src/lib/workspaceColors.ts`), chosen by the user from the
sidebar row's right-click menu and persisted in `Workspace.color`. No color is
assigned automatically; a workspace has none until it is picked. Values outside
the palette (hand-edited `data.json`) normalise to "no color", and the raw hex is
only ever painted as a 3px row bar plus a `color-mix()` row tint, so theme
contrast holds on both light and dark chrome.

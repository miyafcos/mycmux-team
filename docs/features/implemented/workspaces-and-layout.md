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
  color?: string;                   // user-selected from 8-color palette
  splitColumns?: string[][];        // dynamic split tracking
}
```

## Grid Templates

| ID | Layout | Pane Count |
|----|--------|-----------|
| `1x1` | Single pane | 1 |
| `2x1` | 2 columns | 2 |
| `3x1` | 3 columns | 3 |
| `4x1` | 4 columns | 4 |
| `1x2` | 2 rows | 2 |
| `2x2` | 2×2 grid | 4 |
| `3x2` | 3 columns × 2 rows | 6 |
| `2x3` | 2 columns × 3 rows | 6 |
| `3x3` | 3×3 grid | 9 |
| `4x4` | 4×4 grid | 16 |

Template selected in the advanced workspace dialog via `GridPicker`; one-click creation uses the default layout.

## Split Layout (Allotment)

`TerminalGrid` (inside `WorkspaceView.tsx`) uses nested `<Allotment>` components:

```
Allotment (horizontal) — columns
  └── Allotment.Pane × N
      └── Allotment (vertical) — rows per column
          └── Allotment.Pane × M
              └── TerminalPane
```

Two layout modes:
1. **Template initialization**: Grid template (rows × cols) initializes `splitColumns`
2. **Dynamic layout**: `splitColumns` drives column-first arrangements with saved column widths and row heights; missing layout falls back to one column

## Dynamic Splitting

`addPaneToWorkspace(workspaceId, afterPaneId, direction)`:

- **Split right**: Inserts a new column after the target column
- **Split down**: Inserts the new pane after the target within its column

`splitColumns` is a `string[][]` where each inner array is a column of pane IDs.

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
  type?: "terminal" | "browser" | "online" | "web" | "launcher";
}
```

Tab actions:
- **Add tab**: `onAddTab(agentId, type)` — normally opens the React launcher; selecting an agent creates the PTY
- **Close tab**: removes tab; if last tab, removes entire pane
- **Switch tab**: sets `activeTabId`; only the active terminal tab mounts its renderer. Inactive terminal tabs keep their PTY session running and restore scrollback when selected.
- **Cycle tabs**: `Ctrl+Alt+PageDown` / `Ctrl+Alt+PageUp` (`pane.tab.next` / `pane.tab.prev`, v0.15.0)
- **Reorder tabs**: drag a pill along its strip; an insertion indicator marks the slot and `reorderPaneTab` commits the drop. Sidebar workspace rows reorder by drag the same way.
- **Middle-click close**: middle-clicking a tab pill closes it through the same path as the pill's ×, so `Ctrl+Shift+T` can reopen it.

### Adaptive compact tab bar (v0.15.0)

`PaneTabBar` switches to a compact layout when the pane is narrower than 360px and
returns to the wider tier at 400px (hysteresis via `resolvePaneTabBarMode`, exported
for unit tests). Compact mode shows the active tab label, an `n/m` dropdown listing
all tabs (select / close), and a kebab menu hosting New tab / Publish / Split /
Zoom / Close pane. The
dropdown and the full-mode overflow menu share `PaneTabListMenu`.
The current seven tiers are full / slim / compact / compact3 / compact2 / compact1 / micro; their enter/exit thresholds are 560/600, 360/400, 250/290, 210/238, 170/198, and 130/158px.

## Workspace Lifecycle

1. **Create**: one-click New Workspace → `createWorkspace()`; the adjacent dialog trigger chooses name, grid, and agent/model/effort assignments
2. **Run**: new tabs show the React launcher; choosing a terminal target mounts its renderer and creates/reattaches the PTY
3. **Close**: `handleCloseWorkspace()` kills all PTY sessions → `removeWorkspace()`

## Workspace Colors

A fixed 8-entry palette (`src/lib/workspaceColors.ts`), chosen by the user from the
sidebar row's right-click menu and persisted in `Workspace.color`. No color is
assigned automatically; a workspace has none until it is picked. Values outside
the palette (hand-edited `data.json`) normalise to "no color", and the raw hex is
only ever painted as a 3px row bar plus a `color-mix()` row tint, so theme
contrast holds on both light and dark chrome.

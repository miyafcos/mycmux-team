import type { Pane, Workspace } from "../types";

const TAB_PREVIEW_LIMIT = 4;
const UNNAMED_TAB_LABEL = "(名前なし)";

type WorkspacePanes = Pick<Workspace, "panes">;

function tabLabel(pane: Pane): string | undefined {
  const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs[0];
  if (!tab) return undefined;
  return tab.label?.trim() || UNNAMED_TAB_LABEL;
}

export function workspaceTabCount(workspace: WorkspacePanes): number {
  return workspace.panes.reduce((count, pane) => count + pane.tabs.length, 0);
}

export function activeWorkspaceTabLabels(workspace: WorkspacePanes): string[] {
  return workspace.panes.flatMap((pane) => {
    const label = tabLabel(pane);
    return label === undefined ? [] : [label];
  });
}

export function workspaceTabPreview(workspace: WorkspacePanes): {
  labels: string[];
  remainingCount: number;
} {
  const labels = activeWorkspaceTabLabels(workspace);
  return {
    labels: labels.slice(0, TAB_PREVIEW_LIMIT),
    remainingCount: Math.max(0, labels.length - TAB_PREVIEW_LIMIT),
  };
}

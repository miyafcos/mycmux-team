import type { Pane, PaneTab, Workspace } from "../types";

const TAB_PREVIEW_LIMIT = 4;
const UNNAMED_TAB_LABEL = "(名前なし)";

type WorkspacePanes = Pick<Workspace, "panes">;

/**
 * How the pane itself names a tab. Only a stored label survives into the
 * workspace record, so a sidebar reading that alone printed the unnamed
 * placeholder for tabs whose own tab bar was showing "node" or a directory
 * name. The caller hands over the same resolver the pane tab bar uses, which is
 * the only place the process title and cwd are known.
 */
export type TabLabelResolver = (tab: PaneTab, isTabActive: boolean) => string | undefined;

function tabLabel(pane: Pane, resolve?: TabLabelResolver): string | undefined {
  const active = pane.tabs.find((candidate) => candidate.id === pane.activeTabId);
  const tab = active ?? pane.tabs[0];
  if (!tab) return undefined;
  const resolved = resolve?.(tab, tab === active)?.trim();
  return resolved || tab.label?.trim() || UNNAMED_TAB_LABEL;
}

export function workspaceTabCount(workspace: WorkspacePanes): number {
  return workspace.panes.reduce((count, pane) => count + pane.tabs.length, 0);
}

export function activeWorkspaceTabLabels(
  workspace: WorkspacePanes,
  resolve?: TabLabelResolver,
): string[] {
  return workspace.panes.flatMap((pane) => {
    const label = tabLabel(pane, resolve);
    return label === undefined ? [] : [label];
  });
}

export function workspaceTabPreview(
  workspace: WorkspacePanes,
  resolve?: TabLabelResolver,
): {
  labels: string[];
  remainingCount: number;
} {
  const labels = activeWorkspaceTabLabels(workspace, resolve);
  return {
    labels: labels.slice(0, TAB_PREVIEW_LIMIT),
    remainingCount: Math.max(0, labels.length - TAB_PREVIEW_LIMIT),
  };
}

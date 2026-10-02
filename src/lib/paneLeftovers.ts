import { invoke } from "@tauri-apps/api/core";
import type { Workspace } from "../types";
import type { ClosedPaneEntry } from "../stores/closedPaneStore";
import { getTabDisplayLabel } from "./tabDisplayLabel";

export interface PaneLeftoverProcess {
  pid: number;
  parentPid: number | null;
  name: string;
  startedAt: number;
  memoryBytes: number;
  command: string;
  paneSessionId: string;
  paneRunning: boolean;
}

export function listPaneLeftoverProcesses(): Promise<PaneLeftoverProcess[]> {
  return invoke<PaneLeftoverProcess[]>("list_pane_leftover_processes");
}

export function stopPaneLeftoverProcess(process: PaneLeftoverProcess): Promise<void> {
  return invoke<void>("stop_pane_leftover_process", { pid: process.pid, startedAt: process.startedAt });
}

const CLOSED_PANE_LABEL_LIMIT = 200;
const closedPaneLabels = new Map<string, string>();

export function rememberClosedPaneLabel(paneSessionId: string, label: string): void {
  if (!paneSessionId) return;
  closedPaneLabels.delete(paneSessionId);
  closedPaneLabels.set(paneSessionId, label);
  if (closedPaneLabels.size > CLOSED_PANE_LABEL_LIMIT) {
    closedPaneLabels.delete(closedPaneLabels.keys().next().value!);
  }
}

export function __resetPaneLeftoverLabelsForTests(): void {
  closedPaneLabels.clear();
}

export interface PaneLeftoverTree {
  root: PaneLeftoverProcess;
  descendants: PaneLeftoverProcess[];
  memoryBytes: number;
}

/** Group only within the originating pane; each listed process is counted once. */
export function getPaneProcessTrees(processes: readonly PaneLeftoverProcess[]): PaneLeftoverTree[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const children = new Map<number, PaneLeftoverProcess[]>();
  const roots: PaneLeftoverProcess[] = [];
  for (const process of processes) {
    const parent = process.parentPid === null ? undefined : byPid.get(process.parentPid);
    if (parent && parent.paneSessionId === process.paneSessionId) {
      const siblings = children.get(parent.pid) ?? [];
      siblings.push(process);
      children.set(parent.pid, siblings);
    } else {
      roots.push(process);
    }
  }
  const seen = new Set<number>();
  const trees: PaneLeftoverTree[] = [];
  const addTree = (root: PaneLeftoverProcess): void => {
    if (seen.has(root.pid)) return;
    seen.add(root.pid);
    const descendants: PaneLeftoverProcess[] = [];
    const pending = [root];
    let memoryBytes = root.memoryBytes;
    for (let offset = 0; offset < pending.length; offset += 1) {
      for (const child of children.get(pending[offset].pid) ?? []) {
        if (!seen.has(child.pid)) {
          seen.add(child.pid);
          descendants.push(child);
          pending.push(child);
          memoryBytes += child.memoryBytes;
        }
      }
    }
    trees.push({ root, descendants, memoryBytes });
  };
  for (const root of roots) addTree(root);
  // A cycle has no natural root: keep one visible row for its entire component.
  for (const process of processes) {
    if (seen.has(process.pid)) continue;
    let root = process;
    const path = new Set<number>();
    while (!path.has(root.pid)) {
      path.add(root.pid);
      const parent = root.parentPid === null ? undefined : byPid.get(root.parentPid);
      if (!parent || parent.paneSessionId !== root.paneSessionId || seen.has(parent.pid)) break;
      root = parent;
    }
    addTree(root);
  }
  return trees;
}

export interface PaneLeftoverGroup {
  paneSessionId: string;
  title: string;
  closed: boolean;
  processes: PaneLeftoverProcess[];
}

export function groupPaneLeftovers(
  processes: readonly PaneLeftoverProcess[],
  workspaces: readonly Workspace[],
  closedPanes: readonly ClosedPaneEntry[],
): PaneLeftoverGroup[] {
  const openPanes = new Map(workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) =>
    pane.tabs.map((tab) => [tab.sessionId, { tab, workspaceName: workspace.name }] as const),
  )));
  const byPane = new Map<string, PaneLeftoverProcess[]>();
  for (const process of processes) {
    const group = byPane.get(process.paneSessionId) ?? [];
    group.push(process);
    byPane.set(process.paneSessionId, group);
  }
  const groups = [...byPane].map(([paneSessionId, processes]): PaneLeftoverGroup => {
    const openPane = openPanes.get(paneSessionId);
    const running = processes.some((process) => process.paneRunning);
    const closedPane = [...closedPanes].reverse().find((entry) => entry.paneSessionId === paneSessionId);
    const label = closedPane?.label || closedPane?.displayName || closedPaneLabels.get(paneSessionId)
      || (closedPane ? "名前のないペイン" : undefined);
    return {
      paneSessionId,
      title: openPane
        ? `ペイン「${getTabDisplayLabel(openPane.tab)}」(${openPane.workspaceName}) から切り離されたもの`
        : running
          ? `動いているペイン (ID ${paneSessionId.slice(0, 8)}) から切り離されたもの`
          : label
            ? `閉じたペイン「${label}」から残っているもの`
            : `閉じたペイン (ID ${paneSessionId.slice(0, 8)}) から残っているもの`,
      closed: !openPane && !running,
      processes,
    };
  });
  return groups.sort((a, b) => Number(b.closed) - Number(a.closed) || a.title.localeCompare(b.title, "ja"));
}

export function formatProcessStartedAt(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

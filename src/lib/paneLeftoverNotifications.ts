import { isTauri } from "@tauri-apps/api/core";
import { useToastStore } from "../stores/toastStore";
import { __resetPaneLeftoverLabelsForTests, getPaneProcessTrees, listPaneLeftoverProcesses, rememberClosedPaneLabel } from "./paneLeftovers";

export interface ClosedPaneProcessTarget {
  paneSessionId: string;
  label: string;
}

const pending = new Map<string, string>();
let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

async function checkClosedPanes(): Promise<void> {
  const batch = new Map(pending);
  pending.clear();
  timer = undefined;
  try {
    const processes = (await listPaneLeftoverProcesses()).filter((process) => batch.has(process.paneSessionId));
    const trees = getPaneProcessTrees(processes);
    if (trees.length === 0) return;
    const affected = new Set(trees.map((tree) => tree.root.paneSessionId));
    const label = batch.get(trees[0].root.paneSessionId);
    const message = affected.size === 1
      ? `閉じたペイン「${label}」から起動されたプロセスが ${trees.length} 件動いています`
      : `閉じたペインから起動されたプロセスが ${trees.length} 件動いています`;
    useToastStore.getState().pushToast(message, "warning", {
      label: "ペイン掃除で確認",
      run: () => {
        // Avoid a closedPaneStore -> socketCommands -> closedPaneStore cycle.
        void import("../components/layout/tabSweep").then(({ openTabSweepInDashboard }) => openTabSweepInDashboard());
      },
    }, undefined, undefined, "user-action");
  } catch (error) {
    console.warn("[mycmux] closed-pane process scan failed", error);
  }
}

/** One on-demand check ten seconds after the first close in each batch. */
export function scheduleClosedPaneLeftoverCheck(targets: readonly ClosedPaneProcessTarget[]): void {
  for (const target of targets) rememberClosedPaneLabel(target.paneSessionId, target.label);
  if (!isTauri()) return;
  for (const target of targets) {
    if (target.paneSessionId) pending.set(target.paneSessionId, target.label);
  }
  if (pending.size > 0 && timer === undefined) {
    timer = globalThis.setTimeout(() => void checkClosedPanes(), 10_000);
  }
}

export function __resetPaneLeftoverNotificationsForTests(): void {
  if (timer !== undefined) globalThis.clearTimeout(timer);
  timer = undefined;
  pending.clear();
  __resetPaneLeftoverLabelsForTests();
}

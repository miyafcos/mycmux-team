import { subscribePtyReads } from "../../lib/ptyReadGeneration";
import { TERMINAL_RECOVERY_COOLDOWN_MS, TERMINAL_RECOVERY_LIMIT, TERMINAL_RECOVERY_WINDOW_MS } from "../../lib/terminalStreamHealth";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";

type WorkspaceList = ReturnType<typeof useWorkspaceListStore.getState>["workspaces"];
const budgets = new Map<string, { attempts: number[]; reported: boolean }>();
let observing = false;

function containsTab(workspaces: WorkspaceList, id: string): boolean {
  return workspaces.some(workspace => workspace.panes.some(pane =>
    pane.sessionId === id || pane.tabs?.some(tab => tab.sessionId === id)));
}

export function admitPaintRepair(id: string, now = performance.now()): {
  state: "admitted" | "cooldown" | "exhausted" | "silent"; attempt: number;
} {
  if (!observing) {
    observing = true;
    useWorkspaceListStore.subscribe((next, previous) => {
      if (next.workspaces === previous.workspaces) return;
      for (const session of budgets.keys()) {
        if (containsTab(previous.workspaces, session) && !containsTab(next.workspaces, session)) budgets.delete(session);
      }
    });
    subscribePtyReads((session, retired) => { if (retired) budgets.delete(session); });
  }
  const budget = budgets.get(id) ?? { attempts: [], reported: false };
  budget.attempts = budget.attempts.filter(at => now - at < TERMINAL_RECOVERY_WINDOW_MS);
  const attempt = budget.attempts.length;
  if (attempt >= TERMINAL_RECOVERY_LIMIT) {
    const state = budget.reported ? "silent" : "exhausted";
    budget.reported = true;
    return { state, attempt };
  }
  if (attempt && now - budget.attempts[attempt - 1] < TERMINAL_RECOVERY_COOLDOWN_MS) return { state: "cooldown", attempt };
  budget.attempts.push(now);
  budget.reported = false;
  budgets.set(id, budget);
  return { state: "admitted", attempt: attempt + 1 };
}

import { isSessionAlive } from "../ipc";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { isMacTearoutPlatform, nativePaneTearoutEnabled } from "./feature";
import { expectTearoutAttachments, hasTearoutSessionAttachment } from "./sessionAttachment";
import { liveTerms } from "../../components/terminal/terminalCache";
import type { Workspace } from "../../types";

// Match the existing terminal-cache bound. Only existing live PTYs may warm;
// neither a new process nor another window's workspace is introduced here.
export const MAC_TEAROUT_PREWARM_LIMIT = 12;
export function macPrewarmCandidates(workspaces: Workspace[], activeId: string | null): string[] {
  const active = workspaces.find(workspace => workspace.id === activeId);
  return [...new Set(active?.panes.flatMap(pane => pane.tabs
    .filter(tab => (tab.type == null || tab.type === "terminal") && tab.sessionId.startsWith("pty-"))
    .map(tab => tab.sessionId)) ?? [])].slice(0, MAC_TEAROUT_PREWARM_LIMIT);
}

export function installMacTearoutPrewarm(busy: () => boolean): () => void {
  if (!isMacTearoutPlatform()) return () => {};
  let stopped = false, revision = 0, warmed = "", queued = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const active = new Set<ReturnType<typeof expectTearoutAttachments>>();
  const enabled = () => nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled);
  const candidates = () => {
    const state = useWorkspaceListStore.getState();
    return macPrewarmCandidates(state.workspaces, state.activeWorkspaceId);
  };
  const run = async (version: number) => {
    if (stopped || !enabled() || busy()) return;
    const ids = candidates();
    const signature = [...ids].sort().join("|");
    if (!signature || signature === warmed || ids.some(hasTearoutSessionAttachment)) return;
    // A timeout is still one completed attempt for this exact candidate set.
    // Store notifications cannot restart a 12-terminal mount storm.
    warmed = signature;
    const alive = await Promise.all(ids.map(isSessionAlive));
    if (stopped || version !== revision || !enabled() || busy()) return;
    const live = ids.filter((id, index) => alive[index] && !liveTerms.has(id));
    if (!live.length || live.some(hasTearoutSessionAttachment)) return;
    const attachment = expectTearoutAttachments(live, "prewarm", id =>
      useWorkspaceListStore.getState().workspaces.some(workspace => workspace.panes
        .some(pane => pane.tabs.some(tab => tab.sessionId === id))));
    active.add(attachment);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        attachment.ready.then(() => true),
        new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 3000); }),
      ]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      active.delete(attachment); attachment.dispose();
    }
  };
  const queue = () => {
    const signature = enabled() ? [...candidates()].sort().join("|") : "";
    if (!stopped && enabled() && (signature === warmed || signature === queued && timer !== null)) return;
    revision++;
    if (timer !== null) clearTimeout(timer);
    timer = null; queued = "";
    for (const attachment of active) attachment.dispose();
    active.clear();
    if (stopped || !enabled()) { warmed = ""; return; }
    queued = signature;
    const version = revision;
    timer = setTimeout(() => {
      timer = null; queued = "";
      void run(version).catch(() => {});
    }, 250);
  };
  const stopWorkspaces = useWorkspaceListStore.subscribe(queue);
  const stopSettings = useSettingsStore.subscribe(queue);
  queue();
  return () => {
    stopped = true; queue(); stopWorkspaces(); stopSettings();
  };
}

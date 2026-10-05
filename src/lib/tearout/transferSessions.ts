import { isSessionAlive, type WorkspaceConfig } from "../ipc";

/** Saved identity is not proof that a PTY has actually been started. */
export function terminalTransferSessions(configs: WorkspaceConfig[]): string[] {
  return [...new Set(configs.flatMap(config => config.panes.flatMap(pane => (pane.tabs ?? [])
    .filter(tab => (tab.type == null || tab.type === "terminal") && tab.session_id?.startsWith("pty-"))
    .map(tab => tab.session_id!))))];
}
export async function liveTransferSessions(configs: WorkspaceConfig[]): Promise<string[]> {
  const candidates = terminalTransferSessions(configs);
  const declared = new Set(configs.flatMap(config => config.panes.flatMap(pane => (pane.tabs ?? [])
    .filter(tab => tab.lifecycle === "declared").map(tab => tab.session_id))));
  const started = candidates.filter(id => !declared.has(id));
  const alive = await Promise.all(started.map(isSessionAlive));
  return started.filter((_, index) => alive[index]);
}

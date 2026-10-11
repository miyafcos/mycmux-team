// Frontend lifetime only; shared by local IPC and native invalidation events.
const revisions = new Map<string, number>();
const activeEpochs = new Map<string, number | null>();
// Confirmation survives a same-epoch reattach, independently of owner revision.
const exitedEpochs = new Map<string, number>();
export const ptyExitConfirmed = (id: string, epoch: number | null | undefined): boolean => epoch != null && exitedEpochs.get(id) === epoch;
export const confirmPtyExit = (id: string, epoch: number): void => { exitedEpochs.set(id, epoch); };
export const codexRestoreNoticeRevision = (id: string): number => revisions.get(id) ?? 0;
export const codexRestoreNoticeEpoch = (id: string): number | null | undefined => activeEpochs.get(id);
export function invalidateCodexRestoreNotice(id: string): void {
  revisions.set(id, codexRestoreNoticeRevision(id) + 1);
  activeEpochs.set(id, null);
}
export function publishCodexRestoreNoticeEpoch(id: string, epoch: number | null): void {
  invalidateCodexRestoreNotice(id);
  activeEpochs.set(id, Number.isSafeInteger(epoch) ? epoch : null);
}
export const codexRestoreNoticeActive = (id: string, epoch: number): boolean => !activeEpochs.has(id) || activeEpochs.get(id) === epoch;

// Preparation does not decide enrollment; native owns restore validation.
export function needsCodexNoticePreparation(command: string, args: string[], env?: Record<string, string>, reason?: string): boolean {
  const leaf = (value: string) => value.replace(/\\/g, "/").split("/").pop()!.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
  return !!reason || env?.MYCMUX_RESUME === "codex" || leaf(command) === "codex"
    || (["node", "bun"].includes(leaf(command)) && !!args[0] && leaf(args[0]) === "codex.js");
}

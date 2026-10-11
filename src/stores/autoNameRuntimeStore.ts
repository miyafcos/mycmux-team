import { create } from "zustand";
import type { AutoNameMeaning } from "../lib/autoNamePolicy";
import type { NamingRecoveryRecord } from "../lib/autoNameRecovery";

/** Ephemeral evidence and recovery undo; no conversation text is persisted here. */
export const useAutoNameRuntimeStore = create<{
  meanings: ReadonlyMap<string, AutoNameMeaning>;
  descriptions: ReadonlyMap<string, string>;
  recovery: NamingRecoveryRecord | null;
  revision: number;
  invalidatedTabs: ReadonlyMap<string, number>;
  invalidatedWorkspaces: ReadonlyMap<string, number>;
}>(() => ({ meanings: new Map(), descriptions: new Map(), recovery: null, revision: 0, invalidatedTabs: new Map(), invalidatedWorkspaces: new Map() }));

const paneHolds = new Map<string, { owner: string; key?: string }>();
const workspaceHolds = new Map<string, string | undefined>();
export function holdRestoredNames(record: NamingRecoveryRecord) {
  const meanings = useAutoNameRuntimeStore.getState().meanings;
  for (const tab of record.beforeTabs) paneHolds.set(tab.id, { owner: tab.namingOwner ?? meanings.get(tab.id)?.binding ?? tab.owner, key: meanings.get(tab.id)?.contentKey });
  for (const workspace of record.beforeWorkspaces) workspaceHolds.set(workspace.id, undefined);
}
export function isPaneNameHeld(id: string, owner: string, key: string) {
  const hold = paneHolds.get(id);
  if (!hold) return false;
  if (hold.owner !== owner || (hold.key !== undefined && hold.key !== key)) { paneHolds.delete(id); return false; }
  hold.key ??= key; return true;
}
export function isWorkspaceNameHeld(id: string, key: string) {
  if (!workspaceHolds.has(id)) return false;
  const hold = workspaceHolds.get(id);
  if (hold !== undefined && hold !== key) { workspaceHolds.delete(id); return false; }
  workspaceHolds.set(id, key); return true;
}
export function clearNamingHolds(workspaceIds: readonly string[], tabIds: readonly string[]) {
  for (const id of workspaceIds) workspaceHolds.delete(id);
  for (const id of tabIds) paneHolds.delete(id);
}

/** Only the explicitly recovered owners lose their stability/cooldown history. */
export function resetNamingPolicies(workspaceIds: readonly string[], tabIds: readonly string[]) {
  useAutoNameRuntimeStore.setState(state => {
    const revision = state.revision + 1;
    const invalidatedTabs = new Map(state.invalidatedTabs), invalidatedWorkspaces = new Map(state.invalidatedWorkspaces);
    for (const id of tabIds) invalidatedTabs.set(id, revision);
    for (const id of workspaceIds) invalidatedWorkspaces.set(id, revision);
    return { revision, invalidatedTabs, invalidatedWorkspaces };
  });
}

/** Closed owners must not accumulate holds or invalidation history over a long session. */
export function pruneNamingRuntime(workspaceIds: ReadonlySet<string>, tabIds: ReadonlySet<string>) {
  for (const id of workspaceHolds.keys()) if (!workspaceIds.has(id)) workspaceHolds.delete(id);
  for (const id of paneHolds.keys()) if (!tabIds.has(id)) paneHolds.delete(id);
  const state = useAutoNameRuntimeStore.getState();
  const invalidatedTabs = new Map([...state.invalidatedTabs].filter(([id]) => tabIds.has(id)));
  const invalidatedWorkspaces = new Map([...state.invalidatedWorkspaces].filter(([id]) => workspaceIds.has(id)));
  if (invalidatedTabs.size !== state.invalidatedTabs.size || invalidatedWorkspaces.size !== state.invalidatedWorkspaces.size) {
    useAutoNameRuntimeStore.setState({ invalidatedTabs, invalidatedWorkspaces });
  }
}

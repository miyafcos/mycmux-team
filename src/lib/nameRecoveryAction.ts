import { confirm } from "./appConfirmation";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { useAutoNameRuntimeStore, clearNamingHolds, holdRestoredNames, resetNamingPolicies } from "../stores/autoNameRuntimeStore";
import { beginNamingRecovery, undoNamingRecovery } from "./autoNameRecovery";
import { createAutoNamePolicy, isAutomaticNameTarget } from "./autoNamePolicy";
import { readAutoNameScan, liveNamingBinding, namingScanStillCurrent } from "./autoNameEvidence";
import { namingBinding } from "./autoNameMaterial";
import { aggregateWorkspaceName } from "./autoWorkspaceNaming";
import { paneRegistry } from "./paneEvidence";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { getTabDisplayLabel } from "./tabDisplayLabel";

let recovering = false;
export type NameRecoveryFeedback = (result: "applied" | "failed" | "undone", undo?: () => void) => void;
export async function recoverNamesFromContent(workspaceId?: string, feedback?: NameRecoveryFeedback): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    const workspace = workspaceId ? useWorkspaceListStore.getState().getWorkspace(workspaceId) : undefined;
    if (workspaceId && !workspace) return;
    const title = workspaceId ? "中身から名前を付け直す" : "自動の名前に戻す (手で付けた名前以外)";
    const accepted = await confirm(`${workspace ? `「${workspace.name}」` : "このウィンドウの全ワークスペース"}の名前とタブの表示名を、現在の作業から付け直します。\n手で付けたタブ名は残ります。出どころが不明なワークスペース名も自動更新の対象になります。\n「名前の付け直しを元に戻す」で、今回の変更を取り消せます。`, { title, okLabel: "付け直す" });
    if (!accepted) return;
    const store = useWorkspaceListStore.getState();
    const { record, patches } = beginNamingRecovery(store.workspaces, workspaceId, liveNamingBinding);
    clearNamingHolds(record.beforeWorkspaces.map(w => w.id), record.beforeTabs.map(t => t.id));
    store.applyNamePatches(patches);
    useAutoNameRuntimeStore.setState({ recovery: record });
    resetNamingPolicies(record.beforeWorkspaces.map(w => w.id), record.beforeTabs.map(t => t.id));
    // This explicit operation also works while either automatic setting is off.
    const scan = await readAutoNameScan();
    if (useAutoNameRuntimeStore.getState().recovery !== record) return;
    const policy = createAutoNamePolicy(Date.now, paneRegistry, undefined,
      tab => getTabDisplayLabel(tab, true, usePaneMetadataStore.getState().metadata, usePaneMetadataStore.getState().volatileMetadata));
    const names = policy.identify(scan); const scanned = new Map(scan.tabs.map(t => [t.id, t]));
    const current = useWorkspaceListStore.getState();
    const tabNames = record.beforeTabs.flatMap(before => {
      const tab = current.workspaces.flatMap(w => w.panes.flatMap(p => p.tabs)).find(t => t.id === before.id);
      const owner = current.workspaces.find(w => w.panes.some(p => p.tabs.some(t => t.id === before.id)));
      const pane = owner?.panes.find(p => p.tabs.some(t => t.id === before.id));
      const input = scanned.get(before.id); const name = names.tabs.get(before.id)?.displayName;
      if (owner?.status === "stopped" || !tab || !input || !name || !isAutomaticNameTarget(tab) || namingBinding(tab) !== before.owner
        || tab.label !== before.label || tab.labelSource !== before.expectedSource || namingBinding(input) !== liveNamingBinding(tab, pane) || !namingScanStillCurrent(scan, input)) return [];
      return [{ id: tab.id, owner: before.owner, label: tab.label, expectedSource: tab.labelSource,
        labelSource: tab.labelSource, displayName: name, displayNameSource: "auto" as const }];
    });
    const meanings = new Map([...policy.meanings()].filter(([id, meaning]) => {
      const pane = current.workspaces.flatMap(w => w.panes).find(p => p.tabs.some(t => t.id === id));
      const tab = pane?.tabs.find(t => t.id === id); const input = scanned.get(id);
      return tab && input && liveNamingBinding(tab, pane) === meaning.binding && namingScanStillCurrent(scan, input);
    }));
    const workspaceNames = record.beforeWorkspaces.flatMap(before => {
      const live = current.workspaces.find(w => w.id === before.id);
      if (!live || live.nameSource !== "auto") return [];
      const summary = aggregateWorkspaceName(live, meanings, liveNamingBinding);
      return summary.name ? [{ id: live.id, expectedName: live.name, expectedSource: "auto" as const, name: summary.name, nameSource: "auto" as const }] : [];
    });
    current.applyNamePatches({ tabs: tabNames, workspaces: workspaceNames });
    for (const before of record.beforeTabs) before.namingOwner = meanings.get(before.id)?.binding ?? before.namingOwner;
    const affected = new Set(record.beforeWorkspaces.map(w => w.id));
    const ids = new Set(current.workspaces.filter(w => affected.has(w.id)).flatMap(w => w.panes.flatMap(p => p.tabs.map(t => t.id))));
    useAutoNameRuntimeStore.setState(state => ({ meanings: new Map([...state.meanings, ...[...meanings].filter(([id]) => ids.has(id))]) }));
    feedback?.("applied", () => undoRecoveredNames(feedback));
  } catch (error) {
    console.warn("[auto-naming] Explicit recovery incomplete", error);
    feedback?.("failed");
  } finally { recovering = false; }
}
export function undoRecoveredNames(feedback?: NameRecoveryFeedback): void {
  const state = useAutoNameRuntimeStore.getState(); if (!state.recovery) return;
  const store = useWorkspaceListStore.getState();
  const patches = undoNamingRecovery(store.workspaces, state.recovery);
  holdRestoredNames(state.recovery);
  store.applyNamePatches(patches);
  useAutoNameRuntimeStore.setState({ recovery: null });
  resetNamingPolicies(patches.workspaces.map(w => w.id), patches.tabs.map(t => t.id));
  feedback?.("undone");
}

import { useSettingsStore } from "../stores/settingsStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { useLauncherDirsStore } from "../stores/launcherDirsStore";
import type { Workspace } from "../types";
import type { GroupingScan } from "../components/layout/tabGrouping";
import { readEvidenceScan, identitiesForScan, TITLE_REFRESH_MS } from "./paneEvidence";
import type { PaneIdentityResult } from "./paneIdentity";

export const AUTO_PANE_NAMING_DEBOUNCE_MS = 350;
export const AUTO_PANE_NAMING_INTERVAL_MS = TITLE_REFRESH_MS;
export interface AutoPaneNamingDependencies {
  enabled: () => boolean;
  scan: () => Promise<GroupingScan>;
  identify: (scan: GroupingScan) => PaneIdentityResult;
  workspaces: () => Workspace[];
  subscribe: (listener: () => void) => () => void;
  setDisplayName: (workspaceId: string, paneId: string, tabId: string, name: string | undefined) => void;
  setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval; clearInterval: typeof clearInterval;
}
export function buildAutoPaneNamingSignature(tab: {
  id: string; cwd?: string; label?: string; labelSource?: string; agentKind?: string;
  agentSessionId?: string; sessionTitle?: string | null; taskTitle?: string | null;
}): string {
  return JSON.stringify([tab.id, tab.cwd, tab.label, tab.labelSource, tab.agentKind,
    tab.agentSessionId, tab.sessionTitle, tab.taskTitle]);
}
function materialSignature(workspaces: Workspace[]): string {
  return JSON.stringify(workspaces.map(w => [w.id, w.name, w.panes.map(p => [p.id, p.tabs.map(t =>
    [buildAutoPaneNamingSignature(t), t.sessionId, t.origin, t.lifecycle])])]));
}
function metadataMaterialSignature(metadata: ReturnType<typeof usePaneMetadataStore.getState>["metadata"]): string {
  return JSON.stringify(Object.entries(metadata).map(([id, m]) => [id, m.cwd, m.agentKind, m.agentSessionId, m.claudeSessionId]));
}
function defaultDependencies(): AutoPaneNamingDependencies {
  return {
    enabled: () => useSettingsStore.getState().autoPaneNamingEnabled,
    scan: readEvidenceScan, identify: identitiesForScan,
    workspaces: () => useWorkspaceListStore.getState().workspaces,
    setDisplayName: (w, p, t, name) => useWorkspaceLayoutStore.getState().setTabDisplayName(w, p, t, name),
    subscribe: listener => {
      let signature = materialSignature(useWorkspaceListStore.getState().workspaces);
      let metadataSignature = metadataMaterialSignature(usePaneMetadataStore.getState().metadata);
      const unsubscribers = [
        // Both stores change far more often than the naming material does (focus, output
        // heartbeats); skip the signature work unless the watched slice was replaced.
        useWorkspaceListStore.subscribe((state, previous) => {
          if (state.workspaces === previous.workspaces) return;
          const next = materialSignature(state.workspaces);
          if (next !== signature) { signature = next; listener(); }
        }),
        useSettingsStore.subscribe((state, previous) => { if (state.autoPaneNamingEnabled !== previous.autoPaneNamingEnabled) listener(); }),
        useLauncherDirsStore.subscribe((state, previous) => { if (state.view !== previous.view) listener(); }),
        usePaneMetadataStore.subscribe((state, previous) => {
          if (state.metadata === previous.metadata) return;
          const next = metadataMaterialSignature(state.metadata);
          if (next !== metadataSignature) { metadataSignature = next; listener(); }
        }),
      ];
      return () => unsubscribers.forEach(unsubscribe => unsubscribe());
    },
    // The scheduler calls these as `deps.setInterval(...)`. A browser's timer functions throw
    // "Illegal invocation" when `this` is not the window, which took down the whole app at
    // startup in WebView2 (v0.80.1), so each one is bound to the global object here.
    setTimeout: globalThis.setTimeout.bind(globalThis) as typeof setTimeout,
    clearTimeout: globalThis.clearTimeout.bind(globalThis) as typeof clearTimeout,
    setInterval: globalThis.setInterval.bind(globalThis) as typeof setInterval,
    clearInterval: globalThis.clearInterval.bind(globalThis) as typeof clearInterval,
  };
}
export interface AutoPaneNamingScheduler { start: () => void; stop: () => void; runNow: () => Promise<void>; readonly running: boolean }
export function createAutoPaneNamingScheduler(deps: AutoPaneNamingDependencies = defaultDependencies()): AutoPaneNamingScheduler {
  let started = false; let running = false; let epoch = 0; let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  const clearAutomaticNames = () => {
    for (const workspace of deps.workspaces()) for (const pane of workspace.panes) for (const tab of pane.tabs) {
      if (tab.displayNameSource === "auto" && tab.displayName !== undefined) deps.setDisplayName(workspace.id, pane.id, tab.id, undefined);
    }
  };
  const schedule = () => {
    epoch++; dirty = true;
    if (timer !== undefined) deps.clearTimeout(timer);
    timer = undefined;
    if (!started) return;
    // Switching the setting off takes the automatic names away, so each pane shows its own
    // label again instead of a name that no longer follows its material.
    if (!deps.enabled()) { dirty = false; clearAutomaticNames(); return; }
    timer = deps.setTimeout(() => { timer = undefined; void execute(); }, AUTO_PANE_NAMING_DEBOUNCE_MS);
  };
  async function execute() {
    if (!started || !deps.enabled() || running) return;
    running = true; dirty = false;
    const token = epoch;
    try {
      const scan = await deps.scan();
      if (!started || !deps.enabled() || token !== epoch) return;
      const identities = deps.identify(scan);
      const scanned = new Map(scan.tabs.map(t => [t.id, t]));
      for (const workspace of deps.workspaces()) for (const pane of workspace.panes) for (const tab of pane.tabs) {
        const evidence = scanned.get(tab.id); const identity = identities.tabs.get(tab.id);
        if (!evidence || !identity || evidence.sessionId !== tab.sessionId || evidence.label !== (tab.label ?? "")
          || evidence.workspaceId !== workspace.id || evidence.paneId !== pane.id) continue;
        // No material means leave the visible name unchanged.
        if (identity.displayName !== null && tab.displayName !== identity.displayName)
          deps.setDisplayName(workspace.id, pane.id, tab.id, identity.displayName);
      }
    } catch (error) { console.warn("[auto-pane-naming] Evidence unavailable", error); }
    finally { running = false; if (dirty && started && deps.enabled()) schedule(); }
  }
  // The store listeners run inside whatever changed the store. A naming fault is logged here
  // instead of reaching that change and stopping it half-way (v0.80.1-v0.80.2).
  const scheduleFromListener = () => {
    try { schedule(); } catch (error) { console.error("[mycmux] auto pane naming listener threw; the change that woke it still went through", error); }
  };
  function start() {
    if (started) return; started = true; unsubscribe = deps.subscribe(scheduleFromListener);
    interval = deps.setInterval(() => { void execute(); }, AUTO_PANE_NAMING_INTERVAL_MS);
    schedule();
  }
  return { start, stop: () => {
    started = false; epoch++; unsubscribe?.(); unsubscribe = undefined;
    if (timer !== undefined) deps.clearTimeout(timer);
    if (interval !== undefined) deps.clearInterval(interval);
    timer = undefined; interval = undefined;
  }, runNow: async () => { start(); await execute(); }, get running() { return running; } };
}
const scheduler = createAutoPaneNamingScheduler();
export const startAutoPaneNaming = () => scheduler.start();
export const stopAutoPaneNaming = () => scheduler.stop();

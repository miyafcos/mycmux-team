import { invoke } from "@tauri-apps/api/core";

import {
  buildNamingPrompt,
  parseNamingOutput,
  scanNamingContext,
  type NamingPaneGroup,
  type NamingTab,
} from "../components/layout/tabSweep";
import { autoPaneNamingStrings } from "../components/settings/settingsStrings";
import { useAiSettingsStore } from "../stores/aiSettingsStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useToastStore, TOAST_UNDO_DISMISS_MS, type ToastAction } from "../stores/toastStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import type { PaneTab, Workspace } from "../types";

export const AUTO_PANE_NAMING_DEBOUNCE_MS = 90_000;
export const AUTO_PANE_NAMING_INTERVAL_MS = 15 * 60_000;

type LabelSource = PaneTab["labelSource"];

export interface AutoPaneNamingSettings {
  aiEnabled: boolean;
  autoPaneNamingEnabled: boolean;
}

export interface AutoPaneNamingWorkspaceState {
  activeWorkspaceId: string | null;
  workspaces: Workspace[];
}

interface AutoPaneNamingTimerDependencies {
  setTimeout: (handler: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  setInterval: (handler: () => void, timeoutMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
}

export interface AutoPaneNamingDependencies extends AutoPaneNamingTimerDependencies {
  settings: () => AutoPaneNamingSettings;
  scanNamingContext: () => Promise<NamingPaneGroup[]>;
  invokeJudge: (prompt: string, requestId: string) => Promise<string>;
  abortJudge: (requestId: string) => Promise<unknown>;
  getWorkspaceState: () => AutoPaneNamingWorkspaceState;
  subscribeWorkspace: (listener: () => void) => () => void;
  subscribeAutoPaneNamingEnabled: (listener: (enabled: boolean, previous: boolean) => void) => () => void;
  subscribeAiEnabled: (listener: (enabled: boolean, previous: boolean) => void) => () => void;
  setTabLabel: (
    workspaceId: string,
    paneId: string,
    tabId: string,
    label: string | undefined,
    source: "user" | "ai",
  ) => void;
  pushToast: (message: string, kind: "info" | "error", actions?: ToastAction[], durationMs?: number) => void;
  requestId: () => string;
  getVisibility: () => DocumentVisibilityState | "visible";
}

interface ObservedLabelState {
  label: string;
  labelSource?: LabelSource;
}

interface NamingTarget {
  group: NamingPaneGroup;
  tab: NamingTab;
  signature: string;
}

interface AppliedLabel {
  workspaceId: string;
  paneId: string;
  tabId: string;
  label: string | undefined;
  labelSource?: LabelSource;
}

function defaultRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `auto-pane-naming-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function hashText(value: string): string {
  // FNV-1a is enough here: this is a local change detector, not a security
  // boundary, and keeping it deterministic avoids a crypto dependency in the
  // scheduler and its unit tests.
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildAutoPaneNamingSignature(tab: NamingTab): string {
  const tail = tab.tail.slice(-14).join("\n");
  return [tab.id, tab.cwd, tab.agentKind, hashText(tail)].join("\u001f");
}

function isAutoNamingCandidate(tab: NamingTab): boolean {
  return tab.label.trim().length === 0 || tab.labelSource === "ai";
}

function isTerminalTab(tab: PaneTab): boolean {
  return tab.type === undefined || tab.type === "terminal";
}

function tabLabelState(workspaces: readonly Workspace[]): Map<string, ObservedLabelState> {
  const result = new Map<string, ObservedLabelState>();
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs) {
        result.set(tab.id, { label: tab.label ?? "", labelSource: tab.labelSource });
      }
    }
  }
  return result;
}

function defaultDependencies(): AutoPaneNamingDependencies {
  return {
    settings: () => ({
      aiEnabled: useAiSettingsStore.getState().aiEnabled,
      autoPaneNamingEnabled: useSettingsStore.getState().autoPaneNamingEnabled,
    }),
    scanNamingContext,
    invokeJudge: (prompt, requestId) => invoke<string>("run_tab_sweep_judge", {
      prompt,
      requestId,
      mode: "naming",
    }),
    abortJudge: (requestId) => invoke<boolean>("abort_tab_sweep_judge", { requestId }),
    getWorkspaceState: () => {
      const state = useWorkspaceListStore.getState();
      return {
        activeWorkspaceId: state.activeWorkspaceId,
        workspaces: state.workspaces,
      };
    },
    subscribeWorkspace: (listener) => useWorkspaceListStore.subscribe(listener),
    subscribeAutoPaneNamingEnabled: (listener) => useSettingsStore.subscribe((state, previous) => {
      if (state.autoPaneNamingEnabled !== previous.autoPaneNamingEnabled) {
        listener(state.autoPaneNamingEnabled, previous.autoPaneNamingEnabled);
      }
    }),
    subscribeAiEnabled: (listener) => useAiSettingsStore.subscribe((state, previous) => {
      if (state.aiEnabled !== previous.aiEnabled) listener(state.aiEnabled, previous.aiEnabled);
    }),
    setTabLabel: (workspaceId, paneId, tabId, label, source) => {
      useWorkspaceLayoutStore.getState().setTabLabel(workspaceId, paneId, tabId, label, source);
    },
    pushToast: (message, kind, actions, durationMs) => {
      useToastStore.getState().pushToast(message, kind, undefined, actions, durationMs);
    },
    requestId: defaultRequestId,
    getVisibility: () => (typeof document === "undefined" ? "visible" : document.visibilityState),
    setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
    clearTimeout: (timer) => clearTimeout(timer),
    setInterval: (handler, timeoutMs) => setInterval(handler, timeoutMs),
    clearInterval: (timer) => clearInterval(timer),
  };
}

export interface AutoPaneNamingScheduler {
  start: () => void;
  stop: () => void;
  runNow: () => Promise<void>;
  get running(): boolean;
}

export function createAutoPaneNamingScheduler(
  dependencies: AutoPaneNamingDependencies = defaultDependencies(),
): AutoPaneNamingScheduler {
  let started = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let runningToken: number | null = null;
  let nextRunToken = 0;
  let activeRequest: { requestId: string; token: number } | null = null;
  let unsubscribeWorkspace: (() => void) | null = null;
  let unsubscribeSettings: (() => void) | null = null;
  let unsubscribeAiSettings: (() => void) | null = null;
  let observedLabels = new Map<string, ObservedLabelState>();
  const lastSignatures = new Map<string, string>();

  const enabled = (): boolean => {
    const settings = dependencies.settings();
    return settings.aiEnabled && settings.autoPaneNamingEnabled;
  };

  const clearDebounce = (): void => {
    if (debounceTimer === null) return;
    dependencies.clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  const cancelActiveRequest = (): void => {
    nextRunToken += 1;
    runningToken = null;
    const request = activeRequest;
    activeRequest = null;
    if (request) {
      void Promise.resolve(dependencies.abortJudge(request.requestId)).catch(() => {});
    }
  };

  const stopRuntime = (): void => {
    clearDebounce();
    if (intervalTimer !== null) {
      dependencies.clearInterval(intervalTimer);
      intervalTimer = null;
    }
    cancelActiveRequest();
  };

  const syncObservedLabels = (): void => {
    const current = tabLabelState(dependencies.getWorkspaceState().workspaces);
    for (const [tabId, state] of current) {
      const previous = observedLabels.get(tabId);
      const isHumanLabel = state.label.trim().length > 0 && state.labelSource !== "ai";
      const wasNamedAndReset = state.label.trim().length === 0 && Boolean(previous?.label.trim());
      const isNewTab = !previous;
      if (isNewTab || isHumanLabel || wasNamedAndReset) {
        lastSignatures.delete(tabId);
      }
    }
    for (const tabId of lastSignatures.keys()) {
      if (!current.has(tabId)) lastSignatures.delete(tabId);
    }
    observedLabels = current;
  };

  const scheduleDebounced = (): void => {
    if (!started || !enabled()) return;
    clearDebounce();
    debounceTimer = dependencies.setTimeout(() => {
      debounceTimer = null;
      void execute();
    }, AUTO_PANE_NAMING_DEBOUNCE_MS);
  };

  const isCurrentRun = (token: number): boolean => (
    started && runningToken === token && enabled()
  );

  const currentTabLocation = (
    tabId: string,
  ): { workspaceId: string; paneId: string; tab: PaneTab } | null => {
    const state = dependencies.getWorkspaceState();
    const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId);
    if (!workspace) return null;
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((item) => item.id === tabId);
      if (tab) return { workspaceId: workspace.id, paneId: pane.id, tab };
    }
    return null;
  };

  async function execute(): Promise<void> {
    if (!started || !enabled() || runningToken !== null) return;
    const token = ++nextRunToken;
    runningToken = token;
    try {
      const groups = await dependencies.scanNamingContext();
      if (!isCurrentRun(token)) return;

      syncObservedLabels();
      const liveTabs = groups.flatMap((group) => group.tabs);
      const liveIds = new Set(liveTabs.map((tab) => tab.id));
      for (const tabId of lastSignatures.keys()) {
        if (!liveIds.has(tabId)) lastSignatures.delete(tabId);
      }
      for (const tab of liveTabs) {
        if (!isAutoNamingCandidate(tab)) lastSignatures.delete(tab.id);
      }

      const targets: NamingTarget[] = [];
      for (const group of groups) {
        for (const tab of group.tabs) {
          if (!isAutoNamingCandidate(tab)) continue;
          const signature = buildAutoPaneNamingSignature(tab);
          if (lastSignatures.get(tab.id) === signature) continue;
          targets.push({ group, tab, signature });
        }
      }
      if (targets.length === 0) return;

      const targetIds = new Set(targets.map((target) => target.tab.id));
      const targetGroups = groups
        .map((group) => ({
          ...group,
          tabs: group.tabs.filter((tab) => targetIds.has(tab.id)),
        }))
        .filter((group) => group.tabs.length > 0);
      if (targetGroups.length === 0) return;

      const requestId = dependencies.requestId();
      activeRequest = { requestId, token };
      const raw = await dependencies.invokeJudge(buildNamingPrompt(targetGroups), requestId);
      if (!isCurrentRun(token) || activeRequest?.requestId !== requestId) return;
      activeRequest = null;

      const parsed = parseNamingOutput(raw, targetIds);
      if (!parsed.valid) return;
      const targetById = new Map(targets.map((target) => [target.tab.id, target]));
      const applied: AppliedLabel[] = [];
      for (const proposal of parsed.proposals) {
        const target = targetById.get(proposal.id);
        if (!target) continue;
        const location = currentTabLocation(proposal.id);
        if (!location || !isTerminalTab(location.tab)) continue;
        // Re-read the live label before applying. A human rename made while the
        // CLI was running is authoritative and must never be overwritten.
        if (location.tab.label?.trim() && location.tab.labelSource !== "ai") continue;
        const previous: AppliedLabel = {
          workspaceId: location.workspaceId,
          paneId: location.paneId,
          tabId: location.tab.id,
          label: location.tab.label,
          labelSource: location.tab.labelSource,
        };
        dependencies.setTabLabel(location.workspaceId, location.paneId, location.tab.id, proposal.label, "ai");
        applied.push(previous);
        lastSignatures.set(target.tab.id, target.signature);
      }

      if (applied.length === 0) return;
      const undo: ToastAction = {
        label: autoPaneNamingStrings.toastUndo,
        run: () => {
          for (const item of applied) {
            dependencies.setTabLabel(
              item.workspaceId,
              item.paneId,
              item.tabId,
              item.label,
              item.labelSource === "ai" ? "ai" : "user",
            );
          }
          dependencies.pushToast(autoPaneNamingStrings.toastUndone, "info");
        },
      };
      dependencies.pushToast(
        autoPaneNamingStrings.toastApplied(applied.length),
        "info",
        [undo],
        TOAST_UNDO_DISMISS_MS,
      );
    } catch (error) {
      if (isCurrentRun(token)) {
        console.warn("[auto-pane-naming] Naming run failed", error);
      }
    } finally {
      if (runningToken === token) runningToken = null;
      if (activeRequest?.token === token) activeRequest = null;
    }
  }

  const startInterval = (): void => {
    if (intervalTimer !== null) dependencies.clearInterval(intervalTimer);
    intervalTimer = null;
    if (!started || !enabled()) return;
    intervalTimer = dependencies.setInterval(() => {
      if (dependencies.getVisibility() !== "visible") return;
      void execute();
    }, AUTO_PANE_NAMING_INTERVAL_MS);
  };

  const handleSettingsChange = (): void => {
    if (!started) return;
    if (!enabled()) {
      stopRuntime();
      return;
    }
    syncObservedLabels();
    startInterval();
    scheduleDebounced();
  };

  const start = (): void => {
    if (started) return;
    started = true;
    syncObservedLabels();
    unsubscribeWorkspace = dependencies.subscribeWorkspace(() => {
      syncObservedLabels();
      scheduleDebounced();
    });
    unsubscribeSettings = dependencies.subscribeAutoPaneNamingEnabled(() => handleSettingsChange());
    unsubscribeAiSettings = dependencies.subscribeAiEnabled(() => handleSettingsChange());
    if (!enabled()) {
      stopRuntime();
      return;
    }
    startInterval();
    scheduleDebounced();
  };

  const stop = (): void => {
    if (!started) return;
    started = false;
    stopRuntime();
    unsubscribeWorkspace?.();
    unsubscribeSettings?.();
    unsubscribeAiSettings?.();
    unsubscribeWorkspace = null;
    unsubscribeSettings = null;
    unsubscribeAiSettings = null;
    observedLabels = new Map();
    lastSignatures.clear();
  };

  return {
    start,
    stop,
    runNow: async () => {
      if (!started) start();
      await execute();
    },
    get running() {
      return runningToken !== null;
    },
  };
}

const defaultScheduler = createAutoPaneNamingScheduler();

export function startAutoPaneNaming(): void {
  defaultScheduler.start();
}

export function stopAutoPaneNaming(): void {
  defaultScheduler.stop();
}

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  migratePersistedSettings,
  resolveDefaultTerminalRenderer,
  SETTINGS_STORE_VERSION,
  type TerminalRenderer,
} from "./settingsMigration";
import { useAiSettingsStore } from "./aiSettingsStore";

export interface LegacyAiFeatureSettings {
  autoPaneNamingEnabled?: boolean;
  replyDraftSuggestionsEnabled?: boolean;
}

export function parseLegacyAiFeatureSettings(raw: string | null): LegacyAiFeatureSettings {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { state?: unknown };
    if (parsed.state === null || typeof parsed.state !== "object" || Array.isArray(parsed.state)) {
      return {};
    }
    const state = parsed.state as Record<string, unknown>;
    if (state.aiFeatureSettingsDataJsonMigrationComplete === true) return {};
    const legacy: LegacyAiFeatureSettings = {};
    if (
      Object.prototype.hasOwnProperty.call(state, "autoPaneNamingEnabled")
      && typeof state.autoPaneNamingEnabled === "boolean"
    ) {
      legacy.autoPaneNamingEnabled = state.autoPaneNamingEnabled;
    }
    if (
      Object.prototype.hasOwnProperty.call(state, "replyDraftSuggestionsEnabled")
      && typeof state.replyDraftSuggestionsEnabled === "boolean"
    ) {
      legacy.replyDraftSuggestionsEnabled = state.replyDraftSuggestionsEnabled;
    }
    return legacy;
  } catch {
    return {};
  }
}

export function readLegacyAiFeatureSettings(): LegacyAiFeatureSettings {
  if (typeof localStorage === "undefined") return {};
  try {
    return parseLegacyAiFeatureSettings(localStorage.getItem("mycmux-settings"));
  } catch {
    return {};
  }
}

interface SettingsState {
  notificationsEnabled: boolean;
  notificationSoundEnabled: boolean;
  toastAiActivityEnabled: boolean;
  toastUserActionEnabled: boolean;
  toastSystemEnabled: boolean;
  terminalRenderer: TerminalRenderer;
  colorAdaptCommands: string[];
  // CRSM Palette per-kind visibility (Ctrl+P session list).
  // When false the corresponding kind disappears from both the palette
  // list and the filter chips. Defaults true so existing users see no
  // change after upgrade.
  crsmShowClaude: boolean;
  crsmShowCodex: boolean;
  crsmShowClaudeCodex: boolean;
  hideSessionsWithoutUserMessages: boolean;
  // Pane tab bar "Split down" (add a row) button. Defaults false —
  // column splits are the common flow and the row-split button was
  // mostly a misclick target.
  showSplitDownButton: boolean;
  // Pane tab bar "Split right" (add a column) button. Defaults true —
  // column splits are the primary flow, but the button is toggleable
  // for symmetry with the split-down button.
  showSplitRightButton: boolean;
  /**
   * Launcher rows the operator has switched off. Values are catalog targets
   * ("claude", "web-gemini") and the section keys "dev" / "anken" / "resume".
   * Hiding only, never removing: a built-in comes back by unchecking it, and
   * an id that no longer exists is ignored rather than breaking the list.
   */
  launcherHiddenIds: string[];
  /** Diagram-flight animation shown before a grouping layout commit. */
  groupingApplyAnimationEnabled: boolean;
  dispatchWatchdogEnabled: boolean;
  dispatchWatchdogIntervalMinutes: number;
  dispatchStallMinutes: number;
  dispatchWatchdogNotify: boolean;
  paneComposerEnabled: boolean;
  /** Deliberately off until an operator explicitly enables declared-tab launch. */
  declaredLaunchEnabled: boolean;
  /** AI-generated next-action drafts are opt-in; machine suggestions stay available. */
  replyDraftSuggestionsEnabled: boolean;
  /** Automatic AI naming only touches unnamed or AI-named tabs. */
  autoPaneNamingEnabled: boolean;
  /** Provenance marker: compatibility booleans below are no longer legacy input. */
  aiFeatureSettingsDataJsonMigrationComplete: boolean;
  appearanceAdvancedOpen: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  setNotificationSoundEnabled: (v: boolean) => void;
  setToastAiActivityEnabled: (v: boolean) => void;
  setToastUserActionEnabled: (v: boolean) => void;
  setToastSystemEnabled: (v: boolean) => void;
  setTerminalRenderer: (v: TerminalRenderer) => void;
  setColorAdaptCommands: (v: string[]) => void;
  setCrsmShowClaude: (v: boolean) => void;
  setCrsmShowCodex: (v: boolean) => void;
  setCrsmShowClaudeCodex: (v: boolean) => void;
  setHideSessionsWithoutUserMessages: (v: boolean) => void;
  setShowSplitDownButton: (v: boolean) => void;
  setShowSplitRightButton: (v: boolean) => void;
  setLauncherHiddenIds: (v: string[]) => void;
  setGroupingApplyAnimationEnabled: (v: boolean) => void;
  setDispatchWatchdogEnabled: (v: boolean) => void;
  setDispatchWatchdogIntervalMinutes: (v: number) => void;
  setDispatchStallMinutes: (v: number) => void;
  setDispatchWatchdogNotify: (v: boolean) => void;
  setPaneComposerEnabled: (v: boolean) => void;
  setDeclaredLaunchEnabled: (v: boolean) => void;
  setReplyDraftSuggestionsEnabled: (v: boolean) => void;
  setAutoPaneNamingEnabled: (v: boolean) => void;
  setAppearanceAdvancedOpen: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      notificationsEnabled: true,
      notificationSoundEnabled: true,
      // Off by default: the auto-naming and auto-sweep runs announce results
      // that are already visible on screen, and the owner asked for the quiet
      // default (2026-08-28). The setting stays, so it can be turned back on.
      toastAiActivityEnabled: false,
      toastUserActionEnabled: true,
      toastSystemEnabled: true,
      terminalRenderer: resolveDefaultTerminalRenderer(),
      colorAdaptCommands: ["agy"],
      crsmShowClaude: true,
      crsmShowCodex: true,
      crsmShowClaudeCodex: true,
      hideSessionsWithoutUserMessages: true,
      showSplitDownButton: false,
      showSplitRightButton: true,
      launcherHiddenIds: [],
      groupingApplyAnimationEnabled: true,
      dispatchWatchdogEnabled: true,
      dispatchWatchdogIntervalMinutes: 10,
      dispatchStallMinutes: 45,
      dispatchWatchdogNotify: true,
      paneComposerEnabled: true,
      declaredLaunchEnabled: false,
      replyDraftSuggestionsEnabled: false,
      autoPaneNamingEnabled: true,
      aiFeatureSettingsDataJsonMigrationComplete: false,
      appearanceAdvancedOpen: false,
      setNotificationsEnabled: (v) => set({ notificationsEnabled: v }),
      setNotificationSoundEnabled: (v) => set({ notificationSoundEnabled: v }),
      setToastAiActivityEnabled: (v) => set({ toastAiActivityEnabled: v }),
      setToastUserActionEnabled: (v) => set({ toastUserActionEnabled: v }),
      setToastSystemEnabled: (v) => set({ toastSystemEnabled: v }),
      setTerminalRenderer: (v) => set({ terminalRenderer: v }),
      setColorAdaptCommands: (v) => set({ colorAdaptCommands: v }),
      setCrsmShowClaude: (v) => set({ crsmShowClaude: v }),
      setCrsmShowCodex: (v) => set({ crsmShowCodex: v }),
      setCrsmShowClaudeCodex: (v) => set({ crsmShowClaudeCodex: v }),
      setHideSessionsWithoutUserMessages: (v) => set({ hideSessionsWithoutUserMessages: v }),
      setShowSplitDownButton: (v) => set({ showSplitDownButton: v }),
      setShowSplitRightButton: (v) => set({ showSplitRightButton: v }),
      setLauncherHiddenIds: (v) => set({ launcherHiddenIds: v }),
      setGroupingApplyAnimationEnabled: (v) => set({ groupingApplyAnimationEnabled: v }),
      setDispatchWatchdogEnabled: (v) => set({ dispatchWatchdogEnabled: v }),
      setDispatchWatchdogIntervalMinutes: (v) => set({ dispatchWatchdogIntervalMinutes: v }),
      setDispatchStallMinutes: (v) => set({ dispatchStallMinutes: v }),
      setDispatchWatchdogNotify: (v) => set({ dispatchWatchdogNotify: v }),
      setPaneComposerEnabled: (v) => set({ paneComposerEnabled: v }),
      setDeclaredLaunchEnabled: (v) => set({ declaredLaunchEnabled: v }),
      setReplyDraftSuggestionsEnabled: (v) => {
        useAiSettingsStore.getState().setPersistedReplyDraftSuggestionsEnabled(v);
        set({ replyDraftSuggestionsEnabled: v });
      },
      setAutoPaneNamingEnabled: (v) => {
        useAiSettingsStore.getState().setPersistedAutoPaneNamingEnabled(v);
        set({ autoPaneNamingEnabled: v });
      },
      setAppearanceAdvancedOpen: (v) => set({ appearanceAdvancedOpen: v }),
    }),
    {
      name: "mycmux-settings",
      version: SETTINGS_STORE_VERSION,
      migrate: (persistedState, persistedVersion) => (
        migratePersistedSettings(persistedState, persistedVersion) as SettingsState
      ),
    },
  ),
);

export function markAiFeatureSettingsDataJsonMigrationComplete(): void {
  useSettingsStore.setState({ aiFeatureSettingsDataJsonMigrationComplete: true });
}

import { create } from "zustand";
import {
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  modelForProviderSwitch,
  normalizeAiModel,
  normalizeAiProvider,
  type AiProviderId,
} from "../lib/aiModels";

// Which CLI the background AI features run on. Persisted in data.json because
// the Rust consumers resolve this setting before launching a provider CLI.

export const DEFAULT_AUTO_PANE_NAMING_ENABLED = true;
export const DEFAULT_REPLY_DRAFT_SUGGESTIONS_ENABLED = false;

export interface DataJsonAiFeatureSettings {
  autoPaneNamingEnabled: boolean | null | undefined;
  replyDraftSuggestionsEnabled: boolean | null | undefined;
}

export interface EffectiveDataJsonAiFeatureSettings {
  autoPaneNamingEnabled: boolean;
  replyDraftSuggestionsEnabled: boolean;
  persistedAutoPaneNamingEnabled: boolean | null;
  persistedReplyDraftSuggestionsEnabled: boolean | null;
  migrationNeeded: boolean;
}

export function resolveDataJsonAiFeatureSettings(
  dataJson: DataJsonAiFeatureSettings,
  legacy: Partial<Pick<
    EffectiveDataJsonAiFeatureSettings,
    "autoPaneNamingEnabled" | "replyDraftSuggestionsEnabled"
  >>,
): EffectiveDataJsonAiFeatureSettings {
  const dataAutoPaneNaming = dataJson.autoPaneNamingEnabled ?? null;
  const dataReplyDraft = dataJson.replyDraftSuggestionsEnabled ?? null;
  const legacyAutoPaneNaming = typeof legacy.autoPaneNamingEnabled === "boolean"
    ? legacy.autoPaneNamingEnabled
    : null;
  const legacyReplyDraft = typeof legacy.replyDraftSuggestionsEnabled === "boolean"
    ? legacy.replyDraftSuggestionsEnabled
    : null;
  const persistedAutoPaneNamingEnabled = dataAutoPaneNaming ?? legacyAutoPaneNaming;
  const persistedReplyDraftSuggestionsEnabled = dataReplyDraft ?? legacyReplyDraft;
  return {
    autoPaneNamingEnabled: persistedAutoPaneNamingEnabled ?? DEFAULT_AUTO_PANE_NAMING_ENABLED,
    replyDraftSuggestionsEnabled:
      persistedReplyDraftSuggestionsEnabled ?? DEFAULT_REPLY_DRAFT_SUGGESTIONS_ENABLED,
    persistedAutoPaneNamingEnabled,
    persistedReplyDraftSuggestionsEnabled,
    migrationNeeded:
      (dataAutoPaneNaming === null && legacyAutoPaneNaming !== null)
      || (dataReplyDraft === null && legacyReplyDraft !== null),
  };
}

export interface PersistedAiSettings {
  aiProvider: AiProviderId;
  aiModel: string;
  aiEnabled: boolean;
  persistedAutoPaneNamingEnabled: boolean | null;
  persistedReplyDraftSuggestionsEnabled: boolean | null;
}

interface AiSettingsState extends PersistedAiSettings {
  legacyAiFeatureSettingsMigrationPending: boolean;
  hydrateAiSettings: (
    settings: Partial<PersistedAiSettings> & {
      legacyAiFeatureSettingsMigrationPending?: boolean;
    },
  ) => void;
  setAiProvider: (provider: AiProviderId) => void;
  setAiModel: (model: string) => void;
  setAiEnabled: (enabled: boolean) => void;
  setPersistedAutoPaneNamingEnabled: (enabled: boolean) => void;
  setPersistedReplyDraftSuggestionsEnabled: (enabled: boolean) => void;
  completeLegacyAiFeatureSettingsMigration: () => void;
  resetAiSettings: () => void;
}

export const useAiSettingsStore = create<AiSettingsState>((set) => ({
  aiProvider: DEFAULT_AI_PROVIDER,
  aiModel: DEFAULT_AI_MODEL,
  aiEnabled: true,
  persistedAutoPaneNamingEnabled: null,
  persistedReplyDraftSuggestionsEnabled: null,
  legacyAiFeatureSettingsMigrationPending: false,
  hydrateAiSettings: (settings) => {
    const provider = normalizeAiProvider(settings.aiProvider);
    set({
      aiProvider: provider,
      aiModel: normalizeAiModel(settings.aiModel, provider),
      aiEnabled: settings.aiEnabled ?? true,
      persistedAutoPaneNamingEnabled: settings.persistedAutoPaneNamingEnabled ?? null,
      persistedReplyDraftSuggestionsEnabled: settings.persistedReplyDraftSuggestionsEnabled ?? null,
      legacyAiFeatureSettingsMigrationPending:
        settings.legacyAiFeatureSettingsMigrationPending ?? false,
    });
  },
  setAiProvider: (provider) => set((state) => {
    const next = normalizeAiProvider(provider);
    return { aiProvider: next, aiModel: modelForProviderSwitch(next, state.aiModel) };
  }),
  setAiModel: (model) => set((state) => ({ aiModel: normalizeAiModel(model, state.aiProvider) })),
  setAiEnabled: (aiEnabled) => set({ aiEnabled }),
  setPersistedAutoPaneNamingEnabled: (enabled) => set({ persistedAutoPaneNamingEnabled: enabled }),
  setPersistedReplyDraftSuggestionsEnabled: (enabled) => set({
    persistedReplyDraftSuggestionsEnabled: enabled,
  }),
  completeLegacyAiFeatureSettingsMigration: () => set({
    legacyAiFeatureSettingsMigrationPending: false,
  }),
  resetAiSettings: () => set({
    aiProvider: DEFAULT_AI_PROVIDER,
    aiModel: DEFAULT_AI_MODEL,
    aiEnabled: true,
    persistedAutoPaneNamingEnabled: null,
    persistedReplyDraftSuggestionsEnabled: null,
    legacyAiFeatureSettingsMigrationPending: false,
  }),
}));

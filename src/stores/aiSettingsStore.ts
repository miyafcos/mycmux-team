import { create } from "zustand";
import {
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  modelForProviderSwitch,
  normalizeAiModel,
  normalizeAiProvider,
  type AiProviderId,
} from "../lib/aiModels";

// Which CLI the background AI features run on. Persisted in data.json (not
// localStorage) because every consumer of this setting lives in Rust:
// commands/tab_sweep.rs, ailog/summarize.rs and ailog/digest.rs all read it
// through crate::ai::resolve.

export interface PersistedAiSettings {
  aiProvider: AiProviderId;
  aiModel: string;
  aiEnabled: boolean;
}

interface AiSettingsState extends PersistedAiSettings {
  hydrateAiSettings: (settings: Partial<PersistedAiSettings>) => void;
  setAiProvider: (provider: AiProviderId) => void;
  setAiModel: (model: string) => void;
  setAiEnabled: (enabled: boolean) => void;
  resetAiSettings: () => void;
}

export const useAiSettingsStore = create<AiSettingsState>((set) => ({
  aiProvider: DEFAULT_AI_PROVIDER,
  aiModel: DEFAULT_AI_MODEL,
  aiEnabled: true,
  hydrateAiSettings: (settings) => {
    const provider = normalizeAiProvider(settings.aiProvider);
    set({
      aiProvider: provider,
      aiModel: normalizeAiModel(settings.aiModel, provider),
      aiEnabled: settings.aiEnabled ?? true,
    });
  },
  setAiProvider: (provider) => set((state) => {
    const next = normalizeAiProvider(provider);
    return { aiProvider: next, aiModel: modelForProviderSwitch(next, state.aiModel) };
  }),
  setAiModel: (model) => set((state) => ({ aiModel: normalizeAiModel(model, state.aiProvider) })),
  setAiEnabled: (aiEnabled) => set({ aiEnabled }),
  resetAiSettings: () => set({
    aiProvider: DEFAULT_AI_PROVIDER,
    aiModel: DEFAULT_AI_MODEL,
    aiEnabled: true,
  }),
}));

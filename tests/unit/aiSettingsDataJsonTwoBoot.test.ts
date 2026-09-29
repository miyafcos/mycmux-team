// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("AI feature settings two-boot migration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("does not turn clean UI defaults into legacy input on the second boot", async () => {
    const firstListener = await import("../../src/components/layout/SocketListener");
    const firstSettings = await import("../../src/stores/settingsStore");
    const firstAi = await import("../../src/stores/aiSettingsStore");

    firstListener.hydrateAiSettingsFromDataJson({
      ai_provider: "codex",
      ai_model: "gpt-5.3-codex",
      ai_enabled: true,
      auto_pane_naming_enabled: null,
      reply_draft_suggestions_enabled: null,
    });

    expect(firstAi.useAiSettingsStore.getState()).toMatchObject({
      persistedAutoPaneNamingEnabled: null,
      persistedReplyDraftSuggestionsEnabled: null,
      legacyAiFeatureSettingsMigrationPending: false,
    });
    const storedAfterFirstBoot = JSON.parse(localStorage.getItem("mycmux-settings") ?? "null");
    expect(storedAfterFirstBoot.state).toMatchObject({
      autoPaneNamingEnabled: true,
      replyDraftSuggestionsEnabled: false,
      aiFeatureSettingsDataJsonMigrationComplete: true,
    });

    vi.resetModules();
    const secondListener = await import("../../src/components/layout/SocketListener");
    const secondSettings = await import("../../src/stores/settingsStore");
    const secondAi = await import("../../src/stores/aiSettingsStore");
    expect(secondSettings.readLegacyAiFeatureSettings()).toEqual({});

    secondListener.hydrateAiSettingsFromDataJson({
      ai_provider: "codex",
      ai_model: "gpt-5.3-codex",
      ai_enabled: true,
      auto_pane_naming_enabled: null,
      reply_draft_suggestions_enabled: null,
    });

    expect(secondAi.useAiSettingsStore.getState()).toMatchObject({
      persistedAutoPaneNamingEnabled: null,
      persistedReplyDraftSuggestionsEnabled: null,
      legacyAiFeatureSettingsMigrationPending: false,
    });
    expect(firstSettings.parseLegacyAiFeatureSettings(
      localStorage.getItem("mycmux-settings"),
    )).toEqual({});
  }, 15_000);

  it("marks genuine legacy input complete only after a successful data.json save", async () => {
    localStorage.setItem("mycmux-settings", JSON.stringify({
      state: {
        autoPaneNamingEnabled: false,
        replyDraftSuggestionsEnabled: true,
      },
      version: 6,
    }));
    const listener = await import("../../src/components/layout/SocketListener");
    const ai = await import("../../src/stores/aiSettingsStore");
    const settings = await import("../../src/stores/settingsStore");

    listener.hydrateAiSettingsFromDataJson({
      ai_provider: "codex",
      ai_model: "gpt-5.3-codex",
      ai_enabled: true,
      auto_pane_naming_enabled: null,
      reply_draft_suggestions_enabled: null,
    });
    expect(ai.useAiSettingsStore.getState()).toMatchObject({
      persistedAutoPaneNamingEnabled: false,
      persistedReplyDraftSuggestionsEnabled: true,
      legacyAiFeatureSettingsMigrationPending: true,
    });
    expect(settings.readLegacyAiFeatureSettings()).toEqual({
      autoPaneNamingEnabled: false,
      replyDraftSuggestionsEnabled: true,
    });

    listener.completeAiFeatureSettingsMigrationAfterSave();

    expect(ai.useAiSettingsStore.getState().legacyAiFeatureSettingsMigrationPending).toBe(false);
    expect(settings.readLegacyAiFeatureSettings()).toEqual({});
    expect(JSON.parse(localStorage.getItem("mycmux-settings") ?? "null").state)
      .toHaveProperty("aiFeatureSettingsDataJsonMigrationComplete", true);
  }, 15_000);
});

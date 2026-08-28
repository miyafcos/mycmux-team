import { describe, expect, it } from "vitest";

import { resolveDataJsonAiFeatureSettings } from "../../src/stores/aiSettingsStore";
import { parseLegacyAiFeatureSettings } from "../../src/stores/settingsStore";

describe("AI feature settings data.json migration", () => {
  it("adopts each legacy value exactly once when data.json is unset", () => {
    const legacy = parseLegacyAiFeatureSettings(JSON.stringify({
      state: {
        autoPaneNamingEnabled: false,
        replyDraftSuggestionsEnabled: true,
      },
      version: 6,
    }));
    const first = resolveDataJsonAiFeatureSettings({
      autoPaneNamingEnabled: null,
      replyDraftSuggestionsEnabled: null,
    }, legacy);

    expect(first).toEqual({
      autoPaneNamingEnabled: false,
      replyDraftSuggestionsEnabled: true,
      persistedAutoPaneNamingEnabled: false,
      persistedReplyDraftSuggestionsEnabled: true,
      migrationNeeded: true,
    });

    const second = resolveDataJsonAiFeatureSettings({
      autoPaneNamingEnabled: first.persistedAutoPaneNamingEnabled,
      replyDraftSuggestionsEnabled: first.persistedReplyDraftSuggestionsEnabled,
    }, {
      autoPaneNamingEnabled: true,
      replyDraftSuggestionsEnabled: false,
    });
    expect(second).toMatchObject({
      autoPaneNamingEnabled: false,
      replyDraftSuggestionsEnabled: true,
      migrationNeeded: false,
    });
  });

  it("uses UI defaults without converting an absent legacy value into an explicit save", () => {
    expect(resolveDataJsonAiFeatureSettings({
      autoPaneNamingEnabled: null,
      replyDraftSuggestionsEnabled: null,
    }, {})).toEqual({
      autoPaneNamingEnabled: true,
      replyDraftSuggestionsEnabled: false,
      persistedAutoPaneNamingEnabled: null,
      persistedReplyDraftSuggestionsEnabled: null,
      migrationNeeded: false,
    });
  });

  it("lets explicit data.json values win independently over conflicting legacy values", () => {
    expect(resolveDataJsonAiFeatureSettings({
      autoPaneNamingEnabled: false,
      replyDraftSuggestionsEnabled: true,
    }, {
      autoPaneNamingEnabled: true,
      replyDraftSuggestionsEnabled: false,
    })).toMatchObject({
      autoPaneNamingEnabled: false,
      replyDraftSuggestionsEnabled: true,
      migrationNeeded: false,
    });
  });

  it("reads only boolean own-properties and leaves the legacy payload untouched", () => {
    const raw = JSON.stringify({
      state: {
        autoPaneNamingEnabled: true,
        replyDraftSuggestionsEnabled: "false",
        unrelated: 7,
      },
      version: 6,
    });
    expect(parseLegacyAiFeatureSettings(raw)).toEqual({ autoPaneNamingEnabled: true });
    expect(JSON.parse(raw).state).toHaveProperty("autoPaneNamingEnabled", true);
  });
});

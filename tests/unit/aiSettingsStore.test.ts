import { beforeEach, describe, expect, it } from "vitest";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";

function state() {
  return useAiSettingsStore.getState();
}

describe("aiSettingsStore", () => {
  beforeEach(() => {
    state().resetAiSettings();
  });

  it("starts on the codex default", () => {
    expect(state().aiProvider).toBe("codex");
    expect(state().aiModel).toBe("gpt-5.6-luna");
    expect(state().aiEnabled).toBe(true);
  });

  it("hydrates a data.json payload", () => {
    state().hydrateAiSettings({ aiProvider: "claude-code", aiModel: "claude-opus-5", aiEnabled: false });
    expect(state().aiProvider).toBe("claude-code");
    expect(state().aiModel).toBe("claude-opus-5");
    expect(state().aiEnabled).toBe(false);
  });

  it("fills in defaults when data.json predates these keys", () => {
    state().hydrateAiSettings({});
    expect(state().aiProvider).toBe("codex");
    expect(state().aiModel).toBe("gpt-5.6-luna");
    expect(state().aiEnabled).toBe(true);
  });

  it("falls back to the provider default when a hydrated model is blank", () => {
    state().hydrateAiSettings({ aiProvider: "claude-code", aiModel: "   " });
    expect(state().aiModel).toBe("claude-haiku-4-5-20251001");
  });

  it("swaps the model when switching to a provider it does not belong to", () => {
    state().setAiProvider("claude-code");
    expect(state().aiModel).toBe("claude-haiku-4-5-20251001");
    state().setAiProvider("codex");
    expect(state().aiModel).toBe("gpt-5.6-luna");
  });

  it("keeps a hand-typed model across a provider switch", () => {
    state().setAiModel("internal-eval-build");
    state().setAiProvider("claude-code");
    expect(state().aiModel).toBe("internal-eval-build");
  });

  it("keeps an unknown model instead of correcting it", () => {
    state().setAiModel("  gpt-7-preview  ");
    expect(state().aiModel).toBe("gpt-7-preview");
  });

  it("restores the provider default when the model is cleared", () => {
    state().setAiModel("");
    expect(state().aiModel).toBe("gpt-5.6-luna");
  });
});

import { describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  aiProviderDef,
  classifyModelForProvider,
  modelForProviderSwitch,
  normalizeAiModel,
  normalizeAiProvider,
} from "../../src/lib/aiModels";

describe("aiModels catalog", () => {
  it("ships exactly the two CLI providers the Rust runner knows about", () => {
    expect(AI_PROVIDERS.map((p) => p.id)).toEqual(["codex", "claude-code"]);
  });

  it("defaults to codex / gpt-5.6-luna", () => {
    // Mirrored in src-tauri/src/db/storage.rs; pinned by
    // tests/test_ai_settings_contract.py.
    expect(DEFAULT_AI_PROVIDER).toBe("codex");
    expect(DEFAULT_AI_MODEL).toBe("gpt-5.6-luna");
    expect(aiProviderDef("codex").defaultModel).toBe(DEFAULT_AI_MODEL);
  });

  it("lists every provider's own default among its presets", () => {
    for (const provider of AI_PROVIDERS) {
      expect(provider.presets.map((p) => p.id)).toContain(provider.defaultModel);
    }
  });
});

describe("normalizeAiProvider", () => {
  it("keeps known providers", () => {
    expect(normalizeAiProvider("claude-code")).toBe("claude-code");
    expect(normalizeAiProvider("codex")).toBe("codex");
  });

  it("falls back for unknown, empty and non-string values", () => {
    for (const value of ["gemini", "", null, undefined, 7, {}]) {
      expect(normalizeAiProvider(value)).toBe(DEFAULT_AI_PROVIDER);
    }
  });
});

describe("normalizeAiModel", () => {
  it("trims and keeps arbitrary model ids", () => {
    expect(normalizeAiModel("  some-future-model  ", "codex")).toBe("some-future-model");
  });

  it("falls back to the provider default when blank or absent", () => {
    expect(normalizeAiModel("   ", "codex")).toBe("gpt-5.6-luna");
    expect(normalizeAiModel(undefined, "claude-code")).toBe("claude-haiku-4-5-20251001");
  });
});

describe("classifyModelForProvider", () => {
  it("recognises presets", () => {
    expect(classifyModelForProvider("codex", "gpt-5.6-terra")).toBe("preset");
    expect(classifyModelForProvider("claude-code", "claude-sonnet-5")).toBe("preset");
  });

  it("accepts unknown ids as custom rather than an error", () => {
    expect(classifyModelForProvider("codex", "gpt-6-nova")).toBe("custom");
    expect(classifyModelForProvider("claude-code", "internal-eval-build")).toBe("custom");
  });

  it("flags a model that plainly belongs to the other provider", () => {
    expect(classifyModelForProvider("codex", "claude-opus-5")).toBe("likely-mismatch");
    expect(classifyModelForProvider("claude-code", "gpt-5.6-luna")).toBe("likely-mismatch");
    expect(classifyModelForProvider("claude-code", "o3-mini")).toBe("likely-mismatch");
  });
});

describe("modelForProviderSwitch", () => {
  it("replaces a model belonging to the provider being left", () => {
    expect(modelForProviderSwitch("claude-code", "gpt-5.6-luna")).toBe("claude-haiku-4-5-20251001");
    expect(modelForProviderSwitch("codex", "claude-sonnet-5")).toBe("gpt-5.6-luna");
  });

  it("keeps a model that already fits the new provider", () => {
    expect(modelForProviderSwitch("claude-code", "claude-opus-5")).toBe("claude-opus-5");
  });

  it("keeps a hand-typed model the catalog does not know", () => {
    expect(modelForProviderSwitch("claude-code", "internal-eval-build")).toBe("internal-eval-build");
  });
});

describe("current model presets", () => {
  it("offers current models while preserving the configured defaults and legacy presets", () => {
    for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
      expect(classifyModelForProvider("codex", model)).toBe("preset");
    }
    for (const model of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]) {
      expect(classifyModelForProvider("claude-code", model)).toBe("preset");
    }
    for (const provider of AI_PROVIDERS) {
      expect(new Set(provider.presets.map(p => p.id)).size).toBe(provider.presets.length);
    }
  });
});

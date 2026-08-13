// Catalog of CLI providers and model IDs for the background AI features
// (tab-sweep judge/naming, ailog session summaries, ailog daily digest).
//
// This file is the single source of truth for the *presets*. The Rust side
// deliberately keeps no catalog: it receives an opaque model string and puts
// it on the argv. The only value duplicated across the boundary is the
// default pair (codex / gpt-5.6-luna), which
// tests/test_ai_settings_contract.py pins to db/storage.rs.
//
// Note that ailog/price.rs holds *family stems* ("opus-5", "gpt-5.6-luna")
// used for cost aggregation. Those are not CLI model IDs — "opus-5" is not
// something `claude --model` accepts — so it cannot be reused here.

export type AiProviderId = "claude-code" | "codex";

export interface AiModelPreset {
  /** Exact string handed to `--model`. */
  id: string;
  /** Short hint shown next to the entry in the datalist. */
  note: string;
}

export interface AiProviderDef {
  id: AiProviderId;
  /** Product name shown in the UI. */
  label: string;
  /** Executable name, used in "is it installed?" messages. */
  cli: string;
  defaultModel: string;
  presets: AiModelPreset[];
}

export const AI_PROVIDERS: readonly AiProviderDef[] = [
  {
    id: "codex",
    label: "Codex",
    cli: "codex",
    defaultModel: "gpt-5.6-luna",
    presets: [
      { id: "gpt-5.6-luna", note: "既定・高速" },
      { id: "gpt-5.6-terra", note: "標準" },
      { id: "gpt-5.6-sol", note: "高精度・高コスト" },
    ],
  },
  {
    id: "claude-code",
    label: "Claude Code",
    cli: "claude",
    defaultModel: "claude-haiku-4-5-20251001",
    presets: [
      { id: "claude-haiku-4-5-20251001", note: "高速" },
      { id: "claude-sonnet-5", note: "標準" },
      { id: "claude-opus-5", note: "高精度・高コスト" },
      { id: "claude-fable-5", note: "高精度・高コスト" },
    ],
  },
] as const;

export const DEFAULT_AI_PROVIDER: AiProviderId = "codex";
export const DEFAULT_AI_MODEL = "gpt-5.6-luna";

export function aiProviderDef(id: AiProviderId): AiProviderDef {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];
}

/** Unknown/absent values fall back to the default provider, never throw. */
export function normalizeAiProvider(value: unknown): AiProviderId {
  return AI_PROVIDERS.some((p) => p.id === value) ? (value as AiProviderId) : DEFAULT_AI_PROVIDER;
}

/**
 * Trims and falls back to the provider default when empty. Anything else is
 * passed through verbatim: typing a model the catalog has never heard of is a
 * supported workflow, so this must not "correct" it.
 */
export function normalizeAiModel(value: unknown, provider: AiProviderId): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : aiProviderDef(provider).defaultModel;
}

export type AiModelClassification = "preset" | "custom" | "likely-mismatch";

/**
 * Prefix heuristic only — it flags a model that plainly belongs to the other
 * provider (an easy slip when switching providers) without ever blocking the
 * value. New model families are expected to land as "custom", not as errors.
 */
export function classifyModelForProvider(provider: AiProviderId, model: string): AiModelClassification {
  const trimmed = model.trim();
  if (trimmed.length === 0) return "custom";
  if (aiProviderDef(provider).presets.some((p) => p.id === trimmed)) return "preset";

  const lower = trimmed.toLowerCase();
  const looksAnthropic = lower.startsWith("claude-");
  const looksOpenAi = lower.startsWith("gpt-") || /^o[134](-|$)/.test(lower);
  if (provider === "codex" && looksAnthropic) return "likely-mismatch";
  if (provider === "claude-code" && looksOpenAi) return "likely-mismatch";
  return "custom";
}

/**
 * Model to select after a provider switch. Only a model that plainly belongs
 * to the old provider is replaced — a hand-typed one is kept, so switching
 * providers never silently discards something the catalog does not know.
 */
export function modelForProviderSwitch(nextProvider: AiProviderId, currentModel: string): string {
  if (classifyModelForProvider(nextProvider, currentModel) === "likely-mismatch") {
    return aiProviderDef(nextProvider).defaultModel;
  }
  return normalizeAiModel(currentModel, nextProvider);
}

/**
 * Ailog series fills use fixed company hues, not theme variables: many series
 * must remain distinguishable together on both light and dark surfaces. These
 * are fill colours only; text always keeps the theme's foreground colour.
 */

import { agentKindColor } from "../../lib/agentKindColors";
import type { SeriesGroupBy } from "../../lib/ailog";
import { maxChroma, oklchToHex } from "../../lib/oklch";

// OKLCH hues, not HSL: lightness has to mean tier, and only a perceptual space
// keeps that reading from being contaminated by hue-driven brightness.
// Four-provider palette verified against the same contrast/CVD floors.
// Current generations occupy rungs; previous generations reuse muted rungs.
export const PROVIDER_HUE: Record<string, number> = {
  anthropic: 38, openai: 258, xai: 334, google: 170,
};

export const TIER_LADDER: Record<string, readonly string[]> = {
  anthropic: ["fable-5.1", "opus-5.5", "sonnet-5.5", "haiku-4.5"],
  openai: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"],
  xai: ["grok-4.7"],
  google: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
};

export const LEGACY_FAMILIES: Record<string, string> = {
  "fable-5": "fable-5.1",
  "mythos-5.1": "fable-5.1",
  "mythos-5": "fable-5.1",
  "mythos-preview": "fable-5.1",
  "opus-5": "opus-5.5",
  "opus-4.8": "opus-5.5",
  "opus-4.7": "opus-5.5",
  "opus-4.6": "opus-5.5",
  "opus-4.5": "opus-5.5",
  "opus-4.1": "opus-5.5",
  "opus-4.0": "opus-5.5",
  "sonnet-5": "sonnet-5.5",
  "sonnet-4.6": "sonnet-5.5",
  "sonnet-4.5": "sonnet-5.5",
  "sonnet-4.0": "sonnet-5.5",
  "gpt-6-sol": "gpt-6.1-sol",
  "gpt-5.6-sol": "gpt-6.1-sol",
  "gpt-5.6-terra": "gpt-6.1-sol",
  "gpt-5.5": "gpt-6.1-sol",
  "gpt-5.4": "gpt-6.1-sol",
  "gpt-5.6-luna": "gpt-6-luna",
  "grok-4.6": "grok-4.7",
  "grok-4.6-build": "grok-4.7",
  "grok-4.7-build": "grok-4.7",
  "gemini-3.7-flash": "gemini-3.8-flash",
  "gemini-3.6-flash": "gemini-3.8-flash",
  "gemini-3.5-flash": "gemini-3.8-flash",
  "gemini-3.1-flash-lite": "gemini-3.5-flash-lite",
};

/** Collapsed display families resolve to an explicitly chosen generation. */
export const FAMILY_REPRESENTATIVE: Record<string, string> = {
  "gpt-6": "gpt-6-astra",
  "gpt-6.1": "gpt-6.1-sol",
  "gpt-5.6": "gpt-5.6-terra",
};

/** Mirrors price.rs FAMILY_STEMS; longest structural match wins. */
export const FAMILY_STEMS: readonly (readonly [string, string])[] = [
  ["claude-fable-5-1", "fable-5.1"],
  ["claude-mythos-5-1", "mythos-5.1"],
  ["claude-opus-5-5", "opus-5.5"],
  ["claude-sonnet-5-5", "sonnet-5.5"],
  ["claude-fable-5", "fable-5"],
  ["claude-mythos-5", "mythos-5"],
  ["claude-mythos-preview", "mythos-preview"],
  ["claude-opus-5", "opus-5"],
  ["claude-opus-4-8", "opus-4.8"],
  ["claude-opus-4-7", "opus-4.7"],
  ["claude-opus-4-6", "opus-4.6"],
  ["claude-opus-4-5", "opus-4.5"],
  ["claude-opus-4-1", "opus-4.1"],
  ["claude-opus-4-0", "opus-4.0"],
  ["claude-sonnet-5", "sonnet-5"],
  ["claude-sonnet-4-6", "sonnet-4.6"],
  ["claude-sonnet-4-5", "sonnet-4.5"],
  ["claude-sonnet-4-0", "sonnet-4.0"],
  ["claude-haiku-4-5", "haiku-4.5"],
  ["gpt-6.1", "gpt-6.1"],
  ["gpt-6", "gpt-6"],
  ["gpt-5.6", "gpt-5.6"],
  ["gpt-5.5", "gpt-5.5"],
  ["gpt-5.4", "gpt-5.4"],
  ["grok-4.7", "grok-4.7"],
  ["grok-4.6", "grok-4.6"],
  ["gemini-3.8-flash", "gemini-3.8-flash"],
  ["gemini-3.7-flash", "gemini-3.7-flash"],
  ["gemini-3.6-flash", "gemini-3.6-flash"],
  ["gemini-3.5-flash", "gemini-3.5-flash"],
  ["gemini-3.5-flash-lite", "gemini-3.5-flash-lite"],
  ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
];

// Chroma zero on purpose: this is the "no company" colour, so it must not read
// as a faint member of any hue. The old #8a8f9c leaned blue and closed to
// dE 0.036 against the OpenAI muted rungs once those turned blue.
export const NEUTRAL_COLOR = "#8c8c8c";
export const SERIES_TOP_N = 10;
export const UNTIERED_POLICY: "provider-pale" | "neutral" = "provider-pale";

const L_TOP = 0.5;
const L_BOT = 0.656;
const C_TOP = 0.15;
const C_BOT = 0.096;
const L_MID = (L_TOP + L_BOT) / 2;
const C_MID = (C_TOP + C_BOT) / 2;

export type SeriesTone = "solid" | "muted" | "neutral";
export interface SeriesPaint { color: string; tone: SeriesTone; }

function paintAt(hue: number, rank: number, count: number, muted = false): SeriesPaint {
  const position = count <= 1 ? 0.5 : rank / (count - 1);
  const L = count <= 1 ? L_MID : L_TOP + (L_BOT - L_TOP) * position;
  const requestedC = count <= 1 ? C_MID : C_TOP + (C_BOT - C_TOP) * position;
  const chroma = Math.min(requestedC, maxChroma(L, hue)) * (muted ? 0.55 : 1);
  return { color: oklchToHex(L, chroma, hue), tone: muted ? "muted" : "solid" };
}

/** Provider-axis paint always uses the shared middle of the safe L band. */
function providerAxisPaint(provider: string): SeriesPaint | undefined {
  const hue = PROVIDER_HUE[provider];
  if (hue === undefined) return undefined;
  return paintAt(hue, 0, 1);
}

/** Untiered models inherit their provider's palest rung as a muted fill. */
function untieredPaint(provider: string): SeriesPaint | undefined {
  const hue = PROVIDER_HUE[provider];
  if (hue === undefined) return undefined;
  const ladder = TIER_LADDER[provider] ?? [];
  return paintAt(hue, ladder.length === 0 ? 0 : ladder.length - 1, ladder.length || 1, true);
}

function rungPaint(provider: string, rank: number, muted = false): SeriesPaint {
  return paintAt(PROVIDER_HUE[provider], rank, TIER_LADDER[provider].length, muted);
}

export function resolveFamily(name: string): string {
  const trimmed = name.trim();
  let best: readonly [string, string] | undefined;
  for (const entry of FAMILY_STEMS) {
    const [stem] = entry;
    const rest = trimmed.slice(stem.length);
    const valid = trimmed.startsWith(stem) && (rest === "" || rest.startsWith("-") || (rest.startsWith("[") && rest.endsWith("]")));
    const numericSuffix = rest.startsWith("-") && /^\d/.test(rest.slice(1));
    const snapshot = /^(?:\d{8}|\d{4}-\d{2}-\d{2})(?:\[1m\])?$/.test(rest.slice(1));
    if (valid && (!numericSuffix || snapshot) && (!best || stem.length > best[0].length)) best = entry;
  }
  return best?.[1] ?? trimmed;
}

/** Mirrors price.rs MODEL_CLASS_RULES and recognises display-family names. */
export function providerOf(name: string): string | null {
  const lower = name.trim().toLowerCase();
  if (lower.includes("/")) return null;
  if (lower.includes("fugu")) return null;
  if (lower.startsWith("claude-")) return "anthropic";
  if (lower.startsWith("gpt-")) return "openai";
  if (lower.startsWith("gemini-")) return "google";
  if (lower.includes("grok")) return "xai";
  const family = resolveFamily(lower);
  const rung = LEGACY_FAMILIES[family] ?? FAMILY_REPRESENTATIVE[family] ?? family;
  for (const [provider, ladder] of Object.entries(TIER_LADDER)) {
    if (ladder.includes(rung) || (LEGACY_FAMILIES[rung] && ladder.includes(LEGACY_FAMILIES[rung]))) return provider;
  }
  return null;
}

export function modelPaint(name: string): SeriesPaint {
  const raw = name.trim();
  // Only snapshot/context suffixes inherit an existing model's paint. A
  // future named variant must retain the provider's untiered treatment.
  const base = raw.replace(/(?:-(?:\d{8}|\d{4}-\d{2}-\d{2}))?(?:\[1m\])?$/, "");
  const canonical = base.replace(/^(gpt-[^\[]+)\[([^\]]+)\]$/, "$1-$2");
  const knownFamily = FAMILY_STEMS.find(([stem]) => stem === canonical)?.[1];
  const provider = providerOf(raw);
  if (!provider || raw === "(unknown)" || raw === "(folded)") return { color: NEUTRAL_COLOR, tone: "neutral" };
  const findRung = (candidate: string, muted = false): SeriesPaint | undefined => {
    for (const [provider, ladder] of Object.entries(TIER_LADDER)) {
      const rank = ladder.indexOf(candidate);
      if (rank >= 0) return rungPaint(provider, rank, muted);
    }
    return undefined;
  };
  const direct = findRung(canonical) ?? (knownFamily ? findRung(knownFamily) : undefined);
  if (direct) return direct;
  const legacyParent = LEGACY_FAMILIES[canonical] ?? (knownFamily ? LEGACY_FAMILIES[knownFamily] : undefined);
  if (legacyParent) return findRung(legacyParent, true) ?? { color: NEUTRAL_COLOR, tone: "neutral" };
  const representative = FAMILY_REPRESENTATIVE[canonical];
  if (representative) return findRung(representative) ?? findRung(LEGACY_FAMILIES[representative], true) ?? { color: NEUTRAL_COLOR, tone: "neutral" };
  if (UNTIERED_POLICY === "neutral") return { color: NEUTRAL_COLOR, tone: "neutral" };
  return untieredPaint(provider) ?? { color: NEUTRAL_COLOR, tone: "neutral" };
}

/** Stable eight-colour categorical ring for non-model series axes. */
export function categoricalPaint(name: string): SeriesPaint {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  const hue = (hash % 8) * 45;
  return { color: oklchToHex(L_MID, Math.min(C_MID, maxChroma(L_MID, hue)), hue), tone: "solid" };
}

/** Stable group paint; no branch depends on ranking, duration, or metric. */
export function seriesPaint(group: string, groupBy: SeriesGroupBy): SeriesPaint {
  if (groupBy === "model" || groupBy === "model_raw") return modelPaint(group);
  if (groupBy === "provider") return providerAxisPaint(group) ?? { color: NEUTRAL_COLOR, tone: "neutral" };
  if (groupBy === "kind") {
    const kind = agentKindColor(group);
    return kind ? { color: kind.fg, tone: "solid" } : { color: NEUTRAL_COLOR, tone: "neutral" };
  }
  return categoricalPaint(group);
}

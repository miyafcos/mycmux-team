import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../../src/components/theme/colorContrast";
import {
  FAMILY_REPRESENTATIVE,
  FAMILY_STEMS,
  LEGACY_FAMILIES,
  NEUTRAL_COLOR,
  PROVIDER_HUE,
  TIER_LADDER,
  UNTIERED_POLICY,
  categoricalPaint,
  modelPaint,
  providerOf,
  seriesPaint,
} from "../../src/components/ailog/modelColors";
import { THEMES } from "../../src/components/theme/themeDefinitions";
import { deltaEok, hexToOklch, maxChroma, oklchToHex } from "../../src/lib/oklch";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const surfaces = THEMES.map((theme) => theme.chrome.surface);
const lightSurface = surfaces.reduce((lightest, surface) =>
  contrastRatio(surface, "#000000") > contrastRatio(lightest, "#000000") ? surface : lightest,
);
const darkSurface = surfaces.reduce((darkest, surface) =>
  contrastRatio(surface, "#000000") < contrastRatio(darkest, "#000000") ? surface : darkest,
);

function providerOfRung(name: string): string {
  const provider = providerOf(name);
  if (!provider) throw new Error(`expected provider for ${name}`);
  return provider;
}

function expectedNear(actual: string, expected: string): void {
  const bytes = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  for (const [actualByte, expectedByte] of bytes(actual).map((byte, index) => [byte, bytes(expected)[index]] as const)) {
    expect(Math.abs(actualByte - expectedByte), `${actual} vs ${expected}`).toBeLessThanOrEqual(2);
  }
}

const measured = [
  ["fable-5", "#a63b11", "#8b523f"], ["opus-5", "#b15232", "#976352"],
  ["sonnet-5", "#ba674c", "#a37566"], ["haiku-4.5", "#c37c65", "#ae8679"],
  ["gpt-6-astra", "#2460b7", "#456492"], ["gpt-5.6-sol", "#376dbc", "#53709a"],
  ["gpt-5.6-terra", "#497ac1", "#617ba2"], ["gpt-5.6-luna", "#5b86c7", "#6f87aa"],
  ["gpt-5.5", "#6c92cb", "#7d92b2"], ["grok-4.6", "#a55b96", "#936b8a"],
] as const;

// Providers intentionally drawn in NEUTRAL rather than a company hue.
const HUELESS_PROVIDERS = new Set(["local", "other"]);

const legacyForRung: Record<string, string> = {
  "gpt-5.5": "gpt-5.4",
  "fable-5": "mythos-5", "opus-5": "opus-4.8", "sonnet-5": "sonnet-4.6", "grok-4.6": "grok-4.6-build",
};

function mutedForRung(rung: string): string {
  const legacy = legacyForRung[rung];
  if (legacy) return modelPaint(legacy).color;
  const provider = providerOfRung(rung);
  const ladder = TIER_LADDER[provider];
  const rank = ladder.indexOf(rung);
  const position = ladder.length === 1 ? 0.5 : rank / (ladder.length - 1);
  const L = ladder.length === 1 ? 0.578 : 0.5 + 0.156 * position;
  const C = ladder.length === 1 ? 0.123 : 0.15 + (0.096 - 0.15) * position;
  return oklchToHex(L, Math.min(C, maxChroma(L, PROVIDER_HUE[provider])) * 0.55, PROVIDER_HUE[provider]);
}

function allGeneratedPaints(): string[] {
  const solid = Object.values(TIER_LADDER).flatMap((ladder) => ladder.map((rung) => modelPaint(rung).color));
  const muted = measured.map(([rung]) => mutedForRung(rung));
  return [...solid, ...muted, seriesPaint("google", "provider").color];
}

describe("ailog OKLCH palette", () => {
  it("A: maintains the contrast floor against every theme's lightest and darkest surface", () => {
    for (const color of [...allGeneratedPaints(), NEUTRAL_COLOR]) {
      expect(contrastRatio(color, lightSurface), `${color} on ${lightSurface}`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(color, darkSurface), `${color} on ${darkSurface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("B/C/D/F: preserves provider hue, tier lightness, separation, and muted lightness", () => {
    for (const [provider, ladder] of Object.entries(TIER_LADDER)) {
      if (ladder.length === 0) continue;
      const solids = ladder.map((rung) => modelPaint(rung).color);
      const muted = ladder.map((rung) => mutedForRung(rung));
      const hue = PROVIDER_HUE[provider];
      for (const color of [...solids, ...muted]) {
        const difference = Math.abs(hexToOklch(color).h - hue);
        expect(Math.min(difference, 360 - difference), `${provider} ${color}`).toBeLessThan(0.5);
      }
      expect(Math.abs(hexToOklch(solids[0]).L - (ladder.length === 1 ? 0.578 : 0.5))).toBeLessThan(0.002);
      for (let index = 0; index < solids.length; index += 1) {
        expect(deltaEok(solids[index], muted[index]), `${provider} ${ladder[index]}`).toBeGreaterThanOrEqual(0.035);
        expect(Math.abs(hexToOklch(solids[index]).L - hexToOklch(muted[index]).L), `${provider} ${ladder[index]}`).toBeLessThan(0.002);
        if (index > 0) {
          expect(hexToOklch(solids[index - 1]).L).toBeLessThan(hexToOklch(solids[index]).L);
          expect(deltaEok(solids[index - 1], solids[index])).toBeGreaterThanOrEqual(0.035);
        }
      }
    }
  });

  it("E: keeps the ten simultaneous core series distinguishable, including CVD transforms", () => {
    const core = [...TIER_LADDER.anthropic, ...TIER_LADDER.openai, ...TIER_LADDER.xai].map((rung) => modelPaint(rung).color);
    const minPairwise = (colors: readonly string[]) => Math.min(...colors.flatMap((color, index) => colors.slice(index + 1).map((other) => deltaEok(color, other))));
    expect(minPairwise(core)).toBeGreaterThanOrEqual(0.035);
    // Gemini is intentionally excluded: it is not priced/stemmed and measured
    // too close to the core under tritan/protan transformations. Local is neutral.
    for (const matrix of [
      [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
      [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
      [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
    ]) expect(minPairwise(core.map((color) => simulateCvd(color, matrix)))).toBeGreaterThanOrEqual(0.025);
  });

  it("G: keeps neutral independently separated from the complete catalog", () => {
    for (const color of allGeneratedPaints()) expect(deltaEok(NEUTRAL_COLOR, color)).toBeGreaterThanOrEqual(0.05);
  });

  it("H: matches the measured regression hex table", () => {
    for (const [rung, solid, muted] of measured) {
      expectedNear(modelPaint(rung).color, solid);
      expectedNear(mutedForRung(rung), muted);
    }
    expectedNear(seriesPaint("google", "provider").color, "#008f6f");
    expectedNear(modelPaint("gemini-untiered").color, "#528674");
  });

  it("I: mirrors price.rs prices, stems, and provider strings", () => {
    const price = read("src-tauri/src/ailog/price.rs");
    const priceBlock = /pub const DEFAULT_PRICES:[\s\S]*?= &\[([\s\S]*?)\n\];/.exec(price)?.[1] ?? "";
    const pricedModels = [...priceBlock.matchAll(/\("([^"]+)", Price::/g)].map((match) => match[1]);
    const allLadderModels = Object.values(TIER_LADDER).flat();
    const ladderModels = new Set(allLadderModels);
    for (const model of pricedModels) expect(ladderModels.has(model) || Object.hasOwn(LEGACY_FAMILIES, model)).toBe(true);
    const stemsBlock = /const FAMILY_STEMS:[\s\S]*?= &\[([\s\S]*?)\n\];/.exec(price)?.[1] ?? "";
    const displayFamilies = [...stemsBlock.matchAll(/\("[^"]+", "([^"]+)"\)/g)].map((match) => match[1]);
    for (const family of displayFamilies) {
      expect(ladderModels.has(family) || allLadderModels.some((model) => model.startsWith(`${family}-`)) || Object.hasOwn(LEGACY_FAMILIES, family)).toBe(true);
    }
    expect(FAMILY_STEMS).toHaveLength(displayFamilies.length);
    const providerBlock = /provider_prefixes: &\[([\s\S]*?)\],/.exec(price)?.[1] ?? "";
    expect(providerBlock).not.toBe("");
    const asStrBlock = /pub const fn as_str[\s\S]*?match self \{([\s\S]*?)\n        \}/.exec(price)?.[1] ?? "";
    const providers = [...asStrBlock.matchAll(/Self::\w+ => "([^"]+)"/g)].map((match) => match[1]);
    expect(providers).not.toHaveLength(0);
    for (const provider of providers) {
      expect(Object.hasOwn(PROVIDER_HUE, provider) || HUELESS_PROVIDERS.has(provider), provider).toBe(true);
    }
  });

  it("J/K: enforces ladder limits, deterministic resolution, and fallback policies", () => {
    expect(Object.values(TIER_LADDER).every((ladder) => ladder.length <= 5)).toBe(true);
    const allRungs = new Set(Object.values(TIER_LADDER).flat());
    expect(Object.values(LEGACY_FAMILIES).every((parent) => allRungs.has(parent))).toBe(true);
    expect(seriesPaint("mycmux", "project")).toEqual(seriesPaint("mycmux", "project"));
    expect(modelPaint("claude-opus-5").color).toBe(modelPaint("opus-5").color);
    expect(modelPaint("claude-opus-5[1m]").color).toBe(modelPaint("opus-5").color);
    expect(hexToOklch(modelPaint("gpt-5.6-sol").color).L).toBeLessThan(hexToOklch(modelPaint("gpt-5.6-terra").color).L);
    expect(hexToOklch(modelPaint("claude-fable-5").color).L).toBeLessThan(hexToOklch(modelPaint("opus-5").color).L);
    expect(modelPaint("opus-4.8")).toEqual({ color: mutedForRung("opus-5"), tone: "muted" });
    expect(providerOf("grok-4.6")).toBe("xai");
    const unlisted = modelPaint("claude-totally-new-model");
    expect(unlisted).toEqual(UNTIERED_POLICY === "neutral" ? { color: NEUTRAL_COLOR, tone: "neutral" } : { color: mutedForRung("haiku-4.5"), tone: "muted" });
    expect(modelPaint("totally-unknown-x")).toEqual({ color: NEUTRAL_COLOR, tone: "neutral" });
    expect(modelPaint("ollama/llama3")).toEqual({ color: NEUTRAL_COLOR, tone: "neutral" });
    expect(modelPaint("fugu-ultra")).toEqual({ color: NEUTRAL_COLOR, tone: "neutral" });
    expect(seriesPaint("mycmux", "project").tone).toBe("solid");
    expect(seriesPaint("mycmux", "project").color).not.toBe(NEUTRAL_COLOR);
    expect(categoricalPaint("mycmux")).toEqual(seriesPaint("mycmux", "project"));
  });

  it("L: gives every hue-bearing provider the shared middle-band solid", () => {
    for (const provider of Object.keys(PROVIDER_HUE)) {
      const paint = seriesPaint(provider, "provider");
      expect(paint.tone, provider).toBe("solid");
      expect(Math.abs(hexToOklch(paint.color).L - 0.578), provider).toBeLessThan(0.002);
    }
    expect(seriesPaint("anthropic", "provider").color).not.toBe(modelPaint("claude-haiku-4-5").color);
    expect(seriesPaint("openai", "provider").color).not.toBe(modelPaint("gpt-5.4").color);
  });

  it("M: resolves collapsed families and every tier rung as solid model series", () => {
    expect(seriesPaint("gpt-5.6", "model")).toEqual({ color: modelPaint("gpt-5.6-terra").color, tone: "solid" });
    expect(seriesPaint("opus-5", "model")).toEqual({ color: modelPaint("claude-opus-5").color, tone: "solid" });
    expect(FAMILY_REPRESENTATIVE).toEqual({ "gpt-6": "gpt-6-astra", "gpt-5.6": "gpt-5.6-terra" });
    const rungs = Object.values(TIER_LADDER).flat();
    expect(rungs).toHaveLength(10);
    for (const rung of rungs) expect(seriesPaint(rung, "model").tone, rung).not.toBe("muted");
  });

  it("N: renders hue-less providers and local/flat model names as neutral", () => {
    for (const provider of HUELESS_PROVIDERS) {
      expect(seriesPaint(provider, "provider")).toEqual({ color: NEUTRAL_COLOR, tone: "neutral" });
    }
    for (const model of ["ollama/llama3", "fugu-ultra", "fugu/ultra"]) {
      expect(modelPaint(model)).toEqual({ color: NEUTRAL_COLOR, tone: "neutral" });
    }
    expect(providerOf("ollama/llama3")).toBeNull();
    expect(providerOf("fugu/ultra")).toBeNull();
  });
});

function simulateCvd(hex: string, matrix: readonly (readonly number[])[]): string {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const transformed = matrix.map((row) => Math.min(1, Math.max(0, row.reduce((sum, value, index) => sum + value * channels[index], 0))));
  return `#${transformed.map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;
}

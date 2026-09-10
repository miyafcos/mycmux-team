import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import PetSprite, { deriveRowsFromNatural, spriteAtlasStyle, type PetSpriteState } from "../../src/components/workspace/PetSprite";

describe("pet sprite atlas dimensions", () => {
  it("accepts both supported atlas formats", () => {
    expect(deriveRowsFromNatural(1536, 1872)).toBe(9);
    expect(deriveRowsFromNatural(1536, 2288)).toBe(11);
  });

  it("rejects nonstandard atlas dimensions", () => {
    expect(deriveRowsFromNatural(2504, 1878)).toBeNull();
    expect(deriveRowsFromNatural(1252, 939)).toBeNull();
  });

  it("uses the selected row count for background geometry", () => {
    expect(spriteAtlasStyle(208, 11, 7)).toEqual({
      backgroundSize: "1536px 2288px",
      backgroundPosition: "0 -1456px",
    });
  });
});

const contract: [PetSpriteState, number, number, number][] = [
  ["calling", 6, 6, 1010], ["stuck", 5, 8, 1220], ["working", 7, 6, 820],
  ["ready", 8, 6, 1030], ["resting", 0, 6, 6600],
];

describe("Codex pet animation contract", () => {
  it.each(contract)("%s uses row %i, %i frames and %i ms", (state, row, frames, duration) => {
    for (const rows of [9, 11]) {
      const html = renderToStaticMarkup(createElement(PetSprite, { atlasUrl: "pet.webp", state, height: 208, rows }));
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(rows);
      expect(html).toContain(`--pet-row-offset:${-row * 208}px`);
      expect(html).toContain(`--pet-frames:${frames}`);
      expect(html).toContain(`--pet-duration:${duration}ms`);
      expect(html).toContain(`background-size:1536px ${rows * 208}px`);
      expect(html).toContain(`--pet-animation:cmux-pet-sprite-${state === "resting" ? "resting" : frames}`);
      if (state === "resting") expect(html).toContain("animation-timing-function:step-end");
    }
  });

  const css = readFileSync(new URL("../../src/components/workspace/PetSprite.css", import.meta.url), "utf8");
  it("rests for the six unequal Codex frame durations", () => {
    const keyframes = css.split("@keyframes cmux-pet-sprite-resting {")[1].split("@keyframes")[0];
    const percentages = [...keyframes.matchAll(/([\d.]+)%/g)].map((match) => Number(match[1]));
    expect(percentages).toEqual([0, 25.4545, 35.4545, 45.4545, 58.1818, 70.9091, 100]);
    const durations = [1680, 660, 660, 840, 840, 1920];
    durations.forEach((duration, i) => expect((percentages[i + 1] - percentages[i]) * 66).toBeCloseTo(duration, 2));
    expect([...keyframes.matchAll(/\* -(\d)/g)].map((match) => Number(match[1]))).toEqual([1, 2, 3, 4, 5]);
  });
  it("keeps reduced motion on frame zero", () => {
    const reduced = css.split("@media (prefers-reduced-motion: reduce)")[1];
    expect(reduced).toContain("animation: none !important");
    expect(reduced).toContain("background-position: 0 var(--pet-row-offset) !important");
  });
  it("can disable animation explicitly", () => {
    expect(renderToStaticMarkup(createElement(PetSprite, { atlasUrl: "pet.webp", state: "resting", height: 40, animate: false }))).toContain("cmux-pet-sprite--static");
  });
});

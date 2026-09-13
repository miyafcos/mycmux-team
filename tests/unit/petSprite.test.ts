import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import PetSprite, { spriteAtlasStyle, spriteFrame, type PetSpriteState } from "../../src/components/workspace/PetSprite";
import { deriveRowsFromNatural } from "../../src/lib/petAtlasScale";

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
    expect(spriteAtlasStyle({ width: 192, height: 208 }, 11, 7)).toEqual({
      backgroundSize: "1536px 2288px",
      backgroundPosition: "0 -1456px",
    });
  });
});

describe("sprite frame on the device pixel grid", () => {
  // The sidebar sprite at the display scales Windows offers: every frame must
  // be whole device pixels, or the pre-scaled atlas would be resampled again.
  it.each([
    [1, 37, 40],
    [1.25, 46, 50],
    [1.5, 55, 60],
    [1.75, 65, 70],
    [2, 74, 80],
  ])("at %sx a 40px sprite is %ix%i device pixels", (ratio, deviceWidth, deviceHeight) => {
    const frame = spriteFrame(40, ratio);
    expect([frame.deviceWidth, frame.deviceHeight]).toEqual([deviceWidth, deviceHeight]);
    expect(frame.width * ratio).toBeCloseTo(deviceWidth, 9);
    expect(frame.height * ratio).toBeCloseTo(deviceHeight, 9);
    expect(Math.abs(frame.deviceWidth - frame.deviceHeight * 192 / 208)).toBeLessThanOrEqual(0.5);
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

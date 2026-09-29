import { describe, expect, it } from "vitest";
import { downscaleAtlasCells, sharpenAtlasCells, type AtlasPixels } from "../../src/lib/petAtlasScale";

type Rgba = [number, number, number, number];

function pixels(width: number, height: number, paint: (x: number, y: number) => Rgba): AtlasPixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  }
  return { data, width, height };
}

function at(image: AtlasPixels, x: number, y: number): number[] {
  const p = (y * image.width + x) * 4;
  return Array.from(image.data.slice(p, p + 4));
}

describe("pet atlas pre-scale", () => {
  it("keeps a flat colour exact at a non-integer ratio", () => {
    const out = downscaleAtlasCells(pixels(26, 7, () => [10, 200, 30, 255]), 2, 1, { width: 5, height: 3 });
    expect([out.width, out.height]).toEqual([10, 3]);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 10; x++) expect(at(out, x, y)).toEqual([10, 200, 30, 255]);
    }
  });

  it("weights each source pixel by how much of the output pixel it covers", () => {
    // A 3px cell shrunk to 2px: output 0 covers source [0, 1.5), output 1 covers [1.5, 3).
    const grey = [0, 90, 240];
    const out = downscaleAtlasCells(pixels(3, 1, (x) => [grey[x], grey[x], grey[x], 255]), 1, 1, { width: 2, height: 1 });
    expect(at(out, 0, 0)).toEqual([30, 30, 30, 255]);
    expect(at(out, 1, 0)).toEqual([190, 190, 190, 255]);
  });

  it("does not let a transparent pixel's colour tint the edge", () => {
    // Opaque white beside fully transparent magenta, the colour cut-out characters leave behind.
    const out = downscaleAtlasCells(pixels(2, 1, (x) => (x === 0 ? [255, 255, 255, 255] : [255, 0, 255, 0])), 1, 1, { width: 1, height: 1 });
    expect(at(out, 0, 0)).toEqual([255, 255, 255, 128]);
  });

  it("weights colour by alpha across partly transparent pixels", () => {
    // 3/4-opaque red beside 1/4-opaque blue mixes 3:1, while alpha is the plain mean.
    const out = downscaleAtlasCells(pixels(2, 1, (x) => (x === 0 ? [255, 0, 0, 192] : [0, 0, 255, 64])), 1, 1, { width: 1, height: 1 });
    expect(at(out, 0, 0)).toEqual([191, 0, 64, 128]);
  });

  it("never reaches into the neighbouring frame", () => {
    // Cell 0 is empty and cell 1 solid red; 7px cells shrunk to 3px put output pixels across source seams.
    const out = downscaleAtlasCells(pixels(14, 7, (x) => (x < 7 ? [0, 0, 0, 0] : [255, 0, 0, 255])), 2, 1, { width: 3, height: 3 });
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) expect(at(out, x, y)).toEqual([0, 0, 0, 0]);
      for (let x = 3; x < 6; x++) expect(at(out, x, y)).toEqual([255, 0, 0, 255]);
    }
  });

  it("gives the same pixels one row of cells at a time as for the whole atlas", () => {
    // The app shrinks one row of cells per task, which must not change a single pixel.
    const paint = (x: number, y: number): Rgba => [(x * 37 + y * 11) % 256, (x * 5) % 256, (y * 23) % 256, (x + y) % 3 === 0 ? 255 : 90];
    const whole = downscaleAtlasCells(pixels(16, 21, paint), 2, 3, { width: 3, height: 4 });
    for (let row = 0; row < 3; row++) {
      const alone = downscaleAtlasCells(pixels(16, 7, (x, y) => paint(x, row * 7 + y)), 2, 1, { width: 3, height: 4 });
      const rowBytes = 6 * 4 * 4;
      expect(Array.from(alone.data)).toEqual(Array.from(whole.data.slice(row * rowBytes, (row + 1) * rowBytes)));
    }
  });

  it("sharpening leaves a flat opaque cell exactly as it was", () => {
    const out = sharpenAtlasCells(pixels(12, 10, () => [40, 120, 200, 255]), 2, 1);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 12; x++) expect(at(out, x, y)).toEqual([40, 120, 200, 255]);
    }
  });

  it("sharpening raises the contrast across an edge inside the cell", () => {
    // A soft grey ramp between a dark outline and a white interior, as the area average leaves it.
    const ramp = [30, 30, 30, 90, 170, 230, 230, 230];
    const out = sharpenAtlasCells(pixels(8, 3, (x) => [ramp[x], ramp[x], ramp[x], 255]), 1, 1);
    expect(at(out, 3, 1)[0]).toBeLessThan(90);
    expect(at(out, 4, 1)[0]).toBeGreaterThan(170);
  });

  it("sharpening never paints outside the character", () => {
    // A white square in the middle of a transparent cell: every transparent pixel must stay transparent.
    const out = sharpenAtlasCells(pixels(10, 10, (x, y) => (x >= 3 && x < 7 && y >= 3 && y < 7 ? [255, 255, 255, 255] : [0, 0, 0, 0])), 1, 1);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        if (x < 3 || x >= 7 || y < 3 || y >= 7) expect(at(out, x, y)[3]).toBe(0);
      }
    }
  });

  it("sharpening does not strengthen the tint of a partly covered edge pixel", () => {
    // A dark outline whose soft edge still carries a trace of the magenta it was cut from.
    const out = sharpenAtlasCells(pixels(6, 3, (x) => (x < 3 ? [40, 40, 40, 255] : x === 3 ? [90, 40, 90, 128] : [0, 0, 0, 0])), 1, 1);
    expect(at(out, 3, 1).slice(0, 3)).toEqual([90, 40, 90]);
    expect(at(out, 3, 1)[3]).not.toBe(128);
  });

  it("sharpening does not reach into the neighbouring frame", () => {
    // Cell 0 is empty, cell 1 solid red: the seam must not pick up or push anything across.
    const out = sharpenAtlasCells(pixels(8, 4, (x) => (x < 4 ? [0, 0, 0, 0] : [255, 0, 0, 255])), 2, 1);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) expect(at(out, x, y)).toEqual([0, 0, 0, 0]);
      for (let x = 4; x < 8; x++) expect(at(out, x, y)).toEqual([255, 0, 0, 255]);
    }
  });
});

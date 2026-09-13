import { describe, expect, it } from "vitest";
import { downscaleAtlasCells, type AtlasPixels } from "../../src/lib/petAtlasScale";

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
});

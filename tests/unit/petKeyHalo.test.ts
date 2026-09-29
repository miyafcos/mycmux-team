import { describe, expect, it } from "vitest";
import type { AtlasPixels } from "../../src/lib/petAtlasScale";
import { cleanKeyHalo, estimateKeyColours } from "../../src/lib/petKeyHalo";

type Rgba = [number, number, number, number];
const MAGENTA: Rgba = [255, 0, 255, 0];
const BLACK: Rgba = [0, 0, 0, 255];
const WHITE: Rgba = [255, 255, 255, 255];

function mix(share: number, outline: [number, number, number], key: [number, number, number]): Rgba {
  return [
    Math.round(outline[0] + share * (key[0] - outline[0])),
    Math.round(outline[1] + share * (key[1] - outline[1])),
    Math.round(outline[2] + share * (key[2] - outline[2])),
    255,
  ];
}

/** A square character: 2 px black outline, `fill` inside, on a keyed background, with an optional halo rim. */
function character(size: number, fill: Rgba, options: { halo?: boolean; keyUnderTransparent?: boolean; faintKey?: boolean } = {}): AtlasPixels {
  const data = new Uint8ClampedArray(size * size * 4);
  const margin = 6;
  const put = (x: number, y: number, c: Rgba) => data.set(c, (y * size + x) * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inset = Math.min(x, y, size - 1 - x, size - 1 - y) - margin;
      let c: Rgba;
      if (inset < 0) c = options.keyUnderTransparent === false ? [0, 0, 0, 0] : MAGENTA;
      else if (inset < 2) c = options.halo ? mix(inset === 0 ? 0.3 : 0.2, [0, 0, 0], [255, 0, 255]) : BLACK;
      else if (inset < 4) c = BLACK;
      else c = fill;
      put(x, y, c);
    }
  }
  if (options.faintKey) {
    // The band of nearly transparent key residue just outside the rim. Its
    // colour is un-premultiplied: key / alpha, quantised, as the real atlases store it.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inset = Math.min(x, y, size - 1 - x, size - 1 - y) - margin;
        if (inset === -1) put(x, y, [85, 0, 85, 3]);
      }
    }
  }
  return { data, width: size, height: size };
}

function at(image: AtlasPixels, x: number, y: number): number[] {
  const p = (y * image.width + x) * 4;
  return Array.from(image.data.slice(p, p + 4));
}

describe("pet key halo", () => {
  it("reads the key from the transparent area", () => {
    const halo = estimateKeyColours(character(40, WHITE, { halo: true }));
    expect(halo).toEqual([[255, 0, 255]]);
  });

  it("reads the key from nearly transparent residue when the transparent area is black", () => {
    const halo = estimateKeyColours(character(40, WHITE, { halo: true, keyUnderTransparent: false, faintKey: true }));
    expect(halo).toEqual([[255, 0, 255]]);
  });

  it("finds no key in an atlas without one", () => {
    expect(estimateKeyColours(character(40, WHITE, { keyUnderTransparent: false }))).toEqual([]);
  });

  it("turns the rim back into an anti-aliased outline and leaves the inside alone", () => {
    const image = character(40, WHITE, { halo: true, faintKey: true });
    const before = new Uint8ClampedArray(image.data);
    const { changed } = cleanKeyHalo(image);
    expect(changed).toBeGreaterThan(0);
    // Rim (inset 0 and 1): the mixes (77,0,77) and (51,0,51) become black at alpha 255*(1-M).
    expect(at(image, 6, 20)).toEqual([0, 0, 0, 255 - 77]);
    expect(at(image, 7, 20)).toEqual([0, 0, 0, 255 - 51]);
    // Faint residue outside: still alpha 3, now outline-coloured.
    expect(at(image, 5, 20)).toEqual([0, 0, 0, 3]);
    // Solid outline and fill untouched.
    expect(at(image, 8, 20)).toEqual([0, 0, 0, 255]);
    expect(at(image, 20, 20)).toEqual([255, 255, 255, 255]);
    // Transparent pixels untouched.
    expect(at(image, 2, 2)).toEqual([255, 0, 255, 0]);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) expect(at(image, x, y)).toEqual(Array.from(before.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)));
  });

  it("does not fade art of the key's hue that continues inward", () => {
    // A purple shirt (on the black-magenta line) filling the character right up to its outline.
    const purple: Rgba = [210, 2, 212, 255];
    const image = character(40, purple, { halo: false });
    // Replace the outline with the shirt colour so the edge itself is purple art.
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        const inset = Math.min(x, y, 39 - x, 39 - y) - 6;
        if (inset >= 0 && inset < 4) image.data.set(purple, (y * 40 + x) * 4);
      }
    }
    cleanKeyHalo(image);
    expect(at(image, 6, 20)).toEqual(purple);
    expect(at(image, 7, 20)).toEqual(purple);
  });

  it("does not touch colours off the outline-key line", () => {
    // Pink is not a black-magenta mix. On the left half it reaches the edge in
    // place of the outline; the right half keeps the haloed black outline.
    const pink: Rgba = [255, 150, 200, 255];
    const image = character(40, pink, { halo: true });
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 20; x++) {
        const inset = Math.min(x, y, 39 - x, 39 - y) - 6;
        if (inset >= 0 && inset < 4) image.data.set(pink, (y * 40 + x) * 4);
      }
    }
    expect(cleanKeyHalo(image).keys).toEqual([[255, 0, 255]]);
    expect(at(image, 6, 20)).toEqual(pink);
    expect(at(image, 7, 20)).toEqual(pink);
    expect(at(image, 20, 20)).toEqual(pink);
    // The halo rim on the right was still cleaned.
    expect(at(image, 33, 20)).toEqual([0, 0, 0, 255 - 77]);
  });
});

/**
 * Removes the chroma-key halo that cut-out pet art carries along its outline.
 *
 * Pets are usually cut out of a flat key colour (magenta, in every atlas seen
 * so far). The cut leaves a 1-2 px rim of opaque pixels whose colour is the
 * outline with the key mixed in, plus near-transparent pixels whose colour is
 * the key itself. A nearest-neighbour shrink picks single rim texels, so the
 * rim shows as key-coloured squares that jump from frame to frame; an area
 * average tints the whole outline instead. Both go away when the key's share
 * is taken back out of the rim before scaling.
 *
 * Nothing here knows any particular pet. A key is a pure hue (red, yellow,
 * green, cyan, blue or magenta) that the atlas's own transparent and nearly
 * transparent pixels carry and that the character itself does not wear. A rim
 * pixel is compared with the nearest clean opaque pixel further in (its own
 * outline), and only a colour that is a mix of that pixel and the key is
 * corrected. Art of the key's hue that carries on inward (a purple shirt
 * reaching the edge) has no clean pixel near it and is left alone; art off the
 * outline-key line (a pink body) is never a mix and is left alone too.
 */

import type { AtlasPixels } from "./petAtlasScale";

export type Rgb = [number, number, number];

/** Deepest edge band that may be halo (the rims seen were 1-2 px). */
const RIM_DEPTH = 2;
/** How far inward to look for the pixel a rim pixel should return to. */
const OUTLINE_REACH = 3;
/** From this depth on, a pixel is the character proper rather than its edge. */
const INTERIOR_DEPTH = 4;
/** How far a colour may sit off the outline-key line and still count as a mix of the two. */
const AXIS_TOLERANCE = 48;
const MIN_KEY_SHARE = 0.08;
/** Alpha at and below which a pixel is background (the key residue lives here). */
const FAINT_ALPHA = 32;
/** A key must own at least this share of the pure-hued background residue... */
const KEY_MIN_BACKGROUND_SHARE = 0.4;
/** ...and this many pixels of it (or 0.03% of the atlas, whichever is more). */
const KEY_MIN_SAMPLES = 32;
/** A hue the character wears on more than this share of its interior is not a key. */
const KEY_MAX_INTERIOR_SHARE = 0.01;
/** A key tints the rim all around the silhouette; a colour on fewer rim pixels than this is a local detail. */
const KEY_MIN_RIM_SHARE = 0.1;
/** A visible pixel that is nearly all key is art in the key's colour, not a mix. */
const MAX_OPAQUE_KEY_SHARE = 0.8;
/**
 * Key residue is un-premultiplied: at alpha a the stored colour is key/a, so
 * brightness x alpha stays about 255 whatever the alpha ((255,0,255) at 1,
 * (127,0,127) at 2, (85,0,85) at 3...). A character's own anti-aliasing keeps
 * its colour at every alpha, so the product grows with alpha instead.
 */
const MAX_RESIDUE_PRODUCT = 512;
const HUE_BINS = 6;

function saturation(r: number, g: number, b: number): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** Hue in degrees, 0-360. */
function hue(r: number, g: number, b: number): number {
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const span = hi - lo;
  if (span === 0) return 0;
  let h: number;
  if (hi === r) h = ((g - b) / span) % 6;
  else if (hi === g) h = (b - r) / span + 2;
  else h = (r - g) / span + 4;
  return ((h * 60) % 360 + 360) % 360;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Whether a colour is one of the six pure hues, allowing for quantised residue. */
function pureHue(r: number, g: number, b: number): boolean {
  const lo = Math.min(r, g, b);
  const hi = Math.max(r, g, b);
  const span = hi - lo || 1;
  const middle = ((r + g + b - lo - hi - lo) * 255) / span;
  return middle <= 32 || middle >= 223;
}

/** Whether a colour's hue leans the same way as the key's. */
function keyLike(r: number, g: number, b: number, key: Rgb): boolean {
  if (saturation(r, g, b) < 30) return false;
  const grey = (r + g + b) / 3;
  const keyGrey = (key[0] + key[1] + key[2]) / 3;
  const dr = r - grey;
  const dg = g - grey;
  const db = b - grey;
  const kr = key[0] - keyGrey;
  const kg = key[1] - keyGrey;
  const kb = key[2] - keyGrey;
  const norm = Math.sqrt(dr * dr + dg * dg + db * db) * Math.sqrt(kr * kr + kg * kg + kb * kb);
  return norm > 0 && (dr * kr + dg * kg + db * kb) / norm > 0.8;
}

/** Chessboard distance from the nearest background (alpha <= FAINT_ALPHA) pixel, capped at `cap`. */
function distanceToBackground(data: Uint8ClampedArray, width: number, height: number, cap: number): Uint8Array {
  const dist = new Uint8Array(width * height);
  // Two chamfer passes: distances flow down-right, then up-left.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (data[i * 4 + 3] <= FAINT_ALPHA) {
        dist[i] = 0;
        continue;
      }
      let best = cap;
      if (y > 0) {
        const up = i - width;
        if (dist[up] + 1 < best) best = dist[up] + 1;
        if (x > 0 && dist[up - 1] + 1 < best) best = dist[up - 1] + 1;
        if (x < width - 1 && dist[up + 1] + 1 < best) best = dist[up + 1] + 1;
      }
      if (x > 0 && dist[i - 1] + 1 < best) best = dist[i - 1] + 1;
      dist[i] = best;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let best = dist[i];
      if (best === 0) continue;
      if (y < height - 1) {
        const down = i + width;
        if (dist[down] + 1 < best) best = dist[down] + 1;
        if (x > 0 && dist[down - 1] + 1 < best) best = dist[down - 1] + 1;
        if (x < width - 1 && dist[down + 1] + 1 < best) best = dist[down + 1] + 1;
      }
      if (x < width - 1 && dist[i + 1] + 1 < best) best = dist[i + 1] + 1;
      dist[i] = best;
    }
  }
  return dist;
}

/**
 * The key colours an atlas (or one band of it) was cut out of: pure hues that
 * make up a good share of its background residue and that the character does
 * not wear itself. Empty when there is no sign of a key.
 */
export function estimateKeyColours(source: AtlasPixels, dist: Uint8Array = distanceToBackground(source.data, source.width, source.height, INTERIOR_DEPTH + 1)): Rgb[] {
  const { data, width, height } = source;
  const n = width * height;
  const counts = new Int32Array(HUE_BINS);
  const sums = new Float64Array(HUE_BINS * 3);
  const products: number[][] = Array.from({ length: HUE_BINS }, () => []);
  let samples = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (data[p + 3] > FAINT_ALPHA) continue;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    if (saturation(r, g, b) < 64 || !pureHue(r, g, b)) continue;
    const bin = Math.round(hue(r, g, b) / 60) % HUE_BINS;
    counts[bin]++;
    products[bin].push(Math.max(r, g, b) * data[p + 3]);
    // Stretched to full saturation, so every alpha's quantised residue of one key adds up to the same colour.
    const lo = Math.min(r, g, b);
    const span = Math.max(r, g, b) - lo;
    sums[bin * 3] += ((r - lo) * 255) / span;
    sums[bin * 3 + 1] += ((g - lo) * 255) / span;
    sums[bin * 3 + 2] += ((b - lo) * 255) / span;
    samples++;
  }
  const minSamples = Math.max(KEY_MIN_SAMPLES, n * 0.0003);
  const keys: Rgb[] = [];
  for (let bin = 0; bin < HUE_BINS; bin++) {
    if (counts[bin] < minSamples || counts[bin] < samples * KEY_MIN_BACKGROUND_SHARE) continue;
    const sorted = products[bin].sort((a, b) => a - b);
    if (sorted[sorted.length >> 1] > MAX_RESIDUE_PRODUCT) continue;
    const key: Rgb = [Math.round(sums[bin * 3] / counts[bin]), Math.round(sums[bin * 3 + 1] / counts[bin]), Math.round(sums[bin * 3 + 2] / counts[bin])];
    const keyHue = hue(key[0], key[1], key[2]);
    // A hue the character wears inside is its own, whatever the background
    // says; and a key tints the rim everywhere, where a detail's own
    // anti-aliasing only tints it locally.
    let interior = 0;
    let worn = 0;
    let rim = 0;
    let rimTinted = 0;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      if (data[p + 3] !== 255 || dist[i] === 0) continue;
      if (dist[i] >= INTERIOR_DEPTH) {
        interior++;
        if (saturation(data[p], data[p + 1], data[p + 2]) >= 60 && hueDistance(hue(data[p], data[p + 1], data[p + 2]), keyHue) <= 15) worn++;
      } else if (dist[i] <= RIM_DEPTH) {
        rim++;
        if (keyLike(data[p], data[p + 1], data[p + 2], key)) rimTinted++;
      }
    }
    if (interior > 0 && worn > interior * KEY_MAX_INTERIOR_SHARE) continue;
    if (rim === 0 || rimTinted < rim * KEY_MIN_RIM_SHARE) continue;
    keys.push(key);
  }
  return keys;
}

/**
 * Takes one key's share back out of the rim, in place.
 *
 * A rim pixel is its outline with a share M of the key mixed in; it becomes
 * the outline colour at alpha * (1 - M), the anti-aliased edge the key should
 * have left behind. Returns how many pixels changed.
 */
export function removeKeyHalo(source: AtlasPixels, key: Rgb, dist: Uint8Array = distanceToBackground(source.data, source.width, source.height, RIM_DEPTH + OUTLINE_REACH + 1)): number {
  const { data, width, height } = source;
  const n = width * height;
  const tinted = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (data[p + 3] > 0 && keyLike(data[p], data[p + 1], data[p + 2], key)) tinted[i] = 1;
  }
  // Nearest clean opaque pixel further in than (x, y), as an index, or -1.
  const outlineFor = (x: number, y: number, d: number): number => {
    for (let reach = 1; reach <= OUTLINE_REACH; reach++) {
      const y0 = Math.max(0, y - reach);
      const y1 = Math.min(height - 1, y + reach);
      const x0 = Math.max(0, x - reach);
      const x1 = Math.min(width - 1, x + reach);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (Math.max(Math.abs(xx - x), Math.abs(yy - y)) !== reach) continue;
          const j = yy * width + xx;
          if (dist[j] > d && !tinted[j] && data[j * 4 + 3] === 255) return j;
        }
      }
    }
    return -1;
  };
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!tinted[i]) continue;
      const p = i * 4;
      const d = dist[i];
      if (d > RIM_DEPTH) continue;
      const j = outlineFor(x, y, d);
      if (j < 0) continue;
      const q = j * 4;
      if (d === 0) {
        // Nearly transparent key residue: give it its outline's colour so no
        // renderer can tint the edge with it.
        data[p] = data[q];
        data[p + 1] = data[q + 1];
        data[p + 2] = data[q + 2];
        changed++;
        continue;
      }
      const ar = key[0] - data[q];
      const ag = key[1] - data[q + 1];
      const ab = key[2] - data[q + 2];
      const axisLength = ar * ar + ag * ag + ab * ab;
      if (axisLength < 128 * 128) continue;
      const cr = data[p] - data[q];
      const cg = data[p + 1] - data[q + 1];
      const cb = data[p + 2] - data[q + 2];
      const m = Math.min(1, Math.max(0, (cr * ar + cg * ag + cb * ab) / axisLength));
      const rr = cr - m * ar;
      const rg = cg - m * ag;
      const rb = cb - m * ab;
      if (m < MIN_KEY_SHARE || rr * rr + rg * rg + rb * rb > AXIS_TOLERANCE * AXIS_TOLERANCE) continue;
      if (m > MAX_OPAQUE_KEY_SHARE) continue;
      data[p] = data[q];
      data[p + 1] = data[q + 1];
      data[p + 2] = data[q + 2];
      data[p + 3] = Math.round(data[p + 3] * (1 - m));
      changed++;
    }
  }
  return changed;
}

/**
 * Removes the halo of every key an atlas (or band) was cut out of, in place.
 * `keys` defaults to what this band shows; pass the keys pooled over the whole
 * atlas instead, since a band with little residue of its own still carries
 * the same rim.
 */
export function cleanKeyHalo(source: AtlasPixels, keys?: readonly Rgb[]): { keys: Rgb[]; changed: number } {
  const dist = distanceToBackground(source.data, source.width, source.height, Math.max(INTERIOR_DEPTH, RIM_DEPTH + OUTLINE_REACH) + 1);
  // Bands read the same key a unit or two apart; one pass per hue is enough.
  const used: Rgb[] = [];
  for (const key of keys ?? estimateKeyColours(source, dist)) {
    if (!used.some((seen) => hueDistance(hue(...seen), hue(...key)) <= 15)) used.push(key);
  }
  let changed = 0;
  for (const key of used) changed += removeKeyHalo(source, key, dist);
  return { keys: used, changed };
}

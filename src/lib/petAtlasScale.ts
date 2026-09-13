/**
 * Pre-scales Codex pet atlases to the exact device pixels they are painted at.
 *
 * Atlas cells are 192x208, but the sidebar shows a frame 40px tall, so every
 * paint had to shrink it about 5x at 100% scale (3.5x at 150%). PetSprite did
 * that shrink with `image-rendering: pixelated`, which on a shrink is nearest
 * neighbour: each screen pixel copied one source pixel and dropped the rest.
 * Outlines broke into dots, and the half-transparent magenta left around
 * cut-out characters was picked up at full strength. Which pixels survived
 * changed with the animation frame and the display scale, so the sprite
 * looked noisy at some moments and clean at others. Averaging every device
 * pixel's whole footprint once, here, and painting the result 1:1 takes the
 * resampling out of paint altogether.
 */

import { cleanKeyHalo, estimateKeyColours, type Rgb } from "./petKeyHalo";

const ATLAS_COLUMNS = 8;

/**
 * Transparent device pixels right of and below every pre-scaled cell. The
 * sprite box is exactly one cell, so a renderer that samples a pixel or two
 * past its edge (rounding, a driver's filtering, a scaled layer) lands in the
 * gutter instead of on the neighbouring frame.
 */
export const PRESCALE_GUTTER = 2;

export function deriveRowsFromNatural(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width % ATLAS_COLUMNS !== 0) return null;
  const cellWidth = width / ATLAS_COLUMNS;
  const rowHeight = cellWidth * 208 / 192;
  const rawRows = height / rowHeight;
  const rows = Math.round(rawRows);
  return Math.abs(rawRows - rows) < 0.001 && rows >= 9 && rows <= 11 ? rows : null;
}

export interface AtlasPixels {
  /** RGBA with straight (not premultiplied) alpha, as getImageData returns it. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface BoxTaps {
  first: Int32Array;
  count: Int32Array;
  offset: Int32Array;
  weight: Float64Array;
}

/** For each output pixel: the source pixels its footprint overlaps, and the share of the footprint each covers. */
function boxTaps(sourceSize: number, outputSize: number): BoxTaps {
  const step = sourceSize / outputSize;
  const first = new Int32Array(outputSize);
  const count = new Int32Array(outputSize);
  const offset = new Int32Array(outputSize);
  const weights: number[] = [];
  for (let i = 0; i < outputSize; i++) {
    const lo = i * step;
    const hi = Math.min(sourceSize, (i + 1) * step);
    const start = Math.min(sourceSize - 1, Math.floor(lo));
    const end = Math.max(start + 1, Math.min(sourceSize, Math.ceil(hi)));
    first[i] = start;
    count[i] = end - start;
    offset[i] = weights.length;
    const overlaps: number[] = [];
    for (let s = start; s < end; s++) overlaps.push(Math.max(0, Math.min(hi, s + 1) - Math.max(lo, s)));
    const total = overlaps.reduce((sum, overlap) => sum + overlap, 0);
    for (const overlap of overlaps) weights.push(total > 0 ? overlap / total : 1 / overlaps.length);
  }
  return { first, count, offset, weight: Float64Array.from(weights) };
}

/**
 * Area-averages every cell of a `columns` x `rows` atlas down to `cell` pixels.
 *
 * Footprints are clipped to their own cell, so a frame never picks up the edge
 * of its neighbour, and colour is weighted by alpha, so a transparent pixel
 * (whatever colour it happens to carry) cannot tint or darken an outline.
 */
export function downscaleAtlasCells(
  source: AtlasPixels,
  columns: number,
  rows: number,
  cell: { width: number; height: number },
): AtlasPixels {
  const sourceCellWidth = source.width / columns;
  const sourceCellHeight = source.height / rows;
  const width = columns * cell.width;
  const height = rows * cell.height;
  const data = new Uint8ClampedArray(width * height * 4);
  const across = boxTaps(sourceCellWidth, cell.width);
  const down = boxTaps(sourceCellHeight, cell.height);
  const src = source.data;
  // One row of cells, already narrowed but still full height, premultiplied.
  const band = new Float64Array(width * sourceCellHeight * 4);
  for (let row = 0; row < rows; row++) {
    for (let y = 0; y < sourceCellHeight; y++) {
      const sourceLine = (row * sourceCellHeight + y) * source.width;
      const bandLine = y * width;
      for (let column = 0; column < columns; column++) {
        const sourceCell = sourceLine + column * sourceCellWidth;
        const bandCell = bandLine + column * cell.width;
        for (let x = 0; x < cell.width; x++) {
          const from = sourceCell + across.first[x];
          const weightAt = across.offset[x];
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (let t = 0; t < across.count[x]; t++) {
            const p = (from + t) * 4;
            const w = across.weight[weightAt + t] * src[p + 3];
            r += w * src[p];
            g += w * src[p + 1];
            b += w * src[p + 2];
            a += w;
          }
          const q = (bandCell + x) * 4;
          band[q] = r;
          band[q + 1] = g;
          band[q + 2] = b;
          band[q + 3] = a;
        }
      }
    }
    for (let y = 0; y < cell.height; y++) {
      const outputLine = (row * cell.height + y) * width;
      const from = down.first[y];
      const weightAt = down.offset[y];
      const taps = down.count[y];
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let t = 0; t < taps; t++) {
          const q = ((from + t) * width + x) * 4;
          const w = down.weight[weightAt + t];
          r += w * band[q];
          g += w * band[q + 1];
          b += w * band[q + 2];
          a += w * band[q + 3];
        }
        if (a <= 0) continue;
        const p = (outputLine + x) * 4;
        data[p] = r / a;
        data[p + 1] = g / a;
        data[p + 2] = b / a;
        data[p + 3] = a;
      }
    }
  }
  return { data, width, height };
}

/** Unsharp-mask strength and blur (Gaussian sigma, output px): chosen by eye against Lanczos and bicubic, 2026-09-14. */
const SHARPEN_AMOUNT = 0.9;
const SHARPEN_SIGMA = 0.7;

/**
 * Unsharp mask on every cell of a `columns` x `rows` atlas, each cell on its own.
 *
 * An area average is exact but soft: a 1px outline shared with a white
 * interior comes out grey. Pushing each pixel away from its blurred
 * surroundings brings the contrast back without bringing back the noise.
 * Outside a cell counts as transparent (what surrounds the sprite on
 * screen), and a transparent pixel stays transparent, so sharpening can only
 * act inward.
 */
export function sharpenAtlasCells(
  source: AtlasPixels,
  columns: number,
  rows: number,
  amount = SHARPEN_AMOUNT,
  sigma = SHARPEN_SIGMA,
): AtlasPixels {
  const { width, height } = source;
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const n = width * height;
  const src = source.data;
  const premultiplied = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const a = src[p + 3] / 255;
    premultiplied[p] = src[p] * a;
    premultiplied[p + 1] = src[p + 1] * a;
    premultiplied[p + 2] = src[p + 2] * a;
    premultiplied[p + 3] = src[p + 3];
  }
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let t = -radius; t <= radius; t++) total += kernel[t + radius] = Math.exp(-(t * t) / (2 * sigma * sigma));
  for (let t = 0; t < kernel.length; t++) kernel[t] /= total;
  const across = new Float32Array(n * 4);
  const blurred = new Float32Array(n * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cellStart = x - (x % cellWidth);
      const lo = Math.max(cellStart, x - radius);
      const hi = Math.min(cellStart + cellWidth - 1, x + radius);
      const q = (y * width + x) * 4;
      for (let xx = lo; xx <= hi; xx++) {
        const w = kernel[xx - x + radius];
        const p = (y * width + xx) * 4;
        across[q] += w * premultiplied[p];
        across[q + 1] += w * premultiplied[p + 1];
        across[q + 2] += w * premultiplied[p + 2];
        across[q + 3] += w * premultiplied[p + 3];
      }
    }
  }
  for (let y = 0; y < height; y++) {
    const cellStart = y - (y % cellHeight);
    const lo = Math.max(cellStart, y - radius);
    const hi = Math.min(cellStart + cellHeight - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const q = (y * width + x) * 4;
      for (let yy = lo; yy <= hi; yy++) {
        const w = kernel[yy - y + radius];
        const p = (yy * width + x) * 4;
        blurred[q] += w * across[p];
        blurred[q + 1] += w * across[p + 1];
        blurred[q + 2] += w * across[p + 2];
        blurred[q + 3] += w * across[p + 3];
      }
    }
  }
  // Colour is pushed away from the alpha-weighted mean of its surroundings, so
  // transparent neighbours do not count as black (a flat colour stays flat up
  // to the silhouette); alpha is sharpened on its own, which tightens the
  // silhouette's soft edge. Only a pixel the character fully covers gets its
  // colour sharpened: a partly covered one (the silhouette, a whisker) also
  // holds whatever the character was cut out of, and pushing it away from its
  // neighbours would turn that trace into a visible tint.
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const alpha = premultiplied[p + 3];
    if (alpha <= 0) continue;
    const a = Math.min(255, Math.max(0, alpha + amount * (alpha - blurred[p + 3])));
    if (a <= 0) continue;
    const around = blurred[p + 3];
    const colourAmount = alpha >= 255 ? amount : 0;
    for (let c = 0; c < 3; c++) {
      const own = (premultiplied[p + c] * 255) / alpha;
      const mean = around > 0 ? (blurred[p + c] * 255) / around : own;
      data[p + c] = own + colourAmount * (own - mean);
    }
    data[p + 3] = a;
  }
  return { data, width, height };
}

export interface PrescaledAtlas {
  /** Object URL of a PNG whose cells are exactly one frame in device pixels, each followed by PRESCALE_GUTTER transparent pixels. */
  url: string;
  rows: number;
}

interface PrescaleEntry {
  settled: boolean;
  value: PrescaledAtlas | null;
  promise: Promise<PrescaledAtlas | null>;
}

// ponytail: never evicted. It holds one small PNG per pet x sprite size x
// display scale seen in a session (a few dozen at most); revoke the object
// URLs on eviction if pets ever become numerous.
const prescaled = new Map<string, Map<string, PrescaleEntry>>();

function sizeKey(deviceWidth: number, deviceHeight: number, onlyRows: readonly number[]): string {
  return `${deviceWidth}x${deviceHeight}:${onlyRows.join(",")}`;
}

/** The finished pre-scale: undefined while it is still being built, null when it could not be. */
export function peekPrescaledAtlas(
  atlasUrl: string,
  deviceWidth: number,
  deviceHeight: number,
  onlyRows: readonly number[],
): PrescaledAtlas | null | undefined {
  const entry = prescaled.get(atlasUrl)?.get(sizeKey(deviceWidth, deviceHeight, onlyRows));
  return entry?.settled ? entry.value : undefined;
}

/** Builds (once per atlas and size) the atlas with every cell shrunk to `deviceWidth` x `deviceHeight`. */
export function prescalePetAtlas(
  atlasUrl: string,
  deviceWidth: number,
  deviceHeight: number,
  onlyRows: readonly number[],
): Promise<PrescaledAtlas | null> {
  let bySize = prescaled.get(atlasUrl);
  if (!bySize) {
    bySize = new Map();
    prescaled.set(atlasUrl, bySize);
  }
  const key = sizeKey(deviceWidth, deviceHeight, onlyRows);
  const existing = bySize.get(key);
  if (existing) return existing.promise;
  const entry: PrescaleEntry = { settled: false, value: null, promise: Promise.resolve(null) };
  entry.promise = buildPrescaledAtlas(atlasUrl, deviceWidth, deviceHeight, onlyRows)
    .catch((error: unknown) => {
      console.warn("[mycmux] pet atlas pre-scale failed; the browser's own scaling is used instead", error);
      return null;
    })
    .then((value) => {
      entry.settled = true;
      entry.value = value;
      return value;
    });
  bySize.set(key, entry);
  return entry.promise;
}

async function buildPrescaledAtlas(
  atlasUrl: string,
  deviceWidth: number,
  deviceHeight: number,
  onlyRows: readonly number[],
): Promise<PrescaledAtlas | null> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return null;
  // Decoded off the main thread. Drawing an <img> into the canvas instead made
  // the first pixel read decode the whole atlas again on the main thread.
  const bitmap = await createImageBitmap(await (await fetch(atlasUrl)).blob());
  try {
    const rows = deriveRowsFromNatural(bitmap.width, bitmap.height);
    if (rows === null) return null;
    const sourceCellHeight = bitmap.height / rows;
    const band = document.createElement("canvas");
    band.width = bitmap.width;
    band.height = sourceCellHeight;
    const bandContext = band.getContext("2d", { willReadFrequently: true });
    const output = document.createElement("canvas");
    const pitchWidth = deviceWidth + PRESCALE_GUTTER;
    const pitchHeight = deviceHeight + PRESCALE_GUTTER;
    output.width = ATLAS_COLUMNS * pitchWidth;
    output.height = rows * pitchHeight;
    const outputContext = output.getContext("2d");
    if (!bandContext || !outputContext) return null;
    // The key colours the character was cut out of, pooled over every band:
    // a band with little residue of its own still carries the same rim.
    const keys: Rgb[] = [];
    const readBand = (row: number) => {
      bandContext.clearRect(0, 0, band.width, band.height);
      bandContext.drawImage(bitmap, 0, row * sourceCellHeight, band.width, sourceCellHeight, 0, 0, band.width, sourceCellHeight);
      return bandContext.getImageData(0, 0, band.width, band.height);
    };
    for (const row of onlyRows) {
      if (row >= rows) continue;
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const key of estimateKeyColours(readBand(row))) {
        if (!keys.some((known) => known[0] === key[0] && known[1] === key[1] && known[2] === key[2])) keys.push(key);
      }
    }
    for (const row of onlyRows) {
      if (row >= rows) continue;
      // One row of cells per task: a few milliseconds each, instead of one
      // long block per pet while the sidebar is starting up.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const source = readBand(row);
      // Take the key's share out of the outline before averaging, or it tints the edge.
      if (keys.length > 0) cleanKeyHalo(source, keys);
      const scaled = sharpenAtlasCells(downscaleAtlasCells(source, ATLAS_COLUMNS, 1, { width: deviceWidth, height: deviceHeight }), ATLAS_COLUMNS, 1);
      const pixels = outputContext.createImageData(scaled.width, scaled.height);
      pixels.data.set(scaled.data);
      // Cell k of the band lands at k * pitch, leaving its gutter transparent.
      for (let column = 0; column < ATLAS_COLUMNS; column++) {
        outputContext.putImageData(pixels, column * PRESCALE_GUTTER, row * pitchHeight, column * deviceWidth, 0, deviceWidth, deviceHeight);
      }
    }
    const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/png"));
    return blob ? { url: URL.createObjectURL(blob), rows } : null;
  } finally {
    bitmap.close();
  }
}

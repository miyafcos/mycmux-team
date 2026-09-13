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

const ATLAS_COLUMNS = 8;

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

export interface PrescaledAtlas {
  /** Object URL of a PNG whose cells are exactly one frame in device pixels. */
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
    output.width = ATLAS_COLUMNS * deviceWidth;
    output.height = rows * deviceHeight;
    const outputContext = output.getContext("2d");
    if (!bandContext || !outputContext) return null;
    for (const row of onlyRows) {
      if (row >= rows) continue;
      // One row of cells per task: a few milliseconds each, instead of one
      // long block per pet while the sidebar is starting up.
      await new Promise((resolve) => setTimeout(resolve, 0));
      bandContext.clearRect(0, 0, band.width, band.height);
      bandContext.drawImage(bitmap, 0, row * sourceCellHeight, band.width, sourceCellHeight, 0, 0, band.width, sourceCellHeight);
      const scaled = downscaleAtlasCells(
        bandContext.getImageData(0, 0, band.width, band.height),
        ATLAS_COLUMNS,
        1,
        { width: deviceWidth, height: deviceHeight },
      );
      const pixels = outputContext.createImageData(scaled.width, scaled.height);
      pixels.data.set(scaled.data);
      outputContext.putImageData(pixels, 0, row * deviceHeight);
    }
    const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/png"));
    return blob ? { url: URL.createObjectURL(blob), rows } : null;
  } finally {
    bitmap.close();
  }
}

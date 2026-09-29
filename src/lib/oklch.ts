/** Pure OKLCH and sRGB conversion helpers. */

const DEG = Math.PI / 180;

function linearToSrgb(value: number): number {
  const magnitude = Math.abs(value);
  return Math.sign(value) * (magnitude <= 0.0031308 ? 12.92 * magnitude : 1.055 * magnitude ** (1 / 2.4) - 0.055);
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function oklabToLinearSrgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function oklchToLinearSrgb(L: number, C: number, hDeg: number): [number, number, number] {
  const h = hDeg * DEG;
  return oklabToLinearSrgb(L, C * Math.cos(h), C * Math.sin(h));
}

function inSrgbGamut([r, g, b]: [number, number, number]): boolean {
  return r >= -1e-4 && r <= 1.0001 && g >= -1e-4 && g <= 1.0001 && b >= -1e-4 && b <= 1.0001;
}

function clampByte(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

/** Converts OKLCH to a gamut-clamped #rrggbb sRGB colour. */
export function oklchToHex(L: number, C: number, hDeg: number): string {
  const chroma = Math.min(Math.max(0, C), maxChroma(L, hDeg));
  const [r, g, b] = oklchToLinearSrgb(L, chroma, hDeg);
  const targetA = chroma * Math.cos(hDeg * DEG);
  const targetB = chroma * Math.sin(hDeg * DEG);
  const initial = [clampByte(linearToSrgb(r)), clampByte(linearToSrgb(g)), clampByte(linearToSrgb(b))];
  let best = initial;
  let bestError = Number.POSITIVE_INFINITY;
  // Byte rounding is visibly asymmetric in OKLab near some gamut edges. Pick
  // the closest neighbouring encoding in the source colour space instead.
  for (let red = Math.max(0, initial[0] - 1); red <= Math.min(255, initial[0] + 1); red += 1) {
    for (let green = Math.max(0, initial[1] - 1); green <= Math.min(255, initial[1] + 1); green += 1) {
      for (let blue = Math.max(0, initial[2] - 1); blue <= Math.min(255, initial[2] + 1); blue += 1) {
        const candidate = linearSrgbToOklab(srgbToLinear(red / 255), srgbToLinear(green / 255), srgbToLinear(blue / 255));
        const candidateHue = ((Math.atan2(candidate[2], candidate[1]) / DEG) + 360) % 360;
        const hueDelta = Math.min(Math.abs(candidateHue - hDeg), 360 - Math.abs(candidateHue - hDeg));
        if (hueDelta >= 0.5) continue;
        // Tier ordering is encoded in L, so favour its post-quantization
        // fidelity over the otherwise imperceptible channel-rounding error.
        const error = 100 * (candidate[0] - L) ** 2 + (candidate[1] - targetA) ** 2 + (candidate[2] - targetB) ** 2;
        if (error < bestError) {
          best = [red, green, blue];
          bestError = error;
        }
      }
    }
  }
  return `#${best.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Converts a #rrggbb (or #rgb) sRGB colour to OKLCH. */
export function hexToOklch(hex: string): { L: number; C: number; h: number } {
  const compact = hex.trim().replace(/^#/, "");
  const full = compact.length === 3 ? compact.split("").map((channel) => channel + channel).join("") : compact;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`hexToOklch: expected #rrggbb, got "${hex}"`);
  const r = srgbToLinear(parseInt(full.slice(0, 2), 16) / 255);
  const g = srgbToLinear(parseInt(full.slice(2, 4), 16) / 255);
  const b = srgbToLinear(parseInt(full.slice(4, 6), 16) / 255);
  const [L, a, labB] = linearSrgbToOklab(r, g, b);
  const C = Math.hypot(a, labB);
  const h = ((Math.atan2(labB, a) / DEG) + 360) % 360;
  return { L, C, h };
}

function linearSrgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Maximum chroma at the given lightness and hue that remains in sRGB. */
export function maxChroma(L: number, hDeg: number): number {
  let lo = 0;
  let hi = 0.4;
  for (let index = 0; index < 32; index += 1) {
    const mid = (lo + hi) / 2;
    if (inSrgbGamut(oklchToLinearSrgb(L, mid, hDeg))) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Euclidean distance in OKLab space for two sRGB hex colours. */
export function deltaEok(hexA: string, hexB: string): number {
  const a = hexToOklch(hexA);
  const b = hexToOklch(hexB);
  const ax = a.C * Math.cos(a.h * DEG);
  const ay = a.C * Math.sin(a.h * DEG);
  const bx = b.C * Math.cos(b.h * DEG);
  const by = b.C * Math.sin(b.h * DEG);
  return Math.hypot(a.L - b.L, ax - bx, ay - by);
}

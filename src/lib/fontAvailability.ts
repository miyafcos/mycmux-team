/**
 * Whether a font stack resolves to a real face on the machine the app is
 * running on.
 *
 * This exists because a stack that resolves to nothing fails silently. The Mac
 * carried a terminal setting of `'MS Gothic', 'BIZ UDGothic', monospace` copied
 * from the Windows box, and since neither family exists there it rendered in
 * Menlo with Hiragino Sans standing in for the Japanese -- two faces whose cell
 * widths do not divide evenly, so every Japanese table drifted. Nothing in the
 * UI said so; the preset list looked the same on both platforms.
 *
 * The answer is measured, never asked. `document.fonts.check()` looks like the
 * built-in way to ask and is useless for this: measured on the Mac on
 * 2026-09-10, it answered true for every family put to it, including one
 * invented for the test. It reports whether the fonts needed to render text in
 * that stack have finished loading, and a stack that will fall back to a
 * generic has nothing left to load, so the honest answer is yes.
 *
 * Advance width is the signal that survives: a family the machine does not have
 * falls through to the generic and measures exactly like it.
 */

// Keywords CSS resolves itself. They always produce a face, so a stack made
// only of these is available everywhere and needs no probing.
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "unset",
]);

/** Split a CSS font stack into family names, dropping quotes and generics. */
export function nonGenericFamilies(stack: string): string[] {
  return stack
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, "").trim())
    .filter((name) => name.length > 0 && !GENERIC_FAMILIES.has(name.toLowerCase()));
}

// Mixes Latin and CJK so a face that only covers one of the two still shifts the
// measurement away from the baseline.
const PROBE_TEXT = "MWmw0123iIlL日本語表示確認";
const PROBE_SIZE_PX = 72;
// Two baselines, because a family can coincidentally match one generic's metrics
// while differing from the other. Matching both is what marks it as absent.
const BASELINE_GENERICS = ["monospace", "sans-serif"] as const;
// Sub-pixel jitter exists even between identical renders; anything real moves
// the probe much further than this.
const WIDTH_EPSILON_PX = 0.5;

let probeContext: CanvasRenderingContext2D | null | undefined;

function getProbeContext(): CanvasRenderingContext2D | null {
  if (probeContext !== undefined) return probeContext;
  try {
    probeContext = document.createElement("canvas").getContext("2d");
  } catch {
    probeContext = null;
  }
  return probeContext;
}

function advanceWidth(ctx: CanvasRenderingContext2D, stack: string): number {
  ctx.font = `${PROBE_SIZE_PX}px ${stack}`;
  return ctx.measureText(PROBE_TEXT).width;
}

const familyCache = new Map<string, boolean>();

/** Whether one family name is installed, or bundled via @font-face. */
export function fontFamilyAvailable(family: string): boolean {
  const cached = familyCache.get(family);
  if (cached !== undefined) return cached;

  let available = false;
  try {
    const ctx = getProbeContext();
    if (ctx) {
      available = BASELINE_GENERICS.some((generic) => {
        const baseline = advanceWidth(ctx, generic);
        const measured = advanceWidth(ctx, `"${family}", ${generic}`);
        return Math.abs(measured - baseline) > WIDTH_EPSILON_PX;
      });
    } else {
      // No canvas to measure with: claim availability rather than mislabel a
      // working font as missing.
      available = true;
    }
  } catch {
    available = true;
  }

  familyCache.set(family, available);
  return available;
}

/**
 * The families in a stack that this machine cannot resolve. Empty means the
 * stack renders as written; a stack of only generics is always empty.
 */
export function missingFamilies(stack: string): string[] {
  return nonGenericFamilies(stack).filter((family) => !fontFamilyAvailable(family));
}

/**
 * True when nothing in the stack resolves except the generic fallback, which is
 * the case worth warning about: the setting says one thing and the screen shows
 * another.
 */
export function stackFallsBackEntirely(stack: string): boolean {
  const named = nonGenericFamilies(stack);
  return named.length > 0 && named.every((family) => !fontFamilyAvailable(family));
}

// A terminal lays out box-drawing glyphs as one cell each: Unicode calls the
// U+2500 range ambiguous-width, and xterm resolves ambiguous to narrow. A font
// that draws them at full width spills every rule into the next cell.
const BOX_DRAWING_SAMPLE = "─│┌┐└┘┼";
const HALFWIDTH_SAMPLE = "MMMMMMM";
// Halfway between the two outcomes: a halfwidth rule matches the Latin advance,
// a fullwidth one doubles it, and nothing sensible lands near 1.5.
const FULLWIDTH_BOX_THRESHOLD = 1.5;

const boxDrawingCache = new Map<string, boolean>();

/**
 * Whether a stack draws box-drawing glyphs at full width.
 *
 * This is the failure the Mac actually had. Its terminal font resolved to BIZ
 * UDGothic — a real, installed, correctly proportioned monospace face, so no
 * availability check flagged it — but that face draws rules at 1em against a
 * 0.5em Latin advance. Tables came apart, tree output stretched, and progress
 * bars went gappy, while the same setting looked fine on Windows only because
 * nobody had compared them. UDEV Gothic, which ships with the app, draws them
 * at 0.5em.
 */
export function stackBreaksBoxDrawing(stack: string): boolean {
  const cached = boxDrawingCache.get(stack);
  if (cached !== undefined) return cached;

  let broken = false;
  try {
    const ctx = getProbeContext();
    if (ctx) {
      ctx.font = `${PROBE_SIZE_PX}px ${stack}`;
      const latin = ctx.measureText(HALFWIDTH_SAMPLE).width / HALFWIDTH_SAMPLE.length;
      const box = ctx.measureText(BOX_DRAWING_SAMPLE).width / BOX_DRAWING_SAMPLE.length;
      broken = latin > 0 && box / latin > FULLWIDTH_BOX_THRESHOLD;
    }
  } catch {
    // Same principle as availability: never condemn a working font on a failed
    // measurement.
    broken = false;
  }

  boxDrawingCache.set(stack, broken);
  return broken;
}

/** Drop memoized answers. Fonts can finish loading after the first probe. */
export function resetFontAvailabilityCache(): void {
  familyCache.clear();
  boxDrawingCache.clear();
  probeContext = undefined;
}

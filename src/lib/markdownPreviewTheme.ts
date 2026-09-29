// The Markdown preview painted in the colours of the active theme.
//
// The preview document ships with a light paper palette of its own (see
// markdown_preview.css), so a file opened outside the app still reads. Inside
// the app the pane writes these variables onto the frame's <html> element, and
// the reader gets one surface instead of a white page in a dark workspace.
//
// Every colour here is derived, never authored: a theme only declares terminal
// and chrome colours, and a palette assembled by hand would drift the moment a
// theme is added. Derivation also lets each role carry its own contrast floor -
// body text at AAA (7:1), secondary text and the alert colours at the AA body
// floor - which is what tests/unit/markdownPreviewTheme.test.ts measures for
// every theme in THEMES.

import { contrastRatio, isHexColor } from "../components/theme/colorContrast";
import { isLightColor } from "./theme/colorPrimitives";
import { mixOklab } from "./theme/oklab";
import type { ThemeDefinition } from "../types";

export type MarkdownPreviewScheme = "light" | "dark";

export interface MarkdownPreviewPalette {
  /** Whether the preview paints as a light or a dark document. */
  scheme: MarkdownPreviewScheme;
  /** Custom properties, keyed exactly as markdown_preview.css declares them. */
  vars: Record<string, string>;
}

/** Body text is the one surface that is nothing but small text, so it is held to AAA. */
const TEXT_CONTRAST_TARGET = 7;
/** WCAG AA body floor, for links, alert colours and secondary text. */
const BODY_CONTRAST_TARGET = 4.5;
/** Secondary text stays a little above the floor; it carries real content. */
const MUTED_CONTRAST_TARGET = 4.8;
/** Hints and markers are decoration, held to the AA floor for non-text marks. */
const FAINT_CONTRAST_TARGET = 3.2;
/** How far a derived colour may be pushed per step while it chases a floor. */
const CONTRAST_STEP = 0.05;

/** `#rgb` / `#rrggbb` as a lowercase `#rrggbb`, or null for anything else. */
function normalizeHex(value: string | undefined): string | null {
  if (!value || !isHexColor(value)) return null;
  const digits = value.slice(1);
  const expanded = digits.length === 3
    ? digits.split("").map((digit) => `${digit}${digit}`).join("")
    : digits;
  return `#${expanded}`.toLowerCase();
}

export function markdownPreviewPalette(theme: ThemeDefinition): MarkdownPreviewPalette {
  // The terminal background is the colour the workspace actually shows next to
  // this pane; chrome.surface is the fallback for a theme that leaves it unset.
  const bg = normalizeHex(theme.terminal?.background)
    ?? normalizeHex(theme.chrome?.surface)
    ?? "#ffffff";
  const scheme: MarkdownPreviewScheme = isLightColor(bg) ? "light" : "dark";
  const ink = scheme === "light" ? "#000000" : "#ffffff";

  /** `color` pushed toward black (light) or white (dark) until it clears `target`. */
  const ensureContrast = (color: string | undefined, target: number, fallback: string): string => {
    const start = normalizeHex(color) ?? normalizeHex(fallback) ?? ink;
    for (let amount = 0; amount < 1; amount += CONTRAST_STEP) {
      const candidate = mixOklab(start, ink, amount);
      if (contrastRatio(candidate, bg) >= target) return candidate;
    }
    return ink;
  };

  /** `color` faded as far toward the background as `target` still allows. */
  const fade = (color: string, target: number, from: number): string => {
    for (let amount = from; amount > 0.001; amount -= CONTRAST_STEP) {
      const candidate = mixOklab(color, bg, amount);
      if (contrastRatio(candidate, bg) >= target) return candidate;
    }
    return color;
  };

  const text = ensureContrast(theme.terminal?.foreground, TEXT_CONTRAST_TARGET, theme.chrome?.text);
  const border = mixOklab(bg, text, 0.24);

  const vars: Record<string, string> = {
    "--md-bg": bg,
    "--md-text": text,
    "--md-heading": mixOklab(text, ink, 0.4),
    "--md-muted": fade(text, MUTED_CONTRAST_TARGET, 0.45),
    "--md-faint": fade(text, FAINT_CONTRAST_TARGET, 0.7),
    "--md-border": border,
    "--md-border-soft": mixOklab(bg, text, 0.14),
    "--md-code-bg": mixOklab(bg, text, 0.09),
    // A dark theme reads better with code sunk below the page than lifted above
    // it; a light one only needs the faintest tint to separate the block.
    "--md-pre-bg": scheme === "light" ? mixOklab(bg, text, 0.045) : mixOklab(bg, "#000000", 0.22),
    "--md-table-head": mixOklab(bg, text, 0.065),
    "--md-table-stripe": mixOklab(bg, text, 0.028),
    "--md-link": ensureContrast(theme.chrome?.accent, BODY_CONTRAST_TARGET, text),
    "--md-quote": border,
    "--md-mark": mixOklab(bg, theme.terminal?.yellow, scheme === "light" ? 0.45 : 0.3),
    "--md-selection": mixOklab(bg, theme.chrome?.accent, 0.32),
    "--md-note": ensureContrast(theme.terminal?.blue, BODY_CONTRAST_TARGET, text),
    "--md-tip": ensureContrast(theme.terminal?.green, BODY_CONTRAST_TARGET, text),
    "--md-important": ensureContrast(theme.terminal?.magenta, BODY_CONTRAST_TARGET, text),
    "--md-warning": ensureContrast(theme.terminal?.yellow, BODY_CONTRAST_TARGET, text),
    "--md-caution": ensureContrast(theme.terminal?.red, BODY_CONTRAST_TARGET, text),
  };

  return { scheme, vars };
}

/**
 * The reader's terminal font, as a stack the preview can use for code.
 *
 * The value lands inside a CSS declaration, so anything that could end one is
 * refused rather than escaped: a font setting is a list of family names, and a
 * value carrying `;`, braces, brackets or a `url(` is not one.
 */
export function markdownPreviewMonoFont(terminalFontFamily: string): string | null {
  const value = terminalFontFamily.trim();
  if (!value || !/^[\p{L}\p{N} _\-.,'"]+$/u.test(value)) return null;
  return `${value}, "Cascadia Mono", Consolas, "SF Mono", Menlo, "BIZ UDGothic", monospace`;
}

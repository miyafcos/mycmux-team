/**
 * Chart colours. Fixed hues rather than theme variables: the diagram needs many
 * distinguishable series at once, and these are chosen to stay legible on both
 * the light and the dark surface (they are only ever drawn as fills behind
 * theme-coloured text, never as text).
 */

export const MODEL_COLORS = [
  "#7c9cff",
  "#63d2a4",
  "#e0a458",
  "#d98cc4",
  "#5ec8d8",
  "#c2a3f2",
  "#e07a7a",
  "#9fb85a",
  "#e8c547",
  "#e07098",
];

export const TAG_COLORS = [
  "#5b8def",
  "#3fb984",
  "#d9963f",
  "#c76fb0",
  "#41b4c4",
  "#a487e8",
  "#cf6a6a",
  "#8aa54a",
];

export const NEUTRAL_COLOR = "#8a8f9c";

/** Stable colour for a model name that has no fixed slot (session detail). */
export function hashedColor(name: string, palette: string[] = MODEL_COLORS): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length];
}

/** Sequential amount colours; deliberately independent of model-series paints. */
export type GrassLevel = 0 | 1 | 2 | 3 | 4;
export const GRASS_EMPTY = "color-mix(in srgb, var(--cmux-text) 9.9%, transparent)";
export const GRASS_LIGHT = ["#5eb964", "#399a43", "#26792f", "#195920"] as const;
export const GRASS_DARK = ["#3d8241", "#49a14f", "#5cc063", "#75e07c"] as const;

// Only these authored dark surfaces tint the translucent wash beyond C=0.03.
// Opaque neutral values keep their existing contrast without changing other themes.
const NEUTRAL_EMPTY: Readonly<Record<string, string>> = {
  "yoi-ai": "#414141", "yogiri": "#3f3f3f", "synthwave": "#343434",
};

/** A store-free caller uses the dark scale. */
export function grassScale(colorScheme?: "light" | "dark", themeId?: string): readonly string[] {
  return [themeId ? NEUTRAL_EMPTY[themeId] ?? GRASS_EMPTY : GRASS_EMPTY, ...(colorScheme === "light" ? GRASS_LIGHT : GRASS_DARK)];
}

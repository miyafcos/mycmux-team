/** Sequential amount colours; deliberately independent of model-series paints. */
export type GrassLevel = 0 | 1 | 2 | 3 | 4;
export const GRASS_EMPTY = "color-mix(in srgb, var(--cmux-text) 9.9%, transparent)";
export const GRASS_LIGHT = ["#5eb964", "#399a43", "#26792f", "#195920"] as const;
export const GRASS_DARK = ["#3d8241", "#49a14f", "#5cc063", "#75e07c"] as const;

/** A store-free caller uses the dark scale. */
export function grassScale(colorScheme?: "light" | "dark"): readonly string[] {
  return [GRASS_EMPTY, ...(colorScheme === "light" ? GRASS_LIGHT : GRASS_DARK)];
}

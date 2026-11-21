import type { HanabiSceneId } from "../types/theme";

/** Closed, local-only catalog: scene choices never start a wallpaper download. */
export const HANABI_SCENES: readonly { id: HanabiSceneId; label: string }[] = [
  { id: "winter-night", label: "冬の夜空" },
  { id: "summer-seaside", label: "夏の花火大会" },
  { id: "sakura-night", label: "桜の夜" },
  { id: "harbor-night", label: "港町の夜景" },
  { id: "onsen-autumn", label: "山あいの温泉街" },
];

export function normalizeHanabiSceneId(value: unknown): HanabiSceneId {
  return HANABI_SCENES.find(scene => scene.id === value)?.id ?? "winter-night";
}

import { convertFileSrc } from "@tauri-apps/api/core";
import { THEME_BACKGROUND_PRESETS } from "../../lib/themeBackgrounds";
import type { ThemeBackgroundSettings } from "../../types";
import { applyBackgroundPreset, type BackgroundPresetId } from "../../lib/theme/backgroundPresets";
import { SceneThumbnail } from "./SceneThumbnail";

/** The same scene and two panel regions make the three opacity choices comparable. */
export function SurfaceThumbnail({ id, background }: { id: BackgroundPresetId; background: ThemeBackgroundSettings }) {
  const patch = id === "custom" ? background : { ...background, ...applyBackgroundPreset(id) };
  // Deliberately separated demonstration values; applying a preset keeps its real values.
  const alpha = id === "solid" ? 1 : id === "frosted" ? 0.55 : id === "clear" ? 0.12 : patch.solidSurfaces ? 1 : patch.panelOpacity;
  const blur = id === "frosted" ? "blur(1.5px)" : undefined;
  const imageUrl = background.mode === "preset" ? THEME_BACKGROUND_PRESETS.find(preset => preset.id === background.presetId)?.thumbnailUrl
    : background.mode === "image" && background.imagePath ? convertFileSrc(background.imagePath) : undefined;
  return <span aria-hidden="true" data-surface-thumbnail={id} style={{ position: "relative", display: "block", width: "min(100%, 240px)", margin: "0 auto", aspectRatio: "8/5", overflow: "hidden", borderRadius: 4 }}>
    {imageUrl ? <img src={imageUrl} alt="" draggable={false} style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} /> : <SceneThumbnail sceneId={background.sceneId} />}
    <span style={{ position: "absolute", inset: "14% 10%", borderRadius: 4, border: "1px solid var(--cmux-border)",
      backdropFilter: blur, WebkitBackdropFilter: blur,
      background: `color-mix(in srgb, var(--cmux-surface-solid) ${(alpha * 100).toFixed(2)}%, transparent)` }}>
      <span style={{ position: "absolute", inset: "0 auto 0 0", width: "24%", borderRight: "1px solid var(--cmux-border)",
        background: `color-mix(in srgb, var(--cmux-surface-solid) ${(alpha * 100).toFixed(2)}%, transparent)` }} />
      {[26, 43, 60].map((top, index) => <span key={top} style={{ position: "absolute", top: `${top}%`, left: "35%", width: `${index === 1 ? 37 : 47}%`, height: 2,
        background: "var(--cmux-text)", opacity: index ? 0.4 : 0.8 }} />)}
    </span>
  </span>;
}

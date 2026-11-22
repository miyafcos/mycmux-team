import { useEffect, useRef } from "react";
import type { HanabiSceneId } from "../../types/theme";
import { createHanabiScene } from "../../lib/hanabiScenery";
import { createNightFireworks } from "../../lib/hanabiScene";
import { paintNightStill, paintWinterNight, paintNightFireworks } from "../../lib/hanabiCanvas";

const THUMBNAIL_COLORS: Record<HanabiSceneId, string> = {
  "winter-night": "#F08A6C", "summer-seaside": "#f2cc8f", "sakura-night": "#f4bad0",
  "harbor-night": "#9bd9ce", "onsen-autumn": "#f3ad70",
};

/** One frozen product render, cropped to the lower 55%, then nearest-neighbor 1/2.
 * Artwork is 480x546; the bottom 480x300 is cropped without distorting it.
 */
export function SceneThumbnail({ sceneId = "winter-night" }: { sceneId?: HanabiSceneId }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current, ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;
    const scene = createHanabiScene(sceneId, 480, 546);
    const still = document.createElement("canvas"); still.width = 480; still.height = 546;
    const stillCtx = still.getContext("2d", { alpha: false });
    const frame = document.createElement("canvas"); frame.width = 480; frame.height = 546;
    const frameCtx = frame.getContext("2d", { alpha: false });
    if (!stillCtx || !frameCtx) return;
    paintNightStill(stillCtx, scene);
    paintWinterNight(frameCtx, scene, 1800, still, [], true);
    const burst = createNightFireworks("done", 480, 546, 0, 42, {}, sceneId)[0];
    paintNightFireworks(frameCtx, scene, 1800, [{ ...burst, x: 336, y: 336, radius: 48, color: THUMBNAIL_COLORS[sceneId] }]);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame, 0, 246, 480, 300, 0, 0, 240, 150);
  }, [sceneId]);
  return <canvas ref={ref} width={240} height={150} aria-hidden="true" data-scene-thumbnail={sceneId}
    style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", imageRendering: "pixelated" }} />;
}

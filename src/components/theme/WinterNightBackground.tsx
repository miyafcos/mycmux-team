import { useEffect, useRef } from "react";
import type { HanabiSceneId } from "../../types/theme";
import { createHanabiScene } from "../../lib/hanabiScenery";
import { normalizeHanabiSceneId } from "../../lib/hanabiScenes";
import "./hanabi.css";
import { isTauri } from "@tauri-apps/api/core";
import { createHanabiTerminalSurfaces } from "../../lib/hanabiTerminalSurfaces";
import { paintNightStill, paintWinterNight, paintNightFireworks } from "../../lib/hanabiCanvas";
import { createNightFireworks, fireworkEnd, nightCanvasScale, WINTER_NIGHT_SEED, type CelebrationKind, type NightFirework, type NightSceneLayout, type NightRect } from "../../lib/hanabiScene";
import { connectHanabiCelebrations } from "../../stores/hanabiCelebrationObserver";

export interface NightFrameStats { fps: number; averageMs: number; maxMs: number; frames: number }
interface WinterNightBackgroundProps {
  fireworksEnabled: boolean;
  sceneId?: HanabiSceneId;
  terminalColor?: string;
  terminalOpacity?: number;
  sidebarWidth?: number;
  /** Local preview controls; production leaves these unset. */
  previewMode?: boolean;
  previewTimeMs?: number;
  previewFireworks?: CelebrationKind;
  previewReducedMotion?: boolean;
  manualCelebration?: { kind: CelebrationKind; nonce: number };
  onStats?: (stats: NightFrameStats) => void;
}

/** The sole RAF owner, always mounted below the app's existing glass surfaces. */
export function WinterNightBackground({
  fireworksEnabled, sceneId = "winter-night", terminalColor, terminalOpacity = 0.25, sidebarWidth = 0, previewMode = false, previewTimeMs, previewFireworks, previewReducedMotion = false, manualCelebration, onStats,
}: WinterNightBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const launchRef = useRef<(kind: CelebrationKind) => void>(() => {});
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;
    const host = canvas.parentElement;
    if (!host) return;
    const still = document.createElement("canvas");
    const stillCtx = still.getContext("2d", { alpha: false });
    if (!stillCtx) return;
    const surfaces = terminalColor ? createHanabiTerminalSurfaces(canvas, terminalColor, terminalOpacity, () => { if (!disposed && visible()) paint(time()); }) : undefined;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const frozen = previewTimeMs !== undefined;
    let scene = createHanabiScene(sceneId, 1, 1);
    let fireworks: NightFirework[] = [];
    let sequence = WINTER_NIGHT_SEED;
    let frameId: number | undefined;
    let disposed = false, nativeMinimized = false, nativeHidden = false, nativeChecking = false;
    let releaseCelebrations: (() => void) | undefined;
    let lastNativeCheck = -Infinity;
    let nativeWindow: Awaited<ReturnType<typeof import("@tauri-apps/api/window")["getCurrentWindow"]>> | undefined;
    const nativeReleases: (() => void)[] = [];
    const start = performance.now();
    let lastPaint = -Infinity, statsAt = start, frames = 0, totalMs = 0, maxMs = 0;
    const reduced = () => motion.matches || previewReducedMotion;
    const visible = () => !document.hidden && !nativeMinimized && !nativeHidden;
    const time = () => previewTimeMs ?? performance.now() - start;

    // Read layout only on resize/celebration, never on the animation hot path.
    function readLayout(): NightSceneLayout {
      const root = canvas!.closest('[data-cmux-themed-root], .stage') ?? host!;
      const origin = host!.getBoundingClientRect();
      const visibleRect = (element: Element): NightRect | undefined => {
        const r = element.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.bottom <= origin.top || r.top >= origin.bottom) return;
        if (window.getComputedStyle(element).visibility === "hidden") return;
        return { left: r.left - origin.left, top: Math.max(0, r.top - origin.top),
          right: r.right - origin.left, bottom: Math.min(origin.height, r.bottom - origin.top) };
      };
      const messages = Array.from(root.querySelectorAll(".message, .cmux-dashboard-msg")).slice(-64)
        .map(visibleRect).filter((r): r is NightRect => !!r);
      const conversationRect = messages.length ? { left: Math.min(...messages.map(r => r.left)), top: Math.min(...messages.map(r => r.top)),
        right: Math.max(...messages.map(r => r.right)), bottom: Math.max(...messages.map(r => r.bottom)) } : undefined;
      const input = Array.from(root.querySelectorAll(".input, .cmux-composer-shell")).map(visibleRect).find(r => !!r);
      return { sidebarWidth, conversationRect, inputRect: input };
    }
    function paint(at: number) {
      const before = onStats ? performance.now() : 0;
      fireworks = fireworks.filter(firework => fireworkEnd(firework) > at);
      paintWinterNight(ctx!, scene, at, still, [], reduced());
      surfaces?.paint(at, fireworks, reduced());
      if (!reduced()) paintNightFireworks(ctx!, scene, at, fireworks);
      if (onStats) {
        const duration = performance.now() - before;
        frames += 1; totalMs += duration; maxMs = Math.max(maxMs, duration);
        const elapsed = performance.now() - statsAt;
        if (elapsed >= 1000) {
          onStats({ fps: frames * 1000 / elapsed, averageMs: totalMs / frames, maxMs, frames });
          statsAt = performance.now(); frames = 0; totalMs = 0; maxMs = 0;
        }
      }
    }
    function schedule() {
      if (!disposed && !frozen && visible() && !reduced() && frameId === undefined) frameId = requestAnimationFrame(frame);
    }
    function frame(now: number) {
      frameId = undefined;
      if (disposed || !visible() || reduced()) return;
      if (nativeWindow && now - lastNativeCheck >= 1000) void checkNativeVisibility();
      const interval = 1000 / (fireworks.length ? 60 : 30);
      if (now - lastPaint >= interval - 0.05) { lastPaint = now; paint(time()); }
      schedule();
    }
    function syncActivity() {
      if (disposed) return;
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      frameId = undefined;
      releaseCelebrations?.(); releaseCelebrations = undefined;
      fireworks = [];
      if (!visible()) return;
      if (frozen && previewFireworks && !reduced()) fireworks = createNightFireworks(previewFireworks, scene.width, scene.height, 0, 0, { ...scene.layout, ...readLayout() }, sceneId);
      paint(time());
      if (!previewMode && !frozen && !reduced() && fireworksEnabled) releaseCelebrations = connectHanabiCelebrations(launch);
      statsAt = performance.now(); frames = 0; totalMs = 0; maxMs = 0;
      lastPaint = -Infinity;
      schedule();
    }
    function resize() {
      const bounds = host!.getBoundingClientRect();
      const scale = nightCanvasScale(window.devicePixelRatio);
      scene = createHanabiScene(sceneId, bounds.width || window.innerWidth, bounds.height || window.innerHeight, WINTER_NIGHT_SEED, readLayout());
      canvas!.width = Math.round(scene.width * scale); canvas!.height = Math.round(scene.height * scale);
      ctx!.setTransform(scale, 0, 0, scale, 0, 0);
      ctx!.imageSmoothingEnabled = false;
      still.width = scene.width; still.height = scene.height;
      paintNightStill(stillCtx!, scene);
      surfaces?.resize(scene, scale);
      // Resizing keeps one loop and never replays a completed celebration.
      syncActivity();
    }
    function launch(kind: CelebrationKind) {
      if (disposed || frozen || !visible() || reduced() || !fireworksEnabled) return;
      // Placement and ray attenuation use the same current conversation geometry.
      const currentLayout = { ...scene.layout, ...readLayout() };
      // Keep the scene object shared with the terminal light surfaces.
      scene.layout = currentLayout;
      fireworks = [...fireworks, ...createNightFireworks(kind, scene.width, scene.height, time(), sequence++, currentLayout, sceneId)].slice(-12);
      schedule();
    }
    async function checkNativeVisibility() {
      if (!nativeWindow || nativeChecking || disposed) return;
      nativeChecking = true; lastNativeCheck = performance.now();
      try {
        const [minimized, shown] = await Promise.all([nativeWindow.isMinimized(), nativeWindow.isVisible()]);
        if (disposed) return;
        if (minimized !== nativeMinimized || !shown !== nativeHidden) {
          nativeMinimized = minimized; nativeHidden = !shown; syncActivity();
        }
      } catch { /* Browser previews have no native window. */ }
      finally { nativeChecking = false; }
    }
    function onFocus() { void checkNativeVisibility(); }
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
    resizeObserver?.observe(host);
    window.addEventListener("resize", resize);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onFocus);
    document.addEventListener("visibilitychange", syncActivity);
    motion.addEventListener("change", syncActivity);
    launchRef.current = launch;
    resize();
    if (isTauri()) {
      void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        if (disposed) return;
        nativeWindow = getCurrentWindow();
        await checkNativeVisibility();
        for (const subscription of [nativeWindow.onResized(onFocus), nativeWindow.onFocusChanged(onFocus)]) {
          void subscription.then(release => { if (disposed) release(); else nativeReleases.push(release); }).catch(() => {});
        }
      }).catch(() => {});
    }
    return () => {
      disposed = true; launchRef.current = () => {};
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      releaseCelebrations?.(); resizeObserver?.disconnect(); surfaces?.dispose();
      nativeReleases.forEach(release => release());
      window.removeEventListener("resize", resize);
      window.removeEventListener("focus", onFocus); window.removeEventListener("blur", onFocus);
      document.removeEventListener("visibilitychange", syncActivity); motion.removeEventListener("change", syncActivity);
    };
  }, [fireworksEnabled, sceneId, terminalColor, terminalOpacity, sidebarWidth, previewMode, previewTimeMs, previewFireworks, previewReducedMotion, onStats]);
  useEffect(() => { if (manualCelebration) launchRef.current(manualCelebration.kind); }, [manualCelebration]);
  return <canvas ref={canvasRef} aria-hidden="true" data-hanabi-scene={normalizeHanabiSceneId(sceneId)}
    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", imageRendering: "pixelated" }} />;
}

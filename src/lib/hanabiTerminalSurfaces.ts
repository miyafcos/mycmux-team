import type { HanabiScene } from "./hanabiScenery";
import type { NightFirework } from "./hanabiScene";
import { paintNightFireworks } from "./hanabiCanvas";

interface Surface {
  host: HTMLElement; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  left: number; top: number; width: number; height: number; visible: boolean;
}

/** The scene's sole RAF paints these below xterm's ink, above its CSS backdrop.
 * Scenery gets exactly one stored-opacity coat; emitted light does not get tinted.
 * No terminal instance, PTY observation, event producer or extra animation loop.
 */
export function createHanabiTerminalSurfaces(source: HTMLCanvasElement, color: string, opacity: number, invalidate: () => void = () => {}) {
  const root = source.closest('[data-cmux-themed-root], .stage');
  const originHost = source.parentElement;
  const surfaces = new Map<HTMLElement, Surface>();
  let scene: HanabiScene | undefined, scale = 1;
  const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => { if (update()) invalidate(); });
  function update() {
    if (!root || !originHost || !scene) return false;
    let changed = false;
    const origin = originHost.getBoundingClientRect();
    const hosts = new Set([...root.querySelectorAll<HTMLElement>('[data-hanabi-terminal-surface]')].filter(host =>
      !host.closest('[aria-hidden="true"]') && window.getComputedStyle(host).visibility !== "hidden"));
    for (const [host, surface] of surfaces) if (!hosts.has(host)) {
      changed = true; resizeObserver?.unobserve(host); surface.canvas.remove(); surfaces.delete(host);
    }
    for (const host of hosts) {
      let surface = surfaces.get(host);
      if (!surface) {
        const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) continue;
        canvas.setAttribute("aria-hidden", "true"); canvas.dataset.hanabiTerminalLight = "true";
        Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", imageRendering: "pixelated" });
        host.prepend(canvas);
        surface = { host, canvas, ctx, left: 0, top: 0, width: 0, height: 0, visible: true };
        changed = true; surfaces.set(host, surface); resizeObserver?.observe(host);
      }
      const bounds = host.getBoundingClientRect();
      surface.visible = window.getComputedStyle(host).visibility !== "hidden";
      if (surface.left !== bounds.left - origin.left || surface.top !== bounds.top - origin.top || surface.width !== bounds.width || surface.height !== bounds.height) changed = true;
      surface.left = bounds.left - origin.left; surface.top = bounds.top - origin.top;
      surface.width = bounds.width; surface.height = bounds.height;
      const width = Math.max(1, Math.round(bounds.width * scale)), height = Math.max(1, Math.round(bounds.height * scale));
      if (surface.canvas.width !== width) surface.canvas.width = width;
      if (surface.canvas.height !== height) surface.canvas.height = height;
      surface.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    }
    return changed;
  }
  function layoutChanged() { if (update()) invalidate(); }
  const holdsSurface = (node: Node) => node instanceof HTMLElement
    && (node.matches('[data-hanabi-terminal-surface]') || !!node.querySelector('[data-hanabi-terminal-surface]'));
  // React creates/replaces terminal hosts, but output row mutations are not layout work.
  // A modal hides the shell with aria-hidden; surfaces rebuilt meanwhile (a scene picked in settings)
  // are skipped as hidden, so add them when the hiding lifts. Hiding itself keeps the last frame.
  const observer = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(records => {
    if (records.some(record => record.type === "attributes"
      ? (record.target as Element).getAttribute("aria-hidden") !== "true" && holdsSurface(record.target)
      : [...record.addedNodes, ...record.removedNodes].some(holdsSurface))) layoutChanged();
  });
  if (root) observer?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-hidden"] });
  window.addEventListener("mycmux:workspace-visibility-change", layoutChanged);
  return {
    resize(next: HanabiScene, nextScale: number) { scene = next; scale = nextScale; update(); },
    paint(at: number, fireworks: readonly NightFirework[], reducedMotion: boolean) {
      if (!scene) return;
      for (const surface of surfaces.values()) {
        const { ctx, left, top, width, height } = surface;
        if (!surface.visible || width <= 0 || height <= 0 || surface.host.closest('[aria-hidden="true"]')) continue;
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(source, left * scale, top * scale, width * scale, height * scale, 0, 0, width, height);
        ctx.globalAlpha = opacity; ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); ctx.globalAlpha = 1;
        if (!reducedMotion && fireworks.length) {
          ctx.save(); ctx.translate(-left, -top);
          paintNightFireworks(ctx, scene, at, fireworks, { color, opacity }); ctx.restore();
        }
      }
    },
    dispose() {
      observer?.disconnect(); resizeObserver?.disconnect();
      window.removeEventListener("mycmux:workspace-visibility-change", layoutChanged);
      for (const surface of surfaces.values()) surface.canvas.remove(); surfaces.clear();
    },
  };
}

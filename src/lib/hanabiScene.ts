import type { HanabiSceneId } from "../types/theme";

/** Seeded geometry and animation maths: no DOM, clock, or ambient randomness. */
export interface NightRect { left: number; top: number; right: number; bottom: number }
export interface NightSceneLayout { sidebarWidth?: number; conversationRect?: NightRect; inputRect?: NightRect; rightForestTip?: { x: number; y: number }; skyline?: { x: number; y: number }[]; reflectionRange?: { left: number; right: number } }
export interface NightStar { x: number; y: number; size: number; alpha: number; phase: number; speed: number; cross: boolean }
export interface NightSnow { x: number; y: number; size: number; speed: number; drift: number; phase: number; layer: number }
export interface NightTree { x: number; y: number; height: number; width: number; layer: "far" | "near"; shade: number; side: "left" | "right" }
export interface WinterNightScene {
  width: number; height: number; pixel: number; seed: number; layout: NightSceneLayout;
  stars: NightStar[]; snow: NightSnow[]; trees: NightTree[];
  house: { x: number; y: number; width: number; height: number };
}
export type CelebrationKind = "done" | "merge";
export type FireworkStyle = "chrysanthemum" | "willow" | "ring";
export interface NightFirework {
  x: number; y: number; radius: number; startedAt: number; duration: number; launchMs: number;
  style: FireworkStyle; color: string; core: string; final: boolean;
  rays: { angle: number; length: number; phase: number }[];
}
export const WINTER_NIGHT_SEED = 0x68616e61;

export interface NightTreeBranch { top: number; bottom: number; half: number; shadowTop: number }

/** A new bough takes over at each tier: the previous triangle cannot hide its notch. */
export function nightTreeBranches(tree: NightTree, pixel: number): NightTreeBranch[] {
  const snap = (n: number) => Math.round(n / pixel) * pixel;
  const top = tree.y - tree.height;
  return Array.from({ length: 5 }, (_, tier) => {
    const start = snap(top + tier * tree.height * 0.19);
    const bottom = tier === 4 ? tree.y : snap(top + (tier + 1) * tree.height * 0.19);
    return { top: start, bottom, half: snap(tree.width / 2 / Math.pow(1.25, 4 - tier)),
      shadowTop: bottom - (tree.layer === "near" ? pixel * 2 : pixel) };
  });
}

export function nightBranchExtent(branch: NightTreeBranch, row: number, pixel: number, crown = false): number {
  if (row < branch.top || row >= branch.bottom) return 0;
  const progress = (row - branch.top) / Math.max(pixel, branch.bottom - branch.top - pixel);
  return Math.max(pixel, Math.round(branch.half * (crown ? progress : 0.6 + 0.4 * progress) / pixel) * pixel);
}

function treeIntersectsClearing(tree: NightTree, pixel: number, rect: NightRect): boolean {
  return nightTreeBranches(tree, pixel).some((branch, tier) => {
    for (let row = Math.max(branch.top, Math.floor(rect.top / pixel) * pixel); row < Math.min(branch.bottom, rect.bottom); row += pixel) {
      const half = nightBranchExtent(branch, row, pixel, tier === 0);
      if (tree.x + half > rect.left && tree.x - half < rect.right) return true;
    }
    return false;
  });
}


export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function createWinterNightScene(width: number, height: number, seed = WINTER_NIGHT_SEED, layout: NightSceneLayout = {}): WinterNightScene {
  const w = Math.max(1, Math.round(Number.isFinite(width) ? width : 1));
  const h = Math.max(1, Math.round(Number.isFinite(height) ? height : 1));
  const random = seededRandom(seed);
  // Round the artwork grid, rather than flooring the whole scale: FHD uses 4px.
  const pixel = Math.max(3, Math.round(3 * Math.min(w / 1280, h / 800)));
  const unit = pixel / 3;
  const snap = (n: number) => Math.round(n / pixel) * pixel;
  const stars = Array.from({ length: Math.max(56, Math.min(150, Math.round(w * h / 7200))) }, () => {
    let x = random() * w, y = random() * h * 0.92;
    // Half an extra population in the upper side quarters.
    if (random() < 0.2) { x = (random() < 0.5 ? 0 : 0.75) * w + random() * w * 0.25; y = random() * h * 0.5; }
    const tier = random();
    const size = tier < 0.45 ? 1 : tier < 0.8 ? 2 : 3;
    return { x: Math.round(x), y: Math.round(y), size,
      alpha: size === 3 ? 0.85 + random() * 0.15 : 0.4 + random() * 0.45,
      phase: random() * Math.PI * 2, speed: 0.23 + random() * 0.62, cross: size === 3 };
  });
  const snow = Array.from({ length: Math.max(27, Math.min(60, Math.round(w * h / 24000))) }, (_, index) => {
    const layer = index % 3;
    return { x: random() * w, y: random() * h, size: [1, 2, 5][layer] * unit,
      speed: [5, 9, 15][layer] + random() * 3, drift: [4, 8, 13][layer],
      phase: random() * Math.PI * 2, layer };
  });
  const candidates: NightTree[] = [];
  const sidebar = Math.max(0, Math.min(w * 0.4, layout.sidebarWidth ?? 0));
  const portrait = h > w;
  const heightBasis = Math.min(w * 0.6, h * (portrait ? 0.35 : 0.45));
  for (const side of ["left", "right"] as const) {
    for (let index = 0; index < 15; index += 1) {
      const distance = (index + random() * 0.6) / 15 * w * 0.25;
      const height = snap(heightBasis * (0.25 + random() * 0.25));
      candidates.push({ x: snap(side === "left" ? sidebar + distance : w - distance), y: snap(h - 24 * unit),
        height, width: snap(height * (0.52 + random() * 0.1)), layer: "far", shade: random(), side });
    }
    let previous: NightTree | undefined;
    for (let index = 0; index < (portrait ? 2 : 4); index += 1) {
      const height = snap(heightBasis * ([1, 0.72, 0.54, 0.35][index] + random() * 0.06));
      const width = snap(height * (0.52 + random() * 0.1));
      const gap = previous ? Math.ceil(Math.max(previous.width, width) * 0.74 / pixel) * pixel : 0;
      const x = previous ? previous.x + (side === "left" ? gap : -gap)
        : snap(side === "left" ? sidebar + 12 * unit : w * 0.945);
      const tree: NightTree = { x, y: snap(h + 18 * unit), height, width, layer: "near",
        shade: index % 2 === 0 ? 0.75 : 0.25, side };
      candidates.push(tree); previous = tree;
    }
  }
  const houseWidth = snap(54 * unit), houseHeight = snap(30 * unit);
  const input = layout.inputRect;
  const houseY = snap(Math.min(h - 120 * unit, (input?.top ?? h) - 20 * unit));
  const maxX = snap(w - houseWidth - 12 * unit);
  // A full-width composer leaves no right gutter. The cabin is already above it;
  // search the lower-right clearing instead of deleting the tallest fir at the edge.
  const inputRight = input && w - input.right >= houseWidth + 32 * unit ? input.right : 0;
  const minX = Math.min(maxX, Math.ceil(Math.max(w * 0.8, inputRight + 16 * unit) / pixel) * pixel);
  const preferredX = snap(w * 0.885);
  let houseX = minX, bestCost = Infinity;
  // Keep tall silhouettes, clearing only the lower tree in front of the cabin.
  for (let x = minX; x <= maxX; x += pixel) {
    const rect = { left: x - 5 * pixel, right: x + houseWidth + 5 * pixel,
      top: houseY - houseHeight * 1.9, bottom: houseY + 2 * pixel };
    const cost = candidates.filter(t => t.layer === "near" && treeIntersectsClearing(t, pixel, rect))
      .reduce((total, tree) => total + tree.height * tree.height, 0) + Math.abs(x - preferredX) * 0.05;
    if (cost < bestCost) { bestCost = cost; houseX = x; }
  }
  const clearing = { left: houseX - 5 * pixel, right: houseX + houseWidth + 5 * pixel,
    top: houseY - houseHeight * 1.9, bottom: houseY + 2 * pixel };
  const trees = candidates.filter(tree => tree.layer === "far" || !treeIntersectsClearing(tree, pixel, clearing));
  trees.sort((a, b) => (a.layer === b.layer ? a.height - b.height : a.layer === "far" ? -1 : 1));
  const rightCrown = trees.filter(tree => tree.layer === "near" && tree.side === "right")
    .sort((a, b) => a.y - a.height - (b.y - b.height))[0];
  return { width: w, height: h, pixel, seed,
    layout: { ...layout, rightForestTip: rightCrown ? { x: rightCrown.x, y: rightCrown.y - rightCrown.height } : undefined },
    stars, snow, trees, house: { x: houseX, y: houseY, width: houseWidth, height: houseHeight } };
}

export function nightSkyColor(t: number): [number, number, number] {
  const position = Math.max(0, Math.min(1, t));
  const s = Math.max(0, (position - 0.75) / 0.25);
  const settle = s * s * (3 - 2 * s);
  return [24 + 24 * position - 2 * settle, 18 + 20 * position + 6 * settle, 62 + 32 * position];
}

/** Positive RGB light calibrated against the indigo sky; fading changes alpha only. */
export function nightEmissionColor(color: string, yRatio: number, centerGlow = 0): string {
  const sky = nightSkyColor(yRatio);
  const halo = [240, 138, 108];
  const channels = [0, 1, 2].map(channel => Math.max(0, Math.round(
    parseInt(color.slice(1 + channel * 2, 3 + channel * 2), 16) - sky[channel] - halo[channel] * centerGlow,
  )));
  return `rgb(${channels.join(",")})`;
}

/** A fixed five-by-five asterisk; no fractional offsets or blurred diagonals. */
export function nightSnowAsterisk(x: number, y: number) {
  const cx = Math.round(x), cy = Math.round(y);
  return [[-2, 0, 5, 1], [0, -2, 1, 5], [-2, -2, 1, 1], [2, -2, 1, 1], [-2, 2, 1, 1], [2, 2, 1, 1]]
    .map(([dx, dy, width, height]) => ({ x: cx + dx, y: cy + dy, width, height }));
}

export function starOpacity(star: NightStar, timeMs: number): number {
  return star.alpha * (0.84 + 0.16 * Math.sin(timeMs / 1000 * star.speed + star.phase));
}

export function snowPosition(snow: NightSnow, scene: Pick<WinterNightScene, "width" | "height">, timeMs: number) {
  const seconds = timeMs / 1000;
  return { x: ((snow.x + seconds * (1.2 + snow.layer) + Math.sin(seconds * 0.15 + snow.phase) * snow.drift) % scene.width + scene.width) % scene.width,
    y: (snow.y + seconds * snow.speed) % scene.height };
}

/** One quiet meteor every 36 seconds, with a seeded trajectory. */
export function nightMeteor(scene: WinterNightScene, timeMs: number) {
  const cycle = Math.floor(timeMs / 36_000);
  const phase = timeMs % 36_000 - 24_000;
  if (phase < 0 || phase > 850) return null;
  const random = seededRandom(scene.seed + cycle * 31);
  const progress = phase / 850;
  return { x: scene.width * (0.25 + random() * 0.35) + progress * 100,
    y: scene.height * (0.12 + random() * 0.2) + progress * 50,
    alpha: Math.sin(progress * Math.PI) * 0.45 };
}

function circleOverlaps(x: number, y: number, radius: number, rect: NightRect): boolean {
  const dx = x - Math.max(rect.left, Math.min(rect.right, x));
  const dy = y - Math.max(rect.top, Math.min(rect.bottom, y));
  return dx * dx + dy * dy < radius * radius;
}

/** Keep the completed burst outside visible conversation/input ink, when present. */
export function doneFireworkPlacement(width: number, height: number, layout: NightSceneLayout = {}) {
  let radius = Math.min(width, height) * 0.12;
  const tip = layout.rightForestTip;
  let x = tip ? tip.x - radius * 0.4 : width * 0.9;
  let y = tip ? tip.y - radius * 0.6 : height * 0.52;
  const rects = [layout.conversationRect, layout.inputRect].filter((rect): rect is NightRect => !!rect);
  if (rects.some(rect => circleOverlaps(x, y, radius + 10, rect))) {
    const right = Math.max(...rects.filter(rect => y + radius + 10 > rect.top && y - radius - 10 < rect.bottom).map(rect => rect.right));
    const gutter = width - right - 20;
    if (gutter >= 64) { radius = Math.min(radius, gutter / 2); x = right + 10 + radius; }
    else {
      const bottom = Math.max(layout.conversationRect?.bottom ?? 0, 30);
      const inputTop = layout.inputRect?.top ?? height;
      if (inputTop - bottom >= radius * 2 + 24) y = bottom + radius + 12;
      else { radius = Math.max(18, Math.min(radius, (width - (layout.sidebarWidth ?? 0)) * 0.09)); x = width - radius - 10; }
    }
  }
  if (tip) {
    const nearForest = tip.y - radius * 0.6;
    if (!rects.some(rect => circleOverlaps(x, nearForest, radius + 10, rect))) y = nearForest;
  }
  x = Math.max(radius + 8, Math.min(width - radius - 8, x));
  y = Math.max(radius + 8, Math.min(height - radius - 8, y));
  return { x, y, radius };
}

/** Split only at actual text crossings; unrelated strokes retain their path. */
export function nightRaySections(ax: number, ay: number, bx: number, by: number, rect?: NightRect) {
  const cuts = [0, 1], dx = bx - ax, dy = by - ay;
  if (rect) {
    if (dx) for (const x of [rect.left, rect.right]) { const t = (x - ax) / dx; if (t > 0 && t < 1) cuts.push(t); }
    if (dy) for (const y of [rect.top, rect.bottom]) { const t = (y - ay) / dy; if (t > 0 && t < 1) cuts.push(t); }
  }
  cuts.sort((a, b) => a - b);
  const parts: { from: number; to: number; alpha: number }[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const from = cuts[i - 1], to = cuts[i];
    if (to - from < 1e-9) continue;
    const x = ax + dx * (from + to) / 2, y = ay + dy * (from + to) / 2;
    const alpha = rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom ? 0.5 : 1;
    const previous = parts[parts.length - 1];
    if (previous?.alpha === alpha) previous.to = to;
    else parts.push({ from, to, alpha });
  }
  return parts;
}

/** The visible ground boundary is runtime geometry, never a stored setting. */
export function nightSkylineY(width: number, height: number, layout: NightSceneLayout, x: number): number {
  const points = layout.skyline;
  if (!points?.length) return height * 0.8;
  const right = points.findIndex(point => point.x >= Math.max(0, Math.min(width, x)));
  if (right <= 0) return points[right < 0 ? points.length - 1 : 0].y;
  const a = points[right - 1], b = points[right];
  return a.y + (b.y - a.y) * (x - a.x) / Math.max(1, b.x - a.x);
}

/** Clear the core (30%), while the spokes may pass behind conversation text.
 * Keep the whole burst above the ground and to the right of the sidebar.
 */
export function mergeFireworkPlacement(width: number, height: number, layout: NightSceneLayout,
  preferred: { x: number; y: number; radius: number }, final: boolean) {
  const sidebar = Math.min(width - 1, Math.max(0, layout.sidebarWidth ?? 0));
  const rects = [layout.conversationRect, layout.inputRect].filter((r): r is NightRect => !!r);
  const minimum = final ? Math.min(width, height) * 0.15 : preferred.radius;
  const find = (radius: number, allowTopCrop = false) => {
    const left = Math.max(sidebar + radius + 4, layout.reflectionRange?.left ?? 0);
    const right = Math.min(width - radius - 4, layout.reflectionRange?.right ?? width);
    const top = (allowTopCrop ? radius * 0.3 : radius) + 4;
    if (right < left) return;
    let best: { x: number; y: number; radius: number } | undefined, bestCost = Infinity;
    const xs = [Math.max(left, Math.min(right, preferred.x)), ...Array.from({ length: 65 }, (_, i) => left + (right - left) * i / 64)];
    for (const x of xs) {
      const bottom = Math.min((layout.inputRect?.top ?? height) - radius - 4,
        nightSkylineY(width, height, layout, x) - radius - 4);
      if (bottom < top) continue;
      const ys = [Math.max(top, Math.min(bottom, preferred.y)), ...Array.from({ length: 65 }, (_, i) => top + (bottom - top) * i / 64)];
      for (const y of ys) {
        if (rects.some(rect => circleOverlaps(x, y, radius * 0.3 + 4, rect))) continue;
        const cost = Math.hypot(x - preferred.x, y - preferred.y);
        if (cost < bestCost) { bestCost = cost; best = { x, y, radius }; }
      }
    }
    return best;
  };
  const desired = find(preferred.radius);
  if (desired) return desired;
  // Only shrink a finale as far as its explicit large-burst floor. Narrow top
  // gutters may crop the outer tips, but must not turn merge into a done burst.
  if (final) {
    for (let radius = preferred.radius - 2; radius >= minimum; radius -= 2) {
      const point = find(radius);
      if (point) return point;
    }
  }
  const floor = Math.max(minimum, final ? Math.min(width, height) * 0.15 : preferred.radius);
  return find(floor, true) ?? { x: Math.max(sidebar + floor, Math.min(width - floor, preferred.x)),
    y: Math.max(floor * 0.3 + 4, Math.min(preferred.y, nightSkylineY(width, height, layout, preferred.x) - floor)), radius: floor };
}

export function createNightFireworks(kind: CelebrationKind, width: number, height: number, startedAt: number, seed: number, layout: NightSceneLayout = {}, sceneId: HanabiSceneId = "winter-night"): NightFirework[] {
  const random = seededRandom(seed);
  const scale = Math.min(width, height);
  const styles: FireworkStyle[] = ["chrysanthemum", "willow", "ring", "chrysanthemum", "chrysanthemum"];
  return Array.from({ length: kind === "merge" ? 5 : 1 }, (_, index) => {
    const final = kind === "merge" && index === 4;
    const primary = kind === "done" || final;
    const style = kind === "done" ? "chrysanthemum" : styles[index];
    const colorIndex = Math.floor(random() * 10);
    const summerColors = ["#F08A6C", "#f2cc8f", "#f4bad0", "#9bd9ce", "#a9b8f4"];
    const color = sceneId === "summer-seaside" && !primary ? summerColors[((seed >>> 0) + index) % summerColors.length] : style === "willow" ? "#f2cc8f" : primary ? "#F08A6C" : colorIndex < 4 ? "#F08A6C" : colorIndex < 7 ? "#f2cc8f" : colorIndex < 9 ? "#f4bad0" : "#9bd9ce";
    let placement = kind === "done" ? doneFireworkPlacement(width, height, layout)
      : { x: width * [0.57, 0.85, 0.25, 0.43, 0.77][index], y: height * [0.35, 0.42, 0.22, 0.46, 0.32][index],
        radius: scale * (style === "ring" ? 0.095 : final ? 0.235 : 0.12 + random() * 0.025) };
    if (sceneId === "summer-seaside" && kind === "merge") placement.radius *= 1.25;
    if (kind === "merge" && ((layout.sidebarWidth ?? 0) > 0 || layout.conversationRect || layout.inputRect))
      placement = mergeFireworkPlacement(width, height, sceneId === "summer-seaside" && !layout.skyline ? {
        ...layout, skyline: [{ x: 0, y: height * 0.7 }, { x: width, y: height * 0.7 }],
        reflectionRange: { left: (layout.sidebarWidth ?? 0) + (width - (layout.sidebarWidth ?? 0)) * 0.2, right: width * 0.85 },
      } : layout, placement, final);
    const rays = style === "ring" ? 28 : primary ? 24 : 30;
    return { ...placement,
      startedAt: startedAt + (final ? 2500 : index * 530), launchMs: 760,
      duration: style === "willow" ? 3600 : 2900, style, color, core: primary ? "#F7C6A8" : "#ffe1bd", final,
      rays: Array.from({ length: rays }, (_, ray) => ({
        angle: style === "willow" ? Math.PI / 2 + (ray / (rays - 1) - 0.5) * 140 * Math.PI / 180
          : ray * Math.PI * 2 / rays + random() * 0.018,
        length: style === "ring" ? 0.9 + random() * 0.15 : ray % 2 ? 0.95 + random() * 0.05 : 0.6 + random() * 0.15,
        phase: random() * Math.PI * 2,
      })),
    };
  });
}

/** The light envelope never introduces an opaque/dark late-life stroke. */
export function nightFireworkLight(firework: NightFirework, progress: number) {
  const p = Math.max(0, Math.min(1, progress));
  const birth = Math.min(1, p * 28);
  const late = Math.pow(Math.max(0, (1 - p) / 0.3), 2);
  const alpha = birth * (p < 0.7 ? 1 : late);
  const glowEnd = firework.style === "chrysanthemum" ? 0.7 : 0.5;
  return { alpha: firework.style === "willow" ? alpha * Math.pow(1 - p, 0.6) : alpha,
    outerOnly: p >= 0.7, sparksOnly: p >= 0.82,
    glowAlpha: Math.min(1, Math.max(0, (glowEnd - p) / 0.16)) * birth,
    coreAlpha: Math.min(1, Math.max(0, ((firework.style === "chrysanthemum" ? 0.6 : 0.5) - p) / 0.1)) * birth };
}

export function nightFireworkFrame(firework: NightFirework, timeMs: number) {
  const age = timeMs - firework.startedAt - firework.launchMs;
  if (age < 0 || age >= firework.duration) return null;
  const progress = age / firework.duration;
  return { progress, expansion: 1 - Math.exp(-5 * progress),
    alpha: nightFireworkLight(firework, progress).alpha,
    flash: Math.max(0, 1 - age / 330) * 0.14 };
}

export function nightParticle(firework: NightFirework, ray: NightFirework["rays"][number], progress: number) {
  const expansion = 1 - Math.exp(-5 * Math.max(0, progress));
  const radius = firework.radius * ray.length * expansion;
  const gravity = firework.style === "willow" ? 0.6 : 0.25;
  const willowScale = firework.style === "willow" ? 0.5 : 1;
  const willowDrop = firework.style === "willow" ? 0.9 : 1;
  const fallVariation = firework.style === "willow" ? 0.8 + 0.2 * Math.cos(ray.phase) : 1;
  return { x: firework.x + Math.cos(ray.angle) * radius * willowScale,
    y: firework.y + Math.sin(ray.angle) * radius * willowDrop + firework.radius * progress * progress * gravity * fallVariation };
}

export function nightCanvasScale(devicePixelRatio: number): number {
  return Number.isFinite(devicePixelRatio) ? Math.max(1, Math.min(2, devicePixelRatio)) : 1;
}
export function fireworkEnd(firework: NightFirework): number {
  return firework.startedAt + firework.launchMs + firework.duration;
}

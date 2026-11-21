import type { HanabiSceneId } from "../types/theme";
import { normalizeHanabiSceneId } from "./hanabiScenes";
import { createWinterNightScene, seededRandom, WINTER_NIGHT_SEED, type NightSceneLayout, type WinterNightScene } from "./hanabiScene";

export interface SceneMark { x: number; y: number; size: number; color: string; alpha: number; glyph: "/" | "\\" | "*" | "-" }
export interface SceneBuilding { x: number; y: number; width: number; height: number; roof: number; lit: boolean[] }
export interface SceneBranch { points: { x: number; y: number }[]; width: number; dotted?: boolean; bark?: boolean }
export interface SceneryLane { left: number; right: number }
export interface SceneryHero { kind: "pine" | "sakura" | "maple" | "lighthouse" | "town"; side: number; x: number; y: number; width: number; height: number }
export interface SceneScenery {
  id: Exclude<HanabiSceneId, "winter-night">;
  skyline: { x: number; y: number }[];
  marks: SceneMark[]; buildings: SceneBuilding[]; branches: SceneBranch[];
  crowns: { x: number; y: number; rx: number; ry: number; color: string; alpha: number }[];
  heroes: SceneryHero[]; companions: SceneryHero[]; midground: SceneMark[]; midgroundBuildings: SceneBuilding[]; banks: { y: number; left: number; right: number }[]; lanes: SceneryLane[]; baseline: number; horizon: number;
  lights: { x: number; y: number; pink?: boolean }[];
  glows: { x: number; y: number }[];
  water: { x: number; y: number; width: number; phase: number }[];
  boats: { x: number; y: number }[];
  bridge: { x: number; y: number }; moon: { x: number; y: number };
}
export type HanabiScene = WinterNightScene & { scenery?: SceneScenery };

/** Prefer the input gutters; a full-width composer uses the message gutters above it.
 * On a narrow/full-bleed view use proportional side quarters instead.
 */
export function sceneryPlacement(w: number, h: number, layout: NightSceneLayout, p: number) {
  const sidebar = Math.max(0, Math.min(w * 0.6, layout.sidebarWidth ?? 0));
  const work = w - sidebar, margin = Math.min(16, work * 0.025);
  const start = sidebar + margin, end = w - margin;
  const minimum = Math.min(64, work * 0.2);
  const input = layout.inputRect, reading = layout.conversationRect;
  const leftEdge = input && input.left - margin >= start + minimum ? input.left - margin
    : reading && reading.left - margin >= start + minimum ? reading.left - margin : sidebar + work * 0.23;
  const rightEdge = input && input.right + margin <= end - minimum ? input.right + margin
    : reading && reading.right + margin <= end - minimum ? reading.right + margin : w - work * 0.23;
  const lanes = [{ left: start, right: Math.min(sidebar + work * 0.35, Math.max(start + minimum, leftEdge)) },
    { left: Math.max(sidebar + work * 0.65, Math.min(end - minimum, rightEdge)), right: end }];
  const baseline = Math.max(h * 0.62, Math.min(h + p * 3, (input?.top ?? h + p * 6) - p * 3));
  return { lanes, baseline, sidebar, work };
}

/** Geometry is generated once per resize. Painting never consumes random state. */
export function createHanabiScene(id: unknown, width: number, height: number, seed = WINTER_NIGHT_SEED, layout: NightSceneLayout = {}): HanabiScene {
  const sceneId = normalizeHanabiSceneId(id);
  const base = createWinterNightScene(width, height, seed, layout);
  if (sceneId === "winter-night") return base;
  const { width: w, height: h, pixel: p } = base;
  const number = ["summer-seaside", "sakura-night", "harbor-night", "onsen-autumn"].indexOf(sceneId) + 1;
  const random = seededRandom(seed + number * 997 + 117);
  const snap = (n: number) => Math.round(n / p) * p;
  const { lanes, baseline, sidebar, work } = sceneryPlacement(w, h, layout, p);
  const marks: SceneMark[] = [], buildings: SceneBuilding[] = [], branches: SceneBranch[] = [], heroes: SceneryHero[] = [];
  const companions: SceneryHero[] = [], midground: SceneMark[] = [], midgroundBuildings: SceneBuilding[] = [];
  const crowns: SceneScenery["crowns"] = [], lights: SceneScenery["lights"] = [], boats: SceneScenery["boats"] = [];
  const horizon = snap(h * (sceneId === "summer-seaside" ? 0.7 : 0.8));
  const skyline = Array.from({ length: 65 }, (_, i) => {
    const x = i * w / 64, t = Math.min(1, Math.max(0, (x - sidebar) / work));
    const edge = Math.pow(Math.abs(t * 2 - 1), 1.1);
    return { x: snap(x), y: snap(h * (sceneId === "harbor-night" ? 0.82 - edge * 0.19
      : sceneId === "summer-seaside" ? 0.715 - edge * 0.1 : 0.85 - edge * 0.15) - random() * p * 3) };
  });
  const ridgeAt = (x: number) => {
    const i = Math.max(0, Math.min(skyline.length - 2, Math.floor(x / w * 64)));
    const a = skyline[i], b = skyline[i + 1];
    return a.y + (b.y - a.y) * (x - a.x) / Math.max(p, b.x - a.x);
  };
  const addMark = (x: number, y: number, color: string, glyph: SceneMark["glyph"], alpha = 1) =>
    marks.push({ x: snap(x), y: snap(y), color, glyph, alpha, size: p });
  function deciduous(hero: SceneryHero, autumn: boolean, variant: number) {
    const { x, y, height: ht, width: wd } = hero;
    const sign = hero.side ? -1 : 1, trunk = x - sign * wd * 0.12;
    // A broad root forks halfway up, rather than carrying an oval on one pole.
    const fork = { x: trunk + sign * wd * 0.06, y: y - ht * 0.44 };
    branches.push({ width: p * 6, bark: true, points: [{ x: trunk - p, y }, { x: trunk, y: y - ht * 0.18 }, fork] });
    for (const direction of [-1, 1]) branches.push({ width: p * 4, bark: true, points: [fork,
      { x: x + direction * wd * 0.16, y: y - ht * 0.66 }, { x: x + direction * wd * 0.28, y: y - ht * 0.87 }] });
    const shades = autumn ? ["#7a3b3b", "#9a5a2e", "#8a7a3a"] : ["#6e4766"];
    const leaf = autumn ? [["#e9927c", "#be6565"], ["#f3ad70", "#c9834f"], ["#edcf83", "#b99e56"]][variant % 3]
      : ["#f4bad0", "#ffd9e6", "#c98bb0"];
    const cy = y - ht * (autumn ? 0.68 : 0.76), rx = wd * (autumn ? 0.49 : 0.7);
    const ry = autumn ? ht * 0.29 : Math.min(ht * 0.13, rx / 1.65);
    crowns.push({ x, y: cy, rx, ry, color: shades[variant % shades.length], alpha: autumn ? 0.7 : 0.6 });
    let row = 0;
    for (let gy = -ry; gy <= ry; gy += p * (autumn ? 4 : 5), row++) {
      for (let gx = -rx; gx <= rx; gx += p * (autumn ? 4 : 5)) {
        if (gx * gx / (rx * rx) + gy * gy / (ry * ry) > 0.94) continue;
        const gap = autumn ? 0.22 : 0.12;
        if (random() < gap || (autumn && Math.sin(gx / (p * 9) + variant) * Math.cos(gy / (p * 8)) < -0.8)) continue;
        const col = Math.round(gx / (p * 4));
        addMark(x + gx + (row % 2) * p * 2, cy + gy,
          leaf[Math.abs(Math.floor(row / 2) + Math.floor(col / 2)) % leaf.length], "*",
          autumn ? (col % 2 ? 0.94 : 1) : 0.8 + random() * 0.2);
      }
    }
    for (let limb = 0; limb < (autumn ? 4 : hero.side ? 5 : 7); limb++) {
      const direction = (limb % 2 ? -1 : 1) * sign;
      const start = { x: fork.x, y: y - ht * (0.5 + limb * 0.035) };
      const tx = x + direction * wd * (0.56 + (limb % 3) * 0.1), ty = y - ht * (0.72 + limb * 0.02);
      const points = Array.from({ length: 13 }, (_, k) => {
        const t = k / 12;
        return { x: start.x + (tx - start.x) * t, y: start.y + (ty - start.y) * t - Math.sin(t * Math.PI) * ht * 0.17 };
      });
      branches.push({ width: p * 2, points });
      if (!autumn) for (let drop = 0; drop < 4; drop++) {
        const root = points[5 + drop * 2];
        const len = Math.min(h * (0.25 + random() * 0.15), y - root.y - p * (3 + random() * 5));
        const count = Math.max(17, Math.ceil(len / (p * 3)));
        const drops = Array.from({ length: count }, (_, k) => {
          const t = k / (count - 1);
          return { x: root.x + Math.sin(t * 2.2) * direction * p * 3, y: root.y + len * t };
        });
        branches.push({ width: p, dotted: true, points: drops });
        drops.forEach((point, k) => { if (k % 2 === 0 && random() > 0.22) addMark(point.x + (drop % 2 ? p : -p), point.y, leaf[k % 3], "*", 0.95); });
      }
    }
  }
  for (const [side, lane] of lanes.entries()) {
    const laneW = Math.max(p * 4, lane.right - lane.left), x = snap((lane.left + lane.right) / 2);
    const kind = sceneId === "sakura-night" ? "sakura" : sceneId === "onsen-autumn" ? "maple"
      : sceneId === "harbor-night" ? side === 1 ? "lighthouse" : "town" : "pine";
    const ht = h * (sceneId === "sakura-night" ? side ? 0.35 : 0.45 : sceneId === "onsen-autumn" ? 0.34 : side ? 0.36 : 0.43);
    const hero: SceneryHero = { kind, side, x, y: snap(baseline), width: snap(laneW * 0.94), height: snap(Math.min(ht, w * 0.65)) };
    if (kind === "lighthouse") { hero.x = snap(lane.left + laneW * 0.76); hero.y = horizon - p * 3; }
    heroes.push(hero);
    if (sceneId === "summer-seaside" || sceneId === "sakura-night") {
      const companion = { ...hero, x: snap(x + (side ? -1 : 1) * laneW * 0.34),
        height: snap(h * (side ? 0.22 : 0.26)), width: snap(hero.width * 0.65) };
      companions.push(companion);
      if (sceneId === "sakura-night") deciduous(companion, false, side + 2);
    }
    if (sceneId === "harbor-night" && side === 1) companions.push({ ...hero, kind: "pine", x: snap(w - p * 4),
      y: hero.y + p * 4, height: snap(h * 0.24), width: snap(laneW * 0.58) });
    if (sceneId === "sakura-night") deciduous(hero, false, side);
    if (sceneId === "onsen-autumn") {
      // Small trees recede behind the principal tree; the inn never draws over its canopy.
      for (let n = 3; n >= 0; n--) {
        const tree = n === 0 ? hero : { ...hero, x: snap(lane.left + laneW * (0.2 + n * 0.19)),
          height: snap(h * (0.2 + n * 0.025)), width: snap(hero.width * 0.46) };
        deciduous(tree, true, side * 4 + n);
      }
    }
    if (sceneId === "sakura-night" || sceneId === "summer-seaside") {
      for (let n = 0; n < (sceneId === "summer-seaside" ? 5 : 2); n++) lights.push({
        x: snap(lane.left + laneW * (0.14 + n * (sceneId === "summer-seaside" ? 0.18 : 0.7))),
        y: snap(baseline - h * (sceneId === "summer-seaside" ? 0.045 : 0.07) + Math.sin(n * 0.8) * p * 2), pink: sceneId === "sakura-night" });
    }
    const count = sceneId === "harbor-night" ? side ? 9 : 20 : sceneId === "onsen-autumn" ? 2 : sceneId === "summer-seaside" ? 3 : 0;
    for (let n = 0; n < count; n++) {
      const cols = sceneId === "harbor-night" ? side ? 3 : 4 : count;
      const available = sceneId === "harbor-night" && side ? Math.max(p * 12, hero.x - lane.left - laneW * 0.22) : laneW;
      const bw = snap(sceneId === "onsen-autumn" ? Math.min(work * 0.085, laneW * 0.7) : sceneId === "summer-seaside" ? laneW * 0.26 : Math.max(p * 4, available * (side ? 0.21 : 0.19)));
      const bx = snap(sceneId === "onsen-autumn" ? side ? lane.left - p * 5 - bw * (n + 1) : lane.right + p * 5 + bw * n
        : lane.left + (n % cols) * (available - bw) / Math.max(1, cols - 1));
      const by = sceneId === "harbor-night" ? Math.min(horizon - p * 4, ridgeAt(bx + bw / 2) + p * 3 + Math.floor(n / cols) * h * 0.035)
        : baseline - (sceneId === "onsen-autumn" ? h * 0.02 : 0);
      buildings.push({ x: bx, y: snap(by), width: bw,
        height: snap(h * (sceneId === "onsen-autumn" ? 0.065 : sceneId === "summer-seaside" ? 0.04 : 0.025 + random() * 0.025)),
        roof: Math.floor(random() * 3), lit: Array.from({ length: 8 }, () => random() > 0.16) });
    }
  }
  // Shared shore geometry drives water paint, waves, stars and reflections.
  const banks = sceneId === "summer-seaside" ? [
    { y: horizon, left: lanes[0].right + work * 0.04, right: lanes[1].left - work * 0.04 },
    { y: h, left: lanes[0].right - work * 0.02, right: lanes[1].left + work * 0.02 },
  ] : sceneId === "harbor-night" ? [
    { y: horizon, left: sidebar + work * 0.4, right: lanes[1].left - work * 0.025 },
    { y: h, left: sidebar + work * 0.22, right: lanes[1].left + work * 0.015 },
  ] : [];
  for (let x = p * 3; x < w; x += p * 13) {
    const y = snap(Math.min(ridgeAt(x), sceneId === "summer-seaside" || sceneId === "harbor-night" ? horizon - p * 3 : h) - p * 2);
    if (sceneId === "summer-seaside") {
      if (Math.round(x / (p * 13)) % 3 === 0) midgroundBuildings.push({ x, y, width: p * 8, height: p * 4, roof: 1, lit: [true, false, true, false] });
      else for (const dx of [0, p * 3]) {
        midground.push({ x: x + dx, y: y - p * 2, size: Math.max(1, p - 1), color: "#a59aa8", glyph: "/", alpha: 0.64 });
      }
    } else if (sceneId === "harbor-night") {
      for (let n = 0; n < 4; n++) midground.push({ x: x + n * p * 2, y: y + p * (n % 2), size: 1, color: "#efbe83", glyph: "-", alpha: 0.64 });
      if (x > banks[0].left && x + p * 8 < banks[0].right && Math.round(x / (p * 13)) % 2 === 0)
        midgroundBuildings.push({ x, y: horizon - p * 2, width: p * 7, height: p * 4, roof: 0, lit: [true, false, true, false] });
    } else {
      const colors = sceneId === "sakura-night" ? ["#c98bb0", "#f4bad0"] : ["#be6565", "#c9834f", "#b99e56"];
      for (let n = 0; n < 5; n++) midground.push({ x: snap(x + (n - 2) * p * 2), y: snap(y + Math.abs(n - 2) * p),
        size: Math.max(1, p - 1), color: colors[Math.floor(random() * colors.length)], glyph: "*", alpha: 0.58 + random() * 0.15 });
    }
  }
  const water: SceneScenery["water"] = [];
  if (sceneId !== "sakura-night") for (let row = 0, y = horizon + p * 3; y < h; y += p * 4, row++) {
    for (let x = (row % 2) * p * 7; x < w; x += p * 15) {
      const bank = banks.length ? interpolateBanks(banks, y) : undefined;
      const width = p * (2 + Math.floor(random() * 4));
      if (bank && (x < bank.left + p * 2 || x + width > bank.right - p * 2)) continue;
      water.push({ x: snap(x), y: snap(y), width, phase: row % 2 ? 0.3 : 1.1 });
    }
  }
  if (sceneId === "harbor-night") {
    const tower = heroes[1];
    const left = Math.max(lanes[1].left - work * 0.11, banks[0].left + p * 12);
    const right = Math.min(banks[0].right - p * 14, tower.x - p * 25);
    for (let n = 0; n < 3; n++) boats.push({ x: snap(left + (right - left) * n / 2), y: snap(h * (0.83 + n * 0.015)) });
  }
  const windowCenter = (group: SceneBuilding[]) => ({
    x: group.reduce((sum, b) => sum + b.x + b.width / 2, 0) / group.length,
    y: group.reduce((sum, b) => sum + b.y - b.height / 2, 0) / group.length,
  });
  const tower = heroes.find(hero => hero.kind === "lighthouse");
  const glows = sceneId === "onsen-autumn" ? [
    windowCenter(buildings.slice(0, 2)), windowCenter(buildings.slice(2)),
  ] : sceneId === "harbor-night" ? [
    windowCenter(buildings.filter(b => b.x < sidebar + work * 0.5)), { x: tower!.x, y: tower!.y - tower!.height + p * 3 },
  ] : lights.filter((_, i) => i === 1 || i === lights.length - 2).map(light => ({ x: light.x, y: light.y }));
  const starScene = createWinterNightScene(w, h, seed + number * 31);
  let stars = starScene.stars.slice(0, Math.round(starScene.stars.length * (sceneId === "harbor-night" ? 0.6 : 1)));
  if (sceneId === "summer-seaside") stars = [...stars, ...Array.from({ length: 420 }, (_, n) => {
    const t = n / 419, spread = (random() + random() + random() - 1.5) * 0.13;
    return { x: Math.round(w * (0.04 + t * 0.92)), y: Math.round(h * (0.05 + t * 0.42 + spread)),
      size: n % 5 === 0 ? 2 : 1, alpha: 0.36 + random() * 0.3, phase: random() * Math.PI * 2, speed: 0.3, cross: false };
  })];
  const skyBoundary = skyline.map(point => ({ ...point, y: Math.min(point.y,
    sceneId === "summer-seaside" || sceneId === "harbor-night" ? horizon : h) }));
  stars = stars.filter(star => star.y >= 0 && star.y + Math.max(star.size, star.cross ? 5 : 1) < Math.min(ridgeAt(star.x),
    sceneId === "summer-seaside" || sceneId === "harbor-night" ? horizon : h));
  return { ...base, layout: { ...layout, rightForestTip: undefined, skyline: skyBoundary,
    ...(sceneId === "summer-seaside" ? { reflectionRange: { left: banks[0].left + p * 4, right: banks[0].right - p * 4 } } : {}) }, trees: [], stars,
    snow: sceneId === "sakura-night" ? base.snow.filter((_, i) => i % 2 === 0) : [],
    scenery: { id: sceneId, skyline, marks, buildings, branches, crowns, heroes, companions, midground, midgroundBuildings, banks, lanes, baseline, horizon, lights, glows, water, boats,
      bridge: { x: snap(sidebar + work * 0.5), y: snap(Math.min(h * 0.84, (layout.inputRect?.top ?? h) - p * 16)) },
      moon: { x: snap(sidebar + work * 0.85), y: snap(h * 0.13) } } };
}

function interpolateBanks(banks: SceneScenery["banks"], y: number) {
  const a = banks[0], b = banks[banks.length - 1], t = Math.max(0, Math.min(1, (y - a.y) / Math.max(1, b.y - a.y)));
  return { left: a.left + (b.left - a.left) * t, right: a.right + (b.right - a.right) * t };
}
export function sceneryWaterSpan(art: SceneScenery, y: number) {
  return art.banks.length && y >= art.horizon ? interpolateBanks(art.banks, y) : undefined;
}
export function sceneryHasWater(art: SceneScenery, x: number, y: number) {
  const span = sceneryWaterSpan(art, y);
  return !!span && x >= span.left && x <= span.right;
}
export function clipSceneryWater(ctx: CanvasRenderingContext2D, art: SceneScenery) {
  ctx.beginPath();
  art.banks.forEach((bank, i) => { if (i === 0) ctx.moveTo(bank.left, bank.y); else ctx.lineTo(bank.left, bank.y); });
  for (const bank of [...art.banks].reverse()) ctx.lineTo(bank.right, bank.y);
  ctx.closePath(); ctx.clip();
}

export function scenerySkyColor(id: HanabiSceneId, t: number): [number, number, number] {
  const stop = Math.max(0, Math.min(1, t));
  const colors: Record<HanabiSceneId, [number, number, number, number, number, number]> = {
    "winter-night": [24, 18, 62, 46, 44, 94], "summer-seaside": [12, 19, 49, 26, 44, 73],
    "sakura-night": [23, 17, 55, 61, 39, 84], "harbor-night": [13, 22, 52, 29, 47, 79],
    "onsen-autumn": [23, 20, 48, 48, 41, 67],
  };
  const c = colors[id];
  return [c[0] + (c[3] - c[0]) * stop, c[1] + (c[4] - c[1]) * stop, c[2] + (c[5] - c[2]) * stop];
}

/** One-pixel raster staircases keep each slash continuous at every art scale. */
function line(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, p: number) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
  for (let i = 0; i <= steps; i++) ctx.fillRect(Math.round(ax + (bx - ax) * i / steps), Math.round(ay + (by - ay) * i / steps), p, p);
}
function glyph(ctx: CanvasRenderingContext2D, mark: SceneMark) {
  const { x, y } = mark, p = Math.max(1, Math.round(mark.size));
  ctx.fillStyle = mark.color; ctx.globalAlpha = mark.alpha;
  if (mark.glyph === "*") {
    ctx.fillRect(x - p, y, p * 3, p); ctx.fillRect(x, y - p, p, p * 3);
    ctx.fillRect(x - p, y - p, p, p); ctx.fillRect(x + p, y + p, p, p);
  } else if (mark.glyph === "-") ctx.fillRect(x, y, p * 4, p);
  else line(ctx, x, y, x + p * 2, y + (mark.glyph === "/" ? -1 : 1) * p * 4, p);
}
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, alpha: number, color = "240,171,120") {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, "rgba(" + color + "," + alpha + ")"); g.addColorStop(1, "rgba(" + color + ",0)");
  ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}
function building(ctx: CanvasRenderingContext2D, b: SceneBuilding, p: number, autumn: boolean, summer: boolean) {
  ctx.globalAlpha = 1; ctx.fillStyle = autumn ? "#342b43" : "#26344f";
  ctx.fillRect(b.x, b.y - b.height, b.width, b.height);
  const roofY = b.y - b.height, peak = roofY - p * (autumn ? 5 : 2 + b.roof);
  ctx.fillStyle = autumn ? "#544257" : summer ? "#5c4a63" : "#48516f";
  for (let row = peak; row <= roofY; row += p) {
    const half = (row - peak) / Math.max(p, roofY - peak) * (b.width / 2 + p * 2);
    ctx.fillRect(Math.round(b.x + b.width / 2 - half), row, half * 2 + p, p);
    for (let x = b.x + b.width / 2 - half + p * 2; x < b.x + b.width / 2 + half - p * 2; x += p * 5) {
      ctx.fillStyle = autumn ? "#ad8e9c" : "#8b9ab4";
      line(ctx, x, row, x + p, row - p, p);
      ctx.fillStyle = autumn ? "#544257" : summer ? "#5c4a63" : "#48516f";
    }
  }
  ctx.fillStyle = autumn ? "#c1a2ad" : "#8b9ab4";
  line(ctx, b.x - p * 2, roofY, b.x + b.width / 2, peak, p);
  line(ctx, b.x + b.width / 2, peak, b.x + b.width + p * 2, roofY, p);
  ctx.fillStyle = "#efbe83";
  b.lit.forEach((lit, index) => {
    if (!lit) return;
    ctx.globalAlpha = index % 3 ? 1 : 0.75;
    const dx = (index % 4 + 0.5) * b.width / 4;
    const wx = Math.round((b.x + dx) / p) * p;
    const wy = b.y - p * 2 - Math.floor(index / 4) * p * (autumn ? 4 : 3);
    ctx.fillRect(wx, wy, p * (autumn ? 2 : 1), p * (autumn ? 3 : 2));
    if (autumn) {
      ctx.fillStyle = "#9f866d"; ctx.fillRect(wx, wy + p, p * 2, 1); ctx.fillRect(wx + p, wy, 1, p * 3);
      ctx.fillStyle = "#efbe83";
    }
  }); ctx.globalAlpha = 1;
  if (autumn) {
    ctx.fillStyle = "#806274";
    for (let x = b.x; x <= b.x + b.width; x += p * 7) ctx.fillRect(x, b.y - b.height, p, b.height);
  }
}
function lantern(ctx: CanvasRenderingContext2D, x: number, y: number, p: number, pink: boolean) {
  glow(ctx, x, y, 24 * p / 3, 0.15);
  ctx.fillStyle = "#68506c"; ctx.fillRect(x, y, p, p * 9);
  ctx.fillStyle = "#d3a39d"; ctx.fillRect(x - p * 1.5, y - p * 2, p * 3, p);
  ctx.fillStyle = pink ? "#f4bad0" : "#f0ab78";
  ctx.fillRect(x - p, y - p, p * 2, p * 2);
  ctx.fillStyle = "#ffe0ac"; ctx.fillRect(x, y - p, p, p * 2);
}
function ridge(ctx: CanvasRenderingContext2D, scene: HanabiScene, offset: number, color: string, edge?: string) {
  const { scenery: art, height: h, pixel: p } = scene;
  ctx.globalAlpha = 1;
  for (let i = 1; i < art!.skyline.length; i++) {
    const a = art!.skyline[i - 1], b = art!.skyline[i];
    for (let x = a.x; x < b.x; x += p) {
      const y = Math.round((a.y + offset + (b.y - a.y) * (x - a.x) / Math.max(p, b.x - a.x)) / p) * p;
      ctx.fillStyle = color; ctx.fillRect(x, y, p, h - y);
      if (edge) { ctx.fillStyle = edge; ctx.fillRect(x, y, p, p); }
    }
  }
}
function pine(ctx: CanvasRenderingContext2D, hero: SceneryHero, p: number) {
  const { x, y, height: h, width: w } = hero, sign = hero.side ? -1 : 1;
  const bends = [{ x: x - sign * w * 0.26, y }, { x: x - sign * w * 0.08, y: y - h * 0.38 },
    { x: x + sign * w * 0.16, y: y - h * 0.72 }, { x: x + sign * w * 0.06, y: y - h * 0.96 }];
  ctx.globalAlpha = 1; ctx.fillStyle = "#574950";
  for (let i = 1; i < bends.length; i++) line(ctx, bends[i - 1].x, bends[i - 1].y, bends[i].x, bends[i].y, p * (5 - i));
  for (let tier = 0; tier < 4; tier++) {
    const cy = y - h * (0.96 - tier * 0.19), rx = w * (tier % 2 ? 0.5 : 0.43), ry = Math.max(p * 3, h * 0.035);
    const cx = x + sign * w * (tier % 2 ? -0.12 : 0.08);
    ctx.fillStyle = "#77645d"; line(ctx, x, cy + ry * 1.8, cx + sign * rx * 0.7, cy + ry * 0.2, p * 2);
    crown(ctx, { x: cx, y: cy, rx, ry, color: tier % 2 ? "#18403f" : "#1b494a", alpha: 1 }, p);
    ctx.fillStyle = "#102f37"; ctx.fillRect(cx - rx * 0.75, Math.round((cy + ry * 0.6) / p) * p, rx * 1.5, p * 2);
    const gp = Math.max(1, p - 1);
    for (let row = -1; row <= 0; row++) for (let col = -4; col <= 4; col++) {
      const gx = cx + col * gp * 5, gy = cy + row * gp * 4;
      if (Math.abs(gx - cx) + gp * 3 > rx * 0.85) continue;
      glyph(ctx, { x: gx, y: gy, size: gp, glyph: col < 0 ? "/" : "\\", color: col % 2 ? "#81c3ab" : "#549d8e", alpha: 0.96 });
    }
    ctx.globalAlpha = 1;
  }
}
function lighthouse(ctx: CanvasRenderingContext2D, hero: SceneryHero, p: number) {
  const { x, y, height: h, width: w } = hero, half = Math.min(w * 0.21, h * 0.15), top = y - h;
  for (let row = top + p * 6; row < y; row += p) {
    const extent = half * (0.55 + 0.45 * (row - top) / h);
    const red = Math.floor((row - top) / (h / 5)) % 2 === 1;
    ctx.fillStyle = red ? "#8e4e60" : "#687c94"; ctx.fillRect(x - extent, row, extent * 2, p);
    ctx.fillStyle = red ? "#d78885" : "#d3d5cf"; ctx.fillRect(x - extent, row, extent * 0.8, p);
  }
  ctx.fillStyle = "#48506a"; ctx.fillRect(x - half * 1.55, y, half * 3.1, p * 5);
  ctx.fillStyle = "#a2a4ae"; ctx.fillRect(x - half * 1.65, y - p, half * 3.3, p * 2);
  ctx.fillStyle = "#28354d"; ctx.fillRect(x - half * 0.85, top + p * 5, half * 1.7, p * 2);
  ctx.fillStyle = "#ffe0a8"; ctx.fillRect(x - half * 0.65, top + p, half * 1.3, p * 4);
  ctx.fillStyle = "#92a0b2"; line(ctx, x - half, top, x, top - p * 4, p); line(ctx, x, top - p * 4, x + half, top, p);
  ctx.fillStyle = "#b5b3ab"; ctx.fillRect(x - half, top + p * 5, half * 2, p);
  glow(ctx, x, top + p * 3, p * 7, 0.3, "255,224,168");
}
function crown(ctx: CanvasRenderingContext2D, c: SceneScenery["crowns"][number], p: number) {
  ctx.globalAlpha = c.alpha; ctx.fillStyle = c.color;
  for (let y = -c.ry; y <= c.ry; y += p) {
    const half = Math.sqrt(Math.max(0, 1 - y * y / (c.ry * c.ry))) * c.rx;
    ctx.fillRect(Math.round((c.x - half) / p) * p, Math.round((c.y + y) / p) * p, Math.round(half * 2 / p) * p, p);
  } ctx.globalAlpha = 1;
}

export function paintSceneryStill(ctx: CanvasRenderingContext2D, scene: HanabiScene) {
  const art = scene.scenery;
  if (!art) return;
  const { width: w, height: h, pixel: p } = scene;
  if (art.id === "summer-seaside") {
    ridge(ctx, scene, -h * 0.035, "#292d52");
    ridge(ctx, scene, h * 0.01, "#33385f", "#4a4f7e");
  } else ridge(ctx, scene, 0, art.id === "onsen-autumn" ? "#302b49" : art.id === "harbor-night" ? "#2a2950" : "#292d52",
    art.id === "harbor-night" ? "#55567d" : undefined);
  const { sidebar, work } = sceneryPlacement(w, h, scene.layout, p);
  if (art.id === "summer-seaside" || art.id === "harbor-night") {
    for (let y = art.horizon; y < h; y += p) {
      const span = sceneryWaterSpan(art, y)!;
      if (art.id === "summer-seaside") {
        ctx.fillStyle = "#3a3550"; ctx.fillRect(0, y, span.left, p); ctx.fillRect(span.right, y, w - span.right, p);
      }
      ctx.fillStyle = art.id === "summer-seaside" ? "#12283e" : "#16263f";
      ctx.fillRect(Math.round(span.left / p) * p, y, Math.round((span.right - span.left) / p) * p, p);
      if (art.id === "harbor-night") {
        ctx.fillStyle = "#697891"; ctx.fillRect(Math.round(span.left / p) * p - p, y, p, p); ctx.fillRect(Math.round(span.right / p) * p, y, p * 2, p);
      }
    }
    const span = sceneryWaterSpan(art, art.horizon)!;
    ctx.fillStyle = "#60708c"; ctx.globalAlpha = 0.55; ctx.fillRect(span.left, art.horizon, span.right - span.left, p); ctx.globalAlpha = 1;
    if (art.id === "summer-seaside") for (const lane of art.lanes) {
      for (let y = art.horizon + p * 9; y < h; y += p * 7) for (let x = lane.left; x < lane.right; x += p * 9)
        glyph(ctx, { x, y, size: 1, glyph: "/", color: "#73627a", alpha: 0.68 });
    }
  }
  if (art.id === "onsen-autumn") {
    ctx.fillStyle = "#1b2d42";
    for (let y = h * 0.73; y < h; y += p) {
      const t = (y / h - 0.73) / 0.27, center = sidebar + work * (0.46 + t * 0.1), half = work * (0.018 + t * 0.1);
      ctx.fillRect(Math.round((center - half) / p) * p, Math.round(y / p) * p, Math.round(half * 2 / p) * p, p);
    }
  }
  // Broad warmth belongs to each visible light source, not to the hidden sidebar.
  for (const light of art.glows) glow(ctx, light.x, light.y, w * 0.13, 0.1);
  for (const mark of art.midground) glyph(ctx, mark);
  ctx.globalAlpha = 1;
  for (const b of art.midgroundBuildings) building(ctx, b, p, false, true);
  for (const hero of art.companions) if (hero.kind === "pine") pine(ctx, hero, p);
  for (const hero of art.heroes) if (hero.kind === "pine") pine(ctx, hero, p);
  // Inns are behind all foreground foliage, so their roof stitches cannot cross it.
  for (const b of art.buildings) building(ctx, b, p, art.id === "onsen-autumn", art.id === "summer-seaside");
  const paintBranches = () => { for (const branch of art.branches) {
    for (let i = 1; i < branch.points.length; i++) {
      const a = branch.points[i - 1], b = branch.points[i];
      const thickness = branch.bark ? Math.max(p * 3, branch.width * (1 - (i - 1) / branch.points.length * 0.5)) : branch.width;
      ctx.globalAlpha = 1; ctx.fillStyle = "#795b71";
      if (!branch.dotted || i % 2) line(ctx, a.x, a.y, b.x, b.y, thickness);
      if (branch.bark && i === 1) for (let t = 0.1; t < 0.9; t += 0.2) {
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        glyph(ctx, { x, y, size: Math.max(1, p - 1), glyph: "/", color: "#bd8d9b", alpha: 0.94 });
      }
    }
  }
  };
  // Autumn branches belong behind the canopy; cherry branches remain visible.
  if (art.id === "onsen-autumn") paintBranches();
  for (const c of art.crowns) crown(ctx, c, p);
  if (art.id !== "onsen-autumn") paintBranches();
  for (const mark of art.marks) glyph(ctx, mark);
  ctx.globalAlpha = 1;
  if (art.id === "summer-seaside") {
    ctx.fillStyle = "#b08b91";
    for (let i = 1; i < art.lights.length; i++) {
      if (i === art.lights.length / 2) continue;
      line(ctx, art.lights[i - 1].x, art.lights[i - 1].y - p * 3, art.lights[i].x, art.lights[i].y - p * 3, 1);
    }
  }
  for (const light of art.lights) lantern(ctx, light.x, light.y, p, !!light.pink);
  if (art.id === "harbor-night") {
    for (const hero of art.heroes) if (hero.kind === "lighthouse") lighthouse(ctx, hero, p);
    for (const boat of art.boats) {
      ctx.fillStyle = "#8696a9"; line(ctx, boat.x, boat.y, boat.x + p * 9, boat.y, p);
      ctx.fillStyle = "#35465c"; ctx.fillRect(boat.x + p, boat.y + p, p * 7, p * 2);
      ctx.fillStyle = "#aab0ad"; ctx.fillRect(boat.x + p * 4, boat.y - p * 6, p, p * 6);
      ctx.fillStyle = "#f5c58c"; ctx.fillRect(boat.x + p * 3, boat.y - p * 5, p * 2, p * 2);
      glow(ctx, boat.x + p * 4, boat.y - p * 4, p * 5, 0.12);
    }
  }
  if (art.id === "onsen-autumn") {
    const { x, y } = art.bridge;
    ctx.fillStyle = "#c5988c";
    for (let i = -16; i <= 16; i++) {
      const by = y - Math.cos(i / 16 * Math.PI / 2) * p * 5;
      ctx.fillRect(x + i * p * 2, Math.round(by / p) * p, p * 2, p);
      if (i % 3 === 0) ctx.fillRect(x + i * p * 2, Math.round(by / p) * p, p, p * 5);
    }
    ctx.fillStyle = "#71606d"; ctx.fillRect(x - p * 33, y + p * 5, p * 66, p * 2);
    const m = art.moon, radius = p * 6;
    glow(ctx, m.x, m.y, p * 10, 0.08, "243,223,176");
    ctx.fillStyle = "#f3dfb0"; ctx.globalAlpha = 0.9;
    for (let dy = -radius; dy <= radius; dy += p) for (let dx = -radius; dx <= radius; dx += p) {
      if (dx * dx + dy * dy <= radius * radius && (dx - radius * 0.52) ** 2 + (dy + radius * 0.18) ** 2 >= radius ** 2 * 0.88)
        ctx.fillRect(m.x + dx, m.y + dy, p, p);
    } ctx.globalAlpha = 1;
  }
}

export function paintSceneryLife(ctx: CanvasRenderingContext2D, scene: HanabiScene, time: number) {
  const art = scene.scenery;
  if (!art) return;
  const { width: w, height: h, pixel: p } = scene;
  const { sidebar, work } = sceneryPlacement(w, h, scene.layout, p);
  for (const wave of art.water) {
    if (art.id === "onsen-autumn" && Math.abs((wave.x - sidebar) / work - (0.46 + (wave.y / h - 0.73) / 0.27 * 0.1)) > 0.045) continue;
    ctx.globalAlpha = 0.42 + 0.06 * Math.sin(time / 1700 + wave.phase);
    ctx.fillStyle = Math.sin(wave.phase) > 0.5 ? "#d5ae86" : "#6e91a6";
    ctx.fillRect(wave.x, wave.y, wave.width, p);
  }
  if (art.id === "harbor-night") {
    const hero = art.heroes.find(hero => hero.kind === "lighthouse")!;
    const x = hero.x, y = hero.y - hero.height + p * 3, reach = work * 0.36;
    const sweep = Math.sin(time / 9000) * h * 0.025;
    const beam = ctx.createLinearGradient(x, y, x - reach, y + sweep);
    beam.addColorStop(0, "rgba(255,224,168,0.18)"); beam.addColorStop(1, "rgba(255,224,168,0)");
    ctx.fillStyle = beam; ctx.globalAlpha = 1; ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x - reach, y + sweep - h * 0.065); ctx.lineTo(x - reach, y + sweep + h * 0.065); ctx.closePath(); ctx.fill();
    for (const b of [...art.buildings, ...art.midgroundBuildings].filter((b, i) => i % 3 === 0 && sceneryHasWater(art, b.x + b.width / 2, art.horizon + p * 3))) {
      for (let n = 0; n < 7; n++) {
        ctx.fillStyle = "#efbe83"; ctx.globalAlpha = (0.4 - n * 0.035) * (0.85 + 0.15 * Math.sin(time / 1700 + n));
        ctx.fillRect(b.x + b.width / 2 + Math.sin(time / 1900 + n) * p, art.horizon + p * (3 + n * 3), p, p * 2);
      }
    }
  }
  if (art.id === "onsen-autumn") for (const b of art.buildings) for (let puff = 0; puff < 4; puff++) {
    const phase = (time / 10000 + puff / 4) % 1;
    ctx.globalAlpha = 0.25 + (1 - phase) * 0.1; ctx.fillStyle = "#c4b8c4";
    const x = b.x + b.width * 0.6 + Math.sin(phase * 6 + puff) * p * 3, y = b.y - b.height - p * 7 - phase * h * 0.09;
    for (let step = 0; step < 7; step++) ctx.fillRect(Math.round((x + Math.sin(step * 0.8 + phase * 3) * p * 2) / p) * p,
      Math.round((y - step * p * 2) / p) * p, p * 2, p * 2);
  }
  if (art.id === "sakura-night") for (const petal of scene.snow) {
    const seconds = time / 1000;
    const x = (petal.x + seconds * (4 + petal.layer) + Math.sin(seconds * 0.2 + petal.phase) * 12) % w;
    const y = (petal.y + seconds * petal.speed * 0.6) % h;
    ctx.fillStyle = "#f4bad0"; ctx.globalAlpha = 0.6 + petal.layer * 0.12;
    const px = Math.round(x), py = Math.round(y);
    if (petal.layer % 2) ctx.fillRect(px, py, 2, 2);
    else { ctx.fillRect(px + 1, py, 1, 1); ctx.fillRect(px + 1, py + 1, 1, 1); ctx.fillRect(px, py + 2, 1, 1); }
  }
  ctx.globalAlpha = 1;
}

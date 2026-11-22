import { nightBranchExtent, nightEmissionColor, nightRaySections, nightFireworkFrame, nightFireworkLight, nightMeteor, nightSkyColor, nightSnowAsterisk, nightTreeBranches, nightParticle, seededRandom, snowPosition, starOpacity, type NightFirework, type NightTree, type WinterNightScene } from "./hanabiScene";
import { paintSceneryStill, paintSceneryLife, scenerySkyColor, clipSceneryWater, sceneryHasWater, type HanabiScene } from "./hanabiScenery";

function drawTree(ctx: CanvasRenderingContext2D, tree: NightTree, p: number) {
  const { x, width, layer } = tree;
  const far = layer === "far", branches = nightTreeBranches(tree, p);
  const rows = new Map<number, { half: number; shadow: boolean }>();
  for (const [tier, branch] of branches.entries()) {
    for (let row = branch.top; row < branch.bottom; row += p) {
      rows.set(row, { half: nightBranchExtent(branch, row, p, tier === 0), shadow: row >= branch.shadowTop });
    }
  }
  const base = far ? "#3d3a78" : tree.shade > 0.5 ? "#173a4a" : "#12303f";
  ctx.globalAlpha = far ? 0.55 : 1;
  for (const [row, { half, shadow }] of rows) {
    ctx.fillStyle = shadow && !far ? "#10283a" : base;
    ctx.fillRect(x - half, row, half * 2 + p, p);
  }
  const random = seededRandom(Math.round(x * 71 + tree.height * 19 + tree.shade * 10000));
  // Tall isolated glyphs on an integer micro-grid; cell size follows the art grid.
  const glyphP = far ? Math.max(1, Math.round(p * 2 / 3)) : p;
  const pitchX = glyphP * 5, pitchY = glyphP * 7, lineHeight = glyphP * 6;
  const stroke = glyphP;
  for (const [tier, branch] of branches.entries()) {
    let rowIndex = 0;
    for (let row = branch.top + (tier === 0 ? p * 2 : p); row + lineHeight <= branch.shadowTop; row += pitchY, rowIndex += 1) {
      for (let col = -Math.ceil(width / (2 * pitchX)); col <= Math.ceil(width / (2 * pitchX)); col += 1) {
        const left = x + col * pitchX + (rowIndex % 2) * glyphP * 2;
        const flip = random() < 0.2;
        const slash = (left + glyphP * 2 < x) !== flip;
        // A one-pixel raster staircase makes a single long /, not four square beads.
        const points = Array.from({ length: lineHeight }, (_, step) => ({
          x: left + Math.round((slash ? lineHeight - 1 - step : step) / (lineHeight - 1) * glyphP * 3),
          y: row + step,
        }));
        if (points.some(point => {
          const shape = rows.get(Math.floor(point.y / p) * p);
          return !shape || shape.shadow || Math.abs(point.x + stroke / 2 - x) > shape.half - p;
        })) continue;
        if (random() < 0.08) {
          ctx.fillStyle = far ? "#575294" : "#2d5f6a";
          ctx.globalAlpha = far ? 0.12 : 0.25;
          ctx.fillRect(left, row, glyphP * 4, lineHeight);
        }
        ctx.fillStyle = far ? "#7d79c4" : "#6fd6b8";
        ctx.globalAlpha = far ? 0.28 : 0.82;
        for (const point of points) ctx.fillRect(point.x, point.y, stroke, 1);
      }
    }
  }
  ctx.globalAlpha = far ? 0.55 : 1;
  ctx.fillStyle = far ? "#7d79c4" : "#9fd8cf";
  const top = branches[0].top;
  ctx.fillRect(x, top, p, p);
  ctx.fillRect(x - p, top + p, p, p); ctx.fillRect(x + p, top + p, p, p);
  branches.forEach((branch, index) => {
    if (index % 2) return;
    const row = branch.shadowTop - p;
    const half = nightBranchExtent(branch, row, p, index === 0);
    ctx.fillRect(x - half, row, p * 2, p);
    ctx.fillRect(x + half - p, row, p * 2, p);
  });
  ctx.globalAlpha = 1;
}

function drawVillage(ctx: CanvasRenderingContext2D, scene: WinterNightScene) {
  const p = scene.pixel, u = p / 3, snap = (n: number) => Math.round(n / p) * p;
  const random = seededRandom(scene.seed + 983);
  for (let i = 0; i < 9; i += 1) {
    const x = snap(scene.width * (0.72 + i * 0.025)), y = snap(scene.height - (132 + random() * 18) * u);
    const w = snap((16 + random() * 12) * u), h = snap((12 + random() * 10) * u);
    ctx.globalAlpha = 0.35; ctx.fillStyle = "#3a3570";
    ctx.fillRect(x, y - h, w, h);
    // Outline-only caret roofs remain legible above the distant purple trees.
    ctx.globalAlpha = 0.5; ctx.fillStyle = "#7d79c4";
    for (let row = 0; row <= h * 0.7; row += p) {
      const extent = snap(row / (h * 0.7) * w * 0.6);
      ctx.fillRect(snap(x + w / 2 - extent), snap(y - h * 1.7 + row), p, p);
      ctx.fillRect(snap(x + w / 2 + extent), snap(y - h * 1.7 + row), p, p);
    }
    ctx.fillStyle = "#f3bf89";
    ctx.fillRect(x + p * 2, y - p * 2, p, p);
  }
  ctx.globalAlpha = 1;
}

function drawHouse(ctx: CanvasRenderingContext2D, scene: WinterNightScene) {
  const { x, y, width: w, height: h } = scene.house;
  const p = scene.pixel, snap = (n: number) => Math.round(n / p) * p;
  ctx.globalAlpha = 0.5; ctx.fillStyle = "#b0bacd";
  ctx.fillRect(snap(x - w * 0.3), y, snap(w * 1.6), p * 2);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#252943"; ctx.fillRect(x, y - h, w, h);
  ctx.fillStyle = "#4c5079";
  ctx.fillRect(snap(x + w * 0.82), snap(y - h * 1.85), p * 2, snap(h * 0.9));
  for (let row = 0; row < h * 0.75; row += p) {
    const extent = snap(row / (h * 0.75) * w * 0.62);
    ctx.fillStyle = "#3d4163";
    ctx.fillRect(snap(x + w / 2 - extent), snap(y - h * 1.75 + row), extent * 2 + p, p);
    ctx.fillStyle = "#a6b7cb";
    ctx.fillRect(snap(x + w / 2 - extent), snap(y - h * 1.75 + row), p, p);
    ctx.fillRect(snap(x + w / 2 + extent), snap(y - h * 1.75 + row), p, p);
  }
  // Sparse log joints and diagonal roof stitches share the forest's symbol scale.
  ctx.fillStyle = "#69718b";
  for (let row = y - h + p * 2; row < y; row += p * 3) {
    ctx.fillRect(x + p, row, p * 2, p);
    ctx.fillRect(x + w - p * 3, row, p * 2, p);
  }
  ctx.fillStyle = "#b0bacd"; ctx.fillRect(snap(x - w * 0.1), y - h, snap(w * 1.2), p);
  ctx.fillStyle = "#13152e"; ctx.fillRect(snap(x + w * 0.44), snap(y - h * 0.6), p * 3, snap(h * 0.6));
}

/** Render only on resize. Ordered dithering + seeded grain prevents sky bands. */
export function paintNightStill(ctx: CanvasRenderingContext2D, scene: HanabiScene) {
  const image = ctx.createImageData(scene.width, scene.height);
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = 0; y < scene.height; y += 1) {
    const t = y / Math.max(1, scene.height - 1);
    const sky = scene.scenery ? scenerySkyColor(scene.scenery.id, t) : nightSkyColor(t);
    const mist = Math.exp(-Math.pow((t - 0.86) / 0.15, 2)) * 0.025;
    for (let x = 0; x < scene.width; x += 1) {
      const index = (y * scene.width + x) * 4;
      const grain = ((Math.imul(x + scene.seed, 374761393) ^ Math.imul(y, 668265263)) >>> 24) / 255 - 0.5;
      const noise = (bayer[(y % 4) * 4 + x % 4] / 16 - 0.5) * 1.25 + grain * 0.65;
      image.data[index] = Math.round(sky[0] * (1 - mist) + 74 * mist + noise);
      image.data[index + 1] = Math.round(sky[1] * (1 - mist) + 61 * mist + noise);
      image.data[index + 2] = Math.round(sky[2] * (1 - mist) + 140 * mist + noise);
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  if (scene.scenery) { paintSceneryStill(ctx, scene); return; }
  const radius = scene.width * 0.28;
  for (const x of [scene.width * 0.12, scene.width * 0.9]) {
    const glow = ctx.createRadialGradient(x, scene.height * 0.8, 0, x, scene.height * 0.8, radius);
    glow.addColorStop(0, "rgba(90,74,160,0.32)"); glow.addColorStop(1, "rgba(90,74,160,0)");
    ctx.fillStyle = glow; ctx.fillRect(x - radius, scene.height * 0.8 - radius, radius * 2, radius * 2);
  }
  for (const tree of scene.trees.filter(tree => tree.layer === "far")) drawTree(ctx, tree, scene.pixel);
  drawVillage(ctx, scene);
  for (const tree of scene.trees.filter(tree => tree.layer === "near")) drawTree(ctx, tree, scene.pixel);
  drawHouse(ctx, scene);
}

function paintHouseLife(ctx: CanvasRenderingContext2D, scene: WinterNightScene, time: number) {
  const { x, y, width: w, height: h } = scene.house;
  const p = scene.pixel, snap = (n: number) => Math.round(n / p) * p;
  ctx.globalAlpha = 0.84 + 0.06 * Math.sin(time / 2600) + 0.04 * Math.sin(time / 1700 + 1);
  ctx.fillStyle = "#f3bf89";
  for (const offset of [0.17, 0.7]) ctx.fillRect(snap(x + w * offset), snap(y - h * 0.72), p * 2, p * 2);
  ctx.globalAlpha = 0.055; ctx.fillStyle = "#dfc2a1";
  ctx.fillRect(snap(x + w * 0.12), snap(y - h * 0.8), snap(w * 0.83), snap(h * 0.7));
  for (let puff = 0; puff < 5; puff += 1) {
    const phase = ((time / 6000 + puff / 5) % 1 + 1) % 1;
    ctx.globalAlpha = (1 - phase) * 0.065; ctx.fillStyle = "#b9b0ce";
    const size = snap(p * (1 + phase * 2));
    ctx.fillRect(snap(x + w * 0.85 + Math.sin(phase * 3 + puff) * p + phase * p * 4),
      snap(y - h * 1.85 - phase * p * 11), size, size);
  }
  ctx.globalAlpha = 1;
}

function paintFirework(ctx: CanvasRenderingContext2D, scene: HanabiScene, firework: NightFirework, time: number, backdrop?: { color: string; opacity: number }, maskReading = true) {
  const launch = (time - firework.startedAt) / firework.launchMs;
  if (launch < 0) return;
  // Every emitted pixel is light. Alpha alone removes it, never an opaque grey.
  ctx.globalCompositeOperation = "lighter";
  const sky = scene.scenery ? scenerySkyColor(scene.scenery.id, firework.y / scene.height) : nightSkyColor(firework.y / scene.height);
  const emissionColor = (color: string, halo = 0) => {
    if (!scene.scenery && !backdrop) return nightEmissionColor(color, firework.y / scene.height, halo);
    const channels = sky.map((channel, index) => {
      const ground = backdrop ? channel * (1 - backdrop.opacity) + parseInt(backdrop.color.slice(1 + index * 2, 3 + index * 2), 16) * backdrop.opacity : channel;
      return Math.max(0, Math.round(parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) - ground - [240,138,108][index] * halo));
    });
    return `rgb(${channels.join(",")})`;
  };
  const emission = emissionColor(firework.color);
  const coreEmission = emissionColor(firework.core, 0.22);
  if (launch < 1) {
    for (let tail = 10; tail >= 0; tail -= 1) {
      const t = Math.max(0, launch - tail * 0.02);
      const x = firework.x - 35 * (1 - t) + Math.sin(t * 5) * 2;
      const y = scene.height + 10 - (scene.height + 10 - firework.y) * (1 - Math.pow(1 - t, 2));
      ctx.globalAlpha = (1 - tail / 11) * 0.65;
      ctx.fillStyle = tail === 0 ? coreEmission : emission;
      ctx.fillRect(x, y, tail === 0 ? 2 : 1, 3 + tail);
    }
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; return;
  }
  const frame = nightFireworkFrame(firework, time);
  if (!frame) { ctx.globalCompositeOperation = "source-over"; return; }
  const light = nightFireworkLight(firework, frame.progress);
  if (frame.flash > 0) {
    const radius = firework.radius * 2.4;
    const glow = ctx.createRadialGradient(firework.x, firework.y, 0, firework.x, firework.y, radius);
    glow.addColorStop(0, firework.color); glow.addColorStop(1, "transparent");
    ctx.globalAlpha = frame.flash; ctx.fillStyle = glow;
    ctx.fillRect(firework.x - radius, firework.y - radius, radius * 2, radius * 2);
    ctx.strokeStyle = emission; ctx.lineWidth = scene.pixel;
    for (const tree of scene.trees) {
      if (tree.layer !== "near" || Math.hypot(tree.x - firework.x, tree.y - tree.height * 0.6 - firework.y) > radius * 1.5) continue;
      const facing = tree.x > firework.x ? -1 : 1;
      ctx.beginPath(); ctx.moveTo(tree.x, tree.y - tree.height);
      ctx.lineTo(tree.x + facing * tree.width * 0.4, tree.y - tree.height * 0.3); ctx.stroke();
    }
  }
  if (light.glowAlpha > 0) {
    const radius = firework.radius * 0.4;
    const glow = ctx.createRadialGradient(firework.x, firework.y, 0, firework.x, firework.y, radius);
    glow.addColorStop(0, "rgba(240,138,108,0.22)"); glow.addColorStop(1, "rgba(240,138,108,0)");
    ctx.globalAlpha = light.glowAlpha; ctx.fillStyle = glow;
    ctx.fillRect(firework.x - radius, firework.y - radius, radius * 2, radius * 2);
  }
  const reading = maskReading ? scene.layout.conversationRect : undefined;
  const pointOpacity = (x: number, y: number) => reading && x >= reading.left && x < reading.right && y >= reading.top && y < reading.bottom ? 0.5 : 1;
  const strokeRay = (ax: number, ay: number, bx: number, by: number, alpha: number) => {
    for (const part of nightRaySections(ax, ay, bx, by, reading)) {
      ctx.globalAlpha = alpha * part.alpha;
      ctx.beginPath(); ctx.moveTo(part.from === 0 ? ax : ax + (bx - ax) * part.from, part.from === 0 ? ay : ay + (by - ay) * part.from);
      ctx.lineTo(part.to === 1 ? bx : ax + (bx - ax) * part.to, part.to === 1 ? by : ay + (by - ay) * part.to); ctx.stroke();
    }
  };
  ctx.strokeStyle = emission; ctx.lineWidth = firework.final ? 3 : 2.5;
  if (firework.style === "chrysanthemum" && !light.sparksOnly) {
    for (const ray of firework.rays) {
      const point = nightParticle(firework, ray, frame.progress);
      const dx = point.x - firework.x, dy = point.y - firework.y;
      const fraction = light.outerOnly ? 0.75 : Math.min(0.75, 0.22 / Math.max(0.22, ray.length * frame.expansion));
      // The terminal 15 percent is a separate, half-alpha glowing filament.
      for (const [from, to, alpha] of [[fraction, 0.85, 1], [0.85, 1, 0.5]]) {
        if (from >= to) continue;
        strokeRay(firework.x + dx * from, firework.y + dy * from,
          firework.x + dx * to, firework.y + dy * to, light.alpha * alpha);
      }
    }
  } else if (firework.style === "willow" && !light.sparksOnly) {
    const trail = 0.3;
    for (let segment = 3; segment >= 0; segment -= 1) {
      const p1 = Math.max(0, frame.progress - trail * segment / 4);
      const p0 = Math.max(0, p1 - trail / 4);
      ctx.globalAlpha = light.alpha * (1 - segment / 4); ctx.beginPath();
      for (const ray of firework.rays) {
        const a = nightParticle(firework, ray, p0), b = nightParticle(firework, ray, p1);
        if (reading) strokeRay(a.x, a.y, b.x, b.y, light.alpha * (1 - segment / 4));
        else { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      }
      if (!reading) ctx.stroke();
    }
  }
  ctx.fillStyle = firework.style === "ring" ? emission : emissionColor(firework.core);
  for (const ray of firework.rays) {
    const point = nightParticle(firework, ray, frame.progress);
    const crackle = frame.progress > 0.65 ? Math.max(0, Math.sin(time / 31 + ray.phase * 15)) : 1;
    if (firework.style === "ring") {
      const previous = nightParticle(firework, ray, Math.max(0, frame.progress - 0.045));
      ctx.globalAlpha = pointOpacity(previous.x, previous.y) * light.alpha * 0.3;
      ctx.fillRect(Math.round(previous.x), Math.round(previous.y), 1, 1);
    }
    ctx.globalAlpha = pointOpacity(point.x, point.y) * light.alpha * crackle;
    const size = firework.style === "ring" ? 3 : 1.5;
    ctx.fillRect(Math.round(point.x), Math.round(point.y), size, size);
  }
  if (light.coreAlpha > 0) {
    ctx.globalAlpha = light.coreAlpha; ctx.fillStyle = coreEmission;
    ctx.beginPath(); ctx.arc(firework.x, firework.y, firework.radius * 0.12, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
}

export function paintWinterNight(
  ctx: CanvasRenderingContext2D, scene: HanabiScene, timeMs: number,
  still: HTMLCanvasElement, fireworks: readonly NightFirework[], reducedMotion: boolean,
) {
  ctx.imageSmoothingEnabled = false; ctx.drawImage(still, 0, 0, scene.width, scene.height);
  const time = reducedMotion ? 0 : timeMs;
  for (const star of scene.stars) {
    ctx.globalAlpha = starOpacity(star, time); ctx.fillStyle = "#ecebf5";
    if (star.cross) {
      ctx.fillRect(star.x - 3, star.y - 1, 8, 2);
      ctx.fillRect(star.x, star.y - 4, 2, 8);
      if (star.phase > 4) {
        ctx.fillRect(star.x - 2, star.y - 3, 2, 2); ctx.fillRect(star.x + 3, star.y + 2, 2, 2);
        ctx.fillRect(star.x - 2, star.y + 2, 2, 2); ctx.fillRect(star.x + 3, star.y - 3, 2, 2);
      }
    } else ctx.fillRect(star.x, star.y, star.size, star.size);
  }
  ctx.globalAlpha = 1;
  if (scene.scenery) paintSceneryLife(ctx, scene, time);
  else paintHouseLife(ctx, scene, time);
  if (reducedMotion) return;
  const meteor = nightMeteor(scene, time);
  if (meteor) {
    ctx.globalAlpha = meteor.alpha; ctx.strokeStyle = "#cbc7e6"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(meteor.x - 38, meteor.y - 19); ctx.lineTo(meteor.x, meteor.y); ctx.stroke(); ctx.globalAlpha = 1;
  }
  for (const flake of scene.scenery ? [] : scene.snow) {
    const point = snowPosition(flake, scene, time);
    ctx.globalAlpha = [0.16, 0.3, 0.45][flake.layer]; ctx.fillStyle = "#d5d5ec";
    if (flake.layer === 2) {
      for (const pixel of nightSnowAsterisk(point.x, point.y)) ctx.fillRect(pixel.x, pixel.y, pixel.width, pixel.height);
    } else ctx.fillRect(Math.round(point.x), Math.round(point.y), Math.round(flake.size), Math.round(flake.size));
  }
  ctx.globalAlpha = 1;
  paintNightFireworks(ctx, scene, time, fireworks);
}

/** Light is composited after the surface tint, before terminal text. */
export function paintNightFireworks(ctx: CanvasRenderingContext2D, scene: HanabiScene, time: number,
  fireworks: readonly NightFirework[], backdrop?: { color: string; opacity: number }) {
  // A terminal surface is reading area from edge to edge, so the reading mask would halve every
  // burst drawn over it (seen in the real app). The terminal pass therefore paints at full light.
  for (const firework of fireworks) paintFirework(ctx, scene, firework, time, backdrop, !backdrop);
  if (scene.scenery?.id === "summer-seaside" && fireworks.length) {
    const horizon = scene.scenery.horizon;
    ctx.save(); clipSceneryWater(ctx, scene.scenery);
    ctx.translate(0, horizon * 1.35); ctx.scale(1, -0.35);
    // Individual reflected rays retain their hue without mirroring the opaque sky.
    ctx.filter = "opacity(35%)";
    for (const firework of fireworks) paintFirework(ctx, scene, firework, time, backdrop, false);
    ctx.restore();
    // Broken vertical ribbons lie directly below each burst, not below its launch point.
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (const firework of fireworks) {
      const frame = nightFireworkFrame(firework, time);
      if (!frame) continue;
      ctx.fillStyle = firework.color; ctx.globalAlpha = frame.alpha * 0.25;
      const end = Math.min(scene.height, horizon + (horizon - firework.y) * 0.35 + firework.radius * 0.35);
      for (let y = horizon + scene.pixel; y < end; y += scene.pixel * 3) {
        const x = firework.x + Math.sin(y / 19 + time / 700) * scene.pixel * 2;
        if (sceneryHasWater(scene.scenery, x, y) && sceneryHasWater(scene.scenery, x + scene.pixel * 2, y))
          ctx.fillRect(Math.round(x / scene.pixel) * scene.pixel, y, scene.pixel * 2, scene.pixel);
      }
    }
    ctx.restore();
  }
}

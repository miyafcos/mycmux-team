import { Resvg } from "@resvg/resvg-js";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const COLORS = {
  ink: "#2c2218",
  blush: "#ff9aa8",
  spark: "#ffd45e",
  sweat: "#7bc1ff",
};
const MOODS = [
  "idle",
  "listening",
  "thinking",
  "tsukkomi",
  "applaud",
  "curious",
  "amused",
  "alert",
  "sleepy",
];

const LEX = 37;
const REX = 63;
const EY = 48;

function eyes(mood) {
  const INK = COLORS.ink;
  if (mood === "applaud") {
    return `<g stroke="${INK}" stroke-width="2.6" stroke-linecap="round" fill="none">
      <path d="M ${LEX - 5} ${EY + 2} Q ${LEX} ${EY - 5} ${LEX + 5} ${EY + 2}" />
      <path d="M ${REX - 5} ${EY + 2} Q ${REX} ${EY - 5} ${REX + 5} ${EY + 2}" />
    </g>`;
  }
  if (mood === "tsukkomi") {
    return `<g>
      <path d="M ${LEX - 6} ${EY - 1} L ${LEX + 6} ${EY + 2}" stroke="${INK}" stroke-width="2.8" stroke-linecap="round" />
      <ellipse cx="${REX}" cy="${EY}" rx="3" ry="3.8" fill="${INK}" />
    </g>`;
  }
  if (mood === "listening") {
    return `<g fill="${INK}">
      <ellipse cx="${LEX + 1.5}" cy="${EY}" rx="2.8" ry="3.4" />
      <ellipse cx="${REX + 1.5}" cy="${EY}" rx="2.8" ry="3.4" />
      <circle cx="${LEX + 2.5}" cy="${EY - 0.8}" r="0.9" fill="#fff8ef" />
      <circle cx="${REX + 2.5}" cy="${EY - 0.8}" r="0.9" fill="#fff8ef" />
    </g>`;
  }
  if (mood === "thinking") {
    return `<g fill="${INK}">
      <ellipse cx="${LEX}" cy="${EY}" rx="2.2" ry="2.6" />
      <ellipse cx="${REX}" cy="${EY}" rx="2.2" ry="2.6" />
    </g>`;
  }
  if (mood === "curious") {
    return `<g>
      <ellipse cx="${LEX}" cy="${EY}" rx="3.4" ry="4.0" fill="${INK}" />
      <ellipse cx="${REX}" cy="${EY - 1.2}" rx="3.4" ry="4.2" fill="${INK}" />
      <circle cx="${LEX + 1.1}" cy="${EY - 1.6}" r="1.1" fill="#fff8ef" />
      <circle cx="${REX + 1.1}" cy="${EY - 2.8}" r="1.1" fill="#fff8ef" />
    </g>`;
  }
  if (mood === "amused") {
    return `<g stroke="${INK}" stroke-width="2.6" stroke-linecap="round" fill="none">
      <path d="M ${LEX - 5} ${EY} Q ${LEX} ${EY + 4} ${LEX + 5} ${EY}" />
      <path d="M ${REX - 5} ${EY} Q ${REX} ${EY + 4} ${REX + 5} ${EY}" />
    </g>`;
  }
  if (mood === "alert") {
    return `<g>
      <ellipse cx="${LEX}" cy="${EY}" rx="4" ry="4.6" fill="#fff8ef" stroke="${INK}" stroke-width="1.2" />
      <ellipse cx="${REX}" cy="${EY}" rx="4" ry="4.6" fill="#fff8ef" stroke="${INK}" stroke-width="1.2" />
      <circle cx="${LEX}" cy="${EY}" r="1.8" fill="${INK}" />
      <circle cx="${REX}" cy="${EY}" r="1.8" fill="${INK}" />
    </g>`;
  }
  if (mood === "sleepy") {
    return `<g fill="${INK}" transform="translate(0 0.6) scale(1 0.42)" transform-origin="50 ${EY}">
      <ellipse cx="${LEX}" cy="${EY}" rx="3.2" ry="3.6" />
      <ellipse cx="${REX}" cy="${EY}" rx="3.2" ry="3.6" />
    </g>`;
  }
  return `<g>
    <ellipse cx="${LEX}" cy="${EY}" rx="3" ry="3.8" fill="${INK}" />
    <ellipse cx="${REX}" cy="${EY}" rx="3" ry="3.8" fill="${INK}" />
    <circle cx="${LEX + 1}" cy="${EY - 1.4}" r="1" fill="#fff8ef" />
    <circle cx="${REX + 1}" cy="${EY - 1.4}" r="1" fill="#fff8ef" />
  </g>`;
}

function mouth(mood) {
  const stroke = COLORS.ink;
  const sw = 2.3;
  if (mood === "applaud") {
    return `<g>
      <path d="M 39 63 Q 50 78 61 63 Z" stroke="${stroke}" stroke-width="${sw}" fill="${stroke}" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M 41 64 L 59 64" stroke="#fff8ef" stroke-width="1.6" stroke-linecap="round" />
    </g>`;
  }
  if (mood === "tsukkomi") {
    return `<path d="M 41 70 Q 50 62 59 70" stroke="${stroke}" stroke-width="${sw + 0.2}" fill="none" stroke-linecap="round" />`;
  }
  if (mood === "listening") {
    return `<ellipse cx="50" cy="67" rx="3.5" ry="2.5" stroke="${stroke}" stroke-width="${sw}" fill="none" />`;
  }
  if (mood === "thinking") {
    return `<path d="M 43 67 Q 48 70 53 66 T 58 68" stroke="${stroke}" stroke-width="${sw}" fill="none" stroke-linecap="round" />`;
  }
  if (mood === "curious") {
    return `<ellipse cx="50" cy="68" rx="2.2" ry="2.8" stroke="${stroke}" stroke-width="${sw}" fill="none" />`;
  }
  if (mood === "amused") {
    return `<path d="M 40 63 Q 50 72 60 63" stroke="${stroke}" stroke-width="${sw + 0.2}" fill="none" stroke-linecap="round" />`;
  }
  if (mood === "alert") {
    return `<path d="M 42 68 Q 46 64 50 68 Q 54 64 58 68" stroke="${stroke}" stroke-width="${sw}" fill="none" stroke-linecap="round" />`;
  }
  if (mood === "sleepy") {
    return `<path d="M 45 68 Q 50 69 55 68" stroke="${stroke}" stroke-width="${sw - 0.4}" fill="none" stroke-linecap="round" />`;
  }
  return `<path d="M 43 64 Q 50 70 57 64" stroke="${stroke}" stroke-width="${sw}" fill="none" stroke-linecap="round" />`;
}

function accessory(mood) {
  const ink = COLORS.ink;
  if (mood === "listening") {
    return `<g opacity="0.55">
      <path d="M 82 40 Q 86 44 82 48" stroke="${ink}" stroke-width="1.2" fill="none" stroke-linecap="round" />
      <path d="M 86 38 Q 92 44 86 50" stroke="${ink}" stroke-width="1.2" fill="none" stroke-linecap="round" />
    </g>`;
  }
  if (mood === "thinking") {
    return `<g>
      <circle cx="78" cy="24" r="2.6" fill="${ink}" />
      <circle cx="85" cy="18" r="1.8" fill="${ink}" />
      <circle cx="91" cy="13" r="1.2" fill="${ink}" />
    </g>`;
  }
  if (mood === "tsukkomi") {
    return `<path d="M 82 28 Q 85 34 82 38 Q 79 34 82 28 Z" fill="${COLORS.sweat}" stroke="${ink}" stroke-width="0.8" stroke-linejoin="round" />`;
  }
  if (mood === "applaud") {
    return `<g>
      <ellipse cx="${LEX - 6}" cy="${EY + 12}" rx="5" ry="2.6" fill="${COLORS.blush}" opacity="0.75" />
      <ellipse cx="${REX + 6}" cy="${EY + 12}" rx="5" ry="2.6" fill="${COLORS.blush}" opacity="0.75" />
      <path d="M 16 26 L 20 22 L 20 30 Z" fill="${COLORS.spark}" transform="rotate(-18 18 26)" />
      <path d="M 80 26 L 84 22 L 84 30 Z" fill="${COLORS.spark}" transform="rotate(18 82 26)" />
    </g>`;
  }
  if (mood === "curious") {
    return `<text x="82" y="26" font-size="14" font-weight="700" fill="${ink}" font-family="system-ui, sans-serif">?</text>`;
  }
  if (mood === "amused") {
    return `<g>
      <ellipse cx="${LEX - 6}" cy="${EY + 13}" rx="4" ry="2.2" fill="${COLORS.blush}" opacity="0.55" />
      <ellipse cx="${REX + 6}" cy="${EY + 13}" rx="4" ry="2.2" fill="${COLORS.blush}" opacity="0.55" />
    </g>`;
  }
  if (mood === "alert") {
    return `<g>
      <rect x="80" y="14" width="4" height="10" rx="1.5" fill="#e85149" />
      <circle cx="82" cy="28" r="2" fill="#e85149" />
    </g>`;
  }
  if (mood === "sleepy") {
    return `<g>
      <text x="76" y="22" font-size="9" font-weight="700" fill="${ink}" font-family="system-ui, sans-serif" opacity="0.7">z</text>
      <text x="82" y="16" font-size="11" font-weight="700" fill="${ink}" font-family="system-ui, sans-serif" opacity="0.85">z</text>
      <text x="88" y="10" font-size="13" font-weight="700" fill="${ink}" font-family="system-ui, sans-serif">z</text>
    </g>`;
  }
  return "";
}

function buildSvg(mood) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1024" height="1024">${eyes(mood)}${mouth(mood)}${accessory(mood)}</svg>`;
}

async function main() {
  const outDir = join(homedir(), ".claude-buddy", "sprites-export");
  await mkdir(outDir, { recursive: true });
  for (const mood of MOODS) {
    const svg = buildSvg(mood);
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } });
    const png = resvg.render().asPng();
    const file = join(outDir, `${mood}.png`);
    await writeFile(file, png);
    console.log(`exported: ${file}`);
  }
  console.log(`\nDone. ${MOODS.length} sprites in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

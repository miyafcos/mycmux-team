// Real Chromium raster measurement; jsdom without canvas cannot measure ink.
// Usage: node tests/measure_artifact_icon_ink.cjs OUTPUT_DIR [CHROME_EXE] [BASELINE_JSON]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { buildSync } = require("esbuild");

const root = path.resolve(__dirname, "..");
if (!process.argv[2]) throw new Error("An output directory is required");
const output = path.resolve(process.argv[2]);
const chrome = process.argv[3] || "C:/Program Files/Google/Chrome/Application/chrome.exe";
fs.mkdirSync(output, { recursive: true });
const bundlePath = path.join(output, "render-icons.cjs");
buildSync({
  stdin: {
    contents: `
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { AgentKindIcon } from './src/components/icons/AgentIcons';
      const kinds = ['html', 'word', 'excel', 'pdf', 'office', 'powerpoint', 'markdown'];
      console.log(JSON.stringify(Object.fromEntries(kinds.map(kind => [kind,
        renderToStaticMarkup(createElement(AgentKindIcon, {kind, size: 12, chip: false}))
      ]))));
    `,
    resolveDir: root,
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  charset: "ascii",
  loader: { ".webp": "dataurl" },
  outfile: bundlePath,
});
const icons = JSON.parse(execFileSync(process.execPath, [bundlePath], { encoding: "utf8", windowsHide: true }));
fs.writeFileSync(path.join(output, "icons.json"), JSON.stringify(icons, null, 2) + "\n", "utf8");
const html = `<!doctype html><meta charset="utf-8"><title>Artifact ink measurement</title>
<style>body{margin:0;background:#222;color:#ddd;font:14px sans-serif}svg{display:block;width:12px;height:12px}</style>
${Object.entries(icons).map(([kind, svg], index) => `<div style="position:absolute;left:8px;top:${16 + index * 32}px">${kind}</div><div data-kind="${kind}" style="position:absolute;left:120px;top:${16 + index * 32}px">${svg}</div>`).join("")}
<pre id="results" style="display:none"></pre><script>
const marks = [...document.querySelectorAll('[data-kind]')].map(element => {
  const bounds = element.querySelector('svg').getBoundingClientRect();
  return {kind: element.dataset.kind, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height};
});
document.getElementById('results').textContent = JSON.stringify({
  userAgent: navigator.userAgent, devicePixelRatio, inkThreshold: 140, fullThreshold: 230, marks
});
</script>`;
const htmlPath = path.join(output, "measurement.html");
fs.writeFileSync(htmlPath, html, "utf8");
const dom = execFileSync(chrome, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--force-device-scale-factor=1", `--user-data-dir=${path.join(output, "chrome-profile")}`,
  "--virtual-time-budget=3000", "--window-size=640,480", "--hide-scrollbars",
  `--screenshot=${path.join(output, "screenshot.png")}`, "--dump-dom", pathToFileURL(htmlPath).href,
], { encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const encoded = dom.match(/<pre id="results"[^>]*>([\s\S]*?)<\/pre>/)?.[1];
if (!encoded || encoded === "pending") throw new Error("Chromium did not finish the measurement");
const result = JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (result.error) throw new Error(result.error);
// Pillow is used only to inspect the browser screenshot, never to render SVG.
const measured = JSON.parse(execFileSync("python", ["-c", `
import json, sys
from pathlib import Path
from PIL import Image
output = Path(sys.argv[1])
result = json.load(sys.stdin)
image = Image.open(output / "screenshot.png").convert("RGB")
for mark in result["marks"]:
    x, y, width, height = (mark[k] for k in ["x", "y", "width", "height"])
    assert width == height == 12 and int(x) == x and int(y) == y
    crop = image.crop((int(x), int(y), int(x + width), int(y + height)))
    crop.save(output / (mark["kind"] + "-12px.png"))
    values = [min(crop.getpixel((x, y))) for y in range(12) for x in range(12)]
    mark["ink"] = sum(value >= 140 for value in values)
    mark["full"] = sum(value >= 230 for value in values)
    mark["share"] = mark["full"] / mark["ink"]
    mark["percent"] = mark["share"] * 100
print(json.dumps(result))
`, output], { input: JSON.stringify(result), encoding: "utf8", windowsHide: true }));
fs.writeFileSync(path.join(output, "measurements.json"), JSON.stringify(measured, null, 2) + "\n", "utf8");
console.log(measured.userAgent);
for (const mark of measured.marks) console.log(`${mark.kind}: ${mark.full}/${mark.ink} = ${mark.percent.toFixed(2)}%`);

// Optional baseline turns the real-browser measurement into a regression check.
if (process.argv[4]) {
  const baseline = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
  assert.equal(measured.devicePixelRatio, 1);
  assert.equal(measured.userAgent, baseline.userAgent, "Use the same Chromium build for comparison");
  for (const mark of measured.marks) {
    if (["html", "word", "excel"].includes(mark.kind)) {
      assert.ok(mark.share >= 0.35, `${mark.kind} must reach 35% full-strength ink`);
    } else {
      const before = baseline.marks.find(item => item.kind === mark.kind);
      assert.ok(before, `${mark.kind} is missing from the baseline`);
      assert.ok(mark.share >= before.share, `${mark.kind} ink share regressed`);
    }
  }
  console.log("PASS: three marks >= 35%; four unchanged marks did not regress");
}

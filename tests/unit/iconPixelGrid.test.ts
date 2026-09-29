import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Chrome icons are drawn on a 24-unit viewBox and rendered at 12px, so the
// scale is exactly 0.5 and a stroke of 2 is one device pixel wide. Anything
// thinner cannot land on a pixel: rendered in the engine and counted, a 12px
// icon at strokeWidth 1.5 had *no* pixel reach the colour it asked for, and its
// peak stopped around 190 of 230. At strokeWidth 2 between a third and four
// fifths of the ink is full strength. On the 1x display this app is used on,
// that difference is the whole of "the icons look smudged".
//
// A pin drawn at several sizes uses 24 / size, which is the same rule solved
// for whatever size it is asked for.

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const SVG_TAG = /<svg\b[^>]*>/g;
const SIZE_12 = /(?:width="12"|width=\{12\})/;
const STROKE = /strokeWidth=(?:"([\d.]+)"|\{([\d.]+)\})/;
const VIEWBOX_24 = /viewBox="0 0 24 24"/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("icon pixel grid", () => {
  it("no 12px icon on a 24 viewBox draws a stroke thinner than one device pixel", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const text = readFileSync(path, "utf8");
      for (const [tag] of text.matchAll(SVG_TAG)) {
        if (!SIZE_12.test(tag) || !VIEWBOX_24.test(tag)) continue;
        const match = STROKE.exec(tag);
        if (!match) continue;
        const width = Number(match[1] ?? match[2]);
        if (width < 2) {
          const line = text.slice(0, text.indexOf(tag)).split("\n").length;
          offenders.push(`${path.slice(SRC.length + 1)}:${line}: strokeWidth=${width}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the pane toolbar draws its overflow control, not a text character", () => {
    // U+22EE followed the UI font rather than the icons it sat between.
    const bar = readFileSync(join(SRC, "components", "workspace", "PaneTabBar.tsx"), "utf8");
    expect(bar).not.toContain("⋮");
    expect(bar).toContain("<KebabIcon />");
  });
});

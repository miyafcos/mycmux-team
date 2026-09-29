import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the postinstall patch from scripts/patch-xterm-dom.mjs: the DOM
// renderer must squeeze cell-overflowing glyphs (e.g. circled digits drawn
// fullwidth by Japanese fonts) into their allocated cells via scaleX instead
// of letting negative letter-spacing overlap them with the next glyph.
// If these fail, run `npm install` (postinstall applies the patch) or
// re-derive the anchors after an @xterm/xterm upgrade.
describe("xterm DOM renderer overflow-glyph patch", () => {
  const root = process.cwd();

  it.each([
    "node_modules/@xterm/xterm/lib/xterm.mjs",
    "node_modules/@xterm/xterm/lib/xterm.js",
  ])("%s carries the scaleX squeeze patch", (rel) => {
    const source = readFileSync(join(root, rel), "utf8");
    expect(source).toContain("transformOrigin");
    expect(source).toMatch(/scaleX\(\$\{[A-Za-z]\*[a-z]\/\([A-Za-z]\*[a-z]-[A-Za-z]+\)\}\)/);
  });

  it("package.json wires the patch into postinstall", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.postinstall).toContain("patch-xterm-dom.mjs");
  });

  it("pins @xterm/xterm exactly (patch anchors are version-specific)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.dependencies["@xterm/xterm"]).toMatch(/^\d/);
  });
});

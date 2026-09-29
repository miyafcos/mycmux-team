import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOTMENT_VERSION, patchAllotmentBundle } from "../../scripts/patch-allotment.mjs";

describe("Allotment postinstall lifetime patch", () => {
  it("runs after npm ci alongside the existing xterm patch", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts.postinstall).toBe("node scripts/patch-xterm-dom.mjs && node scripts/patch-allotment.mjs");
  });

  for (const name of ["modern.mjs", "module.js", "legacy.js"]) {
    it(`${name}: accepts the full patch idempotently and rejects partial or unrelated edits`, () => {
      const source = readFileSync(join("node_modules/allotment/dist", name), "utf8");
      expect(patchAllotmentBundle(name, source, ALLOTMENT_VERSION)).toEqual({ source, changed: false });
      expect(() => patchAllotmentBundle(name, source.replace("this.hoverDelayer.cancel(), this.el.remove();", "this.el.remove();"), ALLOTMENT_VERSION)).toThrow();
      expect(() => patchAllotmentBundle(name, source + "\n// unexpected drift\n", ALLOTMENT_VERSION)).toThrow(/drift/);
      expect(() => patchAllotmentBundle(name, source, "1.20.6")).toThrow(/version/);
    });
  }
});

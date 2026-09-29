/**
 * Release Allotment 1.20.5 Sash listeners and hover timers on disposal.
 * Patch every published entry point without changing imports or public APIs.
 * Validate all bundles before writing; reject version, anchor or byte drift.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOTMENT_VERSION = "1.20.5";
const esmEdits = [
  ['le.on("onDidChangeGlobalSize", e => {\n      this.size = e, this.layout();\n    })',
   'le.on("onDidChangeGlobalSize", this.onGlobalSizeChange = e => {\n      this.size = e, this.layout();\n    })'],
  ['this.el.removeEventListener("mouseleave", () => this.onMouseLeave)',
   'this.el.removeEventListener("mouseleave", this.onMouseLeave)'],
  ['this.el.removeEventListener("mouseleave", this.onMouseLeave), this.el.remove();',
   'this.el.removeEventListener("mouseleave", this.onMouseLeave), this.onGlobalSizeChange && le.off("onDidChangeGlobalSize", this.onGlobalSizeChange), this.hoverDelayer.cancel(), this.el.remove();'],
];
const bundles = {
  "modern.mjs": { sha: "be70790143a301310951c6914b2b583f9e0775ca3f2248bbab200875ce107a83", edits: esmEdits },
  "module.js": { sha: "e291d8f2a5bb0a08d17f7692d13b2b4a0483e585aebc3a232285751e11895aa8", edits: esmEdits },
  "legacy.js": {
    sha: "78d0b882062e1f8ebdd30698c2ad75f47f3a07ca1d7c2963467fbe9c4dd48d1f",
    edits: [
      ['te.on("onDidChangeGlobalSize", function (e) {\n      _this.size = e, _this.layout();\n    })',
       'te.on("onDidChangeGlobalSize", _this.onGlobalSizeChange = function (e) {\n      _this.size = e, _this.layout();\n    })'],
      ['this.el.removeEventListener("mouseleave", function () {\n        return _this2.onMouseLeave;\n      })',
       'this.el.removeEventListener("mouseleave", this.onMouseLeave)'],
      ['this.el.removeEventListener("mouseleave", this.onMouseLeave), this.el.remove();',
       'this.el.removeEventListener("mouseleave", this.onMouseLeave), this.onGlobalSizeChange && te.off("onDidChangeGlobalSize", this.onGlobalSizeChange), this.hoverDelayer.cancel(), this.el.remove();'],
    ],
  },
};
const sha256 = source => createHash("sha256").update(source, "utf8").digest("hex");
function replaceExactlyOnce(source, before, after, name) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${name}: anchor matched ${count} times; expected exactly 1`);
  return source.replace(before, after);
}

export function patchAllotmentBundle(name, source, version) {
  if (version !== ALLOTMENT_VERSION) throw new Error(`Unsupported allotment version ${version}; expected ${ALLOTMENT_VERSION}`);
  const bundle = bundles[name];
  if (!bundle) throw new Error(`Unsupported allotment bundle ${name}`);
  if (sha256(source) === bundle.sha) {
    for (const [before, after] of bundle.edits) source = replaceExactlyOnce(source, before, after, name);
    return { source, changed: true };
  }
  // Idempotence is accepted only if reversing the entire patch restores the
  // exact published bytes, not merely because a marker happens to be present.
  let original = source;
  for (const [before, after] of [...bundle.edits].reverse()) original = replaceExactlyOnce(original, after, before, name);
  if (sha256(original) !== bundle.sha) throw new Error(`${name}: bundle drift; re-derive the patch for the installed package`);
  return { source, changed: false };
}

export function patchAllotmentPackage(packageRoot) {
  const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const prepared = Object.keys(bundles).map(name => {
    const path = join(packageRoot, "dist", name);
    return { name, path, ...patchAllotmentBundle(name, readFileSync(path, "utf8"), version) };
  });
  for (const item of prepared) if (item.changed) writeFileSync(item.path, item.source, "utf8");
  return prepared.map(({ name, changed }) => ({ name, changed }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "allotment");
    for (const { name, changed } of patchAllotmentPackage(root)) {
      console.log(`patch-allotment: ${changed ? "patched" : "already patched"} dist/${name}`);
    }
  } catch (error) {
    console.error(`patch-allotment: ${error.message}`);
    process.exitCode = 1;
  }
}

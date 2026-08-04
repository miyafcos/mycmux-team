/**
 * postinstall patch for @xterm/xterm 6.0.0 (pinned in package.json).
 *
 * Problem: the DOM renderer keeps the cell grid via negative letter-spacing
 * (DomRendererRowFactory: spacing = width * cellWidth - measuredGlyphWidth).
 * East-Asian-ambiguous glyphs such as U+2460 CIRCLED DIGIT ONE are allocated
 * one cell but drawn at fullwidth by Japanese fonts, so the next glyph gets
 * pulled onto them and the two overlap (mojikuzure reported 2026-08-04).
 * WebGL fixes this via rescaleOverlappingGlyphs, but media backgrounds force
 * the DOM renderer (transparent WebGL is unsafe on WebView2), so the DOM
 * renderer needs the same "squeeze into the cell" behaviour.
 *
 * Fix (mirrors what Windows Terminal / xterm WebGL rescaling do):
 *   1. merge-guard: a cell whose glyph overflows its allocation (spacing
 *      below -cellWidth/2) never merges into a shared span.
 *   2. scale-apply: such spans become inline-block with the exact allocated
 *      width and a scaleX() transform that compresses the full glyph into it.
 *
 * Idempotent; exits non-zero if @xterm/xterm changed and the anchors no
 * longer match (tests/unit/xtermDomPatch.test.ts guards the applied state).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "transformOrigin";

// Identifier maps differ per bundle:
//   xterm.mjs: span=f spacing=Ke width=T cellWidth=a elements=d x=y last=E
//   xterm.js : span=b spacing=M  width=C cellWidth=c elements=m x=x last=U
const EDITS = {
  "node_modules/@xterm/xterm/lib/xterm.mjs": [
    [
      "&&x.extended.ext===P&&te===oe&&Ke===Me&&!Z&&!g&&!Oe&&w){",
      "&&x.extended.ext===P&&te===oe&&Ke===Me&&Ke>=a*-.5&&!Z&&!g&&!Oe&&w){",
    ],
    [
      "Ke!==this.defaultSpacing&&(f.style.letterSpacing=`${Ke}px`),d.push(f),y=E",
      'Ke!==this.defaultSpacing&&(Ke<a*-.5?(f.style.letterSpacing="0px",f.style.display="inline-block",f.style.width=`${T*a}px`,f.style.transform=`scaleX(${T*a/(T*a-Ke)})`,f.style.transformOrigin="0 50%",f.style.verticalAlign="top"):f.style.letterSpacing=`${Ke}px`),d.push(f),y=E',
    ],
  ],
  "node_modules/@xterm/xterm/lib/xterm.js": [
    [
      "&&F.extended.ext===R&&K===A&&M===T&&!H&&!B&&!z&&N){",
      "&&F.extended.ext===R&&K===A&&M===T&&M>=c*-.5&&!H&&!B&&!z&&N){",
    ],
    [
      "M!==this.defaultSpacing&&(b.style.letterSpacing=`${M}px`),m.push(b),x=U",
      'M!==this.defaultSpacing&&(M<c*-.5?(b.style.letterSpacing="0px",b.style.display="inline-block",b.style.width=`${C*c}px`,b.style.transform=`scaleX(${C*c/(C*c-M)})`,b.style.transformOrigin="0 50%",b.style.verticalAlign="top"):b.style.letterSpacing=`${M}px`),m.push(b),x=U',
    ],
  ],
};

let failed = false;
for (const [rel, edits] of Object.entries(EDITS)) {
  const path = join(repoRoot, rel);
  let source = readFileSync(path, "utf8");
  if (source.includes(MARKER)) {
    console.log(`patch-xterm-dom: already patched ${rel}`);
    continue;
  }
  let ok = true;
  for (const [before, after] of edits) {
    const count = source.split(before).length - 1;
    if (count !== 1) {
      console.error(
        `patch-xterm-dom: anchor matched ${count} times (expected 1) in ${rel} — @xterm/xterm changed, re-derive the patch`,
      );
      ok = false;
      failed = true;
      break;
    }
    source = source.replace(before, after);
  }
  if (ok) {
    writeFileSync(path, source, "utf8");
    console.log(`patch-xterm-dom: patched ${rel}`);
  }
}
process.exit(failed ? 1 : 0);

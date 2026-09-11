import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The UI uses both parenthesis widths, and it is not carelessness — it is a
// rule, which I mistook for a mixture twice before measuring it:
//
//   full-width （…） welds a short qualifier to the word in front of it, with
//   no space. Median three characters inside: （合計）（全体）（例）.
//
//   half-width ( … ) sets off a sentence-level aside, always after a space.
//   Median nine characters inside: 「… (詳細はコンソール)」.
//
// Counted across src/ the split is exact: every full-width pair is unspaced,
// and every mid-string half-width pair is spaced. Standalone strings that are
// nothing but a parenthetical — a placeholder like (ホーム) — have nothing in
// front to space against and are left alone.
//
// What this pins is the crisp half of that: the spacing. A tight half-width
// pair or a spaced full-width one is the error, whichever way the length
// judgement falls.

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const JAPANESE = /[぀-ヿ一-鿿]/;
// No newlines or backticks inside: without that, a pair of quotes can straddle
// a line of code and capture source rather than a string.
const LITERAL = /"([^"\\\r\n`]{2,120})"/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

interface Offence {
  where: string;
  literal: string;
  why: string;
}

function offences(): Offence[] {
  const found: Offence[] = [];
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    for (const [, literal] of text.matchAll(LITERAL)) {
      if (!JAPANESE.test(literal)) continue;
      const where = path.slice(SRC.length + 1);
      const full = literal.indexOf("（");
      if (full > 0 && literal[full - 1] === " ") {
        found.push({ where, literal, why: "full-width pair preceded by a space" });
        continue;
      }
      if (full !== -1) continue;
      const half = literal.indexOf("(");
      // Index 0 is a standalone parenthetical; there is nothing to space from.
      // A template hole right before the pair carries its own spacing.
      if (half > 0 && literal[half - 1] !== " " && literal[half - 1] !== "}") {
        found.push({ where, literal, why: "half-width pair with no space in front" });
      }
    }
  }
  return found;
}

describe("Japanese parentheses", () => {
  it("keeps the two widths to their own spacing", () => {
    expect(offences().map((o) => `${o.where}: ${o.literal} — ${o.why}`)).toEqual([]);
  });

  it("still uses both widths, so the rule has something to be a rule about", () => {
    let full = 0;
    let half = 0;
    for (const path of sourceFiles(SRC)) {
      const text = readFileSync(path, "utf8");
      for (const [, literal] of text.matchAll(LITERAL)) {
        if (!JAPANESE.test(literal)) continue;
        if (literal.includes("（")) full += 1;
        else if (literal.includes("(")) half += 1;
      }
    }
    expect(full).toBeGreaterThan(5);
    expect(half).toBeGreaterThan(20);
  });
});

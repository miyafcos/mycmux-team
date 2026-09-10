import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The app is Japanese, but the language used to change from control to control:
// "Split right" beside 「セッションを複製」in one toolbar, an English shortcut
// list, an English workspace dialog, an English document toolbar. Nothing was
// wrong with any single string — the mixture was what read as unfinished.
//
// A tooltip, an accessible name and a placeholder are all read by a person, so
// they are the surfaces this walks. Strings assembled from a table are not
// literals here, which is the point: the tables are where translations live.

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
// A leading space or "<" keeps this off data-* attributes that merely end in
// one of these words (data-declared-tab-placeholder, say).
const ATTR = /[\s<](?:title|aria-label|placeholder)="([^"]{2,80})"/g;
const JAPANESE = /[぀-ヿ一-鿿]/;

// Names of things, which stay in the language of the thing.
const PROPER_NOUNS = /^(Claude|Codex|Grok|ChatGPT|Gemini|mycmux|GitHub|Slack|Web|PTY)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("UI language", () => {
  it("no tooltip, accessible name or placeholder is written in English", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const text = readFileSync(path, "utf8");
      for (const [, value] of text.matchAll(ATTR)) {
        if (JAPANESE.test(value) || PROPER_NOUNS.test(value)) continue;
        const line = text.slice(0, text.indexOf(`"${value}"`)).split("\n").length;
        offenders.push(`${path.slice(SRC.length + 1)}:${line}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

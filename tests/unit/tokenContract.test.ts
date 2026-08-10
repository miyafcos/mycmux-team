import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every var(--cmux-*) reference has to resolve. An undefined token silently
// falls back to the inherited value (or nothing at all), which is how unreadable
// grey-on-grey text kept shipping: the reference looked deliberate in review.

const srcDir = fileURLToPath(new URL("../../src", import.meta.url));

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(tsx?|css)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const globalCss = readFileSync(path.join(srcDir, "global.css"), "utf8");
const appShell = readFileSync(
  path.join(srcDir, "components", "layout", "AppShell.tsx"),
  "utf8",
);

const rootBlockStart = globalCss.indexOf(":root");
const rootBlock = globalCss.slice(rootBlockStart, globalCss.indexOf("}", rootBlockStart));
const definedTokens = new Set(
  [...rootBlock.matchAll(/(--cmux-[a-z0-9-]+)\s*:/g)].map((match) => match[1]),
);

describe("cmux design token contract", () => {
  it("defines every --cmux-* token referenced from src", () => {
    const undefinedReferences: string[] = [];
    for (const file of collectSourceFiles(srcDir)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/var\(\s*(--cmux-[a-z0-9-]+)/g)) {
        if (!definedTokens.has(match[1])) {
          undefinedReferences.push(`${path.relative(srcDir, file)}: ${match[1]}`);
        }
      }
    }
    expect([...new Set(undefinedReferences)].sort()).toEqual([]);
  });

  it("keeps AppShell's themeVars keys inside the global.css token set", () => {
    const themeVarKeys = [...appShell.matchAll(/"(--cmux-[a-z0-9-]+)":/g)].map(
      (match) => match[1],
    );
    expect(themeVarKeys.length).toBeGreaterThan(0);
    expect(themeVarKeys.filter((key) => !definedTokens.has(key)).sort()).toEqual([]);
  });

  it("defines the readability tokens this phase introduced", () => {
    for (const token of ["--cmux-accent-text", "--cmux-yellow", "--cmux-boot-bg"]) {
      expect(definedTokens.has(token), token).toBe(true);
    }
    // The boot ground is only useful if AppShell keeps feeding the key that
    // index.html reads before React mounts.
    expect(appShell).toContain('"mycmux-boot-chrome"');
  });
});

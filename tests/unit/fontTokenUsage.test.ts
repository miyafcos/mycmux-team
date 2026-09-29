import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Components used to name font stacks inline. Two of those stacks were wrong on
// macOS and nobody could see it from the code: the UI one
// ("-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif") left out
// every Japanese face, so the sidebar, title bar and account strip fell through
// to whatever generic sans-serif WebKit picked; and 'JetBrains Mono' is
// installed on neither platform, so the shortcut list rendered in a fallback.
// --cmux-font-ui and --cmux-font-mono carry the stacks the app actually tested.

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

// The terminal's own family is a user setting, and the theme store owns the
// preset stacks the setting chooses from, so those name real fonts on purpose.
const OWNS_A_FONT_STACK = new Set([
  join(SRC, "stores", "themeStore.ts"),
  join(SRC, "lib", "fontAvailability.ts"),
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(path) && !OWNS_A_FONT_STACK.has(path) ? [path] : [];
  });
}

describe("font tokens", () => {
  it("no component names a UI or code font stack inline", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const text = readFileSync(path, "utf8");
      text.split(/\r?\n/).forEach((line, index) => {
        if (/JetBrains Mono|BlinkMacSystemFont|Menlo, Consolas/.test(line)) {
          offenders.push(`${path.slice(SRC.length + 1)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("both tokens carry the faces the inline stacks were missing", () => {
    const css = readFileSync(fileURLToPath(new URL("../../src/global.css", import.meta.url)), "utf8");
    const ui = css.match(/--cmux-font-ui:\s*([^;]+);/)?.[1] ?? "";
    expect(ui).toContain("-apple-system");
    expect(ui).toContain("Hiragino Sans");
    expect(ui).toContain("Segoe UI");
    const mono = css.match(/--cmux-font-mono:\s*([^;]+);/)?.[1] ?? "";
    expect(mono).toContain("UDEV Gothic NF");
    expect(mono).toContain("ui-monospace");
  });
});

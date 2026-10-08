import { describe, expect, it, vi } from "vitest";
import { fitLiveTailLine } from "../../src/components/layout/LiveTailList";

const width = (text: string) => Array.from(text).reduce((sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 10 : /[il.]/.test(char) ? 3 : 5.5), 0);

describe("live-tail measured middle fitting", () => {
  it.each([
    ["* Thinking about a long sample draft… (1h 52m 49s · ↓ 62.3k tokens)", "(1h 52m 49s · ↓ 62.3k tokens)"],
    ["● Wait for a long sample report · 2m 4s", "· 2m 4s"],
    ["● 架空の日本語の資料を確認する長い見出し · 2m 4s", "· 2m 4s"],
    ["✽ 架空の日本語の確認を続けています… (3m 12s · ↓ 12.4k tokens)", "(3m 12s · ↓ 12.4k tokens)"],
    ["• Working through a long sample task (7m 45s • esc to interrupt)", "(7m 45s • esc to interrupt)"],
  ])("retains the trailing counters in %s", (input, tail) => {
    const measure = vi.fn(width);
    const result = fitLiveTailLine(input, 210, measure);
    expect(result).toContain("…"); expect(result.endsWith(tail)).toBe(true);
    expect(width(result)).toBeLessThanOrEqual(210);
    expect(measure).toHaveBeenCalledWith(input);
    const [prefix, suffix] = result.split("…");
    expect(input.startsWith(prefix)).toBe(true); expect(input.endsWith(suffix)).toBe(true);
  });
  it("uses font widths rather than character counts", () => {
    const narrow = (value: string) => value.length;
    const wide = (value: string) => value.length * 8;
    expect(fitLiveTailLine("sample line 123", 20, narrow)).toBe("sample line 123");
    expect(fitLiveTailLine("sample line 123", 60, wide)).toContain("…123");
  });
  it.each([0, 1, 5, 10, 40, 120, 200])("never exceeds a %i px budget", available => {
    for (const text of ["日本語の長いサンプル確認 12345", "sample (123m 4s · ↓ 999k tokens)", "🌱 sample 123", ""]) {
      expect(width(fitLiveTailLine(text, available, width))).toBeLessThanOrEqual(available);
    }
  });
  it("keeps a complete numeric suffix when the whole parenthetical tail cannot fit", () => {
    const result = fitLiveTailLine("long sample title (1h 52m 49s · ↓ 62.3k tokens)", 95, width);
    expect(result.endsWith("62.3k tokens)")).toBe(true);
    expect(width(result)).toBeLessThanOrEqual(95);
  });
  it("does not split a surrogate pair", () => {
    const result = fitLiveTailLine("🌱🌱🌱 sample with a very long heading 12s", 85, width);
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

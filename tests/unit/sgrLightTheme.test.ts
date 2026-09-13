import { readFileSync } from "node:fs";
import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { rewriteSgrForLightTheme, SgrLightRewriter } from "../../src/components/terminal/sgrLightTheme";

const noSubParams = () => false;

describe("light SGR parameters", () => {
  it.each([
    [[2], [90]], [[1, 2], [1, 90]], [[22], [22, 39]], [[0], [0]],
    [[38, 5, 2], [38, 5, 2]], [[38, 2, 10, 20, 30], [38, 2, 10, 20, 30]],
    [[2, 38, 2, 1, 2, 3], [90, 38, 2, 1, 2, 3]],
    [[48, 5, 22, 2], [48, 5, 22, 90]],
    [[48, 2, 2, 22, 2, 22], [48, 2, 2, 22, 2, 22, 39]],
    [[58, 5, 2, 22], [58, 5, 2, 22, 39]],
    [[58, 2, 2, 22, 2, 2], [58, 2, 2, 22, 2, 90]],
    [[22, 34, 2, 22], [22, 39, 34, 90, 22, 39]],
    [[38, 2, 2], [38, 2, 2]],
  ])("rewrites %j to %j", (input, output) => {
    const original = [...input];
    expect(rewriteSgrForLightTheme(input, noSubParams)).toEqual(output);
    expect(input).toEqual(original);
  });
  it("leaves colon tokens untouched without consuming the following SGR", () => {
    expect(rewriteSgrForLightTheme([38, 2, 22], i => i === 0)).toEqual([38, 90, 22, 39]);
    expect(rewriteSgrForLightTheme([2, 22], () => true)).toEqual([2, 22]);
  });
});

describe("streaming light SGR", () => {
  const raw = "a\x1b[1;2mDIM\x1b[22;38:2::1:2:3mRGB\x1b[0mZ";
  const expected = "a\x1b[1;90mDIM\x1b[22;39;38:2::1:2:3mRGB\x1b[0mZ";
  it("handles every two-chunk split, including after ESC and inside parameters", () => {
    for (let i = 0; i <= raw.length; i += 1) {
      const r = new SgrLightRewriter();
      expect(r.push(raw.slice(0, i)) + r.push(raw.slice(i))).toBe(expected);
    }
  });
  it("handles one-character chunks", () => {
    const r = new SgrLightRewriter();
    expect([...raw].map(c => r.push(c)).join("")).toBe(expected);
  });
  it("preserves colon form, color arguments, resets, leading zeros and non-SGR controls", () => {
    const r = new SgrLightRewriter();
    const unchanged = "\x1b[38;5;2m\x1b[48;2;2;22;3m\x1b[58:2::2:22:3m\x1b[2:1m\x1b[00m\x1b[m\x1b[2J\x1b[?2m";
    expect(r.push(unchanged)).toBe(unchanged);
    expect(r.push("\x1b[22;38:2::2:22:3;2m")).toBe("\x1b[22;39;38:2::2:22:3;90m");
  });
  it("passes OSC and DCS payloads through even when split around embedded SGR", () => {
    const raw = "\x1b]0;title\x1b[2m\x07\x1bPdata\x1b[22m\x1b\\\x1b[2m";
    for (let i = 0; i <= raw.length; i += 1) {
      const r = new SgrLightRewriter();
      expect(r.push(raw.slice(0, i)) + r.push(raw.slice(i))).toBe(raw.slice(0, -4) + "\x1b[90m");
    }
  });
  it("bounds a pending tail to 64 characters and flushes longer tails unchanged", () => {
    const r = new SgrLightRewriter();
    const tail = "\x1b[" + "2;".repeat(31);
    expect(tail).toHaveLength(64);
    expect(r.push(tail)).toBe("");
    expect(r.push("2")).toBe(tail + "2");
    expect(r.push("mText")).toBe("mText");
    expect(new SgrLightRewriter().push(tail + "2")).toBe(tail + "2");
  });
  it("cancels malformed CSI without swallowing later valid sequences", () => {
    expect(new SgrLightRewriter().push("\x1b[2\x1b[2mX")).toBe("\x1b[2\x1b[90mX");
  });
  it("resets pending bytes for disposal or a replacement replay", () => {
    const r = new SgrLightRewriter();
    expect(r.push("\x1b[2")).toBe("");
    r.reset();
    expect(r.push("mX")).toBe("mX");
  });
  it("passes dark output through and preserves held bytes across a light-to-dark switch", () => {
    const r = new SgrLightRewriter();
    expect(r.transform(raw, false)).toBe(raw);
    expect(r.transform("\x1b", false)).toBe("\x1b");
    expect(r.transform("[2mX", false)).toBe("[2mX");
    expect(r.transform("\x1b[2", true)).toBe("");
    expect(r.transform("mX", false)).toBe("\x1b[2mX");
    expect(r.transform("\x1b[2mX", true)).toBe("\x1b[90mX");
  });
  it.each([true, false])("feeds the public xterm writer with light=%s", async light => {
    const term = new Terminal({ allowProposedApi: true });
    const r = new SgrLightRewriter();
    try {
      for (const chunk of ["\x1b", "[2", "mX", "\x1b[22mY"]) {
        await new Promise<void>(resolve => term.write(r.transform(chunk, light), resolve));
      }
      expect(!!term.buffer.active.getLine(0)!.getCell(0)!.isDim()).toBe(!light);
      expect(term.buffer.active.getLine(0)!.getCell(0)!.getFgColor()).toBe(light ? 8 : -1);
      expect(!!term.buffer.active.getLine(0)!.getCell(1)!.isDim()).toBe(false);
      expect(term.buffer.active.getLine(0)!.getCell(1)!.getFgColor()).toBe(-1);
    } finally { term.dispose(); }
  });
});

describe("XTermWrapper stream wiring", () => {
  const source = readFileSync(new URL("../../src/components/terminal/XTermWrapper.tsx", import.meta.url), "utf8");
  it("uses the live light-theme ref for both output writers, before public write", () => {
    expect(source).toContain('isLightThemeRef.current = storeTheme.colorScheme === "light";');
    expect(source).toContain('sgrLightRewriters.get(term)!.transform(displayOutput, isLightThemeRef.current)');
    expect(source).toContain('sgrLightRewriter.transform(adaptedOutput, isLightThemeRef.current)');
    expect(source).toContain('term.write(rewrittenOutput, finish);');
    expect(source).toContain('replayTerm.write(rewrittenOutput, () => {');
  });
  it("keeps one instance per Terminal across cached mounts and resets via public addon disposal", () => {
    expect(source).toContain('new WeakMap<Terminal, SgrLightRewriter>()');
    expect(source.match(/new SgrLightRewriter\(\)/g)).toHaveLength(1);
    expect(source).toContain('sgrLightRewriters.set(term, sgrLightRewriter);');
    expect(source).toContain('dispose() { sgrLightRewriter.reset(); }');
    expect(source.match(/sgrLightRewriters.get\(term\)\?\.reset\(\)/g)).toHaveLength(3);
  });
});

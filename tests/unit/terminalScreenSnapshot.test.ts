// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal as LiveTerminal } from "@xterm/xterm";
// @ts-expect-error Published headless ESM has no adjacent declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { LightDarkColorAdaptController } from "../../src/lib/lightDarkColorAdapt";
import type { ScrollbackCursor } from "../../src/lib/ipc";
import { invalidatePtyReads, replacePtyReadOwners } from "../../src/lib/ptyReadGeneration";
import { withAnsiContrastFloor } from "../../src/components/terminal/terminalThemeColors";
import { SgrLightRewriter } from "../../src/components/terminal/sgrLightTheme";
import { getTerminalBufferLines, getTerminalBufferScreen } from "../../src/components/terminal/XTermWrapper";
import { liveTerms, termCache, type CachedTerm } from "../../src/components/terminal/terminalCache";
import { __resetHeadlessBufferCacheForTests, __headlessBufferCacheSizeForTests, readHeadlessBufferScreen, getHeadlessBufferLines, readHeadlessBufferLines } from "../../src/components/terminal/headlessBuffer";
import { snapshotTerminalScreen, terminalScreenTheme, clampScreenScrollback } from "../../src/components/terminal/terminalScreenSnapshot";
import { trackTerminalScreenState, resetTerminalScreenState, terminalScreenCursorVisible, terminalScreenThemeFor, resetTerminalScreenColors } from "../../src/components/terminal/terminalScreenState";
import { useThemeStore } from "../../src/stores/themeStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { setEffectiveMediaActive } from "../../src/stores/compositionStore";

const HeadlessTerminal = PublishedTerminal as typeof import("@xterm/headless").Terminal;
type Headless = InstanceType<typeof HeadlessTerminal>;
const terminals: Array<Headless | LiveTerminal> = [];
const encoder = new TextEncoder();
const owner = Symbol("screen tests");
const theme = terminalScreenTheme({ foreground: "#d4d4d4", background: "#1e1e1e", cursor: "#ffffff" });
function terminal(cols = 20, rows = 5): Headless {
  const term = new HeadlessTerminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = "11";
  trackTerminalScreenState(term); terminals.push(term); return term;
}
const write = (term: Headless | LiveTerminal, text: string) => new Promise<void>(resolve => term.write(text, resolve));
const screen = (term: Headless, scrollback: unknown = 0) => snapshotTerminalScreen(term, theme, {
  scrollback, cursorVisible: terminalScreenCursorVisible(term),
});
const rowText = (runs: ReturnType<typeof screen>["lines"][number]) => runs.map(run => run[2]).join("");

beforeEach(() => {
  replacePtyReadOwners(owner, new Set(["parity", "split", "legacy"]));
  __resetHeadlessBufferCacheForTests();
  useThemeStore.getState().hydrateSettings({ themeId: "mayonaka", themeTweaks: undefined });
  useSettingsStore.setState({ colorAdaptCommands: [] });
  usePaneMetadataStore.setState({ volatileMetadata: {} });
  setEffectiveMediaActive(false);
});
afterEach(() => {
  __resetHeadlessBufferCacheForTests(); replacePtyReadOwners(owner, new Set());
  terminals.splice(0).forEach(term => term.dispose()); liveTerms.clear(); termCache.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("physical terminal screen serialization", () => {
  it("preserves indentation by column, empty rows and soft wraps", async () => {
    const term = terminal(10, 5);
    await write(term, "  indented\r\n\r\nABCDEFGHIJKLM");
    const result = screen(term);
    expect(result.lines).toEqual([
      [[2, 1, "indented", null, null, 0]], [],
      [[0, 1, "ABCDEFGHIJ", null, null, 0]], [[0, 1, "KLM", null, null, 0]], [],
    ]);
    expect(result.cursor).toEqual({ col: 3, row: 3, visible: true });
  });

  it("uses actual Unicode 11 cell widths for CJK, combining marks and emoji", async () => {
    const term = terminal(); await write(term, "日本Ae\u0301🧪Z");
    expect(screen(term).lines[0]).toEqual([
      [0, 2, "日本", null, null, 0], [4, 1, "Ae\u0301", null, null, 0],
      [6, 2, "🧪", null, null, 0], [8, 1, "Z", null, null, 0],
    ]);
  });

  it.each(["👩‍💻中Z", "🇯🇵中Z", "👍🏽中Z", "✈️中Z", "Ae\u0301中Z"])(
    "keeps grapheme positions aligned with xterm cells for %s", async text => {
      const term = terminal(); await write(term, text);
      const line = term.buffer.active.getLine(0)!;
      const expected = [];
      for (let col = 0; col < term.cols; col++) {
        const cell = line.getCell(col)!;
        if (cell.getWidth() && cell.getChars()) expected.push({ col, width: cell.getWidth(), text: cell.getChars() });
      }
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const result = screen(term).lines[0].flatMap(([col, width, value]) =>
        [...segmenter.segment(value)].map(({ segment }, index) => ({ col: col + width * index, width, text: segment })));
      expect(result).toEqual(expected);
      expect(result.find(cell => cell.text === "Z")?.col).toBe(term.buffer.active.cursorX - 1);
      if (text === "👩‍💻中Z") expect(result.find(cell => cell.text === "Z")?.col).toBe(6);
    },
  );

  it("loads without Intl.Segmenter and keeps one run per xterm cell", async () => {
    const term = terminal(); await write(term, "AB日本👩‍💻Z");
    vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
    vi.resetModules();
    const { snapshotTerminalScreen: read } = await import("../../src/components/terminal/terminalScreenSnapshot");
    const expected = [];
    for (let col = 0; col < term.cols; col++) {
      const cell = term.buffer.active.getLine(0)!.getCell(col)!;
      if (cell.getWidth() && cell.getChars()) expected.push([col, cell.getWidth(), cell.getChars(), null, null, 0]);
    }
    expect(read(term, theme).lines[0]).toEqual(expected);
  });

  it("constructs Intl.Segmenter only when a slow boundary first needs it", async () => {
    const Segmenter = Intl.Segmenter;
    const construct = vi.fn();
    vi.spyOn(Intl, "Segmenter").mockImplementation(function (...args: ConstructorParameters<typeof Intl.Segmenter>) {
      construct(); return new Segmenter(...args);
    });
    vi.resetModules();
    const { snapshotTerminalScreen: read } = await import("../../src/components/terminal/terminalScreenSnapshot");
    expect(construct).not.toHaveBeenCalled();
    const term = terminal(); await write(term, "日本語ABC─━");
    read(term, theme); expect(construct).not.toHaveBeenCalled();
    await write(term, "👩‍💻Z");
    read(term, theme); read(term, theme); expect(construct).toHaveBeenCalledTimes(1);
  });

  it("joins more than 256 diverse CJK pairs without per-pair segmentation", async () => {
    const term = terminal(120, 40);
    const text = Array.from({ length: 1200 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("");
    await write(term, text);
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    const result = screen(term); screen(term);
    expect(segment).not.toHaveBeenCalled();
    expect(result.lines.flat().every(run => run[0] === 0 && run[1] === 2 && run[2].length === 60)).toBe(true);
    expect(result.lines.flat().map(run => run[2]).join("")).toBe(text);
  });

  it("matches Intl graphemes across fast-range kana, CJK, Hangul and border pairs", async () => {
    const groups = [[0x20, 0x2ff], [0x2500, 0x259f], [0x3000, 0x3098], [0x309b, 0x30ff],
      [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7a3]];
    const representatives = groups.flatMap(([start, end]) => [start, Math.floor((start + end) / 2), end]);
    const text = representatives.flatMap(left => representatives.map(right => String.fromCharCode(left, right)))
      .join("\r\n");
    const term = terminal(10, 500); await write(term, text);
    const result = screen(term);
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (let row = 0; row < term.rows; row++) {
      const actual = result.lines[row].flatMap(([col, width, value]) => [...segmenter.segment(value)]
        .map(({ segment }, i) => ({ col: col + width * i, width, text: segment })));
      const expected = [];
      for (let col = 0; col < term.cols; col++) {
        const cell = term.buffer.active.getLine(row)!.getCell(col)!;
        if (cell.getWidth() && cell.getChars().trim()) expected.push({ col, width: cell.getWidth(), text: cell.getChars() });
      }
      expect(actual).toEqual(expected);
    }
  });

  it.each(["カ\u3099Z", "カ\u309aZ", "ｶ\uff9eZ", "ﾊ\uff9fZ", "가Z"])(
    "keeps excluded combining boundaries aligned for %s", async text => {
      const term = terminal(); await write(term, text);
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const actual = screen(term).lines[0].flatMap(([col, width, value]) => [...segmenter.segment(value)]
        .map(({ segment }, i) => ({ col: col + width * i, width, text: segment })));
      const expected = [];
      for (let col = 0; col < term.cols; col++) {
        const cell = term.buffer.active.getLine(0)!.getCell(col)!;
        if (cell.getWidth() && cell.getChars()) expected.push({ col, width: cell.getWidth(), text: cell.getChars() });
      }
      expect(actual).toEqual(expected);
    },
  );

  it.each([0x200b, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x206f, 0xfeff])(
    "keeps B at its xterm column after zero-width control %i", async control => {
      const term = terminal(); await write(term, "A" + String.fromCharCode(control) + "B");
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const cells = screen(term).lines[0].flatMap(([col, width, value]) => [...segmenter.segment(value)]
        .map(({ segment }, i) => ({ col: col + width * i, text: segment })));
      expect(cells).toEqual([{ col: 0, text: "A" }, { col: 1, text: "B" }]);
      expect(term.buffer.active.getLine(0)!.getCell(1)!.getChars()).toBe("B");
    },
  );

  it.each(["A\u200cB", "👩\u200d💻Z", "✈\ufe0fZ"])("preserves joining and variation characters in %s", async text => {
    const term = terminal(); await write(term, text);
    expect(rowText(screen(term).lines[0])).toBe(text);
  });

  it("preserves default, palette and RGB colors and every flags bit", async () => {
    const term = terminal();
    await write(term, "a\x1b[31mB\x1b[38;5;201;48;5;238mC\x1b[38;2;1;2;255;48;2;4;5;6mD\x1b[0;1;2;3;4;7;9mE\x1b[0m");
    expect(screen(term).lines[0]).toEqual([
      [0, 1, "a", null, null, 0], [1, 1, "B", 1, null, 0], [2, 1, "C", 201, 238, 0],
      [3, 1, "D", "#0102ff", "#040506", 0], [4, 1, "E", null, null, 63],
    ]);
  });

  it.each([[1, 1], [3, 2], [4, 4], [2, 8], [7, 16], [9, 32]])("maps SGR %i to the individual flags bit %i", async (sgr, flag) => {
    const term = terminal(); await write(term, `\x1b[${sgr}mX\x1b[0m`);
    expect(screen(term).lines[0]).toEqual([[0, 1, "X", null, null, flag]]);
  });

  it("retains background-only erasures, inverse, underline and strikeout spaces", async () => {
    const term = terminal(10, 4);
    await write(term, "\x1b[44m\x1b[K\x1b[0m\r\n\x1b[7m  \x1b[0m\r\n\x1b[4m \x1b[0m\r\n\x1b[9m \x1b[0m");
    expect(screen(term).lines).toEqual([
      [[0, 1, " ".repeat(10), null, 4, 0]], [[0, 1, "  ", null, null, 16]],
      [[0, 1, " ", null, null, 4]], [[0, 1, " ", null, null, 32]],
    ]);
  });

  it("does not expose concealed glyphs", async () => {
    const term = terminal(); await write(term, "\x1b[8mhidden日本\x1b[0m!");
    expect(screen(term).lines[0]).toEqual([[10, 1, "!", null, null, 0]]);
  });

  it("clamps scrollback and returns exactly history plus viewport rows", async () => {
    const term = terminal(10, 3);
    await write(term, Array.from({ length: 520 }, (_, i) => String(i)).join("\r\n"));
    for (const [value, count] of [[undefined, 0], [-2, 0], [3.9, 3], [800, 500], [NaN, 0], ["4", 0]] as const) {
      const result = screen(term, value);
      expect(result.scrollbackLines).toBe(count); expect(result.lines).toHaveLength(count + 3);
      expect(result.cursor).toEqual({ col: 3, row: 2, visible: true });
    }
    expect(clampScreenScrollback(Infinity)).toBe(500); expect(clampScreenScrollback(-Infinity)).toBe(0);
    const short = terminal(); await write(short, "one\r\ntwo");
    expect(screen(short, 500).scrollbackLines).toBe(0);
  });

  it("reads the PC scroll position and omits a cursor outside that viewport", async () => {
    const term = terminal(10, 4);
    await write(term, Array.from({ length: 12 }, (_, i) => `row-${i}`).join("\r\n"));
    term.scrollToLine(2);
    const before = { y: term.buffer.active.viewportY, length: term.buffer.active.length, x: term.buffer.active.cursorX };
    const result = screen(term, 2);
    expect(result.atBottom).toBe(false); expect(result.cursor).toBeNull();
    expect(result.lines.map(rowText)).toEqual(["row-0", "row-1", "row-2", "row-3", "row-4", "row-5"]);
    expect({ y: term.buffer.active.viewportY, length: term.buffer.active.length, x: term.buffer.active.cursorX }).toEqual(before);
    term.scrollToBottom(); await write(term, "\x1b[1;2H"); term.scrollLines(-1);
    expect(screen(term, 3).cursor).toEqual({ col: 1, row: 1, visible: true });
  });

  it("tracks alternate screens and cursor visibility through public parser hooks", async () => {
    const term = terminal(); await write(term, "normal\x1b[?1049h\x1b[?25lALT");
    expect(screen(term, 500)).toMatchObject({ alternateScreen: true, atBottom: true, scrollbackLines: 0, cursor: { visible: false } });
    await write(term, "\x1b[?1;25h"); expect(screen(term).cursor?.visible).toBe(true);
    await write(term, "\x1b[?1049l"); expect(screen(term).alternateScreen).toBe(false);
    expect(rowText(screen(term).lines[0])).toBe("normal");
    await write(term, "\x1b[?25l\x1b[!p"); expect(screen(term).cursor?.visible).toBe(true);
    await write(term, "\x1b[?25l\x1bc"); expect(screen(term).cursor?.visible).toBe(true);
    await write(term, "\x1b[?25l"); term.reset(); resetTerminalScreenState(term);
    expect(screen(term).cursor?.visible).toBe(true);
  });

  it("keeps a pending-wrap cursor on the last visible column", async () => {
    const term = terminal(4, 2); await write(term, "ABCD");
    expect(screen(term).cursor).toEqual({ col: 3, row: 0, visible: true });
  });

  it("serializes actual theme RGB and sixteen ordered ANSI entries", () => {
    const result = terminalScreenTheme({ foreground: "#ABC", background: "rgba(30, 40, 50, 0)", cursor: "#112233aa", red: "#456" });
    expect(result).toMatchObject({ foreground: "#aabbcc", background: "#1e2832", cursor: "#112233" });
    expect(result.palette).toHaveLength(16); expect(result.palette[1]).toBe("#445566");
  });
});

describe("browser/headless parity and legacy reads", () => {
  it.each([19045, 22631])("matches live Windows ConPTY build %i before and after resize", async buildNumber => {
    const live = new LiveTerminal({ cols: 10, rows: 5, allowProposedApi: true,
      windowsPty: { backend: "conpty", buildNumber }, theme: useThemeStore.getState().theme.terminal });
    trackTerminalScreenState(live, () => live.options.theme); terminals.push(live); liveTerms.set("parity", live);
    const text = "ABCDEFGHIJKLMNO\r\nlast", data = encoder.encode(text); await write(live, text);
    const original = { data, startOffset: 0, endOffset: data.length, sessionEpoch: 1, sizeRevision: 1 };
    expect(await readHeadlessBufferScreen("parity", async () => original, 0, { cols: 10, rows: 5 }))
      .toEqual(getTerminalBufferScreen("parity", 0));
    // Exercise the hidden/cached terminal path as well as the live one.
    liveTerms.delete("parity"); termCache.set("parity", { term: live } as CachedTerm);
    __resetHeadlessBufferCacheForTests();
    expect(await readHeadlessBufferScreen("parity", async () => original, 0, { cols: 10, rows: 5 }))
      .toEqual(getTerminalBufferScreen("parity", 0));
    for (const [sizeRevision, cols, rows] of [[2, 20, 5], [3, 5, 7]]) {
      live.resize(cols, rows);
      expect(await readHeadlessBufferScreen("parity", async () => ({ ...original, sizeRevision }), 0, { cols, rows }))
        .toEqual(getTerminalBufferScreen("parity", 0));
    }
  });

  it.each([[5, 5], [20, 7]])("continues the parsed screen after resizing to %i x %i", async (cols, rows) => {
    const live = new LiveTerminal({ cols: 10, rows: 5, allowProposedApi: true, theme: useThemeStore.getState().theme.terminal });
    trackTerminalScreenState(live, () => live.options.theme); terminals.push(live); liveTerms.set("parity", live);
    const data = encoder.encode("ABCDEFGHIJK\rX");
    await write(live, new TextDecoder().decode(data));
    const original = { data, startOffset: 0, endOffset: data.length, sessionEpoch: 1, sizeRevision: 1 };
    expect(await readHeadlessBufferScreen("parity", async () => original, 0, { cols: 10, rows: 5 }))
      .toEqual(getTerminalBufferScreen("parity", 0));
    live.resize(cols, rows);
    expect(await readHeadlessBufferScreen("parity", async () => ({ ...original, sizeRevision: 2 }), 0, { cols, rows }))
      .toEqual(getTerminalBufferScreen("parity", 0));
    const extra = encoder.encode("\r\nnext"); await write(live, "\r\nnext");
    const endOffset = data.length + extra.length;
    const current = await readHeadlessBufferScreen("parity", async () => ({ data: extra, startOffset: data.length,
      endOffset, sessionEpoch: 1, sizeRevision: 2, isDelta: true }), 0, { cols, rows });
    expect(current).toEqual(getTerminalBufferScreen("parity", 0));
    // A delayed reply with an older geometry revision must not resize the parser back.
    expect(await readHeadlessBufferScreen("parity", async () => ({ ...original, data: new Uint8Array(),
      startOffset: endOffset, endOffset, isDelta: true }), 0, { cols: 10, rows: 5 })).toEqual(current);
  });

  it("keeps pane.read's full replay behavior when the cached size changes", async () => {
    const data = encoder.encode("ABCDEFGHIJK\rX");
    const original = { data, startOffset: 0, endOffset: data.length, sessionEpoch: 1, sizeRevision: 1 };
    await getHeadlessBufferLines("legacy", original, 80, { cols: 10, rows: 5 });
    expect(await getHeadlessBufferLines("legacy", { ...original, sizeRevision: 2 }, 80, { cols: 5, rows: 5 }))
      .toEqual(["ABCDEFGHIJX"]);
  });

  it.each([false, true])("matches a real browser Terminal and production headless replay (light=%s)", async light => {
    if (light) useThemeStore.getState().hydrateSettings({ themeId: "geppaku", themeTweaks: undefined });
    useSettingsStore.setState({ colorAdaptCommands: ["sample-cli"] });
    usePaneMetadataStore.setState({ volatileMetadata: { parity: { processTitle: "sample-cli" } } });
    const live = new LiveTerminal({ cols: 24, rows: 7, scrollback: 5000, allowProposedApi: true,
      theme: { ...useThemeStore.getState().theme.terminal, background: "rgba(30, 40, 50, 0)" } });
    live.loadAddon(new Unicode11Addon()); live.unicode.activeVersion = "11"; trackTerminalScreenState(live, () => live.options.theme);
    terminals.push(live); liveTerms.set("parity", live);
    const adapter = new LightDarkColorAdaptController(), rewriter = new SgrLightRewriter();
    const chunks = ["history\r\n".repeat(5), "  枠線 ┌───┐\r\n\r\n", "\x1b[38;2;230;", "220;210m日本Ae\u0301🧪Z\x1b[0m\r\n",
      "\x1b[2m dim \x1b[22m\x1b[48;5;25m  \x1b[0m\r\n", "abcdefghijklmnopqrstuvwxy\r\n\x1b[?25l"];
    for (const chunk of chunks) await write(live, rewriter.transform(adapter.transform(chunk, true), light));
    const data = encoder.encode(chunks.join(""));
    const snapshot = { data, startOffset: 0, endOffset: data.length, sessionEpoch: 1, sizeRevision: 1 };
    const replay = await readHeadlessBufferScreen("parity", async () => snapshot, 0, { cols: 24, rows: 7 });
    expect(replay).toEqual(getTerminalBufferScreen("parity", 0));
    expect(await getHeadlessBufferLines("parity", snapshot, 80, { cols: 24, rows: 7 })).toEqual(getTerminalBufferLines("parity", 80));
    live.scrollToLine(0);
    expect(await readHeadlessBufferScreen("parity", async () => snapshot, 2, { cols: 24, rows: 7 }))
      .toEqual(getTerminalBufferScreen("parity", 2));
  });

  it("uses the corrected current store palette for a cold headless screen", async () => {
    useThemeStore.getState().hydrateSettings({ themeId: "geppaku", themeTweaks: undefined });
    setEffectiveMediaActive(true);
    const data = encoder.encode("cold screen");
    const result = await readHeadlessBufferScreen("split", async () => ({ data, startOffset: 0, endOffset: data.length }), 0);
    expect(result.theme).toEqual(terminalScreenTheme(withAnsiContrastFloor(useThemeStore.getState().theme.terminal, true)));
  });

  it("preserves application OSC colors, resets and browser/headless theme parity", async () => {
    const base = useThemeStore.getState().theme.terminal;
    const live = new LiveTerminal({ cols: 20, rows: 5, allowProposedApi: true, theme: base });
    live.loadAddon(new Unicode11Addon()); live.unicode.activeVersion = "11";
    trackTerminalScreenState(live, () => live.options.theme); terminals.push(live); liveTerms.set("parity", live);
    let text = "\x1b]4;1;rgb:1111/2222/3333;201;#030201\x07\x1b]10;#abc;#010203;rgb:f/0/8\x07\x1b[38;5;201mcolor\x1b[0m";
    await write(live, text);
    const load = async () => { const data = encoder.encode(text); return { data, startOffset: 0, endOffset: data.length,
      sessionEpoch: 1, sizeRevision: 1 }; };
    const result = getTerminalBufferScreen("parity", 0);
    expect(result.theme).toMatchObject({ foreground: "#a0b0c0", background: "#010203", cursor: "#ff0088" });
    expect(result.theme.palette[1]).toBe("#112233");
    expect(result.lines[0][0][3]).toBe("#030201");
    expect(await readHeadlessBufferScreen("parity", load, 0, { cols: 20, rows: 5 })).toEqual(result);
    const reset = "\x1b]104;1\x07\x1b]110\x07\x1b]111\x07\x1b]112\x07";
    await write(live, reset); text += reset;
    expect(getTerminalBufferScreen("parity", 0).theme).toEqual(terminalScreenTheme(base));
    expect(await readHeadlessBufferScreen("parity", load, 0, { cols: 20, rows: 5 })).toEqual(getTerminalBufferScreen("parity", 0));
    await write(live, "\x1b]4;1;#112233\x07");
    live.options.theme = { ...base };
    resetTerminalScreenColors(live);
    expect(terminalScreenThemeFor(live, live.options.theme)).toEqual(terminalScreenTheme(base));
    live.options.theme = { ...base, foreground: "#123456" };
    expect(terminalScreenThemeFor(live, live.options.theme)).toEqual(terminalScreenTheme(live.options.theme));
  });

  it.each([256, 257, 258])("ignores OSC 104 palette reset outside 0..255 (%i)", async index => {
    const term = terminal();
    await write(term, "\x1b]4;1;#112233\x07\x1b]10;#010203;#040506;#070809\x07");
    const before = terminalScreenThemeFor(term);
    expect(before).toMatchObject({ foreground: "#010203", background: "#040506", cursor: "#070809" });
    await write(term, `\x1b]104;${index}\x07`);
    expect(terminalScreenThemeFor(term)).toEqual(before);
    await write(term, "\x1b]104;1\x07");
    expect(terminalScreenThemeFor(term).palette[1]).toBe(terminalScreenTheme().palette[1]);
  });

  it("clears cached OSC colors after the same live theme is reapplied with an empty delta", async () => {
    const base = useThemeStore.getState().theme.terminal;
    const live = new LiveTerminal({ cols: 20, rows: 5, allowProposedApi: true, theme: base });
    trackTerminalScreenState(live, () => live.options.theme, "parity"); terminals.push(live); liveTerms.set("parity", live);
    const text = "\x1b]4;1;#112233;201;#445566\x07\x1b]10;#010203\x07\x1b[38;5;201mcolor";
    const data = encoder.encode(text); await write(live, text);
    const original = { data, startOffset: 0, endOffset: data.length, sessionEpoch: 1, sizeRevision: 1 };
    expect(await readHeadlessBufferScreen("parity", async () => original, 0, { cols: 20, rows: 5 }))
      .toEqual(getTerminalBufferScreen("parity", 0));
    live.options.theme = { ...base }; resetTerminalScreenColors(live);
    const result = await readHeadlessBufferScreen("parity", async () => ({ ...original, data: new Uint8Array(),
      startOffset: data.length, isDelta: true }), 0, { cols: 20, rows: 5 });
    expect(result.theme).toEqual(terminalScreenTheme(base));
    expect(result).toEqual(getTerminalBufferScreen("parity", 0));
    expect(result.lines[0][0][3]).toBe(201);
  });

  it("keeps UTF-8 scalars and SGR sequences intact across incremental replies", async () => {
    const text = "  日本e\u0301🧪\x1b[38;2;12;34;56mOK\x1b[0m";
    const bytes = encoder.encode(text);
    let end = 0;
    for (const next of [4, 9, 16, bytes.length - 3, bytes.length]) {
      const start = end; end = next;
      await readHeadlessBufferScreen("split", async () => ({ data: bytes.slice(start, end), startOffset: start,
        endOffset: end, sessionEpoch: 1, sizeRevision: 1, isDelta: start > 0 }), 0);
    }
    const expected = terminal(80, 24); await write(expected, text);
    const result = await readHeadlessBufferScreen("split", async () => ({ data: new Uint8Array(), startOffset: end,
      endOffset: end, sessionEpoch: 1, sizeRevision: 1, isDelta: true }), 0);
    expect(result.lines).toEqual(screen(expected).lines);
  });

  it("keeps pane.read's trimmed nonempty logical lines after screen reads", async () => {
    const data = encoder.encode("  indented\r\n\r\n" + "w".repeat(90) + "\r\n\x1b[31m日本e\u0301😀\x1b[0m\r\nlast");
    const snapshot = { data, startOffset: 0, endOffset: data.length, sessionEpoch: 1, sizeRevision: 1 };
    const expected = ["indented", "w".repeat(90), "日本e\u0301😀", "last"];
    expect(await getHeadlessBufferLines("legacy", snapshot, 80)).toEqual(expected);
    await readHeadlessBufferScreen("legacy", async () => snapshot, 0);
    expect(await getHeadlessBufferLines("legacy", snapshot, 80)).toEqual(expected);
  });
});


describe("headless cache isolation", () => {
  const size = (cols: number) => ({ cols, rows: 5 });
  const snapshot = (sizeRevision: number) => {
    const data = encoder.encode("ABCDEFGHIJK\rX");
    return { data, startOffset: 0, endOffset: data.length, sessionEpoch: 1, sizeRevision };
  };

  it("(a) preserves pane.read after a narrower pane.screen read", async () => {
    await getHeadlessBufferLines("legacy", snapshot(1), 80, size(10));
    const expected = await readHeadlessBufferLines("legacy", async () => snapshot(2), 80, size(5));
    expect(expected).toEqual(["ABCDEFGHIJX"]);

    await getHeadlessBufferLines("parity", snapshot(1), 80, size(10));
    await readHeadlessBufferScreen("parity", async () => snapshot(2), 0, size(5));
    expect(await readHeadlessBufferLines("parity", async () => snapshot(2), 80, size(5))).toEqual(expected);
  });

  it("(b) preserves pane.screen resize history across a narrower pane.read", async () => {
    await readHeadlessBufferScreen("parity", async () => snapshot(1), 0, size(10));
    const expected = await readHeadlessBufferScreen("parity", async () => snapshot(2), 0, size(5));

    await readHeadlessBufferScreen("legacy", async () => snapshot(1), 0, size(10));
    expect(await getHeadlessBufferLines("legacy", snapshot(2), 80, size(5))).toEqual(["ABCDEFGHIJX"]);
    expect(await readHeadlessBufferScreen("legacy", async () => snapshot(2), 0, size(5))).toEqual(expected);
  });

  it("(c) matches independent readers throughout a 10 to 5 to 10 round trip", async () => {
    await getHeadlessBufferLines("legacy", snapshot(1), 80, size(10));
    await readHeadlessBufferScreen("parity", async () => snapshot(1), 0, size(10));
    await getHeadlessBufferLines("split", snapshot(1), 80, size(10));
    await readHeadlessBufferScreen("split", async () => snapshot(1), 0, size(10));
    for (const [index, cols] of [5, 10].entries()) {
      const current = snapshot(index + 2);
      const lines = await getHeadlessBufferLines("legacy", current, 80, size(cols));
      const screenOnly = await readHeadlessBufferScreen("parity", async () => current, 0, size(cols));
      expect(await readHeadlessBufferScreen("split", async () => current, 0, size(cols))).toEqual(screenOnly);
      expect(await getHeadlessBufferLines("split", current, 80, size(cols))).toEqual(lines);
      expect(await readHeadlessBufferScreen("split", async () => current, 0, size(cols))).toEqual(screenOnly);
    }
  });

  it("(d) reuses each parser and its own delta cursor during same-size alternating reads", async () => {
    const writeSpy = vi.spyOn(HeadlessTerminal.prototype, "write");
    const data = encoder.encode("first second");
    let endOffset = 5;
    const loader = () => vi.fn(async (since?: ScrollbackCursor) => {
      const startOffset = since?.endOffset ?? 0;
      return { data: data.slice(startOffset, endOffset), startOffset, endOffset,
        sessionEpoch: 1, sizeRevision: 1, isDelta: since !== undefined };
    });
    const lineLoader = loader(), screenLoader = loader();
    expect(await readHeadlessBufferLines("legacy", lineLoader, 80, size(20))).toEqual(["first"]);
    await readHeadlessBufferScreen("legacy", screenLoader, 0, size(20));
    expect(lineLoader).toHaveBeenNthCalledWith(1, undefined);
    expect(screenLoader).toHaveBeenNthCalledWith(1, undefined);
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(__headlessBufferCacheSizeForTests()).toBe(2);

    endOffset = data.length;
    expect(await readHeadlessBufferLines("legacy", lineLoader, 80, size(20))).toEqual(["first second"]);
    const result = await readHeadlessBufferScreen("legacy", screenLoader, 0, size(20));
    expect(result.lines[0]).toEqual([
      [0, 1, "first", null, null, 0], [6, 1, "second", null, null, 0],
    ]);
    const oldCursor = { endOffset: 5, sessionEpoch: 1, sizeRevision: 1 };
    expect(lineLoader).toHaveBeenNthCalledWith(2, oldCursor);
    expect(screenLoader).toHaveBeenNthCalledWith(2, oldCursor);
    expect(writeSpy).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 3; i++) {
      expect(await readHeadlessBufferLines("legacy", lineLoader, 80, size(20))).toEqual(["first second"]);
      expect(await getHeadlessBufferLines("legacy", { data, startOffset: 0, endOffset,
        sessionEpoch: 1, sizeRevision: 1 }, 80, size(20))).toEqual(["first second"]);
      expect(await readHeadlessBufferScreen("legacy", screenLoader, 0, size(20))).toEqual(result);
    }
    const cursor = { endOffset, sessionEpoch: 1, sizeRevision: 1 };
    expect(lineLoader).toHaveBeenLastCalledWith(cursor);
    expect(screenLoader).toHaveBeenLastCalledWith(cursor);
    expect(writeSpy).toHaveBeenCalledTimes(4);
    expect(__headlessBufferCacheSizeForTests()).toBe(2);
  });

  it("(e) caps the combined line and screen LRU at twelve terminals", async () => {
    const disposeSpy = vi.spyOn(HeadlessTerminal.prototype, "dispose");
    const sessions = Array.from({ length: 7 }, (_, i) => `cache-${i}`);
    replacePtyReadOwners(owner, new Set(sessions));
    for (const [index, sessionId] of sessions.entries()) {
      await getHeadlessBufferLines(sessionId, snapshot(1), 80, size(10));
      await readHeadlessBufferScreen(sessionId, async () => snapshot(1), 0, size(10));
      expect(__headlessBufferCacheSizeForTests()).toBe(Math.min((index + 1) * 2, 12));
    }
    expect(disposeSpy).toHaveBeenCalledTimes(2);
    __resetHeadlessBufferCacheForTests();
    expect(__headlessBufferCacheSizeForTests()).toBe(0);
    expect(disposeSpy).toHaveBeenCalledTimes(14);
  });

  it.each(["reset", "generation change", "session end"])("(f) disposes both parsers on %s", async event => {
    const disposeSpy = vi.spyOn(HeadlessTerminal.prototype, "dispose");
    await getHeadlessBufferLines("legacy", snapshot(1), 80, size(10));
    await readHeadlessBufferScreen("legacy", async () => snapshot(1), 0, size(10));
    expect(__headlessBufferCacheSizeForTests()).toBe(2);
    if (event === "reset") __resetHeadlessBufferCacheForTests();
    else if (event === "generation change") invalidatePtyReads("legacy", true);
    else replacePtyReadOwners(owner, new Set());
    expect(__headlessBufferCacheSizeForTests()).toBe(0);
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });
});

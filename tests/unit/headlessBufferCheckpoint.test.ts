import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Published headless ESM has no adjacent declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import { resetTerminalScreenColors, trackTerminalScreenState } from "../../src/components/terminal/terminalScreenState";
import { useThemeStore } from "../../src/stores/themeStore";
import type { ScrollbackSnapshot } from "../../src/lib/ipc";
import { observePtyEpoch, replacePtyReadOwners } from "../../src/lib/ptyReadGeneration";
import {
  __headlessBufferStateForTests,
  __resetHeadlessBufferCacheForTests,
  getHeadlessBufferLines,
  readHeadlessBufferScreen,
} from "../../src/components/terminal/headlessBuffer";

const encoder = new TextEncoder();
const owner = Symbol("long-lived dialog sessions");
const sessionId = "effort-dialog";
const otherSessions = Array.from({ length: 13 }, (_, i) => `checkpoint-pressure-${i}`);
const sessionIds = new Set([sessionId, ...otherSessions]);
const capacity = 256 * 1024;
const expected = ["Effort level", "low", "xhigh", "Enter to confirm / Esc to cancel"];
const redraw = "\x1b[4;1H\x1b[38;2;175;135;255mxhigh\x1b[0m";

function snapshot(text: string, startOffset = 0, sessionEpoch = 1): ScrollbackSnapshot {
  const data = encoder.encode(text);
  return { data, startOffset, endOffset: startOffset + data.length,
    sessionEpoch, sizeRevision: 1, cols: 48, rows: 10 };
}

function dialog(alternate: boolean): ScrollbackSnapshot {
  return snapshot((alternate ? "\x1b[?1049h" : "") + "\x1b[2J\x1b[H"
    + "Effort level\x1b[3;1Hlow" + redraw
    + "\x1b[8;1HEnter to confirm / Esc to cancel\x1b[?25l");
}

/** A real 256 KiB PTY ring, deliberately starting inside an RGB SGR. */
function rolledDialog(first: ScrollbackSnapshot): ScrollbackSnapshot {
  const updates = encoder.encode(redraw.repeat(Math.ceil(capacity / redraw.length) + 4));
  const recording = new Uint8Array(first.data.length + updates.length);
  recording.set(first.data); recording.set(updates, first.data.length);
  const startOffset = first.data.length + 2 * redraw.length + redraw.indexOf("35;255m");
  const endOffset = startOffset + capacity;
  return { ...first, data: recording.slice(startOffset, endOffset), startOffset, endOffset };
}

type Reader = "lines" | "screen";
async function read(id: string, value: ScrollbackSnapshot, reader: Reader): Promise<string[]> {
  if (reader === "lines") return getHeadlessBufferLines(id, value, 40, Date.now());
  const screen = await readHeadlessBufferScreen(id, async () => value, 0);
  return screen.lines.map(row => {
    let text = "", end = 0;
    for (const [col, width, run] of row) {
      text += " ".repeat(Math.max(0, col - end)) + run;
      end = col + [...run].length * width;
    }
    return text.trim();
  }).filter(Boolean);
}

async function evictDialog(): Promise<void> {
  for (const id of otherSessions) await getHeadlessBufferLines(id, snapshot("other session"), 40, Date.now());
  expect(__headlessBufferStateForTests().entries.some(entry => entry.sessionId === sessionId)).toBe(false);
}

beforeEach(() => {
  __resetHeadlessBufferCacheForTests();
  replacePtyReadOwners(owner, sessionIds);
});
afterEach(() => {
  __resetHeadlessBufferCacheForTests();
  replacePtyReadOwners(owner, new Set());
});

describe("headless checkpoints for long-lived full-screen dialogs", () => {
  it.each(["lines", "screen"] as const)("keeps a normal-screen dialog after ring rollover and %s cache eviction", async reader => {
    const first = dialog(false);
    expect(await read(sessionId, first, reader)).toEqual(expected);
    await evictDialog();
    const rolled = rolledDialog(first);
    expect(rolled.data.length).toBe(capacity);
    expect(rolled.startOffset).toBeGreaterThan(first.endOffset);
    expect(new TextDecoder().decode(rolled.data.subarray(0, 7))).toBe("35;255m");
    expect(await read(sessionId, rolled, reader)).toEqual(expected);
  });

  it.each(["lines", "screen"] as const)("keeps an alternate-screen dialog after ring rollover and %s cache eviction", async reader => {
    const first = dialog(true);
    expect(await read(sessionId, first, reader)).toEqual(expected);
    await evictDialog();
    expect(await read(sessionId, rolledDialog(first), reader)).toEqual(expected);
    if (reader === "screen") {
      const screen = await readHeadlessBufferScreen(sessionId, async () => rolledDialog(first), 0);
      expect(screen.alternateScreen).toBe(true);
      expect(screen.cursor?.visible).toBe(false);
      expect(screen.lines[3]).toEqual([[0, 1, "xhigh", "#af87ff", null, 0]]);
    }
  });

  it.each(["lines", "screen"] as const)("retains the screen when the ring passes a resident %s parser", async reader => {
    const first = dialog(false);
    await read(sessionId, first, reader);
    expect(await read(sessionId, rolledDialog(first), reader)).toEqual(expected);
  });

  it.each(["lines", "screen"] as const)("does not print an orphaned escape suffix on a cold %s read", async reader => {
    expect(await read(sessionId, snapshot("35;255mgh\x1b[2;1Hready", 1000), reader)).toEqual(["ready"]);
  });

  it.each(["close", "epoch"] as const)("discards an evicted dialog on session %s", async event => {
    const first = dialog(true);
    await read(sessionId, first, "screen");
    await read(sessionId, first, "lines");
    await evictDialog();
    if (event === "close") {
      replacePtyReadOwners(owner, new Set(otherSessions));
      replacePtyReadOwners(owner, sessionIds);
    } else observePtyEpoch(sessionId, 2);
    const fresh = snapshot("\x1b[2;1Hnew process", first.endOffset + capacity, 2);
    expect(await read(sessionId, fresh, "lines")).toEqual(["new process"]);
    expect(await read(sessionId, fresh, "screen")).toEqual(["new process"]);
    const screen = await readHeadlessBufferScreen(sessionId, async () => fresh, 0);
    expect(screen.alternateScreen).toBe(false);
    expect(screen.cursor?.visible).toBe(true);
  });
});

describe("headless checkpoint state and resource bounds", () => {
  const streams = [
    { name: "UTF-8", prefix: "\x1b[2;1H日本Ae\u0301", partial: "🧪", suffix: "Z", utf8Cut: 2 },
    { name: "CSI", prefix: "\x1b[2;1H", partial: "\x1b[38;2;175;135;", suffix: "255mcolor\x1b[0m" },
    { name: "OSC", prefix: "", partial: "\x1b]4;1;#123", suffix: "456\x07\x1b[2;1H\x1b[31mcolor" },
    { name: "saved cursor and attributes", prefix: "\x1b[2;1H\x1b[1;38;5;3mA\x1b7\x1b[8;1H\x1b[0melsewhere", partial: "", suffix: "\x1b8B" },
    { name: "pending right-margin wrap", prefix: "X".repeat(48), partial: "", suffix: "Y" },
    { name: "soft-wrapped logical line", prefix: "W".repeat(60), partial: "", suffix: "Z" },
    { name: "active SGR", prefix: "\x1b[1;3;4;38;2;10;20;30mstyled", partial: "", suffix: " continuation" },
    { name: "colon RGB SGR", prefix: "\x1b[38:2::10:20:30mstyled", partial: "", suffix: " continuation" },
    { name: "saved cursor after scroll", prefix: "history\r\n".repeat(20) + "\x1b7" + "scroll\r\n".repeat(12), partial: "", suffix: "\x1b8restored" },
    { name: "alternate-screen exit", prefix: "normal text\x1b[?1049h\x1b[2;1Hdialog", partial: "", suffix: "\x1b[?1049l more" },
    { name: "scroll region and origin mode", prefix: "\x1b[3;7r\x1b[?6h\x1b[2;1Hregion", partial: "", suffix: "\r\nline\r\nline\r\nlast" },
    { name: "insert and wrap modes", prefix: "ABCDEFG\x1b[?7l\x1b[4h\x1b[1;2H", partial: "", suffix: "new" },
  ];

  it.each(streams)("matches uninterrupted screen replay across eviction with $name", async value => {
    replacePtyReadOwners(owner, new Set([...sessionIds, "reference"]));
    const before = "\x1b[2J\x1b[H" + value.prefix + value.partial;
    const full = snapshot(before + value.suffix);
    const cut = encoder.encode(before).length - (value.utf8Cut ?? 0);
    const first = { ...full, data: full.data.slice(0, cut), endOffset: cut };
    await readHeadlessBufferScreen(sessionId, async () => first, 0);
    await evictDialog();
    const actual = await readHeadlessBufferScreen(sessionId, async () => full, 0);
    const reference = await readHeadlessBufferScreen("reference", async () => full, 0);
    expect(actual).toEqual(reference);
  });

  it("caps checkpoint payloads and evicts the oldest checkpoint before keeping newer sessions", async () => {
    const pressure = Array.from({ length: 80 }, (_, i) => `bounded-${i}`);
    replacePtyReadOwners(owner, new Set([...sessionIds, ...pressure]));
    await read(sessionId, dialog(false), "lines");
    for (const id of pressure) await getHeadlessBufferLines(id, snapshot("small screen"), 40, Date.now());
    const state = __headlessBufferStateForTests();
    expect(state.entries).toHaveLength(12);
    expect(state.checkpoints).toHaveLength(64);
    expect(state.checkpoints.some(entry => entry.sessionId === sessionId)).toBe(false);
    expect(state.checkpoints.every(entry => entry.chars <= 128 * 1024)).toBe(true);
    replacePtyReadOwners(owner, new Set());
    expect(__headlessBufferStateForTests().checkpoints).toEqual([]);
  });

  it("does not retain an unbounded unfinished control string in a checkpoint", async () => {
    await read(sessionId, snapshot("title\x1b]0;" + "x".repeat(5000)), "lines");
    await evictDialog();
    expect(__headlessBufferStateForTests().checkpoints.some(entry => entry.sessionId === sessionId)).toBe(false);
  });

  it("keeps discarding orphaned bytes across polls until a safe boundary arrives", async () => {
    expect(await read(sessionId, snapshot("35;255m", 1000), "lines")).toEqual([]);
    expect(await read(sessionId, snapshot("35;255mgarbage", 1000), "lines")).toEqual([]);
    expect(await read(sessionId, snapshot("35;255mgarbage\x1b[2;1Hready", 1000), "lines")).toEqual(["ready"]);
  });

  it.each(["theme change", "OSC reset"] as const)("does not resurrect old application colors after %s while evicted", async event => {
    const originalTheme = useThemeStore.getState().theme;
    const base = await readHeadlessBufferScreen(sessionId, async () => snapshot("screen"), 0);
    const colored = snapshot("screen\x1b]10;#123456\x07\x1b]4;1;#654321\x07\x1b[2;1H\x1b[31mcolor");
    expect((await readHeadlessBufferScreen(sessionId, async () => colored, 0)).theme.foreground).toBe("#123456");
    await evictDialog();
    const Terminal = PublishedTerminal as typeof import("@xterm/headless").Terminal;
    const renderer = new Terminal({ allowProposedApi: true });
    try {
      if (event === "theme change") useThemeStore.setState({ theme: { ...originalTheme,
        terminal: { ...originalTheme.terminal, foreground: "#decafe" } } });
      else { trackTerminalScreenState(renderer, () => ({}), sessionId); resetTerminalScreenColors(renderer); }
      const restored = await readHeadlessBufferScreen(sessionId, async () => colored, 0);
      expect(restored.theme.foreground).toBe(event === "theme change" ? "#decafe" : base.theme.foreground);
      expect(restored.theme.palette[1]).toBe(base.theme.palette[1]);
    } finally { renderer.dispose(); useThemeStore.setState({ theme: originalTheme }); }
  });

  it("fences checkpoints when a read itself discovers a newer session epoch", async () => {
    const first = dialog(true);
    await read(sessionId, first, "screen");
    await evictDialog();
    const fresh = snapshot("\x1b[Hreplacement", first.endOffset + capacity, 2);
    await expect(read(sessionId, fresh, "screen")).rejects.toThrow("another generation");
    expect(__headlessBufferStateForTests().checkpoints.some(entry => entry.sessionId === sessionId)).toBe(false);
    expect(await read(sessionId, fresh, "screen")).toEqual(["replacement"]);
  });

  it("does not rewind a newer checkpoint when an older screen poll returns after eviction", async () => {
    const first = snapshot("original");
    await readHeadlessBufferScreen(sessionId, async () => first, 0);
    let release!: (value: ScrollbackSnapshot) => void;
    const pending = readHeadlessBufferScreen(sessionId, () => new Promise(resolve => { release = resolve; }), 0);
    const latest = snapshot("original\x1b[2;1Hlatest");
    const expectedScreen = await readHeadlessBufferScreen(sessionId, async () => latest, 0);
    await evictDialog();
    release(first);
    expect(await pending).toEqual(expectedScreen);
    expect(__headlessBufferStateForTests().entries.find(entry => entry.sessionId === sessionId)?.endOffset).toBe(latest.endOffset);
  });
});

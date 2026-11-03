import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error Published headless ESM has no adjacent declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { paneScreenSampleAnsi } from "../helpers/paneScreenSample";
import { snapshotTerminalScreen, terminalScreenTheme } from "../../src/components/terminal/terminalScreenSnapshot";
import { trackTerminalScreenState, terminalScreenCursorVisible } from "../../src/components/terminal/terminalScreenState";

const Terminal = PublishedTerminal as typeof import("@xterm/headless").Terminal;
const theme = terminalScreenTheme({ foreground: "#d4d4d4", background: "#1e1e1e", cursor: "#ffffff" });
const outputDirectory = new URL("../../.dispatch/out/", import.meta.url);
const measurements: object[] = [];

function measure(read: () => object, result: object, cols: number, rows: number, scrollbackLines = 0, scenario = "sample"): void {
  for (let i = 0; i < 100; i++) read();
  const samples: number[] = [];
  for (let i = 0; i < 1000; i++) { const start = performance.now(); read(); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  measurements.push({ scenario, cols, rows, scrollbackLines, iterations: samples.length,
    meanMs: samples.reduce((a, b) => a + b) / samples.length,
    p50Ms: samples[500], p95Ms: samples[950], maxMs: samples[samples.length - 1],
    jsonBytes: Buffer.byteLength(JSON.stringify(result)) });
  writeFileSync(new URL("pane-screen-benchmark.json", outputDirectory), JSON.stringify(measurements, null, 2) + "\n");
}

describe("reproducible pane.screen sample fixtures", () => {
  it.each([[62, 48], [120, 40]])("serializes the synthetic ANSI screen at %i x %i", async (cols, rows) => {
    const term = new Terminal({ cols, rows, allowProposedApi: true });
    term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = "11"; trackTerminalScreenState(term);
    try {
      await new Promise<void>(resolve => term.write(paneScreenSampleAnsi(cols, rows), resolve));
      const read = () => ({ sessionId: `pty-sample-${cols}x${rows}`, ...snapshotTerminalScreen(term, theme, {
        cursorVisible: terminalScreenCursorVisible(term),
      }) });
      const result = read();
      expect(result.lines).toHaveLength(rows); expect(result.scrollbackLines).toBe(0);
      expect(result.lines[3]).toEqual([]); expect(result.cursor).toEqual({ col: 2, row: rows - 2, visible: true });
      expect(result.lines.flat().some(run => run[1] === 2 && run[2].includes("読"))).toBe(true);
      expect(result.lines.flat().some(run => run[4] === "#2d4150" && run[2].trim() === "")).toBe(true);
      if (process.env.UPDATE_PANE_SCREEN_SAMPLES === "1") {
        mkdirSync(outputDirectory, { recursive: true });
        writeFileSync(new URL(`pane-screen-sample-${cols}x${rows}.json`, outputDirectory), JSON.stringify(result, null, 2) + "\n");
        measure(read, result, cols, rows);
      }
    } finally { term.dispose(); }
  });

  it.each([0, 500])("serializes diverse CJK cells with %i scrollback lines", async scrollbackLines => {
    const cols = 120, rows = 40;
    const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
    term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = "11";
    const text = Array.from({ length: rows + scrollbackLines }, (_, row) =>
      Array.from({ length: cols / 2 }, (_, col) => String.fromCharCode(0x4e00 + (row * cols / 2 + col) % 0x5200)).join(""))
      .join("\r\n");
    expect(new Set(Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2))).size).toBeGreaterThan(256);
    try {
      await new Promise<void>(resolve => term.write(text, resolve));
      const read = () => snapshotTerminalScreen(term, theme, { scrollback: scrollbackLines });
      const result = read();
      expect(result.scrollbackLines).toBe(scrollbackLines);
      expect(result.lines).toHaveLength(rows + scrollbackLines);
      expect(result.lines.every(line => line.length === 1 && line[0][1] === 2 && line[0][2].length === cols / 2)).toBe(true);
      if (process.env.UPDATE_PANE_SCREEN_SAMPLES === "1") {
        mkdirSync(outputDirectory, { recursive: true });
        measure(read, result, cols, rows, scrollbackLines, "diverse-cjk");
      }
    } finally { term.dispose(); }
  });
});

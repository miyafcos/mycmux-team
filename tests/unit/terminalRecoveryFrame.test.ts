import { describe, expect, it } from "vitest";
// @ts-expect-error The published ESM entry has no colocated declarations.
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import { buildTerminalRecoveryFrame } from "../../src/components/terminal/terminalRecoveryFrame";
import { planTerminalScrollbackRecovery, sliceBatchAfterScrollbackOffset } from "../../src/components/terminal/terminalCache";
const write = (term: any, text: string | Uint8Array) => new Promise<void>(resolve => term.write(text, resolve));
const lines = (term: any) => Array.from({ length: term.buffer.active.length }, (_, n) => term.buffer.active.getLine(n).translateToString(true));

describe("offscreen recovery of a truncated PTY ring", () => {
  it("replaces a stale screen after a greater-than-256KB gap without missing or duplicated retained rows", async () => {
    const complete = new TextEncoder().encode(Array.from({ length: 5000 }, (_, n) => `LINE ${String(n).padStart(5, "0")} ${"x".repeat(60)}\r\n`).join(""));
    const start = complete.length - 256 * 1024; const ring = complete.slice(start);
    const plan = planTerminalScrollbackRecovery(ring, start, complete.length, 10, new Uint8Array([1, 2]));
    expect(plan.action).toBe("rebuild-truncated");
    const rebuilt = await buildTerminalRecoveryFrame(plan.data, start, 80, 24);
    const expected = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    const restored = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    try {
      await write(expected, complete); await write(restored, "stale screen"); restored.reset(); await write(restored, rebuilt.text);
      expect(lines(restored).slice(-40)).toEqual(lines(expected).slice(-40));
      const ids = lines(restored).filter((line: string) => line.startsWith("LINE ")).map((line: string) => Number(line.slice(5, 10)));
      expect(ids.at(-1)).toBe(4999); expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id: number, n: number) => n === 0 || id === ids[n - 1] + 1)).toBe(true);
      const delta = new TextEncoder().encode("NEXT\r\n");
      const batch = { generation: 2, seq: 1, bytes: delta.length + 2, resync: false,
        scrollbackStart: complete.length - 2, scrollbackEnd: complete.length + delta.length,
        data: new Uint8Array([13, 10, ...delta]) };
      await write(restored, rebuilt.decoder.decode(sliceBatchAfterScrollbackOffset(batch, batch.data, complete.length), { stream: true }));
      expect(lines(restored).filter((line: string) => line === "NEXT")).toHaveLength(1);
    } finally { expected.dispose(); restored.dispose(); }
  });
  it("preserves pending wrap and streaming UTF-8 at the ring boundary", async () => {
    const prepared = await buildTerminalRecoveryFrame(new TextEncoder().encode("1234567890"), 0, 10, 3);
    const term = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });
    try {
      await write(term, prepared.text); await write(term, "NEXT");
      expect(term.buffer.active.getLine(0).translateToString(true)).toBe("1234567890");
      expect(term.buffer.active.getLine(1).translateToString(true)).toBe("NEXT");
      const full = new TextEncoder().encode("before\r\n\u65e5");
      const partial = await buildTerminalRecoveryFrame(full.slice(0, -1), 0, 10, 3);
      term.reset(); await write(term, partial.text);
      await write(term, partial.decoder.decode(full.slice(-1), { stream: true }));
      expect(lines(term).join("\n")).toContain("\u65e5");
      expect(lines(term).join("\n")).not.toContain("\ufffd");
    } finally { term.dispose(); }
  });
  it("preserves alternate-screen geometry, styles, cursor and common TUI modes", async () => {
    const text = "partial\r\n\x1b[?1049h\x1b[2J\x1b[H\x1b[1;38;2;10;20;30mTUI\x1b[0m\x1b[5;8Hcursor\x1b[?2004h\x1b[?1h";
    const prepared = await buildTerminalRecoveryFrame(new TextEncoder().encode(text), 100, 40, 10);
    const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    try {
      await write(term, prepared.text);
      expect(term.buffer.active.type).toBe("alternate"); expect(term.buffer.active.getLine(0).translateToString(true)).toBe("TUI");
      expect(term.buffer.active.getLine(0).getCell(0).isBold()).not.toBe(0);
      expect(term.buffer.active.getLine(0).getCell(0).getFgColor()).toBe(0x0a141e);
      expect(term.buffer.active.cursorY).toBe(4); expect(term.buffer.active.cursorX).toBe(13);
      expect(term.modes.bracketedPasteMode).toBe(true); expect(term.modes.applicationCursorKeysMode).toBe(true);
    } finally { term.dispose(); }
  });
});

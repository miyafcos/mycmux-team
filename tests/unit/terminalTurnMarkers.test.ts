import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error @xterm/headless@6.0.0 publishes this ESM file without colocated declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import type { Terminal } from "@xterm/xterm";

import {
  evictTerminalCache,
  liveTerms,
  pruneTurnMarks,
  termCache,
  terminalTurnMarks,
} from "../../src/components/terminal/terminalCache";
import {
  clearTurnMarks,
  getTurnMarkData,
  noteRestoreBoundaryTurn,
  noteTurnInput,
  noteTurnSubmit,
  reanchorTurnMarks,
  RESTORE_BOUNDARY_LABEL,
  snapshotTurnMarksForReset,
} from "../../src/components/terminal/terminalTurnMarkers";

type HeadlessTerminalConstructor = typeof import("@xterm/headless").Terminal;
type HeadlessTerminal = InstanceType<HeadlessTerminalConstructor>;

const Terminal = PublishedTerminal as HeadlessTerminalConstructor;

function write(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, resolve);
  });
}

function attach(sessionId: string, options?: { cols?: number; rows?: number; scrollback?: number }) {
  const term = new Terminal({
    cols: options?.cols ?? 20,
    rows: options?.rows ?? 8,
    scrollback: options?.scrollback ?? 50,
    allowProposedApi: true,
  });
  liveTerms.set(sessionId, term as unknown as Terminal);
  return term;
}

afterEach(() => {
  for (const sessionId of [...terminalTurnMarks.keys()]) {
    clearTurnMarks(sessionId);
  }
  for (const term of liveTerms.values()) {
    term.dispose();
  }
  liveTerms.clear();
  termCache.clear();
});

describe("terminal turn markers", () => {
  it("places the marker on a later line after Japanese wrap", async () => {
    const sessionId = "wrap-ja";
    const term = attach(sessionId, { cols: 10, rows: 6, scrollback: 20 });
    await write(term, "日本語の折り返しを起こすための長い文章です");
    noteTurnSubmit(sessionId, "折り返し後", 1_000);
    const marks = getTurnMarkData(sessionId);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.line).toBeGreaterThan(0);
    expect(marks[0]?.label).toBe("折り返し後");
  });

  it("drops marks whose buffer line was trimmed by scrollback overflow", async () => {
    const sessionId = "overflow";
    const term = attach(sessionId, { cols: 20, rows: 4, scrollback: 2 });
    await write(term, "keep\r\n");
    noteTurnSubmit(sessionId, "oldest-turn", 1_000);
    expect(getTurnMarkData(sessionId)).toHaveLength(1);
    for (let index = 0; index < 12; index += 1) {
      await write(term, `overflow-${index}\r\n`);
    }
    expect(pruneTurnMarks(sessionId)).toHaveLength(0);
    expect(getTurnMarkData(sessionId)).toEqual([]);
  });

  it("disposes the oldest mark when the 201st is recorded", async () => {
    const sessionId = "cap";
    const term = attach(sessionId, { cols: 40, rows: 10, scrollback: 400 });
    for (let index = 0; index < 201; index += 1) {
      await write(term, `turn-${index}\r\n`);
      noteTurnSubmit(sessionId, `turn-label-${index}`, 1_000 + index * 300);
    }
    const marks = getTurnMarkData(sessionId);
    expect(marks).toHaveLength(200);
    expect(marks[0]?.label).toBe("turn-label-1");
    expect(marks[199]?.label).toBe("turn-label-200");
  });

  it("does not register a mark after entering the alternate screen", async () => {
    const sessionId = "alt";
    const term = attach(sessionId, { cols: 20, rows: 8, scrollback: 20 });
    await write(term, "before\r\n");
    noteTurnSubmit(sessionId, "normal-turn", 1_000);
    expect(getTurnMarkData(sessionId)).toHaveLength(1);
    await write(term, "\x1b[?1049h");
    expect(term.buffer.active.type).toBe("alternate");
    noteTurnSubmit(sessionId, "alt-turn", 2_000);
    expect(getTurnMarkData(sessionId)).toHaveLength(1);
    expect(getTurnMarkData(sessionId)[0]?.label).toBe("normal-turn");
  });

  it("does not mark a fake turn for DA plus a bare enter", async () => {
    const sessionId = "fake-turn";
    attach(sessionId);
    noteTurnInput(sessionId, "\x1b[?1;2c\r");
    expect(getTurnMarkData(sessionId)).toHaveLength(0);
  });

  it("labels the next real submit after a focus report", async () => {
    const sessionId = "after-focus";
    attach(sessionId);
    noteTurnInput(sessionId, "\x1b[O");
    noteTurnInput(sessionId, "こんにちは\r");
    const marks = getTurnMarkData(sessionId);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.label).toBe("こんにちは");
  });

  it("joins a split DA sequence into the typed label", async () => {
    const sessionId = "split-da";
    attach(sessionId);
    noteTurnInput(sessionId, "a\x1b[");
    noteTurnInput(sessionId, "?1;2cb\r");
    expect(getTurnMarkData(sessionId)).toHaveLength(1);
    expect(getTurnMarkData(sessionId)[0]?.label).toBe("ab");
  });

  it("counts a bracketed paste as a single turn", async () => {
    const sessionId = "paste";
    attach(sessionId);
    noteTurnInput(sessionId, "\x1b[200~一行目\r二行目\x1b[201~\r");
    const marks = getTurnMarkData(sessionId);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.label).toBe("一行目 二行目");
  });

  it("clears marks when the session cache is evicted", async () => {
    const sessionId = "evict";
    const term = attach(sessionId);
    await write(term, "cached\r\n");
    noteTurnSubmit(sessionId, "will-evict", 1_000);
    expect(getTurnMarkData(sessionId)).toHaveLength(1);
    evictTerminalCache(sessionId);
    expect(terminalTurnMarks.has(sessionId)).toBe(false);
  });

  it("reanchors marks after reset and identical rewrite", async () => {
    const sessionId = "reanchor-same";
    const term = attach(sessionId, { cols: 20, rows: 8, scrollback: 50 });
    await write(term, "line-a\r\n");
    noteTurnSubmit(sessionId, "turn-a", 1_000);
    await write(term, "line-b\r\n");
    noteTurnSubmit(sessionId, "turn-b", 2_000);
    await write(term, "line-c\r\n");
    noteTurnSubmit(sessionId, "turn-c", 3_000);
    const before = getTurnMarkData(sessionId);
    expect(before).toHaveLength(3);
    const asTerm = term as unknown as Terminal;

    snapshotTurnMarksForReset(sessionId, asTerm);
    term.reset();
    await write(term, "line-a\r\n");
    await write(term, "line-b\r\n");
    await write(term, "line-c\r\n");
    reanchorTurnMarks(sessionId, asTerm);

    const after = getTurnMarkData(sessionId);
    expect(after.map((mark) => mark.label)).toEqual(before.map((mark) => mark.label));
    expect(after.map((mark) => mark.line)).toEqual(before.map((mark) => mark.line));
  });

  it("drops marks that fall outside the rewritten buffer", async () => {
    const sessionId = "reanchor-short";
    const term = attach(sessionId, { cols: 20, rows: 4, scrollback: 50 });
    await write(term, "keep-early\r\n");
    noteTurnSubmit(sessionId, "oldest-turn", 1_000);
    for (let index = 0; index < 20; index += 1) {
      await write(term, `fill-${index}\r\n`);
    }
    noteTurnSubmit(sessionId, "newest-turn", 2_000);
    expect(getTurnMarkData(sessionId).map((mark) => mark.label)).toEqual([
      "oldest-turn",
      "newest-turn",
    ]);
    const asTerm = term as unknown as Terminal;

    snapshotTurnMarksForReset(sessionId, asTerm);
    term.reset();
    await write(term, "x");
    reanchorTurnMarks(sessionId, asTerm);

    const after = getTurnMarkData(sessionId);
    expect(after.some((mark) => mark.label === "oldest-turn")).toBe(false);
  });

  it("is a no-op when reanchor runs without a snapshot", async () => {
    const sessionId = "reanchor-none";
    const term = attach(sessionId);
    await write(term, "plain\r\n");
    expect(() => reanchorTurnMarks(sessionId, term as unknown as Terminal)).not.toThrow();
    expect(getTurnMarkData(sessionId)).toEqual([]);
  });

  it("does not keep a reset snapshot after session eviction", async () => {
    const sessionId = "evict-snapshot";
    const term = attach(sessionId);
    await write(term, "cached\r\n");
    noteTurnSubmit(sessionId, "will-evict", 1_000);
    snapshotTurnMarksForReset(sessionId, term as unknown as Terminal);
    evictTerminalCache(sessionId);
    reanchorTurnMarks(sessionId, term as unknown as Terminal);
    expect(getTurnMarkData(sessionId)).toEqual([]);
    expect(terminalTurnMarks.has(sessionId)).toBe(false);
  });

  it("registers a restore-boundary turn after initial replay", async () => {
    const sessionId = "restore-boundary";
    const term = attach(sessionId);
    await write(term, "old history line 1\r\nold history line 2");
    noteRestoreBoundaryTurn(sessionId, 1_000);
    const marks = getTurnMarkData(sessionId);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.label).toBe(RESTORE_BOUNDARY_LABEL);
  });
});

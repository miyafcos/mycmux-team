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
  noteTurnSubmit,
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

  it("clears marks when the session cache is evicted", async () => {
    const sessionId = "evict";
    const term = attach(sessionId);
    await write(term, "cached\r\n");
    noteTurnSubmit(sessionId, "will-evict", 1_000);
    expect(getTurnMarkData(sessionId)).toHaveLength(1);
    evictTerminalCache(sessionId);
    expect(terminalTurnMarks.has(sessionId)).toBe(false);
  });
});

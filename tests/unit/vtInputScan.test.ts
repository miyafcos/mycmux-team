import { describe, expect, it } from "vitest";

import { scanVtInput, stripVtSequences, type VtInputScanState } from "../../src/lib/vtInputScan";
import { VT_SCAN_VECTORS } from "./vtScanVectors";

function fresh(): VtInputScanState {
  return { pending: "", inPaste: false };
}

function textOf(input: string, state: VtInputScanState = fresh()): string {
  return scanVtInput(input, state)
    .filter((token) => token.kind === "text")
    .map((token) => token.value)
    .join("");
}

function sequencesOf(input: string, state: VtInputScanState = fresh()) {
  return scanVtInput(input, state).filter((token) => token.kind === "sequence");
}

function sequenceBounds(input: string): Array<[number, number]> {
  const state = fresh();
  const tokens = scanVtInput(input, state);
  expect(state.pending).toBe("");
  const bounds: Array<[number, number]> = [];
  let cursor = 0;
  for (const token of tokens) {
    expect(input.slice(cursor, cursor + token.value.length)).toBe(token.value);
    if (token.kind === "sequence") bounds.push([cursor, cursor + token.value.length]);
    cursor += token.value.length;
  }
  expect(cursor).toBe(input.length);
  return bounds;
}

describe("scanVtInput replies", () => {
  it("classifies DA / CPR / DSR / focus as neutral with no leftover text", () => {
    for (const input of ["\x1b[?1;2c", "\x1b[>0;10;1c", "\x1b[24;1R", "\x1b[?1;0n", "\x1b[I", "\x1b[O"]) {
      const state = fresh();
      const sequences = sequencesOf(input, state);
      expect(sequences, input).toEqual([{ kind: "sequence", value: input, effect: "neutral" }]);
      expect(textOf(input, fresh())).toBe("");
      expect(state.pending).toBe("");
    }
  });

  it("classifies OSC (BEL and ST) and DCS replies as neutral", () => {
    const samples = [
      "\x1b]11;rgb:00/00/00\x07",
      "\x1b]11;rgb:00/00/00\x1b\\",
      "\x1bP1$r0;1;0;0m\x1b\\",
      "\x1bP>|xterm\x1b\\",
    ];
    for (const input of samples) {
      expect(sequencesOf(input)).toEqual([{ kind: "sequence", value: input, effect: "neutral" }]);
      expect(textOf(input)).toBe("");
    }
  });

  it("classifies arrows, delete, SS3, and Alt-meta as unmodelled", () => {
    expect(sequencesOf("\x1b[D")).toEqual([{ kind: "sequence", value: "\x1b[D", effect: "unmodelled" }]);
    expect(sequencesOf("\x1b[3~")).toEqual([{ kind: "sequence", value: "\x1b[3~", effect: "unmodelled" }]);
    expect(sequencesOf("\x1bOA")).toEqual([{ kind: "sequence", value: "\x1bOA", effect: "unmodelled" }]);
    expect(textOf("\x1bOA")).toBe("");
    expect(sequencesOf("\x1bb")).toEqual([{ kind: "sequence", value: "\x1bb", effect: "unmodelled" }]);
    expect(textOf("\x1bb")).toBe("");
  });
});

describe("scanVtInput streaming", () => {
  it("reassembles a DA sequence split after CSI introducer", () => {
    const state = fresh();
    expect(textOf("a\x1b[", state)).toBe("a");
    expect(state.pending).toBe("\x1b[");
    expect(textOf("?1;2cb", state)).toBe("b");
    expect(state.pending).toBe("");
  });

  it("reassembles focus-out split after CSI introducer", () => {
    const state = fresh();
    expect(sequencesOf("\x1b[", state)).toEqual([]);
    expect(state.pending).toBe("\x1b[");
    expect(sequencesOf("O", state)).toEqual([{ kind: "sequence", value: "\x1b[O", effect: "neutral" }]);
    expect(textOf("", state)).toBe("");
  });

  it("reassembles focus-out when ESC was the tail of a longer chunk", () => {
    const state = fresh();
    expect(textOf("x\x1b", state)).toBe("x");
    expect(state.pending).toBe("\x1b");
    expect(sequencesOf("[O", state)).toEqual([{ kind: "sequence", value: "\x1b[O", effect: "neutral" }]);
    expect(textOf("", state)).toBe("");
  });

  it("reassembles OSC 11 split across the payload", () => {
    const state = fresh();
    expect(textOf("\x1b]11;rgb:", state)).toBe("");
    expect(state.pending).toBe("\x1b]11;rgb:");
    expect(sequencesOf("00/00/00\x07", state)).toEqual([
      { kind: "sequence", value: "\x1b]11;rgb:00/00/00\x07", effect: "neutral" },
    ]);
  });

  it("treats a lone ESC chunk as unmodelled so the next key is not swallowed", () => {
    const state = fresh();
    expect(sequencesOf("\x1b", state)).toEqual([{ kind: "sequence", value: "\x1b", effect: "unmodelled" }]);
    expect(state.pending).toBe("");
    expect(textOf("a", state)).toBe("a");
  });

  it("drops a pending sequence longer than 32 characters as unmodelled", () => {
    const state = fresh();
    const tokens = scanVtInput(`\x1b]${"x".repeat(40)}`, state);
    expect(state.pending).toBe("");
    expect(tokens).toEqual([
      { kind: "sequence", value: `\x1b]${"x".repeat(40)}`, effect: "unmodelled" },
    ]);
  });

  it("aborts an incomplete CSI when Enter arrives, so CR stays a submit", () => {
    const state = fresh();
    expect(textOf("\x1b[", state)).toBe("");
    const tokens = scanVtInput("\r", state);
    expect(state.pending).toBe("");
    expect(tokens).toEqual([
      { kind: "sequence", value: "\x1b[", effect: "unmodelled" },
      { kind: "text", value: "\r" },
    ]);
  });
});

describe("scanVtInput text integrity", () => {
  it("keeps Japanese and emoji intact in text tokens", () => {
    const sample = "こんにちは🐙";
    const state = fresh();
    const tokens = scanVtInput(sample, state);
    expect(tokens).toEqual([{ kind: "text", value: sample }]);
    expect(stripVtSequences(`\x1b[?1;2c${sample}\x1b[O`)).toBe(sample);
  });

  it("tracks bracketed paste across chunks", () => {
    const state = fresh();
    scanVtInput("\x1b[200~", state);
    expect(state.inPaste).toBe(true);
    expect(textOf("hello", state)).toBe("hello");
    expect(state.inPaste).toBe(true);
    scanVtInput("\x1b[201~", state);
    expect(state.inPaste).toBe(false);
  });
});

describe("shared vt sequence vectors", () => {
  it("agrees with the shared boundary table", () => {
    for (const vector of VT_SCAN_VECTORS) {
      expect(sequenceBounds(vector.input), vector.name).toEqual(vector.sequences);
    }
  });
});

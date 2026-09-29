/**
 * Splits xterm/PTY input into printable text and ESC-originated sequences.
 *
 * Boundary detection is a copy of LightDarkColorAdapt.transform (CSI / OSC /
 * DCS / 2-byte Fe), not a shared helper: that path is a PTY-output hot loop
 * that returns a rewritten string, and tokenizing it would add allocations
 * on every chunk. Input is a few bytes per keystroke.
 *
 * `effect` is input-specific. Neutral sequences are terminal→host replies
 * and paste framing: drop them without dirtying the line draft. Everything
 * else is unmodelled (cursor keys, Alt-meta, …) so erase-line stays blind.
 */

export type VtInputToken =
  | { kind: "text"; value: string }
  | { kind: "sequence"; value: string; effect: "neutral" | "unmodelled" };

export interface VtInputScanState {
  pending: string;
  inPaste: boolean;
}

const ESC = "\u001b";
const MAX_PENDING = 32;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function scanVtInput(input: string, state: VtInputScanState): VtInputToken[] {
  const tokens: VtInputToken[] = [];

  // Esc as its own chunk is a keypress. Holding it would let the next key
  // complete a 2-byte Fe sequence (Alt-meta) and swallow the character.
  if (input.length === 1 && input === ESC && state.pending === "") {
    tokens.push({ kind: "sequence", value: ESC, effect: "unmodelled" });
    return tokens;
  }

  const combined = state.pending + input;
  state.pending = "";
  let cursor = 0;

  while (cursor < combined.length) {
    const escape = combined.indexOf(ESC, cursor);
    if (escape === -1) {
      pushText(tokens, combined.slice(cursor));
      return tokens;
    }
    if (escape > cursor) {
      pushText(tokens, combined.slice(cursor, escape));
    }
    if (escape + 1 === combined.length) {
      return holdOrOverflow(state, tokens, combined.slice(escape));
    }

    const controlType = combined[escape + 1];
    if (controlType === "[") {
      const csi = takeCsi(combined, escape);
      if (csi.kind === "hold") return holdOrOverflow(state, tokens, combined.slice(escape));
      if (csi.kind === "abort") {
        tokens.push({ kind: "sequence", value: csi.value, effect: "unmodelled" });
        cursor = csi.end;
        continue;
      }
      if (csi.value === PASTE_START) state.inPaste = true;
      else if (csi.value === PASTE_END) state.inPaste = false;
      tokens.push({ kind: "sequence", value: csi.value, effect: classifyCsi(csi.value, csi.params, csi.final) });
      cursor = csi.end;
      continue;
    }

    if (controlType === "]") {
      const osc = takeTerminated(combined, escape, "osc");
      if (osc.kind === "hold") return holdOrOverflow(state, tokens, combined.slice(escape));
      if (osc.kind === "abort") {
        tokens.push({ kind: "sequence", value: osc.value, effect: "unmodelled" });
        cursor = osc.end;
        continue;
      }
      tokens.push({ kind: "sequence", value: osc.value, effect: "neutral" });
      cursor = osc.end;
      continue;
    }

    if (controlType === "P" || controlType === "X" || controlType === "^" || controlType === "_") {
      const stringSeq = takeTerminated(combined, escape, "dcs");
      if (stringSeq.kind === "hold") return holdOrOverflow(state, tokens, combined.slice(escape));
      if (stringSeq.kind === "abort") {
        tokens.push({ kind: "sequence", value: stringSeq.value, effect: "unmodelled" });
        cursor = stringSeq.end;
        continue;
      }
      tokens.push({ kind: "sequence", value: stringSeq.value, effect: "neutral" });
      cursor = stringSeq.end;
      continue;
    }

    // SS3 is ESC O + a final byte (arrows, Home/End, F1–F4). Consuming only
    // two bytes would leak the final as text ("A" from up-arrow).
    if (controlType === "O") {
      if (escape + 2 >= combined.length) {
        return holdOrOverflow(state, tokens, combined.slice(escape));
      }
      const third = combined.charCodeAt(escape + 2);
      if (isLineEnding(third)) {
        tokens.push({ kind: "sequence", value: combined.slice(escape, escape + 2), effect: "unmodelled" });
        cursor = escape + 2;
        continue;
      }
      tokens.push({
        kind: "sequence",
        value: combined.slice(escape, escape + 3),
        effect: "unmodelled",
      });
      cursor = escape + 3;
      continue;
    }

    tokens.push({
      kind: "sequence",
      value: combined.slice(escape, escape + 2),
      effect: "unmodelled",
    });
    cursor = escape + 2;
  }

  return tokens;
}

/** Stateless cleanup for labels and recent-input mirrors. Drops a trailing incomplete sequence. */
export function stripVtSequences(value: string): string {
  const state: VtInputScanState = { pending: "", inPaste: false };
  const tokens = scanVtInput(value, state);
  let text = "";
  for (const token of tokens) {
    if (token.kind === "text") text += token.value;
  }
  return text;
}

function pushText(tokens: VtInputToken[], value: string): void {
  if (value.length === 0) return;
  tokens.push({ kind: "text", value });
}

function holdOrOverflow(
  state: VtInputScanState,
  tokens: VtInputToken[],
  leftover: string,
): VtInputToken[] {
  if (leftover.length > MAX_PENDING) {
    tokens.push({ kind: "sequence", value: leftover, effect: "unmodelled" });
    state.pending = "";
    return tokens;
  }
  state.pending = leftover;
  return tokens;
}

function isLineEnding(code: number): boolean {
  return code === 0x0a || code === 0x0d;
}

type Taken =
  | { kind: "complete"; value: string; end: number; params: string; final: string }
  | { kind: "hold" }
  | { kind: "abort"; value: string; end: number };

function takeCsi(input: string, escape: number): Taken {
  let end = escape + 2;
  while (end < input.length) {
    const code = input.charCodeAt(end);
    if (code >= 0x40 && code <= 0x7e) break;
    if (isLineEnding(code)) {
      return { kind: "abort", value: input.slice(escape, end), end };
    }
    end += 1;
  }
  if (end === input.length) return { kind: "hold" };

  const final = input[end] ?? "";
  const params = input.slice(escape + 2, end);
  let seqEnd = end + 1;
  // X10 mouse: CSI M with no parameters, then three 8-bit payload bytes.
  if (final === "M" && params.length === 0) {
    if (end + 4 > input.length) return { kind: "hold" };
    seqEnd = end + 4;
  }
  return { kind: "complete", value: input.slice(escape, seqEnd), end: seqEnd, params, final };
}

function takeTerminated(input: string, escape: number, mode: "osc" | "dcs"): Taken {
  if (mode === "dcs") {
    let index = escape + 2;
    while (index < input.length) {
      const code = input.charCodeAt(index);
      if (isLineEnding(code)) {
        return { kind: "abort", value: input.slice(escape, index), end: index };
      }
      if (input[index] === ESC && input[index + 1] === "\\") {
        return {
          kind: "complete",
          value: input.slice(escape, index + 2),
          end: index + 2,
          params: "",
          final: "",
        };
      }
      index += 1;
    }
    return { kind: "hold" };
  }

  let end = escape + 2;
  while (end < input.length) {
    const code = input.charCodeAt(end);
    if (code === 0x07) {
      return {
        kind: "complete",
        value: input.slice(escape, end + 1),
        end: end + 1,
        params: "",
        final: "",
      };
    }
    if (input[end] === ESC && input[end + 1] === "\\") {
      return {
        kind: "complete",
        value: input.slice(escape, end + 2),
        end: end + 2,
        params: "",
        final: "",
      };
    }
    if (isLineEnding(code)) {
      return { kind: "abort", value: input.slice(escape, end), end };
    }
    end += 1;
  }
  return { kind: "hold" };
}

function classifyCsi(sequence: string, params: string, final: string): "neutral" | "unmodelled" {
  if (final === "~" && (params === "200" || params === "201")) return "neutral";
  if ((final === "I" || final === "O") && params === "") return "neutral";

  const prefix = params.charAt(0);
  const privatePrefix = prefix === "?" || prefix === ">" || prefix === "=";
  if (privatePrefix && final === "c") return "neutral";
  if (final === "R") return "neutral";
  if (prefix === "?" && final === "n") return "neutral";
  if (prefix === "?" && final === "y" && params.includes("$")) return "neutral";
  if (final === "t") return "neutral";

  if (prefix === "<" && (final === "M" || final === "m")) return "neutral";
  if (final === "M") {
    if (params.length === 0 && sequence.length === 6) return "neutral";
    if (/^[0-9;]+$/.test(params)) return "neutral";
  }

  return "unmodelled";
}

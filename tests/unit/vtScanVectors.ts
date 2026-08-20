/**
 * Shared ESC-sequence boundary table.
 *
 * Both scanners (vtInputScan and LightDarkColorAdapt) copy the same CSI / OSC /
 * DCS / 2-byte Fe rules. Keeping the expected spans in one place stops the
 * copies from drifting. SS3 3-byte consumption and X10 mouse extra bytes are
 * input-scanner specific and live only in vtInputScan.test.ts.
 */

export interface VtScanVector {
  name: string;
  input: string;
  /** [start, end) of each complete ESC-originated sequence. */
  sequences: Array<[number, number]>;
}

function bounds(input: string, sequences: string[]): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  let from = 0;
  for (const sequence of sequences) {
    const start = input.indexOf(sequence, from);
    if (start < 0) {
      throw new Error(`vtScanVectors: ${JSON.stringify(sequence)} missing in ${JSON.stringify(input)}`);
    }
    result.push([start, start + sequence.length]);
    from = start + sequence.length;
  }
  return result;
}

function vector(name: string, input: string, sequences: string[]): VtScanVector {
  return { name, input, sequences: bounds(input, sequences) };
}

export const VT_SCAN_VECTORS: VtScanVector[] = [
  vector("da1", "\x1b[?1;2c", ["\x1b[?1;2c"]),
  vector("da2", "\x1b[>0;10;1c", ["\x1b[>0;10;1c"]),
  vector("cpr", "\x1b[24;1R", ["\x1b[24;1R"]),
  vector("dsr", "\x1b[?1;0n", ["\x1b[?1;0n"]),
  vector("focus-in", "\x1b[I", ["\x1b[I"]),
  vector("focus-out", "\x1b[O", ["\x1b[O"]),
  vector("focus-pair", "\x1b[O\x1b[I", ["\x1b[O", "\x1b[I"]),
  vector("osc-bel", "\x1b]11;rgb:00/00/00\x07", ["\x1b]11;rgb:00/00/00\x07"]),
  vector("osc-st", "\x1b]11;rgb:00/00/00\x1b\\", ["\x1b]11;rgb:00/00/00\x1b\\"]),
  vector("dcs-xtversion", "\x1bP>|xterm\x1b\\", ["\x1bP>|xterm\x1b\\"]),
  vector("dcs-decrqss", "\x1bP1$r0;1;0;0m\x1b\\", ["\x1bP1$r0;1;0;0m\x1b\\"]),
  vector("decrpm", "\x1b[?25;1$y", ["\x1b[?25;1$y"]),
  vector("xtwinops", "\x1b[8;24;80t", ["\x1b[8;24;80t"]),
  vector("paste-start", "\x1b[200~", ["\x1b[200~"]),
  vector("paste-end", "\x1b[201~", ["\x1b[201~"]),
  vector("arrow-left", "\x1b[D", ["\x1b[D"]),
  vector("delete-key", "\x1b[3~", ["\x1b[3~"]),
  vector("alt-b", "\x1bb", ["\x1bb"]),
  vector("save-cursor", "\x1b7", ["\x1b7"]),
  vector("da1-wrapped", "ab\x1b[?1;2ccd", ["\x1b[?1;2c"]),
  vector("text-osc-text", "pre\x1b]0;title\x07post", ["\x1b]0;title\x07"]),
];

import type { IBuffer, IBufferCell, Terminal } from "@xterm/headless";
import { terminalScreenCursorVisible, terminalScreenPaletteOverrides } from "./terminalScreenState";

const CSI = "\x1b[";
// UTF-16 payload: at most 256 KiB per checkpoint, plus bounded stream state.
export const HEADLESS_CHECKPOINT_MAX_CHARS = 128 * 1024;
const MAX_CELLS = 64 * 1024;
const MAX_PENDING_CHARS = 4096;
const SGR_RESETS: Readonly<Record<number, readonly number[]>> = {
  22: [1, 2], 23: [3], 24: [4], 25: [5], 27: [7], 28: [8], 29: [9], 39: [38], 49: [48], 59: [58],
};
const sgrParam = (param: number | number[]): string => Array.isArray(param)
  ? param.map(value => value < 0 ? "" : value).join(":") : String(param);

/** Only an unfinished control sequence is retained, never a PTY recording. */
class EscapeTail {
  private mode: "text" | "escape" | "intermediate" | "csi" | "osc" | "string" = "text";
  private escaped = false;
  private length = 0;
  private text = "";

  get pending(): string | undefined { return this.length <= MAX_PENDING_CHARS ? this.text : undefined; }

  push(chunk: string): void {
    // Only the final escape can still be unfinished. Ordinary output before it
    // cannot contribute to the next checkpoint's parser fragment.
    const lastEscape = chunk.lastIndexOf("\x1b");
    if (lastEscape >= 0) { this.reset(); chunk = chunk.slice(lastEscape); }
    else if (this.mode === "text") return;
    for (const char of chunk) {
      if (char === "\x18" || char === "\x1a") { this.reset(); break; }
      if (this.mode === "text") {
        if (char === "\x1b") { this.mode = "escape"; this.text = char; this.length = 1; }
        continue;
      }
      this.length++;
      if (this.length <= MAX_PENDING_CHARS) this.text += char;
      if (this.mode === "osc" || this.mode === "string") {
        if ((this.mode === "osc" && char === "\x07") || (this.escaped && char === "\\")) this.reset();
        else this.escaped = char === "\x1b";
      } else if (char === "\x1b") {
        this.mode = "escape"; this.text = char; this.length = 1;
      } else if (this.mode === "csi") {
        if (char >= "@" && char <= "~") this.reset();
      } else if (this.mode === "intermediate") {
        if (char >= "0" && char <= "~") this.reset();
      } else if (char === "[") this.mode = "csi";
      else if (char === "]") this.mode = "osc";
      else if ("PX^_".includes(char)) this.mode = "string";
      else if (char >= " " && char <= "/") this.mode = "intermediate";
      else if (char >= "0" && char <= "~") this.reset();
      if (this.length === 0) break; // No later ESC remains in this suffix.
    }
  }

  reset(): void { this.mode = "text"; this.escaped = false; this.length = 0; this.text = ""; }
}

function cellStyle(cell: IBufferCell): string {
  const codes = [0];
  for (const [enabled, code] of [
    [cell.isBold(), 1], [cell.isDim(), 2], [cell.isItalic(), 3], [cell.isUnderline(), 4],
    [cell.isBlink(), 5], [cell.isInverse(), 7], [cell.isInvisible(), 8], [cell.isStrikethrough(), 9],
  ]) if (enabled) codes.push(code);
  for (const foreground of [true, false]) {
    const value = foreground ? cell.getFgColor() : cell.getBgColor();
    if (foreground ? cell.isFgRGB() : cell.isBgRGB()) {
      codes.push(foreground ? 38 : 48, 2, value >> 16 & 255, value >> 8 & 255, value & 255);
    } else if (foreground ? cell.isFgPalette() : cell.isBgPalette()) codes.push(foreground ? 38 : 48, 5, value);
  }
  return CSI + codes.join(";") + "m";
}

/** Public parser observers supply the state the public buffer API omits. */
export class HeadlessCheckpointState {
  rawTail = new EscapeTail();
  parsedTail = new EscapeTail();
  private readonly sgr = new Map<number, string>();
  private readonly regions = new Map<string, [number, number]>();
  private readonly saved = new Map<string, { x: number; y: number; origin: boolean; sgr: Map<number, string> }>();
  private checkpointSupported = true;
  private readonly nondefaultCharsets = new Set<number>();

  private activeSgr(): string { return CSI + "0m" + (this.sgr.size ? CSI + [...this.sgr.values()].join(";") + "m" : ""); }

  attach(terminal: Terminal): void {
    const save = (): boolean => {
      if (this.nondefaultCharsets.size > 0) this.checkpointSupported = false;
      const buffer = terminal.buffer.active;
      this.saved.set(buffer.type, { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY, origin: terminal.modes.originMode, sgr: new Map(this.sgr) });
      return false;
    };
    const restore = (type = terminal.buffer.active.type): boolean => {
      const saved = this.saved.get(type);
      if (saved) { this.sgr.clear(); saved.sgr.forEach((value, key) => this.sgr.set(key, value)); }
      return false;
    };
    const reset = (): boolean => { this.sgr.clear(); this.regions.clear(); this.saved.clear(); this.nondefaultCharsets.clear(); return false; };
    const unsupported = (): boolean => { this.checkpointSupported = false; return false; };
    const handlers = [
      // xterm supports these ISO-2022 designators, but its public buffer API
      // exposes neither active character sets nor custom horizontal tab stops.
      ...["(", ")", "*", "+", "-", "."].flatMap((intermediates, index) => [..."0AB4C5RQKYE6ZH7="].map(final =>
        terminal.parser.registerEscHandler({ intermediates, final }, () => {
          const slot = index < 4 ? index : index - 3;
          if (final === "B") this.nondefaultCharsets.delete(slot); else this.nondefaultCharsets.add(slot);
          return false;
        }))),
      ...["H", "n", "o", "|", "}", "~"].map(final => terminal.parser.registerEscHandler({ final }, unsupported)),
      terminal.parser.registerCsiHandler({ final: "g" }, unsupported),
      terminal.parser.registerCsiHandler({ final: "m" }, params => {
        for (let i = 0; i < params.length; i++) {
          const code = params[i];
          if (Array.isArray(code)) continue;
          // xterm's public API places subparameters in a separate array after
          // their main parameter: 38:2::r:g:b becomes [38, [2, -1, r, g, b]].
          const sub = Array.isArray(params[i + 1]) ? params[++i] as number[] : undefined;
          const token = String(code) + (sub ? ":" + sgrParam(sub) : "");
          if (code === 0) this.sgr.clear();
          else if (SGR_RESETS[code]) SGR_RESETS[code].forEach(key => this.sgr.delete(key));
          else if ([1, 2, 3, 4, 5, 7, 8, 9].includes(code)) this.sgr.set(code, token);
          else if (code === 21) this.sgr.set(4, "4:2");
          else if (code === 38 || code === 48 || code === 58) {
            if (sub) this.sgr.set(code, token);
            else {
              const count = params[i + 1] === 2 ? 4 : params[i + 1] === 5 ? 2 : 0;
              if (count && i + count < params.length) this.sgr.set(code, params.slice(i, i + count + 1).join(";"));
              i += count;
            }
          } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) this.sgr.set(38, String(code));
          else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.sgr.set(48, String(code));
        }
        return false;
      }),
      terminal.parser.registerCsiHandler({ final: "r" }, params => {
        const top = Math.max(1, Number(params[0]) || 1), bottom = Math.min(terminal.rows, Number(params[1]) || terminal.rows);
        if (top < bottom) this.regions.set(terminal.buffer.active.type, [top, bottom]);
        return false;
      }),
      terminal.parser.registerEscHandler({ final: "7" }, save),
      terminal.parser.registerCsiHandler({ final: "s" }, save),
      terminal.parser.registerEscHandler({ final: "8" }, () => restore()),
      terminal.parser.registerCsiHandler({ final: "u" }, () => restore()),
      terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, params => {
        if (params.includes(1048) || (params.includes(1049) && terminal.buffer.active.type === "normal")) save();
        return false;
      }),
      terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, params => {
        if (params.includes(1049)) restore("normal"); else if (params.includes(1048)) restore();
        if (params.some(value => value === 47 || value === 1047 || value === 1049)) {
          this.regions.delete("alternate"); this.saved.delete("alternate");
        }
        return false;
      }),
      terminal.parser.registerEscHandler({ final: "c" }, reset),
      terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, reset),
    ];
    // xterm resets both scroll regions on resize.
    const resize = terminal.onResize?.(() => this.regions.clear());
    terminal.loadAddon({ activate() {}, dispose() { handlers.forEach(handler => handler.dispose()); resize?.dispose(); } });
  }

  observeOutput(output: string): void {
    // C1 HTS and SO are execute controls, without a public xterm parser hook.
    if (output.includes("\x88") || output.includes("\x0e")) this.checkpointSupported = false;
    this.parsedTail.push(output);
  }

  resetStreams(): void { this.rawTail = new EscapeTail(); this.parsedTail = new EscapeTail(); }

  /** Serialize both buffers so leaving an alternate dialog restores normal text.
   * Work and payload are bounded independently of xterm's 5000-row scrollback.
   * The largest history suffix fitting both budgets is retained; it may contain
   * fewer logical lines than a pane.read caller requested (up to 400).
   */
  frame(terminal: Terminal, maxChars = HEADLESS_CHECKPOINT_MAX_CHARS): string | undefined {
    if (!this.checkpointSupported || this.nondefaultCharsets.size || !terminal.buffer.normal || !terminal.modes
      || this.rawTail.pending === undefined || this.parsedTail.pending === undefined) return undefined;
    const { cols, rows } = terminal;
    const alternate = terminal.buffer.active.type === "alternate";
    const visibleCells = cols * rows * (alternate ? 2 : 1);
    if (visibleCells > MAX_CELLS) return undefined;
    const position = (buffer: IBuffer): string => {
      let text = CSI + `${buffer.cursorY + 1};${Math.min(cols - 1, buffer.cursorX) + 1}H`;
      if (buffer.cursorX >= cols) {
        const line = buffer.getLine(buffer.baseY + buffer.cursorY);
        let col = cols - 1;
        while (col > 0 && line?.getCell(col)?.getWidth() === 0) col--;
        const cell = line?.getCell(col);
        if (cell) text += CSI + `${buffer.cursorY + 1};${col + 1}H` + cellStyle(cell) + (cell.getChars() || " ");
      }
      return text;
    };
    const bufferEnd = (buffer: IBuffer): string => {
      const region = this.regions.get(buffer.type);
      let text = region ? CSI + `${region[0]};${region[1]}r` : "";
      const saved = this.saved.get(buffer.type);
      if (saved) text += CSI + `?6${saved.origin ? "h" : "l"}`
        + CSI + `${Math.max(0, Math.min(rows - 1, saved.y - buffer.baseY)) + 1 - (saved.origin ? (region?.[0] ?? 1) - 1 : 0)};${Math.min(cols - 1, saved.x) + 1}H`
        + CSI + "0m" + CSI + [...saved.sgr.values()].join(";") + "m\x1b7" + CSI + "?6l";
      return text + position(buffer);
    };
    const normalEnd = bufferEnd(terminal.buffer.normal);
    const normalSgr = this.saved.get("normal")?.sgr;
    const alternateStart = alternate ? (normalSgr ? CSI + "0m" + CSI + [...normalSgr.values()].join(";") + "m" : "")
      + CSI + "?1049h" + CSI + "H" : "";
    const alternateEnd = alternate ? bufferEnd(terminal.buffer.alternate) : "";
    const tail: string[] = [];
    for (const [index, color] of terminalScreenPaletteOverrides(terminal) ?? []) {
      tail.push(index < 256 ? `\x1b]4;${index};${color}\x07` : `\x1b]${index - 246};${color}\x07`);
    }
    const region = this.regions.get(terminal.buffer.active.type);
    if (region) tail.push(CSI + `${region[0]};${region[1]}r`);
    const modes = terminal.modes;
    for (const [enabled, code] of [
      [modes.applicationCursorKeysMode, 1], [modes.wraparoundMode, 7], [modes.reverseWraparoundMode, 45],
      [modes.bracketedPasteMode, 2004], [modes.sendFocusMode, 1004],
    ] as const) tail.push(CSI + `?${code}${enabled ? "h" : "l"}`);
    // DECSET homes the cursor; finish with a region-relative CUP in origin mode.
    tail.push(CSI + `?6${modes.originMode ? "h" : "l"}`);
    const active = terminal.buffer.active;
    tail.push(modes.originMode
      ? CSI + `${active.cursorY + 2 - (region?.[0] ?? 1)};${Math.min(cols - 1, active.cursorX) + 1}H` : position(active));
    tail.push((modes.applicationKeypadMode ? "\x1b=" : "\x1b>") + CSI + `4${modes.insertMode ? "h" : "l"}` + this.activeSgr()
      + CSI + `?25${terminalScreenCursorVisible(terminal) ? "h" : "l"}`);
    let length = normalEnd.length + alternateStart.length + alternateEnd.length + tail.reduce((sum, text) => sum + text.length, 0);
    if (length > maxChars) return undefined;

    type Row = { text: string; wrapped: boolean; blankWrapped: boolean };
    const cell = terminal.buffer.normal.getNullCell();
    // Serialize each visited row once. Independent initial SGR makes its exact
    // length usable for any history suffix without rescanning cells or rebuilding.
    const rowFrame = (buffer: IBuffer, row: number): Row | undefined => {
      const line = buffer.getLine(row);
      if (!line) return { text: "", wrapped: false, blankWrapped: false };
      let end = cols;
      if (!buffer.getLine(row + 1)?.isWrapped) {
        while (end > 0) {
          const value = line.getCell(end - 1, cell);
          if (value && (value.getChars() || cellStyle(value) !== CSI + "0m")) break;
          end--;
        }
      }
      const blankWrapped = line.isWrapped && end === 0;
      if (blankWrapped) end = 1;
      const parts: string[] = [];
      let style = "", chars = 0;
      for (let col = 0; col < end; col++) {
        const value = line.getCell(col, cell);
        if (!value || value.getWidth() === 0) continue;
        const nextStyle = cellStyle(value), text = value.getChars() || " ";
        if (nextStyle !== style) { parts.push(nextStyle); chars += nextStyle.length; style = nextStyle; }
        chars += text.length;
        if (chars > maxChars) return undefined;
        parts.push(text);
      }
      return { text: parts.join(""), wrapped: line.isWrapped, blankWrapped };
    };
    const firstLength = (row: Row) => row.blankWrapped ? 0 : row.text.length;
    const visible = (buffer: IBuffer): Row[] | undefined => {
      const result: Row[] = [];
      for (let row = buffer.baseY; row < buffer.baseY + rows; row++) {
        const value = rowFrame(buffer, row);
        if (!value) return undefined;
        length += result.length ? value.text.length + (value.wrapped ? 0 : 2) : firstLength(value);
        if (length > maxChars) return undefined;
        result.push(value);
      }
      return result;
    };
    const normal = visible(terminal.buffer.normal);
    if (!normal) return undefined;
    const alternateRows = alternate ? visible(terminal.buffer.alternate) : [];
    if (!alternateRows) return undefined;
    // The visible screen must fit before even considering history. Each older
    // row is measured once, stopping at the first suffix that cannot fit.
    const history = Math.min(500, terminal.buffer.normal.baseY, Math.floor((MAX_CELLS - visibleCells) / cols));
    const older: Row[] = [];
    let first = normal[0];
    for (let count = 1; count <= history; count++) {
      const value = rowFrame(terminal.buffer.normal, terminal.buffer.normal.baseY - count);
      if (!value) break;
      const added = firstLength(value) + (first.wrapped ? 0 : 2) + (first.blankWrapped ? first.text.length : 0);
      if (length + added > maxChars) break;
      length += added; older.push(value); first = value;
    }
    const parts: string[] = [];
    const addRows = (values: Row[]) => values.forEach((row, index) => {
      if (index && !row.wrapped) parts.push("\r\n");
      if (index || !row.blankWrapped) parts.push(row.text);
    });
    addRows([...older.reverse(), ...normal]); parts.push(normalEnd, alternateStart);
    addRows(alternateRows); parts.push(alternateEnd, ...tail);
    return this.buildFrame(parts);
  }

  private buildFrame(parts: string[]): string {
    // Exactly one final build, stored flat rather than as per-cell cons strings.
    return parts.join("");
  }
}

/** A cold parser can start at ESC/newline. Preserved cells require an
 * absolute positioning/reset command so a partial redraw cannot paint text at
 * the old checkpoint's parked cursor. Relative-only gaps use cold replay.
 */
export function headlessReplayBoundary(data: Uint8Array, preserveCells = false): number | undefined {
  for (let i = 0; i < data.length; i++) {
    if (!preserveCells && data[i] === 10) return i;
    if (data[i] !== 0x1b) continue;
    if (!preserveCells) { if (data[i + 1] !== 0x5c) return i; continue; }
    if (data[i + 1] === 0x63) return i; // RIS
    if (data[i + 1] !== 0x5b) continue;
    let end = i + 2;
    const privateMode = data[end] === 0x3f;
    if (privateMode) end++;
    const firstParam = end;
    while ((data[end] >= 0x30 && data[end] <= 0x39) || data[end] === 0x3b) end++;
    if (!privateMode && (data[end] === 0x48 || data[end] === 0x66)) return i; // CUP/HVP
    if (!privateMode && data[end] === 0x4a) {
      let parameter = 0;
      for (let p = firstParam; p < end && parameter <= 2; p++) {
        if (data[p] === 0x3b) { parameter = -1; break; }
        parameter = parameter * 10 + data[p] - 0x30;
      }
      if (parameter === 2) return i; // ED 2 only; ED 0/1 depend on an unknown cursor, ED 3 only clears history.
    }
    if (privateMode && (data[end] === 0x68 || data[end] === 0x6c)) {
      let parameter = 0;
      for (let p = firstParam; p <= end; p++) {
        if (p === end || data[p] === 0x3b) {
          if (parameter === 47 || parameter === 1047 || parameter === 1049) return i;
          parameter = 0;
        } else parameter = Math.min(10_000, parameter * 10 + data[p] - 0x30);
      }
    }
  }
  return undefined;
}

// @ts-expect-error The published headless ESM entry has no colocated declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { IBuffer, IBufferCell, Terminal as HeadlessTerminal } from "@xterm/headless";
import type { IDisposable, Terminal as BrowserTerminal } from "@xterm/xterm";
import { withTerminalDeadline } from "../../lib/terminalDeadline";

const Terminal = PublishedTerminal as typeof HeadlessTerminal;
const CSI = "\x1b[";

function cellStyle(cell: IBufferCell): string {
  const codes: number[] = [0];
  for (const [enabled, code] of [
    [cell.isBold(), 1], [cell.isDim(), 2], [cell.isItalic(), 3],
    [cell.isUnderline(), 4], [cell.isBlink(), 5], [cell.isInverse(), 7],
    [cell.isInvisible(), 8], [cell.isStrikethrough(), 9],
  ]) if (enabled) codes.push(code);
  const color = (foreground: boolean): void => {
    const value = foreground ? cell.getFgColor() : cell.getBgColor();
    if (foreground ? cell.isFgRGB() : cell.isBgRGB()) {
      codes.push(foreground ? 38 : 48, 2, value >> 16 & 255, value >> 8 & 255, value & 255);
    } else if (foreground ? cell.isFgPalette() : cell.isBgPalette()) {
      codes.push(foreground ? 38 : 48, 5, value);
    }
  };
  color(true); color(false);
  return CSI + codes.join(";") + "m";
}

/** Serialize cells, rather than exposing a truncated VT byte suffix on screen. */
function serializeBuffer(buffer: IBuffer, cols: number): string {
  let output = "";
  let style = "";
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (row > 0 && !line.isWrapped) output += "\r\n";
    let lastColumn = cols;
    if (!buffer.getLine(row + 1)?.isWrapped) {
      while (lastColumn > 0) {
        const tail = line.getCell(lastColumn - 1);
        if (tail && (tail.getChars() || !tail.isBgDefault() || tail.isInverse())) break;
        lastColumn -= 1;
      }
    }
    for (let col = 0; col < lastColumn; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      const nextStyle = cellStyle(cell);
      if (nextStyle !== style) { output += nextStyle; style = nextStyle; }
      output += cell.getChars() || " ";
    }
  }
  return output + CSI + `${buffer.cursorY + 1};${Math.min(cols - 1, buffer.cursorX) + 1}H`;
}

export async function buildTerminalRecoveryFrame(
  data: Uint8Array, startOffset: number, cols: number, rows: number,
): Promise<{ text: string; decoder: TextDecoder }> {
  const staging = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const decoder = new TextDecoder();
  let activeSgr: string[] = [];
  staging.parser.registerCsiHandler({ final: "m" }, params => {
    if (params.length === 0 || params[0] === 0) activeSgr = [];
    activeSgr.push(CSI + params.map(value => Array.isArray(value) ? value.join(":") : value).join(";") + "m");
    return false;
  });
  try {
    staging.loadAddon(new Unicode11Addon());
    staging.unicode.activeVersion = "11";
    // The ring can begin inside a control sequence or UTF-8 character. Only
    // the incomplete leading line is discarded; the retained complete rows
    // are parsed offscreen at the live terminal's actual geometry.
    const newline = startOffset > 0 ? data.indexOf(10) : -1;
    const replay = newline >= 0 ? data.subarray(newline + 1) : data;
    const text = decoder.decode(replay, { stream: true });
    await withTerminalDeadline(new Promise<void>(resolve => staging.write(text, resolve)), "offscreen terminal recovery");
    let frame = CSI + "?2026h" + serializeBuffer(staging.buffer.normal, cols);
    if (staging.buffer.active.type === "alternate") {
      frame += CSI + "?1049h" + serializeBuffer(staging.buffer.alternate, cols);
    }
    const modes = staging.modes;
    for (const [enabled, code] of [
      [modes.applicationCursorKeysMode, 1], [modes.originMode, 6],
      [modes.wraparoundMode, 7], [modes.reverseWraparoundMode, 45],
      [modes.bracketedPasteMode, 2004], [modes.sendFocusMode, 1004],
    ] as const) frame += CSI + `?${code}${enabled ? "h" : "l"}`;
    frame += CSI + `4${modes.insertMode ? "h" : "l"}`;
    frame += modes.applicationKeypadMode ? "\x1b=" : "\x1b>";
    const active = staging.buffer.active;
    frame += CSI + `${active.cursorY + 1};${Math.min(cols - 1, active.cursorX) + 1}H`;
    if (active.cursorX >= cols) {
      const line = active.getLine(active.baseY + active.cursorY);
      let col = cols - 1;
      while (col > 0 && line?.getCell(col)?.getWidth() === 0) col -= 1;
      const cell = line?.getCell(col);
      if (cell) frame += CSI + "4l" + CSI + `${active.cursorY + 1};${col + 1}H`
        + cellStyle(cell) + (cell.getChars() || " ") + CSI + `4${modes.insertMode ? "h" : "l"}`;
    }
    frame += CSI + "0m" + activeSgr.join("") + CSI + "?2026l";
    return { text: frame, decoder };
  } finally { staging.dispose(); }
}

/** Copy canvas pixels in the render task, before WebGL clears its buffer. */
function copyTerminalScreen(element: HTMLElement | undefined): () => void {
  if (!element?.parentElement) return () => {};
  const frozen = element.cloneNode(true) as HTMLElement;
  frozen.setAttribute("aria-hidden", "true");
  frozen.inert = true;
  Object.assign(frozen.style, { position: "absolute", inset: "0", zIndex: "2", pointerEvents: "none", opacity: "1" });
  const originals = element.querySelectorAll("canvas");
  frozen.querySelectorAll("canvas").forEach((canvas, index) => {
    const original = originals[index];
    if (original) {
      canvas.width = original.width; canvas.height = original.height;
      try { canvas.getContext("2d")?.drawImage(original, 0, 0); } catch { /* DOM renderer remains copied. */ }
    }
  });
  element.parentElement.append(frozen);
  return () => frozen.remove();
}


/** Keep the previous frame without retaining every WebGL drawing buffer. */
export async function freezeTerminalScreen(
  term: Pick<BrowserTerminal, "element" | "rows" | "onRender" | "refresh">,
): Promise<() => void> {
  const element = term.element;
  if (!element?.parentElement) return () => {};
  let rendered: IDisposable | undefined;
  let release = () => {};
  let captured = false;
  try {
    await withTerminalDeadline(new Promise<void>((resolve, reject) => {
      rendered = term.onRender(() => {
        if (captured) return;
        captured = true;
        try { release = copyTerminalScreen(element); resolve(); }
        catch (error) { reject(error); }
      });
      // WebglAddon uses preserveDrawingBuffer=false. A later microtask sees
      // a cleared canvas; capture synchronously after the actual redraw.
      term.refresh(0, term.rows - 1);
    }), "terminal recovery screen");
    return release;
  } catch (error) {
    release();
    throw error;
  } finally { rendered?.dispose(); }
}

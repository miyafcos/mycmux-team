import type { Terminal } from "@xterm/xterm";
import { chunkedWrite, registerTerminalCacheEvictionCleanup } from "./terminalCache";
import { shouldSuppressWheelFocusInput } from "./terminalFocusHelpers";
import { bump as bumpPaintStat } from "../../lib/paintStats";

export type FilteredTerminalInput = {
  data: string;
  hasNonWheelInput: boolean;
};

const terminalMouseModeOutputTailBySession = new Map<string, string>();
const terminalMouseReportModeBySession = new Set<string>();
const terminalSgrMouseReportBySession = new Set<string>();

registerTerminalCacheEvictionCleanup((sessionId) => {
  terminalMouseModeOutputTailBySession.delete(sessionId);
  terminalMouseReportModeBySession.delete(sessionId);
  terminalSgrMouseReportBySession.delete(sessionId);
});

function isTerminalWheelMouseButton(button: number): boolean {
  return Number.isFinite(button) && (button & 64) === 64;
}

function stripTerminalMouseInputSequences(data: string): string {
  return data
    // SGR mouse reporting: ESC [ < button ; col ; row M/m
    .replace(/\x1b\[<\d+(?:;\d+){2}[mM]/g, "")
    // urxvt-style mouse reporting: ESC [ button ; col ; row M/m
    .replace(/\x1b\[\d+(?:;\d+){2}[mM]/g, "")
    // X10 / normal tracking: ESC [ M followed by three encoded bytes
    .replace(/\x1b\[M[\s\S]{3}/g, "");
}

function stripTerminalWheelInputSequences(data: string): string {
  return data
    .replace(/\x1b\[<(\d+)(;\d+){2}[mM]/g, (sequence, button: string) =>
      isTerminalWheelMouseButton(Number(button)) ? "" : sequence,
    )
    .replace(/\x1b\[(\d+)(;\d+){2}[mM]/g, (sequence, button: string) =>
      isTerminalWheelMouseButton(Number(button)) ? "" : sequence,
    )
    .replace(/\x1b\[M([\s\S])([\s\S])([\s\S])/g, (sequence, button: string) => {
      const buttonCode = button.charCodeAt(0) - 32;
      return isTerminalWheelMouseButton(buttonCode) ? "" : sequence;
    });
}

function stripTerminalFocusInputSequences(data: string): string {
  return data.replace(/\x1b\[[IO]/g, "");
}

const TERMINAL_MOUSE_MODE_PARAMS = new Set(["9", "1000", "1002", "1003", "1005", "1006", "1007", "1015", "1016"]);
const TERMINAL_MOUSE_MODE_CONTROL_SEQUENCE_RE = /\x1b\[\?([0-9;]+)([hl])/g;
const TERMINAL_MOUSE_MODE_CONTROL_PARTIAL_RE = /\x1b(?:\[\??[0-9;]*)?$/;
const TERMINAL_MOUSE_REPORT_PARAMS = new Set(["9", "1000", "1002", "1003", "1005", "1006", "1015", "1016"]);

function updateTerminalMouseReportMode(sessionId: string | undefined, parts: string[], final: string): void {
  if (!sessionId || !parts.some((part) => TERMINAL_MOUSE_REPORT_PARAMS.has(part))) return;
  if (final === "h") {
    terminalMouseReportModeBySession.add(sessionId);
    if (parts.includes("1006")) {
      terminalSgrMouseReportBySession.add(sessionId);
    }
    return;
  }
  terminalMouseReportModeBySession.delete(sessionId);
  terminalSgrMouseReportBySession.delete(sessionId);
}

export function stripTerminalMouseModeControlSequences(data: string, sessionId?: string): string {
  return data.replace(TERMINAL_MOUSE_MODE_CONTROL_SEQUENCE_RE, (sequence, params: string, final: string) => {
    const parts = params.split(";").filter(Boolean);
    updateTerminalMouseReportMode(sessionId, parts, final);
    const remaining = parts.filter((part) => !TERMINAL_MOUSE_MODE_PARAMS.has(part));
    if (remaining.length === parts.length) return sequence;
    return remaining.length === 0 ? "" : `\x1b[?${remaining.join(";")}${final}`;
  });
}

export function createTerminalMouseModeControlFilter(): (data: string) => string {
  let pendingTail = "";
  return (data: string): string => {
    const combined = `${pendingTail}${data}`;
    const partialMatch = TERMINAL_MOUSE_MODE_CONTROL_PARTIAL_RE.exec(combined);
    pendingTail = partialMatch?.[0] ?? "";
    const ready = pendingTail ? combined.slice(0, -pendingTail.length) : combined;
    return stripTerminalMouseModeControlSequences(ready);
  };
}

export function stripTerminalMouseModeControlSequencesForSession(sessionId: string, data: string): string {
  const pendingTail = terminalMouseModeOutputTailBySession.get(sessionId) ?? "";
  const combined = `${pendingTail}${data}`;
  const partialMatch = TERMINAL_MOUSE_MODE_CONTROL_PARTIAL_RE.exec(combined);
  const partialTail = partialMatch?.[0] ?? "";
  const ready = partialTail ? combined.slice(0, -partialTail.length) : combined;
  if (partialTail) {
    terminalMouseModeOutputTailBySession.set(sessionId, partialTail);
  } else {
    terminalMouseModeOutputTailBySession.delete(sessionId);
  }
  return stripTerminalMouseModeControlSequences(ready, sessionId);
}

function hasTerminalUserInput(data: string): boolean {
  return stripTerminalFocusInputSequences(stripTerminalWheelInputSequences(data)).length > 0;
}

export function filterTerminalMouseInputSequences(data: string): FilteredTerminalInput {
  const inputData = stripTerminalMouseInputSequences(data);
  return {
    data: inputData,
    hasNonWheelInput: hasTerminalUserInput(inputData),
  };
}

export function filterWheelFocusInputSequences(
  sessionId: string,
  input: FilteredTerminalInput,
): FilteredTerminalInput {
  if (!input.data || !shouldSuppressWheelFocusInput(sessionId)) return input;
  const data = stripTerminalFocusInputSequences(input.data);
  if (data === input.data) return input;
  return {
    data,
    hasNonWheelInput: hasTerminalUserInput(data),
  };
}

const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;

function wheelDeltaToTerminalLines(event: WheelEvent, rows: number): number {
  const rawDelta = event.deltaY;
  if (rawDelta === 0) return 0;

  const lines = event.deltaMode === WHEEL_DELTA_PAGE
    ? rawDelta * Math.max(1, rows)
    : event.deltaMode === WHEEL_DELTA_LINE
      ? rawDelta
      : rawDelta / 40;
  if (!Number.isFinite(lines) || lines === 0) return 0;

  const direction = Math.sign(lines);
  return direction * Math.max(1, Math.round(Math.abs(lines)));
}

function wheelEventToSgrMouseReport(currentTerm: Terminal, event: WheelEvent, lines: number): string | null {
  const element = currentTerm.element;
  if (!element || currentTerm.cols <= 0 || currentTerm.rows <= 0) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const col = Math.min(currentTerm.cols, Math.max(1, Math.floor(((event.clientX - rect.left) / rect.width) * currentTerm.cols) + 1));
  const row = Math.min(currentTerm.rows, Math.max(1, Math.floor(((event.clientY - rect.top) / rect.height) * currentTerm.rows) + 1));
  const baseButton = event.deltaY < 0 ? 64 : 65;
  const button = baseButton + (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0) + (event.ctrlKey ? 16 : 0);
  const repeats = Math.min(12, Math.max(1, Math.abs(lines)));
  return `\x1b[<${button};${col};${row}M`.repeat(repeats);
}

export function shouldForwardWheelToApplication(
  activeBufferType: "normal" | "alternate",
  mouseReportingEnabled: boolean,
  forceMouseReport: boolean,
  shiftKey: boolean,
): boolean {
  if (shiftKey) return false;
  return activeBufferType === "alternate" && (mouseReportingEnabled || forceMouseReport);
}

export function attachTerminalWheelScroll(container: HTMLElement, currentTerm: Terminal, sessionId: string, forceMouseReport: boolean): () => void {
  const handleWheel = (event: WheelEvent): void => {
    if (event.defaultPrevented || event.metaKey) return;
    const lines = wheelDeltaToTerminalLines(event, currentTerm.rows);
    if (lines === 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const mouseReportingEnabled = terminalMouseReportModeBySession.has(sessionId)
      && terminalSgrMouseReportBySession.has(sessionId);
    if (shouldForwardWheelToApplication(
      currentTerm.buffer.active.type,
      mouseReportingEnabled,
      forceMouseReport,
      event.shiftKey,
    )) {
      const report = wheelEventToSgrMouseReport(currentTerm, event, lines);
      if (report) {
        chunkedWrite(sessionId, report);
        return;
      }
    }
    bumpPaintStat("scroll");
    currentTerm.scrollLines(lines);
  };

  container.addEventListener("wheel", handleWheel, { capture: true, passive: false });
  return () => container.removeEventListener("wheel", handleWheel, { capture: true });
}

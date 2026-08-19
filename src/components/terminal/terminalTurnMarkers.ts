import type { Terminal } from "@xterm/xterm";
import { applyInputToDraft, EMPTY_DRAFT, type InputLineDraft } from "../../lib/inputLineDraft";
import {
  liveTerms,
  MAX_TURN_MARKS_PER_SESSION,
  pruneTurnMarks,
  registerTerminalCacheEvictionCleanup,
  termCache,
  terminalTurnMarks,
  type SessionTurnMark,
} from "./terminalCache";
import {
  shouldMarkTurn,
  splitSubmits,
  turnLabelFrom,
  type TurnMarkData,
} from "./terminalTurnModel";

export const TURN_MARKS_EVENT = "mycmux:turn-marks";

const turnDrafts = new Map<string, InputLineDraft>();

registerTerminalCacheEvictionCleanup((sessionId) => {
  turnDrafts.delete(sessionId);
});

export function resolveTurnTerminal(sessionId: string): Terminal | undefined {
  return liveTerms.get(sessionId) ?? termCache.get(sessionId)?.term;
}

function lastKeptMark(marks: readonly SessionTurnMark[]): Pick<TurnMarkData, "line" | "at"> | null {
  const last = marks[marks.length - 1];
  if (!last || last.marker.line < 0) return null;
  return { line: last.marker.line, at: last.at };
}

function emitTurnMarks(sessionId: string): void {
  try {
    window.dispatchEvent(new CustomEvent(TURN_MARKS_EVENT, { detail: { sessionId } }));
  } catch {
    // Node unit tests have no window; the chip listener is the only consumer.
  }
}

export function noteTurnSubmit(sessionId: string, rawLabel: string, now = Date.now()): void {
  const term = resolveTurnTerminal(sessionId);
  if (!term) return;
  const buf = term.buffer.active;
  if (buf.type !== "normal") return;

  const label = turnLabelFrom(rawLabel);
  const currentLine = buf.baseY + buf.cursorY;
  const kept = pruneTurnMarks(sessionId);
  if (!shouldMarkTurn({ label, currentLine, now, last: lastKeptMark(kept) })) return;

  const marker = term.registerMarker(0);
  if (!marker) return;

  const next = terminalTurnMarks.get(sessionId) ?? kept;
  const entry: SessionTurnMark = { marker, label, at: now };
  next.push(entry);
  terminalTurnMarks.set(sessionId, next);

  marker.onDispose(() => {
    const list = terminalTurnMarks.get(sessionId);
    if (!list) return;
    const remaining = list.filter((mark) => mark.marker !== marker);
    if (remaining.length === 0) terminalTurnMarks.delete(sessionId);
    else terminalTurnMarks.set(sessionId, remaining);
  });

  while (next.length > MAX_TURN_MARKS_PER_SESSION) {
    const oldest = next.shift();
    oldest?.marker.dispose();
  }

  emitTurnMarks(sessionId);
}

export function noteTurnInput(sessionId: string, data: string): void {
  const { segments, count } = splitSubmits(data);
  const draft = turnDrafts.get(sessionId) ?? EMPTY_DRAFT;
  if (count > 0) {
    noteTurnSubmit(sessionId, `${draft.text}${segments[0] ?? ""}`);
    for (let index = 1; index < segments.length; index += 1) {
      noteTurnSubmit(sessionId, segments[index] ?? "");
    }
  }
  turnDrafts.set(sessionId, applyInputToDraft(draft, data));
}

export function getTurnMarkData(sessionId: string): TurnMarkData[] {
  return pruneTurnMarks(sessionId)
    .map((mark) => ({ line: mark.marker.line, label: mark.label, at: mark.at }))
    .sort((left, right) => left.line - right.line);
}

export function clearTurnMarks(sessionId: string): void {
  turnDrafts.delete(sessionId);
  const marks = terminalTurnMarks.get(sessionId);
  if (!marks) return;
  terminalTurnMarks.delete(sessionId);
  for (const mark of marks) {
    mark.marker.dispose();
  }
}

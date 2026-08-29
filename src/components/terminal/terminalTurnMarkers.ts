import type { Terminal } from "@xterm/xterm";
import { applyInputToDraft, EMPTY_DRAFT, type InputLineDraft } from "../../lib/inputLineDraft";
import type { TurnMarkPersistSnapshot } from "../../types";
import { scanVtInput, type VtInputScanState } from "../../lib/vtInputScan";
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
export const RESTORE_BOUNDARY_LABEL = "復元前の履歴";
export const TURN_MARK_PERSIST_MAX = 100;
export const TURN_MARK_PERSIST_LABEL_MAX = 80;

export type { TurnMarkPersistSnapshot };

const turnDrafts = new Map<string, InputLineDraft>();

interface TurnMarkSnapshot {
  label: string;
  at: number;
  linesFromBottom: number;
  scrollbackOffset?: number;
}

const turnMarkSnapshots = new Map<string, TurnMarkSnapshot[]>();

registerTerminalCacheEvictionCleanup((sessionId) => {
  turnDrafts.delete(sessionId);
  turnMarkSnapshots.delete(sessionId);
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

function bindMarkerDispose(sessionId: string, marker: SessionTurnMark["marker"]): void {
  marker.onDispose(() => {
    const list = terminalTurnMarks.get(sessionId);
    if (!list) return;
    const remaining = list.filter((mark) => mark.marker !== marker);
    if (remaining.length === list.length) return;
    if (remaining.length === 0) terminalTurnMarks.delete(sessionId);
    else terminalTurnMarks.set(sessionId, remaining);
    emitTurnMarks(sessionId);
  });
}

function placeTurnMark(
  sessionId: string,
  term: Terminal,
  label: string,
  at: number,
  scrollbackOffset?: number,
): void {
  const marker = term.registerMarker(0);
  if (!marker) return;

  const next = terminalTurnMarks.get(sessionId) ?? pruneTurnMarks(sessionId);
  const entry: SessionTurnMark = { marker, label, at };
  if (scrollbackOffset !== undefined) entry.scrollbackOffset = scrollbackOffset;
  next.push(entry);
  terminalTurnMarks.set(sessionId, next);
  bindMarkerDispose(sessionId, marker);

  while (next.length > MAX_TURN_MARKS_PER_SESSION) {
    const oldest = next.shift();
    oldest?.marker.dispose();
  }

  emitTurnMarks(sessionId);
}

export function noteTurnSubmit(
  sessionId: string,
  rawLabel: string,
  now = Date.now(),
  scrollbackOffset?: number,
): void {
  const term = resolveTurnTerminal(sessionId);
  if (!term) return;
  const buf = term.buffer.active;
  if (buf.type !== "normal") return;

  const label = turnLabelFrom(rawLabel);
  const currentLine = buf.baseY + buf.cursorY;
  const kept = pruneTurnMarks(sessionId);
  if (!shouldMarkTurn({ label, currentLine, now, last: lastKeptMark(kept) })) return;

  placeTurnMark(sessionId, term, label, now, scrollbackOffset);
}

/** Synthetic mark at the initial-replay boundary. Bypasses shouldMarkTurn. */
export function noteRestoreBoundaryTurn(sessionId: string, now = Date.now()): void {
  const term = resolveTurnTerminal(sessionId);
  if (!term) return;
  const buf = term.buffer.active;
  if (buf.type !== "normal") return;
  placeTurnMark(sessionId, term, RESTORE_BOUNDARY_LABEL, now);
}

export interface RestoredTurnMark {
  /** Absolute buffer line the prompt was found on. */
  line: number;
  label: string;
  at: number;
}

/**
 * Place marks for prompts that were typed before mycmux was watching.
 *
 * Unlike `noteTurnSubmit` these are not live submits: the line comes from
 * matching the transcript against the redrawn buffer, so `shouldMarkTurn`
 * (which reasons about the cursor and submit timing) does not apply. Marks are
 * merged with whatever is already there — the restore boundary in particular —
 * and the list is kept sorted by line so the chip still walks it in order.
 *
 * Returns how many marks were actually registered.
 */
export function restoreTurnMarksAtLines(
  sessionId: string,
  term: Terminal,
  entries: readonly RestoredTurnMark[],
): number {
  const buf = term.buffer.active;
  if (buf.type !== "normal") return 0;
  const cursorLine = buf.baseY + buf.cursorY;
  const next = [...pruneTurnMarks(sessionId)];
  let placed = 0;
  for (const entry of entries) {
    if (!entry.label) continue;
    if (entry.line < 0 || entry.line >= buf.length) continue;
    const marker = term.registerMarker(entry.line - cursorLine);
    if (!marker || marker.isDisposed || marker.line < 0) continue;
    next.push({ marker, label: entry.label, at: entry.at });
    bindMarkerDispose(sessionId, marker);
    placed += 1;
  }
  if (placed === 0) return 0;

  next.sort((left, right) => left.marker.line - right.marker.line);
  // Publish the capped list before disposing the overflow: marker disposal
  // rewrites whatever `terminalTurnMarks` currently holds for this session.
  const excess = Math.max(0, next.length - MAX_TURN_MARKS_PER_SESSION);
  terminalTurnMarks.set(sessionId, next.slice(excess));
  for (let index = 0; index < excess; index += 1) {
    next[index]?.marker.dispose();
  }
  emitTurnMarks(sessionId);
  return placed;
}

export function capTurnMarkPersistSnapshots(
  snapshots: readonly TurnMarkPersistSnapshot[],
): TurnMarkPersistSnapshot[] {
  const capped = snapshots.length > TURN_MARK_PERSIST_MAX
    ? snapshots.slice(snapshots.length - TURN_MARK_PERSIST_MAX)
    : snapshots;
  return capped.map((entry) => ({
    label: entry.label.slice(0, TURN_MARK_PERSIST_LABEL_MAX),
    at: entry.at,
    lines_from_bottom: entry.lines_from_bottom,
  }));
}

/** Live marks → persist DTO. Null when this session has no terminal to measure against. */
export function getTurnMarkPersistSnapshot(sessionId: string): TurnMarkPersistSnapshot[] | null {
  const term = resolveTurnTerminal(sessionId);
  if (!term) return null;
  const kept = pruneTurnMarks(sessionId);
  if (kept.length === 0) return [];
  const bottom = term.buffer.active.length - 1;
  return capTurnMarkPersistSnapshots(
    kept.map((mark) => ({
      label: mark.label,
      at: mark.at,
      lines_from_bottom: Math.max(0, bottom - mark.marker.line),
    })),
  );
}

/** Persist DTO → in-memory seed consumed by reanchorTurnMarks after replay. */
export function seedTurnMarkSnapshots(
  sessionId: string,
  snapshots: readonly TurnMarkPersistSnapshot[] | null | undefined,
): void {
  if (!snapshots || snapshots.length === 0) {
    turnMarkSnapshots.delete(sessionId);
    return;
  }
  turnMarkSnapshots.set(
    sessionId,
    capTurnMarkPersistSnapshots(snapshots).map((entry) => ({
      label: entry.label,
      at: entry.at,
      linesFromBottom: entry.lines_from_bottom,
    })),
  );
}

export function __resetTurnMarkSnapshotsForTests(): void {
  turnMarkSnapshots.clear();
}

/** Call immediately before term.reset(). Live marks are saved bottom-relative. */
export function snapshotTurnMarksForReset(sessionId: string, term: Terminal): void {
  const kept = pruneTurnMarks(sessionId);
  if (kept.length === 0) return;
  const buf = term.buffer.active;
  const bottom = buf.length - 1;
  turnMarkSnapshots.set(
    sessionId,
    kept.map((mark) => ({
      label: mark.label,
      at: mark.at,
      linesFromBottom: bottom - mark.marker.line,
      scrollbackOffset: mark.scrollbackOffset,
    })),
  );
  terminalTurnMarks.delete(sessionId);
}

/** Call after replay write finishes. No-op if snapshotTurnMarksForReset was not called. */
export function reanchorTurnMarks(sessionId: string, term: Terminal): void {
  const snapshot = turnMarkSnapshots.get(sessionId);
  turnMarkSnapshots.delete(sessionId);
  if (!snapshot || snapshot.length === 0) return;

  const buf = term.buffer.active;
  if (buf.type !== "normal") return;

  const bottom = buf.length - 1;
  const cursorLine = buf.baseY + buf.cursorY;
  const restored: SessionTurnMark[] = [];
  for (const entry of snapshot) {
    const line = bottom - entry.linesFromBottom;
    if (line < 0 || line >= buf.length) continue;
    const marker = term.registerMarker(line - cursorLine);
    if (!marker || marker.isDisposed || marker.line < 0) continue;
    const mark: SessionTurnMark = { marker, label: entry.label, at: entry.at };
    if (entry.scrollbackOffset !== undefined) mark.scrollbackOffset = entry.scrollbackOffset;
    bindMarkerDispose(sessionId, marker);
    restored.push(mark);
  }
  restored.sort((left, right) => left.marker.line - right.marker.line);
  if (restored.length > 0) terminalTurnMarks.set(sessionId, restored);
  else terminalTurnMarks.delete(sessionId);
  emitTurnMarks(sessionId);
}

export function noteTurnInput(sessionId: string, data: string, scrollbackOffset?: number): void {
  const draft = turnDrafts.get(sessionId) ?? EMPTY_DRAFT;
  const sanitized = sanitizeTurnInput(data, draft);
  if (sanitized !== null) {
    const { segments, count } = splitSubmits(sanitized);
    if (count > 0) {
      noteTurnSubmit(sessionId, `${draft.text}${segments[0] ?? ""}`, Date.now(), scrollbackOffset);
      for (let index = 1; index < segments.length; index += 1) {
        noteTurnSubmit(sessionId, segments[index] ?? "", Date.now(), scrollbackOffset);
      }
    }
  }
  turnDrafts.set(sessionId, applyInputToDraft(draft, data));
}

export function clearTurnDraft(sessionId: string): void {
  turnDrafts.delete(sessionId);
}

/** CR/LF stay so splitSubmits can see them; ESC sequences are dropped. */
function sanitizeTurnInput(data: string, draft: InputLineDraft): string | null {
  const state: VtInputScanState = { pending: draft.pending, inPaste: draft.inPaste };
  const tokens = scanVtInput(data, state);
  let sawText = false;
  let inPaste = draft.inPaste;
  let sanitized = "";
  for (const token of tokens) {
    if (token.kind === "sequence") {
      if (token.value === "\x1b[200~") inPaste = true;
      else if (token.value === "\x1b[201~") inPaste = false;
      continue;
    }
    sawText = true;
    sanitized += inPaste ? token.value.replace(/[\r\n]+/g, " ") : token.value;
  }
  return sawText ? sanitized : null;
}

export function getTurnMarkData(sessionId: string): TurnMarkData[] {
  return pruneTurnMarks(sessionId)
    .map((mark) => ({ line: mark.marker.line, label: mark.label, at: mark.at }))
    .sort((left, right) => left.line - right.line);
}

export function clearTurnMarks(sessionId: string): void {
  clearTurnDraft(sessionId);
  const marks = terminalTurnMarks.get(sessionId);
  if (!marks) return;
  terminalTurnMarks.delete(sessionId);
  for (const mark of marks) {
    mark.marker.dispose();
  }
}

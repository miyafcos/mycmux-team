/**
 * Tracks what the user has typed into the current input line of a session.
 *
 * The PTY owns the real line editor, so the app can never read the line back.
 * Mirroring the keystrokes we forward gets close enough for two jobs: knowing
 * how many characters a "clear the line" gesture has to erase, and offering to
 * put the text back if the gesture was a mistake. Anything we cannot model
 * (cursor movement, history recall, embedded newlines) drops the draft to
 * `clean: false`, and callers fall back to a bounded erase with no undo rather
 * than replaying text that may not match the screen.
 */

export interface InputLineDraft {
  text: string;
  /** False once an unmodelled edit means `text` may no longer match the line. */
  clean: boolean;
}

/** Longer than any prompt a person types by hand; past this we stop mirroring. */
const MAX_DRAFT_LENGTH = 4000;
/** Erase budget when the draft is unusable. Backspace at column 0 is a no-op. */
export const BLIND_ERASE_COUNT = 500;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const DELETE = "\x7f";
const KILL_LINE = "\x15";

export const EMPTY_DRAFT: InputLineDraft = { text: "", clean: true };

function isPrintable(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

export function applyInputToDraft(draft: InputLineDraft, data: string): InputLineDraft {
  // Bracketed paste markers wrap ordinary text; keeping the payload is what
  // makes the gesture useful for the case it exists for (a long pasted prompt).
  const input = data.split(PASTE_START).join("").split(PASTE_END).join("");
  let { text, clean } = draft;

  for (const character of input) {
    if (character === "\r" || character === "\n") {
      text = "";
      clean = true;
      continue;
    }
    if (character === DELETE || character === "\b") {
      text = text.slice(0, -1);
      continue;
    }
    if (character === KILL_LINE) {
      // Ctrl+U kills the line in every editor we drive, so the mirror stays exact.
      text = "";
      continue;
    }
    if (isPrintable(character)) {
      text += character;
      if (text.length > MAX_DRAFT_LENGTH) clean = false;
      continue;
    }
    clean = false;
  }
  return { text, clean };
}

/** Keystrokes that erase the line described by `draft`. */
export function eraseSequenceFor(draft: InputLineDraft): string {
  const count = draft.clean && draft.text.length > 0
    ? Math.min(draft.text.length, MAX_DRAFT_LENGTH)
    : BLIND_ERASE_COUNT;
  return DELETE.repeat(count);
}

/** Text to restore, or null when replaying it could desynchronise the line. */
export function restorableText(draft: InputLineDraft): string | null {
  return draft.clean && draft.text.length > 0 ? draft.text : null;
}

const draftsBySession = new Map<string, InputLineDraft>();

export function observeSessionInput(sessionId: string, data: string): void {
  draftsBySession.set(sessionId, applyInputToDraft(draftsBySession.get(sessionId) ?? EMPTY_DRAFT, data));
}

export function sessionDraft(sessionId: string): InputLineDraft {
  return draftsBySession.get(sessionId) ?? EMPTY_DRAFT;
}

export function resetSessionDraft(sessionId: string): void {
  draftsBySession.set(sessionId, EMPTY_DRAFT);
}

export function forgetSessionDraft(sessionId: string): void {
  draftsBySession.delete(sessionId);
}

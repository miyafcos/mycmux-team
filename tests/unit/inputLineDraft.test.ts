import { describe, expect, it } from "vitest";

import {
  applyInputToDraft,
  BLIND_ERASE_COUNT,
  EMPTY_DRAFT,
  eraseSequenceFor,
  restorableText,
} from "../../src/lib/inputLineDraft";

const DELETE = "\x7f";

function typed(...chunks: string[]) {
  return chunks.reduce((draft, chunk) => applyInputToDraft(draft, chunk), EMPTY_DRAFT);
}

describe("input line draft", () => {
  it("mirrors printable typing and backspaces", () => {
    expect(typed("git statuu", DELETE, "s")).toEqual({ text: "git status", clean: true });
  });

  it("keeps the payload of a bracketed paste", () => {
    const draft = typed("\x1b[200~a long pasted prompt\x1b[201~");
    expect(draft).toEqual({ text: "a long pasted prompt", clean: true });
  });

  it("resets on submit so the next line starts empty", () => {
    expect(typed("hello", "\r")).toEqual({ text: "", clean: true });
  });

  it("treats Ctrl+U as an exact line kill", () => {
    expect(typed("hello", "\x15")).toEqual({ text: "", clean: true });
  });

  it("backspacing an empty line does not underflow", () => {
    expect(typed(DELETE, DELETE)).toEqual({ text: "", clean: true });
  });

  it("gives up on cursor movement it cannot model", () => {
    const draft = typed("hello", "\x1b[D", "x");
    expect(draft.clean).toBe(false);
    expect(restorableText(draft)).toBeNull();
  });

  it("recovers cleanliness once the line is submitted", () => {
    const draft = typed("hello", "\x1b[D", "\r", "next");
    expect(draft).toEqual({ text: "next", clean: true });
  });

  it("erases exactly as many characters as it mirrored", () => {
    expect(eraseSequenceFor(typed("abcde"))).toBe(DELETE.repeat(5));
  });

  it("falls back to a bounded blind erase when the mirror is unreliable", () => {
    const draft = typed("hello", "\x1b[D");
    expect(eraseSequenceFor(draft)).toBe(DELETE.repeat(BLIND_ERASE_COUNT));
  });

  it("blind-erases an empty draft rather than sending nothing", () => {
    expect(eraseSequenceFor(EMPTY_DRAFT)).toBe(DELETE.repeat(BLIND_ERASE_COUNT));
    expect(restorableText(EMPTY_DRAFT)).toBeNull();
  });

  it("stops mirroring past the draft cap", () => {
    const draft = typed("x".repeat(4001));
    expect(draft.clean).toBe(false);
  });
});

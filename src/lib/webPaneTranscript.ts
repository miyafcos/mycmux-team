/**
 * Turning what a Web pane shows into the transcript shape the dashboard reads.
 *
 * A Web tab has no PTY, so livebrief -- the source every other chat column
 * reads -- knows nothing about it: the conversation is readable in the pane
 * itself and nowhere else. `webpane_read` returns the turns the page is
 * displaying, and this module maps them onto `SemanticEventEnvelope` so one
 * ChatTranscript renders both without learning a second shape.
 *
 * The page carries no timestamps. Rather than invent one per read (which would
 * make every bubble jump to "now" on each poll), a turn keeps the moment it was
 * first seen and only new or still-growing turns take the current clock. The
 * first read of an old conversation therefore stamps everything with that read,
 * which is why the column states when it fetched.
 */
import type { SemanticEventEnvelope } from "./livebrief";

export interface WebPaneTurn {
  role: "user" | "assistant";
  text: string;
}

function envelope(tabId: string, index: number, turn: WebPaneTurn, occurredAt: number): SemanticEventEnvelope {
  return {
    eventId: `webpane:${tabId}:${index}`,
    sourceRevision: 0,
    occurredAt,
    sourceByteStart: 0,
    sourceByteEnd: 0,
    kind: turn.role === "user"
      // `taskChange` is the neutral user-turn kind: the dashboard reads the
      // kind to label intent, and a Web page never states one.
      ? { type: "userMessage", kind: "taskChange", text: turn.text, digest: "" }
      : { type: "agentMessage", text: turn.text },
  };
}

function sameTurn(previous: SemanticEventEnvelope | undefined, turn: WebPaneTurn): boolean {
  if (!previous) return false;
  if (turn.role === "user") {
    return previous.kind.type === "userMessage" && previous.kind.text === turn.text;
  }
  return previous.kind.type === "agentMessage" && previous.kind.text === turn.text;
}

/**
 * Merge a fresh read into what the column already showed, keeping the
 * first-seen time -- and the object identity -- of every leading turn that did
 * not change. Matching runs from the start, which is where a conversation is
 * stable; the turn being streamed sits at the end and is meant to re-stamp.
 *
 * When the reader drops older turns (its character budget is finite) the
 * leading turns no longer line up and the visible ones are re-stamped with this
 * read. That is the honest answer: the column can only say when it saw them.
 */
export function mergeWebPaneTurns(
  previous: readonly SemanticEventEnvelope[],
  turns: readonly WebPaneTurn[],
  tabId: string,
  now: number,
): SemanticEventEnvelope[] {
  const merged: SemanticEventEnvelope[] = [];
  let carrying = true;
  for (const [index, turn] of turns.entries()) {
    const carried = carrying ? previous[index] : undefined;
    if (carried && sameTurn(carried, turn)) {
      merged.push(carried);
      continue;
    }
    carrying = false;
    merged.push(envelope(tabId, index, turn, now));
  }
  return merged;
}

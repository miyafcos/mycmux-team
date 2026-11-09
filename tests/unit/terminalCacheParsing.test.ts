import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginTerminalBufferWrite, isTerminalBufferWritePending, isTerminalParsingCurrentOutput,
  liveTerms, markTerminalBufferReady, pendingTerminalBufferWrites, registerCurrentOutputParser,
  termCache, type CachedTerm,
} from "../../src/components/terminal/terminalCache";
import {
  __resetPtyReadGenerationsForTests, invalidatePtyReads, ptyReadGeneration, retainPtyReads,
} from "../../src/lib/ptyReadGeneration";

let release: () => void;
let finish: ((parsed: boolean) => boolean)[] = [];
const sessionId = "pending-parse-fixture";
const term = () => liveTerms.get(sessionId)!;
function submit() {
  const done = beginTerminalBufferWrite(sessionId, term(), ptyReadGeneration(sessionId));
  finish.push(done); return done;
}
beforeEach(() => {
  __resetPtyReadGenerationsForTests();
  release = retainPtyReads(sessionId);
  liveTerms.set(sessionId, {} as CachedTerm["term"]);
  markTerminalBufferReady(term());
  // XTermWrapper's real pump also returns false while a batch is parsing.
  registerCurrentOutputParser(sessionId, term(), () => !pendingTerminalBufferWrites(term(), ptyReadGeneration(sessionId)));
});
afterEach(() => {
  finish.forEach(done => done(false)); finish = [];
  liveTerms.clear(); termCache.clear(); release(); __resetPtyReadGenerationsForTests();
});
describe("read-only pending parse classification", () => {
  it("recognizes only an existing parsed current terminal's submitted write without authorizing a read", () => {
    expect(isTerminalParsingCurrentOutput(sessionId)).toBe(true);
    expect(isTerminalBufferWritePending(sessionId)).toBe(false);
    const done = submit();
    expect(isTerminalParsingCurrentOutput(sessionId)).toBe(false);
    expect(isTerminalBufferWritePending(sessionId)).toBe(true);
    expect(pendingTerminalBufferWrites(term(), ptyReadGeneration(sessionId))).toBe(1);
    expect(isTerminalParsingCurrentOutput(sessionId)).toBe(false);
    done(true);
    expect(isTerminalBufferWritePending(sessionId)).toBe(false);
    expect(isTerminalParsingCurrentOutput(sessionId)).toBe(true);
  });
  it.each(["missing", "cached", "unready", "failed", "generation", "unregistered", "parked"])(
    "does not mistake a %s terminal for a temporary parse backlog", reason => {
      if (reason === "unready" || reason === "unregistered") {
        liveTerms.set(sessionId, {} as CachedTerm["term"]);
        if (reason === "unregistered") markTerminalBufferReady(term());
        else registerCurrentOutputParser(sessionId, term(), () => true);
      }
      if (reason === "generation") invalidatePtyReads(sessionId, true);
      if (reason !== "parked") submit();
      if (reason === "missing") liveTerms.delete(sessionId);
      if (reason === "cached") termCache.set(sessionId, { term: term() } as CachedTerm);
      if (reason === "failed") { submit()(false); }
      if (reason === "parked") registerCurrentOutputParser(sessionId, term(), () => false);
      expect(isTerminalBufferWritePending(sessionId)).toBe(false);
      expect(isTerminalParsingCurrentOutput(sessionId)).toBe(false);
    });
});

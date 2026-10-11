import { afterEach, expect, it } from "vitest";
// @ts-expect-error Published ESM has no adjacent declarations.
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import type { Terminal as RendererTerminal } from "@xterm/xterm";
import { __inspectPtyReadsForTests, ptyReadGeneration, replacePtyReadOwners } from "../../src/lib/ptyReadGeneration";
import { isTerminalParsingCurrentOutput, liveTerms, markTerminalBufferReady, pendingTerminalBufferWrites } from "../../src/components/terminal/terminalCache";
import { xtermInitialReplayWrite, xtermWritePump } from "../fixtures/xtermWritePump";

const owner = Symbol("live replay fixture");
let term: RendererTerminal | undefined, pump: ReturnType<typeof xtermWritePump> | undefined;
afterEach(() => {
  pump?.dispose(); term?.dispose(); liveTerms.delete("replay-throw");
  replacePtyReadOwners(owner, new Set());
});

it("retires a thrown actual initial-replay submission without reviving previous parser proof", async () => {
  const id = "replay-throw";
  replacePtyReadOwners(owner, new Set([id]));
  term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true }) as RendererTerminal;
  liveTerms.set(id, term);
  await new Promise<void>(resolve => term!.write("old screen", () => { markTerminalBufferReady(term!); resolve(); }));
  pump = xtermWritePump(id, term);
  expect(isTerminalParsingCurrentOutput(id)).toBe(true);
  const write = term.write.bind(term), generation = ptyReadGeneration(id);
  // Explicit synchronous submission failure; parsing/authority remain real.
  term.write = () => { throw new Error("xterm submission failed"); };
  await expect(xtermInitialReplayWrite(id, term, "new screen")).rejects.toThrow("xterm submission failed");
  expect(pendingTerminalBufferWrites(term, generation)).toBe(0);
  expect(__inspectPtyReadsForTests().operations.has(id)).toBe(false);
  expect(isTerminalParsingCurrentOutput(id)).toBe(false);
  term.write = write;
  // A subsequent successful same-generation parse cannot certify that the
  // failed submission's bytes were parsed.
  await xtermInitialReplayWrite(id, term, "later screen");
  expect(isTerminalParsingCurrentOutput(id)).toBe(false);
  pump.dispose(); replacePtyReadOwners(owner, new Set());
  expect(__inspectPtyReadsForTests().generations).not.toContain(id);
});

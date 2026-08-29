import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../../src/components/terminal/XTermWrapper.tsx", import.meta.url)),
  "utf8",
);

describe("XTermWrapper turn-chip lifecycle wiring", () => {
  it("classifies transcript panes from every stable launch signal", () => {
    expect(source).toMatch(/const hasTurnTranscript = startsAsAgentTui\(/);
    expect(source).toContain("hasTranscript: hasTurnTranscript");
  });

  it("clears list rows and remounts list-local state at a session boundary", () => {
    expect(source).toMatch(/useEffect\(\(\) => \{[\s\S]*?setTurnListRows\(\[\]\);[\s\S]*?\}, \[sessionId\]\);/);
    expect(source).toContain("key={sessionId}");
  });

  it("keeps the opening mark snapshot when a reset temporarily removes live marks", () => {
    expect(source).toContain("const listMarks = latestMarks.length > 0 ? latestMarks : marks");
  });

  it("pins the chip while the history list is open", () => {
    expect(source).toContain("turnChipVisibilityRef.current?.setPinned(open)");
    expect(source).toContain("onListVisibilityChange={setTurnListOpen}");
  });
});

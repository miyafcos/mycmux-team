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

  it("routes both the arrows and the list rows through one jump decision", () => {
    // Both used to decide for themselves, and the mark handler bailed out of
    // transcript mode entirely.
    expect(source).toContain("const action = resolveTurnJump(intent, {");
    expect(source).toMatch(/const jumpTurn = useCallback\(\(direction: -1 \| 1\) => \{\s*runTurnJump\(\{ kind: "step", direction \}\);/);
    expect(source).toMatch(/const jumpTurnToMark = useCallback\(\(markIndex: number\) => \{\s*runTurnJump\(\{ kind: "mark", markIndex \}\);/);
    expect(source).not.toContain('if (lastTurnChipRef.current?.mode === "transcript") return;');
  });

  it("keeps a turn jump inside the pane and opens the reader for it", () => {
    // Only the reader's own link may open the Dashboard now; a jump queues the
    // request and shows the transcript here.
    expect(source).toContain("queueTranscriptTurnRequest(tabId, payload)");
    expect(source).toMatch(/if \(applyTranscriptTurnPayload\(sessionId, action\.payload\)\) setTranscriptPanelOpen\(true\)/);
    expect(source.match(/openTranscriptTurnRequest/gu) ?? []).toHaveLength(1);
  });

  it("drops the reader when the pane switches session", () => {
    expect(source).toContain("useEffect(() => setTranscriptPanelOpen(false), [sessionId]);");
  });

  it("pins the chip while the history list is open", () => {
    expect(source).toContain("turnChipVisibilityRef.current?.setPinned(open)");
    expect(source).toContain("onListVisibilityChange={setTurnListOpen}");
  });
});

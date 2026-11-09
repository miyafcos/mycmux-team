import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cropLiveTail, isLiveTailDoneRow, liveTailBodyRows } from "../../src/lib/liveTail/crop";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/liveTail/screens2141.json", import.meta.url), "utf8")) as {
  seats: { agent: string; rounds: { rows: string[]; expected: { state: string; marker: string } }[] }[];
};
describe("additional tab evidence without changing existing crop values", () => {
  it.each([
    ["claude", ["answer", "✻ Churned for 1m 20s · done 15:21"], 80],
    ["claude-codex", ["answer", "* Worked for 2h 1m 3s · done 01:00"], 7263],
    ["codex", ["answer", "Worked for 16s • 12:56"], 16],
    ["codex", ["answer", "Worked for 1h 56m 45s • 20:52"], 7005],
  ] as const)("parses the original %s completion duration", (agent, rows, seconds) => {
    expect(cropLiveTail(rows, agent).doneElapsedSec).toBe(seconds);
    expect(cropLiveTail(rows, agent).elapsedSec).toBeNull();
  });
  it("adds null elapsed completion evidence to working, error, empty and unknown screens", () => {
    for (const seat of fixture.seats) for (const round of seat.rounds) {
      const result = cropLiveTail(round.rows, seat.agent);
      if (result.state !== "done") expect(result.doneElapsedSec).toBeNull();
      const { doneElapsedSec: _elapsed, ...unchanged } = result;
      expect(unchanged).toMatchObject(round.expected);
    }
    expect(cropLiveTail([], "claude").doneElapsedSec).toBeNull();
    expect(cropLiveTail(["unchanged"], "shell").doneElapsedSec).toBeNull();
  });
  it("removes Claude input boxes and hints while keeping original whitespace", () => {
    const rows = ["old", "  answer  ", "", "✻ Churned for 1m 20s · done 15:21", "new task? /help",
      "────────────────", "❯ private draft", "────────────────", "-- INSERT --"];
    expect(liveTailBodyRows(rows, "claude", 2)).toEqual(["  answer  ", "✻ Churned for 1m 20s · done 15:21"]);
    expect(liveTailBodyRows(rows, "claude-codex", 1)).toEqual([rows[3]]);
  });
  it("removes Codex input/footer chrome before choosing the last N nonempty rows", () => {
    const rows = ["old", "  • Ran cargo test  ", "", "└ 12 passed ", "Worked for 16s • 12:56", "› private draft", "Context 42% used", "5 Ready", ""];
    expect(liveTailBodyRows(rows, "codex", 3)).toEqual([rows[1], rows[3], rows[4]]);
  });
  it("takes up to eight actual body rows from every captured screen", () => {
    for (const seat of fixture.seats) for (const round of seat.rounds) {
      const body = liveTailBodyRows(round.rows, seat.agent, 8);
      expect(body.length).toBeLessThanOrEqual(8);
      expect(body.every(row => row.trim() && round.rows.includes(row))).toBe(true);
      if (seat.agent === "claude") expect(body.some(row => /^─{8,}|^❯$|^-- INSERT/.test(row))).toBe(false);
    }
  });
  it("preserves unknown-agent whitespace and handles empty/zero/negative limits", () => {
    expect(liveTailBodyRows(["old", "  keep  ", "", "\tlast ", " "], "shell", 2)).toEqual(["  keep  ", "\tlast "]);
    for (const max of [0, -1, 0.5, Number.NaN]) expect(liveTailBodyRows(["keep"], "codex", max)).toEqual([]);
    expect(liveTailBodyRows([], "claude", 8)).toEqual([]);
  });
});

describe("completion-row classification for the tab strip", () => {
  it.each([
    ["claude", "✻ Brewed for 6s · done 15:13", true],
    ["claude", "  ✻ Brewed for 6s · done 15:13  ", true],
    ["claude-codex", "\t* Worked for 2h 1m 3s · done 01:00 ", true],
    ["codex", "Worked for 16s • 12:56", true],
    ["codex", "  Worked for 1h 56m 45s • 20:52\t", true],
    ["claude", "· Generating… (9s · ↓ 19 tokens)", false],
    ["codex", "• Working (9s • esc to interrupt)", false],
    ["claude", "⎿  Running…", false],
    ["claude", "ordinary output", false],
    ["codex", "ordinary output", false],
    ["claude", "Worked for 16s • 12:56", false],
    ["codex", "✻ Brewed for 6s · done 15:13", false],
    ["shell", "✻ Brewed for 6s · done 15:13", false],
    [null, "Worked for 16s • 12:56", false],
    ["claude", "  ", false],
  ] as const)("classifies %s row %j as done=%s", (agent, row, done) => {
    expect(isLiveTailDoneRow(row, agent)).toBe(done);
  });
});

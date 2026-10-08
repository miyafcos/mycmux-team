import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cropLiveTail } from "../../src/lib/liveTail/crop";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/liveTail/screens2141.json", import.meta.url), "utf8"));

describe("live tail crop: independently captured prototype expectations", () => {
  for (const seat of fixture.seats) {
    seat.rounds.forEach((round: { rows: string[]; expected: object }, index: number) => {
      it(`seat ${seat.index}, round ${index}: exact original rows and parsed evidence`, () => {
        const result = cropLiveTail(round.rows, seat.agent);
        expect(result).toMatchObject(round.expected);
        expect(result.rows.length).toBeLessThanOrEqual(3);
        for (const row of result.rows) expect(round.rows).toContain(row);
      });
    });
  }

  it("has the specified population in the last round", () => {
    const counts: Record<string, number> = {};
    let readable = 0;
    for (const seat of fixture.seats) {
      const crop = cropLiveTail(seat.rounds.at(-1).rows, seat.agent);
      counts[crop.state] = (counts[crop.state] ?? 0) + 1;
      readable += Number(crop.readable);
    }
    expect(readable).toBe(27);
    expect(counts).toEqual({ working: 8, done: 18, error: 1, unreadable: 2 });
  });

  it("keeps indentation and trailing spaces for other terminal kinds", () => {
    expect(cropLiveTail(["old", "  first  ", "", "second", "\tthird ", " "], "shell")).toMatchObject({
      readable: true, state: "unknown", rows: ["  first  ", "second", "\tthird "], marker: null,
    });
  });

  it("does not mistake an older spinner above a completed turn for current work", () => {
    const rows = ["* Thinking\u2026 (1s \u00b7 \u2193 10 tokens)", "answer", "* Cooked for 2s \u00b7 done 01:00"];
    expect(cropLiveTail(rows, "claude").state).toBe("done");
  });

  it("makes an empty or missing marker unreadable", () => {
    expect(cropLiveTail([], "claude")).toMatchObject({ readable: false, state: "unreadable" });
    expect(cropLiveTail(["plain response"], "codex")).toMatchObject({ readable: false, state: "unreadable" });
  });
});

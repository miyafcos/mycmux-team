import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cropLiveTail } from "../../src/lib/liveTail/crop";
import { advanceLiveTailEvidence, factForLiveTailEvidence, fingerprintLiveTail, type LiveTailEvidence } from "../../src/lib/liveTail/facts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/liveTail/recording.json", import.meta.url), "utf8"));

describe("36-round, six-minute offline recording", () => {
  it("never freezes a seat whose PTY timestamp advanced and never renews progress on animation alone", () => {
    const counts: Record<string, number> = {};
    let observations = 0, advancing = 0, animation = 0;
    for (const seat of fixture.seats) {
      let evidence: LiveTailEvidence | undefined;
      for (const round of seat.rounds) {
        const before = evidence;
        const crop = cropLiveTail(round.rows, seat.agent);
        evidence = advanceLiveTailEvidence(before, { crop, rawRows: round.rows, observedAt: round.observedAt, lastOutputAt: round.lastOutputAt });
        const fact = factForLiveTailEvidence(evidence);
        counts[fact.kind] = (counts[fact.kind] ?? 0) + 1; observations += 1;
        if (before && round.lastOutputAt > (before.observation.lastOutputAt ?? 0)) {
          advancing += 1;
          expect(fact.kind, `seat ${seat.index}, round ${round.round}: advancing PTY`).not.toBe("frozen");
        }
        if (before && before.observation.crop.state === "working" && crop.state === "working"
          && fingerprintLiveTail(crop) === fingerprintLiveTail(before.observation.crop)
          && crop.tokens === before.observation.crop.tokens && crop.tool?.outputLines === before.observation.crop.tool?.outputLines
          && JSON.stringify(round.rows) !== JSON.stringify(before.observation.rawRows)) {
          animation += 1;
          expect(evidence.lastProgressAt, `seat ${seat.index}, round ${round.round}: animation only`).toBe(before.lastProgressAt);
        }
      }
    }
    expect(observations).toBe(252); expect(advancing).toBe(110); expect(animation).toBe(65);
    expect(counts).toEqual({ alive: 18, cmd: 28, progress: 68, unreadable: 41, idle: 28, frozen: 69 });
  });
  for (const index of [4, 6]) {
    it(`seat ${index}: a silent PTY and unchanged actual screen freeze at round 2, with no invented progress`, () => {
      let evidence: LiveTailEvidence | undefined;
      for (const round of fixture.seats[index].rounds) {
        evidence = advanceLiveTailEvidence(evidence, { crop: cropLiveTail(round.rows, fixture.seats[index].agent),
          rawRows: round.rows, observedAt: round.observedAt, lastOutputAt: round.lastOutputAt });
        expect(factForLiveTailEvidence(evidence).kind).toBe(round.round < 2 ? "alive" : "frozen");
        expect(evidence.lastProgressAt).toBeNull();
      }
    });
  }
});

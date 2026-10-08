import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cropLiveTail } from "../../src/lib/liveTail/crop";
import {
  deriveLiveTailFact, fingerprintLiveTail, FROZEN_WINDOW_MS, PROGRESS_WINDOW_MS, STALE_WINDOW_MS,
  type LiveTailObservation,
} from "../../src/lib/liveTail/facts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/liveTail/screens2141.json", import.meta.url), "utf8"));
const expected: Record<number, string> = { 2: "cmd", 4: "unreadable", 5: "unreadable", 6: "progress", 11: "progress", 12: "progress", 13: "error", 14: "progress", 16: "frozen", 25: "frozen", 28: "progress" };
const start = 1_800_000_000_000;

function obs(ms: number, rawRows: string[], output = start + ms, agent = "claude"): LiveTailObservation {
  return { observedAt: start + ms, rawRows, lastOutputAt: output, crop: cropLiveTail(rawRows, agent) };
}
function spinner(seconds: number, glyph = "*", tokens = 100): string[] {
  return [`${glyph} Thinking\u2026 (${seconds}s \u00b7 \u2193 ${tokens} tokens)`];
}

afterEach(() => vi.useRealTimers());

describe("21:41 facts from three actual observations", () => {
  for (const seat of fixture.seats) {
    it(`seat ${seat.index}: ${expected[seat.index] ?? "idle"}`, () => {
      const history = seat.rounds.map((r: { observedAt: number; rows: string[] }) => ({
        observedAt: r.observedAt, rawRows: r.rows, lastOutputAt: seat.lastOutputAt, crop: cropLiveTail(r.rows, seat.agent),
      }));
      expect(deriveLiveTailFact(history).kind).toBe(expected[seat.index] ?? "idle");
    });
  }
  it("reproduces every specified category count", () => {
    const counts: Record<string, number> = {};
    for (const seat of fixture.seats) {
      const kind = deriveLiveTailFact(seat.rounds.map((r: { observedAt: number; rows: string[] }) => ({
        observedAt: r.observedAt, rawRows: r.rows, lastOutputAt: seat.lastOutputAt, crop: cropLiveTail(r.rows, seat.agent),
      }))).kind;
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    expect(counts).toEqual({ idle: 18, progress: 5, cmd: 1, frozen: 2, unreadable: 2, error: 1 });
  });
});

describe("fact thresholds and animation-only changes", () => {
  it("fixes the windows at 60s / 180s / 20s", () => {
    expect([PROGRESS_WINDOW_MS, STALE_WINDOW_MS, FROZEN_WINDOW_MS]).toEqual([60_000, 180_000, 20_000]);
  });
  it("does not claim progress on the first observation", () => {
    expect(deriveLiveTailFact([obs(0, spinner(1))]).kind).toBe("alive");
  });
  it("becomes stale after 180 seconds of spinner and duration changes with PTY output", () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const history: LiveTailObservation[] = [obs(0, spinner(0))];
    for (let ms = 2_000; ms <= 180_000; ms += 2_000) {
      vi.setSystemTime(start + ms);
      history.push(obs(ms, spinner(ms / 1_000, ms % 4_000 ? "\u273d" : "*")));
    }
    expect(deriveLiveTailFact(history.slice(0, -1)).kind).toBe("alive");
    expect(deriveLiveTailFact(history).kind).toBe("stale");
  });
  it("requires both an identical screen for 20 seconds and a silent PTY", () => {
    const rows = spinner(1);
    expect(deriveLiveTailFact([obs(0, rows), obs(19_999, rows, start)]).kind).toBe("alive");
    expect(deriveLiveTailFact([obs(0, rows), obs(20_000, rows, start)]).kind).toBe("frozen");
    expect(deriveLiveTailFact([obs(0, rows), obs(20_000, rows, start + 20_000)]).kind).toBe("unreadable");
    const missing = [obs(0, rows), obs(20_000, rows)];
    missing.forEach((o) => { o.lastOutputAt = null; });
    expect(deriveLiveTailFact(missing).kind).not.toBe("frozen");
  });
  it("detects an old identical screen when the PTY advances, even before the frozen window", () => {
    expect(deriveLiveTailFact([obs(0, spinner(1)), obs(2_000, spinner(1))]).kind).toBe("unreadable");
  });
  it("records command waiting when only the command duration advances", () => {
    const rows = (s: number) => [`\u25cf Wait for report \u00b7 ${s}s`, "\u23bf  $ wait", ...spinner(s)];
    expect(deriveLiveTailFact([obs(0, rows(1)), obs(2_000, rows(3))])).toMatchObject({ kind: "cmd", toolElapsedSec: 3 });
  });
  it("expires progress exactly 60 seconds after its evidence, without renewing it on animation", () => {
    const history = [obs(0, spinner(0)), obs(2_000, spinner(2, "*", 101))];
    expect(deriveLiveTailFact([...history, obs(61_999, spinner(62, "\u273d", 101))]).kind).toBe("progress");
    expect(deriveLiveTailFact([...history, obs(62_000, spinner(63, "\u273d", 101))]).kind).toBe("alive");
  });
  it("counts an increase from zero command output lines as progress", () => {
    const rows = (n: number) => ["\u25cf Wait \u00b7 1s", "\u23bf  $ wait", `(1s \u00b7 ${n} lines)`, ...spinner(n + 1)];
    expect(deriveLiveTailFact([obs(0, rows(0)), obs(2_000, rows(1))]).kind).toBe("progress");
  });
  it("masks blinking dots, elapsed seconds, token units and Codex background hints", () => {
    const a = cropLiveTail(["\u25cf Wait \u00b7 1s", "\u23bf  $ wait", ...spinner(1, "*", 900)], "claude");
    const b = cropLiveTail(["  Wait \u00b7 20s", "\u23bf  $ wait", ...spinner(20, "\u273d", 1_200)], "claude");
    expect(fingerprintLiveTail(a)).toBe(fingerprintLiveTail(b));
    const cx = (rest: string) => cropLiveTail(["\u2022 Ran check", `\u2022 Working (1h 02m 03s \u2022 esc to interrupt)${rest}`], "codex");
    expect(fingerprintLiveTail(cx(""))).toBe(fingerprintLiveTail(cx(" \u00b7 1 background terminal running \u00b7 /ps\u2026")));
  });
  it("keeps real event text and a changed spinner verb as progress evidence", () => {
    expect(deriveLiveTailFact([obs(0, spinner(0)), obs(2_000, ["* Testing\u2026 (2s \u00b7 \u2193 100 tokens)"])]).kind).toBe("progress");
  });
});

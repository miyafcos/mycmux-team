import { describe, expect, it } from "vitest";
import { readAilogLastVisit, writeAilogLastVisit } from "../../src/lib/ailogLastVisit";

function storage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    raw: () => value,
  };
}

describe("ailog last visit storage", () => {
  it("rejects malformed data", () => {
    expect(readAilogLastVisit(storage("not json"))).toEqual({ lastVisitTs: null, readDigestDates: [], lastAnswers: {} });
  });

  it("persists only the allowed visit fields", () => {
    const target = storage();
    writeAilogLastVisit({ lastVisitTs: 123, readDigestDates: ["2026-08-17", "2026-08-17"], lastAnswers: { model: "得している" } }, target);
    expect(JSON.parse(target.raw()!)).toEqual({ lastVisitTs: 123, readDigestDates: ["2026-08-17"], lastAnswers: { model: "得している" } });
  });
});

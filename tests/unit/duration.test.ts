import { describe, expect, it } from "vitest";

import { formatElapsedMinutes, formatElapsedSince } from "../../src/lib/duration";

describe("formatElapsedMinutes", () => {
  it("keeps minutes below an hour", () => {
    expect(formatElapsedMinutes(0)).toBe("0分");
    expect(formatElapsedMinutes(59)).toBe("59分");
  });

  it("rolls up to hours, dropping a zero minute remainder", () => {
    expect(formatElapsedMinutes(60)).toBe("1時間");
    expect(formatElapsedMinutes(95)).toBe("1時間35分");
  });

  it("rolls up to days instead of printing an unreadable minute count", () => {
    // The field report: the watchdog queue showed "3900分".
    expect(formatElapsedMinutes(3900)).toBe("2日17時間");
    expect(formatElapsedMinutes(1440)).toBe("1日");
  });

  it("clamps negatives and fractions", () => {
    expect(formatElapsedMinutes(-5)).toBe("0分");
    expect(formatElapsedMinutes(90.9)).toBe("1時間30分");
  });
});

describe("formatElapsedSince", () => {
  it("converts a millisecond span", () => {
    expect(formatElapsedSince(3_600_000, 0)).toBe("1時間");
  });

  it("treats a future timestamp as zero", () => {
    expect(formatElapsedSince(0, 60_000)).toBe("0分");
  });
});

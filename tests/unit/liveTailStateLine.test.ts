import { describe, expect, it } from "vitest";
import { formatLiveTailAgo, formatLiveTailDuration, liveTailStateLine, type LiveTailStateLineInput } from "../../src/lib/liveTail/stateLine";
import type { LiveTailFactKind } from "../../src/lib/liveTail/facts";

const now = 1_800_000_000_000;
function input(kind: LiveTailFactKind = "alive", overrides: Partial<LiveTailStateLineInput> = {}): LiveTailStateLineInput {
  return { fact: { kind, sinceMs: now - 180_000, elapsedSec: null, tokens: null, toolElapsedSec: null, error: null },
    status: "unknown", attentionKind: null, attentionSince: null, cropState: null, now, ...overrides };
}
const result = (text: string, tone = "neutral", badge: string | null = null) => ({ text, tone, badge });

describe("live-tail state line priority S1-S14", () => {
  it("S1 input wins over progress, working and the crop", () => {
    expect(liveTailStateLine(input("progress", { status: "working", attentionKind: "input", attentionSince: now - 180_000, cropState: "working" })))
      .toEqual(result("回答待ち · 3分前から", "waiting", "回答待ち"));
  });
  it("S2 approval wins over screen error and waiting", () => {
    expect(liveTailStateLine(input("error", { status: "waiting", attentionKind: "approval", attentionSince: now - 180_000 })))
      .toEqual(result("承認待ち · 3分前から", "waiting", "承認待ち"));
  });
  it("S3 rate limit wins over screen error and waiting", () => {
    expect(liveTailStateLine(input("error", { status: "waiting", attentionKind: "rate_limited", attentionSince: now - 180_000 })))
      .toEqual(result("利用上限 · 3分前から", "stopped", "利用上限"));
  });
  it("S4 attention error uses its own timestamp ahead of waiting", () => {
    expect(liveTailStateLine(input("error", { status: "waiting", attentionKind: "error", attentionSince: now - 180_000 })))
      .toEqual(result("エラー · 3分前から", "stopped", "エラー"));
  });
  it("S5 screen error has no time and wins over waiting and done", () => {
    expect(liveTailStateLine(input("error", { status: "waiting", attentionKind: "done", attentionSince: now - 720_000 })))
      .toEqual(result("エラー", "stopped", "エラー"));
  });
  it.each([null, "none", "done"] as const)("S6 waiting without a blocking attention (%s) has no time", attentionKind => {
    expect(liveTailStateLine(input("progress", { status: "waiting", attentionKind, attentionSince: now - 180_000 })))
      .toEqual(result("回答待ち", "waiting", "回答待ち"));
  });
  it("S7 done uses attention time without the waiting suffix", () => {
    expect(liveTailStateLine(input("frozen", { status: "idle", attentionKind: "done", attentionSince: now - 720_000 })))
      .toEqual(result("完了 · 12分前"));
  });
  it("S7 done does not override working", () => {
    expect(liveTailStateLine(input("alive", { status: "working", attentionKind: "done", attentionSince: now - 720_000 })))
      .toEqual(result("作業中"));
  });
  it.each(["done", "unknown", "working", "unreadable", null] as const)("S8 idle status uses crop %s without observation time", cropState => {
    expect(liveTailStateLine(input("frozen", { status: "idle", cropState })))
      .toEqual(result(cropState === "done" ? "完了" : "入力待ち"));
  });
  it("S8 idle fact wins even over working status", () => {
    expect(liveTailStateLine(input("idle", { status: "working", cropState: "done" }))).toEqual(result("完了"));
  });
  it("S9 frozen wins over working", () => {
    expect(liveTailStateLine(input("frozen", { status: "working" }))).toEqual(result("画面が止まっている · 3分前から", "stopped", "止まっている"));
  });
  it("S10 stale wins over working", () => {
    expect(liveTailStateLine(input("stale", { status: "working" }))).toEqual(result("進んでいない · 3分前から", "stopped", "進んでいない"));
  });
  it("S11 progress uses the fact timestamp", () => {
    const value = input("progress", { status: "working" }); value.fact = { ...value.fact, sinceMs: now - 11_000 };
    expect(liveTailStateLine(value)).toEqual(result("作業中 · 11秒前に進んだ", "progress"));
  });
  it("S12 command uses elapsed duration", () => {
    const value = input("cmd", { cropState: "working" }); value.fact = { ...value.fact, sinceMs: now - 130_000 };
    expect(liveTailStateLine(value)).toEqual(result("コマンド実行中 · 2分10秒", "cmd"));
  });
  it.each([{ status: "working", cropState: "unreadable" }, { status: "unknown", cropState: "working" }] as const)
    ("S13 working status or crop is neutral: %o", overrides => {
      expect(liveTailStateLine(input("unreadable", overrides))).toEqual(result("作業中"));
    });
  it.each(["alive", "unreadable"] as const)("S14 %s without task state has no line", kind => {
    expect(liveTailStateLine(input(kind))).toBeNull();
  });
  it.each(["input", "approval", "rate_limited", "error", "done"] as const)("omits an invalid attention timestamp for %s", attentionKind => {
    for (const attentionSince of [0, -1, NaN, Infinity, -Infinity, null, undefined]) {
      const value = liveTailStateLine(input("alive", { attentionKind, attentionSince }));
      expect(value?.text).toBe({ input: "回答待ち", approval: "承認待ち", rate_limited: "利用上限", error: "エラー", done: "完了" }[attentionKind]);
    }
  });
  it("clamps future attention and fact timestamps to zero", () => {
    expect(liveTailStateLine(input("alive", { attentionKind: "input", attentionSince: now + 10_000 }))?.text).toBe("回答待ち · 0秒前から");
    for (const [kind, text] of [["frozen", "画面が止まっている · 0秒前から"], ["stale", "進んでいない · 0秒前から"],
      ["progress", "作業中 · 0秒前に進んだ"], ["cmd", "コマンド実行中 · 0秒"]] as const) {
      const value = input(kind); value.fact = { ...value.fact, sinceMs: now + 10_000 };
      expect(liveTailStateLine(value)?.text).toBe(text);
    }
  });
  it("keeps tone and badge independent of the relative clock", () => {
    for (const kind of ["progress", "cmd", "stale", "frozen", "unreadable", "error", "idle", "alive"] as const) {
      const value = input(kind, { status: "working" });
      const before = liveTailStateLine(value), after = liveTailStateLine({ ...value, now: now + 86_400_000 });
      expect(after?.tone).toBe(before?.tone); expect(after?.badge).toBe(before?.badge);
    }
  });
});

describe("live-tail elapsed time boundaries", () => {
  it.each([
    [-1, "0秒前"], [0, "0秒前"], [999, "0秒前"], [59_999, "59秒前"], [60_000, "1分前"],
    [3_540_000, "59分前"], [3_599_999, "59分前"], [3_600_000, "1時間前"],
    [3_900_000, "1時間5分前"], [7_200_000, "2時間前"], [86_340_000, "23時間59分前"],
    [86_399_999, "23時間59分前"], [86_400_000, "1日前"], [172_800_999, "2日前"],
  ])("ago %i ms is %s", (ms, expected) => { expect(formatLiveTailAgo(ms)).toBe(expected); });
  it.each([
    [-1, "0秒"], [0, "0秒"], [999, "0秒"], [59_999, "59秒"], [60_000, "1分0秒"],
    [130_000, "2分10秒"], [3_540_000, "59分0秒"], [3_599_999, "59分59秒"], [3_600_000, "1時間0分"],
    [3_900_000, "1時間5分"], [86_340_000, "23時間59分"], [86_400_000, "24時間0分"],
  ])("duration %i ms is %s", (ms, expected) => { expect(formatLiveTailDuration(ms)).toBe(expected); });
});

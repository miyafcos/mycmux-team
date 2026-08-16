import { describe, expect, it } from "vitest";

import { buildWatchdogQueue, telemetryForSkip, telemetryForTick, WAITING_KINDS, type WatchdogItem } from "../../src/stores/dispatchWatchdogStore";
import type { DispatchEntry } from "../../src/lib/ipc";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const MINUTE = 60_000;

function entry(overrides: Partial<DispatchEntry> = {}): DispatchEntry {
  return {
    slug: "child",
    ts: new Date(NOW - 60 * MINUTE).toISOString(),
    hasDone: false,
    hasAsk: false,
    hasVerdict: false,
    sessionLogAgeMinutes: 0,
    liveState: "RUNNING",
    ...overrides,
  };
}

function queue(
  entries: DispatchEntry[],
  previous: WatchdogItem[] = [],
  now = NOW,
  attentionBySession?: Record<string, { attentionId?: string | null; stateSince?: number }>,
) {
  return buildWatchdogQueue({
    entries,
    stallEntries: {},
    knownSessionIds: new Set(["ledger-tab"]),
    previous,
    now,
    stallMinutes: 45,
    attentionBySession,
  });
}

describe("buildWatchdogQueue", () => {
  it("records display telemetry for a successful tick and a hidden skip without queue input", () => {
    expect(telemetryForTick(NOW, 5, true)).toMatchObject({ lastTickAt: NOW, nextTickDueAt: NOW + 5 * MINUTE, lastSkipReason: null });
    expect(telemetryForSkip("hidden")).toMatchObject({ running: false, lastTickAt: null, lastSkipReason: "hidden", nextTickDueAt: null });
  });

  it("keeps ASK ahead of DONE and stalled", () => {
    const result = queue([entry({ hasAsk: true, hasDone: true, askMtimeMs: 10, doneMtimeMs: 11, sessionLogAgeMinutes: 60 })]);
    expect(result.queue.map((item) => item.kind)).toEqual(["ask"]);
  });

  it("prefers a ledger session over the same stall entry and ignores dead PTYs", () => {
    const result = buildWatchdogQueue({
      entries: [entry({ tabSessionId: "ledger-tab", hasAsk: true, askMtimeMs: 10 })],
      stallEntries: {
        "ledger-tab": { sessionId: "ledger-tab", reason: "no_output", since: 1 },
        dead: { sessionId: "dead", reason: "pty_dead", since: 1 },
      },
      knownSessionIds: new Set(["ledger-tab", "dead"]), previous: [], now: NOW, stallMinutes: 45,
    });
    expect(result.queue.map((item) => item.kind)).toEqual(["ask"]);
  });

  it("suppresses fresh ledger entries but retains the documented no-log window", () => {
    const fresh = queue([entry({ ts: new Date(NOW - MINUTE).toISOString(), hasAsk: true })]);
    const noLog = queue([entry({ ts: new Date(NOW - 2 * MINUTE).toISOString(), sessionLogAgeMinutes: -1 })]);
    expect(fresh.queue).toEqual([]);
    expect(noLog.queue.map((item) => item.kind)).toEqual(["no_log"]);
  });

  it("keeps one confirmation chain when an evidence mtime changes", () => {
    const first = queue([entry({ hasAsk: true, askMtimeMs: 10 })]).queue;
    const second = queue([entry({ hasAsk: true, askMtimeMs: 10 })], first).queue;
    const third = queue([entry({ hasAsk: true, askMtimeMs: 10 })], second).queue;
    const changed = queue([entry({ hasAsk: true, askMtimeMs: 11 })], third).queue;
    expect(first[0].key).toBe(changed[0].key);
    expect([first[0].confirmations, second[0].confirmations, third[0].confirmations, changed[0].confirmations]).toEqual([1, 2, 3, 4]);
  });

  it("excludes closed and abandoned entries and returns manually closed slugs", () => {
    const result = buildWatchdogQueue({
      entries: [
        entry({ slug: "closed", status: "closed", hasAsk: true, tabSessionId: "missing" }),
        entry({ slug: "abandoned", status: "abandoned", hasAsk: true }),
      ],
      stallEntries: {}, knownSessionIds: new Set(), previous: [], now: NOW, stallMinutes: 45,
    });
    expect(result.queue).toEqual([]);
    expect(result.abandonedSlugs).toEqual(["closed"]);
  });

  it("distinguishes unverified and failed review states", () => {
    const result = queue([
      entry({ slug: "done", hasDone: true, doneMtimeMs: 10 }),
      entry({ slug: "review", hasVerdict: true, verify: "auto-fail", verdictMtimeMs: 11 }),
    ]);
    expect(result.queue.map((item) => item.kind)).toEqual(["done_unverified", "done_needs_review"]);
  });

  it("adds independent tab findings", () => {
    const result = buildWatchdogQueue({
      entries: [],
      stallEntries: {
        output: { sessionId: "output", reason: "no_output", since: 10 },
        queued: { sessionId: "queued", reason: "queued_input", since: 11, detail: "typed" },
        silent: { sessionId: "silent", reason: "silent", since: 12 },
      },
      knownSessionIds: new Set(), previous: [], now: NOW, stallMinutes: 45,
    });
    expect(result.queue.map((item) => item.kind)).toEqual(["tab_no_output", "tab_queued_input", "tab_silent"]);
  });

  it("reports a rate-limited session as waiting rather than stalled", () => {
    // A 429'd session stops writing its transcript, so log age alone is
    // indistinguishable from a hang. Misfiling it as stalled would let a later
    // phase poke a session that is only waiting out its limit.
    const result = queue([entry({ liveState: "RATE_LIMITED", sessionLogAgeMinutes: 90 })]);
    expect(result.queue.map((item) => item.kind)).toEqual(["rate_limited"]);
  });

  it("confirms a continuing rate limit across watchdog ticks and resets on a new occurrence", () => {
    const rateLimited = entry({ tabSessionId: "ledger-tab", liveState: "RATE_LIMITED", sessionLogAgeMinutes: 90 });
    const first = queue([rateLimited], [], NOW, {
      "ledger-tab": { attentionId: "rate-limit:ledger-tab:evidence", stateSince: NOW - MINUTE },
    }).queue;
    const second = queue([rateLimited], first, NOW + 10 * MINUTE, {
      "ledger-tab": { attentionId: "rate-limit:ledger-tab:evidence", stateSince: NOW - MINUTE },
    }).queue;
    const renewed = queue([rateLimited], second, NOW + 20 * MINUTE, {
      "ledger-tab": { attentionId: "rate-limit:ledger-tab:evidence", stateSince: NOW + 15 * MINUTE },
    }).queue;

    expect(first[0].key).toBe(second[0].key);
    expect([first[0].confirmations, second[0].confirmations, renewed[0].confirmations]).toEqual([1, 2, 1]);
    expect(renewed[0].key).not.toBe(second[0].key);
  });

  it("keeps ASK ahead of a rate limit so a real question is never hidden", () => {
    const result = queue([entry({ hasAsk: true, askMtimeMs: 10, liveState: "RATE_LIMITED", sessionLogAgeMinutes: 90 })]);
    expect(result.queue.map((item) => item.kind)).toEqual(["ask"]);
  });

  it("marks ask and rate_limited as waiting, and stalled as actionable", () => {
    expect(WAITING_KINDS.has("ask")).toBe(true);
    expect(WAITING_KINDS.has("rate_limited")).toBe(true);
    expect(WAITING_KINDS.has("stalled")).toBe(false);
  });

  it("suppresses a working ledger session from stalled classification", () => {
    const result = buildWatchdogQueue({
      entries: [entry({ tabSessionId: "ledger-tab", sessionLogAgeMinutes: 60 })],
      stallEntries: {}, knownSessionIds: new Set(["ledger-tab"]), previous: [], now: NOW, stallMinutes: 45,
      attentionBySession: { "ledger-tab": { uiState: "working" } },
    });
    expect(result.queue).toEqual([]);
  });
});

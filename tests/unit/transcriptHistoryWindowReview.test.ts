// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveItem, TranscriptDescriptor, TranscriptPage } from "../../src/lib/livebrief";
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mock.invoke }));
import { ARCHIVE_CACHE_BYTES, archiveCacheStats, TranscriptHistoryReader } from "../../src/stores/transcriptHistoryStore";
const readers: TranscriptHistoryReader[] = [];
const descriptor = (id: string): TranscriptDescriptor => ({ ptySessionId: id, tabId: `tab-${id}`, expectedAgentKind: "claude", expectedAgentSessionId: id });
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
function page(id: string, from: number, large: boolean): TranscriptPage {
  const count = large ? 60 : 10;
  const items: ArchiveItem[] = Array.from({ length: count }, (_, i) => ({ occurrenceId: `${id}:${from + i}`, sourceStart: String(from + i), sourceEnd: String(from + i + 1), slot: 0, kind: "user", timestamp: null, text: large ? "x".repeat(8100) : `message ${from + i}`, bodyRef: null, callId: null, tool: null, target: null, aliases: [] }));
  return { readerId: id, sourceGeneration: id, snapshotEnd: "20000", items, olderCursor: `older-${from}`, newerCursor: `newer-${from + count}`, latestCursor: "latest", scanContinuation: null, reachedStart: false, reachedFence: false, diagnostics: [] };
}
function setup(from: number, large: boolean) {
  const count = large ? 60 : 10;
  mock.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "open_transcript_history") return page(args.request.expectedAgentSessionId, from, large);
    if (command === "read_transcript_history_page") {
      const { readerId, cursor } = args.request;
      const boundary = Number(cursor.split("-")[1]);
      return page(readerId, cursor.startsWith("older") ? boundary - count : boundary, large);
    }
    if (command === "heartbeat_transcript_history") return { hasNewBytes: false };
    return null;
  });
}
function make(id: string) { const r = new TranscriptHistoryReader(descriptor(id)); readers.push(r); return r; }
async function full(r: TranscriptHistoryReader, direction: "older" | "newer") { await flush(); for (let n = 0; n < 4; n++) await r.load(direction); }
function expectContinuous(r: TranscriptHistoryReader) {
  expect(r.snapshot.pages.length).toBeLessThanOrEqual(5);
  for (let n = 1; n < r.snapshot.items.length; n++) expect(r.snapshot.items[n].sourceStart).toBe(r.snapshot.items[n - 1].sourceEnd);
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(document, "hidden", "get").mockReturnValue(false); mock.invoke.mockReset(); });
afterEach(() => { for (const r of readers.splice(0)) r.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); expect(archiveCacheStats().bytes).toBe(0); });
describe("anchored archive window review", () => {
  for (const direction of ["older", "newer"] as const) {
    it.each([false, true])(`F3 preserves an actual anchor when extending ${direction}, shared cache pressure=%s`, async pressure => {
      setup(10000, pressure);
      const noise: TranscriptHistoryReader[] = [];
      if (pressure) for (let n = 0; n < 4; n++) { const r = make(`noise-${n}`); noise.push(r); await full(r, direction); }
      const a = make("anchor"), b = make("anchor");
      await full(a, direction); await full(b, direction);
      expect(a.snapshot.pages).toHaveLength(5);
      let anchor = "anchor:10005";
      a.setAnchor(anchor); b.setAnchor(anchor);
      a.setBeforeMutation(() => a.setAnchor(anchor));
      const before = { items: a.snapshot.items, older: a.snapshot.olderCursor, newer: a.snapshot.newerCursor };
      await a.load(direction);
      expect(a.snapshot.items.some(item => item.occurrenceId === anchor)).toBe(true);
      expect(a.snapshot.items).toEqual(before.items);
      expect(a.snapshot.olderCursor).toBe(before.older); expect(a.snapshot.newerCursor).toBe(before.newer);
      expect(b.snapshot.items.some(item => item.occurrenceId === anchor)).toBe(true);
      expect(archiveCacheStats().bytes).toBeLessThanOrEqual(ARCHIVE_CACHE_BYTES);
      if (pressure) expect(noise.some(r => r.snapshot.pages.length < 5)).toBe(true);
      // Moving the viewport frees the opposite endpoint; the deferred interval
      // can then be installed through the same original signed cursor.
      anchor = (direction === "older" ? a.snapshot.items[0] : a.snapshot.items.at(-1))!.occurrenceId;
      a.setAnchor(anchor); await a.load(direction);
      expect(a.snapshot.items.some(item => item.occurrenceId === anchor)).toBe(true);
      expect(direction === "older" ? a.snapshot.olderCursor : a.snapshot.newerCursor).not.toBe(direction === "older" ? before.older : before.newer);
      for (const r of readers) expectContinuous(r);
    });
  }
  it("keeps explicit first navigation available across an anchored five-page window", async () => {
    setup(70, false);
    const regular = mock.invoke.getMockImplementation()!;
    mock.invoke.mockImplementation(async (command: string, args: any) => {
      const reply = await regular(command, args);
      if (command === "read_transcript_history_page" && args.request.cursor === "older-10") return { ...reply, reachedStart: true, olderCursor: null };
      return reply;
    });
    const r = make("first"); await full(r, "older");
    r.setAnchor("first:75"); r.setBeforeMutation(() => r.setAnchor("first:75"));
    const navigation = r.first(); await vi.advanceTimersByTimeAsync(20);
    expect(await navigation).toBe(true); expect(r.snapshot.items[0].occurrenceId).toBe("first:0");
    expectContinuous(r);
  });
  it("F4 keeps a frozen sourceChanged error, descriptor and blocked navigation after cache eviction", async () => {
    setup(10000, true);
    const frozen = make("frozen"); await full(frozen, "older");
    frozen.setAnchor("frozen:10005"); frozen.report("sourceChanged");
    const originalDescriptor = frozen.snapshot.descriptor;
    for (let n = 0; n < 5; n++) { const r = make(`pressure-${n}`); await full(r, "older"); }
    expect(frozen.snapshot.pages.length).toBeLessThan(5);
    expect(frozen.snapshot.status).toBe("frozen"); expect(frozen.snapshot.error).toBe("sourceChanged");
    expect(frozen.snapshot.descriptor).toBe(originalDescriptor); expect(frozen.snapshot.following).toBe(false);
    expect(frozen.snapshot.items.some(item => item.occurrenceId === "frozen:10005")).toBe(true);
    const calls = mock.invoke.mock.calls.length;
    await frozen.load("older"); await frozen.load("newer"); await frozen.latest(); expect(await frozen.first()).toBe(false);
    expect(mock.invoke.mock.calls).toHaveLength(calls);
    expect(archiveCacheStats().bytes).toBeLessThanOrEqual(ARCHIVE_CACHE_BYTES);
    for (const r of readers) expectContinuous(r);
  });
});

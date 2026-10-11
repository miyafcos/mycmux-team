// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveItem, TranscriptDescriptor, TranscriptPage } from "../../src/lib/livebrief";
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mock.invoke }));
import { ArchiveTranscript } from "../../src/components/dashboard/ArchiveTranscript";
import { ARCHIVE_CACHE_BYTES, ARCHIVE_PAGE_LIMIT, archiveCacheStats, TranscriptHistoryReader } from "../../src/stores/transcriptHistoryStore";

const descriptor: TranscriptDescriptor = { ptySessionId: "instruction-pty", tabId: "instruction-tab", expectedAgentKind: "claude", expectedAgentSessionId: "instruction-id" };
const occurrence = (index: number) => `claude:instruction-id:g:${index * 10}:0`;
// Independent source oracle: exactly two user instructions, separated by six
// hundred assistant/tool rows. None of the intermediate pages has a target.
const source: ArchiveItem[] = Array.from({ length: 602 }, (_, index) => ({
  occurrenceId: occurrence(index), sourceStart: String(index * 10), sourceEnd: String((index + 1) * 10), slot: 0,
  kind: index === 0 || index === 601 ? "user" : index % 2 ? "assistant" : "toolResult",
  timestamp: null, text: index === 0 ? "U1" : index === 601 ? "U2" : `work ${index}`,
  bodyRef: null, callId: null, tool: null, target: null, aliases: [],
}));
function page(from: number, to: number): TranscriptPage {
  return { readerId: "instruction-reader", sourceGeneration: "g", snapshotEnd: "6020", items: source.slice(from, to),
    olderCursor: from === 0 ? null : `older-${from}`, newerCursor: `newer-${to}`, latestCursor: "latest",
    scanContinuation: null, reachedStart: from === 0, reachedFence: to === 602, diagnostics: [] };
}
let root: Root, host: HTMLDivElement, view: TranscriptHistoryReader;
const readers: TranscriptHistoryReader[] = [];
const subscriptions: (() => void)[] = [];
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
async function settle(work: () => void | Promise<void>) {
  await act(async () => { await work(); await vi.advanceTimersByTimeAsync(20); });
}
function bounded(reader: TranscriptHistoryReader) {
  expect(reader.snapshot.pages.length).toBeLessThanOrEqual(ARCHIVE_PAGE_LIMIT);
  expect(archiveCacheStats().bytes).toBeLessThanOrEqual(ARCHIVE_CACHE_BYTES);
  for (let n = 1; n < reader.snapshot.items.length; n++)
    expect(reader.snapshot.items[n].sourceStart).toBe(reader.snapshot.items[n - 1].sourceEnd);
}
function make() {
  const reader = new TranscriptHistoryReader(descriptor); readers.push(reader);
  subscriptions.push(reader.subscribe(() => bounded(reader))); return reader;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  mock.invoke.mockReset();
  mock.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "open_transcript_history") return page(502, 602);
    if (command === "read_transcript_history_page") {
      const cursor: string = args.request.cursor;
      if (cursor === "latest") return page(502, 602);
      const boundary = Number(cursor.split("-")[1]);
      return cursor.startsWith("older") ? page(Math.max(0, boundary - 100), boundary) : page(boundary, Math.min(602, boundary + 100));
    }
    if (command === "heartbeat_transcript_history") return { hasNewBytes: false };
    return null;
  });
  // jsdom supplies no layout. Give the real view its estimated 75px rows so
  // its own beforeMutation callback captures the first visible occurrence.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
    const row = this as HTMLElement, log = host.querySelector<HTMLElement>("[role=log]");
    const index = view?.snapshot.items.findIndex(item => item.occurrenceId === row.dataset.archiveRow) ?? -1;
    const top = index >= 0 ? index * 75 - (log?.scrollTop ?? 0) : 0;
    return { x: 0, y: top, top, bottom: top + (index >= 0 ? 75 : 600), left: 0, right: 800, width: 800, height: index >= 0 ? 75 : 600, toJSON: () => ({}) };
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  for (const reader of readers.splice(0)) reader.dispose();
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  expect(archiveCacheStats().bytes).toBe(0);
});
describe("explicit archive instruction navigation review", () => {
  it.each(["older", "newer"] as const)("N1 reaches the adjacent instruction through a long %s interval without weakening ordinary anchoring", async direction => {
    view = make(); const peer = make(); await flush();
    if (direction === "newer") {
      // Opening always starts at the latest page. Move both consumers to the
      // actual beginning through the existing explicit first() path.
      const first = Promise.all([view.first(), peer.first()]);
      await vi.advanceTimersByTimeAsync(40); expect(await first).toEqual([true, true]);
    }
    view.setFollowing(false); peer.setFollowing(false);
    const anchor = occurrence(direction === "older" ? 502 : 0);
    const captured = vi.spyOn(view, "setAnchor");
    await settle(() => root.render(<ArchiveTranscript descriptor={descriptor} prepared={view} />));
    expect(captured).toHaveBeenCalledWith(anchor); // real viewport capture, not a replacement callback
    peer.setAnchor(anchor);
    if (direction === "older") for (let n = 0; n < 4; n++) {
      await settle(() => view.load(direction)); await peer.load(direction);
    }
    expect(view.snapshot.pages).toHaveLength(5); expect(peer.snapshot.pages).toHaveLength(5);
    const before = { items: view.snapshot.items, older: view.snapshot.olderCursor, newer: view.snapshot.newerCursor };
    const peerBefore = { items: peer.snapshot.items, older: peer.snapshot.olderCursor, newer: peer.snapshot.newerCursor };
    // Original F3: the sixth ordinary page must remain deferred in both
    // directions. Explicit instruction navigation may then use that interval.
    await settle(() => view.load(direction));
    expect(view.snapshot.notice).toBe("anchorPaused"); expect(view.snapshot.items).toEqual(before.items);
    expect(view.snapshot.olderCursor).toBe(before.older); expect(view.snapshot.newerCursor).toBe(before.newer);
    expect(captured).toHaveBeenLastCalledWith(anchor);
    const label = direction === "older" ? "前の指示へ" : "次の指示へ";
    const target = direction === "older" ? "U1" : "U2";
    const targetId = occurrence(direction === "older" ? 0 : 601);
    const arrivals: (string | null)[] = [];
    for (let retry = 0; retry < 2; retry++) {
      const button = host.querySelector<HTMLButtonElement>(`[aria-label='${label}']`)!;
      expect(button.disabled).toBe(false); await settle(() => button.click());
      arrivals.push(host.querySelector<HTMLElement>(`[data-archive-row='${targetId}'] .cmux-dashboard-msg-plain`)?.textContent ?? null);
      expect(peer.snapshot.items).toEqual(peerBefore.items);
      expect(peer.snapshot.olderCursor).toBe(peerBefore.older); expect(peer.snapshot.newerCursor).toBe(peerBefore.newer);
      expect(peer.snapshot.items.some(item => item.occurrenceId === anchor)).toBe(true);
      bounded(view); bounded(peer); expect(host.querySelectorAll("[data-archive-row]").length).toBeLessThanOrEqual(120);
    }
    expect(arrivals).toEqual([target, target]); // retry must neither stall nor skip the adjacent user
    expect(host.querySelector(".cmux-dashboard-user-turn-nav-label")?.textContent).toBe(target);
    expect(view.snapshot.notice).not.toBe("anchorPaused");
    expect(mock.invoke.mock.calls.every(([command]) => String(command).includes("transcript_history"))).toBe(true);
  });
});

import type { ArchiveItem, TranscriptDescriptor } from "../lib/livebrief";
import { descriptorKey, TranscriptHistoryReader } from "./transcriptHistoryStore";

export const TRANSCRIPT_SEARCH_LIMIT = 1_000;
export const TRANSCRIPT_SEARCH_PAGE_DELAY_MS = 20;
export const TRANSCRIPT_SEARCH_DEBOUNCE_MS = 180;
export const TRANSCRIPT_SEARCH_WAIT_MS = 15_000;
export const TRANSCRIPT_SEARCH_QUERY_LIMIT = 512;
const rememberedQueries = new Map<string, string>();
export const normalizeTranscriptQuery = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
export function matchesTranscriptQuery(item: ArchiveItem, query: string): boolean {
  return !!query && (item.kind === "user" || item.kind === "assistant" || item.kind === "question") && normalizeTranscriptQuery(item.text).includes(query);
}
export type TranscriptSearchStatus = "idle" | "composing" | "waiting" | "searching" | "complete" | "stopped" | "partial" | "limited" | "unavailable";
export interface TranscriptSearchState {
  query: string;
  normalizedQuery: string;
  identity: string | null;
  generation: number;
  status: TranscriptSearchStatus;
  matches: readonly string[];
  selected: number;
  navigation: number;
  navigating: boolean;
  navigationReason: string | null;
  pagesRead: number;
  recordsRead: number;
  snapshotEnd: string | null;
  sourceGeneration: string | null;
  reason: string | null;
}
const abortError = () => new Error("cancelled");
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const done = () => { signal.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(done, ms);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(abortError()); };
    signal.addEventListener("abort", cancel, { once: true });
  });
}
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => { clearTimeout(timer); signal.removeEventListener("abort", cancel); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error("readTimeout"))), TRANSCRIPT_SEARCH_WAIT_MS);
    const cancel = () => finish(() => reject(abortError()));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

/** Search state and its scan consumer are separate from the reading viewport.
 * Only compact occurrence IDs survive a page; backend I/O uses the real reader. */
export class TranscriptSearch {
  private listeners = new Set<() => void>();
  private descriptor: TranscriptDescriptor | null = null;
  private active = false;
  private composing = false;
  private abort: AbortController | null = null;
  private reader: TranscriptHistoryReader | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastIdentity: string | null = null;
  snapshot: TranscriptSearchState = { query: "", normalizedQuery: "", identity: null, generation: 0, status: "idle", matches: [], selected: -1, navigation: 0, navigating: false, navigationReason: null, pagesRead: 0, recordsRead: 0, snapshotEnd: null, sourceGeneration: null, reason: null };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private update(patch: Partial<TranscriptSearchState>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private invalidate() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.abort?.abort(); this.abort = null;
    this.reader?.dispose(); this.reader = null;
    this.update({ generation: this.snapshot.generation + 1, selected: -1, navigating: false, navigationReason: null });
  }
  private remember() {
    const key = this.snapshot.identity;
    if (!key) return;
    rememberedQueries.delete(key); rememberedQueries.set(key, this.snapshot.query);
    while (rememberedQueries.size > 32) rememberedQueries.delete(rememberedQueries.keys().next().value!);
  }
  setContext(descriptor: TranscriptDescriptor | null, active: boolean) {
    const key = descriptor ? descriptorKey(descriptor) : null;
    if (key === this.snapshot.identity && active === this.active) return;
    const oldKey = this.snapshot.identity;
    this.remember(); this.invalidate(); this.descriptor = descriptor; this.active = active;
    const query = key !== oldKey && key ? rememberedQueries.get(key) ?? (this.lastIdentity ? "" : this.snapshot.query) : this.snapshot.query;
    if (key) this.lastIdentity = key;
    this.update({ identity: key, query, normalizedQuery: normalizeTranscriptQuery(query), matches: [], pagesRead: 0, recordsRead: 0, snapshotEnd: null, sourceGeneration: null, reason: null });
    this.schedule();
  }
  setQuery(query: string, composing = false) {
    this.invalidate(); this.composing = composing;
    const text = query.slice(0, TRANSCRIPT_SEARCH_QUERY_LIMIT);
    this.update({ query: text, normalizedQuery: normalizeTranscriptQuery(text), matches: [], pagesRead: 0, recordsRead: 0, snapshotEnd: null, sourceGeneration: null, reason: null });
    this.remember(); this.schedule();
  }
  restart() { this.setQuery(this.snapshot.query); }
  setNavigationState = (generation: number, navigation: number, pending: boolean, reason: string | null = null) => {
    if (generation === this.snapshot.generation && navigation === this.snapshot.navigation) this.update({ navigating: pending, navigationReason: reason });
  };
  stop(reason: string | null = null) {
    this.invalidate(); this.update({ status: this.snapshot.normalizedQuery ? "stopped" : "idle", reason });
  }
  move(delta: -1 | 1) {
    if (!this.snapshot.matches.length || this.composing || !this.active) return;
    const index = this.snapshot.selected < 0 ? 0 : this.snapshot.selected + delta;
    if (index < 0 || index >= this.snapshot.matches.length) return;
    this.update({ selected: index, navigation: this.snapshot.navigation + 1, navigating: true, navigationReason: null });
  }
  private schedule() {
    if (this.composing) { this.update({ status: "composing" }); return; }
    if (!this.snapshot.normalizedQuery) { this.update({ status: "idle" }); return; }
    if (!this.descriptor || !this.active) { this.update({ status: "unavailable" }); return; }
    this.update({ status: "waiting" });
    const generation = this.snapshot.generation, descriptor = this.descriptor, query = this.snapshot.normalizedQuery;
    this.timer = setTimeout(() => { this.timer = null; void this.scan(descriptor, query, generation); }, TRANSCRIPT_SEARCH_DEBOUNCE_MS);
  }
  private async scan(descriptor: TranscriptDescriptor, query: string, generation: number) {
    const abort = new AbortController(); this.abort = abort;
    const current = () => !this.disposed && !abort.signal.aborted && this.snapshot.generation === generation && this.snapshot.identity === descriptorKey(descriptor) && this.snapshot.normalizedQuery === query;
    const reader = new TranscriptHistoryReader(descriptor); this.reader = reader;
    const matches: string[] = [];
    let oldest: { start: bigint; slot: number } | null = null;
    let diagnostic: string | null = null;
    try {
      const started = Date.now();
      while (reader.snapshot.loading) {
        if (Date.now() - started >= TRANSCRIPT_SEARCH_WAIT_MS) throw new Error("readTimeout");
        await wait(10, abort.signal);
      }
      if (!current()) return;
      if (reader.snapshot.status !== "ready") throw new Error(reader.snapshot.error ?? reader.snapshot.notice ?? "recordMissing");
      await bounded(reader.latest(), abort.signal);
      if (!current()) return;
      reader.setFollowing(false);
      const sourceGeneration = reader.snapshot.sourceGeneration;
      const snapshotEnd = reader.snapshot.pages[reader.snapshot.pages.length - 1]?.snapshotEnd ?? null;
      this.update({ status: "searching", sourceGeneration, snapshotEnd });
      while (current()) {
        const state = reader.snapshot;
        if (state.error || state.status !== "ready" || state.notice === "readerBusy") throw new Error(state.error ?? state.notice ?? "searchPaused");
        if (state.sourceGeneration !== sourceGeneration) throw new Error("sourceChanged");
        for (const page of state.pages) diagnostic ??= page.diagnostics[0]?.reason ?? null;
        let records = this.snapshot.recordsRead;
        for (const item of [...state.items].reverse()) {
          const start = BigInt(item.sourceStart);
          if (oldest && (start > oldest.start || start === oldest.start && item.slot >= oldest.slot)) continue;
          oldest = { start, slot: item.slot }; records++;
          if (matchesTranscriptQuery(item, query)) matches.push(item.occurrenceId);
          if (matches.length >= TRANSCRIPT_SEARCH_LIMIT) break;
        }
        if (!current()) return;
        const firstMatch = this.snapshot.selected < 0 && matches.length > 0;
        this.update({ matches: [...matches], recordsRead: records, selected: firstMatch ? 0 : this.snapshot.selected, navigation: this.snapshot.navigation + (firstMatch ? 1 : 0), navigating: firstMatch || this.snapshot.navigating });
        if (matches.length >= TRANSCRIPT_SEARCH_LIMIT) { this.update({ status: "limited", reason: "matchLimit" }); return; }
        if (state.reachedStart) { this.update({ status: diagnostic ? "partial" : "complete", reason: diagnostic }); return; }
        if (!state.olderCursor || state.continuation) throw new Error(state.notice ?? "searchPaused");
        const cursor = state.olderCursor;
        await wait(TRANSCRIPT_SEARCH_PAGE_DELAY_MS, abort.signal);
        if (!current()) return;
        await bounded(reader.load("older", { navigate: true }), abort.signal);
        if (!current()) return;
        this.update({ pagesRead: this.snapshot.pagesRead + 1 });
        if (reader.snapshot.olderCursor === cursor && !reader.snapshot.reachedStart) throw new Error(reader.snapshot.error ?? reader.snapshot.notice ?? "searchPaused");
      }
    } catch (error) {
      if (current()) this.update({ status: "partial", reason: String(error).replace(/^Error: /, "") });
    } finally {
      reader.dispose();
      if (this.reader === reader) this.reader = null;
      if (this.abort === abort) this.abort = null;
    }
  }
  dispose() { this.remember(); this.invalidate(); this.disposed = true; this.listeners.clear(); }
}

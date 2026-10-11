import {
  closeTranscriptHistory, openTranscriptHistory, readTranscriptHistoryPage,
  refreshTranscriptHistoryTail, readTranscriptHistoryBody, heartbeatTranscriptHistory,
  type ArchiveItem, type TranscriptDescriptor, type TranscriptPage, type TranscriptBodyPage,
} from "../lib/livebrief";

export const ARCHIVE_PAGE_LIMIT = 5;
// Leave space for React/Markdown/DOM above UTF-16 cached text in the 32 MiB target.
export const ARCHIVE_CACHE_BYTES = 12 * 1024 * 1024;
const encoder = new TextEncoder();
type Direction = "older" | "newer" | "initial";
export interface HistoryState {
  descriptor: TranscriptDescriptor;
  status: "opening" | "ready" | "error" | "frozen" | "closed";
  readerId: string | null;
  sourceGeneration: string | null;
  items: readonly ArchiveItem[];
  pages: readonly TranscriptPage[];
  olderCursor: string | null;
  newerCursor: string | null;
  continuation: string | null;
  reachedStart: boolean;
  reachedFence: boolean;
  loading: Direction | null;
  following: boolean;
  newTail: boolean;
  error: string | null;
  notice: string | null;
  version: number;
}
interface CachedPage { owner: string; key: string; page: TranscriptPage; bytes: number; pins: number; cursor?: string }
const cache = new Map<string, CachedPage>();
let cacheBytes = 0;
let connectionSequence = 0;
let sliceSequence = 0;
const connections = new Map<string, Connection>();
const activeReaders = new Set<TranscriptHistoryReader>();
export const descriptorKey = (d: TranscriptDescriptor): string => JSON.stringify([d.ptySessionId, d.tabId, d.expectedAgentKind, d.expectedAgentSessionId]);
const sameDescriptor = (a: TranscriptDescriptor, b: TranscriptDescriptor) => descriptorKey(a) === descriptorKey(b);
const errorCode = (error: unknown) => String(error).replace(/^Error: /, "");
const pause = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function admit(key: string, page: TranscriptPage, owner: string): CachedPage {
  const known = cache.get(key);
  if (known) { cache.delete(key); cache.set(key, known); return known; }
  const bytes = encoder.encode(JSON.stringify(page)).byteLength;
  // Make replacement space before admitting the reply. Selected/visible anchor
  // pages stay pinned; distant ends of unselected windows may be reloaded.
  while (cacheBytes + bytes > ARCHIVE_CACHE_BYTES || cache.size >= 1024) {
    const cold = [...cache.values()].find(e => e.pins === 0);
    if (cold) { cache.delete(cold.key); cacheBytes -= cold.bytes; continue; }
    if (![...activeReaders].some(reader => reader.releaseDistantPage())) break;
  }
  for (const [coldKey, cold] of cache) {
    if (cacheBytes + bytes <= ARCHIVE_CACHE_BYTES && cache.size<1024) break;
    if (cold.pins === 0) { cache.delete(coldKey); cacheBytes -= cold.bytes; }
  }
  if (cacheBytes + bytes > ARCHIVE_CACHE_BYTES || cache.size >= 1024) throw new Error("readerBusy");
  const entry = { key, page, bytes, pins: 0, owner }; cache.set(key, entry); cacheBytes += bytes; return entry;
}

/** One backend lease and queue per exact source in this webview. Viewports,
 * retained windows and follow intent belong to each consumer, never here. */
class Connection {
  readonly key: string;
  readonly consumers = new Set<TranscriptHistoryReader>();
  readonly initial: Promise<void>;
  private readonly firstPage: Promise<void>;
  private initialEntry: CachedPage | null = null;
  private initialKey: string | null = null;
  private initialContinuation: string | null = null;
  private initialComplete = false;
  private initialFailure: string | null = null;
  private initialCursor: string | null = null;
  latestCursor: string | null = null;
  private latestFence = 0n;
  readerId: string | null = null;
  closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight = new Map<string, Promise<CachedPage>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private heartbeatAt=0;
  private failed = false;
  private pendingPage: TranscriptPage | null = null;
  private waits = new Map<ReturnType<typeof setTimeout>, () => void>();
  private wait(ms: number): Promise<void> {
    return new Promise(resolve => { const timer = setTimeout(() => { this.waits.delete(timer); resolve(); }, ms); this.waits.set(timer, resolve); });
  }
  // The queue owns the entire backend job, including slices after a consumer
  // hides or leaves. No other page/tail request can strand its continuation.
  private async finishJob(page: TranscriptPage): Promise<TranscriptPage> {
    this.pendingPage = page.scanContinuation ? page : null;
    while (page.scanContinuation) {
      if (this.closed) throw new Error("cursorExpired");
      await this.wait(page.diagnostics.some(d => d.reason === "incompleteRecord") ? 1500 : 0);
      if (this.closed) throw new Error("cursorExpired");
      page = await this.read(() => readTranscriptHistoryPage(this.readerId!, page.scanContinuation!));
      if (this.closed) throw new Error("cursorExpired");
      this.pendingPage = page.scanContinuation ? page : null;
    }
    return page;
  }
  private async read<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw new Error("cursorExpired");
      try { return await work(); }
      catch (error) {
        if (errorCode(error) !== "readerBusy" || attempt >= 2) throw error;
        await this.wait(Math.min(2000, 250 * 2 ** attempt));
      }
    }
  }
  constructor(readonly descriptor: TranscriptDescriptor, shared: boolean) {
    this.key = `${descriptorKey(descriptor)}:${++connectionSequence}`;
    if (shared) connections.set(descriptorKey(descriptor), this);
    let firstReady!: () => void, firstFailed!: (error: unknown) => void;
    this.firstPage = new Promise<void>((resolve, reject) => { firstReady=resolve; firstFailed=reject; });
    this.initial = this.schedule(async () => {
      let page: TranscriptPage | undefined;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (this.closed) throw new Error("cursorExpired");
        try { page = await openTranscriptHistory(descriptor); break; }
        catch (error) {
          if (this.closed) throw new Error("cursorExpired");
          if (errorCode(error) !== "readerBusy" || attempt === 5) throw error;
          for (const reader of this.consumers) reader.report(error, this);
          await this.wait(Math.min(2000, 250 * 2 ** attempt));
        }
      }
      this.readerId = page!.readerId;
      if (this.closed) { void closeTranscriptHistory(page!.readerId).catch(() => {}); throw new Error("cursorExpired"); }
      if (page!.scanContinuation) {
        this.initialContinuation=page!.scanContinuation;
        const key=`${this.key}:page:${this.initialContinuation}`;
        // Publish bounded first rows immediately. The connection still owns
        // the job; consumers await its final reply rather than driving it.
        const pending=this.initial.then(()=>{
          const entry=this.initialEntry ?? (this.initialKey ? cache.get(this.initialKey) : null);this.initialEntry=null;
          if(entry)return entry;
          if(!this.initialCursor)throw new Error("cursorExpired");
          return this.request(this.initialCursor);
        }).finally(()=>this.inFlight.delete(key));
        this.inFlight.set(key,pending);void pending.catch(()=>{});
        this.pendingPage=page!;
        try {
          this.initialEntry=admit(`${this.key}:initial:partial`,page!,this.key);this.initialKey=this.initialEntry.key;
          this.initialCursor=page!.latestCursor;this.rememberFence(page!);firstReady();
        } catch(error) { firstFailed(error); }
      }
      const complete = await this.finishJob(page!);
      if(this.closed)throw new Error("cursorExpired");
      this.initialCursor = complete.latestCursor;
      this.rememberFence(complete);
      const key=this.initialContinuation ? `${this.key}:page:${this.initialContinuation}` : `${this.key}:initial`;
      this.initialEntry=admit(key,complete,this.key);this.initialKey=key;this.initialComplete=true;firstReady();
    });
    // A pre-open may be disposed before a UI subscribes.
    const failed=(error:unknown)=>{
      this.failed=true;this.initialFailure=errorCode(error);firstFailed(error);
      if(connections.get(descriptorKey(this.descriptor))===this)connections.delete(descriptorKey(this.descriptor));
    };
    void this.initial.catch(failed);void this.firstPage.catch(failed);
    this.timer = setInterval(() => { void this.poll(); }, 1500);
  }
  private rememberFence(page: TranscriptPage): void {
    if (BigInt(page.snapshotEnd) >= this.latestFence) { if(page.latestCursor)this.latestCursor=page.latestCursor;this.latestFence=BigInt(page.snapshotEnd); }
  }
  async getInitial(): Promise<CachedPage> {
    await this.firstPage;
    // Initial is reusable only until this connection has observed a newer fence.
    const cached = this.initialEntry ?? (this.initialKey ? cache.get(this.initialKey) : null); this.initialEntry = null;
    if (cached && BigInt(cached.page.snapshotEnd) === this.latestFence && (!cached.page.scanContinuation || !this.initialComplete)) return cached;
    const cursor=this.latestCursor??this.initialCursor;
    if (!cursor) throw new Error("cursorExpired");
    return this.request(cursor);
  }
  private schedule<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => { if (this.closed) throw new Error("cursorExpired"); return work(); });
    this.queue = result.then(() => undefined, () => undefined); return result;
  }
  request(cursor: string, tail = false): Promise<CachedPage> {
    const key = `${this.key}:${tail ? "tail" : "page"}:${cursor}`;
    if (!tail) { const hit = cache.get(key); if (hit && !hit.page.scanContinuation) return Promise.resolve(hit); }
    const pending = this.inFlight.get(key); if (pending) return pending;
    if (!tail && cursor===this.initialContinuation) {
      // A hidden consumer may resume after the final cached reply was evicted.
      // Reload the validated initial snapshot, never replay a retired job token.
      if(this.initialComplete && this.initialCursor)return this.request(this.initialCursor);
      if(this.initialFailure && this.initialFailure!=="readerBusy")return Promise.reject(new Error(this.initialFailure));
      if(this.initialFailure==="readerBusy" && !this.pendingPage && this.initialCursor)return this.request(this.initialCursor);
    }
    const request = this.schedule(async () => {
      if (!this.readerId) await this.initial;
      const resumed=this.pendingPage ? await this.finishJob(this.pendingPage) : null;
      if(resumed && this.initialContinuation && !this.initialComplete) {
        this.initialCursor=resumed.latestCursor;this.initialComplete=true;this.initialFailure=null;this.failed=false;this.rememberFence(resumed);
      }
      const sampled = !tail && cursor===this.initialContinuation && resumed ? resumed
        : tail ? await refreshTranscriptHistoryTail(this.readerId!, cursor) : await readTranscriptHistoryPage(this.readerId!, cursor);
      if (this.closed) throw new Error("cursorExpired");
      const page = await this.finishJob(sampled);
      if (this.closed) throw new Error("cursorExpired");
      this.rememberFence(page);
      // Tail sampling must not be memoized: the same old fence can grow.
      const entry=admit(tail || page.scanContinuation ? `${key}:slice:${++sliceSequence}` : key,page,this.key); entry.cursor=cursor; return entry;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request); return request;
  }
  body(bodyRef: string, cursor: string | null, signal?: AbortSignal): Promise<TranscriptBodyPage> {
    return this.schedule(async () => {
      let page: TranscriptBodyPage;
      do {
        if (this.closed || signal?.aborted) throw new Error("cursorExpired");
        page = await readTranscriptHistoryBody(this.readerId!, bodyRef, cursor);
        cursor = page.cursor;
        if (page.validationPending) await pause();
      } while (page.validationPending && cursor);
      return page;
    });
  }
  private async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    const hidden=(typeof document!=="undefined"&&document.hidden)||![...this.consumers].some(r=>r.visible);
    const readers = [...this.consumers].filter((r) => r.visible && r.snapshot.status === "ready" && r.snapshot.following && r.snapshot.reachedFence && !r.snapshot.loading);
    const first = !hidden?readers[0]:undefined;
    if (!first?.snapshot.newerCursor) {
      if(!this.readerId||this.failed||Date.now()-this.heartbeatAt<(hidden?120000:1500))return;
      this.heartbeatAt=Date.now();this.polling=true;
      const contexts=[...this.consumers].map(r=>({r,valid:r.captureRequest(this)}));
      try {const beat=await this.schedule(()=>heartbeatTranscriptHistory(this.readerId!));if(beat.hasNewBytes)for(const r of this.consumers)r.markTail(this);}
      catch(error){for(const {r,valid} of contexts)if(valid())r.report(error, this);}finally{this.polling=false;}
      return;
    }
    this.polling = true;
    const contexts=readers.map(r=>({r,valid:r.captureRequest(this)}));
    try {
      const cursor = first.snapshot.newerCursor;
      const page = await this.request(cursor, true);
      if (this.closed) return;
      for (const {r:reader,valid} of contexts) {
        if(!valid())continue;
        // A tail covers only its signed starting cursor. Lagging views sample
        // their own fence; an empty fanout must never skip their missing range.
        const ownCursor = reader.snapshot.newerCursor;
        if (!ownCursor || !reader.belongsTo(this)) continue;
        const ownPage = ownCursor === cursor ? page : await this.request(ownCursor, true);
        if (this.closed) return;
        await reader.receiveTail(ownPage, this, ownCursor);
      }
      if(page.page.items.length)for(const r of this.consumers)if(!readers.includes(r))r.markTail(this);
    } catch (error) { for (const {r,valid} of contexts) if(valid())r.report(error, this); }
    finally { this.polling = false; }
  }
  detach(reader: TranscriptHistoryReader): void {
    this.consumers.delete(reader);
    if (this.consumers.size) return;
    this.closed = true;
    for (const [timer, resolve] of this.waits) { clearTimeout(timer); resolve(); }
    this.waits.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (connections.get(descriptorKey(this.descriptor)) === this) connections.delete(descriptorKey(this.descriptor));
    if (this.readerId) void closeTranscriptHistory(this.readerId).catch(() => {});
    this.initialEntry=null;
    // Tokens belong to the closed lease; no future connection can reuse them.
    for (const [key,entry] of cache) if(key.startsWith(`${this.key}:`)) {cache.delete(key);cacheBytes-=entry.bytes;}
  }
}
function connection(d: TranscriptDescriptor, shared = true): Connection {
  return shared ? connections.get(descriptorKey(d)) ?? new Connection(d, true) : new Connection(d, false);
}

/** Per-consumer bounded source window. No PTY command is available here. */
export class TranscriptHistoryReader {
  private listeners = new Set<() => void>();
  private retained: CachedPage[] = [];
  private conn: Connection;
  private sequence = 0;
  private searchSequence = 0;
  private bindingSequence = 0;
  private beforeMutation: (() => void) | null = null;
  private selection = false;
  private partial: CachedPage | null = null;
  private continuationDirection: Direction = "initial";
  private anchorId: string | null = null;
  visible = true;
  snapshot: HistoryState;
  constructor(descriptor: TranscriptDescriptor) {
    this.snapshot = { descriptor, status: "opening", readerId: null, sourceGeneration: null, items: [], pages: [], olderCursor: null, newerCursor: null, continuation: null, reachedStart: false, reachedFence: false, loading: "initial", following: true, newTail: false, error: null, notice: null, version: 0 };
    this.conn = connection(descriptor); this.conn.consumers.add(this);
    activeReaders.add(this); void this.initialize();
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): HistoryState => this.snapshot;
  setBeforeMutation(callback: (() => void) | null): void { this.beforeMutation = callback; }
  private update(patch: Partial<HistoryState>): void {
    if (this.snapshot.status === "closed") return;
    this.snapshot = { ...this.snapshot, ...patch, version: this.snapshot.version + 1 };
    for (const listener of this.listeners) listener();
  }
  belongsTo(conn: Connection): boolean {
    return this.conn === conn && this.snapshot.status !== "closed" && sameDescriptor(this.snapshot.descriptor, conn.descriptor);
  }
  private current(seq: number, conn: Connection): boolean { return seq === this.sequence && this.belongsTo(conn); }
  captureRequest(conn = this.conn): () => boolean { const seq=this.sequence; return () => this.current(seq,conn); }
  setAnchor(id: string | null): void { this.anchorId = id; }
  // Both cache pressure and the five-page cap remove only an endpoint.
  // A directional extension must keep the edge it extends and the viewport
  // anchor; otherwise no contiguous replacement window exists yet.
  private distantPageIndex(direction: Direction | null = this.snapshot.loading, preserveAnchor = true): number {
    const protectedIndex = this.retained.findIndex(e => e.page.items.some(i => i.occurrenceId === this.anchorId));
    const end = this.retained.length - 1;
    const index = direction === "older" ? end : direction === "newer" ? 0
      : protectedIndex === 0 ? end : protectedIndex === end || this.snapshot.following ? 0 : end;
    return preserveAnchor && protectedIndex === index ? -1 : index;
  }
  releaseDistantPage(): boolean {
    if (this.selection || this.retained.length <= 1) return false;
    this.beforeMutation?.();
    const index = this.distantPageIndex();
    if (index < 0) return false;
    this.retained.splice(index, 1)[0].pins--;
    this.publishWindow(this.retained[this.retained.length - 1].page);
    return true;
  }
  private async initialize(): Promise<void> {
    const seq = ++this.sequence, conn = this.conn;
    try { const page = await conn.getInitial(); if (!this.current(seq, conn)) return; if (this.install(page, "initial")) await this.continueWork("initial", seq); }
    catch (error) { if (this.current(seq, conn)) { this.report(error, conn); if (errorCode(error)==="readerBusy") this.update({status:"error",error:"readerBusy"}); } }
    finally { if (this.current(seq, conn)) this.update({ loading: null }); }
  }
  private releaseWindow(): void {
    for (const entry of this.retained) entry.pins--;
    this.retained = [];
    if (this.partial) this.partial.pins--;
    this.partial = null;
  }
  private install(entry: CachedPage, direction: Direction, navigate = false): boolean {
    if (entry.owner !== this.conn.key || !sameDescriptor(this.snapshot.descriptor, this.conn.descriptor) || entry.page.readerId !== this.conn.readerId) return false;
    if (!cache.has(entry.key)) entry = admit(entry.key, entry.page, entry.owner);
    const page = entry.page;
    if (this.snapshot.status === "closed" || this.selection) { this.update({ newTail: true }); return false; }
    if (this.snapshot.sourceGeneration && page.sourceGeneration && this.snapshot.sourceGeneration !== page.sourceGeneration) { this.report("sourceChanged"); return false; }
    this.beforeMutation?.();
    // Initial/target replacement is an explicit move, including a partial
    // page restored by a unique-target search. It still occupies one slot.
    if (direction === "initial") this.releaseWindow();
    const adding = page.scanContinuation || !this.retained.some(old => old.key === entry.key);
    if (direction !== "initial" && adding && this.retained.length >= ARCHIVE_PAGE_LIMIT) {
      const index = this.distantPageIndex(direction, !navigate);
      if (index < 0) {
        // Keep the signed cursors and visible window for a later retry after
        // the viewport moves. The connection has already drained the job.
        this.update({ notice: "anchorPaused", following: false, newTail: direction === "newer" || this.snapshot.newTail });
        return false;
      }
      this.retained.splice(index, 1)[0].pins--;
    }
    if (this.partial) { this.partial.pins--; this.partial = null; }
    if (page.scanContinuation) { this.continuationDirection=direction; entry.pins++; this.partial = entry; }
    else if (direction === "initial" || !this.retained.some((old) => old.key === entry.key)) {
      if (direction === "initial") { entry.pins++; this.retained = [entry]; }
      else if (direction === "older") this.retained.unshift(entry);
      else this.retained.push(entry);
      if (direction !== "initial") entry.pins++;
    }
    this.publishWindow(page);
    return true;
  }
  private publishWindow(page: TranscriptPage): void {
    const frozen = this.snapshot.status === "frozen";
    const error = frozen ? this.snapshot.error : null;
    const pages = [...this.retained.map((e) => e.page), ...(this.partial ? [this.partial.page] : [])];
    const items = new Map<string, ArchiveItem>();
    for (const p of pages) for (const item of p.items) items.set(item.occurrenceId, item);
    const ordered = [...items.values()].sort((a, b) => { const x = BigInt(a.sourceStart), y = BigInt(b.sourceStart); return x === y ? a.slot-b.slot : x<y ? -1 : 1; });
    const first = this.retained[0]?.page; const last = this.retained[this.retained.length-1]?.page;
    this.update({ readerId: page.readerId, sourceGeneration: page.sourceGeneration || this.snapshot.sourceGeneration, status: frozen ? "frozen" : page.sourceGeneration ? "ready" : "opening", pages, items: ordered,
      continuation: page.scanContinuation, olderCursor: first ? first.olderCursor : page.olderCursor, newerCursor: last ? last.newerCursor : page.newerCursor,
      reachedStart: first?.reachedStart ?? page.reachedStart, reachedFence: last?.reachedFence ?? page.reachedFence,
      notice: page.diagnostics[0]?.reason ?? null, error });
  }
  private async continueWork(direction: Direction, seq: number, navigate = false, valid: () => boolean = () => true): Promise<void> {
    const conn = this.conn;
    while (valid() && this.current(seq, conn) && this.snapshot.continuation && this.visible && !this.selection && !this.snapshot.error?.includes("sourceChanged")) {
      await pause(this.snapshot.notice === "incompleteRecord" ? 1500 : 0);
      if (!valid() || !this.current(seq, conn) || !this.visible) return;
      const next = await conn.request(this.snapshot.continuation);
      if (!valid() || !this.current(seq, conn) || !this.install(next, direction, navigate)) return;
    }
  }
  async load(direction: "older" | "newer", options: { navigate?: boolean } = {}): Promise<void> { return this.loadWindow(direction, options.navigate === true); }
  // Only explicit instruction/first/target navigation may replace this consumer's old anchor.
  // Ordinary extension and automatic tail follow always preserve it.
  private async loadWindow(direction: "older" | "newer", navigate = false, valid: () => boolean = () => true): Promise<void> {
    if (!valid() || this.snapshot.loading || this.selection || this.snapshot.status === "closed" || this.snapshot.error && this.snapshot.error!=="bindingChanged") return;
    const seq = ++this.sequence, conn = this.conn;
    this.update({ loading: direction, following: false });
    try {
      if (this.snapshot.continuation) await this.continueWork(direction, seq, navigate, valid);
      else {
        const cursor = direction === "older" ? this.snapshot.olderCursor : this.snapshot.newerCursor;
        if (!cursor || (direction === "newer" && this.snapshot.reachedFence)) return;
        const result = await conn.request(cursor); if (!valid() || !this.current(seq, conn)) return;
        if (this.install(result, direction, navigate)) await this.continueWork(direction, seq, navigate, valid);
      }
    } catch (error) { if (valid() && this.current(seq, conn)) this.report(error, conn); }
    finally { if (this.current(seq, conn)) this.update({ loading: null }); }
  }
  async receiveTail(entry: CachedPage, conn = this.conn, cursor = entry.cursor): Promise<void> {
    if (!this.belongsTo(conn) || entry.owner !== conn.key || cursor !== this.snapshot.newerCursor) return;
    if (this.snapshot.loading || !this.snapshot.following || !this.visible) { this.update({ newTail: true }); return; }
    const seq = ++this.sequence; this.update({ loading: "newer" });
    try {
      if (!entry.page.items.length && !entry.page.scanContinuation && entry.page.reachedFence) { this.update({newerCursor:entry.page.newerCursor}); return; }
      if (!this.install(entry,"newer")) return; await this.continueWork("newer",seq);
      while (this.current(seq, conn) && !this.snapshot.reachedFence && this.snapshot.newerCursor && this.visible && !this.selection) {
        await pause(); if (!this.current(seq, conn)) return; const next = await conn.request(this.snapshot.newerCursor!); if (!this.current(seq, conn)) return; if (!this.install(next,"newer")) return; await this.continueWork("newer",seq);
      }
    } catch (error) { if (this.current(seq, conn)) this.report(error, conn); }
    finally { if (this.current(seq, conn)) this.update({ loading: null }); }
  }
  setFollowing(following: boolean): void { this.update({ following: following && this.snapshot.reachedFence, newTail: following ? false : this.snapshot.newTail }); }
  markTail(conn = this.conn):void {if(this.belongsTo(conn))this.update({newTail:true});}
  setSelection(selected: boolean): void { this.selection = selected; if(!selected) this.setVisible(this.visible); }
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.snapshot.continuation && !this.snapshot.loading) { const seq = ++this.sequence, conn = this.conn; this.update({ loading:"initial" }); void this.continueWork(this.continuationDirection,seq).catch((e)=>{if(this.current(seq,conn))this.report(e,conn);}).finally(()=>{if(this.current(seq,conn))this.update({loading:null});}); }
  }
  freeze(reason = "bindingChanged"): void { this.bindingSequence++; this.sequence++; this.searchSequence++; this.update({ status: "frozen", following: false, error: reason, loading: null }); }
  report(error: unknown, conn = this.conn): void {
    if (!this.belongsTo(conn)) return;
    const code = errorCode(error);
    if (code === "readerBusy") { this.update({ loading: null, notice: code, ...(!this.conn.readerId ? {status:"opening" as const} : {}) }); return; }
    this.bindingSequence++; this.sequence++; this.searchSequence++; this.update({ status: this.snapshot.items.length ? "frozen" : "error", error: code, following: false, loading: null });
  }
  reopen(descriptor = this.snapshot.descriptor): void {
    this.bindingSequence++; this.searchSequence++; this.sequence++; this.conn.detach(this); this.beforeMutation?.(); this.releaseWindow();
    this.snapshot = { ...this.snapshot, descriptor, sourceGeneration: null, readerId: null, items: [], pages: [], following: true, newTail: false, error: null, status:"opening", loading:"initial", continuation:null, olderCursor:null, newerCursor:null };
    this.conn = connection(descriptor,false); this.conn.consumers.add(this); this.update({}); void this.initialize();
  }
  async latest(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.snapshot.loading || this.selection || this.snapshot.status!=="ready") return;
    const valid = () => !signal?.aborted;
    const seq=++this.sequence, conn=this.conn; this.update({loading:"initial",following:true,newTail:false});
    try {
      if (this.snapshot.newerCursor) {
        const sampled=await conn.request(this.snapshot.newerCursor,true);
        if (!valid() || !this.current(seq, conn)) return;
        if (sampled.page.scanContinuation && this.install(sampled,"newer")) await this.continueWork("newer",seq,false,valid);
      }
      if (!valid() || !this.current(seq, conn) || !conn.latestCursor) return;
      const page=await conn.request(conn.latestCursor); if (!valid() || !this.current(seq, conn)) return;
      if (this.install(page,"initial")) await this.continueWork("initial",seq,false,valid);
    } catch(error) { if (valid() && this.current(seq, conn)) this.report(error, conn); }
    finally { if (this.current(seq, conn)) this.update({loading:null}); }
  }
  async readBody(item: ArchiveItem, cursor: string | null, signal?: AbortSignal): Promise<TranscriptBodyPage> {
    if (!item.bodyRef) throw new Error("recordMissing");
    const conn = this.conn, binding = this.bindingSequence;
    const valid=()=>binding===this.bindingSequence && this.belongsTo(conn);
    try { const page = await conn.body(item.bodyRef, cursor, signal); if (!valid()) throw new Error("cursorExpired"); return page; }
    catch (error) { if (valid() && !signal?.aborted && ["sourceChanged","identityMismatch"].includes(errorCode(error))) this.report(error, conn); throw error; }
  }
  cancelSearch(): void { this.searchSequence++; this.update({ notice:null }); }
  /** Legacy aliases need a unique occurrence across the complete snapshot.
   * Keep at most one matching page pinned while scanning; restore it only when
   * uniqueness is proven. Labels deliberately choose the latest occurrence. */
  async find(predicate: (item: ArchiveItem) => boolean, options: { unique?: boolean; fromLatest?: boolean; signal?: AbortSignal } = {}): Promise<ArchiveItem | null> {
    const search = ++this.searchSequence, conn = this.conn;
    const valid = () => !options.signal?.aborted && search === this.searchSequence && this.belongsTo(conn);
    const cancelled = () => { if (search === this.searchSequence && this.belongsTo(conn)) this.update({ notice: null }); };
    options.signal?.addEventListener("abort", cancelled, { once: true });
    let found: ArchiveItem | null = null;
    let foundPage: CachedPage | null = null;
    try {
      if (!valid()) return null;
      if (options.fromLatest && this.snapshot.status === "ready") await this.latest(options.signal);
      if (!valid()) return null;
      this.setFollowing(false);
      while (valid() && this.getSnapshot().status !== "closed" && this.visible) {
        if (this.selection) { this.update({notice:"selectionPaused"}); return null; }
        if (this.snapshot.loading) { await pause(10); continue; }
        const matches = this.snapshot.items.filter(predicate);
        for (const match of [...matches].reverse()) {
          if (!options.unique) { this.update({notice:null}); return match; }
          if (found && found.occurrenceId !== match.occurrenceId) { this.update({notice:"ambiguousTarget"}); return null; }
          if (!found) {
            found = match;
            foundPage = this.retained.find((e) => e.page.items.some((i) => i.occurrenceId === match.occurrenceId)) ?? this.partial;
            if (foundPage) foundPage.pins++;
          }
        }
        if (this.snapshot.reachedStart) {
          if (found && foundPage) { this.install(foundPage,"initial"); this.update({notice:null}); return found; }
          this.update({notice:"targetMissing"}); return null;
        }
        if (!this.snapshot.olderCursor || this.snapshot.status === "frozen" || this.snapshot.error) { this.update({notice:"targetMissing"}); return null; }
        const cursor = this.snapshot.olderCursor;
        this.update({notice:"searching"}); await this.loadWindow("older",true,valid); if (!valid()) return null; await pause();
        if (!valid()) return null;
        if (this.snapshot.error || cursor === this.snapshot.olderCursor && !this.snapshot.reachedStart) { this.update({notice:this.snapshot.notice === "readerBusy" ? "readerBusy" : "searchPaused"}); return null; }
      }
      return null;
    } finally { options.signal?.removeEventListener("abort", cancelled); if (foundPage) foundPage.pins--; }
  }
  async first(): Promise<boolean> {
    const search = ++this.searchSequence, conn = this.conn; this.setFollowing(false);
    while (search === this.searchSequence && !this.snapshot.reachedStart && this.snapshot.olderCursor && this.snapshot.status !== "closed" && this.visible) {
      if (this.selection || this.snapshot.error) return false;
      if (this.snapshot.loading) { await pause(10); continue; }
      const cursor = this.snapshot.olderCursor;
      this.update({notice:"searching"}); await this.loadWindow("older",true); if (search !== this.searchSequence || !this.belongsTo(conn)) return false; await pause();
      if (search !== this.searchSequence || !this.belongsTo(conn)) return false;
      if (cursor === this.snapshot.olderCursor && !this.snapshot.reachedStart) { this.update({notice:"searchPaused"}); return false; }
    }
    const reached = search === this.searchSequence && this.snapshot.reachedStart;
    if (reached) this.update({notice:null});
    return reached;
  }
  dispose(): void {
    if (this.snapshot.status === "closed") return;
    activeReaders.delete(this); this.bindingSequence++; this.sequence++; this.searchSequence++; this.conn.detach(this); this.releaseWindow(); this.snapshot = {...this.snapshot,status:"closed",items:[],pages:[]}; this.listeners.clear(); this.beforeMutation=null;
  }
}
export function archiveCacheStats(): { bytes: number; pages: number; connections: number } { return {bytes:cacheBytes,pages:cache.size,connections:connections.size}; }
export { sameDescriptor };

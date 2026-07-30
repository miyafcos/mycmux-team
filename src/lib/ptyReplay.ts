import {
  reset as resetPaintStats,
  setPaintStatsSessionScope,
  snapshot as paintStatsSnapshot,
  type PaintStatsSnapshot,
} from "./paintStats";

export const PTY_RECORDING_VERSION = 1 as const;
export const PTY_RECORDING_MAX_BYTES = 64 * 1024 * 1024;

export interface PtyBatchMetadata {
  generation: number;
  seq: number;
  resync: boolean;
  scrollbackStart: number;
  scrollbackEnd: number;
  data: Uint8Array;
}

export interface PtyRecordingHeader {
  type: "header";
  version: typeof PTY_RECORDING_VERSION;
  sessionId: string;
  startedAt: string;
}

export interface PtyRecordingEvent {
  type: "data";
  offsetMs: number;
  generation: number;
  seq: number;
  resync: boolean;
  scrollbackStart: number;
  scrollbackEnd: number;
  dataBase64: string;
}

export interface PtyRecordingFooter {
  type: "footer";
  endedAt: string;
  eventCount: number;
  bytes: number;
  valid: boolean;
  gaps: number;
}

export interface PtyRecording {
  header: PtyRecordingHeader;
  events: PtyRecordingEvent[];
  footer: PtyRecordingFooter;
}

export interface PtyReplayResult<TSnapshot = unknown> {
  sessionId: string;
  bytes: number;
  writeCalls: number;
  elapsedMs: number;
  snapshot: TSnapshot | null;
}

export interface PtyReplayOptions<TSnapshot = unknown> {
  speed?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  snapshot?: () => TSnapshot;
}

export interface PtyRecordStatus {
  active: boolean;
  sessionId: string;
  eventCount: number;
  bytes: number;
  valid: boolean;
  gaps: number;
  downloadName?: string;
  ndjson?: string;
}

type ReplayWriter = (data: Uint8Array, index: number, eventCount: number) => Promise<void>;
type DevReplayTarget = {
  begin: () => Promise<void> | void;
  write: ReplayWriter;
  end: () => Promise<void> | void;
};
type ActiveRecorder = { recorder: PtyRecorder; requestedPath?: string };
type RawPtyRecordingEvent = Omit<PtyRecordingEvent, "dataBase64"> & { data: Uint8Array };

const activeRecorders = new Map<string, ActiveRecorder>();
const replayTargets = new Map<string, DevReplayTarget>();
const activeReplays = new Set<string>();

function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}

function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid PTY recording ${name}`);
  }
  return value;
}

function parseJsonLine(line: string, index: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Invalid PTY recording JSON at line ${index + 1}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid PTY recording object at line ${index + 1}`);
  }
  return parsed as Record<string, unknown>;
}

function recordingFileName(sessionId: string, requested?: string): string {
  const leaf = requested?.split(/[\\/]/).pop()?.trim();
  const safe = (leaf || `mycmux-pty-${sessionId}-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
  return safe.toLowerCase().endsWith(".ndjson") ? safe : `${safe}.ndjson`;
}

function downloadRecording(contents: string, fileName: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const url = URL.createObjectURL(new Blob([contents], { type: "application/x-ndjson" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export class PtyRecorder {
  private readonly header: PtyRecordingHeader;
  private readonly events: RawPtyRecordingEvent[] = [];
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private lastGeneration: number | null = null;
  private lastSeq: number | null = null;
  private lastScrollbackEnd: number | null = null;
  private bytes = 0;
  private gaps = 0;
  private overflowed = false;

  constructor(
    sessionId: string,
    options: { now?: () => number; wallClock?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    const wallClock = options.wallClock ?? (() => new Date());
    this.startedAtMs = this.now();
    this.header = {
      type: "header",
      version: PTY_RECORDING_VERSION,
      sessionId,
      startedAt: wallClock().toISOString(),
    };
  }

  record(batch: PtyBatchMetadata): void {
    if (this.bytes + batch.data.byteLength > PTY_RECORDING_MAX_BYTES) {
      if (!this.overflowed) {
        this.overflowed = true;
        this.gaps += 1;
      }
      return;
    }
    const offsetMs = Math.max(0, this.now() - this.startedAtMs);
    const discontinuity = this.lastScrollbackEnd !== null
      && batch.scrollbackStart !== this.lastScrollbackEnd;
    const seqGap = this.lastGeneration === batch.generation
      && this.lastSeq !== null
      && batch.seq !== this.lastSeq + 1;
    const spanMismatch = batch.scrollbackEnd < batch.scrollbackStart
      || batch.scrollbackEnd - batch.scrollbackStart !== batch.data.byteLength;
    if (batch.resync || discontinuity || seqGap || spanMismatch) this.gaps += 1;
    this.lastGeneration = batch.generation;
    this.lastSeq = batch.seq;
    this.lastScrollbackEnd = batch.scrollbackEnd;
    this.bytes += batch.data.byteLength;
    this.events.push({
      type: "data",
      offsetMs,
      generation: batch.generation,
      seq: batch.seq,
      resync: batch.resync,
      scrollbackStart: batch.scrollbackStart,
      scrollbackEnd: batch.scrollbackEnd,
      data: batch.data.slice(),
    });
  }

  finish(wallClock: () => Date = () => new Date()): PtyRecording {
    return {
      header: { ...this.header },
      events: this.events.map(({ data, ...event }) => ({
        ...event,
        dataBase64: bytesToBase64(data),
      })),
      footer: {
        type: "footer",
        endedAt: wallClock().toISOString(),
        eventCount: this.events.length,
        bytes: this.bytes,
        valid: this.gaps === 0,
        gaps: this.gaps,
      },
    };
  }
}

export function serializePtyRecording(recording: PtyRecording): string {
  return [recording.header, ...recording.events, recording.footer]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
}

export function parsePtyRecording(contents: string): PtyRecording {
  if (contents.length > PTY_RECORDING_MAX_BYTES * 2) {
    throw new Error("PTY recording exceeds the supported size limit");
  }
  const lines = contents.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error("PTY recording is missing header or footer");
  const objects = lines.map(parseJsonLine);
  const rawHeader = objects[0];
  if (
    rawHeader.type !== "header"
    || rawHeader.version !== PTY_RECORDING_VERSION
    || typeof rawHeader.sessionId !== "string"
    || typeof rawHeader.startedAt !== "string"
  ) {
    throw new Error("Invalid PTY recording header");
  }

  const rawFooter = objects[objects.length - 1];
  if (rawFooter.type !== "footer" || typeof rawFooter.endedAt !== "string") {
    throw new Error("Invalid PTY recording footer");
  }

  let previousOffset = -1;
  let previousGeneration: number | null = null;
  let previousSeq: number | null = null;
  let previousScrollbackEnd: number | null = null;
  let computedGaps = 0;
  const events = objects.slice(1, -1).map((raw, index): PtyRecordingEvent => {
    if (
      raw.type !== "data"
      || typeof raw.dataBase64 !== "string"
      || typeof raw.resync !== "boolean"
    ) {
      throw new Error(`Invalid PTY recording event at index ${index}`);
    }
    const event: PtyRecordingEvent = {
      type: "data",
      offsetMs: finiteNonNegative(raw.offsetMs, "offsetMs"),
      generation: finiteNonNegative(raw.generation, "generation"),
      seq: finiteNonNegative(raw.seq, "seq"),
      resync: raw.resync,
      scrollbackStart: finiteNonNegative(raw.scrollbackStart, "scrollbackStart"),
      scrollbackEnd: finiteNonNegative(raw.scrollbackEnd, "scrollbackEnd"),
      dataBase64: raw.dataBase64,
    };
    for (const [name, value] of [
      ["generation", event.generation],
      ["seq", event.seq],
      ["scrollbackStart", event.scrollbackStart],
      ["scrollbackEnd", event.scrollbackEnd],
    ] as const) {
      if (!Number.isSafeInteger(value)) throw new Error(`Invalid PTY recording ${name}`);
    }
    if (event.offsetMs < previousOffset) throw new Error("PTY recording events are out of order");
    previousOffset = event.offsetMs;
    const data = base64ToBytes(event.dataBase64);
    const discontinuity = previousScrollbackEnd !== null
      && event.scrollbackStart !== previousScrollbackEnd;
    const seqGap = previousGeneration === event.generation
      && previousSeq !== null
      && event.seq !== previousSeq + 1;
    const spanMismatch = event.scrollbackEnd < event.scrollbackStart
      || event.scrollbackEnd - event.scrollbackStart !== data.byteLength;
    if (event.resync || discontinuity || seqGap || spanMismatch) computedGaps += 1;
    previousGeneration = event.generation;
    previousSeq = event.seq;
    previousScrollbackEnd = event.scrollbackEnd;
    return event;
  });

  const footer: PtyRecordingFooter = {
    type: "footer",
    endedAt: rawFooter.endedAt,
    eventCount: finiteNonNegative(rawFooter.eventCount, "eventCount"),
    bytes: finiteNonNegative(rawFooter.bytes, "bytes"),
    valid: typeof rawFooter.valid === "boolean" ? rawFooter.valid : false,
    gaps: finiteNonNegative(rawFooter.gaps, "gaps"),
  };
  const decodedBytes = events.reduce((total, event) => total + base64ToBytes(event.dataBase64).byteLength, 0);
  if (footer.eventCount !== events.length || footer.bytes !== decodedBytes) {
    throw new Error("PTY recording footer does not match its events");
  }
  if (footer.gaps !== computedGaps || footer.valid !== (computedGaps === 0)) {
    throw new Error("PTY recording validity metadata does not match its events");
  }

  return {
    header: rawHeader as unknown as PtyRecordingHeader,
    events,
    footer,
  };
}

export async function replayPtyRecording<TSnapshot = unknown>(
  recording: PtyRecording,
  write: ReplayWriter,
  options: PtyReplayOptions<TSnapshot> = {},
): Promise<PtyReplayResult<TSnapshot>> {
  const speed = options.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("Replay speed must be positive");
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));
  const startedAtMs = now();
  let bytes = 0;
  let writeCalls = 0;

  for (const [index, event] of recording.events.entries()) {
    const targetElapsed = event.offsetMs / speed;
    const delay = Math.max(0, targetElapsed - (now() - startedAtMs));
    if (delay > 0) await sleep(delay);
    const data = base64ToBytes(event.dataBase64);
    await write(data, index, recording.events.length);
    bytes += data.byteLength;
    writeCalls += 1;
  }

  return {
    sessionId: recording.header.sessionId,
    bytes,
    writeCalls,
    elapsedMs: Math.max(0, now() - startedAtMs),
    snapshot: options.snapshot ? options.snapshot() : null,
  };
}

export function recordPtyBatchForRecording(sessionId: string, batch: PtyBatchMetadata): void {
  if (!import.meta.env.DEV) return;
  activeRecorders.get(sessionId)?.recorder.record(batch);
}

export function registerPtyReplayTarget(sessionId: string, target: DevReplayTarget): () => void {
  if (!import.meta.env.DEV) return () => {};
  replayTargets.set(sessionId, target);
  return () => {
    if (replayTargets.get(sessionId) === target) replayTargets.delete(sessionId);
  };
}

function togglePtyRecording(sessionId: string, requestedPath?: string): PtyRecordStatus {
  const active = activeRecorders.get(sessionId);
  if (!active) {
    if (!replayTargets.has(sessionId)) {
      throw new Error(`No mounted xterm for PTY recording session ${sessionId}`);
    }
    activeRecorders.set(sessionId, {
      recorder: new PtyRecorder(sessionId),
      requestedPath,
    });
    return { active: true, sessionId, eventCount: 0, bytes: 0, valid: true, gaps: 0 };
  }

  activeRecorders.delete(sessionId);
  const recording = active.recorder.finish();
  const ndjson = serializePtyRecording(recording);
  const downloadName = recordingFileName(sessionId, requestedPath ?? active.requestedPath);
  downloadRecording(ndjson, downloadName);
  return {
    active: false,
    sessionId,
    eventCount: recording.footer.eventCount,
    bytes: recording.footer.bytes,
    valid: recording.footer.valid,
    gaps: recording.footer.gaps,
    downloadName,
    ndjson,
  };
}

async function replayFromDevApi(
  source: string | File,
  targetSessionId?: string,
  speed = 1,
): Promise<PtyReplayResult<PaintStatsSnapshot>> {
  if (source instanceof File && source.size > PTY_RECORDING_MAX_BYTES * 2) {
    throw new Error("PTY recording exceeds the supported size limit");
  }
  const contents = typeof source === "string" ? source : await source.text();
  const recording = parsePtyRecording(contents);
  if (!recording.footer.valid) throw new Error("PTY recording contains a resync or byte gap");
  const sessionId = targetSessionId ?? recording.header.sessionId;
  const target = replayTargets.get(sessionId);
  if (!target) throw new Error(`No mounted xterm for PTY replay session ${sessionId}`);
  if (activeReplays.size > 0) throw new Error("Another PTY replay is already active");
  activeReplays.add(sessionId);
  let began = false;
  try {
    await target.begin();
    began = true;
    await settleBrowser(32);
    setPaintStatsSessionScope(sessionId);
    resetPaintStats();
    const result = await replayPtyRecording(recording, target.write, { speed });
    const scanSettleMs = typeof document !== "undefined"
      && (document.visibilityState === "hidden" || !document.hasFocus())
      ? 1100
      : 250;
    await settleBrowser(scanSettleMs);
    const targetResult = { ...result, sessionId, snapshot: paintStatsSnapshot() };
    console.log(`[mycmux-diag pty-replay:${sessionId}] completed`, targetResult);
    return targetResult;
  } finally {
    setPaintStatsSessionScope(null);
    if (began) await target.end();
    activeReplays.delete(sessionId);
  }
}

async function settleBrowser(minimumDelayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, minimumDelayMs));
  if (typeof requestAnimationFrame !== "function") return;
  await Promise.race([
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 100)),
  ]);
}

async function chooseReplayFile(targetSessionId?: string, speed = 1): Promise<PtyReplayResult<PaintStatsSnapshot>> {
  if (typeof document === "undefined") throw new Error("File picker is unavailable");
  const file = await new Promise<File>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ndjson,application/x-ndjson,application/json";
    input.onchange = () => {
      const selected = input.files?.[0];
      if (selected) resolve(selected);
      else reject(new Error("No PTY recording selected"));
    };
    input.addEventListener("cancel", () => reject(new Error("PTY recording selection cancelled")), { once: true });
    input.click();
  });
  return replayFromDevApi(file, targetSessionId, speed);
}

declare global {
  interface Window {
    __mycmuxPtyRecord?: typeof togglePtyRecording;
    __mycmuxPtyReplay?: typeof replayFromDevApi;
    __mycmuxPtyReplayFile?: typeof chooseReplayFile;
  }
}

if (typeof window !== "undefined" && import.meta.env.DEV) {
  window.__mycmuxPtyRecord = togglePtyRecording;
  window.__mycmuxPtyReplay = replayFromDevApi;
  window.__mycmuxPtyReplayFile = chooseReplayFile;
}

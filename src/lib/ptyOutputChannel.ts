import { Channel } from "@tauri-apps/api/core";

export const PTY_CHANNEL_GAP_MS = 250;
export const PTY_CHANNEL_PENDING_LIMIT = 16;
export const PTY_CHANNEL_PENDING_BYTES = 512 * 1024;

type Message = { index: number; message?: ArrayBuffer; end?: boolean };
type Bridge = {
  transformCallback: (callback: (message: Message) => void, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
};

/**
 * Tauri's ordered Channel waits forever for a missing fetch response. PTY
 * frames already contain absolute offsets: after a bounded reorder grace,
 * skip the missing message and let the terminal recover from its scrollback.
 * This uses the same callback envelope and serialization as Channel on both
 * WebView2 and WebKit, without modifying the installed Tauri dependency.
 */
export class PtyOutputChannel extends Channel<ArrayBuffer> {
  private nextIndex = 0;
  private pending = new Map<number, ArrayBuffer>();
  private pendingBytes = 0;
  private endIndex: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private bridge: Bridge | undefined;
  private closed = false;
  private gap = false;

  constructor() {
    super();
    const bridge = (globalThis as typeof globalThis & {
      window?: { __TAURI_INTERNALS__?: Bridge };
    }).window?.__TAURI_INTERNALS__;
    // Plain Node/mock environments retain the ordinary Channel test surface.
    if (!bridge?.transformCallback || !bridge.unregisterCallback) return;
    this.bridge = bridge;
    bridge.unregisterCallback(this.id);
    this.id = bridge.transformCallback(message => this.ingest(message));
  }

  consumeGap(): boolean {
    const gap = this.gap;
    this.gap = false;
    return gap;
  }

  private ingest(message: Message): void {
    if (this.closed || !Number.isSafeInteger(message.index) || message.index < this.nextIndex) return;
    if ("end" in message) this.endIndex = message.index;
    else if (message.message instanceof ArrayBuffer && !this.pending.has(message.index)) {
      this.pending.set(message.index, message.message);
      this.pendingBytes += message.message.byteLength;
    }
    this.drain();
    if (this.pending.size >= PTY_CHANNEL_PENDING_LIMIT || this.pendingBytes >= PTY_CHANNEL_PENDING_BYTES) {
      this.skipGap();
    } else if (!this.closed && (this.pending.size > 0 || this.endIndex !== null) && this.timer === null) {
      this.timer = setTimeout(() => { this.timer = null; this.skipGap(); }, PTY_CHANNEL_GAP_MS);
    }
  }

  private drain(): void {
    while (this.pending.has(this.nextIndex)) {
      const frame = this.pending.get(this.nextIndex)!;
      this.pending.delete(this.nextIndex++);
      this.pendingBytes -= frame.byteLength;
      this.onmessage(frame);
    }
    if (this.endIndex !== null && this.nextIndex >= this.endIndex) this.dispose();
    if (this.pending.size === 0 && this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private skipGap(): void {
    if (this.closed) return;
    const next = Math.min(...this.pending.keys(), this.endIndex ?? Infinity);
    if (!Number.isFinite(next)) return;
    if (next > this.nextIndex) { this.gap = true; this.nextIndex = next; }
    this.drain();
    if (!this.closed && (this.pending.size > 0 || this.endIndex !== null) && this.timer === null) {
      this.timer = setTimeout(() => { this.timer = null; this.skipGap(); }, PTY_CHANNEL_GAP_MS);
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.pendingBytes = 0;
    this.bridge?.unregisterCallback(this.id);
  }
}

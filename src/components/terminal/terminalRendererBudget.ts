/** GPU contexts, including parked terminals, stay below Chromium's limit of 16. */
export const MAX_TERMINAL_RENDERERS = 12;
export type RendererPriority = { visible: boolean; focused: boolean };
type Entry<T> = { dispose: (requester?: T) => boolean | void; priority: () => RendererPriority };

export class TerminalRendererBudget<T extends object> {
  private readonly entries = new Map<T, Entry<T>>();
  constructor(private readonly limit = MAX_TERMINAL_RENDERERS) {}
  get size(): number { return this.entries.size; }
  touch(terminal: T): void {
    const entry = this.entries.get(terminal);
    if (!entry) return;
    this.entries.delete(terminal); this.entries.set(terminal, entry);
  }
  reserve(terminal: T, dispose: (requester?: T) => boolean | void,
    priority: () => RendererPriority = () => ({ visible: false, focused: false }),
    onDenied?: (protectingHigherPriority: boolean) => void): boolean {
    this.forget(terminal);
    let evictionAttempted = false;
    if (this.entries.size >= this.limit) {
      const rank = ({ visible, focused }: RendererPriority) => visible ? (focused ? 2 : 1) : 0;
      const requesterRank = rank(priority());
      const candidates = [...this.entries].map(([victim, entry]) => ({ victim, entry, rank: rank(entry.priority()) }));
      // Stable order within each tier is LRU. A request cannot evict a higher tier.
      for (const candidate of candidates.sort((a, b) => a.rank - b.rank)) {
        if (candidate.rank > requesterRank) break;
        evictionAttempted = true;
        try {
          if (candidate.entry.dispose(terminal) === false) continue;
          this.entries.delete(candidate.victim);
          break;
        } catch { /* This context is still owned; try the next eligible victim. */ }
      }
    }
    if (this.entries.size >= this.limit) {
      onDenied?.(!evictionAttempted);
      return false;
    }
    this.entries.set(terminal, { dispose, priority }); return true;
  }
  forget(terminal: T): void { this.entries.delete(terminal); }
}

/** GPU contexts, including parked terminals, stay below Chromium's limit of 16. */
export const MAX_TERMINAL_RENDERERS = 12;

export class TerminalRendererBudget<T extends object> {
  private readonly entries = new Map<T, () => void>();

  constructor(private readonly limit = MAX_TERMINAL_RENDERERS) {}

  touch(terminal: T): void {
    const dispose = this.entries.get(terminal);
    if (!dispose) return;
    this.entries.delete(terminal);
    this.entries.set(terminal, dispose);
  }

  reserve(terminal: T, dispose: () => void): void {
    this.forget(terminal);
    // Release before creating the next context, not one context later.
    while (this.entries.size >= this.limit) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      oldest[1]();
    }
    this.entries.set(terminal, dispose);
  }

  forget(terminal: T): void {
    this.entries.delete(terminal);
  }
}

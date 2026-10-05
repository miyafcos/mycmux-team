/** A lost IPC response must not own a terminal's pump forever. */
export const TERMINAL_IPC_TIMEOUT_MS = 4_000;
export const TERMINAL_ATTACH_TIMEOUT_MS = 8_000;

export class TerminalDeadlineError extends Error {
  constructor(operation: string) {
    super(`Terminal IPC timed out: ${operation}`);
    this.name = "TerminalDeadlineError";
  }
}

export function withTerminalDeadline<T>(
  pending: Promise<T>,
  operation: string,
  timeoutMs = TERMINAL_IPC_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TerminalDeadlineError(operation)), timeoutMs);
    // Both handlers remain attached after timeout. Late failures are consumed;
    // late success cannot continue the timed-out caller or mutate its state.
    pending.then(value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

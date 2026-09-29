export type TerminalFrontendAck = {
  generation: number;
  seq: number;
  bytes: number;
};

type SendAck = (ack: TerminalFrontendAck) => Promise<void>;

const ACK_FLUSH_DELAY_MS = 32;
const ACK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1000] as const;
const ACK_SEND_TIMEOUT_MS = 1000;

function sendWithTimeout(
  send: SendAck,
  ack: TerminalFrontendAck,
  onRequestSettled: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("terminal ACK timed out")), ACK_SEND_TIMEOUT_MS);
    void send(ack).then(
      () => {
        clearTimeout(timeout);
        onRequestSettled();
        resolve();
      },
      (error) => {
        clearTimeout(timeout);
        onRequestSettled();
        reject(error);
      },
    );
  });
}

/**
 * Backend ACKs are cumulative within one frontend generation. Keep only the
 * highest sequence and retry it so a transient IPC failure cannot leave the
 * backend permanently stuck in AutoConsume mode.
 */
export class TerminalAckCoalescer {
  private latest: TerminalFrontendAck | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private disposed = false;
  private retryAttempt = 0;
  private highestGenerationSeen = -1;
  private highestSuccessfulSeq = -1;
  private attemptToken = 0;
  private activeAttemptsByGeneration = new Map<number, number>();

  constructor(private readonly send: SendAck) {}

  enqueue(ack: TerminalFrontendAck): void {
    if (this.disposed) return;
    if (ack.generation < this.highestGenerationSeen) return;
    const generationChanged = ack.generation > this.highestGenerationSeen;
    if (generationChanged) {
      this.highestGenerationSeen = ack.generation;
      this.highestSuccessfulSeq = -1;
      this.retryAttempt = 0;
      // An invoke from the replaced channel may never settle. Invalidate its
      // completion handlers and let the new generation ACK independently.
      this.attemptToken += 1;
      this.sending = false;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
    if (ack.seq <= this.highestSuccessfulSeq) return;
    if (
      this.latest
      && (
        ack.generation < this.latest.generation
        || (ack.generation === this.latest.generation && ack.seq <= this.latest.seq)
      )
    ) {
      return;
    }
    this.latest = ack;
    this.schedule(generationChanged ? 0 : ACK_FLUSH_DELAY_MS);
  }

  flushAndDispose(): void {
    if (this.disposed) return;
    const finalAck = this.latest;
    this.disposed = true;
    this.latest = null;
    this.attemptToken += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (
      finalAck
      && (this.activeAttemptsByGeneration.get(finalAck.generation) ?? 0) < 2
    ) {
      void this.send(finalAck).catch(() => {});
    }
  }

  private schedule(delayMs: number): void {
    if (this.disposed || this.sending || this.timer || !this.latest) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.sending || !this.latest) return;
    const candidate = this.latest;
    const activeAttempts = this.activeAttemptsByGeneration.get(candidate.generation) ?? 0;
    if (activeAttempts >= 2) {
      this.schedule(1000);
      return;
    }
    this.activeAttemptsByGeneration.set(candidate.generation, activeAttempts + 1);
    const token = ++this.attemptToken;
    this.sending = true;
    let retryDelay = 0;
    try {
      await sendWithTimeout(this.send, candidate, () => {
        const remaining = Math.max(
          0,
          (this.activeAttemptsByGeneration.get(candidate.generation) ?? 1) - 1,
        );
        if (remaining === 0) {
          this.activeAttemptsByGeneration.delete(candidate.generation);
        } else {
          this.activeAttemptsByGeneration.set(candidate.generation, remaining);
        }
        if (
          !this.disposed
          && !this.sending
          && this.latest?.generation === candidate.generation
        ) {
          this.schedule(0);
        }
      });
      if (this.disposed || token !== this.attemptToken) return;
      this.highestSuccessfulSeq = Math.max(this.highestSuccessfulSeq, candidate.seq);
      if (
        this.latest
        && this.latest.generation === candidate.generation
        && this.latest.seq <= candidate.seq
      ) {
        this.latest = null;
      }
      this.retryAttempt = 0;
    } catch {
      if (this.disposed || token !== this.attemptToken) return;
      const latestGenerationChanged = Boolean(
        this.latest && this.latest.generation !== candidate.generation,
      );
      if (latestGenerationChanged) {
        this.retryAttempt = 0;
      } else {
        retryDelay = ACK_RETRY_DELAYS_MS[
          Math.min(this.retryAttempt, ACK_RETRY_DELAYS_MS.length - 1)
        ];
        this.retryAttempt += 1;
      }
    } finally {
      if (token !== this.attemptToken) return;
      this.sending = false;
      if (!this.disposed && this.latest) {
        this.schedule(retryDelay);
      }
    }
  }
}

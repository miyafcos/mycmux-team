// v0.7.1 diag: per-session committed attach epoch.
// createSession() reserves a unique next epoch, but only publishes it after the
// backend attach succeeds. Older onmessage closures keep rendering until that
// commit; after commit they ACK/drop stale batches so old attachments cannot
// write into the terminal.
const sessionAttachEpoch = new Map<string, number>();
const sessionAttachNextEpoch = new Map<string, number>();

export type FrontendDataBatch = {
  generation: number;
  seq: number;
  bytes: number;
  resync: boolean;
  data: number[] | ArrayBuffer | Uint8Array;
};

export type AttachEpochHandlers = {
  deliver: (batch: FrontendDataBatch) => void;
  ackStale: (batch: FrontendDataBatch, current: number | undefined) => void;
};

export type AttachEpochLifecycle = {
  readonly previousEpoch: number;
  readonly epoch: number;
  readonly messageCount: number;
  ingest: (batch: FrontendDataBatch) => void;
  commit: () => void;
  fail: () => void;
};

export function getCurrentSessionEpoch(sessionId: string): number {
  return sessionAttachEpoch.get(sessionId) ?? 0;
}

function reserveSessionAttachEpoch(sessionId: string): number {
  const current = sessionAttachEpoch.get(sessionId) ?? 0;
  const next = (sessionAttachNextEpoch.get(sessionId) ?? current) + 1;
  sessionAttachNextEpoch.set(sessionId, next);
  return next;
}

export function beginSessionAttach(
  sessionId: string,
  handlers: AttachEpochHandlers,
): AttachEpochLifecycle {
  const previousEpoch = sessionAttachEpoch.get(sessionId) ?? 0;
  const epoch = reserveSessionAttachEpoch(sessionId);
  const pendingBatches: FrontendDataBatch[] = [];
  let messageCount = 0;
  let attachResolved = false;
  let attachFailed = false;

  const flushPendingBatches = (): void => {
    const pending = pendingBatches.splice(0);
    for (const batch of pending) {
      const current = sessionAttachEpoch.get(sessionId);
      if (current === epoch) {
        handlers.deliver(batch);
      } else {
        handlers.ackStale(batch, current);
      }
    }
  };

  return {
    previousEpoch,
    epoch,
    get messageCount() {
      return messageCount;
    },
    ingest(batch) {
      messageCount += 1;
      const current = sessionAttachEpoch.get(sessionId);
      if (current !== epoch) {
        if (!attachResolved && !attachFailed && (current ?? 0) === previousEpoch) {
          pendingBatches.push(batch);
        } else {
          handlers.ackStale(batch, current);
        }
        return;
      }
      handlers.deliver(batch);
    },
    commit() {
      attachResolved = true;
      sessionAttachEpoch.set(sessionId, epoch);
      flushPendingBatches();
    },
    fail() {
      attachFailed = true;
      for (const batch of pendingBatches.splice(0)) {
        handlers.ackStale(batch, sessionAttachEpoch.get(sessionId));
      }
    },
  };
}

export function __resetAttachEpochStateForTests(): void {
  sessionAttachEpoch.clear();
  sessionAttachNextEpoch.clear();
}

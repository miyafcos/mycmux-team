/**
 * Order for the catch-up work a terminal does when its window comes back.
 *
 * A window returning from behind another app wakes every mounted pane in the
 * same tick. Letting them all refit, repaint and pull their scrollback at once
 * is what the reader feels as the stall right after Cmd-Tab. This admits one
 * pane at a time: the pane the reader is in first, the rest spaced out behind
 * it, and each one only after the previous has settled.
 */

/** Requests arriving in the same tick are collected before the first one runs. */
export const TERMINAL_RESYNC_COLLECT_MS = 0;
/** Gap between one pane finishing its catch-up and the next one starting. */
export const TERMINAL_RESYNC_STAGGER_MS = 32;

type ResyncTask = () => void | Promise<void>;

type QueuedResync = {
  sessionId: string;
  active: boolean;
  run: ResyncTask;
};

let queue: QueuedResync[] = [];
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function takeNext(): QueuedResync | undefined {
  const activeIndex = queue.findIndex((entry) => entry.active);
  const [next] = queue.splice(activeIndex >= 0 ? activeIndex : 0, 1);
  return next;
}

function scheduleDrain(delayMs: number): void {
  if (timer !== null || running || queue.length === 0) return;
  timer = setTimeout(() => {
    timer = null;
    drain();
  }, delayMs);
}

function drain(): void {
  if (running || timer !== null) return;
  const next = takeNext();
  if (!next) return;
  running = true;
  let result: void | Promise<void>;
  try {
    result = next.run();
  } catch {
    result = undefined;
  }
  void Promise.resolve(result)
    .catch(() => {})
    .finally(() => {
      running = false;
      scheduleDrain(TERMINAL_RESYNC_STAGGER_MS);
    });
}

/**
 * Queues one pane's catch-up. A second request for the same pane replaces the
 * queued one rather than adding a second pass.
 */
export function requestTerminalResync(
  sessionId: string,
  active: boolean,
  run: ResyncTask,
): void {
  const entry: QueuedResync = { sessionId, active, run };
  const queued = queue.findIndex((candidate) => candidate.sessionId === sessionId);
  if (queued >= 0) queue[queued] = entry;
  else queue.push(entry);
  scheduleDrain(TERMINAL_RESYNC_COLLECT_MS);
}

/** Drops a pane's queued catch-up — it went away, or it is no longer writable. */
export function cancelTerminalResync(sessionId: string): void {
  queue = queue.filter((entry) => entry.sessionId !== sessionId);
}

/** Sessions still waiting their turn, in queue order. Tests read this. */
export function pendingTerminalResyncSessions(): string[] {
  return queue.map((entry) => entry.sessionId);
}

/** Test hook: forget everything, including a drain that is already scheduled. */
export function resetTerminalResyncScheduler(): void {
  queue = [];
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

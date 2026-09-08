export interface WebPaneCommandContext {
  command: string;
  receivedAt: number;
  deadline: number;
}

export function webPaneCommandContext(command: string): WebPaneCommandContext {
  const receivedAt = Date.now();
  return { command, receivedAt, deadline: receivedAt + 25000 };
}

function queuedDeadlineError(context: WebPaneCommandContext): Error {
  return new Error(context.command + " queued past the socket deadline; retry");
}

type TabQueue = { tail: Promise<void>; waiters: Set<() => void> };
const queues = new Map<string, TabQueue>();

export function cancelWebPaneCommandWaiters(tabId: string): void {
  const queue = queues.get(tabId);
  if (queue) for (const cancel of queue.waiters) cancel();
}

// Expiring a waiter settles its caller immediately, but its queue link still
// waits for the prior holder. Later commands must never overtake that holder.
export async function acquireWebPaneCommandLock(
  tabId: string, context: WebPaneCommandContext,
): Promise<() => void> {
  if (Date.now() >= context.deadline) throw queuedDeadlineError(context);
  const queue = queues.get(tabId) ?? { tail: Promise.resolve(), waiters: new Set<() => void>() };
  queues.set(tabId, queue);
  const previous = queue.tail;
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const current = previous.then(() => held);
  queue.tail = current;
  const release = () => {
    finish();
    void current.then(() => {
      if (queues.get(tabId) === queue && queue.tail === current) queues.delete(tabId);
    });
  };
  let cancel!: () => void;
  let timer!: ReturnType<typeof setTimeout>;
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error(context.command + ": tab closed while queued"));
    queue.waiters.add(cancel);
    timer = setTimeout(() => reject(queuedDeadlineError(context)), Math.max(0, context.deadline - Date.now()));
  });
  try {
    await Promise.race([previous, interrupted]);
    if (Date.now() >= context.deadline) throw queuedDeadlineError(context);
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    clearTimeout(timer);
    queue.waiters.delete(cancel);
  }
}

export async function withWebPaneCommandLock<T>(
  tabId: string, context: WebPaneCommandContext, operation: () => T | Promise<T>,
): Promise<T> {
  const release = await acquireWebPaneCommandLock(tabId, context);
  try {
    return await operation();
  } finally {
    release();
  }
}

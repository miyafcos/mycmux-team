interface StartupSessionGateState {
  expected: Set<string>;
  pending: Set<string>;
  readyPromise: Promise<void>;
  resolveReady: (() => void) | null;
}

function createResolvedPromise(): Promise<void> {
  return Promise.resolve();
}

function createGate(sessionIds: string[]): StartupSessionGateState {
  const expected = new Set(sessionIds);
  const pending = new Set(sessionIds);

  if (pending.size === 0) {
    return {
      expected,
      pending,
      readyPromise: createResolvedPromise(),
      resolveReady: null,
    };
  }

  let resolveReady: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  return {
    expected,
    pending,
    readyPromise,
    resolveReady,
  };
}

let gate = createGate([]);

export function prepareStartupSessionGate(sessionIds: string[]): void {
  gate = createGate(sessionIds);
  console.log(`[startup] prepared session gate for ${sessionIds.length} visible sessions`);
}

export function markStartupSessionSettled(sessionId: string): void {
  if (!gate.expected.has(sessionId)) {
    return;
  }

  if (!gate.pending.delete(sessionId)) {
    return;
  }

  console.log(`[startup] session settled: ${sessionId} (${gate.pending.size} remaining)`);

  if (gate.pending.size === 0) {
    gate.resolveReady?.();
    gate.resolveReady = null;
  }
}

export function getStartupSessionGateSnapshot(): { expected: number; pending: number } {
  return {
    expected: gate.expected.size,
    pending: gate.pending.size,
  };
}

export async function waitForStartupSessionGate(timeoutMs: number): Promise<{ timedOut: boolean; pending: number }> {
  if (gate.pending.size === 0) {
    return { timedOut: false, pending: 0 };
  }

  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ timedOut: true, pending: gate.pending.size });
    }, timeoutMs);

    gate.readyPromise.then(() => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      resolve({ timedOut: false, pending: 0 });
    });
  });
}

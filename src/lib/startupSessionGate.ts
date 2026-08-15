import type { Workspace } from "../types";

interface StartupSessionGateState {
  expected: Set<string>;
  pending: Set<string>;
  readyPromise: Promise<void>;
  resolveReady: (() => void) | null;
  completionEmitted: boolean;
}

export const STARTUP_RESTORE_COMPLETE_EVENT = "startup-restore-complete";

export function collectStartupSessionIds(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
): string[] {
  const startupWorkspace = (
    activeWorkspaceId
      ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)
      : undefined
  ) ?? workspaces[0];
  if (!startupWorkspace) return [];

  return startupWorkspace.panes.flatMap((pane) => {
    const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
    return activeTab ? [activeTab.sessionId] : [];
  });
}

function createResolvedPromise(): Promise<void> {
  return Promise.resolve();
}

function maybeEmitStartupRestoreComplete(): void {
  if (gate.completionEmitted || gate.pending.size > 0) {
    return;
  }
  gate.completionEmitted = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(STARTUP_RESTORE_COMPLETE_EVENT));
  }
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
      completionEmitted: false,
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
    completionEmitted: false,
  };
}

let gate = createGate([]);
const listeners = new Set<() => void>();

function notifyListeners(): void {
  listeners.forEach((listener) => listener());
}

export function prepareStartupSessionGate(sessionIds: string[]): void {
  gate = createGate(sessionIds);
  notifyListeners();
  if (gate.pending.size === 0 && typeof window !== "undefined") {
    window.queueMicrotask(maybeEmitStartupRestoreComplete);
  }
}

export function markStartupSessionSettled(sessionId: string): void {
  if (!gate.expected.has(sessionId)) {
    return;
  }

  if (!gate.pending.delete(sessionId)) {
    return;
  }

  notifyListeners();

  if (gate.pending.size === 0) {
    gate.resolveReady?.();
    gate.resolveReady = null;
    maybeEmitStartupRestoreComplete();
  }
}

export function isStartupSessionPending(sessionId: string): boolean {
  return gate.pending.has(sessionId);
}

export function subscribeStartupSessionGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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

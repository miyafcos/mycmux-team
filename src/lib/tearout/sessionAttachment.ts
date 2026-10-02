import { useSyncExternalStore } from "react";

const expected = new Map<string, { resolve: () => void }>();
const listeners = new Set<() => void>();
let revision = 0;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => revision;
function changed(): void { revision++; for (const listener of listeners) listener(); }
export function useTearoutAttachmentRevision(): void { useSyncExternalStore(subscribe, snapshot); }
export const hasTearoutSessionAttachment = (sessionId: string): boolean => expected.has(sessionId);

export function markTearoutSessionAttached(sessionId: string): void {
  expected.get(sessionId)?.resolve();
}

export function expectTearoutAttachments(sessionIds: string[]): { ready: Promise<void>; dispose: () => void } {
  const entries = sessionIds.map((sessionId) => {
    let resolve = () => {};
    const ready = new Promise<void>((yes) => { resolve = yes; });
    const entry = { resolve };
    expected.set(sessionId, entry);
    return { sessionId, entry, ready };
  });
  changed();
  return {
    ready: Promise.all(entries.map((entry) => entry.ready)).then(() => {}),
    dispose: () => {
      let removed = false;
      for (const { sessionId, entry } of entries) {
        if (expected.get(sessionId) === entry) { expected.delete(sessionId); removed = true; }
      }
      if (removed) changed();
    },
  };
}

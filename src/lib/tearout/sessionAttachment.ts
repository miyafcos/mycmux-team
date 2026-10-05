import { useSyncExternalStore } from "react";

const generations = new Map<string, number>();
export const tearoutAttachmentGeneration = (id: string): number => generations.get(id) ?? 0;
const expected = new Map<string, { resolve: () => void; kind: "transfer" | "prewarm" }>();
// Retain a bounded-by-session marker after disposal so a delayed mount can
// still be recognized when it finally reaches createSession.
const prewarmedSessions = new Map<string, () => boolean>();
export const macPrewarmSessionOwned = (sessionId: string): boolean => prewarmedSessions.get(sessionId)?.() ?? true;
export function macPrewarmAttachGuard(sessionId: string): (() => boolean) | null {
  const entry = expected.get(sessionId);
  return entry?.kind === "prewarm" ? () => expected.get(sessionId) === entry : null;
}
// A moved stopped terminal must not respawn merely because its new owner mounts.
const dormantSessions = new Set<string>();
export const isTearoutSessionDormant = (id: string): boolean => dormantSessions.has(id);
export function rememberTearoutDormantSessions(all: string[], live: string[]): void {
  const running = new Set(live);
  for (const id of all) { if (running.has(id)) dormantSessions.delete(id); else dormantSessions.add(id); }
  changed();
}
export function startDormantTearoutSession(id: string): void { if (dormantSessions.delete(id)) changed(); }
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

export function expectTearoutAttachments(sessionIds: string[], kind: "transfer" | "prewarm" = "transfer", ownsSession: (id: string) => boolean = () => true): { ready: Promise<void>; dispose: () => void } {
  const entries = sessionIds.map((sessionId) => {
    let resolve = () => {};
    const ready = new Promise<void>((yes) => { resolve = yes; });
    const entry = { resolve, kind };
    if (kind === "transfer") generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
    if (kind === "prewarm") prewarmedSessions.set(sessionId, () => ownsSession(sessionId));
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

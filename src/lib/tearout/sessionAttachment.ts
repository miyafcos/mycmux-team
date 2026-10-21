import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { withTerminalDeadline } from "../terminalDeadline";

export interface AttachmentContext {
  backend_epoch: string;
  transfer_id: string | null;
  transfer_token: string | null;
  session_id: string;
  window_label: string;
  window_incarnation: string;
  attachment_epoch: number;
  nonce: string;
  existing_only: boolean;
}
export interface SessionAttachmentResult { context: AttachmentContext; channelId: number }
export interface SessionAttachmentAttempt {
  readonly context: Promise<AttachmentContext>;
  current: () => boolean;
}
export function sameAttachmentContext(a?: AttachmentContext, b?: AttachmentContext): boolean {
  return Boolean(a && b && a.backend_epoch === b.backend_epoch && a.transfer_id === b.transfer_id
    && a.transfer_token === b.transfer_token && a.session_id === b.session_id
    && a.window_label === b.window_label && a.window_incarnation === b.window_incarnation
    && a.attachment_epoch === b.attachment_epoch && a.nonce === b.nonce && a.existing_only === b.existing_only);
}
const generations = new Map<string, number>();
export const tearoutAttachmentGeneration = (id: string): number => generations.get(id) ?? 0;
interface Expected {
  attempt: SessionAttachmentAttempt; context?: AttachmentContext; channelId?: number;
  resolve: () => void; reject: (error: unknown) => void; disposed: boolean; kind: "transfer" | "prewarm";
}
const expected = new Map<string, Expected>();
const prewarmedSessions = new Map<string, () => boolean>();
export const macPrewarmSessionOwned = (sessionId: string): boolean => prewarmedSessions.get(sessionId)?.() ?? true;
export function macPrewarmAttachGuard(sessionId: string): (() => boolean) | null {
  const entry = expected.get(sessionId);
  return entry?.kind === "prewarm" ? entry.attempt.current : null;
}
export function requestAttachmentContexts(sessionIds: string[], existingOnly: boolean, transferToken?: string): Promise<AttachmentContext[]> {
  if (!sessionIds.length) return Promise.resolve([]);
  return withTerminalDeadline(invoke<AttachmentContext[]>("get_session_attachment_contexts", {
    sessionIds, existingOnly, transferToken: transferToken ?? null,
  }), "get_session_attachment_contexts")
    .then(contexts => {
      if (!Array.isArray(contexts) || contexts.length !== sessionIds.length
        || sessionIds.some(id => contexts.filter(context => context.session_id === id).length !== 1)) {
        throw new Error("attachment_context_response_invalid");
      }
      return contexts;
    });
}
// Capture before the async attachment starts. An ordinary mount lazily requests
// its authority when its serialized operation reaches the backend.
export function captureSessionAttachment(sessionId: string, existingOnly = false): SessionAttachmentAttempt {
  const entry = expected.get(sessionId);
  if (entry) return entry.attempt;
  const generation = tearoutAttachmentGeneration(sessionId);
  let context: Promise<AttachmentContext> | undefined;
  return {
    get context() {
      return context ??= requestAttachmentContexts([sessionId], existingOnly).then(contexts => contexts[0]);
    },
    current: () => tearoutAttachmentGeneration(sessionId) === generation && !expected.has(sessionId),
  };
}
export function markTearoutSessionAttached(sessionId: string, result: SessionAttachmentResult): boolean {
  const entry = expected.get(sessionId);
  if (!entry || !entry.attempt.current() || !sameAttachmentContext(entry.context, result?.context)) return false;
  if (entry.channelId !== undefined && entry.channelId !== result.channelId) return false;
  entry.channelId = result.channelId; entry.resolve(); return true;
}
export function failTearoutSessionAttachment(sessionId: string, attempt: SessionAttachmentAttempt, error: unknown): void {
  const entry = expected.get(sessionId);
  if (entry?.attempt === attempt && attempt.current()) entry.reject(error);
}
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

export function expectTearoutAttachments(sessionIds: string[], kind: "transfer" | "prewarm" = "transfer",
  ownsSession: (id: string) => boolean = () => true, transferToken?: string,
): { prepared: Promise<void>; ready: Promise<void>; dispose: () => void } {
  const contexts = requestAttachmentContexts(sessionIds, true, transferToken);
  const entries = sessionIds.map(sessionId => {
    let resolve = () => {}, reject = (_error: unknown) => {};
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const entry: Expected = { attempt: undefined as unknown as SessionAttachmentAttempt, resolve, reject, disposed: false, kind };
    entry.attempt = {
      context: contexts.then(values => {
        const context = values.find(value => value.session_id === sessionId)!;
        entry.context = context; return context;
      }),
      current: () => !entry.disposed && expected.get(sessionId) === entry && ownsSession(sessionId),
    };
    void entry.attempt.context.catch(error => failTearoutSessionAttachment(sessionId, entry.attempt, error));
    generations.set(sessionId, tearoutAttachmentGeneration(sessionId) + 1);
    if (kind === "prewarm") prewarmedSessions.set(sessionId, () => ownsSession(sessionId));
    expected.set(sessionId, entry);
    return { sessionId, entry, ready };
  });
  const prepared = Promise.all(entries.map(({ entry }) => entry.attempt.context)).then(() => {});
  const ready = Promise.all([prepared, ...entries.map(entry => entry.ready)]).then(() => {});
  void prepared.catch(() => {}); void ready.catch(() => {});
  changed();
  return { prepared, ready, dispose: () => {
    let removed = false;
    for (const { sessionId, entry } of entries) {
      entry.disposed = true; entry.reject(new Error("attachment_expectation_disposed"));
      if (expected.get(sessionId) === entry) { expected.delete(sessionId); removed = true; }
    }
    if (removed) changed();
  } };
}

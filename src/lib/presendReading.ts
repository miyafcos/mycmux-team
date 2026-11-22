import type { ComposerTarget } from "./composerSend";
import { OMITTED, scrubPresendCredentials } from "./scrubCredentials";

export type PresendReadingProvider = "claude" | "codex";
export interface PresendReading {
  reading: string;
  assumption: string;
  missing: string;
  elapsedMs: number;
  provider: PresendReadingProvider;
}
export const PRESEND_DELAY_MS = 1_500;
export const PRESEND_MIN_CHARS = 12;
export const PRESEND_CONTEXT_CHARS = 1_500;

export function normalizePresendProvider(value: unknown): PresendReadingProvider {
  return value === "codex" ? "codex" : "claude";
}

export interface PresendTrigger {
  enabled: boolean;
  tabEnabled: boolean;
  target: ComposerTarget;
  draft: string;
  composing: boolean;
  quietMs: number;
  attempted?: ReadonlySet<string>;
}

// 64-bit FNV-1a over the UTF-16 code units, paired with the draft's length.
export function presendDraftFingerprint(draft: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < draft.length; i++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(draft.charCodeAt(i))) * 0x100000001b3n);
  }
  return `${draft.length}:${hash.toString(16).padStart(16, "0")}`;
}

/** No timer, side effects, or provider call: callers can test the whole gate. */
export function shouldReadPresend(input: PresendTrigger): boolean {
  return input.enabled && input.tabEnabled && input.target !== "shell" && !input.composing
    && Array.from(input.draft.replace(/\s/gu, "")).length >= PRESEND_MIN_CHARS
    && input.quietMs >= PRESEND_DELAY_MS && !input.attempted?.has(presendDraftFingerprint(input.draft));
}

export interface PresendRevision {
  sessionId: string;
  draft: string;
  target: ComposerTarget;
  revision: number;
  provider: PresendReadingProvider;
}
export function samePresendRevision(request: PresendRevision, current: PresendRevision): boolean {
  return request.sessionId === current.sessionId && request.draft === current.draft
    && request.revision === current.revision && request.provider === current.provider && request.target === current.target;
}

export function presendWorkdirName(cwd: string): string {
  const safePath = scrubPresendCredentials(cwd).replace(/^[A-Za-z]:/, "");
  const name = safePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return name.includes(OMITTED) ? OMITTED : name;
}

/** Scrub before taking the tail: a clipped credential can lose its prefix. */
export function unicodeTail(value: string, count: number): string {
  return Array.from(value).slice(-count).join("");
}

export function appendPresendLine(draft: string, kind: "assumption" | "missing", value: string): string {
  const addition = kind === "missing" ? `${value}: ` : `\u524d\u63d0: ${value}`;
  return `${draft}${draft.endsWith("\n") || !draft ? "" : "\n"}${addition}`;
}

// Tab-local consent and de-duplication live only in this renderer's memory.
const tabs = new Map<string, { enabled: boolean; attempted: Set<string> }>();
const listeners = new Set<() => void>();
export function presendTab(sessionId: string) {
  return tabs.get(sessionId);
}
export function ensurePresendTab(sessionId: string) {
  let tab = presendTab(sessionId);
  if (!tab) {
    tab = { enabled: true, attempted: new Set<string>() };
    tabs.set(sessionId, tab);
  }
  return tab;
}
export function clearPresendAttempts(sessionId: string): void {
  tabs.get(sessionId)?.attempted.clear();
}
export function forgetPresendTab(sessionId: string): void {
  if (tabs.delete(sessionId)) listeners.forEach(listener => listener());
}
export function setPresendTabEnabled(sessionId: string, enabled: boolean): void {
  ensurePresendTab(sessionId).enabled = enabled;
  listeners.forEach(listener => listener());
}
export function subscribePresendTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

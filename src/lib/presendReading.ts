import { invoke } from "@tauri-apps/api/core";
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
export type PresendResult = PresendReading | {
  disposition: "attempted" | "superseded";
  attempted?: boolean;
};

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
  provider?: PresendReadingProvider;
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

export function presendAttemptKey(draft: string, provider: PresendReadingProvider): string {
  return `${provider}:${presendDraftFingerprint(draft)}`;
}

/** No timer, side effects, or provider call: callers can test the whole gate. */
export function shouldReadPresend(input: PresendTrigger): boolean {
  return input.enabled && input.tabEnabled && input.target !== "shell" && !input.composing
    && Array.from(input.draft.replace(/\s/gu, "")).length >= PRESEND_MIN_CHARS
    && input.quietMs >= PRESEND_DELAY_MS
    && !input.attempted?.has(presendAttemptKey(input.draft, input.provider ?? "claude"));
}

export interface PresendConversation {
  agentKind: string;
  agentSessionId: string;
}

export interface PresendRevision {
  sessionId: string;
  draft: string;
  target: ComposerTarget;
  revision: number;
  provider: PresendReadingProvider;
  ptyRevision?: number;
  conversationKey?: string;
}
export function samePresendRevision(request: PresendRevision, current: PresendRevision): boolean {
  return request.sessionId === current.sessionId && request.draft === current.draft
    && request.revision === current.revision && request.provider === current.provider
    && request.target === current.target && request.ptyRevision === current.ptyRevision
    && request.conversationKey === current.conversationKey;
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

// Keep the renderer cache and de-duplication in memory.
interface PresendTab {
  enabled: boolean;
  attempted: Set<string>;
  paused?: "saving" | "failed";
}

const tabs = new Map<string, PresendTab>();
const preferenceRevisions = new WeakMap<PresendTab, number>();
let preferenceRevision = 0;
const attemptLedgers = new WeakMap<PresendTab, { generation: number | null; pending: Map<string, Promise<void>> }>();
const shellObservations = new Map<string, { generation: number | null | undefined; shell: boolean }>();

export function rememberPresendShell(sessionId: string, generation: number | null | undefined, shell: boolean): void {
  shellObservations.set(sessionId, { generation, shell });
}

export function rememberedPresendShell(sessionId: string, generation: number | null | undefined): boolean {
  const saved = shellObservations.get(sessionId);
  return saved?.generation === generation && saved?.shell === true;
}

export function presendAttemptLedger(tab: PresendTab, generation: number | null) {
  const saved = attemptLedgers.get(tab);
  if (saved?.generation === generation) return saved;
  if (saved) tab.attempted.clear();
  const ledger = { generation, pending: new Map<string, Promise<void>>() };
  attemptLedgers.set(tab, ledger);
  return ledger;
}

export function currentPresendAttemptLedger(tab: PresendTab) {
  return attemptLedgers.get(tab);
}

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
export function sharedPresendTabEnabled(sessionId: string, enabled?: boolean): Promise<boolean> {
  return Promise.resolve().then(() => invoke<boolean>("configure_presend_reading", { sessionId, tabEnabled: enabled }));
}
export function forgetPresendTab(sessionId: string): void {
  if (tabs.get(sessionId)?.enabled === false) {
    void sharedPresendTabEnabled(sessionId, true).catch(() => undefined);
  }
  shellObservations.delete(sessionId);
  if (tabs.delete(sessionId)) listeners.forEach(listener => listener());
}
export function presendTabPreferenceRevision(sessionId: string): number {
  const tab = presendTab(sessionId);
  return tab ? preferenceRevisions.get(tab) ?? 0 : 0;
}

export function setPresendTabEnabled(sessionId: string, enabled: boolean): void {
  const tab = ensurePresendTab(sessionId);
  preferenceRevisions.set(tab, ++preferenceRevision);
  tab.enabled = enabled;
  listeners.forEach(listener => listener());
}

export function pausePresendTab(sessionId: string): void {
  const tab = ensurePresendTab(sessionId);
  if (tab.paused === "saving") return;
  tab.paused = "saving";
  setPresendTabEnabled(sessionId, false);
  void sharedPresendTabEnabled(sessionId, false).then(
    enabled => enabled === false,
    () => false,
  ).then(acknowledged => {
    if (presendTab(sessionId) !== tab) return;
    if (acknowledged) delete tab.paused;
    else tab.paused = "failed";
    // An older read in a remounted composer cannot undo this write's result.
    setPresendTabEnabled(sessionId, false);
  });
}
// An empty transfer list carries no acknowledgement of a local pause.
export function adoptPresendPause(sessionId: string, pending: boolean): void {
  if (!pending) return;
  const current = tabs.get(sessionId);
  if (current?.paused === "saving") {
    // The outstanding response belongs to the receiver's earlier pause.
    const adopted: PresendTab = { enabled: false, attempted: current.attempted };
    const ledger = attemptLedgers.get(current);
    if (ledger) attemptLedgers.set(adopted, ledger);
    tabs.set(sessionId, adopted);
  }
  pausePresendTab(sessionId);
}

export function subscribePresendTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

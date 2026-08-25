import { emit } from "@tauri-apps/api/event";

import type { AskScreen } from "./askQuestionScan";

interface PublishedAskEvidence {
  attentionId: string;
  screen: AskScreen;
}

const publishedBySession = new Map<string, PublishedAskEvidence>();
const evidenceQueueBySession = new Map<string, Promise<unknown>>();

function enqueueEvidence<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = evidenceQueueBySession.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  evidenceQueueBySession.set(sessionId, next);
  void next.finally(() => {
    if (evidenceQueueBySession.get(sessionId) === next) evidenceQueueBySession.delete(sessionId);
  });
  return next;
}

function askQuestionIdentity(screen: AskScreen): string {
  return JSON.stringify({
    kind: screen.kind,
    question: screen.question,
    header: screen.header ?? null,
    multiSelect: screen.multiSelect,
    tabs: screen.tabs.map((tab) => ({
      label: tab.label,
      answered: tab.answered,
      active: tab.active,
    })),
    options: screen.options.map((option) => ({
      index: option.index,
      label: option.label,
      description: option.description ?? null,
      role: option.role,
    })),
  });
}

function sameTabbedFlow(previous: AskScreen, next: AskScreen): boolean {
  if (previous.tabs.length === 0 || next.tabs.length === 0) return false;
  const previousLabels = previous.tabs.map((tab) => tab.label);
  const nextLabels = next.tabs.map((tab) => tab.label);
  return previousLabels.length === nextLabels.length
    && previousLabels.every((label, index) => label === nextLabels[index]);
}

function sameScreenContent(previous: AskScreen, next: AskScreen): boolean {
  return askQuestionIdentity(previous) === askQuestionIdentity(next);
}

export function askQuestionAttentionId(sessionId: string, screen: AskScreen): string {
  const previous = publishedBySession.get(sessionId);
  if (
    previous
    && (sameScreenContent(previous.screen, screen) || sameTabbedFlow(previous.screen, screen))
  ) {
    return previous.attentionId;
  }
  return `ask:${sessionId}:${askQuestionIdentity(screen)}`;
}

async function publishEvidence(payload: Record<string, unknown>): Promise<boolean> {
  try {
    await emit("mycmux:session-state-evidence", payload);
    return true;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn("[mycmux-diag] failed to publish AskUserQuestion evidence", error);
    }
    return false;
  }
}

export async function publishAskQuestionEvidence(
  sessionId: string,
  screen: AskScreen,
  observedAt = Date.now(),
  canonicalAttention?: { attentionId: string | null; kind: string },
): Promise<boolean> {
  return enqueueEvidence(sessionId, async () => {
    const attentionId = askQuestionAttentionId(sessionId, screen);
    const previous = publishedBySession.get(sessionId);
    if (
      previous?.attentionId === attentionId
      && (!canonicalAttention
        || (canonicalAttention.attentionId === attentionId && canonicalAttention.kind === "input"))
    ) {
      previous.screen = screen;
      return false;
    }

    const published = await publishEvidence({
      session_id: sessionId,
      attention: "input",
      attention_id: attentionId,
      detail: screen.question,
      observed_at: observedAt,
      confidence: 0.9,
      stale_after: 30_000,
      complete: true,
      resync: false,
    });
    if (published) publishedBySession.set(sessionId, { attentionId, screen });
    return published;
  });
}

export function publishedAskQuestionAttentionId(sessionId: string): string | null {
  return publishedBySession.get(sessionId)?.attentionId ?? null;
}

export function hasPublishedAskQuestionEvidence(
  sessionId: string,
  attentionId: string,
): boolean {
  return publishedAskQuestionAttentionId(sessionId) === attentionId;
}

export function releaseAskQuestionEvidence(sessionId: string): void {
  publishedBySession.delete(sessionId);
}

export async function clearAskQuestionEvidence(
  sessionId: string,
  observedAt = Date.now(),
): Promise<boolean> {
  return enqueueEvidence(sessionId, async () => {
    if (!publishedBySession.has(sessionId)) return false;
    const published = await publishEvidence({
      session_id: sessionId,
      attention: "none",
      attention_id: null,
      detail: null,
      observed_at: observedAt,
      confidence: 0.9,
      stale_after: 30_000,
      complete: true,
      resync: false,
    });
    if (published) publishedBySession.delete(sessionId);
    return published;
  });
}

export function resetAskQuestionEvidenceForTests(): void {
  publishedBySession.clear();
  evidenceQueueBySession.clear();
}

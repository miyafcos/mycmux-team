import { feedbackCategories, feedbackFeatures, feedbackUrgencies } from "./feedbackStrings";

export interface FeedbackDraft {
  category: string; feature: string; problem: string; want: string; urgency: string; sender: string;
}
const LEGACY_DRAFT_KEY = "mycmux.feedback.draft.v1";
const DRAFT_PREFIX = "mycmux.feedback.draft.v2.";
const SENDER_KEY = "mycmux.feedback.sender.v1";

interface FeedbackRecovery {
  key: string;
  failed: boolean;
  storedValue: string;
}

interface SavedFeedbackDraft {
  draft: FeedbackDraft;
  recovery: FeedbackRecovery;
  savedAt: number | null;
}

interface StoredDraft extends Partial<FeedbackDraft> {
  failed?: boolean;
  savedAt?: number;
}

function parseDraft(value: string | null): StoredDraft | null {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? Array.from(value).slice(0, max).join("") : "";
}
function selected(value: unknown, options: readonly { value: string }[]): string {
  return typeof value === "string" && options.some(option => option.value === value) ? value : "";
}
function normalizeDraft(saved: StoredDraft, sender: string): FeedbackDraft {
  return {
    category: selected(saved.category, feedbackCategories), feature: selected(saved.feature, feedbackFeatures),
    problem: text(saved.problem, 4000), want: text(saved.want, 2000), urgency: selected(saved.urgency, feedbackUrgencies),
    sender: text(saved.sender || sender, 120),
  };
}

export function loadFeedbackDraft(): {
  draft: FeedbackDraft;
  recovery: FeedbackRecovery | null;
  failedDrafts: SavedFeedbackDraft[];
} {
  const failedDrafts: SavedFeedbackDraft[] = [];
  let legacyDraft: SavedFeedbackDraft | undefined;
  let sender = "";
  try {
    sender = localStorage.getItem(SENDER_KEY) ?? "";
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(DRAFT_PREFIX)) continue;
      const storedValue = localStorage.getItem(key);
      const saved = parseDraft(storedValue);
      if (storedValue === null || saved?.failed !== true || typeof saved.savedAt !== "number" || !Number.isFinite(saved.savedAt)) continue;
      failedDrafts.push({ draft: normalizeDraft(saved, sender), recovery: { key, failed: true, storedValue }, savedAt: saved.savedAt });
    }

    const legacyValue = localStorage.getItem(LEGACY_DRAFT_KEY);
    const legacy = parseDraft(legacyValue);
    if (legacyValue !== null && legacy) {
      legacyDraft = {
        draft: normalizeDraft(legacy, sender),
        recovery: { key: LEGACY_DRAFT_KEY, failed: legacy.failed === true, storedValue: legacyValue },
        savedAt: typeof legacy.savedAt === "number" && Number.isFinite(legacy.savedAt) ? legacy.savedAt : null,
      };
      if (legacyDraft.recovery.failed) failedDrafts.push(legacyDraft);
    }
  } catch { /* A damaged or unavailable draft must not prevent opening the form. */ }
  failedDrafts.sort((a, b) => (b.savedAt ?? -Infinity) - (a.savedAt ?? -Infinity)
    || b.recovery.key.localeCompare(a.recovery.key));
  const selectedDraft = failedDrafts[0] ?? legacyDraft;
  return {
    draft: selectedDraft?.draft ?? normalizeDraft({}, sender),
    recovery: selectedDraft?.recovery ?? null,
    failedDrafts,
  };
}
export function rememberFeedbackSender(sender: string): void {
  try { if (sender.trim()) localStorage.setItem(SENDER_KEY, sender); }
  catch { /* Remembering the sender is optional when local storage is unavailable. */ }
}
export function saveFeedbackDraft(draft: FeedbackDraft, previous: FeedbackRecovery | null):
  { saved: true; recovery: FeedbackRecovery } | { saved: false } {
  // Each revision has its own key. Another window can clear the snapshot it sent
  // without clearing an edit written while its send was in flight.
  try {
    const key = DRAFT_PREFIX + crypto.randomUUID();
    const storedValue = JSON.stringify({
      category: draft.category, feature: draft.feature, problem: draft.problem,
      want: draft.want, urgency: draft.urgency, sender: draft.sender, failed: true, savedAt: Date.now(),
    });
    localStorage.setItem(key, storedValue);
    clearFeedbackDraft(previous);
    return { saved: true, recovery: { key, failed: true, storedValue } };
  } catch { return { saved: false }; }
}

export function isFeedbackDraftKey(key: string | null): boolean {
  return key === null || key === LEGACY_DRAFT_KEY || key.startsWith(DRAFT_PREFIX);
}

export function feedbackRevisionStatus(recovery: FeedbackRecovery): "present" | "missing" | "unavailable" {
  try { return localStorage.getItem(recovery.key) === recovery.storedValue ? "present" : "missing"; }
  catch { return "unavailable"; }
}

export function clearFeedbackDraft(recovery: FeedbackRecovery | null): void {
  if (!recovery) return;
  try {
    if (feedbackRevisionStatus(recovery) !== "present") return;
    localStorage.removeItem(recovery.key);
  } catch { /* The in-memory form can still close. */ }
}

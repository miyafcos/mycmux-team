import { feedbackCategories, feedbackFeatures, feedbackUrgencies } from "./feedbackStrings";

export interface FeedbackDraft {
  category: string; feature: string; problem: string; want: string; urgency: string; sender: string;
}
const DRAFT_KEY = "mycmux.feedback.draft.v1";
const SENDER_KEY = "mycmux.feedback.sender.v1";
function text(value: unknown, max: number): string {
  return typeof value === "string" ? Array.from(value).slice(0, max).join("") : "";
}
function selected(value: unknown, options: readonly { value: string }[]): string {
  return typeof value === "string" && options.some(option => option.value === value) ? value : "";
}
export function loadFeedbackDraft(): FeedbackDraft {
  let saved: Partial<FeedbackDraft> = {};
  let sender = "";
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) saved = value;
    sender = localStorage.getItem(SENDER_KEY) ?? "";
  } catch { /* A damaged local draft must not prevent opening the form. */ }
  return {
    category: selected(saved.category, feedbackCategories), feature: selected(saved.feature, feedbackFeatures),
    problem: text(saved.problem, 4000), want: text(saved.want, 2000), urgency: selected(saved.urgency, feedbackUrgencies),
    sender: text(saved.sender || sender, 120),
  };
}
export function hasFailedFeedbackDraft(): boolean {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
    return !!saved && typeof saved === "object" && "failed" in saved && saved.failed === true;
  } catch { return false; }
}
export function rememberFeedbackSender(sender: string): void {
  try { if (sender.trim()) localStorage.setItem(SENDER_KEY, sender); }
  catch { /* Remembering the sender is optional when local storage is unavailable. */ }
}
export function saveFeedbackDraft(draft: FeedbackDraft): void {
  // Whitelist text fields; images and destination credentials never enter this storage.
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      category: draft.category, feature: draft.feature, problem: draft.problem,
      want: draft.want, urgency: draft.urgency, sender: draft.sender, failed: true,
    }));
  } catch { /* Keep the open form usable when local storage is unavailable. */ }
}
export function clearFeedbackDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* The in-memory form can still close. */ }
}

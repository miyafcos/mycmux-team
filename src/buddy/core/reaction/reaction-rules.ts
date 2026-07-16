import type { BuddySignal } from "../perception/perception";
import { COMPLETION_KEYWORDS, ERROR_KEYWORDS } from "../perception/signal-classifier";
import type { ReactionKind } from "./reaction-types";

export interface ReactionClassificationContext {
  repeatedErrorCount?: number;
}

const DANGER_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bgit\s+push\s+(-[a-z]*f|--force)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\./i,
  /:>\s*\/dev\/sd/i,
  /\bdrop\s+(table|database)\b/i,
  /\bshutdown\s+/i,
  /\btruncate\s+table\b/i,
];

export function classifyReaction(
  signal: BuddySignal,
  context: ReactionClassificationContext = {},
): ReactionKind | null {
  if (signal.kind === "windowFocusEvent") {
    return "notice";
  }

  if (signal.kind === "idleEvent") {
    return null;
  }

  if (signal.kind === "userTypingEvent") {
    if (signal.is_dangerous || DANGER_PATTERNS.some((pattern) => pattern.test(signal.buffer))) {
      return "alarmed";
    }
    if ((signal.backspace_streak ?? 0) >= 5) {
      return "concerned";
    }
    return signal.buffer.trim().length > 0 ? "notice" : null;
  }

  const text = signal.text.toLowerCase();
  if (hasKeyword(text, ERROR_KEYWORDS)) {
    return (context.repeatedErrorCount ?? 0) >= 3 ? "exasperated" : "concerned";
  }

  if (hasKeyword(text, COMPLETION_KEYWORDS)) {
    return "impressed";
  }

  return "focus";
}

export function isDangerousCommand(text: string): boolean {
  return DANGER_PATTERNS.some((pattern) => pattern.test(text));
}

export function isErrorSignal(signal: BuddySignal): boolean {
  if (signal.kind !== "claudeEvent" && signal.kind !== "codexEvent") {
    return false;
  }
  return hasKeyword(signal.text.toLowerCase(), ERROR_KEYWORDS);
}

export function errorSignature(signal: BuddySignal): string {
  if (signal.kind !== "claudeEvent" && signal.kind !== "codexEvent") {
    return signal.kind;
  }
  return signal.text
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function hasKeyword(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

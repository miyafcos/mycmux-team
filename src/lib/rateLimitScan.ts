export type RateLimitScan =
  | { kind: "none" }
  | { kind: "near-limit"; evidence: string; resetsAt?: number }
  | { kind: "limit-reached"; evidence: string; resetsAt?: number };

const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
const LIMIT_REACHED_PATTERNS: readonly RegExp[] = [
  /\busage limit reached\b/i,
  /\b(?:5[ -]?hour|weekly) limit reached\b/i,
  /\brate limit (?:has been )?reached\b/i,
  /\btoo many requests\b/i,
];
const NEAR_LIMIT_PATTERNS: readonly RegExp[] = [
  /\bapproaching rate limits?\b/i,
  /\bapproaching (?:your )?(?:usage|5[ -]?hour) limit\b/i,
];

function normalizeTail(tail: string): string {
  return tail.replace(ANSI_ESCAPE, "").replace(/\r\n?/g, "\n");
}

function matchingEvidence(text: string, patterns: readonly RegExp[]): string | null {
  return text.split("\n").find((line) => patterns.some((pattern) => pattern.test(line))) ?? null;
}

export function scanRateLimit(tail: string): RateLimitScan {
  const text = normalizeTail(tail);
  const reached = matchingEvidence(text, LIMIT_REACHED_PATTERNS);
  if (reached) return { kind: "limit-reached", evidence: reached.trim() };
  const near = matchingEvidence(text, NEAR_LIMIT_PATTERNS);
  if (near) return { kind: "near-limit", evidence: near.trim() };
  return { kind: "none" };
}

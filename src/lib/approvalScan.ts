// Approval-prompt detection patterns. Pattern index is used as the
// notification key so the same approval fires only once per occurrence.
export const APPROVAL_PATTERNS: readonly RegExp[] = [
  /\ballow\b.*\?.*\(y\/n\)/i, // Claude Code tool approval.
  /do you want to (proceed|continue|make this edit|run)\b/i, // Direct action confirmation.
  /would you like to (proceed|continue)\b/i, // Plan or continuation confirmation.
  /would you like to run the following command\?/i, // Codex command approval.
  /ask user question/i, // AskUserQuestion box title.
  /hook \w+ requires confirmation/i, // Hook confirmation prompt.
  /type your (answer|response)/i, // Open answer prompt.
  /shift\s*\+\s*tab to approve/i, // Plan approval footer.
  new RegExp("^\\s*[\\u276F\\u203A\\u25B6>]\\s*\\d+\\.\\s"), // Cursor-marked choice.
  /^\s*(?:[\u276F\u203A\u25B6>]\s*)?\d+\.\s*(?:yes|no)\b/i, // Explicit yes/no choice.
  /\(y\/n\)\s*[?:]?\s*$/i, // Trailing interactive y/n prompt.
  /\[y\/N\]\s*$/, // Shell-style default-no prompt.
] as const;

// Scan lines for an approval pattern. Returns a 1-based pattern index or 0.
export function scanForApproval(lines: string[]): number {
  for (const line of lines) {
    for (let i = 0; i < APPROVAL_PATTERNS.length; i++) {
      if (APPROVAL_PATTERNS[i].test(line)) return i + 1;
    }
  }
  return 0;
}

export function findApprovalPromptDetail(
  lines: string[],
  matchedPatternId: number,
): string | null {
  if (matchedPatternId <= 0) return null;
  for (const line of lines) {
    if (scanForApproval([line]) !== matchedPatternId) continue;
    const detail = line.replace(/[\r\n]+/g, " ").trim();
    return detail || null;
  }
  return null;
}

export function resolveWaitingTransition(
  prev: { waiting: boolean; absentStreak: number },
  matchedPatternId: number,
): { waiting: boolean; absentStreak: number; clear: boolean } {
  if (matchedPatternId > 0) {
    return { waiting: true, absentStreak: 0, clear: false };
  }

  const absentStreak = prev.absentStreak + 1;
  const clear = prev.waiting && absentStreak >= 2;
  return {
    waiting: prev.waiting && !clear,
    absentStreak,
    clear,
  };
}

import type { SessionAttention } from "../stores/sessionAttentionStore";

export const MERGE_CELEBRATION_COOLDOWN_MS = 12_000;
export const DONE_CELEBRATION_COOLDOWN_MS = 3_500;

// OSC (including hyperlinks), DCS/APC/PM and CSI. Also accept C1 controls.
export function stripCelebrationAnsi(output: string): string {
  return output
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g, "")
    .replace(/\x1b[P_^][\s\S]*?(?:\x1b\\|\x9c)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** Match complete success lines, never an echoed command, prose, or a failure. */
export function mergeSuccessLines(output: string): string[] {
  return stripCelebrationAnsi(output).split(/[\r\n]+/).map(line => line.trim()).filter(line =>
    /^(?:[\u2713\u2714]\s+)?(?:Merged|Squashed and merged|Rebased and merged) pull request(?:\s+(?:[\w.-]+\/[\w.-]+)?#\d+\b.*|\s*\(.*\)\s*|\s*$)/i.test(line)
    || /^Merge made by (?:the )?['"][^'"]+['"] strategy\.?$/i.test(line)
    || /^Fast-forward(?:\s+\(no commit created; -m option ignored\))?$/i.test(line),
  );
}

export interface MergeCelebrationState {
  outputAt: number | null;
  seen: readonly string[];
  lastFiredAt: number | null;
}

export interface MergeCelebrationSample { text: string; outputAt: number | null }

/**
 * An initial screen is a baseline, not a fresh merge. Remember success lines
 * even during cooldown, so the same retained output never fires again later.
 */
export function advanceMergeCelebration(
  previous: MergeCelebrationState | undefined, sample: MergeCelebrationSample, now: number,
): { state: MergeCelebrationState; fire: boolean } {
  const cleanRows = stripCelebrationAnsi(sample.text).split(/[\r\n]+/).map(line => line.trim());
  const lines = [...new Set(mergeSuccessLines(sample.text))];
  const evidence = cleanRows.flatMap((line, index) => {
    if (!lines.includes(line)) return [];
    let range: string | undefined;
    if (/^Fast-forward(?:\s|$)/i.test(line)) {
      const context = cleanRows.slice(Math.max(0, index - 3), index);
      // Rejoin physical wraps before extracting the commit IDs, not row text.
      for (let start = context.length - 1; start >= 0; start -= 1) {
        const update = context.slice(start).join("").match(/^Updating\s+([\da-f]+)\.\.([\da-f]+)$/i);
        if (update) { range = update[1].toLowerCase() + ".." + update[2].toLowerCase(); break; }
      }
    }
    return [{ line, key: range ? line + " @ " + range : line }];
  });
  let seen = [...(previous?.seen ?? [])];
  let unseen = false;
  for (const { line, key } of evidence) {
    if (seen.includes(key)) continue;
    if (key !== line && seen.includes(line)) {
      // The first range after a bare success enriches that success once.
      seen = seen.filter(item => item !== line);
    } else if (key === line && seen.some(item => item.startsWith(line + " @ "))) {
      // A repaint can omit the context of an already identified Fast-forward.
      continue;
    } else unseen = true;
    seen.push(key);
  }
  const freshOutput = previous !== undefined && sample.outputAt !== null
    && (previous.outputAt === null || sample.outputAt > previous.outputAt);
  const fire = freshOutput && unseen
    && (previous.lastFiredAt === null || now - previous.lastFiredAt >= MERGE_CELEBRATION_COOLDOWN_MS);
  return { fire, state: { outputAt: sample.outputAt, seen: seen.slice(-128),
    lastFiredAt: fire ? now : previous?.lastFiredAt ?? null } };
}

/** The same accepted attention feed drives the pane tab's completion badge. */
export function isHanabiDoneTransition(previous: SessionAttention | undefined, next: SessionAttention): boolean {
  return previous !== undefined && previous.sessionEpoch === next.sessionEpoch
    && previous.kind !== "done" && next.kind === "done";
}

import type { LiveTailCrop } from "./crop";

export const PROGRESS_WINDOW_MS = 60_000;
export const STALE_WINDOW_MS = 180_000;
export const FROZEN_WINDOW_MS = 20_000;

export interface LiveTailObservation {
  crop: LiveTailCrop;
  rawRows: string[];
  lastOutputAt: number | null;
  observedAt: number;
}

export type LiveTailFactKind = "progress" | "cmd" | "stale" | "frozen" | "unreadable" | "error" | "idle" | "alive";
export interface LiveTailFact {
  kind: LiveTailFactKind;
  sinceMs: number;
  elapsedSec: number | null;
  tokens: number | null;
  toolElapsedSec: number | null;
  error: string | null;
}

/** Constant-size evidence survives truncation of the recent raw observations. */
export interface LiveTailEvidence {
  observation: LiveTailObservation;
  observations: number;
  workingSinceMs: number;
  rawUnchangedSinceMs: number;
  lastProgressAt: number | null;
  commandSinceMs: number | null;
  commandAdvanced: boolean;
  outputAdvancedWithSameScreen: boolean;
}

/** Animation counters are not work evidence. Returned display rows stay intact. */
export function fingerprintLiveTail(crop: LiveTailCrop): string {
  return JSON.stringify(crop.rows.map((row, i) => {
    let line = row.trim().replace(/^\u25cf\s+/, "");
    if (crop.tool && i === 0) line = line.replace(/\s+\u00b7\s+(?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*$/, "");
    if (/^\u2022\s+Working\s*\(/.test(line)) {
      line = line.replace(/\s+\u00b7\s+\d+\s+background terminals? running.*$/, "");
    }
    return line
      .replace(/^[\u00b7\u2722\u2733\u2736\u273b\u273d*]\s+(?=[^\s\u2026]+\u2026)/, "<spinner> ")
      .replace(/\u2193\s*[\d.]+(?:k|m)?\s*tokens/g, "\u2193 # tokens")
      .replace(/\b(?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/g, "#");
  }));
}

function equalRows(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((row, index) => row === b[index]);
}

function sameCommand(a: LiveTailCrop, b: LiveTailCrop): boolean {
  return Boolean(a.tool && b.tool
    && a.tool.description === b.tool.description
    && a.tool.commandRow === b.tool.commandRow);
}

function increased(a: number | null | undefined, b: number | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && b > a;
}

export function advanceLiveTailEvidence(previous: LiveTailEvidence | undefined, observation: LiveTailObservation): LiveTailEvidence {
  const before = previous?.observation;
  const comparable = Boolean(before?.crop.readable && observation.crop.readable);
  const rawEqual = before !== undefined && equalRows(before.rawRows, observation.rawRows);
  const commandEqual = comparable && sameCommand(before!.crop, observation.crop);
  const progressing = comparable && (
    fingerprintLiveTail(before!.crop) !== fingerprintLiveTail(observation.crop)
    || increased(before!.crop.tokens, observation.crop.tokens)
    || increased(before!.crop.tool?.outputLines, observation.crop.tool?.outputLines)
  );
  const working = observation.crop.state === "working" || observation.crop.state === "unknown";
  const wasWorking = before?.crop.state === "working" || before?.crop.state === "unknown";
  return {
    observation,
    observations: (previous?.observations ?? 0) + 1,
    workingSinceMs: previous && working && (wasWorking || !before?.crop.readable) ? previous.workingSinceMs : observation.observedAt,
    rawUnchangedSinceMs: rawEqual ? previous!.rawUnchangedSinceMs : observation.observedAt,
    lastProgressAt: progressing && working ? observation.observedAt : previous?.lastProgressAt ?? null,
    commandSinceMs: commandEqual ? previous!.commandSinceMs : observation.crop.tool
      ? observation.observedAt - (observation.crop.tool.elapsedSec ?? 0) * 1_000 : null,
    commandAdvanced: commandEqual && increased(before!.crop.tool?.elapsedSec, observation.crop.tool?.elapsedSec),
    outputAdvancedWithSameScreen: rawEqual && (previous!.outputAdvancedWithSameScreen
      || increased(before!.lastOutputAt, observation.lastOutputAt)),
  };
}

export function factForLiveTailEvidence(evidence: LiveTailEvidence, now = evidence.observation.observedAt): LiveTailFact {
  const { observation, rawUnchangedSinceMs, lastProgressAt } = evidence;
  const { crop, lastOutputAt } = observation;
  const fact = (kind: LiveTailFactKind, sinceMs = observation.observedAt): LiveTailFact => ({
    kind, sinceMs, elapsedSec: crop.elapsedSec, tokens: crop.tokens, toolElapsedSec: crop.tool?.elapsedSec ?? null, error: crop.error,
  });
  if (!crop.readable) return fact("unreadable");
  if (crop.state === "error") return fact("error");
  if (crop.state === "done") return fact("idle");
  // One sample is never proof of either progress or a frozen screen.
  if (evidence.observations < 2) return fact("alive", evidence.workingSinceMs);
  if (now - rawUnchangedSinceMs >= FROZEN_WINDOW_MS) {
    if (lastOutputAt !== null && now - lastOutputAt >= FROZEN_WINDOW_MS) {
      return fact("frozen", Math.max(rawUnchangedSinceMs, lastOutputAt));
    }
    return fact("unreadable", rawUnchangedSinceMs);
  }
  if (evidence.outputAdvancedWithSameScreen) return fact("unreadable", rawUnchangedSinceMs);
  if (lastProgressAt !== null && now - lastProgressAt < PROGRESS_WINDOW_MS) return fact("progress", lastProgressAt);
  if (crop.tool && evidence.commandAdvanced) return fact("cmd", evidence.commandSinceMs ?? observation.observedAt);
  const noProgressSince = lastProgressAt ?? evidence.workingSinceMs;
  if (!crop.tool && now - noProgressSince >= STALE_WINDOW_MS
    && lastOutputAt !== null && now - lastOutputAt < FROZEN_WINDOW_MS) return fact("stale", noProgressSince);
  return fact("alive", noProgressSince);
}

export function deriveLiveTailFact(history: readonly LiveTailObservation[], now = history[history.length - 1]?.observedAt ?? 0): LiveTailFact {
  let evidence: LiveTailEvidence | undefined;
  for (const observation of history) evidence = advanceLiveTailEvidence(evidence, observation);
  return evidence ? factForLiveTailEvidence(evidence, now) : {
    kind: "unreadable", sinceMs: now, elapsedSec: null, tokens: null, toolElapsedSec: null, error: null,
  };
}

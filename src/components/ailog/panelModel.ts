import type { FindingKind } from "../../lib/ailog";

export type AilogSurface = "record" | "insight";
export type RecordSegment = "when" | "what" | "how";
export type InsightSegment = "daily" | "recurring" | "decisions";
export type PanelSegment = RecordSegment | InsightSegment;

export const recurringFindingKinds: FindingKind[] = ["gotcha", "cause"];
export const decisionFindingKinds: FindingKind[] = ["decision", "constraint", "verified"];

export function findingKindsForSegment(segment: InsightSegment): FindingKind[] {
  if (segment === "recurring") return recurringFindingKinds;
  if (segment === "decisions") return decisionFindingKinds;
  return [];
}

export function loadersForSegment(surface: AilogSurface, segment: PanelSegment): string[] {
  if (surface === "record") {
    if (segment === "when") return ["usage"];
    if (segment === "what") return ["breakdown", "prices"];
    return ["experiment"];
  }
  if (segment === "daily") return ["digest"];
  if (segment === "recurring") return ["findings", "rankings"];
  return ["findings"];
}

export function shouldRefreshBreakdown(surface: AilogSurface, segment: RecordSegment): boolean {
  return surface === "record" && segment === "what";
}

export function dailyDigestNavigation(date: string) {
  return { surface: "insight" as const, segment: "daily" as const, date };
}

export function recordBreakdownNavigation(date: string) {
  return { surface: "record" as const, segment: "what" as const, from: date, to: date };
}

/** LLM work is never part of navigation or segment loading. */
export function isExplicitLlmIntent(intent: string): boolean {
  return intent === "regenerateDigest" || intent === "startSummarize" || intent === "summarizeSession";
}

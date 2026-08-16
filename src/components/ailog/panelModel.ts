import type { FindingKind } from "../../lib/ailog";

export type PanelSegment = "change" | "how" | "learning" | "record" | "daily";

export const recurringFindingKinds: FindingKind[] = ["gotcha", "cause"];
export const decisionFindingKinds: FindingKind[] = ["decision", "constraint", "verified"];

export function findingKindsForSegment(segment: PanelSegment): FindingKind[] {
  if (segment === "learning") return [...recurringFindingKinds, ...decisionFindingKinds];
  return [];
}

export function loadersForSegment(segment: PanelSegment): string[] {
  if (segment === "change") return [];
  if (segment === "record") return ["usage", "breakdown"];
  if (segment === "how") return ["experiment"];
  if (segment === "daily") return ["digest"];
  return ["findings", "rankings", "ruleCheck"];
}

export function dailyDigestNavigation(date: string) {
  return { segment: "daily" as const, date };
}

export function recordNavigation(date: string) {
  return { segment: "record" as const, from: date, to: date };
}

/** LLM work is never part of navigation or segment loading. */
export function isExplicitLlmIntent(intent: string): boolean {
  return intent === "regenerateDigest" || intent === "startSummarize" || intent === "summarizeSession";
}

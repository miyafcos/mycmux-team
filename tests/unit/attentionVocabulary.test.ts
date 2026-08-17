import { describe, expect, it } from "vitest";

import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";

const forbidden = ["WorkOrder", "AttentionGate", "AttentionCard", "fingerprint", "upsert", "Outbox", "Integrator", "predicate", "DAG", "candidate", "emit", "SessionRef"];

type DashboardStringKey = keyof typeof dashboardStrings;

// Any function that cannot be invoked by this test must be named here with a
// reason. Keep this list empty while every dashboard string function is covered.
const functionExclusions: Readonly<Record<string, string>> = {};

const functionSamples: Partial<Record<DashboardStringKey, readonly unknown[][]>> = {
  collapsedDone: [[1]],
  collapsedIdle: [[1]],
  clearDoneButton: [[1]],
  countUnit: [[1]],
  paneLocation: [[1, 2]],
  breadcrumb: [["workspace", 1, 2]],
  elapsed: [[0], [60]],
  stallSince: [[1]],
  watchLastTick: [["now"]],
  watchNextTick: [["later"]],
  watchDueIn: [[1]],
  watchAgo: [[1]],
  totalSummary: [[1, 1]],
  filteredSummary: [[1, 2]],
  interventionRejected: [["reason"]],
  interventionReason: [["target_missing"], ["transport"], ["other"]],
  lastCheckedAgo: [[1]],
  noUpdateFor: [[1]],
  removeMention: [["agent"]],
  dispatchPreview: [[1]],
  dispatchResults: [[1]],
  dispatchRetryFailed: [[1]],
  dispatchMode: [["plain"], ["status-request"], ["answer-forward"], ["continue"]],
  reportReceiveModeForSession: [["immediate"], ["batch"], ["quiet"]],
  reportReceiveModeDescription: [["immediate"], ["batch"], ["quiet"]],
  reportSummaryUnlinked: [[1]],
  reportQuietRecorded: [[1]],
  attentionActionLabel: [["openSession"], ["answerQuestion"], ["retryWorkItem"], ["reviewConflict"], ["raiseBudget"], ["acknowledgeGoalReached"]],
  attentionKindLabel: [["agentAsked"], ["workStopped"], ["reportsComplete"], ["completionWithoutTests"], ["budgetReached"], ["outOfScopeWrite"], ["conflictDetected"], ["goalReached"], ["nextItemReady"], ["workOrderStalled"]],
  contractRoleMenuFor: [["agent"]],
  contractExecutionDetail: [["agent"]],
  contractReference: [["source", "event"]],
  contractCoverageSummary: [[1, 1, 0, 0], [1, 1, 0, 1]],
  contractRunSourcesAcquired: [[1]],
  aiSuggestionFailureReason: [
    ["ai_disabled"], ["cli_not_found"], ["cli_failed"], ["invalid_output"],
    ["timeout"], ["provider_model_mismatch"], ["internal"], ["duplicate_request"],
  ],
};

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringLeaves);
  return [];
}

function renderedFunctionStrings(): string[] {
  const rendered: string[] = [];
  for (const [rawKey, value] of Object.entries(dashboardStrings)) {
    if (typeof value !== "function") continue;
    const key = rawKey as DashboardStringKey;
    const exclusion = functionExclusions[key];
    if (exclusion) continue;
    const samples = functionSamples[key];
    if (!samples) {
      throw new Error(`dashboardStrings.${key} has no representative invocation`);
    }
    for (const args of samples) {
      const output = (value as (...args: unknown[]) => unknown)(...args);
      expect(typeof output, `dashboardStrings.${key}(${JSON.stringify(args)})`).toBe("string");
      rendered.push(output as string);
    }
  }
  for (const key of Object.keys(functionSamples) as DashboardStringKey[]) {
    expect(typeof dashboardStrings[key], `stale sample for dashboardStrings.${key}`).toBe("function");
  }
  for (const key of Object.keys(functionExclusions)) {
    expect(typeof dashboardStrings[key as DashboardStringKey], `stale exclusion for dashboardStrings.${key}`).toBe("function");
  }
  return rendered;
}

describe("attention vocabulary", () => {
  it("keeps forbidden implementation terms out of dashboard string values", () => {
    const strings = [...stringLeaves(dashboardStrings), ...renderedFunctionStrings()];
    for (const term of forbidden) {
      expect(strings.some((value) => value.includes(term)), term).toBe(false);
    }
  });
});

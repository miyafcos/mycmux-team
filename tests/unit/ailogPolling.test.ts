import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ailogPollPlan } from "../../src/hooks/useAilogPolling";

describe("AI log polling plan", () => {
  it("stops closed or idle panels and selects the event-health cadence while jobs run", () => {
    expect(ailogPollPlan({ open: false, indexRunning: true, summarizeRunning: true, eventsHealthy: true })).toEqual({ pollIndex: false, pollSummarize: false, nextDelayMs: null });
    expect(ailogPollPlan({ open: true, indexRunning: false, summarizeRunning: false, eventsHealthy: true })).toEqual({ pollIndex: false, pollSummarize: false, nextDelayMs: null });
    expect(ailogPollPlan({ open: true, indexRunning: true, summarizeRunning: false, eventsHealthy: true })).toEqual({ pollIndex: true, pollSummarize: false, nextDelayMs: 4_000 });
    expect(ailogPollPlan({ open: true, indexRunning: false, summarizeRunning: true, eventsHealthy: false })).toEqual({ pollIndex: false, pollSummarize: true, nextDelayMs: 1_500 });
  });

  it("keeps timing in the hook and removes the panel intervals", () => {
    const hook = readFileSync(join(process.cwd(), "src/hooks/useAilogPolling.ts"), "utf8");
    const panel = readFileSync(join(process.cwd(), "src/components/ailog/AiLogPanel.tsx"), "utf8");
    expect(hook).toContain("indexInFlight.current");
    expect(hook).toContain("summarizeInFlight.current");
    expect(hook).toContain("window.setTimeout");
    expect(hook).toContain("window.clearTimeout");
    expect(hook).toContain("refreshReports");
    expect(panel).not.toContain("setInterval");
    expect(panel).toContain("useAilogPolling");
  });
});

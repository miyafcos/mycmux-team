import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGroupingOutput, validateEditedPlan } from "../../src/components/layout/tabGrouping";

// Opt-in replay of local experiment artifacts; no personal pane text belongs in git.
const evidence = process.env.JEV_GROUPING_EVIDENCE;
const inputs = [
  ["app-validated-real", "frozen-input.json"],
  ["app-validated-19", "heldout-19-input.json"],
  ["focused-recheck-real", "frozen-input.json"],
  ["focused-recheck-19", "heldout-19-input.json"],
] as const;

describe.skipIf(!evidence)("Jev experiment output through the production grouping validator", () => {
  for (const [folder, input] of inputs) {
    for (let run = 1; run <= 3; run += 1) {
      it(`${folder} run ${run}: validates all three plans and every pane`, () => {
        const state = JSON.parse(readFileSync(join(evidence!, input), "utf8"));
        const raw = readFileSync(join(evidence!, folder, `plans-${run}.json`), "utf8");
        const ids: string[] = state.tabs.map((tab: { id: string }) => tab.id);
        const workspaceIds: string[] = state.workspaces.map((workspace: { id: string }) => workspace.id);
        const names: string[] = state.workspaces.map((workspace: { name: string }) => workspace.name);
        const result = parseGroupingOutput(raw, ids, workspaceIds, names);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.plans.map((plan) => plan.strategy)).toEqual(["project", "role", "minimal_move"]);
        expect(result.droppedPlans).toEqual([]);
        for (const plan of result.plans) {
          expect(validateEditedPlan(plan, ids, workspaceIds, new Set(names))).toEqual([]);
          expect(plan.groups.flatMap((group) => group.tabIds).sort()).toEqual([...ids].sort());
        }
      });
    }
  }
});

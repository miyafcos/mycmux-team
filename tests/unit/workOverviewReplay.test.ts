import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOverviewSnapshot, buildOverviewSuggestions, type OverviewInput } from "../../src/lib/workOverview";
import type { ProjectRegistration } from "../../src/lib/paneIdentity";
const dir = process.env.MYCMUX_OV_REPLAY_DIR;
describe.skipIf(!dir)("work overview live snapshots kept outside the repository", () => {
  it("records every proposal and verifies full population without registry-home moves", () => {
    const results = ["rs", "ov"].map(tag => {
      const input = JSON.parse(readFileSync(join(dir!, "evaluation_input_" + tag + ".json"), "utf8")) as OverviewInput & { registry: ProjectRegistration[] };
      const snapshot = buildOverviewSnapshot(input);
      expect(snapshot.cards.length).toBe(input.workspaces.reduce((n, ws) => n + ws.panes.reduce((m, pane) => m + pane.tabs.length, 0), 0));
      const proposals = buildOverviewSuggestions(snapshot.cards, input.registry);
      expect(proposals.length).toBeLessThanOrEqual(5);
      for (const proposal of proposals) {
        if (proposal.kind === "gather") {
          expect(proposal.evidence.length).toBeGreaterThanOrEqual(2);
          expect(proposal.evidence.every(reason => !/「\d+」/.test(reason))).toBe(true);
        }
      }
      return { tag, population: snapshot.cards.length, counts: snapshot.counts, proposals };
    });
    writeFileSync(join(dir!, "evaluation_results.json"), JSON.stringify(results, null, 2) + "\n", "utf8");
  });
});

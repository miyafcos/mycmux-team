import { describe, expect, it } from "vitest";

import { logicalSessionId } from "../../src/lib/logicalSessionId";
import type { MentionCandidate, MentionToken } from "../../src/lib/mentionModel";
import {
  buildContractDraft,
  compileWorkOrderPlan,
  DEFAULT_DONE_CONDITIONS,
  integratorProblem,
  shouldOfferContract,
  type ContractDraft,
} from "../../src/components/dashboard/workOrderModel";

function candidate(id: string): MentionCandidate {
  return {
    kind: "session",
    logicalSessionId: logicalSessionId(`tab-${id}`),
    sessionId: `pty-${id}`,
    label: id,
    workspaceName: "ws",
    statusLabel: "idle",
    isWorking: false,
  };
}

function token(id: string): MentionToken {
  const entry = candidate(id);
  return { kind: "session", logicalSessionId: entry.logicalSessionId, sessionId: entry.sessionId, labelSnapshot: id };
}

function roles(text: string, ids: string[]): string[] {
  const candidates = ids.map(candidate);
  return buildContractDraft(text, ids.map(token), candidates).participants.map((participant) => participant.role);
}

describe("workOrderModel", () => {
  it("derives the five documented role patterns", () => {
    expect(roles("\u540c\u3058\u30c6\u30b9\u30c8\u3092\u5b9f\u884c\u3057\u3066", ["A", "B"])).toEqual(["work", "work"]);
    const comparison = buildContractDraft("\u7d50\u8ad6\u3092\u6bd4\u8f03\u3057\u3066\u65b9\u91dd\u3092\u51fa\u3057\u3066", [token("A"), token("B")], [candidate("A"), candidate("B")]);
    expect(comparison.participants.map((participant) => participant.role)).toEqual(["material", "material"]);
    expect(comparison.needsNewIntegrator).toBe(true);
    expect(roles("A\u306e\u6210\u679c\u3092B\u304c\u7d71\u5408\u3057\u3066", ["A", "B"])).toEqual(["material", "integrator"]);
    const integrationText = "\u3053\u308c\u3089\u3092\u7d71\u5408\u3057\u3066\u30b4\u30fc\u30ebD\u307e\u3067\u5b9f\u88c5\u3057\u3066";
    const integration = buildContractDraft(integrationText, [token("A"), token("B"), token("C")], [candidate("A"), candidate("B"), candidate("C")]);
    expect(integration.participants.map((participant) => participant.role)).toEqual(["material", "material", "material"]);
    expect(integration.needsNewIntegrator).toBe(true);
    expect(integration.purpose).toBe(integrationText);
    const noMention = buildContractDraft("\u3053\u306e\u4ef6\u3084\u3063\u3068\u3044\u3066", [], []);
    expect(noMention.participants).toEqual([]);
    expect(noMention.needsNewIntegrator).toBe(true);
  });

  it("does not offer a contract for a normal single destination instruction", () => {
    expect(shouldOfferContract("\u901a\u5e38\u306e\u6307\u793a", 1)).toBe(false);
    expect(shouldOfferContract("\u307e\u3068\u3081\u3066", 1)).toBe(false);
    expect(shouldOfferContract("\u3053\u308c\u3089\u3092\u7d71\u5408\u3057\u3066", 1)).toBe(false);
    expect(shouldOfferContract("\u3053\u308c\u3089\u3092\u7d71\u5408\u3057\u3066", 2)).toBe(true);
  });

  it("compiles the same Japanese completion criteria shown to the operator", () => {
    const candidates = [candidate("A"), candidate("B")];
    const draft = buildContractDraft("\u3053\u308c\u3089\u3092\u7d71\u5408\u3057\u3066", [token("A"), token("B")], candidates);
    const plan = compileWorkOrderPlan(draft, candidates);
    expect(draft.doneCondition).toEqual(DEFAULT_DONE_CONDITIONS);
    expect(plan.acceptanceCriteria.map((criterion) => criterion.description)).toEqual(DEFAULT_DONE_CONDITIONS);
    expect(JSON.stringify(plan)).not.toMatch(/checks|report|conflicts/);
  });

  it("reports missing and multiple integrators", () => {
    const base: ContractDraft = { purpose: "x", participants: [{ logicalSessionId: "a", label: "A", role: "material" }], needsNewIntegrator: false, doneCondition: ["x"] };
    expect(integratorProblem(base)).toBe("missing");
    expect(integratorProblem({ ...base, participants: [
      { logicalSessionId: "a", label: "A", role: "integrator" },
      { logicalSessionId: "b", label: "B", role: "integrator" },
    ] })).toBe("multiple");
  });
});

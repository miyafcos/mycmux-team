import { describe, expect, it } from "vitest";

import {
  WORKING_ALL_LABEL,
  buildMentionCandidates,
  describeMentionToken,
  filterMentionCandidates,
  mentionTokenFromCandidate,
  resolveMentionRecipients,
  resolveSealedMentionRecipients,
} from "../../src/lib/mentionModel";

const inputs = [
  { logicalSessionId: "tab-a", sessionId: "runtime-a", label: "設計", workspaceName: "開発", statusLabel: "作業中", isWorking: true },
  { logicalSessionId: "tab-b", sessionId: "runtime-b", label: "校正", workspaceName: "教材", statusLabel: "待機", isWorking: false },
];

describe("mentionModel", () => {
  it("orders @動いてる全員 first and filters only menu candidates", () => {
    const candidates = buildMentionCandidates(inputs);
    expect(candidates.map((candidate) => candidate.label)).toEqual([WORKING_ALL_LABEL, "設計", "校正"]);
    expect(filterMentionCandidates(candidates, "教材").map((candidate) => candidate.label)).toEqual(["校正"]);
  });

  it("resolves token identity against both stable tab and runtime session ids", () => {
    const candidates = buildMentionCandidates(inputs);
    const target = candidates[1];
    expect(target.kind).toBe("session");
    if (target.kind !== "session") throw new Error("test target missing");
    const token = mentionTokenFromCandidate(target);
    const renamed = buildMentionCandidates([{ ...inputs[0], label: "設計（名称変更）" }, inputs[1]]);
    expect(describeMentionToken(token, renamed)).toMatchObject({ label: "設計（名称変更）", valid: true });
    expect(resolveMentionRecipients([token], buildMentionCandidates([{ ...inputs[0], sessionId: "runtime-replaced" }, inputs[1]])).missing).toHaveLength(1);
    expect(resolveMentionRecipients([token], buildMentionCandidates([inputs[1]])).missing).toHaveLength(1);
  });

  it("expands @動いてる全員 only to working sessions and seals retries", () => {
    const candidates = buildMentionCandidates(inputs);
    const all = mentionTokenFromCandidate(candidates[0]);
    const initial = resolveMentionRecipients([all], candidates);
    expect(initial.missing).toEqual([]);
    expect(initial.recipients.map((recipient) => recipient.logicalSessionId)).toEqual(["tab-a"]);

    // A retry uses the sealed membership; a later newly-working tab cannot join.
    const later = buildMentionCandidates([
      { ...inputs[0], isWorking: false },
      { ...inputs[1], isWorking: true },
    ]);
    const retry = resolveSealedMentionRecipients(initial.recipients, later);
    expect(retry.recipients.map((recipient) => recipient.logicalSessionId)).toEqual(["tab-a"]);
    expect(retry.recipients.map((recipient) => recipient.logicalSessionId)).not.toContain("tab-b");
  });
});

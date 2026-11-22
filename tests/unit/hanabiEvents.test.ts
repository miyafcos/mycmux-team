import { describe, expect, it } from "vitest";
import { advanceMergeCelebration, isHanabiDoneTransition, mergeSuccessLines, MERGE_CELEBRATION_COOLDOWN_MS, stripCelebrationAnsi } from "../../src/lib/hanabiEvents";
import type { SessionAttention } from "../../src/stores/sessionAttentionStore";

describe("merge success recognition", () => {
  it.each(["✓ Merged pull request", "Merged pull request #123", "✓ Merged pull request owner/repo#123 (Title)",
    "✓ Squashed and merged pull request owner/repo#9 (Title)",
    "Merge made by the 'ort' strategy.", "Merge made by 'recursive' strategy.", "Fast-forward",
    "Fast-forward (no commit created; -m option ignored)"])("accepts %s", text => {
    expect(mergeSuccessLines(text)).toHaveLength(1);
  });
  it.each(["gh pr merge 123", "$ gh pr merge --squash", "error: Failed to merge pull request #1",
    "The output might say Merged pull request #1", "echo 'Merged pull request #1'",
    "Fast-forward merge is not possible", "Not Fast-forward", "Merge conflict", "Already up to date.",
    "✓ Merged pull request failed", "Summary: Merge made by the 'ort' strategy.", "Fast-forwarding instructions"])("rejects %s", text => {
    expect(mergeSuccessLines(text)).toEqual([]);
  });
  it("strips CSI, OSC hyperlinks, DCS, and C1 controls before comparing", () => {
    const text = "\x1b[32m✓\x1b[0m Merged pull request \x1b]8;;https://example.invalid\x1b\\#42\x1b]8;;\x07";
    expect(mergeSuccessLines(text)).toEqual(["✓ Merged pull request #42"]);
    expect(mergeSuccessLines("\x9b32mFast-forward\x9b0m")).toEqual(["Fast-forward"]);
    expect(stripCelebrationAnsi("\x1bPignored\x1b\\Fast-forward")).toBe("Fast-forward");
  });
  it("does not fire for an initial historic screen or later duplicates", () => {
    let result = advanceMergeCelebration(undefined, { text: "Fast-forward", outputAt: 100 }, 100);
    expect(result.fire).toBe(false);
    result = advanceMergeCelebration(result.state, { text: "Fast-forward", outputAt: 200 }, 20000);
    expect(result.fire).toBe(false);
    result = advanceMergeCelebration(result.state, { text: "Fast-forward\nnew output", outputAt: 300 }, 40000);
    expect(result.fire).toBe(false);
  });
  it("fires for new output, applies cooldown, and consumes suppressed duplicates", () => {
    let result = advanceMergeCelebration(undefined, { text: "working", outputAt: 100 }, 100);
    result = advanceMergeCelebration(result.state, { text: "Merged pull request #1", outputAt: 200 }, 200);
    expect(result.fire).toBe(true);
    result = advanceMergeCelebration(result.state, { text: "Merged pull request #2", outputAt: 300 }, 300);
    expect(result.fire).toBe(false);
    result = advanceMergeCelebration(result.state, { text: "Merged pull request #2", outputAt: 400 }, 20000);
    expect(result.fire).toBe(false);
    result = advanceMergeCelebration(result.state, { text: "Merged pull request #3", outputAt: 500 }, 20000);
    expect(result.fire).toBe(true);
    expect(MERGE_CELEBRATION_COOLDOWN_MS).toBeGreaterThan(0);
  });
  it("distinguishes later Fast-forward merges by Git commit evidence", () => {
    let result = advanceMergeCelebration(undefined, { text: "working", outputAt: 100 }, 100);
    result = advanceMergeCelebration(result.state, { text: "Updating abc123..def456\nFast-forward", outputAt: 200 }, 200);
    expect(result.fire).toBe(true);
    result = advanceMergeCelebration(result.state, { text: "Fast-forward\nother output", outputAt: 300 }, 20000);
    expect(result.fire).toBe(false);
    result = advanceMergeCelebration(result.state, { text: "Updating def456..aaa777\nFast-forward", outputAt: 400 }, 30000);
    expect(result.fire).toBe(true);
  });
  it.each([
    "Updating abc1234..def\n5678\nFast-forward",
    "Updating abc1\n234..def5678\nFast-forward",
    "Updating ABC1234..DEF5678\nFast-forward",
  ])("deduplicates normalized commit ranges in %s", repaint => {
    let result = advanceMergeCelebration(undefined, { text: "working", outputAt: 100 }, 100);
    result = advanceMergeCelebration(result.state, { text: "Updating abc1234..def5678\nFast-forward", outputAt: 200 }, 200);
    expect(result.fire).toBe(true);
    result = advanceMergeCelebration(result.state, { text: repaint, outputAt: 300 }, 20000);
    expect(result.fire).toBe(false);
    expect(result.state.seen).toEqual(["Fast-forward @ abc1234..def5678"]);
  });
  it("enriches a bare Fast-forward once, then accepts a different commit range", () => {
    let result = advanceMergeCelebration(undefined, { text: "working", outputAt: 100 }, 100);
    result = advanceMergeCelebration(result.state, { text: "Fast-forward", outputAt: 200 }, 200);
    expect(result.fire).toBe(true);
    result = advanceMergeCelebration(result.state, { text: "Updating abc123..def456\nFast-forward", outputAt: 300 }, 20000);
    expect(result.fire).toBe(false);
    result = advanceMergeCelebration(result.state, { text: "Fast-forward", outputAt: 400 }, 30000);
    expect(result.fire).toBe(false);
    result = advanceMergeCelebration(result.state, { text: "Updating def456..aaa777\nFast-forward", outputAt: 500 }, 40000);
    expect(result.fire).toBe(true);
  });
  it("bounds retained success evidence to 128 items", () => {
    const text = Array.from({ length: 200 }, (_, index) => "Merged pull request #" + index).join("\n");
    const result = advanceMergeCelebration(undefined, { text, outputAt: 100 }, 100);
    expect(result.state.seen).toHaveLength(128);
    expect(result.state.seen.at(-1)).toBe("Merged pull request #199");
  });
  it("requires advancing output evidence, and keeps each tab independent", () => {
    const baseline = advanceMergeCelebration(undefined, { text: "", outputAt: 100 }, 100).state;
    expect(advanceMergeCelebration(baseline, { text: "Fast-forward", outputAt: 100 }, 200).fire).toBe(false);
    expect(advanceMergeCelebration(baseline, { text: "Fast-forward", outputAt: null }, 200).fire).toBe(false);
    expect(advanceMergeCelebration(baseline, { text: "Fast-forward", outputAt: 101 }, 200).fire).toBe(true);
    expect(advanceMergeCelebration({ ...baseline }, { text: "Fast-forward", outputAt: 101 }, 200).fire).toBe(true);
  });
});

const attention = (kind: SessionAttention["kind"], epoch = 1): SessionAttention => ({
  sessionId: "s", sessionEpoch: epoch, kind, attentionId: kind, detail: null, sessionRevision: 1,
  uiState: kind === "done" ? "done" : "working", stateSince: 1, occurrenceOrder: 1,
});
describe("accepted completion transitions", () => {
  it("fires on a fresh done transition only, not hydration, duplicates, or old producer state", () => {
    expect(isHanabiDoneTransition(attention("none"), attention("done"))).toBe(true);
    expect(isHanabiDoneTransition(undefined, attention("done"))).toBe(false);
    expect(isHanabiDoneTransition(attention("done"), attention("done"))).toBe(false);
    expect(isHanabiDoneTransition(attention("none", 1), attention("done", 2))).toBe(false);
    expect(isHanabiDoneTransition(attention("done"), attention("none"))).toBe(false);
  });
});

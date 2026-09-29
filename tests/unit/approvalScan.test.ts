import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findApprovalPromptDetail,
  resolveWaitingTransition,
  scanForApproval,
} from "../../src/lib/approvalScan";

describe("scanForApproval", () => {
  it.each([
    "? for shortcuts",
    "1. tabbar redesign (560/600px)",
    "left \u2192 right migration done",
    "Esc to cancel \u00b7 Enter to send",
    "ctrl-g to edit in external editor",
    "press enter to continue reading the log",
    "> 1. まず設定ファイルを開く",
    "see docs/ask user question flow for details",
    "if you type your answer in the form it is saved automatically",
  ])("does not match an idle or finished line: %s", (line) => {
    expect(scanForApproval([line])).toBe(0);
  });

  it.each([
    ["Do you want to proceed?", 2],
    ["\u276F 1. Yes", 9],
    ["  2. No, and tell Claude what to do differently", 9],
    ["Would you like to run the following command?", 4],
    ["Allow Bash to run git push? (y/n)", 1],
    ["Ask User Question", 5],
    ["  \u2502 Ask user question  \u2502", 5],
    ["Overwrite existing file? [y/N]", 11],
    ["Would you like to continue?", 3],
    ["Hook Bash requires confirmation", 6],
    ["Type your response", 7],
    ["Shift + Tab to approve", 8],
    ["Continue? (y/n):", 10],
  ] as const)("matches a real approval line: %s", (line, patternId) => {
    expect(scanForApproval([line])).toBe(patternId);
  });
});

describe("resolveWaitingTransition", () => {
  it("clears exactly on the second consecutive pattern-free scan", () => {
    let state = resolveWaitingTransition(
      { waiting: false, absentStreak: 0 },
      1,
    );
    expect(state).toEqual({ waiting: true, absentStreak: 0, clear: false });

    state = resolveWaitingTransition(state, 0);
    expect(state).toEqual({ waiting: true, absentStreak: 1, clear: false });

    state = resolveWaitingTransition(state, 0);
    expect(state).toEqual({ waiting: false, absentStreak: 2, clear: true });
  });

  it("resets the absent streak when a pattern returns", () => {
    let state = resolveWaitingTransition(
      { waiting: false, absentStreak: 0 },
      1,
    );
    state = resolveWaitingTransition(state, 0);
    expect(state.clear).toBe(false);

    state = resolveWaitingTransition(state, 2);
    expect(state).toEqual({ waiting: true, absentStreak: 0, clear: false });
  });
});

describe("findApprovalPromptDetail", () => {
  it("returns the first matched prompt as one line", () => {
    const lines = ["noise", "Allow this command? (y/n)\r\n", "more noise"];
    const patternId = scanForApproval(lines);

    expect(findApprovalPromptDetail(lines, patternId)).toBe("Allow this command? (y/n)");
  });

  it("returns null when there is no matched pattern", () => {
    expect(findApprovalPromptDetail(["plain output"], 0)).toBeNull();
  });
});

describe("approvalScan source", () => {
  it("contains only ASCII source characters", () => {
    const source = readFileSync(
      new URL("../../src/lib/approvalScan.ts", import.meta.url),
      "utf8",
    );
    const nonAscii = Array.from(source).filter((char) => char.charCodeAt(0) >= 128);

    expect(nonAscii).toEqual([]);
  });

  it("publishes only waiting entry and clear transitions to the Rust reducer", () => {
    const source = readFileSync(
      new URL("../../src/components/terminal/XTermWrapper.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('emit("mycmux:session-state-evidence"');
    expect(source).toContain('if (prevStatus !== "waiting" && !askScreen)');
    expect(source).toContain('publishScreenScanEvidence("none", null, null, resync)');
    expect(source).toMatch(/publishAskQuestionEvidence\(\s*sessionId,\s*askScreen,\s*observedAt,/);
    expect(source).toContain("clearAskQuestionEvidence(sessionId, observedAt)");
  });
});

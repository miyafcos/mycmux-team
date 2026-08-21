import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error @xterm/headless@6.0.0 publishes this ESM file without colocated declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import type { Terminal } from "@xterm/xterm";

import { liveTerms, termCache, terminalTurnMarks } from "../../src/components/terminal/terminalCache";
import {
  clearTurnMarks,
  getTurnMarkData,
  noteRestoreBoundaryTurn,
  noteTurnSubmit,
  RESTORE_BOUNDARY_LABEL,
} from "../../src/components/terminal/terminalTurnMarkers";
import {
  __resetTurnMarkRestoreForTests,
  restoreTurnMarksFromTranscript,
  type TurnMarkRestoreDeps,
} from "../../src/components/terminal/turnMarkRestore";
import {
  collectLogicalLines,
  matchPromptsToBuffer,
  normalizeMatchText,
  promptMatchesLine,
} from "../../src/components/terminal/turnMarkRestoreModel";

type HeadlessTerminalConstructor = typeof import("@xterm/headless").Terminal;
type HeadlessTerminal = InstanceType<HeadlessTerminalConstructor>;

const Terminal = PublishedTerminal as HeadlessTerminalConstructor;

function write(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, resolve);
  });
}

function attach(sessionId: string, options?: { cols?: number; rows?: number; scrollback?: number }) {
  const term = new Terminal({
    cols: options?.cols ?? 40,
    rows: options?.rows ?? 8,
    scrollback: options?.scrollback ?? 200,
    allowProposedApi: true,
  });
  liveTerms.set(sessionId, term as unknown as Terminal);
  return term;
}

/** No real timers, no IPC: only the transcript content varies per test. */
function deps(
  prompts: readonly { text: string; occurredAt: number }[],
  overrides: Partial<TurnMarkRestoreDeps> = {},
): Partial<TurnMarkRestoreDeps> {
  return {
    fetchPrompts: async () => prompts.map((prompt) => ({ ...prompt })),
    wait: async () => {},
    report: () => {},
    ...overrides,
  };
}

/** A redraw as Claude paints it back: "> " in front of every past prompt. */
async function redraw(term: HeadlessTerminal, lines: readonly string[]): Promise<void> {
  for (const line of lines) {
    await write(term, `${line}\r\n`);
  }
}

afterEach(() => {
  for (const sessionId of [...terminalTurnMarks.keys()]) {
    clearTurnMarks(sessionId);
  }
  for (const term of liveTerms.values()) {
    term.dispose();
  }
  liveTerms.clear();
  termCache.clear();
  __resetTurnMarkRestoreForTests();
});

describe("turn mark restore — matching core", () => {
  it("cancels out the decoration an agent draws in front of a prompt", () => {
    expect(normalizeMatchText("> こんにちは")).toBe("こんにちは");
    expect(normalizeMatchText("│ > こんにちは                    │")).toBe("こんにちは");
    expect(normalizeMatchText("こんにちは")).toBe("こんにちは");
  });

  it("normalises a prompt that starts with markup the same way as its line", () => {
    expect(normalizeMatchText("- 箇条書き")).toBe(normalizeMatchText("> - 箇条書き"));
    expect(normalizeMatchText("# 見出し")).toBe(normalizeMatchText("> # 見出し"));
  });

  it("uses the first line of a multi-line prompt", () => {
    expect(normalizeMatchText("\n\n先頭行\n2行目")).toBe("先頭行");
  });

  it("never lets a short prompt claim a line that merely starts with it", () => {
    expect(promptMatchesLine("Go", "Go somewhere else")).toBe(false);
    expect(promptMatchesLine("Go", "Go")).toBe(true);
  });

  it("accepts a hard-wrapped head of a long prompt but not a short one", () => {
    const prompt = "この指示はペイン幅より長いので途中で折り返される";
    expect(promptMatchesLine(prompt, "この指示はペイン幅より長いので")).toBe(true);
    expect(promptMatchesLine(prompt, "この指示は")).toBe(false);
  });

  /**
   * Measured on real panes: anchoring at the oldest prompt let a prompt whose
   * own line had scrolled off claim a much later repeat of the same text, and
   * the monotonic rule then blocked every prompt in between (23 of 24 marks
   * lost). The pairing runs from the newest end for exactly this case.
   */
  it("does not let a scrolled-off prompt steal a later repeat of its text", () => {
    const lines = [
      { line: 0, text: "❯ 定型の報告" },
      { line: 1, text: "● 応答" },
      { line: 2, text: "❯ 定型の報告" },
      { line: 3, text: "● 応答" },
      { line: 4, text: "❯ 進捗" },
    ];
    // The first 進捗 and the first 定型の報告 are gone from the buffer.
    const result = matchPromptsToBuffer(
      [
        { text: "進捗", at: 1 },
        { text: "定型の報告", at: 2 },
        { text: "定型の報告", at: 3 },
        { text: "定型の報告", at: 4 },
        { text: "進捗", at: 5 },
      ],
      lines,
    );
    expect(result.placements.map((placement) => placement.line)).toEqual([0, 2, 4]);
    expect(result.placements.map((placement) => placement.at)).toEqual([3, 4, 5]);
    expect(result.skipped).toBe(2);
  });

  it("keeps a prompt with no line at all out of the placements", () => {
    const lines = [
      { line: 0, text: "> 実在する指示" },
      { line: 1, text: "⏺ 応答" },
    ];
    const result = matchPromptsToBuffer(
      [
        { text: "実在する指示", at: 1 },
        { text: "画面に無い指示", at: 2 },
      ],
      lines,
    );
    expect(result.placements).toEqual([{ line: 0, label: "実在する指示", at: 1 }]);
    expect(result.skipped).toBe(1);
  });
});

describe("turn mark restore — buffer scan", () => {
  it("joins xterm-wrapped rows so a long prompt is found at its head row", async () => {
    const sessionId = "wrap-join";
    const term = attach(sessionId, { cols: 12, rows: 6, scrollback: 100 });
    await write(term, "> 折り返しの起きる長い指示文です\r\n");
    const { lines } = collectLogicalLines(term.buffer.active, 0, 1_000);
    const head = lines[0];
    expect(head?.line).toBe(0);
    expect(normalizeMatchText(head?.text ?? "")).toBe("折り返しの起きる長い指示文です");
  });

  it("resumes the next chunk past a complete logical line", async () => {
    const sessionId = "chunked";
    const term = attach(sessionId, { cols: 10, rows: 6, scrollback: 100 });
    await write(term, "> 折り返す長い一行目\r\n> 二行目\r\n");
    const first = collectLogicalLines(term.buffer.active, 0, 1);
    expect(first.lines).toHaveLength(1);
    expect(first.nextRow).toBeGreaterThan(1);
    const second = collectLogicalLines(term.buffer.active, first.nextRow, 1_000);
    expect(second.lines.map((entry) => normalizeMatchText(entry.text))).toContain("二行目");
  });
});

describe("turn mark restore — end to end on a redrawn pane", () => {
  it("restores a mark for every past prompt found in the buffer", async () => {
    const sessionId = "restore-basic";
    const term = attach(sessionId);
    await redraw(term, [
      "> 最初の指示",
      "⏺ わかりました",
      "> 二番目の指示",
      "⏺ 進めます",
      "> 三番目の指示",
      "⏺ 完了しました",
    ]);
    noteRestoreBoundaryTurn(sessionId);

    const report = await restoreTurnMarksFromTranscript(
      sessionId,
      deps([
        { text: "最初の指示", occurredAt: 1 },
        { text: "二番目の指示", occurredAt: 2 },
        { text: "三番目の指示", occurredAt: 3 },
      ]),
    );

    expect(report.outcome).toBe("restored");
    expect(report.restored).toBe(3);
    expect(report.skipped).toBe(0);
    const marks = getTurnMarkData(sessionId);
    expect(marks.map((mark) => mark.label)).toEqual([
      "最初の指示",
      "二番目の指示",
      "三番目の指示",
      RESTORE_BOUNDARY_LABEL,
    ]);
    expect(marks.map((mark) => mark.line)).toEqual([0, 2, 4, 6]);
  });

  it("keeps repeated one-word prompts in transcript order", async () => {
    const sessionId = "restore-repeat";
    const term = attach(sessionId);
    await redraw(term, [
      "> Go",
      "⏺ 一件目",
      "> 進捗",
      "⏺ 途中です",
      "> Go",
      "⏺ 二件目",
      "> 進捗",
      "⏺ 終わりました",
    ]);
    noteRestoreBoundaryTurn(sessionId);

    const report = await restoreTurnMarksFromTranscript(
      sessionId,
      deps([
        { text: "Go", occurredAt: 1 },
        { text: "進捗", occurredAt: 2 },
        { text: "Go", occurredAt: 3 },
        { text: "進捗", occurredAt: 4 },
      ]),
    );

    expect(report.restored).toBe(4);
    const marks = getTurnMarkData(sessionId).filter((mark) => mark.label !== RESTORE_BOUNDARY_LABEL);
    expect(marks.map((mark) => mark.line)).toEqual([0, 2, 4, 6]);
    expect(marks.map((mark) => mark.at)).toEqual([1, 2, 3, 4]);
    // Strictly increasing: the nth prompt never lands before the (n-1)th.
    for (let index = 1; index < marks.length; index += 1) {
      expect(marks[index]!.line).toBeGreaterThan(marks[index - 1]!.line);
    }
  });

  it("never counts a prompt it could not find", async () => {
    const sessionId = "restore-missing";
    const term = attach(sessionId);
    await redraw(term, ["> 画面にある指示", "⏺ 応答"]);
    noteRestoreBoundaryTurn(sessionId);

    const report = await restoreTurnMarksFromTranscript(
      sessionId,
      deps([
        { text: "画面にある指示", occurredAt: 1 },
        { text: "スクロールバックから落ちた指示", occurredAt: 2 },
        { text: "これも画面には無い", occurredAt: 3 },
      ]),
    );

    expect(report.restored).toBe(1);
    expect(report.skipped).toBe(2);
    // The chip's total is the mark count, so an unfound prompt cannot inflate it.
    const marks = getTurnMarkData(sessionId);
    expect(marks).toHaveLength(report.restored + 1);
    expect(marks.some((mark) => mark.label === "スクロールバックから落ちた指示")).toBe(false);
  });

  it("finds a prompt the agent hard-wrapped when it redrew it", async () => {
    const sessionId = "restore-hardwrap";
    const term = attach(sessionId, { cols: 30, rows: 6, scrollback: 100 });
    await redraw(term, ["> この指示は再描画のときに", "  途中で折り返されている", "⏺ 応答"]);
    noteRestoreBoundaryTurn(sessionId);

    const report = await restoreTurnMarksFromTranscript(
      sessionId,
      deps([{ text: "この指示は再描画のときに途中で折り返されている", occurredAt: 1 }]),
    );

    expect(report.restored).toBe(1);
    expect(getTurnMarkData(sessionId)[0]?.line).toBe(0);
  });
});

describe("turn mark restore — guards", () => {
  it("does not run, and never reads the transcript, on a pane that was not restored", async () => {
    const sessionId = "restore-live-pane";
    const term = attach(sessionId);
    await redraw(term, ["> 生ログの指示", "⏺ 応答"]);
    noteTurnSubmit(sessionId, "生ログの指示", 1_000);
    const fetchPrompts = vi.fn(async () => [{ text: "生ログの指示", occurredAt: 1 }]);

    const report = await restoreTurnMarksFromTranscript(sessionId, {
      fetchPrompts,
      wait: async () => {},
      report: () => {},
    });

    expect(report.outcome).toBe("not-restored-pane");
    expect(fetchPrompts).not.toHaveBeenCalled();
    expect(getTurnMarkData(sessionId).map((mark) => mark.label)).toEqual(["生ログの指示"]);
  });

  it("leaves the live submit path alone after a restore", async () => {
    const sessionId = "restore-then-live";
    const term = attach(sessionId);
    await redraw(term, ["> 復元される指示", "⏺ 応答"]);
    noteRestoreBoundaryTurn(sessionId);
    await restoreTurnMarksFromTranscript(sessionId, deps([{ text: "復元される指示", occurredAt: 1 }]));

    await write(term, "生ログ\r\n");
    noteTurnSubmit(sessionId, "あとから打った指示", Date.now() + 10_000);

    const marks = getTurnMarkData(sessionId);
    expect(marks[marks.length - 1]?.label).toBe("あとから打った指示");
    expect(marks.map((mark) => mark.label)).toContain("復元される指示");
  });

  it("runs at most once per session", async () => {
    const sessionId = "restore-once";
    const term = attach(sessionId);
    await redraw(term, ["> 一度だけ", "⏺ 応答"]);
    noteRestoreBoundaryTurn(sessionId);
    const fetchPrompts = vi.fn(async () => [{ text: "一度だけ", occurredAt: 1 }]);

    const first = await restoreTurnMarksFromTranscript(sessionId, {
      fetchPrompts,
      wait: async () => {},
      report: () => {},
    });
    const second = await restoreTurnMarksFromTranscript(sessionId, {
      fetchPrompts,
      wait: async () => {},
      report: () => {},
    });

    expect(first.restored).toBe(1);
    expect(second.outcome).toBe("already-attempted");
    expect(fetchPrompts).toHaveBeenCalledTimes(1);
  });

  it("places nothing when output moved the buffer during the scan", async () => {
    const sessionId = "restore-moved";
    const term = attach(sessionId);
    await redraw(term, ["> 動いた指示", "⏺ 応答"]);
    noteRestoreBoundaryTurn(sessionId);
    // Quiet while settling, then a fresh write on every sample from the scan on.
    let scanning = false;
    let ticks = 0;

    const report = await restoreTurnMarksFromTranscript(sessionId, {
      fetchPrompts: async () => {
        scanning = true;
        return [{ text: "動いた指示", occurredAt: 1 }];
      },
      writeCounter: () => (scanning ? (ticks += 1) : 0),
      wait: async () => {},
      report: () => {},
    });

    expect(report.outcome).toBe("buffer-moved");
    expect(report.restored).toBe(0);
    expect(getTurnMarkData(sessionId).map((mark) => mark.label)).toEqual([RESTORE_BOUNDARY_LABEL]);
  });
});

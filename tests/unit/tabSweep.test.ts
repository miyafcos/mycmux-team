import { describe, expect, it, vi } from "vitest";
import type { PtyMetadataSnapshot } from "../../src/lib/ipc";
import type { Workspace } from "../../src/types";
import {
  applySweep,
  buildJudgePrompt,
  countUnseenSweepTabs,
  formatJudgeError,
  formatLastOutputAge,
  formatSweepCompletion,
  hasIdlePrompt,
  hasQueuedInput,
  lastMeaningfulTailLine,
  parseJudgeOutput,
  parseJudgeOutputResult,
  scanTabs,
  shortenCwdFromStart,
  summarizeSweepReport,
  TAB_SWEEP_IDLE_MS,
  type SweepReport,
  type SweepScanSource,
  type SweepTab,
} from "../../src/components/layout/tabSweep";

const NOW = 1_800_000_000_000;
const liveProcess = { process_status: "claude" } as PtyMetadataSnapshot[string];

function workspace(tabs: Workspace["panes"][number]["tabs"], activeTabId = tabs[0]?.id ?? ""): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    panes: [{
      id: "pane-1",
      agentId: "shell-starter",
      sessionId: tabs[0]?.sessionId ?? "",
      tabs,
      activeTabId,
    }],
  };
}

function source(overrides: Partial<SweepScanSource> = {}): SweepScanSource {
  return {
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    metadata: {},
    processMetadata: {},
    processMetadataAvailable: true,
    lastOutputBySession: {},
    isScreenObserved: () => false,
    readTail: async () => ["❯"],
    now: NOW,
    ...overrides,
  };
}

function tab(id: string, category: SweepTab["category"], unnamed = false): SweepTab {
  return {
    id,
    sessionId: `session-${id}`,
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    paneId: "pane-1",
    category,
    lockReasons: category === "LOCKED" ? ["active"] : [],
    unnamed,
    tail: ["❯"],
    processStatusReason: category === "DEAD" ? "no_live_pty_session" : null,
    lastOutputAt: NOW - TAB_SWEEP_IDLE_MS - 1,
  };
}

function report(tabs: SweepTab[]): SweepReport {
  return {
    scannedAt: NOW,
    tabs,
    dead: tabs.filter((item) => item.category === "DEAD"),
    locked: tabs.filter((item) => item.category === "LOCKED"),
    candidates: tabs.filter((item) => item.category === "CANDIDATE"),
    unnamed: tabs.filter((item) => item.category !== "DEAD" && item.unnamed),
  };
}

describe("scanTabs", () => {
  it("classifies DEAD, all LOCKED reasons, and a quiet CANDIDATE", async () => {
    const tabs = [
      { id: "dead", sessionId: "s-dead", agentId: "shell-starter", type: "terminal" as const },
      { id: "active", sessionId: "s-active", agentId: "shell-starter", type: "terminal" as const },
      { id: "recent", sessionId: "s-recent", agentId: "shell-starter", type: "terminal" as const },
      { id: "queued", sessionId: "s-queued", agentId: "shell-starter", type: "terminal" as const },
      { id: "working", sessionId: "s-working", agentId: "shell-starter", type: "terminal" as const },
      { id: "candidate", sessionId: "s-candidate", agentId: "shell-starter", type: "terminal" as const, label: "候補" },
    ];
    const tails: Record<string, string[]> = {
      "s-active": ["❯"],
      "s-recent": ["❯"],
      "s-queued": ["❯ 次の指示"],
      "s-working": ["作業中"],
      "s-candidate": ["❯"],
    };
    const result = await scanTabs(source({
      workspaces: [workspace(tabs, "active")],
      activeWorkspaceId: "workspace-1",
      metadata: { "s-working": { agentStatus: "working" } },
      processMetadata: {
        "s-active": liveProcess,
        "s-recent": liveProcess,
        "s-queued": liveProcess,
        "s-working": liveProcess,
        "s-candidate": liveProcess,
      },
      lastOutputBySession: {
        "s-recent": NOW - TAB_SWEEP_IDLE_MS,
        "s-candidate": NOW - TAB_SWEEP_IDLE_MS - 1,
      },
      isScreenObserved: (sessionId) => sessionId === "s-working",
      readTail: async (sessionId) => tails[sessionId] ?? [],
    }));

    expect(result.dead.map((item) => item.id)).toEqual(["dead"]);
    expect(result.tabs.find((item) => item.id === "active")?.lockReasons).toContain("active");
    expect(result.tabs.find((item) => item.id === "recent")?.lockReasons).toContain("recent_output");
    expect(result.tabs.find((item) => item.id === "queued")?.lockReasons).toContain("queued_input");
    expect(result.tabs.find((item) => item.id === "working")?.lockReasons).toContain("working");
    expect(result.candidates.map((item) => item.id)).toEqual(["candidate"]);
    expect(result.unnamed.map((item) => item.id)).not.toContain("dead");
  });

  it("treats snapshot_unavailable as DEAD", async () => {
    const result = await scanTabs(source({
      workspaces: [workspace([
        { id: "lost", sessionId: "s-lost", agentId: "shell-starter", type: "terminal" },
      ])],
      processMetadataAvailable: false,
    }));
    expect(result.dead[0]?.processStatusReason).toBe("snapshot_unavailable");
  });

  it("keeps no_foreground_process live and requires an idle prompt", async () => {
    const tabs = [
      { id: "live-idle", sessionId: "s-live-idle", agentId: "shell-starter", type: "terminal" as const },
      { id: "server", sessionId: "s-server", agentId: "shell-starter", type: "terminal" as const },
    ];
    const result = await scanTabs(source({
      workspaces: [workspace(tabs)],
      processMetadata: {
        "s-live-idle": {} as PtyMetadataSnapshot[string],
        "s-server": liveProcess,
      },
      readTail: async (sessionId) => sessionId === "s-live-idle" ? ["❯"] : ["server listening"],
    }));
    expect(result.tabs.find((item) => item.id === "live-idle")?.processStatusReason).toBe("no_foreground_process");
    expect(result.candidates.map((item) => item.id)).toContain("live-idle");
    expect(result.tabs.find((item) => item.id === "server")?.lockReasons).toContain("not_at_prompt");
  });

  it("locks screen-observed tabs but treats stale working metadata as a candidate", async () => {
    const tabs = [
      { id: "observed", sessionId: "s-observed", agentId: "shell-starter", type: "terminal" as const },
      { id: "stale-working", sessionId: "s-stale", agentId: "shell-starter", type: "terminal" as const },
    ];
    const result = await scanTabs(source({
      workspaces: [workspace(tabs)],
      metadata: {
        "s-observed": { agentStatus: "waiting" },
        "s-stale": { agentStatus: "working" },
      },
      processMetadata: { "s-observed": liveProcess, "s-stale": liveProcess },
      isScreenObserved: (sessionId) => sessionId === "s-observed",
    }));
    expect(result.tabs.find((item) => item.id === "observed")?.lockReasons).toContain("active");
    expect(result.candidates.map((item) => item.id)).toContain("stale-working");
  });
});

describe("queued input detection", () => {
  it.each([
    [["❯"], false],
    [["❯ テキスト"], true],
    [["❯", "────────────────────────", "? for shortcuts"], false],
    [["❯", "⏵⏵ bypass permissions on (shift+tab to cycle mode)"], false],
    [["❯", "CC 2.1.220 │ sid abc"], false],
    [["❯", "Opus 4.1 │ CTX 52% │ $1.25 │ cache │ API ok"], false],
    [["古い出力", "❯", "次の指示"], true],
  ] as const)("detects %j as %s", (tail, expected) => {
    expect(hasQueuedInput(tail)).toBe(expected);
  });

  it("requires a real empty prompt before a tab can become a candidate", () => {
    expect(hasIdlePrompt(["server listening"])).toBe(false);
    expect(hasIdlePrompt(["❯"])).toBe(true);
    expect(hasIdlePrompt(["❯ queued"])).toBe(false);
  });

  it.each([
    ["PS C:\\Users\\miyaz>", true],
    ["C:\\work\\project>", true],
    ["$", true],
    ["#", true],
    ["user@host:~/work$", true],
    ["PS C:\\Users\\miyaz> Get-ChildItem", false],
    ["C:\\work> dir", false],
    ["$ npm test", false],
    ["# apt update", false],
    ["price is $", false],
    ["server listening", false],
  ])("recognizes conservative shell prompt %j as idle=%s", (line, expected) => {
    expect(hasIdlePrompt([line])).toBe(expected);
  });

  it("treats text after a shell prompt as queued input", () => {
    expect(hasQueuedInput(["PS C:\\work> npm test"])).toBe(true);
    expect(hasQueuedInput(["C:\\work> dir"])).toBe(true);
    expect(hasQueuedInput(["$ git status"])).toBe(true);
  });
});

describe("judge prompt and output", () => {
  it("builds the requested JSON-only prompt with eight tail lines", () => {
    const candidate = { ...tab("candidate", "CANDIDATE", true), tail: Array.from({ length: 12 }, (_, index) => `line-${index}`) };
    const prompt = buildJudgePrompt([candidate], [candidate]);
    expect(prompt).toContain("JSON 配列のみ");
    expect(prompt).toContain('"id":"candidate"');
    expect(prompt).not.toContain("line-0");
    expect(prompt).toContain("line-11");
  });

  it("parses valid output and trims labels to twelve characters", () => {
    const result = parseJudgeOutput(
      '[{"id":"a","verdict":"done_waiting","label":"123456789012345"}]',
      ["a"],
    );
    expect(result).toEqual([{ id: "a", verdict: "done_waiting", label: "123456789012" }]);
  });

  it("fails safe for garbage, invalid verdicts, and unknown ids", () => {
    expect(parseJudgeOutput("not-json", ["a"])).toEqual([{ id: "a", verdict: "unknown" }]);
    expect(parseJudgeOutput(
      '[{"id":"a","verdict":"close"},{"id":"alien","verdict":"done_waiting"}]',
      ["a"],
    )).toEqual([{ id: "a", verdict: "unknown" }]);
  });

  it("reports malformed or incomplete judge output as invalid for the UI", () => {
    expect(parseJudgeOutputResult("not-json", ["a"]).valid).toBe(false);
    expect(parseJudgeOutputResult('[{"id":"a","verdict":"done_waiting"}]', ["a"]).valid).toBe(true);
    expect(parseJudgeOutputResult('[{"id":"a","verdict":"done_waiting"}]', ["a", "b"]).valid).toBe(false);
    expect(parseJudgeOutputResult('[{"id":"a","verdict":"close"}]', ["a"]).valid).toBe(false);
  });
});

describe("tab sweep UI helpers", () => {
  it("formats elapsed output age against the scan snapshot", () => {
    expect(formatLastOutputAge(NOW - 9_000, NOW)).toBe("最終出力から9秒");
    expect(formatLastOutputAge(NOW - 5 * 60_000, NOW)).toBe("最終出力から5分");
    expect(formatLastOutputAge(NOW - 2 * 60 * 60_000, NOW)).toBe("最終出力から2時間");
    expect(formatLastOutputAge(null, NOW)).toBe("最終出力時刻不明");
  });

  it("keeps the meaningful last line and the end of a long cwd", () => {
    expect(lastMeaningfulTailLine(["build complete", "❯"])).toBe("build complete");
    expect(lastMeaningfulTailLine(["❯"])).toBe("待機プロンプト");
    const shortened = shortenCwdFromStart("C:\\Users\\miyaz\\very\\long\\project\\directory", 20);
    expect(shortened.startsWith("…")).toBe(true);
    expect(shortened.endsWith("project\\directory")).toBe(true);
  });

  it("includes skipped and failed counts in the completion summary", () => {
    expect(formatSweepCompletion("2件閉じました", {
      closed: 2,
      renamed: 0,
      skipped: ["a"],
      errors: ["b: failed"],
    })).toBe("2件閉じました（1件は状態が変わったため見送りました、1件は処理できませんでした）");
  });

  it("maps judge errors to Japanese while retaining raw detail", () => {
    expect(formatJudgeError({ code: "timeout", detail: "timed out raw" })).toEqual({
      summary: "判定が時間切れになりました。もう一度実行してください。",
      raw: "timed out raw",
    });
    expect(formatJudgeError({ code: "cli_not_found", detail: "not found raw" }).summary).toContain("見つかりません");
    expect(formatJudgeError({ code: "cli_failed", detail: "stderr raw" }).summary).toContain("エラー終了");
  });

  it("counts the union of unseen dead, candidate, and unnamed tabs", () => {
    const candidate = tab("candidate", "CANDIDATE", true);
    const summary = summarizeSweepReport(report([tab("dead", "DEAD"), candidate]));
    expect(summary).toMatchObject({ dead: 1, candidates: 1, unnamed: 1 });
    expect(countUnseenSweepTabs(summary, new Set())).toBe(2);
    expect(countUnseenSweepTabs(summary, new Set(["candidate:candidate", "unnamed:candidate"]))).toBe(1);
  });
});

describe("applySweep safety invariants", () => {
  it("S1 skips a candidate that became LOCKED before apply", async () => {
    const command = vi.fn(async () => ({}));
    const reports = [report([tab("a", "LOCKED")])];
    const scan = vi.fn(async () => reports[0]);
    await applySweep(
      { closeCandidateTabIds: ["a"], verdicts: [{ id: "a", verdict: "done_waiting" }] },
      { scan, command },
    );
    expect(command).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledWith("a");
  });

  it("S1 skips when the target changes between the two immediate safety scans", async () => {
    const command = vi.fn(async () => ({}));
    const states = [report([tab("a", "CANDIDATE")]), report([tab("a", "LOCKED")])];
    const scan = vi.fn(async () => states.shift() ?? report([]));
    const result = await applySweep(
      { closeCandidateTabIds: ["a"], verdicts: [{ id: "a", verdict: "done_waiting" }] },
      { scan, command },
    );
    expect(result.closed).toBe(0);
    expect(command).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("S2 closes only explicit done_waiting candidate ids", async () => {
    const command = vi.fn(async () => ({}));
    const current = report([tab("done", "CANDIDATE"), tab("unknown", "CANDIDATE")]);
    const result = await applySweep(
      {
        closeCandidateTabIds: ["done", "unknown"],
        verdicts: [
          { id: "done", verdict: "done_waiting" },
          { id: "unknown", verdict: "unknown" },
        ],
      },
      { scan: async () => current, command },
    );
    expect(result.closed).toBe(1);
    expect(command).toHaveBeenCalledWith("pane.close_tab", { sessionId: "session-done" });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("B-9 manually closes a stable candidate without weakening the AI path", async () => {
    const command = vi.fn(async () => ({}));
    const current = report([tab("manual", "CANDIDATE")]);
    const result = await applySweep(
      { manualCloseCandidateTabIds: ["manual"] },
      { scan: async () => current, command },
    );
    expect(result.closed).toBe(1);
    expect(command).toHaveBeenCalledWith("pane.close_tab", { sessionId: "session-manual" });
  });

  it("B-9 keeps a manually selected tab when the second safety scan becomes locked", async () => {
    const command = vi.fn(async () => ({}));
    const states = [report([tab("manual", "CANDIDATE")]), report([tab("manual", "LOCKED")])];
    const result = await applySweep(
      { manualCloseCandidateTabIds: ["manual"] },
      { scan: async () => states.shift() ?? report([]), command },
    );
    expect(result.closed).toBe(0);
    expect(result.skipped).toEqual(["manual"]);
    expect(command).not.toHaveBeenCalled();
  });

  it("S4 closes DEAD tabs without any judge verdict", async () => {
    const command = vi.fn(async () => ({}));
    const result = await applySweep(
      { closeDeadTabIds: ["dead"] },
      { scan: async () => report([tab("dead", "DEAD")]), command },
    );
    expect(result.closed).toBe(1);
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith("pane.close_tab", { sessionId: "session-dead" });
  });

  it("S5 renames only tabs that are still unnamed", async () => {
    const command = vi.fn(async () => ({}));
    const named = { ...tab("named", "CANDIDATE"), unnamed: false, label: "既存" };
    const unnamed = tab("unnamed", "CANDIDATE", true);
    const current = report([named, unnamed]);
    const result = await applySweep(
      { renames: [{ id: "named", label: "上書き" }, { id: "unnamed", label: "新しい名前" }] },
      { scan: async () => current, command },
    );
    expect(result.renamed).toBe(1);
    expect(command).toHaveBeenCalledWith("pane.rename_tab", {
      sessionId: "session-unnamed",
      label: "新しい名前",
    });
    expect(command).toHaveBeenCalledTimes(1);
  });
});

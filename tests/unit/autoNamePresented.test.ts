// Presented automatic names (2026-10-14): session title, then the rule-derived
// name, then the launch label, and only then the unknown name.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({ ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: fake.invoke }));
import { createAutoNamePolicy, deriveAutoName, fitPresentedName, presentedAutoName, resolveNameSiblings, stripWorkspacePrefix,
  UNKNOWN_AUTO_NAME, type AutoNameMeaning } from "../../src/lib/autoNamePolicy";
import { buildAutoNameEvidence, namingBinding, type AutoNameEvidence, type AutoNameScan } from "../../src/lib/autoNameMaterial";
import { aggregateWorkspaceName } from "../../src/lib/autoWorkspaceNaming";
import { buildLocalGroupingScan } from "../../src/components/layout/groupingLocalPlan";
import { resetSessionTitlesForTest, TITLE_REFRESH_MS, TITLE_RETRY_MS, TITLE_RETRY_WINDOW_MS, TITLE_WAIT_MS, TITLED_AGENT_KINDS,
  withSessionTitles } from "../../src/lib/sessionTitles";
import { getTabDisplayLabel } from "../../src/lib/tabDisplayLabel";
import type { GroupingScan } from "../../src/components/layout/tabGrouping";
import type { PaneTab, Workspace } from "../../src/types";

const refs = { binding: "b", contentKey: "k", evidenceRefs: [] };
const userWorkspace = { name: "ひかりスタ 数学" };

describe("fitPresentedName", () => {
  it("keeps short names and cuts long ones at a boundary without an ellipsis", () => {
    expect(fitPresentedName("山田さんへのメール返信", 20)).toBe("山田さんへのメール返信");
    const cut = fitPresentedName("サンプル企画 問題集2027年度版 DTP入稿状況", 20);
    expect(cut).toBe("サンプル企画 問題集2027年度版");
    expect(cut).not.toContain("…");
  });
  it.each([
    ["833-3 田中様 例題② (10/14)", "833-3 田中様 例題②"],
    ["hikarist-video-measure-rerun", "hikarist-video"],
    ["ひかりスタ数学の定積分スライドの修正と再提出の準備", "ひかりスタ数学の定積分スライドの修正"],
    ["北斗学院数学科の先生方全員へ三次原稿の送付", "北斗学院数学科の先生方全員へ三次原稿"],
    ["北斗学院数学科の先生方全員へ三次原稿送付予定", "北斗学院数学科の先生方全員"],
  ])("does not end %s inside a bracket or on a joiner", (text, expected) => {
    expect(fitPresentedName(text, 20)).toBe(expected);
  });
});

describe("stripWorkspacePrefix", () => {
  it("drops a leading copy of a hand-given workspace name, ignoring spaces", () => {
    expect(stripWorkspacePrefix("ひかりスタ数学 定積分スライド修正", "ひかりスタ 数学")).toBe("定積分スライド修正");
    expect(stripWorkspacePrefix("ひかりスタ数学 定積分スライド修正", "ひかりスタ")).toBe("数学 定積分スライド修正");
  });
  it.each([
    ["数学台割の不備と修正版", "数学台割の不備と修正版"],
    ["ひかりスタ数学の修正", "ひかりスタ 数学"],
    ["ひかりスタ数学 解説", "ひかりスタ 数学"],
    ["サンプル企画動画の子役・機材手配", "ひかりスタ 数学"],
    ["ひかりスタ数学 定積分スライド修正", "ひ"],
    ["ひかりスタンド設置の案内", "ひかりスタ"],
    ["北斗学院 数学 三次原稿", "北斗"],
    ["2027年度 入試問題 確認作業", "2027"],
    ["v2.1 リリース作業", "v2"],
    ["北斗(学院) 数学 二次", "北斗"],
  ])("keeps %s when the rest would be empty, a particle, too short, mid-word or unrelated", (title, workspace) => {
    expect(stripWorkspacePrefix(title, workspace)).toBe(title);
  });
});

describe("presentedAutoName", () => {
  it("prefers the session title even over a rule-derived name", () => {
    const named = presentedAutoName({ sessionTitle: "ひかりスタ数学 定積分スライド修正", label: "cdb-p2", labelSource: "launch" }, userWorkspace, refs, true);
    expect(named).toMatchObject({ source: "title", fullName: "定積分スライド修正", strength: "strong", fresh: true });
  });
  it("does not strip with an automatic workspace name", () => {
    expect(presentedAutoName({ sessionTitle: "ひかりスタ数学 定積分スライド修正" }, { ...userWorkspace, nameSource: "auto" }, refs)?.fullName)
      .toBe("ひかりスタ数学 定積分スライド修正");
  });
  it("uses a launch label only when the rules found nothing", () => {
    const tab = { label: "833-3 田中様 例題② (10/14)", labelSource: "launch" as const };
    expect(presentedAutoName(tab, userWorkspace, refs, false)).toMatchObject({ source: "label", fullName: "833-3 田中様 例題②" });
    expect(presentedAutoName(tab, userWorkspace, refs, true)).toBeUndefined();
  });
  it.each([
    [{ label: "人の名前", labelSource: "user" as const }, undefined],
    [{ label: "開発 (StaffOps ほか)" }, undefined],
    [{ label: "claude-123456", labelSource: "launch" as const }, undefined],
    [{ label: "bokan-claude-123456", labelSource: "launch" as const }, undefined],
    [{ label: "claude-1", labelSource: "launch" as const }, undefined],
    [{ label: "claude-codex-3", labelSource: "launch" as const }, undefined],
    [{ label: "agent_7", labelSource: "launch" as const }, undefined],
    [{ label: "cdb-3fa9c1d2e4", labelSource: "launch" as const }, undefined],
    [{ label: "worker-261014-a", labelSource: "launch" as const }, undefined],
    [{ label: "moshi-edit" }, "moshi-edit"],
    [{ label: "261014-hikarist-video-measure", labelSource: "launch" as const }, "hikarist-video"],
    [{ sessionTitle: "bad\u0007title", label: "cdb-plan-2d", labelSource: "launch" as const }, "cdb-plan-2d"],
  ])("handles labels and unsafe titles: %j", (tab, expected) => {
    expect(presentedAutoName(tab, userWorkspace, refs)?.fullName).toBe(expected);
  });
});

function row(id: string, meaning: AutoNameMeaning, tab: Partial<PaneTab> = {}) {
  return { id, meaning, tab: { id, sessionId: "s-" + id, agentId: "shell-starter", ...tab } as PaneTab };
}
const titled = (name: string) => presentedAutoName({ sessionTitle: name }, undefined, refs)!;

describe("resolveNameSiblings with presented names", () => {
  it("keeps titles that share a four-grapheme prefix instead of falling to unknown", () => {
    const names = resolveNameSiblings([row("a", titled("ひかりスタ数学 定積分スライド修正")), row("b", titled("ひかりスタ動画の編集自動化"))]);
    expect([...names.values()]).toEqual(["ひかりスタ数学 定積分スライド修正", "ひかりスタ動画の編集自動化"]);
  });
  it("numbers only exact repeats and keeps a previous number", () => {
    const names = resolveNameSiblings([row("a", titled("spec.md の引き継ぎ")),
      row("b", titled("spec.md の引き継ぎ"), { displayName: "spec.md の引き継ぎ・2", displayNameSource: "auto" })]);
    expect(names.get("b")).toBe("spec.md の引き継ぎ・2");
    expect(names.get("a")).toBe("spec.md の引き継ぎ・1");
  });
  it("numbers a title that matches a protected name and leaves a lone unknown plain", () => {
    const unknown = deriveAutoName({ id: "u", workspaceId: "w", binding: "u", contentKey: "u", instructions: [], activity: [], files: [], taskTitle: "", cwd: "", evidenceRefs: [] });
    const names = resolveNameSiblings([row("a", titled("山田さんへのメール返信")), row("u", unknown),
      row("m", unknown, { label: "山田さんへのメール返信", labelSource: "user" })]);
    expect(names.get("a")).toBe("山田さんへのメール返信・1");
    expect(names.get("u")).toBe(UNKNOWN_AUTO_NAME);
  });
  it("keeps a numbered twenty-grapheme title within the display cap", () => {
    const names = resolveNameSiblings([row("a", titled("ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴ")), row("b", titled("ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴ"))]);
    for (const name of names.values()) expect([...name].length).toBeLessThanOrEqual(20);
    expect(new Set(names.values()).size).toBe(2);
  });
});

async function policyScan(tabs: PaneTab[], instructions: Record<string, string>, titles: Record<string, string>, name = "ひかりスタ 数学"): Promise<AutoNameScan> {
  const workspace: Workspace = { id: "w", name, createdAt: 0, status: "running", gridTemplateId: "1x1",
    panes: [{ id: "p", sessionId: tabs[0].sessionId, agentId: "shell-starter", activeTabId: tabs[0].id, tabs }] };
  const base = await buildLocalGroupingScan({ workspaces: [workspace], metadata: {}, attentionByTabId: {}, now: 0 });
  const naming = new Map<string, AutoNameEvidence>();
  for (const tab of base.tabs) {
    tab.sessionTitle = titles[tab.id] ?? null;
    const input = buildAutoNameEvidence(tab);
    const instruction = instructions[tab.id] ?? "";
    Object.assign(input, { instructions: instruction ? [instruction] : [], instructionHistoryComplete: true, contentKey: instruction, binding: namingBinding(tab) });
    naming.set(tab.id, input);
  }
  return { ...base, naming };
}

describe("createAutoNamePolicy with presented names", () => {
  it("names by title, then rule, then launch label, then unknown", async () => {
    const tabs: PaneTab[] = [
      { id: "title", sessionId: "s1", agentId: "shell-starter", label: "worker-a", labelSource: "launch" },
      { id: "long", sessionId: "s5", agentId: "shell-starter" },
      { id: "rule", sessionId: "s2", agentId: "shell-starter", label: "bokan clockshift 3009 retry", labelSource: "launch" },
      { id: "label", sessionId: "s3", agentId: "shell-starter", label: "833-3 田中様 例題② (10/14)", labelSource: "launch" },
      { id: "none", sessionId: "s4", agentId: "shell-starter" },
    ];
    const scan = await policyScan(tabs, { title: "日付表示を修正する", rule: "日付表示を修正する", label: "進捗の確認" },
      { title: "ひかりスタ数学 定積分スライド修正", long: "サンプル企画 問題集2027年度版 DTP入稿状況" });
    const names = createAutoNamePolicy(() => 0).identify(scan).tabs;
    expect(names.get("title")?.displayName).toBe("定積分スライド修正");
    expect(names.get("rule")?.displayName).toBe("日付表示修正");
    expect(names.get("label")?.displayName).toBe("833-3 田中様 例題②");
    expect(names.get("none")?.displayName?.startsWith(UNKNOWN_AUTO_NAME)).toBe(true);
    expect(names.get("title")?.subjectReason).toBe("session_title");
    // What the heading, sidebar and dashboard draw: a long title must not fall back to the unknown name there.
    for (const tab of tabs.filter(t => t.id !== "none")) {
      const displayName = names.get(tab.id)!.displayName;
      expect(getTabDisplayLabel({ ...tab, displayName, displayNameSource: "auto" })).toBe(displayName);
    }
    expect(names.get("long")?.displayName).toBe("サンプル企画 問題集2027年度版");
  });
});

describe("aggregateWorkspaceName with presented names", () => {
  const tab = (id: string): PaneTab => ({ id, sessionId: "s-" + id, agentId: "shell-starter" });
  const workspace = (tabs: PaneTab[]): Workspace => ({ id: "w", name: "前の名前", nameSource: "auto", createdAt: 0, status: "running", gridTemplateId: "1x1",
    panes: [{ id: "p", sessionId: tabs[0].sessionId, agentId: "shell-starter", activeTabId: tabs[0].id, tabs }] });
  const titledFor = (t: PaneTab, title: string) => presentedAutoName({ sessionTitle: title }, undefined,
    { binding: namingBinding(t), contentKey: title, evidenceRefs: [] })!;
  it("fits a long single title instead of turning it into the unknown name", () => {
    const a = tab("a");
    const summary = aggregateWorkspaceName(workspace([a]), new Map([["a", titledFor(a, "サンプル企画 問題集2027年度版 DTP入稿状況")]]));
    expect(summary.name).toBe("サンプル企画 問題集2027年度版");
  });
  it("counts a tab named by its launch label as unknown for the workspace", () => {
    const [a, b] = [tab("a"), tab("b")];
    const label = presentedAutoName({ label: "cdb-plan-2d", labelSource: "launch" }, undefined,
      { binding: namingBinding(b), contentKey: "l", evidenceRefs: [] })!;
    expect(aggregateWorkspaceName(workspace([b]), new Map([["b", label]])).name).toBe(UNKNOWN_AUTO_NAME);
    const mixed = aggregateWorkspaceName(workspace([a, b]), new Map([["a", titledFor(a, "山田さんへのメール返信")], ["b", label]]));
    expect(mixed.unknown).toBe(1);
    expect(mixed.description).toContain("起動時の名前 1件");
    expect(mixed.description).not.toContain("作業内容未取得");
    expect(mixed.name).not.toContain("cdb-plan-2d");
  });
  it("lists the first title with the remainder count", () => {
    const [a, b] = [tab("a"), tab("b")];
    const summary = aggregateWorkspaceName(workspace([a, b]), new Map([["a", titledFor(a, "山田さんへのメール返信")], ["b", titledFor(b, "サンプル企画動画の子役・機材手配")]]));
    expect(summary.name).not.toContain(UNKNOWN_AUTO_NAME);
    expect(summary.name!.length).toBeLessThanOrEqual(20);
    expect(summary.unknown).toBe(0);
  });
});

describe("withSessionTitles", () => {
  const scanTab = (id: string, agentKind: string) => ({ id, sessionId: "s-" + id, agentKind, agentSessionId: "a-" + id, cwd: "/c", label: "",
    workspaceId: "w", workspaceName: "", paneId: "p", column: 1, lastOutputAt: null, tail: [] }) as GroupingScan["tabs"][number];
  const scan = (tabs: GroupingScan["tabs"]) => ({ scannedAt: 0, tabs, lineageClusters: [], baseline: [], workspaceIds: ["w"], workspaces: [] }) as GroupingScan;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); fake.invoke.mockReset(); resetSessionTitlesForTest(); });
  afterEach(() => { vi.useRealTimers(); });
  it("rereads an untitled Claude tab after a minute and a titled one after five", async () => {
    const tabs = [scanTab("c1", "claude"), scanTab("x1", "codex")];
    fake.invoke.mockResolvedValue([{ tab_id: "c1", session_title: null, task_title: null }, { tab_id: "x1", session_title: null, task_title: null }]);
    await withSessionTitles(scan(tabs));
    expect(fake.invoke).toHaveBeenCalledTimes(2); // Claude and the rest are read apart
    fake.invoke.mockClear().mockResolvedValue([{ tab_id: "c1", session_title: "山田さんへのメール返信", task_title: null }]);
    vi.setSystemTime(1_000_000 + TITLE_RETRY_MS);
    const titled = await withSessionTitles(scan(tabs));
    expect(fake.invoke.mock.calls[0][1].requests.map((r: { tab_id: string }) => r.tab_id)).toEqual(["c1"]);
    expect(titled.tabs[0].sessionTitle).toBe("山田さんへのメール返信");
    fake.invoke.mockClear();
    vi.setSystemTime(1_000_000 + TITLE_RETRY_MS * 2);
    await withSessionTitles(scan(tabs));
    expect(fake.invoke).not.toHaveBeenCalled();
    // Five minutes after the first read only the Codex tab is due; the Claude tab was read again at one minute.
    vi.setSystemTime(1_000_000 + TITLE_REFRESH_MS + 1);
    await withSessionTitles(scan(tabs));
    expect(fake.invoke.mock.calls.map(call => call[1].requests.map((r: { tab_id: string }) => r.tab_id))).toEqual([["x1"]]);
  });
  it("reads only titled agents when asked and stops the quick retry after the window", async () => {
    const tabs = [scanTab("c2", "claude"), scanTab("x2", "codex")];
    fake.invoke.mockResolvedValue([{ tab_id: "c2", session_title: null, task_title: null }]);
    await withSessionTitles(scan(tabs), TITLED_AGENT_KINDS);
    expect(fake.invoke.mock.calls[0][1].requests.map((r: { tab_id: string }) => r.tab_id)).toEqual(["c2"]);
    fake.invoke.mockClear();
    vi.setSystemTime(1_000_000 + TITLE_RETRY_WINDOW_MS);
    await withSessionTitles(scan(tabs), TITLED_AGENT_KINDS);
    expect(fake.invoke).toHaveBeenCalledTimes(1);
    fake.invoke.mockClear();
    vi.setSystemTime(1_000_000 + TITLE_RETRY_WINDOW_MS + TITLE_RETRY_MS);
    await withSessionTitles(scan(tabs), TITLED_AGENT_KINDS);
    expect(fake.invoke).not.toHaveBeenCalled();
  });
  it("does not read the same tab twice while a read is in flight", async () => {
    let finish!: (value: unknown) => void;
    fake.invoke.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const tabs = [scanTab("c3", "claude")];
    const first = withSessionTitles(scan(tabs));
    const second = withSessionTitles(scan(tabs), TITLED_AGENT_KINDS);
    finish([{ tab_id: "c3", session_title: "題名", task_title: null }]);
    expect((await first).tabs[0].sessionTitle).toBe("題名");
    // The second caller waits for the read under way instead of returning without the title.
    expect((await second).tabs[0].sessionTitle).toBe("題名");
    expect(fake.invoke).toHaveBeenCalledTimes(1);
  });
  it("reads titled agents apart from the rest and does not wait on the other read", async () => {
    let finishRest!: (value: unknown) => void;
    fake.invoke.mockImplementation(async (_command: string, args: { requests: Array<{ tab_id: string }> }) =>
      args.requests[0].tab_id === "x4" ? new Promise(resolve => { finishRest = resolve; })
        : [{ tab_id: "c4", session_title: "題名4", task_title: null }]);
    const tabs = [scanTab("c4", "claude"), scanTab("x4", "codex")];
    const grouping = withSessionTitles(scan(tabs));
    const naming = await withSessionTitles(scan(tabs), TITLED_AGENT_KINDS);
    expect(naming.tabs[0].sessionTitle).toBe("題名4");
    expect(fake.invoke).toHaveBeenCalledTimes(2);
    finishRest([{ tab_id: "x4", session_title: null, task_title: null }]);
    await grouping;
  });
  it("lets waiting callers finish when a read fails, then reads again", async () => {
    let fail!: (error: Error) => void;
    fake.invoke.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const tabs = [scanTab("c5", "claude")];
    const first = withSessionTitles(scan(tabs));
    const second = withSessionTitles(scan(tabs), TITLED_AGENT_KINDS);
    fail(new Error("read failed"));
    expect((await first).tabs[0].sessionTitle).toBeUndefined();
    expect((await second).tabs[0].sessionTitle).toBeUndefined();
    expect(fake.invoke).toHaveBeenCalledTimes(1);
    fake.invoke.mockResolvedValueOnce([{ tab_id: "c5", session_title: "題名5", task_title: null }]);
    expect((await withSessionTitles(scan(tabs))).tabs[0].sessionTitle).toBe("題名5");
    expect(fake.invoke).toHaveBeenCalledTimes(2);
  });
  it("stops waiting on a read that never returns", async () => {
    fake.invoke.mockReturnValueOnce(new Promise(() => undefined));
    const tabs = [scanTab("c6", "claude")];
    void withSessionTitles(scan(tabs));
    const waiting = withSessionTitles(scan(tabs), TITLED_AGENT_KINDS);
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS);
    expect((await waiting).tabs[0].sessionTitle).toBeUndefined();
    // Once the lost read is older than the cap, the next call reads again instead of waiting.
    fake.invoke.mockResolvedValueOnce([{ tab_id: "c6", session_title: "題名6", task_title: null }]);
    expect((await withSessionTitles(scan(tabs), TITLED_AGENT_KINDS)).tabs[0].sessionTitle).toBe("題名6");
    expect(fake.invoke).toHaveBeenCalledTimes(2);
  });
  it("keeps a newer title when a given-up read returns late", async () => {
    let late!: (value: unknown) => void;
    fake.invoke.mockReturnValueOnce(new Promise(resolve => { late = resolve; }))
      .mockResolvedValueOnce([{ tab_id: "c7", session_title: "新しい題名", task_title: null }]);
    const tabs = [scanTab("c7", "claude")];
    void withSessionTitles(scan(tabs));
    vi.setSystemTime(1_000_000 + TITLE_WAIT_MS);
    expect((await withSessionTitles(scan(tabs))).tabs[0].sessionTitle).toBe("新しい題名");
    late([{ tab_id: "c7", session_title: null, task_title: null }]);
    await vi.advanceTimersByTimeAsync(0);
    expect((await withSessionTitles(scan(tabs))).tabs[0].sessionTitle).toBe("新しい題名");
    expect(fake.invoke).toHaveBeenCalledTimes(2);
  });
  it("backs off rereading a key whose reads never return", async () => {
    fake.invoke.mockReturnValue(new Promise(() => undefined));
    const tabs = [scanTab("c8", "claude")];
    // Every ten seconds for two minutes: reads at 0s, 10s, 30s and 70s only.
    for (let second = 0; second <= 120; second += 10) {
      vi.setSystemTime(1_000_000 + second * 1000);
      void withSessionTitles(scan(tabs), TITLED_AGENT_KINDS);
    }
    expect(fake.invoke).toHaveBeenCalledTimes(4);
  });
});

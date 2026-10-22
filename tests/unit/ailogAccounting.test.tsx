import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()), invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { AccountingNote } from "../../src/components/ailog/AccountingNote";
import { SessionTable } from "../../src/components/ailog/SessionTable";
import { __resetAilogStoreForTests, useAilogStore } from "../../src/stores/ailogStore";
import { type AccountingTotals, type Overview, type SessionRow, type SessionsReport } from "../../src/lib/ailog";

const accounting: AccountingTotals = { costUsd: 0.009, canonicalUsd: 0.006, legacyUsd: 0.003, unresolvedUsd: 0.002, suspectedDuplicateRows: 2, suspectedDuplicateUsd: 0.006, confirmedDuplicateRows: 1, confirmedDuplicateUsd: 0.003, turns: 2 };

function report(rows: SessionRow[] = []): SessionsReport {
  return { range: { from: 0, to: 99, label: "確認用" }, rows, total: 1, priceSource: "default", costNote: "請求額ではありません" };
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return { kind: "codex", sessionId: "parent", title: "親の作業", projectLabel: null, gitBranch: null, origin: null, primaryModel: null, modelCount: 1, rangeModels: [], rangeModelCount: 0, isSidechain: false, workTags: [], startedAt: 1, endedAt: 2, wallMs: 1, activeMs: 1, turnCount: 1, userMsgCount: 1, compactCount: 0, costUsd: 0.003, reworkScore: 0, goalSummary: "確認用の要約", goalCluster: null, lineage: { parentKind: null, parentSessionId: null, relationshipType: "root", state: "verified" }, presentation: { depth: 0, childrenCount: 1, ownCostUsd: 0.003, groupCostUsd: 0.009, groupTurns: 2, contextOnly: false, parentMissing: false, cycle: false }, ...overrides };
}

function table(rows: SessionRow[]): string {
  return renderToStaticMarkup(<SessionTable report={report(rows)} sort="cost" appliedSort="cost" onSort={() => {}} page={0} appliedPage={0} onPage={() => {}} pageSize={100} onOpenDetail={() => {}} activeKey={null} query="" appliedQuery="" onQuery={() => {}} onRetry={() => {}} loading={false} error={null} modelFilterActive={false} />);
}

describe("親子の会計表示", () => {
  it("合計に含む旧ログと合計外の3分類を区別する", () => {
    const html = renderToStaticMarkup(<AccountingNote accounting={accounting} />);
    expect(html).toContain("子の行を開閉しても合計は変わりません");
    expect(html).toContain("親子の区別なし（元ログなし）");
    expect(html).toContain("写し・再通知の疑い");
    expect(html).toContain("照合済みの写し");
    expect(html).toContain("未確定");
    expect(html).toContain("疑いは重複の確定ではありません");
    const detail = renderToStaticMarkup(<AccountingNote accounting={accounting} sessionOnly />);
    expect(detail).toContain("この会話自身");
    expect(detail).not.toContain("合計は親と子の使用を含みます");
  });

  it("親子行を表示してもページ件数は1組のまま", () => {
    const parent = row();
    const child = row({ sessionId: "child", title: "子の作業", isSidechain: true, presentation: { ...parent.presentation!, depth: 1, childrenCount: 0, ownCostUsd: 0.006, groupCostUsd: 0.006, groupTurns: 1 } });
    const html = table([parent, child]);
    expect(html).toContain("1–1 / 1 組");
    expect(html).toContain("子を含む");
    expect(html).toContain("この会話");
    expect(html).toContain("子 · ");
    expect(html).toContain("padding-left:20px");
  });

  it("元ログなしと表示用の親を区別する", () => {
    expect(table([row({ lineage: { parentKind: null, parentSessionId: null, relationshipType: "unknown", state: "legacy" } })])).toContain("親子の区別なし（元ログなし）");
    const parent = row();
    expect(table([row({ presentation: { ...parent.presentation!, contextOnly: true } })])).toContain("表示用の親（条件に一致する使用なし）");
  });
});

describe("親子表示だけを切り替えるstore", () => {
  beforeEach(() => { __resetAilogStoreForTests(); invokeMock.mockReset().mockResolvedValue(report()); });
  afterEach(() => { __resetAilogStoreForTests(); });

  it("集計値を消さず一覧だけを更新する", async () => {
    const overview = { range: { from: 0, to: 99, label: "確認用" }, totals: { costUsd: 0.009 }, accounting } as Overview;
    useAilogStore.setState({ overview, sessionPage: 2 });
    useAilogStore.getState().setIncludeSidechain(true);
    await vi.waitFor(() => expect(useAilogStore.getState().sessionLoading).toBe(false));
    expect(useAilogStore.getState().overview).toBe(overview);
    expect(useAilogStore.getState().sessionPage).toBe(2);
    expect(invokeMock.mock.calls.every(([command]) => command === "ailog_sessions")).toBe(true);
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ filters: { includeSidechain: true }, options: { offset: 200 } });
  });

  it("表示OFFでも集計は子を含める", async () => {
    expect(useAilogStore.getState().includeSidechain).toBe(false);
    await useAilogStore.getState().refreshUsage();
    expect(invokeMock.mock.calls.find(([command]) => command === "ailog_series")?.[1]).toMatchObject({ filters: { includeSidechain: true } });
    await useAilogStore.getState().refreshSessions();
    expect(invokeMock.mock.calls.find(([command]) => command === "ailog_sessions")?.[1]).toMatchObject({ filters: { includeSidechain: false } });
  });

  it("遅れて返った開いた一覧で閉じた一覧を上書きしない", async () => {
    let resolveExpanded!: (value: SessionsReport) => void;
    invokeMock.mockImplementation((_command: string, payload: { filters: { includeSidechain: boolean } }) => payload.filters.includeSidechain ? new Promise<SessionsReport>((resolve) => { resolveExpanded = resolve; }) : Promise.resolve(report([row()])));
    useAilogStore.getState().setIncludeSidechain(true);
    useAilogStore.getState().setIncludeSidechain(false);
    await vi.waitFor(() => expect(useAilogStore.getState().sessions?.rows).toHaveLength(1));
    resolveExpanded(report([row(), row({ sessionId: "child" })]));
    await Promise.resolve();
    expect(useAilogStore.getState().sessions?.rows).toHaveLength(1);
  });
});

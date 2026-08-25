import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionDetailView } from "../../src/components/ailog/SessionDetailView";
import { SessionTable, sessionModelLabel, sessionModelTitle } from "../../src/components/ailog/SessionTable";
import type { SessionDetail, SessionRow, SessionsReport } from "../../src/lib/ailog";

const baseSession: SessionRow = {
  kind: "codex",
  sessionId: "s1",
  title: "要約済みの主題",
  projectLabel: null,
  gitBranch: null,
  origin: null,
  primaryModel: "gpt-5.6",
  modelCount: 1,
  rangeModels: [],
  rangeModelCount: 0,
  isSidechain: false,
  workTags: [],
  startedAt: 1,
  endedAt: 2,
  wallMs: 1,
  activeMs: 1,
  turnCount: 0,
  userMsgCount: 0,
  compactCount: 0,
  costUsd: 0,
  reworkScore: 0,
  goalSummary: "要約済みの主題",
  goalCluster: null,
};

const detail: SessionDetail = {
  session: baseSession,
  cwd: null, aiTitle: null, firstPrompt: "最初の依頼。二文目", goalKey: null, agentNames: [], cliVersion: null, planType: null, turns: [], tools: [],
  rework: { toolErrorCount: 0, toolCallCount: 0, toolErrorRate: 0, correctionHits: 0, maxFileEdits: 0, churnFiles: 0, retryBash: 0, abandoned: false, score: 0, scoreNote: "" },
  costBreakdown: { ingest: { tokens: 0, costUsd: 0, input: 0, cacheRead: 0, cacheWrite: 0 }, generate: { tokens: 0, costUsd: 0, output: 0, reasoning: 0 }, ingestRatio: 0, cacheHitRate: 0, ioChars: { read: 0, exec: 0, write: 0, fetch: 0, prompt: 0, other: 0, estimation: "" }, ioFiles: { readFiles: 0, writtenFiles: 0 }, note: "" },
  summary: null, priceSource: "", priceCoverage: { priced: { models: [], tokens: 0 }, local: { models: [], tokens: 0 }, internal: { models: [], tokens: 0 }, flat: { models: [], tokens: 0 }, reported: { models: [], tokens: 0 }, unknown: { models: [], tokens: 0 }, coveredTokenRatio: 1 }, costNote: "",
};

function renderDetail(value = detail) {
  return renderToStaticMarkup(<SessionDetailView detail={value} transcript={null} transcriptLoading={false} transcriptError={null} sessionSummarizing={false} sessionSummarizeError={null} onSummarize={() => {}} onClose={() => {}} />);
}

describe("session presentation", () => {
  it("uses the query-provided title and exposes the one-session summary action", () => {
    const html = renderDetail();
    expect(html).toContain("要約済みの主題");
    expect(html).toContain("このセッションを要約する");
    expect(html).not.toContain("F3 で追加予定");
  });

  it("marks a list row with no goal summary as unsummarized", () => {
    const report: SessionsReport = { range: { from: 0, to: 1, label: "test" }, rows: [{ ...detail.session, goalSummary: null }], total: 1, priceSource: "", costNote: "" };
    const html = renderToStaticMarkup(<SessionTable report={report} sort="recent" onSort={() => {}} page={0} onPage={() => {}} pageSize={100} onOpenDetail={() => {}} activeKey={null} />);
    expect(html).toContain("未要約");
    expect(html).not.toContain("最初の依頼。二文目");
  });

  it("shows rangeModels instead of primaryModel when the range list is present", () => {
    const row: SessionRow = {
      ...baseSession,
      primaryModel: "gpt-5.6",
      rangeModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
      rangeModelCount: 2,
    };
    expect(sessionModelLabel(row)).toBe("Codex · gpt-5.6-sol + gpt-5.6-terra");
    expect(sessionModelTitle(row)).toBe("gpt-5.6-sol / gpt-5.6-terra");
    const html = renderToStaticMarkup(
      <SessionTable report={{ range: { from: 0, to: 1, label: "test" }, rows: [row], total: 1, priceSource: "", costNote: "" }} sort="recent" onSort={() => {}} page={0} onPage={() => {}} pageSize={100} onOpenDetail={() => {}} activeKey={null} />,
    );
    expect(html).toContain("Codex · gpt-5.6-sol + gpt-5.6-terra");
    expect(html).not.toContain("gpt-5.6 ·");
    expect(html).not.toMatch(/· gpt-5\.6</);
  });

  it("falls back to primaryModel when rangeModels is empty", () => {
    const row: SessionRow = { ...baseSession, primaryModel: "gpt-5.6", rangeModels: [], rangeModelCount: 0 };
    expect(sessionModelLabel(row)).toBe("Codex · gpt-5.6");
    expect(sessionModelTitle(row)).toBe("gpt-5.6");
    const html = renderToStaticMarkup(
      <SessionTable report={{ range: { from: 0, to: 1, label: "test" }, rows: [row], total: 1, priceSource: "", costNote: "" }} sort="recent" onSort={() => {}} page={0} onPage={() => {}} pageSize={100} onOpenDetail={() => {}} activeKey={null} />,
    );
    expect(html).toContain("Codex · gpt-5.6");
  });

  it("appends ほか N when more models exist than the listed top three", () => {
    const row: SessionRow = {
      ...baseSession,
      rangeModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      rangeModelCount: 5,
    };
    expect(sessionModelLabel(row)).toBe("Codex · gpt-5.6-sol + gpt-5.6-terra + gpt-5.6-luna ほか 2");
    const html = renderToStaticMarkup(
      <SessionTable report={{ range: { from: 0, to: 1, label: "test" }, rows: [row], total: 1, priceSource: "", costNote: "" }} sort="recent" onSort={() => {}} page={0} onPage={() => {}} pageSize={100} onOpenDetail={() => {}} activeKey={null} />,
    );
    expect(html).toContain("ほか 2");
  });

  it("renders (unknown) as ログにモデル名なし", () => {
    const row: SessionRow = {
      ...baseSession,
      rangeModels: ["(unknown)", "gpt-5.6-sol"],
      rangeModelCount: 2,
    };
    expect(sessionModelLabel(row)).toBe("Codex · ログにモデル名なし + gpt-5.6-sol");
    expect(sessionModelTitle(row)).toBe("ログにモデル名なし / gpt-5.6-sol");
    const html = renderToStaticMarkup(
      <SessionTable report={{ range: { from: 0, to: 1, label: "test" }, rows: [row], total: 1, priceSource: "", costNote: "" }} sort="recent" onSort={() => {}} page={0} onPage={() => {}} pageSize={100} onOpenDetail={() => {}} activeKey={null} />,
    );
    expect(html).toContain("ログにモデル名なし");
    expect(html).not.toContain("(unknown)");
  });
});

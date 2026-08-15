import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionDetailView } from "../../src/components/ailog/SessionDetailView";
import { SessionTable } from "../../src/components/ailog/SessionTable";
import type { SessionDetail, SessionsReport } from "../../src/lib/ailog";

const detail: SessionDetail = {
  session: { kind: "codex", sessionId: "s1", title: "要約済みの主題", projectLabel: null, gitBranch: null, origin: null, primaryModel: null, modelCount: 1, isSidechain: false, workTags: [], startedAt: 1, endedAt: 2, wallMs: 1, activeMs: 1, turnCount: 0, userMsgCount: 0, compactCount: 0, costUsd: 0, reworkScore: 0, goalSummary: "要約済みの主題", goalCluster: null },
  cwd: null, aiTitle: null, firstPrompt: "最初の依頼。二文目", goalKey: null, agentNames: [], cliVersion: null, planType: null, turns: [], tools: [],
  rework: { toolErrorCount: 0, toolCallCount: 0, toolErrorRate: 0, correctionHits: 0, maxFileEdits: 0, churnFiles: 0, retryBash: 0, abandoned: false, score: 0, scoreNote: "" },
  costBreakdown: { ingest: { tokens: 0, costUsd: 0, input: 0, cacheRead: 0, cacheWrite: 0 }, generate: { tokens: 0, costUsd: 0, output: 0, reasoning: 0 }, ingestRatio: 0, cacheHitRate: 0, ioChars: { read: 0, exec: 0, write: 0, fetch: 0, prompt: 0, other: 0, estimation: "" }, ioFiles: { readFiles: 0, writtenFiles: 0 }, note: "" },
  summary: null, priceSource: "", priceCoverage: { priced: { models: [], tokens: 0 }, local: { models: [], tokens: 0 }, internal: { models: [], tokens: 0 }, flat: { models: [], tokens: 0 }, unknown: { models: [], tokens: 0 }, coveredTokenRatio: 1 }, costNote: "",
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
    const html = renderToStaticMarkup(<SessionTable report={report} sort="recent" onSort={() => {}} page={0} onPage={() => {}} pageSize={100} selection={null} leafDimension="model" onOpenDetail={() => {}} activeKey={null} />);
    expect(html).toContain("未要約");
    expect(html).not.toContain("最初の依頼。二文目");
  });
});

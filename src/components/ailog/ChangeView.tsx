import { memo, useMemo } from "react";
import type { DigestReport, FindingsReport, IndexStatus, SessionsReport } from "../../lib/ailog";
import type { AilogLastVisit } from "../../lib/ailogLastVisit";
import type { QuestionCardData } from "./questionModel";
import { Section, noteStyle, subtleButtonStyle } from "./ui";

export const ChangeView = memo(function ChangeView({ visit, sessions, findings, digestReport, indexStatus, questions, onOpenLearning, onOpenQuestions, onOpenDaily }: { visit: AilogLastVisit; sessions: SessionsReport | null; findings: FindingsReport | null; digestReport: DigestReport | null; indexStatus: IndexStatus | null; questions: QuestionCardData[]; onOpenLearning: () => void; onOpenQuestions: () => void; onOpenDaily: () => void }) {
  const summary = useMemo(() => {
    const since = visit.lastVisitTs;
    const newSessions = since ? (sessions?.rows ?? []).filter((row) => (row.startedAt ?? row.endedAt ?? 0) > since).length : 0;
    const newFindings = since ? (findings?.rows ?? []).filter((row) => row.date > since).length : 0;
    const unreadDigest = digestReport?.digest && !visit.readDigestDates.includes(digestReport.date) ? 1 : 0;
    const recurring = since ? (findings?.rows ?? []).filter((row) => row.kind === "gotcha" && row.repeatCount >= 2 && row.date > since) : [];
    const changedAnswers = questions.filter((card) => visit.lastAnswers[card.id] && visit.lastAnswers[card.id] !== card.answer);
    return { newSessions, newFindings, unreadDigest, recurring, changedAnswers };
  }, [digestReport, findings, questions, sessions, visit]);
  const previous = visit.lastVisitTs ? new Date(visit.lastVisitTs).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "前回の記録なし";
  const cards = [
    summary.recurring[0] ? { title: `同じ罠 ${summary.recurring[0].repeatCount}回目`, body: summary.recurring[0].text, action: onOpenLearning, label: "学びを見る" } : null,
    summary.changedAnswers[0] ? { title: "問いの答えが変わりました", body: `${summary.changedAnswers[0].question}: ${visit.lastAnswers[summary.changedAnswers[0].id]} → ${summary.changedAnswers[0].answer}`, action: onOpenQuestions, label: "問いを見る" } : null,
    summary.unreadDigest ? { title: "未読の日別まとめ", body: digestReport?.digest?.content.headline ?? "新しい日別まとめがあります。", action: onOpenDaily, label: "日別を見る" } : null,
  ].filter((card): card is { title: string; body: string; action: () => void; label: string } => Boolean(card)).slice(0, 3);
  return <div style={{ display: "flex", flexDirection: "column", gap: 12 }}><Section title="前回からの変化" subtitle={`${previous} から`}><div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontVariantNumeric: "tabular-nums" }}><span>新しいセッション <strong>{summary.newSessions}</strong></span><span>新しい発見 <strong>{summary.newFindings}</strong></span><span>未読の日別まとめ <strong>{summary.unreadDigest}</strong></span></div></Section>{cards.length > 0 ? <Section title="今日見る価値"><div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{cards.map((card) => <div key={card.title} style={{ border: "1px solid var(--cmux-border-hairline)", borderRadius: 6, background: "var(--cmux-hover)", padding: "9px 10px" }}><div style={{ fontWeight: 700 }}>{card.title}</div><div style={{ ...noteStyle, marginTop: 3 }}>{card.body}</div><button type="button" onClick={card.action} style={{ ...subtleButtonStyle, marginTop: 8 }}>{card.label}</button></div>)}</div></Section> : <Section title="今日見る価値"><div style={noteStyle}>{`前回から新しい記録はありません。取り込みは ${indexStatus?.lastFinishedAt ? new Date(indexStatus.lastFinishedAt).toLocaleString("ja-JP") : "未確認"} まで完了しています。`}</div></Section>}</div>;
});

ChangeView.displayName = "ChangeView";

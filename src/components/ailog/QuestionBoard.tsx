import { memo } from "react";
import type { EfficiencyReport } from "../../lib/ailog";
import { buildQuestionCards, type QuestionCardData } from "./questionModel";
import { EmptyState, Section, SkeletonBlock, noteStyle, subtleButtonStyle } from "./ui";

export const QuestionBoard = memo(function QuestionBoard({ report, loading, error, onOpenRecords }: { report: EfficiencyReport | null; loading: boolean; error: string | null; onOpenRecords: (card: QuestionCardData) => void }) {
  if (loading && !report) return <SkeletonBlock height={140} label="問いを読み込み中" />;
  if (error) return <EmptyState kind="error" message={error} />;
  if (!report) return <EmptyState kind="no-data" message="集計できる記録が増えると、ここで次の判断を比べられます。" />;
  return <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{buildQuestionCards(report).map((card) => <Section key={card.id} title={card.question} actions={<Answer answer={card.answer} />}><div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 9 }}><div style={noteStyle}>{card.evidence}</div><div style={{ fontSize: "var(--cmux-font-size-sm)", color: "var(--cmux-text-secondary)" }}>次の一手: {card.nextAction}</div><button type="button" onClick={() => onOpenRecords(card)} style={subtleButtonStyle}>該当セッションを見る</button></div></Section>)}</div>;
});

function Answer({ answer }: { answer: QuestionCardData["answer"] }) {
  const tone = answer === "得している" ? "var(--cmux-accent)" : answer === "損している" ? "var(--cmux-usage-warn)" : "var(--cmux-text-secondary)";
  return <strong style={{ color: tone, fontSize: "var(--cmux-font-size-sm)" }}>{answer}</strong>;
}

QuestionBoard.displayName = "QuestionBoard";

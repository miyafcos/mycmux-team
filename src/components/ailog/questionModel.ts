import type { EfficiencyReport, EfficiencyRow, QuantileRow } from "../../lib/ailog";

export type QuestionId = "subagent" | "effort" | "length" | "compaction" | "model";
export type QuestionAnswer = "得している" | "差がない" | "損している" | "まだ判断できない";
export type QuestionSort = "cost" | "rework" | "turns";

export interface QuestionCardData {
  id: QuestionId;
  question: string;
  answer: QuestionAnswer;
  evidence: string;
  nextAction: string;
  sort: QuestionSort;
  modelKey?: string;
}

const minimumSessions = 8;
const threshold = 0.15;

function pct(next: number, previous: number): number {
  if (previous === 0) return next === 0 ? 0 : (next > 0 ? Infinity : -Infinity);
  return (next - previous) / Math.abs(previous);
}

function pctText(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "増加" : "減少";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function score(value: number): string { return Number.isFinite(value) ? value.toFixed(2) : "—"; }
function cost(value: number): string { return Number.isFinite(value) ? `$${value.toFixed(2)}` : "—"; }

function insufficient(left: { sessions: number } | undefined, right: { sessions: number } | undefined): QuestionAnswer | null {
  return !left || !right || left.sessions < minimumSessions || right.sessions < minimumSessions ? "まだ判断できない" : null;
}

function missingEvidence(left: { sessions: number } | undefined, right: { sessions: number } | undefined): string {
  const leftSessions = left?.sessions ?? 0;
  const rightSessions = right?.sessions ?? 0;
  const needed = Math.max(0, minimumSessions - leftSessions) + Math.max(0, minimumSessions - rightSessions);
  return `あと ${needed} セッション必要 (今 ${leftSessions} / ${rightSessions})`;
}

function pairedAnswer(first: number, second: number, third: number, fourth: number): QuestionAnswer {
  const firstChange = pct(second, first);
  const secondChange = pct(fourth, third);
  if (firstChange <= -threshold && secondChange <= -threshold) return "得している";
  if (firstChange >= threshold && secondChange >= threshold) return "損している";
  return "差がない";
}

function row(rows: EfficiencyRow[] | undefined, key: string): EfficiencyRow | undefined { return rows?.find((item) => item.key === key); }
function quantile(rows: QuantileRow[] | undefined, first: boolean): QuantileRow | undefined { return first ? rows?.[0] : rows?.[rows.length - 1]; }

function effortRows(rows: EfficiencyRow[] | undefined): [EfficiencyRow | undefined, EfficiencyRow | undefined] {
  const ranks: Record<string, number> = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6 };
  const known = (rows ?? []).filter((item) => ranks[item.key.trim().toLowerCase()] !== undefined);
  if (known.length < 2) return [known[0], undefined];
  const ranked = [...known].sort((left, right) => ranks[left.key.trim().toLowerCase()] - ranks[right.key.trim().toLowerCase()] || left.key.localeCompare(right.key));
  return [ranked[0], ranked[ranked.length - 1]];
}

function effortAnswer(low: EfficiencyRow | undefined, high: EfficiencyRow | undefined): QuestionAnswer {
  if (insufficient(low, high)) return "まだ判断できない";
  const improvement = -pct(high!.avgRework, low!.avgRework);
  const costIncrease = pct(high!.avgSessionCost, low!.avgSessionCost);
  if (improvement >= threshold && improvement >= Math.max(0, costIncrease)) return "得している";
  if (pct(high!.avgRework, low!.avgRework) >= threshold && costIncrease >= threshold) return "損している";
  return "差がない";
}

function modelCard(rows: EfficiencyRow[] | undefined): QuestionCardData {
  const source = rows ?? [];
  const sufficient = source.filter((item) => item.sessions >= minimumSessions);
  if (sufficient.length < 2) {
    const highest = sufficient[0] ?? source.reduce<EfficiencyRow | undefined>((best, item) => !best || item.sessions > best.sessions ? item : best, undefined);
    const challenger = source.filter((item) => item.key !== highest?.key).sort((left, right) => right.sessions - left.sessions)[0];
    const challengerSessions = challenger?.sessions ?? 0;
    return { id: "model", question: "どのモデルが自分の仕事に合うか？", answer: "まだ判断できない", evidence: `あと ${Math.max(0, minimumSessions - challengerSessions)} セッション必要 (今 ${highest?.sessions ?? 0} / ${challengerSessions})`, nextAction: "手戻りが大きい記録を開いて確かめてください。", sort: "rework", modelKey: highest?.key };
  }
  const best = [...sufficient].sort((left, right) => left.avgRework - right.avgRework || right.sessions - left.sessions || left.key.localeCompare(right.key))[0]!;
  const runnerUp = [...sufficient].filter((item) => item.key !== best.key).sort((left, right) => left.avgRework - right.avgRework)[0];
  const difference = runnerUp ? pct(best.avgRework, runnerUp.avgRework) : 0;
  const answer: QuestionAnswer = runnerUp && difference <= -threshold ? "得している" : "差がない";
  return { id: "model", question: "どのモデルが自分の仕事に合うか？", answer, evidence: runnerUp ? `${best.key} 手戻り ${score(best.avgRework)} / ${runnerUp.key} ${score(runnerUp.avgRework)} (${pctText(difference)})` : `${best.key} の手戻り ${score(best.avgRework)} (今 ${best.sessions} セッション)`, nextAction: "このモデルの記録を開いて確かめてください。", sort: "rework", modelKey: best.key };
}

export function buildQuestionCards(report: EfficiencyReport): QuestionCardData[] {
  const main = row(report.bySubagent, "main"); const subagent = row(report.bySubagent, "subagent");
  const [lowEffort, highEffort] = effortRows(report.byEffort);
  const shortest = quantile(report.turnQuantiles, true); const longest = quantile(report.turnQuantiles, false);
  const withoutCompact = row(report.byCompaction, "not-compacted"); const compacted = row(report.byCompaction, "compacted");
  return [
    { id: "subagent", question: "人に任せると得か？", answer: insufficient(main, subagent) ?? pairedAnswer(main!.avgRework, subagent!.avgRework, main!.avgSessionCost, subagent!.avgSessionCost), evidence: insufficient(main, subagent) ? missingEvidence(main, subagent) : `手戻り ${score(main!.avgRework)} → ${score(subagent!.avgRework)} (${pctText(pct(subagent!.avgRework, main!.avgRework))}) / コスト ${cost(main!.avgSessionCost)} → ${cost(subagent!.avgSessionCost)} (${pctText(pct(subagent!.avgSessionCost, main!.avgSessionCost))})`, nextAction: "手戻りが大きい記録を開いて確かめてください。", sort: "rework" },
    { id: "effort", question: "effort を上げる価値はあるか？", answer: effortAnswer(lowEffort, highEffort), evidence: insufficient(lowEffort, highEffort) ? missingEvidence(lowEffort, highEffort) : `手戻り ${score(lowEffort!.avgRework)} → ${score(highEffort!.avgRework)} (${pctText(pct(highEffort!.avgRework, lowEffort!.avgRework))}) / コスト ${cost(lowEffort!.avgSessionCost)} → ${cost(highEffort!.avgSessionCost)} (${pctText(pct(highEffort!.avgSessionCost, lowEffort!.avgSessionCost))})`, nextAction: "手戻りが大きい記録を開いて確かめてください。", sort: "rework" },
    { id: "length", question: "長いセッションは損か？", answer: insufficient(shortest, longest) ?? pairedAnswer(shortest!.avgRework, longest!.avgRework, shortest!.avgCost, longest!.avgCost), evidence: insufficient(shortest, longest) ? missingEvidence(shortest, longest) : `手戻り ${score(shortest!.avgRework)} → ${score(longest!.avgRework)} (${pctText(pct(longest!.avgRework, shortest!.avgRework))}) / コスト ${cost(shortest!.avgCost)} → ${cost(longest!.avgCost)} (${pctText(pct(longest!.avgCost, shortest!.avgCost))})`, nextAction: "長い記録を開いて確かめてください。", sort: "turns" },
    { id: "compaction", question: "compact まで粘るのは損か？", answer: insufficient(withoutCompact, compacted) ?? pairedAnswer(withoutCompact!.avgRework, compacted!.avgRework, withoutCompact!.abandonedRate, compacted!.abandonedRate), evidence: insufficient(withoutCompact, compacted) ? missingEvidence(withoutCompact, compacted) : `手戻り ${score(withoutCompact!.avgRework)} → ${score(compacted!.avgRework)} (${pctText(pct(compacted!.avgRework, withoutCompact!.avgRework))}) / 中断率 ${(withoutCompact!.abandonedRate * 100).toFixed(1)}% → ${(compacted!.abandonedRate * 100).toFixed(1)}% (${pctText(pct(compacted!.abandonedRate, withoutCompact!.abandonedRate))})`, nextAction: "手戻りが大きい記録を開いて確かめてください。", sort: "rework" },
    modelCard(report.byModel),
  ];
}

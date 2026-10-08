import type { SkillRow, SkillUsageRecord } from "../../lib/skillsApi";
import { dateTime } from "../agentDesign/presentation";
export function skillFileInfo(row: SkillRow) {
  const place = row.places?.find(value => value.path === row.docPath) ?? row.places?.[0];
  // Legacy rows use zero for missing metadata; a measured place preserves zero.
  return { size: { chars: place?.chars ?? null, lines: place?.lines ?? null,
    bytes: place ? place.bytes : row.docPath && (row.fileSize > 0 || row.modifiedAt > 0) ? row.fileSize : null },
    modifiedAt: place ? place.modifiedAt : row.modifiedAt > 0 ? row.modifiedAt : null };
}
export function skillRecord(row: SkillRow, service: "claude" | "codex"): SkillUsageRecord {
  return row.usageRecords?.[service] ?? { status: service === "codex" && row.codexRecorded ? "available" : "unavailable", count: service === "codex" && row.codexRecorded ? row.usage.codex : null, lastAt: null, source: service === "claude" ? "skillUsage" : "usage_codex.json", ...(service === "codex" ? { days: 90 } : {}) };
}
export function usageText(row: SkillRow, service: "claude" | "codex") {
  const record = skillRecord(row, service);
  if (record.status !== "available") return record.status === "failed" ? "集計に失敗" : "記録は未取得";
  return record.count === 0 ? "記録なし（0）" : record.count + (service === "claude" ? " 回の呼び出し" : " 会話");
}
export function SkillRecords({ row }: { row: SkillRow }) {
  return <section className="skills-records"><h3>使われた記録</h3><div>{(["claude", "codex"] as const).map(service => { const record = skillRecord(row, service); return <article key={service}><strong>{service === "claude" ? "Claude Code の呼び出し" : "Codex の会話数"}</strong><p>{usageText(row, service)}</p><p>最後の記録 {record.lastAt ? dateTime(record.lastAt) : "日時は未取得"}</p><small>出所 {record.source} · {service === "codex" ? "更新された会話の直近 " + (record.days ?? 90) + " 日。同じ会話は1件。時刻は会話の最終更新です。" : "集計の開始日と網羅性は未確認です。"}</small></article>; })}</div><p>記録なしは未使用の証明ではありません。今回の本文読取・実行・成功、個別の最近の履歴は未収集です。</p>{row.usageRecords && <small>取得日時 {dateTime(row.usageRecords.sampledAt)}</small>}</section>;
}

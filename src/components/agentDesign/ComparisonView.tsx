import { ArrowLeft } from "lucide-react";
import type { AgentDesignApi, AgentDesignCatalog, DesignService } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, chars, number, bytes } from "./agentDesignStrings";
import { Links, ServiceMark } from "./ui";
import { ItemList } from "./Information";
import { dateTime } from "./presentation";
export const compareKinds = ["instruction", "folderInstruction", "rule", "settings", "permissionRules", "memoryIndex", "skill", "skillListing", "plugins", "agent", "mcp", "hooks", "scheduled", "reference"];
export function compareItems(catalog: AgentDesignCatalog, service: DesignService, row: number) {
  const root = service.root.replace(/\\/g, "/").toLowerCase();
  return catalog.items.filter(i => i.service === service.id && (row === 0 ? i.kind === "instruction" && i.path?.replace(/\\/g, "/").toLowerCase().startsWith(root + "/")
    : row === 1 ? ["instruction", "override", "shadowedInstruction"].includes(i.kind) && !i.path?.replace(/\\/g, "/").toLowerCase().startsWith(root + "/")
    : row === 4 ? i.kind === (service.id === "claude" ? "settings" : "permissionRules")
    : i.kind === compareKinds[row]));
}
function summary(catalog: AgentDesignCatalog, a: DesignService, row: number): [string, string] {
  if (a.state === "absent") return [s.absent, a.root];
  const st = a.stats; const docs = compareItems(catalog, a, row);
  const name = docs.map(i => i.displayName).slice(0, 2).join(" · ") || "対象の文書は未取得";
  const metric = (label: string, value: number | null | undefined, unit = "件") => value == null ? "" : label + " " + number(value) + " " + unit;
  const joined = (...values: string[]) => values.filter(Boolean).join(" · ");
  const quantity = (key: string, unit = "件") => st[key] == null ? name : number(st[key]) + " " + unit;
  if (a.id === "hermes") return [row === 6 ? quantity("skillsOwn", "本") : docs.some(i => i.active) ? name : docs.length ? s.absent : "対象は未取得", docs[0]?.path ?? "名前と置き場所の確認まで"];
  if (row <= 1) {
    const active = docs.filter(i => i.active); const amount = active.length && active.every(i => i.size.chars != null) ? active.reduce((sum, i) => sum + i.size.chars!, 0) : null;
    return [name, joined(amount == null ? "" : chars(amount), ...[...new Set(docs.map(i => s.timings[i.readTiming]))], docs.some(i => i.kind === "override") ? s.overridden : "")];
  }
  if (row === 2) return a.id === "claude" ? [quantity("rules", "本"), joined(metric("毎回", st.rulesAlways, "本"), metric("条件つき", st.rulesConditional, "本"))] : ["個別のルールは対象外", "作業方針は AGENTS.md で確認"];
  if (row === 3) return [name, a.settings.filter(f => ["model", "effortLevel", "model_reasoning_effort"].includes(f.key)).map(f => f.value).join(" · ")];
  if (row === 4) return a.id === "claude" ? [joined(metric("許可する操作（共通）", st.allow), metric("許可する操作（作業場所）", st.allowLocal)) || name, a.settings.find(f => f.key === "defaultMode")?.value ?? "適用された許可の形は未取得"]
    : [st.rulesBytes == null ? name : "default.rules " + bytes(st.rulesBytes), a.settings.filter(f => ["approval_policy", "sandbox_mode"].includes(f.key)).map(f => f.value).join(" · ")];
  if (row === 5) return [quantity("memoryFiles", "ファイル"), joined(a.context.memory == null ? "" : chars(a.context.memory), "索引を毎回、本文は必要時")];
  if (row === 6) return [a.id === "claude" ? quantity("skillsOwn", "本") : joined(metric(".codex", st.skillsCodex, "本"), metric(".agents", st.skillsAgents, "本")) || name, "本文は呼ばれたときだけ"];
  if (row === 7) return [a.session.listing.count == null ? "初期の一覧は未取得" : number(a.session.listing.count) + " 本", joined(a.session.listing.chars == null ? "" : chars(a.session.listing.chars), "初期一覧の名前と説明")];
  if (row === 8) return [quantity("plugins"), joined(metric("有効", st.pluginsEnabled), Object.keys(a.session.listing.disabledCounts).length ? s.damaged : "")];
  if (row === 9) return [quantity("agents", "担当"), "担当を呼んだときに読む"];
  if (row === 10) return [a.id === "claude" ? joined(metric("共通", st.mcpUser, "接続"), metric("作業場所", st.mcpProject, "接続")) || name : quantity("mcp", "接続"), a.id === "codex" ? metric(s.mcpCommented, st.mcpCommented, "接続") : "登録された接続数。使用回数は未収集"];
  if (row === 11) return [joined(metric("出来事", st.hookEvents, "種類"), metric("登録", st.hookHandlers, "処理")) || name, "出来事に合わせて処理。実行回数は未収集"];
  if (row === 12) return [quantity("scheduledJobs", "処理"), joined(metric("有効", st.scheduledEnabled, "処理"), "決まった時刻で動く")];
  return [quantity("references", "文書"), "必要なときに資料を開く"];
}
export function ComparisonView({ catalog, query, selectedRow, setSelectedRow, opened, setOpened, onSkill, onOpen }: {
  catalog: AgentDesignCatalog; api: AgentDesignApi; query: string; selectedRow: number; setSelectedRow: (r: number) => void; opened: boolean; setOpened: (b: boolean) => void; onSkill: (id?: string) => void; onOpen: (id: string, line?: number) => void;
}) {
  const services = catalog.services;
  const tag = (row: number) => row === 8 && Object.keys((services.find(a => a.id === "codex") ?? services[0]).session.listing.disabledCounts).length ? s.damaged : row === 2 ? s.claudeOnly : [1, 4, 6].includes(row) ? s.differentForm : [9, 10, 11, 12, 13].includes(row) ? s.differentCount : s.sameRole;
  const rows = s.compareRows.map((label, row) => ({ label, row })).filter(({ label, row }) => !query || (label + services.map(a => summary(catalog, a, row).join(" ")).join(" ")).toLowerCase().includes(query.toLowerCase()));
  return <main className="ad-compare ad-main" data-ad-view="compare">
    <p className="ad-intro">{s.compareHelp}</p><div className="ad-compare-scope">{services.map(a => <section key={a.id}><strong>{a.displayName}</strong><p>{a.id === "hermes" ? "目録は名前と置き場所。本文は押して取得でき、利用の記録は未収集。" : "現在の設定・登録と、採用した会話の初期記録。今回の本文読取は未収集。"}</p><small>目録 {dateTime(catalog.generatedAt)} · 会話 {dateTime(a.session.startedAt)}</small><code className="ad-path">{a.session.file ?? a.root}</code></section>)}</div>
    {opened ? <><button className="ad-back" onClick={() => setOpened(false)}><ArrowLeft size={13} />{s.back}</button><h2>{s.compareRows[selectedRow]}</h2>
      <div className="ad-compare-documents">{services.map(a => <section key={a.id}><h3><ServiceMark id={a.id} />{a.displayName}</h3>
        <ItemList items={compareItems(catalog, a, selectedRow)} catalog={catalog} onOpen={onOpen} onSkill={onSkill} /></section>)}</div></>
      : <table className="ad-compare-table" tabIndex={0} aria-label={s.compareTitle}><colgroup><col style={{ width: "14%" }} /><col style={{ width: "29%" }} /><col style={{ width: "29%" }} /><col style={{ width: "17%" }} /><col style={{ width: "11%" }} /></colgroup>
        <thead><tr><th>{s.sameRole}</th>{services.map(a => <th key={a.id}><ServiceMark id={a.id} />{a.displayName}</th>)}<th>{s.compareTag}</th></tr></thead>
        <tbody>{rows.map(({ label, row }) => <tr key={row} tabIndex={-1} data-ad-compare-row={row} aria-selected={row === selectedRow} className={row === selectedRow ? "selected" : ""} onClick={() => { setSelectedRow(row); setOpened(true); }}>
          <th scope="row"><button onClick={() => { setSelectedRow(row); setOpened(true); }}>{label} →</button></th>{services.map(a => { const values = summary(catalog, a, row); return <td key={a.id}><button className="ad-cell-open" aria-label={a.displayName + "の" + label + "を確認"} onClick={() => { setSelectedRow(row); setOpened(true); }}><strong>{values[0]}</strong><small>{values[1]}</small></button></td>; })}<td><span className={"ad-compare-tag" + (tag(row) === s.damaged ? " damaged" : "")}>{tag(row)}</span></td></tr>)}</tbody>
      </table>}
    <h3>{s.crossLinks}</h3><Links onOpen={onOpen} catalog={catalog} links={catalog.links.filter(l => l.sourceService !== l.targetService)} />
  </main>;
}

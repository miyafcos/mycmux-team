import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillCatalog } from "../../lib/skillsApi";
import { skillsApi } from "../../lib/skillsApi";
import type { SkillsViewProps } from "./SkillsView";
import { SkillDetail } from "./SkillDetail";
import { skillFileInfo, skillRecord, usageText } from "./SkillRecords";
import { dateTime } from "../agentDesign/presentation";
import { skillsStrings as s } from "./skillsStrings";
import { bytes } from "../agentDesign/agentDesignStrings";

export function SkillsExplorer({ initialSkillId = null, onClose, api = skillsApi, initialCatalog }: SkillsViewProps) {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(() => initialCatalog ?? api.peek()); const [query, setQuery] = useState(""); const [category, setCategory] = useState("all"); const [service, setService] = useState("all"); const [sort, setSort] = useState("name"); const [selected, setSelected] = useState<string | null>(initialSkillId); const [tab, setTab] = useState("content"); const [expanded, setExpanded] = useState(false); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const epoch = useRef(0); const search = useRef<HTMLInputElement>(null);
  const refresh = async () => { const token = epoch.current; setBusy(true); try { const value = await api.refresh(); if (token === epoch.current) setCatalog(value); } catch { if (token === epoch.current) setNotice("スキルの目録を取得できませんでした。読み直して再確認してください。"); } finally { if (token === epoch.current) setBusy(false); } };
  useEffect(() => { const token = ++epoch.current; let fresh = false; void api.cached().then(value => { if (token === epoch.current && value && !fresh) setCatalog(value); }).catch(() => { if (token === epoch.current) setNotice("保存された目録を取得できませんでした。"); }); setBusy(true); void api.refresh().then(value => { fresh = true; if (token === epoch.current) setCatalog(value); }).catch(() => { if (token === epoch.current) setNotice("スキルの目録を取得できませんでした。"); }).finally(() => { if (token === epoch.current) setBusy(false); }); return () => { epoch.current++; }; }, [api]);
  useEffect(() => { if (initialSkillId) { setSelected(initialSkillId); setTab("content"); } }, [initialSkillId]);
  const rows = useMemo(() => {
    const term = query.toLowerCase();
    return [...(catalog?.skills ?? [])].filter(row => (category === "all" || row.category === category) && (service === "all" || row.agents.includes(service)) && (!term || [row.id, row.label, row.description, ...Object.values(row.calls), row.body].some(value => value.toLowerCase().includes(term)))).sort((a, b) => {
      if (sort === "updated") return b.modifiedAt - a.modifiedAt;
      if (sort === "size") return b.fileSize - a.fileSize;
      if (sort === "claude" || sort === "codex") return (skillRecord(b, sort).count ?? -1) - (skillRecord(a, sort).count ?? -1) || a.label.localeCompare(b.label);
      return a.label.localeCompare(b.label, "ja");
    });
  }, [catalog, category, service, sort, query]);
  const row = catalog?.skills.find(value => value.id.toLowerCase() === selected?.toLowerCase());
  return <div className="skills-panel skills-explorer" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (selected) setSelected(null); else if (query) setQuery(""); else onClose(); } else if (event.key === "Enter" && event.ctrlKey) { event.preventDefault(); event.stopPropagation(); setNotice(s.readOnly); } else if (event.key === "/" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); event.stopPropagation(); search.current?.focus(); } }}>
    <header className="skills-header"><strong>スキルの棚</strong><small>{catalog?.skills.length ?? 0} 本 · 取得 {dateTime(catalog?.generatedAt)}</small><div className="skills-header-spacer" /><button disabled={busy} onClick={() => void refresh()}>{busy ? "読み直し中" : "読み直す"}</button><button aria-label={s.close} onClick={onClose}>閉じる</button></header>
    {notice && <p className="skills-notice" role="status">{notice}</p>}
    <section className="skills-explorer-list" hidden={Boolean(row)}><nav className="skills-shelves" aria-label="スキルの棚"><button aria-pressed={category === "all"} onClick={() => setCategory("all")}>全ての棚 {catalog?.skills.length ?? 0}</button>{catalog?.categories.map(value => <button key={value.id} aria-pressed={category === value.id} onClick={() => setCategory(value.id)}>{value.name} {catalog.skills.filter(skill => skill.category === value.id).length}</button>)}</nav>
      <div className="skills-list-toolbar"><label>探す <input ref={search} aria-label="スキルを探す" placeholder="名前・説明・呼ぶ言葉" value={query} onChange={e => setQuery(e.target.value)} /></label><label>サービス <select aria-label="サービスで絞る" value={service} onChange={e => setService(e.target.value)}><option value="all">全サービス</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label>並び <select aria-label="スキルの並び順" value={sort} onChange={e => setSort(e.target.value)}><option value="name">名前順</option><option value="claude">Claude 呼び出し数順</option><option value="codex">Codex 会話数順</option><option value="updated">更新日順</option><option value="size">大きさ順</option></select></label><strong>{rows.length} 本</strong></div>
      <p>スキルは AI に作業の進め方を教える文書です。検索は名前・説明・呼ぶ言葉と取得済みの本文だけが対象です。未取得の本文は検索していません。目録に本文のある検索対象は {catalog?.skills.filter(value => value.body).length ?? 0} 本です。</p>
      <table className="skills-dense-table" role="listbox" aria-label="スキル一覧"><thead><tr><th>名前・役割</th><th>サービス・呼ぶ言葉</th><th>量・更新日</th><th>読む時機</th><th>Claude 呼び出し数</th><th>Codex 会話数</th><th>本文</th></tr></thead><tbody>{rows.map(value => <tr key={value.id} role="option" aria-selected={selected === value.id}><th><button className="skills-row" onClick={() => { setSelected(value.id); setTab("content"); }}>{value.label}<small>{value.id}</small></button><p>{value.line || "手順の文書。本文を開いて内容を確認できます。"}</p></th><td>{value.agents.join(" · ")}<code>{Object.values(value.calls).join(" · ")}</code></td><td>{bytes(skillFileInfo(value).size.bytes)}<small>{dateTime(skillFileInfo(value).modifiedAt)}</small>{value.places?.[0]?.chars != null && <small>{value.places[0].chars.toLocaleString("ja-JP")} 字</small>}</td><td>説明は初期一覧<small>本文は呼ばれたときだけ</small></td><td>{usageText(value, "claude")}<small>{skillRecord(value, "claude").lastAt ? dateTime(skillRecord(value, "claude").lastAt) : "最後の日時は未取得"}</small></td><td>{usageText(value, "codex")}<small>直近 90 日の会話</small></td><td><button onClick={() => { setSelected(value.id); setTab("content"); }}>スキルのページ →</button></td></tr>)}</tbody></table>
      {!rows.length && <p>{busy ? "スキルを取得中" : "条件に合うスキルがありません。"}</p>}<p>二つのサービスは集計の単位が異なります。記録なしは未使用を意味しません。本文読取・実行・成功の記録は未収集です。</p>
    </section>{selected && !row && <p role="status">指定したスキルはこの目録にありません。<button onClick={() => setSelected(null)}>棚へ戻る</button></p>}
    {row && <section className="skills-detail skills-full-page"><nav className="skills-breadcrumb"><button onClick={() => setSelected(null)}>スキルの棚へ戻る</button><span> › {row.label}</span></nav><SkillDetail key={row.id + ":" + row.modifiedAt + ":" + catalog?.generatedAt} readOnly row={row} category={catalog?.categories.find(value => value.id === row.category)} api={api} tab={tab} setTab={setTab} expanded={expanded} setExpanded={setExpanded} query={query} snippet="" notify={setNotice} close={onClose} /></section>}
  </div>;
}

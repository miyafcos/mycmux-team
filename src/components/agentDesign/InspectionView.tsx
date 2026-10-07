import { useState } from "react";
import { CircleAlert, CircleHelp, Eye, Check, FolderOpen } from "lucide-react";
import type { AgentDesignApi, AgentDesignCatalog, DesignFinding } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, number, chars } from "./agentDesignStrings";
import { Fields, ServiceMark } from "./ui";
export function visibleFindings(catalog: AgentDesignCatalog, query: string) { return catalog.findings.filter(f => !query || (s.findingTitles[f.kind] + " " + f.names.join(" ") + " " + f.service).toLowerCase().includes(query.toLowerCase())); }
export function InspectionView({ catalog, api, query, selectedId, setSelectedId, update, notify, openItem, onSkill }: {
  catalog: AgentDesignCatalog; api: AgentDesignApi; query: string; selectedId: string | null; setSelectedId: (id: string) => void; update: (c: AgentDesignCatalog) => void;
  notify: (n: string) => void; openItem: (id: string) => void; onSkill: (id?: string) => void;
}) {
  const [closing, setClosing] = useState<string | null>(null); const [reason, setReason] = useState(""); const [saving, setSaving] = useState(false); const [candidates, setCandidates] = useState<string[]>([]);
  const findings = visibleFindings(catalog, query); const selected = findings.find(f => f.id === selectedId) ?? findings[0];
  const begin = (f: DesignFinding) => { setSelectedId(f.id); setClosing(f.id); setReason(""); };
  const close = async () => {
    if (!closing || !reason.trim()) return;
    setSaving(true);
    try { update(await api.close(closing, reason, catalog.cwd)); setClosing(null); notify(s.closed); }
    catch { notify(s.closeError); } finally { setSaving(false); }
  };
  return <div className="ad-split ad-inspection" data-ad-view="inspection"><main className="ad-main"><p className="ad-intro">{s.inspectHelp}</p>
    <div className="ad-inspect-counts">{["repair", "decide", "watch"].map(level => <span key={level} className="ad-chip">{s[level as "repair" | "decide" | "watch"]} {number(findings.filter(f => f.severity === level).length)}</span>)}<span className="ad-muted">{s.closedCount} {number(catalog.closedCount)}</span></div>
    <div className="ad-findings" role="listbox" aria-label={s.inspectTitle} tabIndex={0}>{findings.map(f => {
      const Icon = f.severity === "repair" ? CircleAlert : f.severity === "decide" ? CircleHelp : Eye;
      return <article key={f.id} data-ad-finding={f.id} role="option" aria-selected={selected?.id === f.id} tabIndex={-1} className={"ad-finding " + f.severity + (selected?.id === f.id ? " selected" : "")} onClick={() => setSelectedId(f.id)}>
        <Icon size={18} /><div><strong>{s.findingTitles[f.kind] ?? s.unsupported}</strong><p>{number(f.count)} / {chars(f.chars)}{f.names.length > 0 && " / " + f.names.slice(0, 3).join(" · ")}</p>
          <span className={"ad-severity " + f.severity}>{s[f.severity as "repair" | "decide" | "watch"]}</span><span className="ad-chip"><ServiceMark id={f.service} size={12} />{f.service} / {s.layerNames[f.layer]}</span></div>
        <div className="ad-finding-actions"><button onClick={event => { event.stopPropagation(); setSelectedId(f.id); notify(s.stageC); }}>{s.proposal}</button><button onClick={event => { event.stopPropagation(); begin(f); }}><Check size={12} />{s.closeIntentional}</button></div>
      </article>;
    })}{!findings.length && <div className="ad-empty"><Check size={28} /><p>{s.noFindings}</p></div>}</div>
  </main><aside className="ad-detail">{selected ? <><h2>{s.findingTitles[selected.kind] ?? s.unsupported}</h2><p className="ad-muted"><ServiceMark id={selected.service} /> {number(selected.count)} / {chars(selected.chars)}</p>
    <h3>{s.evidenceFiles}</h3><div className="ad-evidence">{selected.evidence.map((e, index) => <article key={index}><strong>{s.ruleNames[e.rule] ?? s.source}</strong>
      {e.path && <code className="ad-path">{e.path}{e.line != null && ":" + e.line}</code>}{e.record && <code className="ad-path">{e.record}</code>}<Fields fields={e.fields} /></article>)}</div>
    <h3>{s.unknowns}</h3>{selected.unknowns.length ? selected.unknowns.map(code => <p key={code}>{s.uncertaintyNames[code] ?? s.unknown}</p>) : <p className="ad-muted">{s.noUncertainty}</p>}
    <h3>{s.proposalText}</h3><p>{s.proposals[selected.proposal] ?? s.stageC}</p>
    <div className="ad-actions"><button className="primary" onClick={() => notify(s.stageC)}>{s.proposal}</button><button onClick={() => { if (selected.itemIds[0]) openItem(selected.itemIds[0]); else onSkill(selected.names[0]); }}><FolderOpen size={13} />{s.open}</button><button onClick={() => begin(selected)}>{s.closeIntentional}</button></div>
    {selected.kind === "unusedListing" && <section className="ad-candidates"><h3>{s.candidateSkills}</h3><p>{s.selectedCandidates} {number(candidates.length)}</p><div>{selected.names.map(name => <label key={name}><input type="checkbox" checked={candidates.includes(name)} onChange={event => setCandidates(previous => event.target.checked ? [...previous, name] : previous.filter(n => n !== name))} /><code>{name}</code><button onClick={() => onSkill(name)}>{s.open}</button></label>)}</div></section>}
    {closing === selected.id && <form className="ad-close-form" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setClosing(null); } }} onSubmit={event => { event.preventDefault(); void close(); }}><label>{s.reason}<textarea autoFocus aria-label={s.reason} value={reason} onChange={event => setReason(event.target.value)} placeholder={s.reasonPlaceholder} maxLength={1000} /></label>
      <button type="submit" disabled={saving || !reason.trim()}>{s.saveClose}</button><button type="button" onClick={() => setClosing(null)}>{s.cancel}</button></form>}
  </> : <p className="ad-muted">{s.noFindings}</p>}</aside></div>;
}

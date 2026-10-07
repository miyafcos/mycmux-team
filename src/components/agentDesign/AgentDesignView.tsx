import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X, RefreshCw, Folder, Monitor, ArrowLeft } from "lucide-react";
import { open as chooseDirectory } from "@tauri-apps/plugin-dialog";
import { SkillsIcon } from "../icons/ChromeIcons";
import { SkillsView } from "../skills/SkillsView";
import { agentDesignApi, type AgentDesignApi, type AgentDesignCatalog, type AgentServiceId } from "../../lib/agentDesignApi";
import type { skillsApi } from "../../lib/skillsApi";
import { agentDesignStrings as s, chars, number } from "./agentDesignStrings";
import { ServiceMark } from "./ui";
import { Overview, matchesItem } from "./Overview";
import { ReadingView } from "./ReadingView";
import { ComparisonView } from "./ComparisonView";
import { InspectionView, visibleFindings } from "./InspectionView";
import { createReadOnlySkillsApi } from "./readOnlySkillsApi";
import "./agentDesign.css";
export interface AgentDesignViewProps { onClose: () => void; api?: AgentDesignApi; initialCatalog?: AgentDesignCatalog; initialCwd?: string | null; skillApi?: typeof skillsApi }
export function AgentDesignView({ onClose, api = agentDesignApi, initialCatalog, initialCwd = null, skillApi }: AgentDesignViewProps) {
  const [cwd, setCwd] = useState<string | null>(initialCwd);
  const [catalog, setCatalog] = useState<AgentDesignCatalog | null>(() => initialCatalog ?? api.peek(initialCwd));
  const [serviceId, setServiceId] = useState<AgentServiceId>("claude"); const [view, setView] = useState(0); const [layer, setLayer] = useState(3);
  const [query, setQuery] = useState(""); const [selected, setSelected] = useState<string | null>(null); const [compareRow, setCompareRow] = useState(0); const [compareOpen, setCompareOpen] = useState(false);
  const [findingId, setFindingId] = useState<string | null>(null); const [embedded, setEmbedded] = useState(false); const [skillId, setSkillId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const alive = useRef(0); const search = useRef<HTMLInputElement>(null); const surface = useRef<HTMLDivElement>(null); const flowIndex = useRef(0);
  const currentFolder = useRef(cwd); currentFolder.current = catalog?.cwd ?? cwd;
  const embeddedApi = useRef<typeof skillsApi | null>(null);
  if (!embeddedApi.current) embeddedApi.current = skillApi ?? createReadOnlySkillsApi(() => currentFolder.current);
  useEffect(() => {
    const token = ++alive.current; let fresh = false;
    setBusy(true); setSelected(null); setCompareOpen(false); setEmbedded(false);
    const snapshot = api.peek(cwd); if (snapshot) setCatalog(snapshot); else if (cwd !== initialCwd) setCatalog(null);
    void api.cached(cwd).then(data => { if (data && !fresh && token === alive.current) setCatalog(data); }).catch(() => { if (token === alive.current) setNotice(s.cacheError); });
    void api.refresh(cwd).then(data => { fresh = true; if (token === alive.current) setCatalog(data); }).catch(() => { if (token === alive.current) setNotice(s.error); }).finally(() => { if (token === alive.current) setBusy(false); });
    return () => { alive.current++; };
  }, [api, cwd, initialCwd]);
  const refresh = async () => {
    const token = alive.current; setBusy(true);
    try { const data = await api.refresh(cwd); if (token === alive.current) { setCatalog(data); setNotice(s.refreshed); } }
    catch { if (token === alive.current) setNotice(s.error); } finally { if (token === alive.current) setBusy(false); }
  };
  const chooseFolder = async (hermes = false) => {
    try {
      const path = await chooseDirectory({ directory: true, multiple: false, defaultPath: catalog?.cwd, title: hermes ? s.hermesLocation : s.chooseFolder });
      if (typeof path !== "string") return;
      if (hermes) { await api.setHermesHome(path); await refresh(); } else setCwd(path);
    } catch { setNotice(s.error); }
  };
  const openSkill = useCallback((id?: string) => { setSkillId(id ?? null); setEmbedded(true); }, []);
  const service = catalog?.services.find(a => a.id === serviceId) ?? catalog?.services[0];
  const switchView = (next: number) => { setView(next); setEmbedded(false); setSelected(null); setCompareOpen(false); };
  const keyboard = (event: React.KeyboardEvent) => {
    const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (embedded) { setEmbedded(false); return; }
      if (selected) { setSelected(null); return; }
      if (compareOpen) { setCompareOpen(false); return; }
      if (query) { setQuery(""); return; }
      onClose(); return;
    }
    if (embedded) return;
    if (event.key === "/" && !editing) { event.preventDefault(); search.current?.focus(); return; }
    if (editing) return;
    if (/^[1-4]$/.test(event.key)) { event.preventDefault(); switchView(Number(event.key) - 1); return; }
    if (!catalog || !service) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); const step = event.key === "ArrowDown" ? 1 : -1;
      if (view === 0) {
        const layers = [7, 6, 5, 4, 3, 2, 1].filter(n => !query || s.layerNames[n].includes(query) || catalog.items.some(i => i.service === service.id && i.layer === n && matchesItem(i, query)));
        const n = layers[Math.max(0, Math.min(layers.length - 1, layers.indexOf(layer) + step))];
        if (n) { setLayer(n); setSelected(null); surface.current?.querySelector<HTMLElement>('[data-ad-layer="' + n + '"]')?.focus(); }
      } else if (view === 1) {
        const rows = surface.current?.querySelectorAll<HTMLElement>(".ad-flow-card"); if (rows?.length) { flowIndex.current = Math.max(0, Math.min(rows.length - 1, flowIndex.current + step)); rows[flowIndex.current].focus(); }
      } else if (view === 2) { const rows = Array.from(surface.current?.querySelectorAll<HTMLElement>("[data-ad-compare-row]") ?? []); const at = rows.findIndex(row => Number(row.dataset.adCompareRow) === compareRow); const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))]; if (next) { setCompareRow(Number(next.dataset.adCompareRow)); next.focus(); } }
      else {
        const rows = visibleFindings(catalog, query); const index = Math.max(0, rows.findIndex(f => f.id === findingId));
        const row = rows[Math.max(0, Math.min(rows.length - 1, index + step))]; if (row) { setFindingId(row.id); surface.current?.querySelector<HTMLElement>('[data-ad-finding="' + row.id + '"]')?.focus(); }
      }
    } else if (event.key === "Enter" && (event.target === surface.current || (event.target instanceof HTMLElement && event.target.matches('[role="option"],[role="listbox"],tr,.ad-flow-card')))) {
      event.preventDefault();
      if (view === 0) setSelected(catalog.items.find(i => i.service === service.id && i.layer === layer && i.active && matchesItem(i, query))?.id ?? null);
      else if (view === 1) { setLayer([2, 3, 4, 5, 6, 6, 6, 3, 5, 7, 6, 6][flowIndex.current]); switchView(0); }
      else if (view === 2) setCompareOpen(true);
      else { const f = visibleFindings(catalog, query).find(f => f.id === findingId) ?? visibleFindings(catalog, query)[0]; if (f?.itemIds[0]) { setLayer(f.layer); setServiceId(f.service); setSelected(f.itemIds[0]); setView(0); } }
    }
  };
  const openItem = (id: string) => { const item = catalog?.items.find(i => i.id === id); if (item) { setLayer(item.layer); setServiceId(item.service); setView(0); setSelected(id); } };
  return <div className="ad-view" ref={surface} onKeyDown={keyboard} tabIndex={-1}>
    <header className="ad-header"><SkillsIcon size={20} /><div className="ad-brand"><strong>{s.title}</strong><small>{catalog?.services.filter(a => a.version).map(a => a.displayName + " " + a.version).join(" · ") || s.version + " " + s.unknown}{catalog && " · " + s.updatedAt + " " + new Date(catalog.generatedAt).toLocaleTimeString("ja-JP")}{busy && " · " + s.updating}</small></div>
      <nav className="ad-tabs" aria-label={s.title}>{s.views.map((label, index) => <button key={label} aria-pressed={view === index} className={view === index ? "active" : ""} onClick={() => switchView(index)}>{label}{index === 3 && catalog && <small>{catalog.findings.length}</small>}</button>)}</nav>
      <label className="ad-search"><Search size={15} /><input ref={search} aria-label={s.search} placeholder={s.searchPlaceholder} value={query} onChange={event => setQuery(event.target.value)} /><kbd>/</kbd></label>
      <button aria-label={s.refresh} title={s.refresh} onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} className={busy ? "ad-spinning" : ""} /></button><button aria-label={s.close} title={s.close} onClick={onClose}><X size={16} /></button>
    </header>
    {(notice || catalog?.warnings.length) ? <div className="ad-notice" role="status">{notice || s.countError}<button aria-label={s.dismiss} onClick={() => setNotice("")}><X size={13} /></button></div> : null}
    <div className="ad-body"><nav className="ad-rail" aria-label={s.services}><h3>{s.services}</h3>
      {(["claude", "codex", "hermes"] as const).map(id => { const a = catalog?.services.find(a => a.id === id); return <button key={id} aria-pressed={serviceId === id} className={"ad-service" + (serviceId === id ? " selected" : "")} onClick={() => { setServiceId(id); setSelected(null); }}><span><ServiceMark id={id} /><strong>{a?.displayName ?? (id === "claude" ? "Claude Code" : id === "codex" ? "Codex" : "Hermes")}</strong></span><small>{a?.state === "absent" ? s.absent : id === "hermes" ? s.hermesScope : s.everyRead + " " + chars(a?.context.total)}</small><small>{s.groupNames.own} {number(id === "codex" ? a?.stats.skillsCodex == null || a.stats.skillsAgents == null ? null : a.stats.skillsCodex + a.stats.skillsAgents : a?.stats.skillsOwn)}{id !== "hermes" && " · " + s.kinds.hooks + " " + number(a?.stats.hookHandlers)}</small></button>; })}
      <h3>{s.thisPc}</h3><button className="ad-home" onClick={() => setCwd(null)}><Monitor size={15} /><code title={catalog?.home}>{catalog?.home ?? s.home}</code></button><button className="ad-folder" onClick={() => void chooseFolder()}><Folder size={15} /><span>{s.chooseFolder}</span></button>
      {catalog && catalog.cwd !== catalog.home && <code className="ad-current-folder ad-path">{catalog.cwd}</code>}
      {serviceId === "hermes" && <button className="ad-folder" onClick={() => void chooseFolder(true)}><Folder size={15} /><span>{s.hermesLocation}</span></button>}
      {catalog && <footer>{s.readOnly}<br />{s.refreshedDuration} {catalog.refreshMs.toFixed(0)} ms</footer>}
    </nav>
    <div className={"ad-content" + (embedded ? " ad-embedded" : "")}>{!catalog || !service ? <div className="ad-empty">{s.noData}</div> : embedded ? <><div className="ad-embedded-head"><button onClick={() => setEmbedded(false)}><ArrowLeft size={13} />{s.backOverview}</button><small>{s.readOnly}</small></div><SkillsView initialSkillId={skillId} onClose={() => setEmbedded(false)} api={embeddedApi.current ?? undefined} readOnly /></>
      : view === 0 ? <Overview catalog={catalog} service={service} api={api} layer={layer} setLayer={setLayer} selected={selected} setSelected={setSelected} onSkill={openSkill} query={query} />
      : view === 1 ? <ReadingView catalog={catalog} service={service} api={api} query={query} notify={setNotice} />
      : view === 2 ? <ComparisonView catalog={catalog} api={api} query={query} selectedRow={compareRow} setSelectedRow={setCompareRow} opened={compareOpen} setOpened={setCompareOpen} onSkill={openSkill} />
      : <InspectionView catalog={catalog} api={api} query={query} selectedId={findingId} setSelectedId={setFindingId} update={setCatalog} notify={setNotice} openItem={openItem} onSkill={openSkill} />}
    </div></div>
  </div>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Search, X, RefreshCw, Folder, Monitor, ArrowLeft } from "lucide-react";
import { open as chooseDirectory } from "@tauri-apps/plugin-dialog";
import { SkillsIcon } from "../icons/ChromeIcons";
import { SkillsView } from "../skills/SkillsView";
import { agentDesignApi, agentDesignExportApi, type AgentDesignExportApi, type AgentDesignApi, type AgentDesignCatalog, type AgentServiceId } from "../../lib/agentDesignApi";
import type { skillsApi } from "../../lib/skillsApi";
import { agentDesignStrings as s, chars, number } from "./agentDesignStrings";
import { ItemDetail, ServiceMark } from "./ui";
import { MechanismView } from "./MechanismView";
import { Overview, matchesItem } from "./Overview";
import { ReadingView } from "./ReadingView";
import { ComparisonView } from "./ComparisonView";
import { HistoryView } from "./HistoryView";
import { ExportView } from "./ExportView";
import { InspectionView, visibleFindings } from "./InspectionView";
import { createReadOnlySkillsApi } from "./readOnlySkillsApi";
import "./agentDesign.css";
const folderKey = (path: string) => {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
};
export interface AgentDesignViewProps { onClose: () => void; api?: AgentDesignApi; initialCatalog?: AgentDesignCatalog; initialCwd?: string | null; skillApi?: typeof skillsApi; exportApi?: AgentDesignExportApi; initialView?: "mechanism" | "overview" }
export function AgentDesignView({ onClose, api = agentDesignApi, initialCatalog, initialCwd = null, skillApi, exportApi = agentDesignExportApi, initialView = "mechanism" }: AgentDesignViewProps) {
  const [cwd, setCwd] = useState<string | null>(initialCwd);
  const [catalog, setCatalog] = useState<AgentDesignCatalog | null>(() => initialCatalog ?? api.peek(initialCwd));
  const [serviceId, setServiceId] = useState<AgentServiceId>("claude"); const [view, setView] = useState(initialView === "overview" ? 1 : 0); const [layer, setLayer] = useState(3);
  const [query, setQuery] = useState(""); const [selected, setSelected] = useState<string | null>(null); const [compareRow, setCompareRow] = useState(0); const [compareOpen, setCompareOpen] = useState(false);
  const [sourceLine, setSourceLine] = useState<number | undefined>(); const [trail, setTrail] = useState<{ id: string; line?: number }[]>([]);
  const [findingId, setFindingId] = useState<string | null>(null); const [embedded, setEmbedded] = useState(false); const [skillId, setSkillId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const alive = useRef(0); const publication = useRef(0); const search = useRef<HTMLInputElement>(null); const surface = useRef<HTMLDivElement>(null); const flowIndex = useRef(0);
  const origin = useRef<string | null>(null); const returning = useRef(false);
  useEffect(() => { if (returning.current && !selected && !embedded) { returning.current = false; [...surface.current?.querySelectorAll<HTMLButtonElement>("[data-ad-open]") ?? []].find(button => button.dataset.adOpen === origin.current)?.focus({ preventScroll: true }); } }, [selected, embedded]);
  const currentFolder = useRef(cwd); currentFolder.current = catalog?.cwd ?? cwd;
  const embeddedApi = useRef<typeof skillsApi | null>(null);
  if (!embeddedApi.current) embeddedApi.current = skillApi ?? createReadOnlySkillsApi(() => currentFolder.current);
  useEffect(() => {
    const token = ++alive.current; const revision = ++publication.current; let fresh = false;
    setBusy(true); setSelected(null); setSourceLine(undefined); setTrail([]); setCompareOpen(false); setEmbedded(false);
    const snapshot = api.peek(cwd); if (snapshot) setCatalog(snapshot); else if (cwd !== initialCwd) setCatalog(null);
    void api.cached(cwd).then(data => { if (data && !fresh && token === alive.current && revision === publication.current) setCatalog(data); }).catch(() => { if (token === alive.current) setNotice(s.cacheError); });
    void api.refresh(cwd).then(data => { fresh = true; if (token === alive.current && revision === publication.current) setCatalog(data); }).catch(() => { if (token === alive.current) setNotice(s.error); }).finally(() => { if (token === alive.current) setBusy(false); });
    const unlisten = listen<{ workFolder: string }>("agent-design-refreshed", event => {
      const visible = currentFolder.current;
      if (token !== alive.current || !visible || typeof event.payload?.workFolder !== "string" || folderKey(event.payload.workFolder) !== folderKey(visible)) return;
      fresh = true; const remoteRevision = ++publication.current;
      void api.cached(cwd).then(data => {
        if (data && token === alive.current && remoteRevision === publication.current && folderKey(data.cwd) === folderKey(event.payload.workFolder)) {
          setCatalog(data); setNotice(s.refreshed);
        }
      }).catch(() => { if (token === alive.current && remoteRevision === publication.current) setNotice(s.cacheError); });
    }).catch(() => undefined);
    return () => { alive.current++; void unlisten.then(stop => stop?.()).catch(() => {}); };
  }, [api, cwd, initialCwd]);
  const refresh = async () => {
    const token = alive.current; const revision = ++publication.current; setBusy(true);
    try { const data = await api.refresh(cwd); if (token === alive.current && revision === publication.current) { setCatalog(data); setNotice(s.refreshed); } }
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
  const switchView = (next: number) => { setView(next); setEmbedded(false); setSelected(null); setSourceLine(undefined); setTrail([]); setCompareOpen(false); };
  const keyboard = (event: React.KeyboardEvent) => {
    const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (embedded) { setEmbedded(false); return; }
      if (selected) { backItem(); return; }
      if (compareOpen) { setCompareOpen(false); return; }
      if (query) { setQuery(""); return; }
      onClose(); return;
    }
    if (embedded) return;
    if (event.key === "/" && !editing) { event.preventDefault(); search.current?.focus(); return; }
    if (editing) return;
    if (/^[0-6]$/.test(event.key)) { event.preventDefault(); switchView(Number(event.key)); return; }
    if (!catalog || !service || selected) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); const step = event.key === "ArrowDown" ? 1 : -1;
      if (view === 0 || view === 1) {
        const rows = Array.from(surface.current?.querySelectorAll<HTMLElement>("[data-ad-layer]") ?? []); const at = rows.findIndex(row => Number(row.dataset.adLayer) === layer); const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))];
        if (next) { setLayer(Number(next.dataset.adLayer)); setSelected(null); next.focus(); }
      } else if (view === 2) {
        const rows = Array.from(surface.current?.querySelectorAll<HTMLElement>(".ad-flow-card") ?? []); const current = event.target instanceof HTMLElement ? event.target.closest(".ad-flow-card") : null;
        const at = rows.findIndex(row => row === current); if (rows.length) { flowIndex.current = Math.max(0, Math.min(rows.length - 1, (at < 0 ? flowIndex.current : at) + step)); rows[flowIndex.current].focus(); }
      } else if (view === 3) { const rows = Array.from(surface.current?.querySelectorAll<HTMLElement>("[data-ad-compare-row]") ?? []); const at = rows.findIndex(row => Number(row.dataset.adCompareRow) === compareRow); const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))]; if (next) { setCompareRow(Number(next.dataset.adCompareRow)); next.focus(); } }
      else if (view === 4) {
        const rows = Array.from(surface.current?.querySelectorAll<HTMLElement>("[data-ad-finding]") ?? []); const index = Math.max(0, rows.findIndex(row => row.dataset.adFinding === findingId));
        const row = rows[Math.max(0, Math.min(rows.length - 1, index + step))]; if (row?.dataset.adFinding) { setFindingId(row.dataset.adFinding); row.focus(); }
      }
    } else if (event.key === "Enter" && (event.target === surface.current || (event.target instanceof HTMLElement && event.target.matches('[role="option"],[role="listbox"],tr,.ad-flow-card')))) {
      event.preventDefault();
      if (view === 0 || view === 1) { const item = catalog.items.find(i => i.service === service.id && i.layer === layer && i.active && matchesItem(i, query)); if (item) openItem(item.id); }
      else if (view === 2) { setLayer([2, 3, 4, 5, 6, 6, 6, 3, 5, 7, 6, 6][flowIndex.current]); switchView(1); }
      else if (view === 3) setCompareOpen(true);
      else if (view === 4) { const f = visibleFindings(catalog, query).find(f => f.id === findingId) ?? visibleFindings(catalog, query)[0]; if (f?.itemIds[0]) setSelected(f.itemIds[0]); }
    }
  };
  const openItem = (id: string, line?: number) => { if (catalog?.items.some(i => i.id === id)) { if (!selected) origin.current = id; if (selected && selected !== id) setTrail(previous => [...previous, { id: selected, line: sourceLine }]); setSourceLine(line); setSelected(id); } };
  const backItem = () => { const previous = trail[trail.length - 1]; returning.current = !previous; setTrail(trail.slice(0, -1)); setSelected(previous?.id ?? null); setSourceLine(previous?.line); };
  const selectedItem = catalog?.items.find(item => item.id === selected);
  return <div className="ad-view" ref={surface} onKeyDown={keyboard} tabIndex={-1}>
    <header className="ad-header"><SkillsIcon size={20} /><div className="ad-brand"><strong>{s.title}</strong><small>{catalog?.services.filter(a => a.version).map(a => a.displayName + " " + a.version).join(" · ") || s.version + " " + s.unknown}{catalog && " · " + s.updatedAt + " " + new Date(catalog.generatedAt).toLocaleTimeString("ja-JP")}{busy && " · " + s.updating}</small></div>
      <nav className="ad-tabs" aria-label={s.title}>{s.views.map((label, index) => <button key={label} aria-pressed={!embedded && view === index} className={!embedded && view === index ? "active" : ""} onClick={() => switchView(index)}>{label}{index === 4 && catalog && <small>{catalog.findings.length}</small>}</button>)}<button aria-pressed={embedded} onClick={() => openSkill()}>スキル</button>{["履歴", "書き出し"].map((label, index) => <button key={label} aria-pressed={!embedded && view === index + 5} onClick={() => switchView(index + 5)}>{label}</button>)}</nav>
      <label className="ad-search"><Search size={15} /><input ref={search} aria-label={s.search} placeholder={s.searchPlaceholder} value={query} onChange={event => setQuery(event.target.value)} /><kbd>/</kbd></label>
      <button aria-label={s.refresh} title={s.refresh} onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} className={busy ? "ad-spinning" : ""} />{s.refresh}</button><button aria-label={s.close} title={s.close} onClick={onClose}><X size={16} /></button>
    </header>
    {(notice || catalog?.warnings.length) ? <div className="ad-notice" role="status">{notice || s.countError}<button aria-label={s.dismiss} onClick={() => setNotice("")}><X size={13} /></button></div> : null}
    <div className="ad-body"><nav className="ad-rail" aria-label={s.services}><h3>{s.services}</h3>
      {(["claude", "codex", "hermes"] as const).map(id => { const a = catalog?.services.find(a => a.id === id); const own = id === "codex" ? a?.stats.skillsCodex == null || a.stats.skillsAgents == null ? null : a.stats.skillsCodex + a.stats.skillsAgents : a?.stats.skillsOwn; return <button key={id} aria-pressed={serviceId === id} className={"ad-service" + (serviceId === id ? " selected" : "")} onClick={() => { setServiceId(id); setSelected(null); setTrail([]); setSourceLine(undefined); }}><span><ServiceMark id={id} /><strong>{a?.displayName ?? (id === "claude" ? "Claude Code" : id === "codex" ? "Codex" : "Hermes")}</strong></span><small>{a?.state === "absent" ? s.absent : id === "hermes" ? s.hermesScope : s.everyRead + " " + chars(a?.context.total ?? a?.context.knownTotal)}</small><small>{own != null && s.groupNames.own + " " + number(own) + " 本"}{id !== "hermes" && a?.stats.hookHandlers != null && " · 処理の登録 " + number(a.stats.hookHandlers) + " 件"}</small></button>; })}
      <h3>{s.thisPc}</h3><button className="ad-home" onClick={() => setCwd(null)}><Monitor size={15} /><code title={catalog?.home}>{catalog?.home ?? s.home}</code></button><button className="ad-folder" onClick={() => void chooseFolder()}><Folder size={15} /><span>{s.chooseFolder}</span></button>
      {catalog && catalog.cwd !== catalog.home && <code className="ad-current-folder ad-path">{catalog.cwd}</code>}
      {serviceId === "hermes" && <button className="ad-folder" onClick={() => void chooseFolder(true)}><Folder size={15} /><span>{s.hermesLocation}</span></button>}
      {catalog && <footer>{s.readOnly}<br />{s.refreshedDuration} 約 {(catalog.refreshMs / 1000).toFixed(1)} 秒</footer>}
    </nav>
    <div className={"ad-content" + (embedded ? " ad-embedded" : "")}>{!catalog || !service ? <div className="ad-empty">{s.noData}</div> : <>
      <div className="ad-page" hidden={embedded || Boolean(selectedItem)}>
        {view === 0 ? <MechanismView catalog={catalog} service={service} layer={layer} setLayer={setLayer} query={query} onOpen={openItem} onSkill={openSkill} onReading={() => switchView(2)} />
          : view === 1 ? <Overview catalog={catalog} service={service} api={api} layer={layer} setLayer={setLayer} selected={null} setSelected={id => id ? openItem(id) : setSelected(null)} onSkill={openSkill} query={query} onMechanism={() => switchView(0)} onReading={() => switchView(2)} />
          : view === 2 ? <ReadingView catalog={catalog} service={service} api={api} query={query} notify={setNotice} onOpen={openItem} onSkill={openSkill} />
          : view === 3 ? <ComparisonView catalog={catalog} api={api} query={query} selectedRow={compareRow} setSelectedRow={setCompareRow} opened={compareOpen} setOpened={setCompareOpen} onSkill={openSkill} onOpen={openItem} />
          : view === 4 ? <InspectionView catalog={catalog} api={api} query={query} selectedId={findingId} setSelectedId={setFindingId} update={setCatalog} notify={setNotice} openItem={openItem} onSkill={openSkill} />
          : view === 5 ? <HistoryView catalog={catalog} serviceId={service.id} api={api} query={query} onOpen={openItem} />
          : <ExportView catalog={catalog} api={exportApi} query={query} onOpen={openItem} />}
      </div>
      {embedded ? <><div className="ad-embedded-head"><button onClick={() => setEmbedded(false)}><ArrowLeft size={13} />{s.backOverview}</button><small>{s.readOnly}</small></div><SkillsView initialSkillId={skillId} onClose={() => setEmbedded(false)} api={embeddedApi.current ?? undefined} readOnly /></>
        : selectedItem && <main className="ad-main ad-item-page"><nav className="ad-breadcrumb" aria-label="現在の場所"><button onClick={() => { setTrail([]); returning.current = true; setSelected(null); }}>{s.views[view] ?? (view === 5 ? "履歴" : "書き出し")}</button><span>› {selectedItem.service} › {s.layerNames[selectedItem.layer]} › {selectedItem.displayName}</span></nav><ItemDetail key={selectedItem.id + ":" + selectedItem.modifiedAt + ":" + catalog.generatedAt} item={selectedItem} catalog={catalog} api={api} onBack={backItem} onSkill={openSkill} onOpen={openItem} sourceLine={sourceLine} /></main>}
    </>}
    </div></div>
  </div>;
}

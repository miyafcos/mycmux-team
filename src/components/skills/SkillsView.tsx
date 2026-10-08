import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Search, X, RefreshCw, Grid2X2, Star, Sparkles, History, EyeOff, Puzzle, Box, Terminal, Folder } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { SkillsIcon } from "../icons/ChromeIcons";
import { ClaudeAgentIcon, CodexAgentIcon } from "../icons/AgentIcons";
import { KIND_COLORS } from "../../lib/agentKindColors";
import { useVirtualRows } from "../../hooks/useVirtualRows";
import { skillsApi, type SkillCatalog, type SkillRow } from "../../lib/skillsApi";
import { searchSkills, type SkillMatch } from "./skillSearch";
import { categoryTone, SkillSymbol } from "./symbolMap";
import { SkillsExplorer } from "./SkillsExplorer";
import { SkillDetail } from "./SkillDetail";
import { SkillHighlight } from "./SkillHighlight";
import { startSkill } from "./skillLaunch";
import { skillsStrings as s } from "./skillsStrings";
import "./skills.css";

export function SkillUsage({ row }: { row: SkillRow }) {
  return <span className="skills-usage"><span title={s.claudeUsage} style={{ color: KIND_COLORS.claude.fg }}><ClaudeAgentIcon />{row.usage.claude}</span><span title={row.codexRecorded ? s.codexUsage : s.noRecord} style={{ color: KIND_COLORS.codex.fg }}><CodexAgentIcon />{row.usage.codex}</span></span>;
}
export interface SkillsViewProps {
  /** Select one registered skill when mounted or when the host changes this id. */
  initialSkillId?: string | null;
  onClose: () => void;
  api?: typeof skillsApi;
  initialCatalog?: SkillCatalog;
  /** Stage A hosts inspect skills without starting, editing or exporting them. */
  readOnly?: boolean;
}
export function SkillsView(props: SkillsViewProps) { return props.readOnly ? <SkillsExplorer {...props} /> : <ManagedSkillsView {...props} />; }
function ManagedSkillsView({ initialSkillId = null, onClose, api = skillsApi, initialCatalog, readOnly = false }: SkillsViewProps) {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(() => initialCatalog ?? api.peek());
  const [shelf, setShelf] = useState("all"); const [query, setQuery] = useState(""); const [agent, setAgent] = useState("all"); const [sort, setSort] = useState("usage");
  const [selected, setSelected] = useState<string | null>(initialSkillId); const [expanded, setExpanded] = useState(false); const [tab, setTab] = useState("content");
  const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false); const [changed, setChanged] = useState<Set<string>>(new Set());
  const [bundled, setBundled] = useState<{ name: string; state: string }[]>([]);
  const search = useRef<HTMLInputElement>(null); const alive = useRef(0); const list = useRef<HTMLDivElement>(null);
  const refresh = async () => {
    const token = alive.current; setBusy(true);
    try { const data = await api.refresh(); if (token !== alive.current) return;
      setCatalog(previous => { const before = new Map(previous?.skills.map(r => [r.id, r])); setChanged(new Set(data.skills.filter(r => before.has(r.id) && JSON.stringify(before.get(r.id)) !== JSON.stringify(r)).map(r => r.id))); return data; });
    } catch (error) { if (token === alive.current) setNotice(s.error(String(error))); }
    finally { if (token === alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current++; const token = alive.current; let fresh = false;
    void api.cached().then(data => { if (data && !fresh && token === alive.current) setCatalog(data); }).catch(error => { if (token === alive.current) setNotice(s.cacheError(String(error))); });
    setBusy(true); void api.refresh().then(data => { fresh = true; if (token === alive.current) setCatalog(data); }).catch(error => { if (token === alive.current) setNotice(s.error(String(error))); }).finally(() => { if (token === alive.current) setBusy(false); });
    return () => { alive.current++; };
  }, [api]);
  useEffect(() => { if (!readOnly && shelf === "bundled") void invoke<{ skills: { name: string; state: string }[] }>("claude_skills_status").then(result => setBundled(result.skills)).catch(error => setNotice(s.error(String(error)))); }, [shelf, readOnly]);
  useEffect(() => { if (!changed.size) return; const timer = setTimeout(() => setChanged(new Set()), 2000); return () => clearTimeout(timer); }, [changed]);
  useEffect(() => { if (initialSkillId) { setShelf("all"); setAgent("all"); setQuery(""); setSelected(initialSkillId); } }, [initialSkillId]);
  const matches = useMemo(() => {
    let rows = shelf === "hidden" ? catalog?.hiddenSkills ?? [] : catalog?.skills ?? [];
    rows = rows.filter(row => (agent === "all" || row.agents.includes(agent)) && (
      shelf === "all" || shelf === "hidden" || shelf === "frequent" || (shelf === "new" && row.isNew) || shelf === "recent" || row.category === shelf || row.kind === shelf));
    rows = [...rows].sort((a, b) => sort === "name" ? a.label.localeCompare(b.label) : sort === "recent" || shelf === "recent" ? b.modifiedAt - a.modifiedAt : sort === "size" ? b.fileSize - a.fileSize : b.usageCount - a.usageCount);
    if (shelf === "frequent") rows = rows.filter(row => row.usageCount > 0);
    return searchSkills(rows, query);
  }, [catalog, shelf, agent, sort, query]);
  const virtual = useVirtualRows(matches.length, 76);
  useEffect(() => { if (!matches.some(m => m.row.id === selected)) setSelected(matches.some(m => m.row.id === initialSkillId) ? initialSkillId : matches[0]?.row.id ?? null); }, [matches, selected, initialSkillId]);
  const match = matches.find(m => m.row.id === selected); const row = match?.row;
  const launch = (kind: "claude" | "codex") => { if (readOnly) { setNotice(s.readOnly); return; } if (!row) return; try { startSkill(row, kind); onClose(); } catch (error) { setNotice(s.error(String(error))); } };
  const goShelf = (id: string) => { setShelf(id); setExpanded(false); setQuery(""); };
  const keyboard = (event: React.KeyboardEvent) => {
    const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!escape()) onClose(); }
    else if (event.key === "/" && !editing) { event.preventDefault(); search.current?.focus(); }
    else if (event.key === "Enter" && event.ctrlKey) { event.preventDefault(); event.stopPropagation(); launch(event.shiftKey ? "codex" : "claude"); }
    else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !(event.target instanceof HTMLSelectElement)) {
      event.preventDefault(); const index = matches.findIndex(m => m.row.id === selected); const next = Math.max(0, Math.min(matches.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))); setSelected(matches[next]?.row.id ?? null);
      const container = virtual.ref.current; if (container) { const top = next * 76; if (top < container.scrollTop || top + 76 > container.scrollTop + container.clientHeight) container.scrollTop = Math.max(0, top - container.clientHeight / 2); virtual.onScroll(); }
    } else if (event.key === "Enter" && (event.target === search.current || event.target === virtual.ref.current || (event.target instanceof HTMLElement && !!event.target.closest(".skills-row")))) { event.preventDefault(); setTab("content"); list.current?.querySelector<HTMLButtonElement>(".skills-tabs button")?.focus(); }
  };
  const escape = () => { if (query) { setQuery(""); search.current?.focus(); return true; } if (expanded) { setExpanded(false); return true; } if (tab !== "content") { setTab("content"); return true; } return false; };
  const countShelf = (id: string) => (catalog?.skills ?? []).filter(r => r.category === id).length;
  const specials = [
    { id: "all", label: s.all, icon: Grid2X2, count: catalog?.skills.length ?? 0 }, { id: "frequent", label: s.frequent, icon: Star }, { id: "new", label: s.new, icon: Sparkles, count: catalog?.newCount }, { id: "recent", label: s.recent, icon: History },
  ];
  const extras = [{ id: "hidden", label: s.hidden, icon: EyeOff, count: catalog?.hiddenCount }, { id: "bundled", label: s.bundled, icon: SkillsIcon }, { id: "plugin", label: s.plugin, icon: Puzzle }, { id: "builtin", label: s.builtin, icon: Box }, { id: "command", label: s.command, icon: Terminal }].filter(item => !readOnly || item.id !== "bundled");
  const railItem = (item: { id: string; label: string; icon: ComponentType<{ size?: number }>; count?: number }) => <button key={item.id} className={shelf === item.id ? "selected" : ""} onClick={() => goShelf(item.id)} aria-pressed={shelf === item.id}><item.icon size={15} /><span>{item.label}</span>{item.count !== undefined && <small>{item.count}</small>}</button>;
  return <div className="skills-panel" onKeyDown={keyboard} ref={list}>
      <header className="skills-header"><SkillsIcon size={20} /><div><strong>{s.title}</strong><small>{s.catalogStatus(catalog?.skills.length ?? 0, catalog?.generatedAt, busy)}</small></div><span className="skills-shelf-label">{s.shelf}</span><div className="skills-header-spacer" />
        <label className="skills-search"><Search size={15} /><input ref={search} value={query} onChange={e => { setQuery(e.target.value); setExpanded(false); }} placeholder={s.searchPlaceholder} aria-label={s.search} /><kbd>/</kbd></label>
        <button onClick={() => void refresh()} title={s.refresh} aria-label={s.refresh} disabled={busy}><RefreshCw size={15} /></button><button onClick={onClose} title={s.close} aria-label={s.close}><X size={16} /></button></header>
      {notice && <div className="skills-notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label={s.dismiss}><X size={14} /></button></div>}
      <div className={`skills-columns${expanded ? " expanded" : ""}`}>
        <nav className="skills-rail" aria-label={s.shelves}>{specials.map(railItem)}<h3>{s.shelf}</h3>{catalog?.categories.map(category => <button key={category.id} onClick={() => goShelf(category.id)} className={shelf === category.id ? "selected" : ""} aria-pressed={shelf === category.id}><span style={{ color: categoryTone(category.id) }}><SkillSymbol symbol={category.symbol} size={15} /></span><span>{category.name}</span><small>{countShelf(category.id)}</small></button>)}<h3>{s.other}</h3>{extras.map(railItem)}</nav>
        {!expanded && <section className="skills-list" aria-label={s.list}>
          <div className="skills-list-toolbar"><strong>{query ? s.searchResults : catalog?.categories.find(c => c.id === shelf)?.name ?? [...specials, ...extras].find(i => i.id === shelf)?.label}</strong><small>{matches.length}</small><div className="skills-header-spacer" />
            <select aria-label={s.filterAgent} value={agent} onChange={e => setAgent(e.target.value)}><option value="all">{s.all}</option><option value="claude">Claude</option><option value="codex">Codex</option></select>
            <select aria-label={s.sort} value={sort} onChange={e => setSort(e.target.value)}><option value="usage">{s.sortUsage}</option><option value="name">{s.sortName}</option><option value="recent">{s.sortRecent}</option><option value="size">{s.sortSize}</option></select></div>
          {shelf === "bundled" ? <div className="skills-empty">{bundled.map(item => <p key={item.name}><code>{item.name}</code> <span>{s.bundledState(item.state)}</span></p>)}</div> : <div className="skills-rows" role="listbox" aria-label={s.list} aria-activedescendant={selected ? `skill-row-${selected}` : undefined} tabIndex={0} ref={virtual.ref} onScroll={virtual.onScroll}>
            <div style={{ height: virtual.paddingTop }} />{matches.slice(virtual.start, virtual.end).map((item: SkillMatch, index) => <div key={item.row.id} style={{ height: 76 }}>{query && (virtual.start + index === 0 || matches[virtual.start + index - 1]?.group !== item.group) && <div className="skills-match-group">{s.groups[item.group]}</div>}
              <button id={`skill-row-${item.row.id}`} role="option" aria-selected={selected === item.row.id} className={`skills-row${selected === item.row.id ? " selected" : ""}${changed.has(item.row.id) ? " changed" : ""}`} onClick={() => setSelected(item.row.id)}>
                <span className="skills-symbol" style={{ color: categoryTone(item.row.category), background: `color-mix(in srgb, ${categoryTone(item.row.category)} 10%, var(--cmux-surface-raised))` }}><SkillSymbol symbol={item.row.symbol ?? catalog?.categories.find(c => c.id === item.row.category)?.symbol ?? null} size={20} /></span><span className="skills-row-main"><span><b><SkillHighlight text={item.row.label} query={query} /></b><code><SkillHighlight text={item.row.id} query={query} /></code>{item.row.duplicateCodex && <span className="skills-tag" title={s.duplicateWarning}>{s.duplicateTag}</span>}{item.row.hasWrapper && <span className="skills-tag">{s.wrapperTag}</span>}{item.row.isNew && <span className="skills-tag">{s.new}</span>}</span><span className="skills-one-line"><SkillHighlight text={item.row.line} query={query} /></span></span><span className="skills-row-side"><SkillUsage row={item.row} /><small>{s.date(item.row.lastUsedAt)}</small></span>
              </button></div>)}<div style={{ height: virtual.paddingBottom }} />{!matches.length && <p className="skills-empty">{busy ? s.loading : s.noResults}</p>}</div>}
          <footer>{s.usageNote}</footer>
        </section>}
        <section className="skills-detail" aria-label={s.details}>{row && shelf !== "bundled" ? <SkillDetail key={row.id} readOnly={readOnly} row={row} category={catalog?.categories.find(c => c.id === row.category)} api={api} tab={tab} setTab={setTab} expanded={expanded} setExpanded={setExpanded} query={query} snippet={match?.snippet ?? ""} notify={setNotice} close={onClose} /> : <div className="skills-empty"><Folder size={36} /><p>{shelf === "bundled" ? s.bundledReadOnly : s.selectSkill}</p></div>}</section>
      </div>
    </div>;
}

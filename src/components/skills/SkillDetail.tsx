import { useEffect, useRef, useState } from "react";
import { Copy, Play, Share2, FolderOpen, Expand, Minimize, Pencil, Sparkles, FileText, Search, ArrowLeft, Check, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { downloadDir, join } from "@tauri-apps/api/path";
import { ClaudeAgentIcon, CodexAgentIcon } from "../icons/AgentIcons";
import { skillsApi, type SkillCategory, type SkillRow, type SkillDocument, type SkillFolder, type SkillPreview, type SkillLocations, type SkillDiff } from "../../lib/skillsApi";
import { categoryTone, SkillSymbol } from "./symbolMap";
import { startSkill } from "./skillLaunch";
import { SkillHighlight } from "./SkillHighlight";
import { skillsStrings as s } from "./skillsStrings";

function bytes(value: number) { return value > 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : value > 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`; }
function MarkdownView({ html, query = "", notify }: { html: string; query?: string; notify: (message: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = root.current; if (!host) return;
    host.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading, index) => { heading.id = `skill-heading-${index}`; });
    const term = query.trim().toLocaleLowerCase(); if (!term) return;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); const nodes: Text[] = []; while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const text = node.textContent ?? ""; const lower = text.toLocaleLowerCase(); let at = 0, next = lower.indexOf(term);
      if (next < 0) continue; const fragment = document.createDocumentFragment();
      while (next >= 0) { fragment.append(text.slice(at, next)); const mark = document.createElement("mark"); mark.textContent = text.slice(next, next + term.length); fragment.append(mark); at = next + term.length; next = lower.indexOf(term, at); }
      fragment.append(text.slice(at)); node.replaceWith(fragment);
    }
  }, [html, query]);
  return <div ref={root} className="skills-markdown" onClick={event => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a"); if (!link) return; event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) root.current?.querySelectorAll<HTMLElement>("[id]").forEach(el => { if (`#${el.id}` === href) el.scrollIntoView({ block: "start" }); });
    else if (/^(https?:\/\/|mailto:)/i.test(href)) void shellOpen(href).catch(error => notify(s.error(String(error))));
  }} dangerouslySetInnerHTML={{ __html: html }} />;
}
interface Props {
  row: SkillRow; category?: SkillCategory; api: typeof skillsApi; tab: string; setTab: (tab: string) => void;
  expanded: boolean; setExpanded: (value: boolean) => void; query: string; snippet: string;
  notify: (message: string) => void; close: () => void; readOnly?: boolean;
}
export function SkillDetail({ row, category, api, tab, setTab, expanded, setExpanded, query, snippet, notify, close, readOnly = false }: Props) {
  const [content, setContent] = useState<SkillDocument | null>(null); const [folder, setFolder] = useState<SkillFolder | null>(null); const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [places, setPlaces] = useState<SkillLocations | null>(null); const [diff, setDiff] = useState<SkillDiff | null>(null); const [diffLeft, setDiffLeft] = useState(0); const [diffRight, setDiffRight] = useState(1);
  const [insideQuery, setInsideQuery] = useState(""); const [sharing, setSharing] = useState(false); const [selection, setSelection] = useState<string[]>([]); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const fileEpoch = useRef(0); const container = useRef<HTMLDivElement>(null); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; fileEpoch.current++; }; }, []);
  useEffect(() => {
    setContent(null); setFolder(null); setPreview(null); setPlaces(null); setDiff(null); fileEpoch.current++;
    if (!row.docPath) return; let live = true;
    void api.document(row.id).then(value => { if (live) setContent(value); }).catch(error => { if (live) setError(s.error(String(error))); });
    void api.locations(row.id).then(value => { if (live) setPlaces(value); }).catch(error => { if (live) setError(s.error(String(error))); });
    return () => { live = false; };
  }, [row.id, row.docPath, row.modifiedAt, api]);
  useEffect(() => {
    if ((tab !== "folder" && !sharing) || folder || !row.docPath) return; let live = true;
    void api.folder(row.id).then(value => { if (live) { setFolder(value); setSelection(value.selected); } }).catch(error => { if (live) setError(s.error(String(error))); });
    return () => { live = false; };
  }, [tab, sharing, folder, row.id, row.docPath, api]);
  const action = async (run: () => void | Promise<void>) => { try { await run(); } catch (error) { notify(s.error(String(error))); } };
  const launch = (kind: "claude" | "codex", repair = false) => void action(() => { if (readOnly) { notify(s.readOnly); return; } startSkill(row, kind, repair); close(); });
  const showFile = async (relative: string) => { const epoch = ++fileEpoch.current; try { const value = await api.preview(row.id, relative); if (epoch === fileEpoch.current && mounted.current) setPreview(value); } catch (error) { if (epoch === fileEpoch.current && mounted.current) setError(s.error(String(error))); } };
  const shareBytes = folder?.files.filter(f => selection.includes(f.path)).reduce((sum, f) => sum + f.size, 0) ?? 0;
  const tooLarge = selection.length > 5000 || shareBytes > 50 * 1024 * 1024;
  const exportZip = async () => {
    if (readOnly || !folder || tooLarge) return; setSaving(true);
    try {
      const zipName = `${row.id.replace(/[:/\\]/g, "-")}.zip`; let dialogUnavailable = false;
      let destination = await save({ defaultPath: zipName, filters: [{ name: "ZIP", extensions: ["zip"] }] }).catch(() => { dialogUnavailable = true; return null; });
      if (dialogUnavailable) destination = await join(await downloadDir(), zipName);
      if (!destination) return;
      const saved = await api.export(row.id, selection, destination); notify(s.saved(saved));
      await navigator.clipboard.writeText(saved).catch(error => notify(s.error(String(error))));
      await invoke("reveal_in_explorer", { path: saved });
    } catch (error) { notify(s.error(String(error))); } finally { if (mounted.current) setSaving(false); }
  };
  const metadata = content?.frontmatter.metadata as Record<string, unknown> | undefined;
  const tags = (value: unknown) => (Array.isArray(value) ? value : value ? [value] : []).map((v, i) => <span className="skills-chip" key={i}>{String(v)}</span>);
  return <>
    <div className="skills-detail-head"><span className="skills-big-symbol" style={{ color: categoryTone(row.category), background: `color-mix(in srgb, ${categoryTone(row.category)} 10%, var(--cmux-surface-raised))` }}><SkillSymbol symbol={row.symbol ?? category?.symbol ?? null} size={29} /></span><div className="skills-detail-title"><h2>{row.label}</h2><div className="skills-detail-meta"><code>{row.id}</code><span className="skills-chip">{category?.name ?? s.unsorted}</span><span className="skills-chip">{s.kinds[row.kind] ?? row.kind}</span><span className="skills-chip" title={s.curationHelp}>{s.curations[row.curation] ?? row.curation}</span></div><p>{row.line}</p>
      <div className="skills-calls">{["claude", "codex"].map(kind => row.calls[kind] && <button key={kind} title={s.copyCall} onClick={() => void action(async () => { await navigator.clipboard.writeText(row.calls[kind]); notify(s.copied); })}>{kind === "claude" ? <ClaudeAgentIcon /> : <CodexAgentIcon />}<code>{row.calls[kind]}</code><Copy size={12} /></button>)}</div>
      <div className="skills-actions">{!readOnly && <><button className="primary" disabled={!row.calls.claude} onClick={() => launch("claude")}><Play size={13} />{s.startClaude}</button><button disabled={!row.calls.codex} onClick={() => launch("codex")}><CodexAgentIcon />{s.startCodex}</button><button disabled={!row.docPath} onClick={() => { setSharing(true); }}><Share2 size={13} />{s.share}</button></>}<button disabled={!row.docPath} onClick={() => void action(async () => { await invoke("reveal_in_explorer", { path: row.docPath }); })}><FolderOpen size={13} />{s.folder}</button><button onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize size={13} /> : <Expand size={13} />}{expanded ? s.collapse : s.expand}</button></div>
      {places?.duplicateCodex && <p className="skills-warning" role="note">{s.duplicateWarning}</p>}
    </div></div>
    <nav className="skills-tabs" aria-label={s.detailTabs}>{["content", "folder", "places"].map(value => <button key={value} aria-pressed={tab === value && !sharing} className={tab === value && !sharing ? "active" : ""} onClick={() => { setSharing(false); setTab(value); }}>{s.tabs[value]}</button>)}<span />{!readOnly && <><button disabled={!row.docPath} onClick={() => void action(async () => { await invoke("open_with_default", { path: row.docPath }); })} title={s.editor}><Pencil size={13} />{s.editor}</button><button disabled={!row.docPath} onClick={() => launch("claude", true)}><Sparkles size={13} />{s.repair}</button></>}</nav>
    <div className="skills-detail-body" ref={container}>
      {error && <p role="alert" className="skills-warning">{error}</p>}
      {sharing ? <section className="skills-share" aria-label={s.share}><div className="skills-section-head"><h3>{s.shareTitle}</h3><button onClick={() => setSharing(false)}><ArrowLeft size={13} />{s.back}</button></div><p>{s.shareNote}</p><p>{s.shareSize(selection.length, bytes(shareBytes))} <span className={tooLarge ? "skills-warning" : ""}>{s.shareLimits}</span></p>
        {folder?.files.map(file => <label key={file.path} className="skills-share-row"><input type="checkbox" checked={selection.includes(file.path)} disabled={file.reason === "cache" || file.path.toLowerCase() === "skill.md"} onChange={event => setSelection(previous => event.target.checked ? [...previous, file.path] : previous.filter(p => p !== file.path))} /><code>{file.path}</code><small>{s.fileKinds[file.kind ?? "binary"]}</small><small>{bytes(file.size)}</small>{file.reason && <span className="skills-chip">{s.reasons[file.reason] ?? file.reason}</span>}</label>)}
        {folder?.blocked.map(file => <p key={file.path} className="skills-private"><X size={13} /><code>{file.path}</code><span>{s.reasons[file.reason] ?? file.reason}</span></p>)}<button className="primary" disabled={!folder || tooLarge || saving || !selection.length} onClick={() => void exportZip()}><Check size={14} />{saving ? s.saving : s.saveZip}</button>
      </section> : tab === "content" ? <>
        {snippet && <aside className="skills-snippet"><strong>{s.bodyMatch}</strong><pre><SkillHighlight text={snippet} query={query} /></pre></aside>}
        {!row.docPath ? <p>{s.noDocument}</p> : content ? <>
          <dl className="skills-frontmatter"><dt>{s.description}</dt><dd>{String(content.frontmatter.description ?? row.description)}</dd><dt>{s.triggers}</dt><dd>{tags(metadata?.triggers)}</dd><dt>{s.exclusions}</dt><dd>{tags(metadata?.exclusions)}</dd><dt>{s.tools}</dt><dd>{tags(content.frontmatter["allowed-tools"])}</dd><dt>{s.size}</dt><dd>{s.documentSize(content.lines, bytes(content.size))} · {s.date(content.modifiedAt)}</dd></dl>
          <div className="skills-document-tools"><label><Search size={13} /><input aria-label={s.searchInside} value={insideQuery} onChange={event => setInsideQuery(event.target.value)} placeholder={s.searchInside} /></label></div>
          {content.toc.length > 0 && <nav className="skills-toc" aria-label={s.toc}>{content.toc.map((heading, index) => <button key={index} style={{ paddingLeft: (heading.level - 1) * 10 + 6 }} onClick={() => container.current?.querySelector(`#skill-heading-${index}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}>{heading.text}</button>)}</nav>}
          <MarkdownView key={`${content.html}:${insideQuery}:${query}`} html={content.html} query={insideQuery || query} notify={notify} />
        </> : <p>{s.loading}</p>}
      </> : tab === "folder" ? <>
        {folder ? <><div className="skills-section-head"><h3>{folder.rootName}</h3><small>{s.folderSize(folder.files.length, bytes(folder.files.reduce((sum, f) => sum + f.size, 0)))}</small></div><div className="skills-folder-view"><div className="skills-file-tree" role="list" aria-label={s.fileTree}>{folder.entries.map(file => file.dir ? <div key={file.path} className="skills-file-folder" style={{ paddingLeft: file.depth * 14 + 6 }}><FolderOpen size={13} /><span>{file.name}</span><small>{bytes(file.size)}</small></div> : <button key={file.path} onClick={() => void showFile(file.path)} style={{ paddingLeft: file.depth * 14 + 6 }} title={file.path}><FileText size={13} /><span>{file.name}</span><small>{s.fileKinds[file.kind ?? "binary"]}</small><small>{bytes(file.size)}</small>{file.reason && <span className="skills-chip">{s.reasons[file.reason] ?? file.reason}</span>}</button>)}{folder.blocked.map(file => <div key={file.path} className="skills-private"><X size={13} /><span>{file.path}</span><small>{s.reasons[file.reason] ?? file.reason}</small></div>)}</div>
          <div className="skills-file-preview">{preview ? <><code>{preview.path}</code>{preview.kind === "md" ? <MarkdownView html={preview.html ?? ""} notify={notify} /> : preview.kind === "image" ? <img src={preview.content ?? ""} alt={preview.path} /> : preview.kind === "text" ? <pre>{preview.content}</pre> : readOnly ? <p>{s.readOnly}</p> : <button onClick={() => void action(async () => { await invoke("open_with_default", { path: preview.path }); })}>{s.openExternally}</button>}</> : <p>{s.selectFile}</p>}</div></div></> : <p>{row.docPath ? s.loading : s.noDocument}</p>}
      </> : <>
        <div className="skills-section-head"><h3>{s.placesTitle}</h3><small>{s.readOnly}</small></div>{places?.duplicateCodex && <p className="skills-warning">{s.duplicateWarning}</p>}
        <div className="skills-places-grid">{places?.items.map((place, index) => <article key={place.path} className="skills-place"><header><strong>{s.relations[place.relation] ?? place.relation}</strong><code>{place.path}</code></header><p>{s.documentSize(place.lines, s.fileCount(place.fileCount))} · {s.date(place.modifiedAt)} · {s.implicit(place.allowImplicitInvocation)}</p>{place.target && <p>{s.target}: <code>{place.target}</code> <span className={place.targetExists ? "" : "skills-warning"}>{place.targetExists ? s.exists : s.missing}</span></p>}{place.descriptionSame !== null && <p className={place.descriptionSame ? "" : "skills-warning"}>{place.descriptionSame ? s.sameDescription : s.differentDescription}</p>}{place.sameContent !== null && <p>{place.sameContent ? s.sameContent : s.differentContent}</p>}<div className="skills-place-controls"><label><input type="radio" name={`diff-left-${row.id}`} checked={diffLeft === index} onChange={() => setDiffLeft(index)} />{s.diffLeft}</label><label><input type="radio" name={`diff-right-${row.id}`} checked={diffRight === index} onChange={() => setDiffRight(index)} />{s.diffRight}</label></div></article>)}</div>
        {places && places.items.length > 1 && <button disabled={diffLeft === diffRight} onClick={() => void action(async () => { const result = await api.diff(row.id, diffLeft, diffRight); if (mounted.current) setDiff(result); })}>{s.showDiff}</button>}
        {diff && <div className="skills-diff" aria-label={s.diff}>{diff.truncated && <p>{s.diffTooLarge}</p>}{diff.lines.map((line, index) => <pre key={index} className={line.kind}><span>{line.left ?? ""} {line.right ?? ""}</span>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} {line.text}</pre>)}</div>}
        {places && !places.items.length && <p>{s.noPlaces}</p>}
      </>}
    </div>
  </>;
}

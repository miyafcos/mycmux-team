import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, SlidersHorizontal, ScrollText, Brain, Wrench, Zap, BookOpen, ArrowRight, ArrowLeft } from "lucide-react";
import { AgentKindIcon } from "../icons/AgentIcons";
import { KIND_COLORS } from "../../lib/agentKindColors";
import type { AgentServiceId, AgentDesignApi, AgentDesignCatalog, DesignService, DesignItem, DesignField, DesignLink, DesignDocument, DesignSession } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, number, chars, count, bytes } from "./agentDesignStrings";
import { DocumentView } from "./DocumentView";
import { Facts, UsageNote } from "./Information";
import { dateTime, sizeText } from "./presentation";

export const layerIcons = [Box, Box, SlidersHorizontal, ScrollText, Brain, Wrench, Zap, BookOpen];
export function ServiceMark({ id, size = 16 }: { id: AgentServiceId; size?: number }) {
  return <span className="ad-service-mark" style={{ color: KIND_COLORS[id].fg }}><AgentKindIcon kind={id} size={size} /></span>;
}
export function Badge({ value, evidence = false }: { value: string; evidence?: boolean }) {
  return <span className={"ad-badge ad-badge-" + value}>{(evidence ? s.evidence : s.timings)[value] ?? s.unsupported}</span>;
}
export function Fields({ fields }: { fields: DesignField[] }) {
  return <dl className="ad-fields">{fields.map((f, i) => <div key={f.key + i}><dt>{f.key.startsWith("plugin:") ? s.kinds.plugins + " / " + f.key.slice(7) : f.key.startsWith("mcp:") ? "MCP / " + f.key.slice(4) : f.key.startsWith("hook:") ? s.kinds.hooks + " / " + f.key.slice(5) : s.fieldNames[f.key] ?? s.unsupported}</dt>
    <dd>{f.value === "true" ? s.enabled : f.value === "false" ? s.disabled : f.value === "unknown" ? s.unknown : f.value === "notCounted" ? s.notCounted : f.value === "unsupported" ? s.unsupported : f.value}</dd></div>)}</dl>;
}
export function SessionOrigin({ session }: { session: DesignSession }) {
  if (!session.file) return null;
  const date = session.startedAt ? new Date(session.startedAt) : null;
  const time = date && Number.isFinite(date.getTime()) ? date.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " " + s.sessionOrigin : s.sessionStartUnknown;
  const line = time + " / " + session.file;
  return <p className="ad-session-origin ad-muted" title={line}>{line}</p>;
}
export function AmountBand({ service, compact = false, onPart }: { service: DesignService; compact?: boolean; onPart?: (index: number) => void }) {
  const values = [service.context.instructions, service.context.memory, service.context.listing, service.context.startup];
  const known = service.context.knownTotal; const hasMeasured = values.some(value => value != null);
  return <section className={"ad-amount" + (compact ? " compact" : "")} aria-label={s.everyRead}>
    <div className="ad-amount-heading"><strong>{hasMeasured ? s.everyRead + " " + chars(service.context.total ?? known) : "初期の量は未取得"}</strong>{service.context.total == null && hasMeasured && <small>{s.partialTotal} · {s.unknownTotal}</small>}</div>
    {known > 0 && <small>400 字の原稿用紙なら約 {number(Math.ceil(known / 400))} 枚。会話全体の割合は未計測です。</small>}
    <div className="ad-amount-bar" aria-hidden="true">{values.map((value, index) => value != null && value > 0 && <span key={index} className={"ad-amount-part ad-part-" + index} style={{ flex: value }} />)}{known === 0 && <span className="ad-amount-empty" />}</div>
    <div className="ad-amount-legend">{values.map((value, index) => onPart ? <button key={index} onClick={() => onPart(index)}><i className={"ad-part-" + index} />{s.inputParts[index]} {value == null ? "" : chars(value)} →</button> : <span key={index}><i className={"ad-part-" + index} />{s.inputParts[index]} {value == null ? "" : chars(value)}</span>)}</div>
    <small className="ad-muted">{s.productNotCounted}{service.context.product != null && " / " + s.productAdded + " " + chars(service.context.product)}</small>
    <SessionOrigin session={service.session} />
  </section>;
}
export function LayerSummary({ service: a, layer, items }: { service: DesignService; layer: number; items: DesignItem[] }) {
  const st = a.stats;
  const metric = (label: string, value: string, timing?: string) => <span className="ad-chip" key={label + timing}>{label} <b>{value}</b>{timing && <Badge value={timing} />}</span>;
  const activeDocs = items.filter(i => i.layer === 3 && i.active && i.kind !== "rule");
  let content: ReactNode;
  if (a.state === "absent") content = metric(s.absent, "");
  else if (a.id === "hermes") content = items.filter(i => i.layer === layer && i.kind !== "runtime").map(i => metric(s.kinds[i.kind] ?? i.displayName, i.status === "absent" ? s.absent : i.displayName, i.readTiming));
  else if (layer === 1) content = <>{metric(a.displayName, a.version ?? s.unknown)}{metric(s.groupNames.builtin, count(a.id === "claude" ? a.session.listing.groups.find(g => g.kind === "builtin")?.count : st.skillsSystem))}{metric(s.productNotCounted, "", "outside")}</>;
  else if (layer === 2) content = <>{items.filter(i => i.layer === 2 && (i.kind === "settings" || i.kind === "settingsLocal")).map(i => metric(i.displayName, bytes(i.size.bytes)))}
    {metric(s.fieldNames.allowCount, a.id === "claude" ? number(st.allow) + " + " + number(st.allowLocal) : a.settings.find(f => f.key === "approval_policy")?.value ?? s.unknown)}
    {metric(s.fieldNames.model, a.settings.find(f => f.key === "model")?.value ?? s.unknown)}
    {a.id === "claude" ? metric(s.kinds.privateCount, count(st.tokensFiles), "private") : metric("default.rules", bytes(st.rulesBytes), "outside")}</>;
  else if (layer === 3) content = <>{activeDocs.slice(0, 3).map(i => metric(i.displayName, chars(i.size.chars), "always"))}
    {a.id === "claude" && <>{metric(s.rules, count(st.rulesAlways) + " / " + chars(st.rulesAlwaysChars), "always")}{metric(s.rules, count(st.rulesConditional), "conditional")}</>}</>;
  else if (layer === 4) content = <>{metric(a.id === "claude" ? "MEMORY.md" : s.inputParts[1], chars(a.context.memory), "always")}{metric(s.location, count(st.memoryFiles), "onDemand")}
    {a.id === "claude" && metric(s.linesUnit, number(st.memoryIndexLines) + " / 200")}</>;
  else if (layer === 5) content = <>{metric(s.groupNames.own, count(a.id === "claude" ? st.skillsOwn : st.skillsCodex == null || st.skillsAgents == null ? null : st.skillsCodex + st.skillsAgents), "onDemand")}
    {a.id === "claude" && metric(s.groupNames.synced, count(st.skillsSynced))}{metric(s.kinds.plugins, number(st.plugins) + " / " + s.enabled + " " + number(st.pluginsEnabled))}
    {metric(s.compareRows[9], count(st.agents), "onDemand")}{a.id === "claude" && metric(s.groupNames.command, count(st.commands))}
    {metric("MCP", a.id === "claude" ? number(st.mcpUser) + " + " + number(st.mcpProject) : count(st.mcp))}</>;
  else if (layer === 6) content = <>{metric(s.kinds.hooks, number(st.hookEvents) + " / " + number(st.hookHandlers), "event")}
    {metric(s.kinds.scheduled, number(st.scheduledJobs) + " / " + s.enabled + " " + number(st.scheduledEnabled), "schedule")}
    {metric("scripts", count(st.scripts))}</>;
  else content = <>{metric("references", count(st.references), "onDemand")}{a.id === "claude" && metric(s.location, bytes(st.referencesBytes))}</>;
  return <div className="ad-chips">{content}</div>;
}
export function Links({ links, catalog, onOpen }: { links: DesignLink[]; catalog: AgentDesignCatalog; onOpen?: (id: string, line?: number) => void }) {
  const name = (id: string) => catalog.items.find(i => i.id === id)?.displayName ?? (id === "unsupported" ? s.unsupported : id);
  return <div className="ad-links">{!links.length ? <p className="ad-muted">{s.noLinks}</p> : links.map(link => <article key={link.id}>
    <div><ServiceMark id={link.sourceService} size={13} /><code>{name(link.from)}</code><ArrowRight size={13} /><ServiceMark id={link.targetService} size={13} /><code>{name(link.to)}</code><Badge value={link.evidence} evidence /></div>
    {link.targetPath && <code className="ad-path">{link.targetPath}</code>}{onOpen && catalog.items.filter(item => item.id === link.from || item.id === link.to || (item.path != null && item.path === link.targetPath)).map(item => <button key={item.id} onClick={() => onOpen(item.id, item.id === link.from ? link.line ?? undefined : undefined)}>{item.displayName}を開く</button>)}<small>{s.relationNames[link.relation] ?? s.unsupported}{link.exists === false && " / " + s.noTarget}{link.line != null && " / " + s.linesUnit + " " + link.line}</small>
  </article>)}</div>;
}
export function ItemDetail({ item, catalog, api, onBack, onSkill, onOpen, sourceLine }: {
  item: DesignItem; catalog: AgentDesignCatalog; api: AgentDesignApi; onBack: () => void; onSkill: (id?: string) => void;
  onOpen?: (id: string, line?: number) => void; sourceLine?: number;
}) {
  const [doc, setDoc] = useState<DesignDocument | null>(null); const [error, setError] = useState(false); const [navigated, setNavigated] = useState(false);
  const epoch = useRef(0);
  const load = (relative?: string, offset?: number) => {
    const current = ++epoch.current; setError(false); setDoc(null); setNavigated(relative !== undefined);
    void api.document(item.id, catalog.cwd, relative, offset).then(value => {
      if (current === epoch.current) setDoc(value);
    }).catch(() => { if (current === epoch.current) setError(true); });
  };
  useEffect(() => {
    let alive = true; setError(false); setDoc(null); setNavigated(false); const request = ++epoch.current;
    void api.document(item.id, catalog.cwd).then(value => { if (alive && request === epoch.current) setDoc(value); }).catch(() => { if (alive && request === epoch.current) setError(true); });
    return () => { alive = false; epoch.current++; };
  }, [api, item.id, item.modifiedAt, catalog.cwd, catalog.generatedAt]);
  useEffect(() => setNavigated(false), [sourceLine]);
  const reveal = doc?.revision && api.reveal ? (mask: number) => api.reveal!(item.id, catalog.cwd, doc.relative ?? null, mask, doc.revision!) : undefined;
  const links = catalog.links.filter(link => link.from === item.id || link.to === item.id || link.targetPath === item.path || (item.kind === "hooks" && link.sourceService === item.service && ["executes", "declaredCall", "generates"].includes(link.relation)));
  const service = catalog.services.find(service => service.id === item.service);
  return <section className="ad-item-detail" aria-label={s.contents}>
    <button className="ad-back" onClick={onBack}><ArrowLeft size={13} />{s.back}</button>
    <h2>{item.displayName}</h2><div className="ad-meta"><ServiceMark id={item.service} /><Badge value={item.readTiming} /><Badge value={item.evidence} evidence /><span>{sizeText(item.size)}</span></div>
    <div className="ad-item-basics"><section><h3>{s.location}</h3><code className="ad-path">{item.path ?? "製品に組み込み"}</code></section><section><h3>{s.modified}</h3><p>{dateTime(item.modifiedAt)}</p><small>更新日時と、読まれた日時は別です。</small></section></div>
    <Facts layer={item.layer} item={item} catalog={catalog} />
    {item.conditions.length > 0 && <p>ファイルの条件 <code>{item.conditions.join(", ")}</code>（設定から分かる条件）</p>}
    {item.kind === "shadowedInstruction" && <p>{s.overridden}</p>}
    {service && <UsageNote service={service} layer={item.layer} />}
    {(item.kind === "skill" || item.layer === 5) && <button onClick={() => onSkill(item.kind === "skill" ? item.fields.find(field => field.key === "catalogId")?.value ?? item.fields.find(field => field.key === "name")?.value ?? item.displayName : undefined)}>{item.kind === "skill" ? "スキルのページ" : s.openSkills}</button>}
    <h3>{s.contents}</h3>{error ? <p role="alert">{s.documentError}<button onClick={() => load()}>再確認</button></p> : !doc ? <p>{s.loadingDocument}</p> : <>
      <DocumentView key={item.id + ":" + doc.relative + ":" + doc.revision + ":" + sourceLine} document={doc} onFile={load} reveal={reveal} highlightLine={navigated ? undefined : sourceLine} />
      {(doc.fields.length > 0 || item.fields.length > 0) && <Fields fields={doc.fields.length ? doc.fields : item.fields} />}
    </>}
    <h3>{s.links}</h3><Links links={links} catalog={catalog} onOpen={onOpen} />
  </section>;
}

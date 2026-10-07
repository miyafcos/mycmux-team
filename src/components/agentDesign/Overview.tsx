import { ArrowRight } from "lucide-react";
import type { AgentDesignApi, AgentDesignCatalog, DesignItem, DesignService } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, chars } from "./agentDesignStrings";
import { AmountBand, Badge, ItemDetail, LayerSummary, Links, layerIcons } from "./ui";
export interface OverviewProps { catalog: AgentDesignCatalog; service: DesignService; api: AgentDesignApi; layer: number; setLayer: (n: number) => void; selected: string | null; setSelected: (id: string | null) => void; onSkill: (id?: string) => void; query: string }
export const matchesItem = (item: DesignItem, query: string) => !query || [item.displayName, item.path, s.kinds[item.kind], ...item.fields.map(f => f.value)].some(v => v?.toLowerCase().includes(query.toLowerCase()));
export function Overview({ catalog, service, api, layer, setLayer, selected, setSelected, onSkill, query }: OverviewProps) {
  const items = catalog.items.filter(i => i.service === service.id); const selectedItem = items.find(i => i.id === selected);
  const inLayer = items.filter(i => i.layer === layer && matchesItem(i, query));
  const links = catalog.links.filter(l => inLayer.some(i => i.id === l.from || i.id === l.to) || (l.sourceService === service.id && (l.targetService !== service.id || (layer === 6 && ["executes", "declaredCall", "generates"].includes(l.relation)))));
  const Icon = layerIcons[layer];
  return <div className="ad-split ad-overview" data-ad-view="overview">
    <main className="ad-main"><AmountBand service={service} />
      <div className="ad-layers" role="listbox" aria-label={s.layers} tabIndex={0} aria-activedescendant={"ad-layer-" + layer}>
        {[7, 6, 5, 4, 3, 2, 1].filter(n => !query || s.layerNames[n].includes(query) || items.some(i => i.layer === n && matchesItem(i, query))).map(n => {
          const Mark = layerIcons[n];
          return <article id={"ad-layer-" + n} key={n} role="option" aria-selected={n === layer} tabIndex={-1} data-ad-layer={n}
            className={"ad-layer ad-layer-" + n + (n === layer ? " selected" : "")} onClick={() => { setLayer(n); setSelected(null); }}>
            <span className="ad-layer-title"><span className="ad-layer-icon"><Mark size={19} /></span><strong>{s.layerNames[n]}</strong></span>
            <LayerSummary service={service} layer={n} items={items} /><span className="ad-layer-note">{n === 5 ? <button onClick={event => { event.stopPropagation(); onSkill(); }}>{s.openSkills}<ArrowRight size={12} /></button> : s.layerNotes[n]}</span>
          </article>;
        })}</div>
      <p className="ad-layer-help">{s.layerNote}</p><div className="ad-legend" aria-label={s.legend}>{Object.entries(s.timings).map(([key]) => <span key={key}><Badge value={key} />{s.timingHelp[key]}</span>)}</div>
    </main>
    <aside className="ad-detail" aria-label={s.details}>{selectedItem ? <ItemDetail item={selectedItem} catalog={catalog} api={api} onBack={() => setSelected(null)} onSkill={onSkill} />
      : <><div className={"ad-section-title ad-tone-" + layer}><span className="ad-layer-icon"><Icon size={23} /></span><div><h2>{s.layerNames[layer]}</h2><small>{s.layerNotes[layer]}</small></div></div>
          <div className="ad-item-list">{inLayer.map(item => <button key={item.id} onClick={() => setSelected(item.id)} className={item.active ? "" : "inactive"}>
            <span><code title={item.path ?? ""}>{s.kinds[item.kind] ?? item.displayName}</code><small className="ad-path">{item.path}</small></span>
            <Badge value={item.readTiming} /><small>{item.status === "absent" ? s.absent : chars(item.size.chars)}</small>
          </button>)}{!inLayer.length && <p>{s.noItems}</p>}</div>
          {layer === 6 && <div className="ad-hook-list">{service.hooks.map((h, index) => <p key={index}><code>{h.event}</code><ArrowRight size={12} /><code>{h.script === "unsupported" ? s.unsupported : h.script}</code>{h.matcher && <small>{h.matcher}</small>}<Badge value="declaration" evidence /></p>)}</div>}
          <h3>{s.links}</h3><Links links={links} catalog={catalog} /></>}
    </aside>
  </div>;
}

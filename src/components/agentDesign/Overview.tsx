import type { AgentDesignApi, AgentDesignCatalog, DesignItem, DesignService } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, chars, number } from "./agentDesignStrings";
import { AmountBand, Badge, ItemDetail, Links } from "./ui";
import { Facts, Glossary, ItemList, UsageNote } from "./Information";
import { initialLayerChars, layerRoles, sizeText, sumSize } from "./presentation";
export interface OverviewProps { catalog: AgentDesignCatalog; service: DesignService; api: AgentDesignApi; layer: number; setLayer: (n: number) => void; selected: string | null; setSelected: (id: string | null) => void; onSkill: (id?: string) => void; query: string; onMechanism?: () => void; onReading?: () => void }
export const matchesItem = (item: DesignItem, query: string) => !query || [item.displayName, item.path, s.kinds[item.kind], ...item.fields.map(f => f.value)].some(v => v?.toLowerCase().includes(query.toLowerCase()));
export function Overview({ catalog, service, api, layer, setLayer, selected, setSelected, onSkill, query, onMechanism, onReading }: OverviewProps) {
  const items = catalog.items.filter(i => i.service === service.id); const selectedItem = items.find(i => i.id === selected);
  const inLayer = items.filter(i => i.layer === layer && matchesItem(i, query));
  const links = catalog.links.filter(l => l.sourceService === service.id || l.targetService === service.id);
  return <div className="ad-split ad-overview" data-ad-view="overview"><main className="ad-main"><AmountBand service={service} onPart={index => setLayer([3, 4, 5, 6][index])} />
    <div className="ad-actions"><button onClick={onMechanism}>しくみの地図へ</button><button onClick={onReading}>読む順番を確認</button><button onClick={() => onSkill()}>{s.openSkills}</button></div>
    <h2>7 つの層を見渡す</h2><p className="ad-muted">現在のファイルの量と、採用した会話の初期記録を分けています。今回の本文読取・最後に使った日は未収集です。</p>
    <table className="ad-dense-table ad-layers" role="listbox" aria-label={s.layers} tabIndex={0} aria-activedescendant={"ad-layer-" + layer}><thead><tr><th>層・役割</th><th>現在の項目と量</th><th>初期記録</th><th>読む時機</th><th>点検・記録</th></tr></thead><tbody>
      {[7, 6, 5, 4, 3, 2, 1].filter(n => !query || s.layerNames[n].includes(query) || items.some(i => i.layer === n && matchesItem(i, query))).map(n => {
        const group = items.filter(i => i.layer === n); const amount = sumSize(group); const timings = [...new Set(group.map(i => i.readTiming))];
        return <tr id={"ad-layer-" + n} key={n} role="option" aria-selected={n === layer} tabIndex={-1} data-ad-layer={n} className={"ad-layer" + (n === layer ? " selected" : "")} onClick={() => { setLayer(n); setSelected(null); }}>
          <th><button onClick={() => { setLayer(n); setSelected(null); }}>{s.layerNames[n]}</button><small>{layerRoles[n]}</small></th><td><strong>{number(group.length)} 件</strong><small>{sizeText(amount.size)}{amount.partial && "（取得分）"}</small></td><td>{initialLayerChars(service, n) == null ? "初期量の対象外・未計測" : chars(initialLayerChars(service, n))}</td><td>{timings.map(timing => <Badge key={timing} value={timing} />)}</td><td>{number(catalog.findings.filter(f => f.service === service.id && f.layer === n).length)} 件の指摘<small>今回の記録は未収集</small></td>
        </tr>;
      })}</tbody></table>
    <Facts layer={layer} catalog={catalog} /><UsageNote service={service} layer={layer} /><Glossary />
    <h3>このサービスにつながる全項目</h3><Links links={links} catalog={catalog} onOpen={id => setSelected(id)} />
  </main><aside className="ad-detail" aria-label={s.details}>{selectedItem ? <ItemDetail item={selectedItem} catalog={catalog} api={api} onBack={() => setSelected(null)} onSkill={onSkill} onOpen={id => setSelected(id)} /> : <><h2>{s.layerNames[layer]}</h2><p>{layerRoles[layer]}</p>{layer === 6 && <div className="ad-hook-list"><h3>出来事に合わせた処理の登録</h3>{service.hooks.map((hook, index) => <p key={index}><strong>{({ SessionStart: "会話を始めるとき", UserPromptSubmit: "依頼を送るとき", PreToolUse: "道具を使う前", PostToolUse: "道具を使った後", Stop: "回答を終えるとき", SessionEnd: "会話を終えるとき" } as Record<string, string>)[hook.event] ?? "登録された出来事"}</strong><code>{hook.event}</code><span>{hook.script === "unsupported" ? s.unsupported : hook.script}</span>{hook.matcher && <small>対象 {hook.matcher}</small>}<Badge value="declaration" evidence /></p>)}</div>}<ItemList items={inLayer} catalog={catalog} onOpen={id => setSelected(id)} onSkill={onSkill} />{layer === 5 && <button onClick={() => onSkill()}>スキルの棚を開く</button>}</>}</aside></div>;
}

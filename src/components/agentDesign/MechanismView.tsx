import type { AgentDesignCatalog, DesignService } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, bytes, chars, number } from "./agentDesignStrings";
import { AmountBand, layerIcons } from "./ui";
import { Facts, Glossary, ItemList, UsageNote } from "./Information";
import { initialLayerChars, layerRoles, mapLayers, sizeText, sumSize } from "./presentation";
import { matchesItem } from "./Overview";

export function MechanismView({ catalog, service, layer, setLayer, query, onOpen, onSkill, onReading }: {
  catalog: AgentDesignCatalog; service: DesignService; layer: number; setLayer: (layer: number) => void;
  query: string; onOpen: (id: string) => void; onSkill: (id?: string) => void; onReading: () => void;
}) {
  const items = catalog.items.filter(item => item.service === service.id);
  const selected = items.filter(item => item.layer === layer && matchesItem(item, query));
  return <div className="ad-split ad-mechanism" data-ad-view="mechanism"><main className="ad-main">
    <div className="ad-section-heading"><div><h2>会話に入る情報の地図</h2><p className="ad-intro">どの情報が、いつ会話に入るか。地図から項目を選び、中身まで確認できます。</p></div><button onClick={() => onSkill()}>{s.openSkills}</button></div>
    <p className="ad-measurement">目録 {new Date(catalog.generatedAt).toLocaleString("ja-JP")} · 読み直し 約 {(catalog.refreshMs / 1000).toFixed(1)} 秒。採用した会話の初期情報と、現在のファイルの量を分けて表示します。</p>
    <div className="ad-diagram-key"><span>実線: 会話の始めに入る情報</span><span>点線: 条件つき・必要時・会話の外</span></div>
    <div className="ad-map"><div className="ad-map-layers">{mapLayers.filter(n => !query || s.layerNames[n].includes(query) || items.some(item => item.layer === n && matchesItem(item, query))).map(n => {
      const Icon = layerIcons[n]; const inLayer = items.filter(item => item.layer === n); const total = sumSize(inLayer); const initial = initialLayerChars(service, n);
      return <button key={n} data-ad-layer={n} aria-pressed={layer === n} className={"ad-map-card ad-layer-" + n + (layer === n ? " selected" : "") + ([3, 4, 5].includes(n) ? " initial" : " additional")} onClick={() => setLayer(n)}>
        <span className="ad-layer-icon"><Icon size={18} /></span><strong>{s.layerNames[n]}</strong><b>{initial != null ? "初期 " + chars(initial) : number(inLayer.length) + " 項目"}</b>
        <span>{layerRoles[n]}</span><small>{initial == null && inLayer.length ? "ファイル " + sizeText(total.size) + (total.partial ? "（確認できた分）" : "") : n === 5 ? "一覧の名前・説明が先、本文は呼ばれたとき" : s.layerNotes[n]}</small><small>{n === 6 ? "起動の出力だけ初期量へ。他の実行記録は未収集" : number(inLayer.length) + " 項目 · 選んで中身を確認 →"}</small>
      </button>;
    })}</div><section className="ad-map-conversation"><h2>会話の始め</h2><AmountBand service={service} onPart={n => setLayer([3, 4, 5, 6][n])} />
      <p>必要時の本文や処理の登録を、初期量へ足しません。起動の処理の出力は、記録で確認できた分だけ含めます。</p><button onClick={onReading}>読む順番と量の内訳を確認 →</button>
    </section></div>
    <button className="ad-runtime-strip" data-ad-layer={1} aria-pressed={layer === 1} onClick={() => setLayer(1)}>本体 · {service.displayName}{service.version && " " + service.version} · 製品の組み込みの指示と道具の説明は別の量 · 中身を確認 →</button>
    <Facts catalog={catalog} layer={layer} /><UsageNote service={service} layer={layer} /><Glossary />
  </main><aside className="ad-detail"><h2>{s.layerNames[layer]} · {number(selected.length)} 項目</h2><p className="ad-muted">字数・更新日時・置き場所・読む時期を確認して開けます。</p>
    <ItemList items={selected} catalog={catalog} onOpen={onOpen} onSkill={onSkill} />{layer === 5 && <button onClick={() => onSkill()}>{s.openSkills}</button>}
    {service.session.bytesConsumed > 0 && <small>初期記録の取得範囲 {bytes(service.session.bytesConsumed)}。ファイルの本文の合計とは別です。</small>}
  </aside></div>;
}

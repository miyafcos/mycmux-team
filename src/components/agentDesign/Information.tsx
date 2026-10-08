import type { AgentDesignCatalog, DesignItem, DesignService } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, chars, number } from "./agentDesignStrings";
import { Badge } from "./ui";
import { dateTime, itemRole, layerEffects, layerRoles, sizeText, usageDefinition } from "./presentation";

export function Facts({ layer, item, catalog }: { layer: number; item?: DesignItem; catalog: AgentDesignCatalog }) {
  const facts = [
    ["これは何か", item ? itemRole(item, catalog) : layerRoles[layer]],
    ["いつ読まれるか", item ? s.timingHelp[item.readTiming] : s.layerNotes[layer]],
    ["どこで効くか", layer === 2 || layer === 6 ? "PC での操作・処理の範囲" : "AI が作業の方針や手順を選ぶとき"],
    ["変えるとどうなるか", layerEffects[layer]],
  ];
  return <div className="ad-facts">{facts.map(([title, body]) => <section key={title}><h3>{title}</h3><p>{body}</p></section>)}</div>;
}
export function ItemList({ items, catalog, onOpen, onSkill }: { items: DesignItem[]; catalog: AgentDesignCatalog; onOpen: (id: string, line?: number) => void; onSkill?: (id?: string) => void }) {
  return <div className="ad-item-list ad-rich-items">{items.map(item => <article key={item.id} className={item.active ? "" : "inactive"}>
    <button data-ad-open={item.id} onClick={() => onOpen(item.id)}><strong>{item.displayName}</strong><span>{itemRole(item, catalog)}</span><small>{sizeText(item.size)} · <Badge value={item.readTiming} /></small><small>{s.modified}: {dateTime(item.modifiedAt)}</small><code className="ad-path">{item.path ?? "製品に組み込み"}</code><span className="ad-open-label">{s.readDocument} →</span></button>
    {item.kind === "skill" && onSkill && <button className="ad-skill-shortcut" onClick={() => onSkill(item.fields.find(field => field.key === "catalogId")?.value ?? item.fields.find(field => field.key === "name")?.value ?? item.displayName)}>スキルのページ</button>}
  </article>)}{!items.length && <p className="ad-muted">{s.noItems}</p>}</div>;
}
export function UsageNote({ service, layer = 5 }: { service: DesignService; layer?: number }) {
  const entries = service.session.listing.entries;
  const recorded = entries.filter(entry => entry.usageRecorded === true).length;
  const absent = entries.filter(entry => entry.usageRecorded === false).length;
  return <section className="ad-usage-note"><h3>使われた記録の読み方</h3><p>{usageDefinition(layer)}</p>
    {layer === 5 && entries.some(entry => entry.usageRecorded != null) && <p>採用した一覧の中で、記録あり {number(recorded)} 本・記録なし {number(absent)} 本。{chars(entries.filter(entry => entry.usageRecorded === false).reduce((sum, entry) => sum + entry.chars, 0))} は記録なしの説明の量です。</p>}
    <p>今回の本文読取・処理実行・成功の記録は未収集。記録なしは未使用の証明ではありません。集計の開始日・網羅性は未確認です。</p>
  </section>;
}
export function Glossary() {
  return <details className="ad-glossary"><summary>言葉の意味を確認する</summary><dl>
    {[ ["スキル", "AI に作業の進め方を教える手順の文書。"], ["記憶の索引", "詳しい記憶の場所を探す案内。記憶の本文は必要なときに開きます。"], ["フック", "会話の開始や道具を使う前後など、出来事に合わせて動く処理。"], ["MCP", "外の道具と AI をつなぐ仕組み。接続数と使用回数は別です。"], ["プラグイン", "スキルや道具などをまとめて追加する単位。"], ["目録", "PC で読み直した時点の項目・数・量の一覧。現在の会話の実況とは別です。"] ].map(([term, meaning]) => <div key={term}><dt>{term}</dt><dd>{meaning}</dd></div>)}
  </dl></details>;
}

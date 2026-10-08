import type { AgentDesignCatalog } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, number } from "./agentDesignStrings";
import { dateTime } from "./presentation";
import { ItemList } from "./Information";
import { matchesItem } from "./Overview";

export function HistoryUnavailable({ catalog, query, onOpen }: { catalog: AgentDesignCatalog; query: string; onOpen: (id: string) => void }) {
  const items = catalog.items.filter(item => matchesItem(item, query));
  return <main className="ad-main ad-history" data-ad-view="history"><h2>記録の時点と対象</h2><div className="ad-facts"><section><h3>現在の目録</h3><p>{dateTime(catalog.generatedAt)}</p><p>{number(catalog.items.length)} 件 · 全サービスの 7 層</p><code className="ad-path">{catalog.cwd}</code></section><section><h3>過去の写し</h3><p>この目録では未取得です。</p><p>過去と現在の差は、まだ比較できません。</p></section><section><h3>編集の記録</h3><p>この目録では未取得です。</p><p>ファイルの更新日は、編集の履歴や読取日とは別です。</p></section><section><h3>確認できる範囲</h3><p>現在の項目と、採用した会話の初期記録。</p><p>「記録がない」を「変更がない」とは判定しません。</p></section></div>
    <h3>採用した会話</h3><table className="ad-dense-table"><thead><tr><th>サービス</th><th>開始日時</th><th>出所</th><th>記録の読み止め</th></tr></thead><tbody>{catalog.services.map(service => <tr key={service.id}><th>{service.displayName}</th><td>{dateTime(service.session.startedAt)}</td><td><code className="ad-path">{service.session.file ?? "会話の記録は未取得"}</code></td><td>{s.stopNames[service.session.stoppedAt] ?? "取得した初期記録の範囲まで"}</td></tr>)}</tbody></table>
    <h3>現在の文書を確認する · {number(items.length)} 件</h3><p className="ad-muted">上の検索欄で名前・置き場所を探せます。本文は押して開けます。</p><ItemList items={items} catalog={catalog} onOpen={onOpen} />
  </main>;
}

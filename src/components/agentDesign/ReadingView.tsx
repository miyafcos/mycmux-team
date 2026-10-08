import { useEffect, useRef, useState } from "react";
import type { AgentDesignApi, AgentDesignCatalog, DesignScene, DesignService } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, bytes, chars, number } from "./agentDesignStrings";
import { AmountBand, Badge, SessionOrigin } from "./ui";
import { Facts, Glossary, ItemList, UsageNote } from "./Information";
import { dateTime, initialLayerChars, sizeText, sumSize } from "./presentation";
import { phaseNames, phaseSteps, readingSteps, stageEvents, stepDescriptions, stepItems, stepLayers } from "./readingModel";

export function ReadingView({ catalog, service, api, query, notify, onOpen = () => {}, onSkill = () => {} }: {
  catalog: AgentDesignCatalog; service: DesignService; api: AgentDesignApi; query: string; notify: (message: string) => void;
  onOpen?: (id: string, line?: number) => void; onSkill?: (id?: string) => void;
}) {
  const [selected, setSelected] = useState(1); const [phase, setPhase] = useState<number | null>(null);
  const [path, setPath] = useState(""); const [scene, setScene] = useState<DesignScene | null>(null); const [checking, setChecking] = useState(false); const [sceneError, setSceneError] = useState(false);
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; setScene(null); setPath(""); setChecking(false); setPhase(null); setSelected(1); return () => { epoch.current++; }; }, [catalog.cwd, service.id]);
  const names = service.id === "codex" ? s.codexFlowNames : s.flowNames;
  const steps = readingSteps(catalog, service); const current = steps[selected]; const currentItems = steps.length ? stepItems(catalog, service, selected) : [];
  const hasInitial = [service.context.instructions, service.context.memory, service.context.listing, service.context.startup].some(value => value != null);
  const registrationsKnown = service.stats.hookHandlers != null;
  const hooks = (index: number) => service.hooks.filter(hook => stageEvents[steps[index]?.id]?.includes(hook.event));
  const checkScene = async () => {
    const token = ++epoch.current; setChecking(true); setSceneError(false); setScene(null);
    try { const value = await api.scene(path, catalog.cwd); if (token === epoch.current) setScene(value); }
    catch { if (token === epoch.current) { setSceneError(true); notify("条件の試算を取得できません。条件の宣言を確認し、もう一度試してください。"); } }
    finally { if (token === epoch.current) setChecking(false); }
  };
  const sceneItems = catalog.items.filter(item => item.service === service.id && scene?.itemIds.includes(item.id));
  return <div className="ad-split ad-reading" data-ad-view="reading"><main className="ad-main">
    <div className="ad-section-heading"><div><h2>起動から会話の終わりまで</h2><p className="ad-intro">読む情報と、PC が動かす処理を時間に沿って確認します。設定上の順序で、今回の実況ではありません。</p></div><button onClick={() => onSkill()}>{s.openSkills}</button></div>
    <SessionOrigin session={service.session} />
    {steps.length > 0 && <div className="ad-timeflow" aria-label="会話の時間の流れ">{phaseNames.map((name, index) => <button key={name} aria-pressed={phase === index} onClick={() => { setPhase(phase === index ? null : index); setSelected(phaseSteps[index][0]); }}>
      <small>{String(index + 1).padStart(2, "0")}</small><strong>{name}</strong><span>読むもの</span><p>{["設定と許可", "指示・索引・スキル一覧", "条件に合う指示", "スキル本文・参照資料", "読んだ情報から返事", "会話を閉じる"][index]}</p><span>動くもの</span><p>{index === 0 ? "実行環境を用意" : !registrationsKnown ? "登録の内訳は未取得" : number(phaseSteps[index].reduce((sum, step) => sum + hooks(step).length, 0)) + " 処理の登録"}</p><small>{index === 1 ? "初期情報を確認" : "設定から分かる予定"}</small>
    </button>)}</div>}
    <div className="ad-evidence-grid"><section><h3>初期部分で確認</h3><p>{hasInitial ? chars(service.context.knownTotal) + "。現在の指示ファイルや採用した会話の記録で確認した分です。" : "初期の量は未取得です。"}</p></section><section><h3>設定から分かる予定</h3><p>登録件数と条件を表示。実行した回数とは別です。</p></section><section><h3>今回の記録</h3><p>本文読取・処理実行・成功は未収集。記録なしを未使用と断定しません。</p></section></div>
    <div className="ad-section-heading"><h3>12 段の読み方と量</h3>{phase != null && <button onClick={() => setPhase(null)}>全12段を見る</button>}</div>
    {!steps.length ? <p>{service.state === "absent" ? "サービスのファイルがありません。" : "このサービスの読む順序は未取得です。概要の項目から内容を確認できます。"}</p> : <table className="ad-data-table ad-reading-table" aria-label="12段の読み方"><thead><tr><th>段階・内容</th><th>読む情報 / 動く処理</th><th>量・登録</th><th>確かさ・確認</th></tr></thead><tbody>{steps.map((step, index) => {
      const items = stepItems(catalog, service, index); const files = sumSize(items);
      if ((phase != null && !phaseSteps[phase].includes(index)) || (query && !(names[index] + stepDescriptions[index] + items.map(item => item.displayName + " " + item.path).join(" ")).toLowerCase().includes(query.toLowerCase()))) return null;
      return <tr key={step.id} className={"ad-flow-card" + (selected === index ? " selected" : "")} tabIndex={0} data-ad-step={step.id} aria-selected={selected === index} onFocus={() => setSelected(index)} onClick={() => setSelected(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setSelected(index); } }}>
        <th scope="row"><small>{number(index + 1)} · {s.stages[step.stage]}</small><button onClick={() => setSelected(index)}>{names[index]}</button><Badge value={step.timing} /></th>
        <td><strong>{step.id === "settings" ? "アプリが使う設定" : stageEvents[step.id] ? "PC が動かす処理" : "AI が読む情報"}</strong><small>{stepDescriptions[index]}</small></td>
        <td>{step.chars != null ? <strong>{chars(step.chars)}</strong> : <span>{stageEvents[step.id] ? "実行した回数は未収集" : step.timing === "outside" ? "会話には入らない" : "読取量は未収集"}</span>}{stageEvents[step.id] && <small>{registrationsKnown ? number(hooks(index).length) + " 処理の登録" : "登録の内訳は未取得"}</small>}{files.size.bytes != null && <small>現在のファイル {bytes(files.size.bytes)}{files.partial && "（確認できた分）"}</small>}</td>
        <td><Badge value={step.evidence} evidence /><button onClick={() => setSelected(index)}>対象 {number(items.length)} 項目を確認 →</button></td>
      </tr>;
    })}</tbody></table>}
    <h3>初期情報を層ごとに積み上げる</h3><AmountBand service={service} onPart={index => { setPhase(null); setSelected([1, 2, 3, 4][index]); }} />
    <table className="ad-data-table" aria-label="層ごとの量"><thead><tr><th>層</th><th>初期の量</th><th>現在のファイル</th><th>追加される時期</th></tr></thead><tbody>{[1, 2, 3, 4, 5, 6, 7].map(layer => {
      const items = catalog.items.filter(item => item.service === service.id && item.layer === layer); const amount = initialLayerChars(service, layer); const size = sumSize(items);
      return <tr key={layer}><th><button onClick={() => { setPhase(null); setSelected(Math.max(0, stepLayers.indexOf(layer))); }}>{s.layerNames[layer]}</button></th><td>{amount != null ? chars(amount) : layer <= 2 || layer === 7 ? "会話の初期量に含めない" : "量は未計測"}</td><td>{size.size.bytes != null ? bytes(size.size.bytes) + (size.partial ? "（確認できた分）" : "") : "大きさは未計測"}</td><td>{layer === 3 ? "毎回読む / 条件つき" : layer === 4 ? "索引は毎回 / 本文は呼ばれたとき" : layer === 5 ? "一覧は毎回 / 本文は呼ばれたとき" : s.layerNotes[layer]}</td></tr>;
    })}</tbody></table><p className="ad-muted">字数とバイトは別の単位です。現在のファイルの大きさから、今回読んだ量やトークン数を推測しません。</p><Glossary />
  </main><aside className="ad-detail"><h2>{current ? names[selected] : "読む順序は未取得"}</h2>{current && <><p>{stepDescriptions[selected]}</p><Facts catalog={catalog} layer={stepLayers[selected]} /><p className="ad-muted">選んだ段の対象 {number(currentItems.length)} 項目 · {sizeText(sumSize(currentItems).size)}（現在のファイル）</p><ItemList items={currentItems} catalog={catalog} onOpen={onOpen} onSkill={onSkill} />
    {hooks(selected).map((hook, index) => <p key={index} className="ad-muted">{hook.event} · {hook.script === "unsupported" ? s.unsupported : hook.script}{hook.line != null && " · 根拠 " + number(hook.line) + " 行"}</p>)}{[3, 8].includes(selected) && <button onClick={() => onSkill()}>{s.openSkills}</button>}</>}
    <UsageNote service={service} layer={stepLayers[selected]} /><h3>{s.scenario}</h3><p className="ad-muted">条件宣言と照らす作業例。実際に読んだ記録とは別です。</p><div className="ad-actions"><button onClick={() => { epoch.current++; setChecking(false); setPath("src/example.tsx"); setScene(null); }}>画面を変更する例</button><button onClick={() => { epoch.current++; setChecking(false); setPath("docs/example.md"); setScene(null); }}>文書を変更する例</button></div>
    <label className="ad-form-field">{s.touchedPath}<input aria-label={s.touchedPath} value={path} onChange={event => { epoch.current++; setChecking(false); setPath(event.target.value); setScene(null); }} placeholder={s.touchedPathPlaceholder} /></label><button disabled={checking || !path.trim()} onClick={() => void checkScene()}>{s.checkScenario}</button><p className="ad-muted">{s.scenarioNote}</p>
    {sceneError && <p role="status">試算を取得できませんでした。</p>}{scene && <section role="status"><strong>{sceneItems.length ? s.conditionalAdded + (scene.chars != null && sceneItems.length === scene.itemIds.length ? " · " + chars(scene.chars) : "") : s.noConditional}</strong><ItemList items={sceneItems} catalog={catalog} onOpen={onOpen} /><Badge value="declaration" evidence /></section>}
    <h3>採用した初期記録の範囲</h3><code className="ad-path">{service.session.file ?? "記録を取得できません"}</code><p className="ad-muted">開始 {dateTime(service.session.startedAt)} · {number(service.session.linesRead)} 行 · {bytes(service.session.bytesConsumed)} · {s.stopNames[service.session.stoppedAt] ?? s.unsupported}</p>
  </aside></div>;
}

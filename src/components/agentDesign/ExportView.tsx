import { useEffect, useMemo, useRef, useState } from "react";
import { save as chooseFile } from "@tauri-apps/plugin-dialog";
import { agentDesignExportApi, type AgentDesignCatalog, type AgentDesignExportApi, type AgentExportOptions, type AgentExportPreview, type ExportDocument } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, number, bytes } from "./agentDesignStrings";
import { dateTime, itemRole, sizeText } from "./presentation";
import "./export.css";

export const exportTitle = "書き出し";
export interface ExportViewProps { catalog: AgentDesignCatalog; api?: AgentDesignExportApi; query?: string; onOpen?: (id: string) => void }
const errors: Record<string, string> = {
  exportChanged: "確認のあとに目録が変わりました。もう一度選び直して確認してください。",
  exportFileExists: "同じ名前のファイルがあります。新しい名前で保存してください。",
  exportNamesUnavailable: "名前の一覧を読めません。書き出しを止めています。",
  exportSectionRequired: "指示の文書は見出しごとに選んでください。",
};
export function ExportView({ catalog, api = agentDesignExportApi, query = "", onOpen }: ExportViewProps) {
  const [services, setServices] = useState(["claude", "codex", "hermes"]);
  const [layers, setLayers] = useState([1, 2, 3, 5, 6, 7]);
  const [documents, setDocuments] = useState<ExportDocument[]>([]);
  const [choices, setChoices] = useState<Record<string, string[] | null>>({});
  const [preview, setPreview] = useState<AgentExportPreview | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [pending, setPending] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [list, setList] = useState<{ path: string; content: string } | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listRevision, setListRevision] = useState(0);
  const serial = useRef(0);
  const lifetime = useRef(0);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [documentRetry, setDocumentRetry] = useState(0);
  const [documentsFailed, setDocumentsFailed] = useState(false);
  const [rechecking, setRechecking] = useState<string[]>([]);
  const cwd = catalog.cwd;
  useEffect(() => {
    let active = true; lifetime.current++;
    setChoices({}); setPreview(null); setDocuments([]); setList(null); setDocumentsFailed(false); setRechecking([]);
    void api.documents(cwd).then(data => { if (active) setDocuments(data); }).catch(() => { if (active) { setDocumentsFailed(true); setNotice("本文を選べる文書を取得できません。再確認してください。"); } });
    return () => { active = false; lifetime.current++; };
  }, [api, cwd, catalog.generatedAt, documentRetry]);
  const options = useMemo<AgentExportOptions>(() => ({
    services, layers, documents: Object.entries(choices)
      .filter(([id, parts]) => (parts === null || parts.length > 0) && documents.some(d => d.id === id && services.includes(d.service) && layers.includes(d.layer)))
      .map(([id, sections]) => ({ id, sections })),
  }), [services, layers, choices, documents]);
  const requestKey = JSON.stringify(options);
  useEffect(() => {
    const token = ++serial.current;
    setPending(true); setPreview(null); setVerifiedAt(null); setNotice("");
    const timer = setTimeout(() => {
      void api.preview(options, cwd).then(data => {
        if (token === serial.current) { setPreview(data); setPreviewKey(requestKey); setVerifiedAt(new Date().toISOString()); }
      }).catch(error => {
        if (token === serial.current) setNotice(errors[String(error)] ?? "書き出し前の確認に失敗しました。保存はしていません。");
      }).finally(() => { if (token === serial.current) setPending(false); });
    }, 200);
    return () => { clearTimeout(timer); serial.current++; };
  }, [api, options, cwd, requestKey, catalog.generatedAt, listRevision]);
  const toggleService = (id: string) => setServices(before => before.includes(id) ? before.filter(v => v !== id) : [...before, id]);
  const toggleLayer = (id: number) => setLayers(before => before.includes(id) ? before.filter(v => v !== id) : [...before, id]);
  const toggleBody = (id: string) => setChoices(before => { const after = { ...before }; if (id in after) delete after[id]; else after[id] = null; return after; });
  const toggleSection = (id: string, part: string) => setChoices(before => {
    const parts = before[id] ?? [];
    return { ...before, [id]: parts.includes(part) ? parts.filter(p => p !== part) : [...parts, part] };
  });
  const duplicateOmissionLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of preview?.omissions ?? []) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    return new Set([...counts].filter(([, count]) => count > 1).map(([label]) => label));
  }, [preview]);
  const canSave = !!preview && previewKey === requestKey && preview.hits.length === 0 && !pending && !saving && !listBusy && !list && rechecking.length === 0;
  const save = async () => {
    if (!canSave || !preview) return;
    const token = serial.current;
    setSaving(true); setNotice("");
    try {
      const path = await chooseFile({ title: "設計書の保存先を選ぶ", defaultPath: "agent-design.html", filters: [{ name: "HTML", extensions: ["html"] }] });
      if (!path || token !== serial.current) return;
      const result = await api.save(options, preview.fingerprint, path, cwd);
      if (token !== serial.current) return;
      setPreview(result.preview);
      setNotice(result.saved ? "書き出しました: " + result.path : "名前の検査で保存を止めました。対象の語を確認してください。");
    } catch (error) { if (token === serial.current) setNotice(errors[String(error)] ?? "保存に失敗しました。保存先を確認して、もう一度書き出してください。"); }
    finally { setSaving(false); }
  };
  const openList = async () => {
    const token = lifetime.current;
    setListBusy(true); setNotice("");
    try { const data = await api.names(); if (token === lifetime.current) setList(data); } catch { setNotice("名前の一覧を開けません。"); } finally { setListBusy(false); }
  };
  const saveList = async () => {
    if (!list) return;
    setListBusy(true);
    try { await api.saveNames(list.content); setList(null); setListRevision(n => n + 1); }
    catch { setNotice("名前の一覧を保存できません。"); }
    finally { setListBusy(false); }
  };
  const recheck = async (id: string) => {
    if (!api.recheck) return;
    const token = lifetime.current;
    setRechecking(previous => [...previous, id]);
    try {
      const data = await api.recheck(id, cwd);
      if (token === lifetime.current) setDocuments(previous => previous.map(doc => doc.id === id ? data : doc));
    } catch {
      if (token === lifetime.current) setDocuments(previous => previous.map(doc => doc.id === id ? { ...doc, available: false, reason: "recheckFailed" } : doc));
    } finally { if (token === lifetime.current) setRechecking(previous => previous.filter(value => value !== id)); }
  };
  const availabilityReason = (doc: ExportDocument) => doc.reason === "truncated" ? "本文が長く、一部だけ取得しています。全体を添付できません。" : doc.reason === "recheckFailed" ? "本文の取得に失敗しました。再確認してください。" : doc.reason ? s.documentReasons[doc.reason] ?? "この本文を取得できません。開いて理由を確認してください。" : "本文は未取得です。開いて理由を確認するか、目録を読み直してください。";
  const matching = documents.filter(d => !query || (d.label + " " + d.path + " " + d.sections.map(p => p.label).join(" ")).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const targets = catalog.items.filter(item => services.includes(item.service) && layers.includes(item.layer) && item.layer !== 4 && item.kind !== "privateCount");
  const activeDocuments = documents.filter(doc => services.includes(doc.service) && layers.includes(doc.layer));
  const available = activeDocuments.filter(doc => doc.available);
  return <div className="ad-export" data-ad-view="export">
    <section className="ad-main ad-export-selection" aria-label="書き出す内容の選択">
      <h2>設計書を1冊のHTMLにする</h2>
      <p>1 対象を選ぶ → 2 本文を開いて添付を選ぶ → 3 外したものと名前の検査を確認 → 4 保存する。</p>
      <p className="ad-muted">本文は初めは選択しません。記憶・秘密・会話本文はいつも外します。</p>
      <div className="ad-facts"><section><h3>対象</h3><p>{number(targets.length)} 項目 / 全 {number(catalog.items.length)} 項目</p></section><section><h3>本文を選べる対象</h3><p>{number(available.length)} 本 / 候補 {number(activeDocuments.length)} 本</p><p>未取得 {number(activeDocuments.length - available.length)} 本</p></section><section><h3>添付の選択</h3><p>{number(options.documents.length)} 本</p><p>指示は見出しごとに選択</p></section><section><h3>目録の時点</h3><p>{dateTime(catalog.generatedAt)}</p><p>一時表示した鍵の値は含めません。</p></section></div>
      <fieldset><legend>入れるサービス</legend><div className="ad-export-checks">
        {catalog.services.map(service => <label key={service.id}><input type="checkbox" checked={services.includes(service.id)} onChange={() => toggleService(service.id)} disabled={saving} />{service.displayName} · {number(catalog.items.filter(item => item.service === service.id && layers.includes(item.layer) && item.layer !== 4 && item.kind !== "privateCount").length)} 項目</label>)}
      </div></fieldset>
      <fieldset><legend>入れる層</legend><div className="ad-export-checks">
        {[1, 2, 3, 4, 5, 6, 7].map(layer => <label key={layer}><input type="checkbox" checked={layer !== 4 && layers.includes(layer)} onChange={() => toggleLayer(layer)} disabled={layer === 4 || saving} />{layer} {s.layerNames[layer]} · {number(catalog.items.filter(item => item.layer === layer && services.includes(item.service) && item.kind !== "privateCount").length)} 項目{layer === 4 && "（いつも外す）"}</label>)}
      </div></fieldset>
      <fieldset><legend>本文を入れる文書を選ぶ · 表示 {number(matching.length)} 本</legend>
        <p className="ad-muted">指示の文書は見出しごとに選びます。選ぶ範囲は、次の見出しまでです。</p>
        <button onClick={() => setDocumentRetry(n => n + 1)} disabled={saving}>本文の可否を再確認</button>
        {documentsFailed && <p role="alert">本文の可否の取得に失敗しました。</p>}
        <table className="ad-dense-table ad-export-documents"><thead><tr><th>文書・役割・場所</th><th>サービス・量・更新</th><th>本文を添付する範囲</th></tr></thead><tbody>
          {matching.map(doc => {
            const enabled = doc.available && services.includes(doc.service) && layers.includes(doc.layer) && !saving && !rechecking.includes(doc.id);
            const item = catalog.items.find(item => item.id === doc.id);
            return <tr key={doc.id}><th><strong>{doc.label}</strong>{item && <small>{itemRole(item, catalog)} · {s.timings[item.readTiming]}</small>}<code className="ad-path">{doc.path}</code>{onOpen && <button data-ad-open={doc.id} onClick={() => onOpen(doc.id)}>本文を開いて確認</button>}{api.recheck && <button disabled={saving || rechecking.includes(doc.id)} onClick={() => void recheck(doc.id)}>{rechecking.includes(doc.id) ? "可否を取得中" : "この本文の可否を再確認"}</button>}</th><td>{doc.service} · {s.layerNames[doc.layer]}{item && <><small>{sizeText(item.size)}</small><small>{dateTime(item.modifiedAt)}</small></>}</td><td>
              {doc.sectioned ? doc.sections.map(part => <label key={part.id}><input type="checkbox" checked={choices[doc.id]?.includes(part.id) ?? false} onChange={() => toggleSection(doc.id, part.id)} disabled={!enabled} />{part.label}<small>{number(part.chars)} 字</small></label>) : <label><input type="checkbox" aria-label={doc.label + "の本文を添付"} checked={doc.id in choices} onChange={() => toggleBody(doc.id)} disabled={!enabled} />本文を添付する</label>}
              {!doc.available ? <p>{availabilityReason(doc)}</p> : !services.includes(doc.service) || !layers.includes(doc.layer) ? <p>サービスまたは層を選んでいません。</p> : <small>取得済みの本文 · 鍵の値を除外</small>}
            </td></tr>;
          })}
        </tbody></table>
        {matching.length === 0 && <p className="ad-muted">この範囲に本文を選べる文書はありません。</p>}
      </fieldset>
    </section>
    <section className="ad-detail ad-export-confirm" aria-label="書き出す前の確認">
      <h2>保存前の確認</h2><div className="ad-facts"><section><h3>選択後の対象</h3><p>{number(targets.length)} 項目</p></section><section><h3>対象から外した項目</h3><p>{number(catalog.items.length - targets.length)} 項目</p></section><section><h3>付録</h3><p>{number(options.documents.length)} 本を選択</p></section><section><h3>設計書の大きさ</h3><p>{preview ? bytes(preview.bytes) : "生成後に確認"}</p></section></div>
      <h3>外したもの</h3>
      <p className="ad-muted">書き出す前に必ず確認します。</p>
      {preview ? <ul className="ad-export-omissions">
        {preview.omissions.map((item, index) => <li key={index}><strong>{item.label}</strong>
          {duplicateOmissionLabels.has(item.label) && item.path && <small className="ad-path">{item.path}</small>}
          <small>{(item.kind === "memory" || item.count > 0) && item.count + " 件 · "}{item.reason}</small>
        </li>)}
      </ul> : <p role="status">外したものを確認しています。</p>}
      <h3>名前の検査</h3>
      <p className="ad-muted">検査の対象は生成した HTML です。検査日時: {dateTime(verifiedAt)}。ホームは ~ に置き換えます。OSの利用者名・メール・電話と、一覧の語を、保存直前にも検査します。</p>
      <button onClick={() => void openList()} disabled={listBusy || saving}>書き出しの検査用の名前リストを編集</button>
      <p className="ad-muted">このリストは書き出しの検査だけに使います。</p>
      {list && <div className="ad-export-names"><p className="ad-path">{list.path}</p><label>1行に1語<textarea aria-label="名前の一覧" value={list.content} onChange={event => setList({ ...list, content: event.target.value })} maxLength={65536} rows={5} /></label><button onClick={() => void saveList()} disabled={listBusy}>一覧を保存して検査</button><button onClick={() => setList(null)} disabled={listBusy}>閉じる</button></div>}
      <div className="ad-export-hits" role={preview?.hits.length ? "alert" : "status"}>
        {pending ? "検査中" : preview ? "保存を止める名前 " + number(preview.hits.length) + " 件" : "検査できません。書き出しを止めています。"}
        {!!preview?.hits.length && <ul>{preview.hits.map((hit, index) => <li key={index}><code>{hit.term}</code> · HTML {hit.line} 行 ({hit.kind === "list" ? "一覧" : hit.kind === "osUser" ? "OSの利用者名" : hit.kind === "email" ? "メール" : "電話"})</li>)}</ul>}
      </div>
      {preview?.hits.length === 0 && !pending && <p className="ad-muted">この検査条件では該当 0 件です。一覧にない名前をすべて確認したという意味ではありません。</p>}
      <div className="ad-export-save"><small>{preview && "付録の文書 " + preview.documentCount + " 本 · " + bytes(preview.bytes)}</small><button className="primary" onClick={() => void save()} disabled={!canSave}>{saving ? "保存中" : "設計書を保存"}</button></div>
      {notice && <p className="ad-export-notice" role="status">{notice}</p>}
    </section>
  </div>;
}

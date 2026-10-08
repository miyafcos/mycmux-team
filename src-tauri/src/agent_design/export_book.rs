use super::{export_privacy as privacy, model::*};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt::Write as _;
use sha2::{Digest, Sha256};

const LAYERS: [&str; 7] = ["本体", "実行の設定と権限", "指示とルール", "記憶と記録", "道具と手順", "自動化", "参照資料と設計"];
fn defaults_services() -> Vec<String> { ["claude", "codex", "hermes"].map(str::to_owned).to_vec() }
fn defaults_layers() -> Vec<u8> { (1..=7).filter(|n| *n != 4).collect() }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentChoice { pub id: String, pub sections: Option<Vec<String>> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportOptions {
    #[serde(default = "defaults_services")] pub services: Vec<String>,
    #[serde(default = "defaults_layers")] pub layers: Vec<u8>,
    #[serde(default)] pub documents: Vec<DocumentChoice>,
}
impl Default for ExportOptions {
    fn default() -> Self { Self { services: defaults_services(), layers: defaults_layers(), documents: vec![] } }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionChoice { pub id: String, pub label: String, pub chars: usize }
struct Section { choice: SectionChoice, body: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectableDocument {
    pub id: String, pub service: String, pub layer: u8, pub label: String,
    pub path: String, pub sectioned: bool, pub available: bool, pub reason: Option<String>, pub sections: Vec<SectionChoice>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Omission {
    pub kind: String, pub label: String, pub reason: String, pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")] pub path: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview {
    pub fingerprint: String, pub omissions: Vec<Omission>, pub hits: Vec<privacy::NameHit>,
    pub document_count: usize, pub bytes: usize,
    #[serde(skip_serializing)] pub html: String,
}
pub(super) fn memory(item: &Item) -> bool {
    item.layer == 4 || item.kind.to_ascii_lowercase().contains("memory")
        || item.path.as_deref().is_some_and(|p| p.replace('\\', "/").split('/').any(|s| ["memory", "memories", "rollout_summaries", "sessions", "projects"].contains(&s.to_ascii_lowercase().as_str())))
}
pub(super) fn allowed(item: &Item) -> bool {
    item.service != "hermes" && !memory(item) && item.status == "present"
        && (item.document_allowed && ["instruction", "override", "shadowedInstruction", "rule", "reference", "agent", "command"].contains(&item.kind.as_str()) || item.kind == "skill")
        && item.path.as_deref().is_some_and(|p| !super::safe::private(std::path::Path::new(p)))
}
fn sectioned(item: &Item) -> bool { ["instruction", "override", "shadowedInstruction"].contains(&item.kind.as_str()) }
fn sections(body: &str) -> Vec<Section> {
    let lines: Vec<&str> = body.split_inclusive('\n').collect();
    let mut starts = vec![];
    let mut fence: Option<(char, usize)> = None;
    for (n, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        let first = trimmed.chars().next().unwrap_or(' ');
        let length = trimmed.chars().take_while(|c| *c == first).count();
        if let Some((marker, width)) = fence {
            if first == marker && length >= width && trimmed[length..].trim().is_empty() { fence = None; }
            continue;
        }
        if ['`', '~'].contains(&first) && length >= 3 { fence = Some((first, length)); continue; }
        if line.len() - trimmed.len() > 3 { continue; }
        if first == '#' && length <= 6 && trimmed[length..].starts_with(char::is_whitespace) {
            starts.push((n, trimmed[length..].trim().trim_end_matches('#').trim().to_owned()));
        } else if n > 0 && ['=', '-'].contains(&first) && length >= 3 && trimmed[length..].trim().is_empty() && !lines[n - 1].trim().is_empty() {
            starts.push((n - 1, lines[n - 1].trim().to_owned()));
        }
    }
    if starts.first().is_none_or(|(n, _)| *n != 0) { starts.insert(0, (0, "見出しの前".into())); }
    starts.iter().enumerate().map(|(index, (start, label))| {
        let end = starts.get(index + 1).map(|s| s.0).unwrap_or(lines.len());
        let body = lines[*start..end].concat();
        Section { choice: SectionChoice { id: format!("section-{}", start + 1), label: label.clone(), chars: body.chars().count() }, body }
    }).filter(|s| !s.body.trim().is_empty()).collect()
}
fn doc_body<'a>(catalog: &'a Catalog, id: &str) -> Option<&'a str> { catalog.documents.get(id)?.get("body")?.as_str() }
pub(super) fn documents(catalog: &Catalog) -> Vec<SelectableDocument> {
    catalog.items.iter().filter(|i| allowed(i)).map(|item| {
        let body = doc_body(catalog, &item.id);
        SelectableDocument {
            id: item.id.clone(), service: item.service.clone(), layer: item.layer, label: item.display_name.clone(),
            path: privacy::relative(item.path.as_deref().unwrap_or(""), &catalog.home).replace('\\', "/"),
            sectioned: sectioned(item), available: body.is_some() || item.kind == "skill",
            reason: catalog.documents.get(&item.id).and_then(|d| d["reason"].as_str()).map(str::to_owned),
            sections: if sectioned(item) { body.map(sections).unwrap_or_default().into_iter().map(|s| s.choice).collect() } else { vec![] },
        }
    }).collect()
}
fn escape(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;") }
fn text(s: &str, home: &str) -> String { escape(&privacy::relative(&super::redaction::mask(s, false).body, home)) }
fn amount(value: Option<u64>) -> String { value.map(|n| n.to_string()).unwrap_or_else(|| "未取得".into()) }
fn size(size: &Size) -> String {
    let mut parts = vec![];
    if let Some(chars) = size.chars { parts.push(format!("{chars} 字")); }
    if let Some(lines) = size.lines { parts.push(format!("{lines} 行")); }
    if let Some(bytes) = size.bytes { parts.push(format!("{:.2} KB", bytes as f64 / 1024.0)); }
    parts.join(" / ")
}
fn label<'a>(key: &'a str, entries: &[(&str, &'a str)]) -> &'a str { entries.iter().find(|(id, _)| *id == key).map(|(_, word)| *word).unwrap_or("未対応") }
fn timing(key: &str) -> &str { label(key, &[("always", "毎回"), ("conditional", "条件つき"), ("onDemand", "必要なとき"), ("event", "場面ごと"), ("schedule", "時刻で"), ("outside", "会話には入らない（アプリが使う設定）"), ("private", "鍵の値は除外する")]) }
fn evidence(key: &str) -> &str { label(key, &[("measured", "取得した情報で確認"), ("product", "製品の決まり"), ("declaration", "設定から分かる"), ("estimated", "推定"), ("unknown", "根拠は未取得")]) }
fn role(key: &str) -> &str {
    label(key, &[("runtime", "製品本体"), ("settings", "実行設定"), ("settingsLocal", "作業フォルダの設定"),
    ("instruction", "始めに読む指示"), ("override", "優先する指示"), ("shadowedInstruction", "優先されなかった指示"), ("rule", "場面ごとの規則"),
    ("skill", "道具と手順"), ("skillListing", "スキルの一覧"), ("plugins", "プラグイン"), ("agent", "サブエージェント"), ("command", "コマンド"),
    ("mcp", "道具への接続"), ("hooks", "自動化の入口"), ("scheduled", "定期のジョブ"), ("reference", "参照資料"), ("script", "台本")])
}
fn safe_field(key: &str) -> bool {
    ["model", "effortLevel", "model_reasoning_effort", "approval_policy", "sandbox_mode", "defaultMode", "count", "enabled", "version", "allow", "allowLocal"].contains(&key)
}
fn secret_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    if [".env", "credentials", "auth.json", ".pem", ".key", "--token", "--api-key", "--password", "--secret"].iter().any(|p| lower.contains(p)) { return true; }
    let value = line.trim().strip_prefix("export ").unwrap_or(line.trim());
    value.split_once('=').is_some_and(|(key, _)| !key.trim().is_empty() && key.trim().chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
        || ["api_key", "api-key", "password", "access_token", "secret_key"].iter().any(|key| lower.contains(key) && (line.contains(':') || line.contains('=')))
}
fn selected_body(catalog: &Catalog, item: &Item, choice: &DocumentChoice) -> Result<(String, usize), String> {
    let body = doc_body(catalog, &item.id).ok_or("exportDocumentUnavailable")?;
    if sectioned(item) {
        let selected = choice.sections.as_ref().ok_or("exportSectionRequired")?;
        let parts = sections(body);
        if selected.is_empty() || selected.iter().collect::<BTreeSet<_>>().len() != selected.len() || selected.iter().any(|id| !parts.iter().any(|s| &s.choice.id == id)) { return Err("exportSectionUnavailable".into()); }
        let out = parts.iter().filter(|s| selected.contains(&s.choice.id)).map(|s| s.body.as_str()).collect::<Vec<_>>().join("\n");
        Ok((out, parts.len() - selected.len()))
    } else {
        if choice.sections.is_some() { return Err("exportSelectionInvalid".into()); }
        Ok((body.into(), 0))
    }
}
fn omission(kind: &str, label: impl Into<String>, reason: &str, count: usize) -> Omission { Omission { kind: kind.into(), label: label.into(), reason: reason.into(), count, path: None } }
fn located(mut row: Omission, path: Option<&str>, home: &str) -> Omission {
    row.path = path.map(|p| privacy::relative(p, home).replace('\\', "/"));
    row
}
pub(super) fn prepare(catalog: &Catalog, options: &ExportOptions, names: &[String], users: &[String]) -> Result<ExportPreview, String> {
    if catalog.schema_version != 1 { return Err("exportCatalogUnsupported".into()); }
    if options.services.is_empty() || options.services.iter().any(|id| !["claude", "codex", "hermes"].contains(&id.as_str()))
        || options.layers.is_empty() || options.layers.iter().any(|n| !(1..=7).contains(n))
        || options.services.iter().collect::<BTreeSet<_>>().len() != options.services.len()
        || options.layers.iter().collect::<BTreeSet<_>>().len() != options.layers.len()
        || options.documents.iter().map(|d| &d.id).collect::<BTreeSet<_>>().len() != options.documents.len() { return Err("exportSelectionInvalid".into()); }
    let includes = |i: &Item| options.services.contains(&i.service) && options.layers.contains(&i.layer);
    let mut omissions = vec![
        omission("memory", "記憶と記録", "いつも外す。索引・本文・置き場所・読み方の量も含めない。", catalog.items.iter().filter(|i| memory(i)).count()),
        omission("secret", "秘密", "いつも外す。設定全文・env の値・認証・鍵の詳細・MCP の設定値・hooks の引数。", 0),
        omission("conversation", "会話の本文・ログ", "いつも外す。会話のファイル名・開始の出力・根拠本文も含めない。", 0),
    ];
    for s in &catalog.services {
        if !options.services.contains(&s.id) { omissions.push(omission("service", &s.display_name, "サービスを選んでいない。", 1)); }
    }
    for n in 1..=7 {
        if n != 4 && !options.layers.contains(&n) { omissions.push(omission("layer", LAYERS[n as usize - 1], "層を選んでいない。", 1)); }
    }
    let available = documents(catalog);
    let mut appendix = Vec::new();
    for choice in &options.documents {
        let item = catalog.items.iter().find(|i| i.id == choice.id).ok_or("exportDocumentUnavailable")?;
        if !allowed(item) || !includes(item) { return Err("exportDocumentDenied".into()); }
        let (body, omitted) = selected_body(catalog, item, choice)?;
        if omitted > 0 { omissions.push(located(omission("section", &item.display_name, "選ばなかった見出しの本文。", omitted), item.path.as_deref(), &catalog.home)); }
        let mut secrets = 0;
        let body = super::redaction::mask(&body, false).body;
        let body = body.lines().map(|line| if secret_line(line) { secrets += 1; "［秘密の値・非公開の場所を除外］".to_owned() } else { line.to_owned() }).collect::<Vec<_>>().join("\n");
        if secrets > 0 { omissions.push(located(omission("secretBody", &item.display_name, "選んだ本文から秘密の値・非公開の場所を含む行を外した。", secrets), item.path.as_deref(), &catalog.home)); }
        appendix.push((item, body));
    }
    for doc in &available {
        if !options.documents.iter().any(|c| c.id == doc.id) {
            omissions.push(located(omission("document", &doc.label, if options.services.contains(&doc.service) && options.layers.contains(&doc.layer) { "本文を選んでいない。" } else { "サービスまたは層を選んでいない。" }, 1), Some(&doc.path), &catalog.home));
        }
    }
    let home = &catalog.home;
    let mut html = format!("<!doctype html>\n<html lang=\"ja\">\n<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>エージェント設計書</title>\n<style>{}</style></head>\n<body>\n<header><h1>エージェント設計書</h1>\n<p>作った日: {} ／ mycmux {} ／ 目録の日: {}</p></header>\n<section id=\"omitted\"><h2>この設計書に入れていないもの</h2>\n<p>記憶・秘密・会話本文とログはすべて外しています。本文は付録で選んだ文書・見出しだけです。</p>\n<ul>\n", STYLE, chrono::Local::now().format("%Y-%m-%d"), env!("CARGO_PKG_VERSION"), text(&catalog.generated_at, home));
    // Exported omission labels never include excluded document names or paths.
    // Those details remain on the local preview screen only.
    let counts = ["memory", "secret", "conversation", "service", "layer", "document", "section", "secretBody"];
    for kind in counts {
        let rows: Vec<_> = omissions.iter().filter(|o| o.kind == kind).collect();
        if !rows.is_empty() {
            let title = label(kind, &[("memory","記憶と記録"),("secret","秘密"),("conversation","会話の本文・ログ"),("service","選ばなかったサービス"),("layer","選ばなかった層"),("document","選ばなかった文書の本文"),("section","選ばなかった見出しの本文"),("secretBody","本文から外した秘密の行")]);
            let count = rows.iter().map(|r| r.count).sum::<usize>();
            let amount = if count > 0 { format!(": {count} 件") } else { String::new() };
            writeln!(html, "<li>{title}{amount} — {}</li>", text(&rows[0].reason, home)).unwrap();
        }
    }
    html.push_str("</ul></section>\n<main>\n");
    let visible: Vec<_> = catalog.items.iter().filter(|i| includes(i) && !memory(i) && !["privateCount", "memoryIndex", "memoryDirectory"].contains(&i.kind.as_str()) && i.path.as_deref().is_none_or(|p| !super::safe::private(std::path::Path::new(p)))).collect();
    let visible_ids: BTreeSet<_> = visible.iter().map(|i| &i.id).collect();
    for service in catalog.services.iter().filter(|s| options.services.contains(&s.id)) {
        writeln!(html, "<section><h2>{}</h2><p>製品の版: {}</p>", text(&service.display_name, home), text(service.version.as_deref().unwrap_or("版は未取得"), home)).unwrap();
        writeln!(html, "<p>この目録で取得した項目が対象です。字数・行数を数えていない欄は省いています。今回の読取・実行の回数は未収集です。</p>").unwrap();
        if service.id != "hermes" {
            if let Some(started) = &service.session.started_at { writeln!(html, "<p>採用した会話の開始: {}。この会話の初期記録だけを確認しています。</p>", text(started, home)).unwrap(); }
        }
        for layer in 1..=7 {
            writeln!(html, "<section><h3>{layer} {}</h3>", LAYERS[layer - 1]).unwrap();
            if layer == 4 { html.push_str("<p>記憶と記録はすべて外しています。</p>\n"); }
            else if !options.layers.contains(&(layer as u8)) { html.push_str("<p>この層を選んでいません。</p>\n"); }
            else {
                if layer == 6 && service.id != "hermes" {
                    for hook in &service.hooks {
                        if let (Some(event), Some(script)) = (super::safe::identifier(&hook.event), super::safe::identifier(&hook.script)) {
                            writeln!(html, "<p>フックの場面: {} ／ 台本: {}</p>", text(&event, home), text(&script, home)).unwrap();
                        }
                    }
                }
                let items: Vec<_> = visible.iter().filter(|i| i.service == service.id && i.layer as usize == layer).collect();
                if items.is_empty() { html.push_str("<p>項目はありません。</p>\n"); }
                for item in items {
                    writeln!(html, "<article><h4>{}</h4>", text(&item.display_name, home)).unwrap();
                    if service.id != "hermes" { writeln!(html, "<p>{} ／ 読まれる時期: {} ／ 出典: {}</p>", role(&item.kind), timing(&item.read_timing), evidence(&item.evidence)).unwrap(); }
                    writeln!(html, "<p>有無: {}</p>", if item.status == "present" { "あり" } else if item.status == "absent" { "無し" } else { "不明" }).unwrap();
                    if let Some(path) = &item.path { writeln!(html, "<p class=\"path\">置き場所: {}</p>", text(&path.replace('\\', "/"), home)).unwrap(); }
                    if service.id != "hermes" {
                        if item.size.chars.is_some() || item.size.lines.is_some() || item.size.bytes.is_some() {
                            writeln!(html, "<p>大きさ: {}</p>", size(&item.size)).unwrap();
                            if let Some(modified) = item.modified_at.and_then(|m| chrono::DateTime::from_timestamp_millis(m as i64)) { writeln!(html, "<p>更新日: {}</p>", modified.to_rfc3339()).unwrap(); }
                        }
                        for field in item.fields.iter().filter(|f| safe_field(&f.key)) { writeln!(html, "<p>{}: {}</p>", text(&field.key, home), text(&field.value, home)).unwrap(); }
                        if item.kind == "skill" {
                            let description = item.fields.iter().find(|f| f.key == "description").map(|f| f.value.as_str()).unwrap_or("この目録には説明がありません");
                            let shelf = item.fields.iter().find(|f| f.key == "category").map(|f| f.value.as_str()).unwrap_or("未分類 (目録に棚の指定なし)");
                            writeln!(html, "<p>説明: {} ／ 棚: {}</p>", text(description, home), text(shelf, home)).unwrap();
                        }
                        let links: Vec<_> = catalog.links.iter().filter(|l| l.from == item.id && visible_ids.contains(&l.to)).collect();
                        for link in links {
                            if let Some(target) = visible.iter().find(|i| i.id == link.to) {
                                writeln!(html, "<p>つながり: {} → {} ({})</p>", text(&item.display_name, home), text(&target.display_name, home), evidence(&link.evidence)).unwrap();
                            }
                        }
                    }
                    html.push_str("</article>\n");
                }
            }
            html.push_str("</section>\n");
        }
        html.push_str("</section>\n");
    }
    html.push_str("<section><h2>サービスの間のつながり</h2>\n");
    for link in &catalog.links {
        if !options.services.contains(&link.source_service) || !options.services.contains(&link.target_service) { continue; }
        let source = visible.iter().find(|i| i.id == link.from);
        let target = visible.iter().find(|i| i.id == link.to);
        if catalog.items.iter().any(|i| (i.id == link.from || i.id == link.to) && memory(i)) { continue; }
        let path_target = link.target_path.as_deref().filter(|p| !super::safe::private(std::path::Path::new(p)) && !p.replace('\\', "/").split('/').any(|s| ["memory","memories","sessions","projects"].contains(&s)));
        if link.target_path.is_some() && path_target.is_none() { continue; }
        if source.is_none() && !(options.layers.contains(&6) && link.relation == "executes") { continue; }
        if target.is_none() && path_target.is_none() && !["executes","declaredCall"].contains(&link.relation.as_str()) { continue; }
        let from = source.map(|i| i.display_name.as_str()).unwrap_or(&link.from);
        let to = target.map(|i| i.display_name.as_str()).or(path_target).unwrap_or(&link.to);
        let relation = label(&link.relation, &[("executes","実行"),("references","参照"),("readsSource","読む元"),("shadows","優先"),("declaredCall","呼び出しの宣言"),("generates","生成")]);
        writeln!(html, "<p>{}: {} → {} / {}</p>", relation, text(from, home), text(&to.replace('\\', "/"), home), evidence(&link.evidence)).unwrap();
    }
    html.push_str("</section>\n<section><h2>読み方の流れ</h2>\n");
    for flow in catalog.reading_flows.iter().filter(|f| options.services.contains(&f.service) && f.service != "hermes") {
        let service = catalog.services.iter().find(|s| s.id == flow.service).ok_or("exportCatalogUnsupported")?;
        writeln!(html, "<h3>{}</h3><ol>", text(&service.display_name, home)).unwrap();
        for step in &flow.steps {
            if step.id == "memory" { continue; }
            let ids: Vec<_> = visible.iter().filter(|i| step.item_ids.contains(&i.id)).map(|i| text(&i.display_name, home)).collect();
            if ids.is_empty() && step.item_ids.len() > 0 { continue; }
            let name = label(&step.id, &[("settings","起動・設定"),("instructions","始めの指示"),("listing","スキルの一覧"),("startup","起動のフック"),("request","依頼のたび"),("tools","道具のたび"),("conditional","条件つきの規則"),("skillBody","選んだスキル"),("references","参照資料"),("response","応答のたび"),("end","会話の終わり")]);
            writeln!(html, "<li>{name} — {} / {}: {}</li>", timing(&step.timing), evidence(&step.evidence), ids.join("・")).unwrap();
        }
        html.push_str("</ol>\n");
    }
    html.push_str("</section>\n<section><h2>比べる</h2><table><thead><tr><th>働き</th>");
    let selected_services: Vec<_> = catalog.services.iter().filter(|s| options.services.contains(&s.id)).collect();
    for s in &selected_services { write!(html, "<th>{}</th>", text(&s.display_name, home)).unwrap(); }
    html.push_str("</tr></thead><tbody>\n");
    if catalog.compare_rows.is_empty() {
        for layer in 1..=7 {
            if layer == 4 || !options.layers.contains(&(layer as u8)) { continue; }
            write!(html, "<tr><th>{}</th>", LAYERS[layer - 1]).unwrap();
            for s in &selected_services {
                let items: Vec<_> = visible.iter().filter(|i| i.service == s.id && i.layer as usize == layer).collect();
                write!(html, "<td>{} 件<br>{}</td>", items.len(), items.iter().map(|i| text(&i.display_name, home)).collect::<Vec<_>>().join("・")).unwrap();
            }
            html.push_str("</tr>\n");
        }
    } else {
        for row in catalog.compare_rows.iter().filter(|r| r.id != "memory") {
            let has_visible = row.cells.iter().filter(|c| options.services.contains(&c.service)).any(|c| c.item_ids.iter().any(|id| visible_ids.contains(id)));
            if !has_visible { continue; }
            let row_label = label(&row.id, &[("globalInstructions","会話の始めの指示"),("folderInstructions","作業フォルダの指示"),("rules","場面ごとの規則"),("settings","実行の設定"),("permissions","許可"),("ownSkills","自分のスキル"),("skillListing","スキルの一覧"),("plugins","プラグイン"),("agents","サブエージェント"),("mcp","道具への接続"),("hooks","フック"),("scheduled","定期のジョブ"),("references","参照資料")]);
            write!(html, "<tr><th>{row_label}</th>").unwrap();
            for service in &selected_services {
                html.push_str("<td>");
                if let Some(cell) = row.cells.iter().find(|c| c.service == service.id) {
                    let items: Vec<_> = visible.iter().filter(|i| cell.item_ids.contains(&i.id)).collect();
                    if items.is_empty() { html.push_str("選んだ項目はありません"); }
                    else {
                        html.push_str(&items.iter().map(|i| text(&i.display_name, home)).collect::<Vec<_>>().join("・"));
                        if service.id != "hermes" {
                            for field in cell.fields.iter().filter(|f| safe_field(&f.key)) { write!(html, "<br>{}: {}", text(&field.key, home), text(&field.value, home)).unwrap(); }
                            for (key, value) in cell.values.iter().filter(|(key,value)| !key.to_ascii_lowercase().contains("memory") && value.is_some()) { write!(html, "<br>{}: {}", text(key, home), amount(*value)).unwrap(); }
                        }
                    }
                } else { html.push_str("このサービスの項目は未取得"); }
                html.push_str("</td>");
            }
            html.push_str("</tr>\n");
        }
    }
    html.push_str("</tbody></table></section>\n<section><h2>点検の結果</h2><p>件数と場所だけ。根拠の本文・会話の記録・個人名は含めません。</p>\n");
    let mut finding_count = 0;
    for finding in catalog.findings.iter().filter(|f| options.services.contains(&f.service) && options.layers.contains(&f.layer) && f.layer != 4 && !f.kind.to_lowercase().contains("memory")) {
        finding_count += 1;
        let kind = label(&finding.kind, &[("disabledPlugins","切ったプラグインが一覧に載る"),("unusedListing","使われた記録がないスキル"),("implicitHidden","一覧に載らないスキル"),("shadowedAgents","優先する指示"),("duplicate","同じ名前の複数の配置"),("brokenTarget","行き先のない入口")]);
        let locations = finding.item_ids.iter().filter_map(|id| visible.iter().find(|i| &i.id == id)).filter_map(|i| i.path.as_ref()).map(|p| text(&p.replace('\\', "/"), home)).collect::<Vec<_>>().join("・");
        writeln!(html, "<p>{kind}: {} 件 / {}</p>", finding.count, if locations.is_empty() { "場所は未取得".into() } else { locations }).unwrap();
    }
    writeln!(html, "<p>指摘の項目: {finding_count} 件</p></section>\n<section><h2>付録 — 選んだ文書の本文</h2>").unwrap();
    if appendix.is_empty() { html.push_str("<p>本文は選んでいません。</p>\n"); }
    for (item, body) in &appendix {
        writeln!(html, "<article><h3>{}</h3><p>{}</p><pre>{}</pre></article>", text(&item.display_name, home), text(&item.path.as_deref().unwrap_or("").replace('\\', "/"), home), text(body, home)).unwrap();
    }
    html.push_str("</section></main>\n<footer>この1ファイルで読めます。外部のCSS・字体・画像・スクリプトは使っていません。</footer>\n</body></html>\n");
    let hits = privacy::scan(&html, names, users);
    if !hits.is_empty() { omissions.push(omission("name", "名前の検査で当たったもの", "書き出しを止めました。語とHTMLの行は名前の検査に表示します。", hits.len())); }
    Ok(ExportPreview { fingerprint: format!("{:x}", Sha256::digest(html.as_bytes())), omissions, hits, document_count: appendix.len(), bytes: html.len(), html })
}
const STYLE: &str = r#"
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0 auto;max-width:1120px;padding:24px;color:#20252b;background:#fafafa;font:15px/1.65 -apple-system,"Segoe UI","Yu Gothic UI",sans-serif}
h1{font-size:26px}h2{font-size:21px;border-bottom:1px solid #d9dfe5;padding-bottom:8px}h3{font-size:18px}h4{font-size:16px;margin:0 0 8px}
section{margin:24px 0}article{padding:14px;margin:10px 0;border:1px solid #d9dfe5;border-radius:8px;background:white}p{margin:6px 0}
p,li,h1,h2,h3,h4,td,th{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:14px}td,th{border:1px solid #d9dfe5;padding:9px;text-align:left;vertical-align:top}th{background:#f0f3f6}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 ui-monospace,Consolas,monospace;background:#f3f5f7;padding:12px;border-radius:6px}.path,footer{color:#555;font-size:13px}#omitted{padding:14px;background:#fff;border:1px solid #d9dfe5;border-left:4px solid #365b84}
@media(max-width:600px){body{padding:14px;font-size:14px}h1{font-size:23px}h2{font-size:19px}td,th{padding:5px;font-size:12px}article{padding:10px}}
"#;

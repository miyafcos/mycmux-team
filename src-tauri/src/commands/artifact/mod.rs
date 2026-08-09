mod markdown;
mod office;
mod path_resolve;

use crate::util::atomic_write::AtomicWrite;
use crate::util::task::run_blocking;
use chrono::Local;
use kuchikiki::{NodeData, NodeRef};
use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use zip::{ZipArchive, ZipWriter};

pub(crate) use path_resolve::artifact_path_from_uri;
use markdown::{html_fragment_to_markdown, looks_like_html_fragment, markdown_to_static_html};
use office::{
    docx_to_html, html_fragment_to_docx_document_xml, office_to_static_html, read_zip_text_entry,
    unsupported_docx_editing_feature,
};
use path_resolve::preview_path_for_artifact;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewArtifactInfo {
    pub preview_path: String,
    pub source_path: String,
    pub source_kind: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableArtifactSource {
    pub source_path: String,
    pub source_kind: String,
    pub content: String,
    pub raw_content: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEditableArtifactResult {
    pub source_path: String,
    pub backup_path: String,
    pub preview_path: String,
}

const MAX_ARTIFACT_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ARTIFACT_FILE_MB: u64 = MAX_ARTIFACT_FILE_BYTES / (1024 * 1024);

fn ensure_artifact_file_within_read_limit(path: &Path, action: &str) -> Result<(), String> {
    let size = std::fs::metadata(path)
        .map_err(|error| format!("Failed to inspect artifact file before {action}: {error}"))?
        .len();
    if size > MAX_ARTIFACT_FILE_BYTES {
        let size_mb = size as f64 / (1024.0 * 1024.0);
        return Err(format!(
            "file too large to {action} ({size_mb:.1} MB > {MAX_ARTIFACT_FILE_MB} MB)"
        ));
    }
    Ok(())
}

fn is_safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && !session_id.contains('/')
        && !session_id.contains('\\')
        && session_id != "."
        && session_id != ".."
}

fn sidetab_session_dir(session_id: &str) -> Result<PathBuf, String> {
    if !is_safe_session_id(session_id) {
        return Err("Invalid session id".to_string());
    }
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    Ok(home.join(".mycmux").join("sessions").join(session_id))
}

fn normalize_preview_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn is_allowed_artifact_path(session_dir: &Path, path: &Path) -> bool {
    let root = normalize_preview_path(session_dir);
    let target = normalize_preview_path(path);
    target == root.join("out.html")
        || target == root.join("out.md")
        || target.starts_with(root.join("artifacts"))
}

fn is_allowed_external_artifact_path(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}

fn is_previewable_artifact(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("html")
            | Some("htm")
            | Some("md")
            | Some("markdown")
            | Some("doc")
            | Some("docx")
            | Some("docm")
            | Some("dot")
            | Some("dotx")
            | Some("dotm")
            | Some("xls")
            | Some("xlsx")
            | Some("xlsm")
            | Some("xlsb")
            | Some("xlt")
            | Some("xltx")
            | Some("xltm")
            | Some("ppt")
            | Some("pptx")
            | Some("pptm")
            | Some("pot")
            | Some("potx")
            | Some("potm")
            | Some("pps")
            | Some("ppsx")
            | Some("ppsm")
    )
}

fn artifact_source_kind(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") => Some("html"),
        Some("md") | Some("markdown") => Some("markdown"),
        Some("doc") | Some("docx") | Some("docm") | Some("dot") | Some("dotx") | Some("dotm")
        | Some("xls") | Some("xlsx") | Some("xlsm") | Some("xlsb") | Some("xlt") | Some("xltx")
        | Some("xltm") | Some("ppt") | Some("pptx") | Some("pptm") | Some("pot") | Some("potx")
        | Some("potm") | Some("pps") | Some("ppsx") | Some("ppsm") => Some("office"),
        _ => None,
    }
}

fn validate_editable_artifact_path(source_path: &str) -> Result<(PathBuf, String), String> {
    let path = PathBuf::from(source_path);
    if !path.is_absolute() {
        return Err("Editable artifact path must be absolute".to_string());
    }
    if !path.exists() {
        return Err("Editable artifact file not found".to_string());
    }
    if !path.is_file() {
        return Err("Editable artifact path must be a file".to_string());
    }
    let Some(kind) = artifact_source_kind(&path) else {
        return Err("Editable artifact must be .html, .htm, .md, .markdown, or .docx".to_string());
    };
    if !(matches!(kind, "html" | "markdown")
        || kind == "office" && is_editable_word_artifact(&path))
    {
        return Err("Editable artifact must be .html, .htm, .md, .markdown, or .docx".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize editable artifact: {error}"))?;
    Ok((canonical, kind.to_string()))
}

fn is_editable_word_artifact(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("docx") | Some("docm") | Some("dotx") | Some("dotm")
    )
}

fn preview_info_for_artifact(
    session_id: &str,
    path: &Path,
    allow_external: bool,
) -> Result<PreviewArtifactInfo, String> {
    let preview_path = preview_path_for_artifact(session_id, path, allow_external)?;
    let source_kind = artifact_source_kind(path)
        .ok_or_else(|| "Unsupported artifact source kind".to_string())?
        .to_string();
    let source_path = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();
    Ok(PreviewArtifactInfo {
        preview_path,
        source_path,
        source_kind,
    })
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn element_name(node: &NodeRef) -> Option<String> {
    match node.data() {
        NodeData::Element(element) => Some(element.name.local.to_string()),
        _ => None,
    }
}

fn text_content(node: &NodeRef) -> String {
    match node.data() {
        NodeData::Text(text) => text.borrow().to_string(),
        _ => node
            .children()
            .map(|child| text_content(&child))
            .collect::<Vec<_>>()
            .join(""),
    }
}

fn preview_artifact_uri_for_session_v2_inner(
    session_id: String,
    uri: String,
) -> Result<PreviewArtifactInfo, String> {
    let path = artifact_path_from_uri(&uri)?;
    preview_info_for_artifact(&session_id, &path, true)
}

#[tauri::command]
pub async fn preview_artifact_uri_for_session_v2(
    session_id: String,
    uri: String,
) -> Result<PreviewArtifactInfo, String> {
    run_blocking("preview_artifact_uri_for_session_v2", move || {
        preview_artifact_uri_for_session_v2_inner(session_id, uri)
    })
    .await
}

fn read_editable_artifact_inner(source_path: String) -> Result<EditableArtifactSource, String> {
    let (path, source_kind) = validate_editable_artifact_path(&source_path)?;
    let mut raw_content = None;
    let content = match source_kind.as_str() {
        "markdown" => {
            ensure_artifact_file_within_read_limit(&path, "read")?;
            let raw = std::fs::read_to_string(&path)
                .map_err(|error| format!("Failed to read editable artifact: {error}"))?;
            raw_content = Some(raw.clone());
            markdown_to_static_html(&raw)
        }
        "html" => {
            ensure_artifact_file_within_read_limit(&path, "read")?;
            std::fs::read_to_string(&path)
                .map_err(|error| format!("Failed to read editable artifact: {error}"))?
        }
        "office" => {
            ensure_artifact_file_within_read_limit(&path, "read")?;
            docx_to_html(&path)?
        }
        _ => return Err("Unsupported editable artifact source kind".to_string()),
    };
    Ok(EditableArtifactSource {
        source_path: path.to_string_lossy().to_string(),
        source_kind,
        content,
        raw_content,
    })
}

#[tauri::command]
pub async fn read_editable_artifact(source_path: String) -> Result<EditableArtifactSource, String> {
    run_blocking("read_editable_artifact", move || {
        read_editable_artifact_inner(source_path)
    })
    .await
}

fn backup_path_for(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .ok_or_else(|| "Editable artifact file name is invalid".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Editable artifact parent directory not found".to_string())?;
    let timestamp = Local::now().format("%Y%m%d-%H%M%S");
    let candidate = parent.join(format!("{file_name}.bak-{timestamp}"));
    if !candidate.exists() {
        return Ok(candidate);
    }
    for index in 2..100 {
        let candidate = parent.join(format!("{file_name}.bak-{timestamp}-{index}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Failed to allocate backup path".to_string())
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    AtomicWrite::new("temporary save file", "Failed to replace editable artifact")
        .parent_missing("Editable artifact parent directory not found")
        .write_bytes(path, contents)
}

fn write_docx_document_xml_atomic(path: &Path, document_xml: &str) -> Result<(), String> {
    AtomicWrite::new("temporary Word file", "Failed to replace Word document")
        .parent_missing("Editable artifact parent directory not found")
        .write_with(path, |temp_file| {
            let mut replaced = false;
            let source = File::open(path)
                .map_err(|error| format!("Failed to open Word document: {error}"))?;
            let mut archive = ZipArchive::new(source)
                .map_err(|error| format!("Failed to read Word document: {error}"))?;
            let mut writer = ZipWriter::new(temp_file);
            for index in 0..archive.len() {
                let mut entry = archive
                    .by_index(index)
                    .map_err(|error| format!("Failed to inspect Word archive: {error}"))?;
                let name = entry.name().to_string();
                let options = entry.options();
                if entry.is_dir() {
                    writer
                        .add_directory(name, options)
                        .map_err(|error| format!("Failed to write Word directory entry: {error}"))?;
                    continue;
                }
                writer
                    .start_file(&name, options)
                    .map_err(|error| format!("Failed to write Word file entry: {error}"))?;
                if name == "word/document.xml" {
                    writer
                        .write_all(document_xml.as_bytes())
                        .map_err(|error| format!("Failed to write Word document body: {error}"))?;
                    replaced = true;
                } else {
                    std::io::copy(&mut entry, &mut writer)
                        .map_err(|error| format!("Failed to copy Word archive entry: {error}"))?;
                }
            }
            writer
                .finish()
                .map_err(|error| format!("Failed to finish Word archive: {error}"))?;
            if !replaced {
                return Err("Word document body entry not found".to_string());
            }
            Ok(())
        })
}

fn preview_fallback_path(path: &Path, suffix: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("artifact")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    std::env::temp_dir().join(format!("mycmux-{stem}-{:016x}.{suffix}", hasher.finish()))
}

fn write_preview_html_with_fallback(
    preferred_path: &Path,
    fallback_path: &Path,
    html: String,
    label: &str,
) -> Result<PathBuf, String> {
    match std::fs::write(preferred_path, html.as_bytes()) {
        Ok(()) => Ok(preferred_path.to_path_buf()),
        Err(primary_error) => {
            std::fs::write(fallback_path, html.as_bytes()).map_err(|fallback_error| {
                format!(
                    "Failed to refresh {label} preview: {primary_error}; fallback also failed: {fallback_error}"
                )
            })?;
            Ok(fallback_path.to_path_buf())
        }
    }
}

fn preview_path_after_save(
    path: &Path,
    source_kind: &str,
    markdown: Option<&str>,
) -> Result<String, String> {
    if source_kind == "html" {
        return Ok(path.to_string_lossy().to_string());
    }
    if source_kind == "office" {
        let preview_path = path.with_extension("office.preview.html");
        let fallback_path = preview_fallback_path(path, "office.preview.html");
        let written_path = write_preview_html_with_fallback(
            &preview_path,
            &fallback_path,
            office_to_static_html(path),
            "Word",
        )?;
        return Ok(written_path.to_string_lossy().to_string());
    }
    let markdown = markdown.ok_or_else(|| "Markdown preview content missing".to_string())?;
    let preview_path = path.with_extension("preview.html");
    let fallback_path = preview_fallback_path(path, "preview.html");
    let written_path = write_preview_html_with_fallback(
        &preview_path,
        &fallback_path,
        markdown_to_static_html(markdown),
        "markdown",
    )?;
    Ok(written_path.to_string_lossy().to_string())
}

fn save_editable_artifact_inner(
    source_path: String,
    source_kind: String,
    content: String,
) -> Result<SaveEditableArtifactResult, String> {
    let (path, actual_kind) = validate_editable_artifact_path(&source_path)?;
    if source_kind != actual_kind {
        return Err("Editable artifact source kind does not match file extension".to_string());
    }

    ensure_artifact_file_within_read_limit(&path, "save")?;
    let original = std::fs::read(&path)
        .map_err(|error| format!("Failed to read original artifact before save: {error}"))?;
    let backup_path = backup_path_for(&path)?;
    std::fs::write(&backup_path, original)
        .map_err(|error| format!("Failed to create artifact backup: {error}"))?;

    let mut markdown_preview: Option<String> = None;
    if actual_kind == "office" {
        let original_xml = read_zip_text_entry(&path, "word/document.xml")?;
        if let Some(feature) = unsupported_docx_editing_feature(&original_xml) {
            return Err(format!(
                "This Word document contains {feature}. Open it in Word for editing to avoid losing formatting."
            ));
        }
        let next_xml = html_fragment_to_docx_document_xml(&content, &original_xml);
        write_docx_document_xml_atomic(&path, &next_xml)?;
    } else {
        let next_content = if actual_kind == "markdown" {
            let markdown = if looks_like_html_fragment(&content) {
                html_fragment_to_markdown(&content)
            } else {
                content
            };
            markdown_preview = Some(markdown.clone());
            markdown
        } else {
            content
        };
        write_atomic(&path, next_content.as_bytes())?;
    }
    let preview_path = preview_path_after_save(&path, &actual_kind, markdown_preview.as_deref())?;

    Ok(SaveEditableArtifactResult {
        source_path: path.to_string_lossy().to_string(),
        backup_path: backup_path.to_string_lossy().to_string(),
        preview_path,
    })
}

#[tauri::command]
pub async fn save_editable_artifact(
    source_path: String,
    source_kind: String,
    content: String,
) -> Result<SaveEditableArtifactResult, String> {
    run_blocking("save_editable_artifact", move || {
        save_editable_artifact_inner(source_path, source_kind, content)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::markdown::markdown_to_static_html;
    use super::office::{
        docx_xml_to_html, pptx_slide_xml_to_paragraphs, xlsx_shared_strings_xml_to_vec,
        xlsx_sheet_xml_to_html,
    };
    use super::path_resolve::{
        decode_file_uri, external_markdown_preview_path, external_office_preview_path,
    };
    use super::*;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    fn write_test_docx(path: &Path, document_xml: &str) {
        let file = File::create(path).unwrap();
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let mut writer = ZipWriter::new(file);
        writer.start_file("[Content_Types].xml", options).unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            )
            .unwrap();
        writer.start_file("word/document.xml", options).unwrap();
        writer.write_all(document_xml.as_bytes()).unwrap();
        writer.finish().unwrap();
    }

    #[test]
    fn artifact_preview_allows_only_session_files() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("session-1");
        let artifacts_dir = session_dir.join("artifacts");
        std::fs::create_dir_all(&artifacts_dir).unwrap();
        let html_path = session_dir.join("out.html");
        let markdown_path = artifacts_dir.join("report.md");
        let office_path = artifacts_dir.join("report.docx");
        let outside_path = dir.path().join("outside.html");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();
        std::fs::write(&markdown_path, "# ok").unwrap();
        std::fs::write(&office_path, "office").unwrap();
        std::fs::write(&outside_path, "<h1>bad</h1>").unwrap();

        assert!(is_allowed_artifact_path(&session_dir, &html_path));
        assert!(is_allowed_artifact_path(&session_dir, &markdown_path));
        assert!(is_allowed_artifact_path(&session_dir, &office_path));
        assert!(!is_allowed_artifact_path(&session_dir, &outside_path));
        assert!(is_previewable_artifact(&markdown_path));
        assert!(is_previewable_artifact(&office_path));
        assert!(!is_previewable_artifact(&artifacts_dir.join("secret.txt")));
    }

    #[test]
    fn external_preview_allows_absolute_html_md_and_office_only() {
        let dir = tempfile::tempdir().unwrap();
        let html_path = dir.path().join("report.html");
        let markdown_path = dir.path().join("report.md");
        let word_path = dir.path().join("report.docx");
        let excel_path = dir.path().join("budget.xlsx");
        let powerpoint_path = dir.path().join("deck.pptx");
        let text_path = dir.path().join("secret.txt");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();
        std::fs::write(&markdown_path, "# ok").unwrap();
        std::fs::write(&word_path, "word").unwrap();
        std::fs::write(&excel_path, "excel").unwrap();
        std::fs::write(&powerpoint_path, "powerpoint").unwrap();
        std::fs::write(&text_path, "secret").unwrap();

        assert!(is_allowed_external_artifact_path(&html_path));
        assert!(is_allowed_external_artifact_path(&markdown_path));
        assert!(is_allowed_external_artifact_path(&word_path));
        assert!(is_previewable_artifact(&html_path));
        assert!(is_previewable_artifact(&markdown_path));
        assert!(is_previewable_artifact(&word_path));
        assert!(is_previewable_artifact(&excel_path));
        assert!(is_previewable_artifact(&powerpoint_path));
        assert!(!is_previewable_artifact(&text_path));
        assert!(!is_allowed_external_artifact_path(Path::new(
            "relative.html"
        )));
    }

    #[test]
    fn external_markdown_preview_writes_under_session_previews() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("session-1");
        let outside_markdown = dir.path().join("outside report.md");
        std::fs::write(&outside_markdown, "# ok").unwrap();

        let preview_path = external_markdown_preview_path(&session_dir, &outside_markdown).unwrap();
        assert!(preview_path.starts_with(session_dir.join("artifacts").join("previews")));
        assert_eq!(
            preview_path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("html")
        );
    }

    #[test]
    fn external_office_preview_writes_under_session_previews() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("session-1");
        let outside_doc = dir.path().join("outside report.docx");
        std::fs::write(&outside_doc, "office").unwrap();

        let preview_path = external_office_preview_path(&session_dir, &outside_doc).unwrap();
        assert!(preview_path.starts_with(session_dir.join("artifacts").join("previews")));
        assert_eq!(
            preview_path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("html")
        );
        assert!(preview_path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .unwrap()
            .contains(".office.preview.html"));
    }

    #[test]
    fn office_preview_html_escapes_path_and_labels_kind() {
        let path = Path::new(r"C:\Users\miyaz\budget & plan.xlsx");
        let html = office_to_static_html(path);

        assert!(html.contains(">Excel<"));
        assert!(html.contains("budget &amp; plan.xlsx"));
        assert!(html.contains("C:\\Users\\miyaz\\budget &amp; plan.xlsx"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn docx_xml_preview_renders_paragraphs_and_tables() {
        let html = docx_xml_to_html(
            r#"<w:document xmlns:w="w"><w:body>
                <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> world</w:t></w:r></w:p>
                <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            </w:body></w:document>"#,
        );

        assert!(html.contains("<p>Hello world</p>"));
        assert!(html.contains("<table><tbody>"));
        assert!(html.contains("<td>A1</td>"));
        assert!(html.contains("<td>B1</td>"));
    }

    #[test]
    fn docx_xml_preview_renders_word_formatting() {
        let html = docx_xml_to_html(
            r#"<w:document xmlns:w="w" xmlns:m="m"><w:body>
                <w:p>
                    <w:pPr><w:jc w:val="center"/><w:ind w:left="720"/></w:pPr>
                    <w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r>
                    <w:r><w:t> </w:t></w:r>
                    <w:r><w:rPr><w:i/><w:rFonts w:ascii="Aptos"/><w:sz w:val="28"/></w:rPr><w:t>Styled</w:t></w:r>
                </w:p>
                <w:p><w:r><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath></w:r></w:p>
            </w:body></w:document>"#,
        );

        assert!(html.contains(r#"<p style="text-align:center; margin-left:0.50in;">"#));
        assert!(html.contains("<strong>Bold</strong>"));
        assert!(html.contains("<em>Styled</em>"));
        assert!(html.contains("font-family:'Aptos'"));
        assert!(html.contains("font-size:14pt"));
        assert!(html.contains("class=\"mycmux-equation\""));
        assert!(html.contains("x+1"));
    }

    #[test]
    fn docx_xml_preview_renders_extended_run_formatting_and_empty_lines() {
        let html = docx_xml_to_html(
            r##"<w:document xmlns:w="w"><w:body>
                <w:p><w:r><w:rPr><w:u w:val="single"/><w:strike/><w:color w:val="FF0000"/><w:highlight w:val="yellow"/><w:vertAlign w:val="superscript"/></w:rPr><w:t>Marked</w:t></w:r></w:p>
                <w:p><w:r><w:t></w:t></w:r></w:p>
            </w:body></w:document>"##,
        );

        assert!(html.contains("text-decoration:underline line-through"));
        assert!(html.contains("color:#FF0000"));
        assert!(html.contains("background-color:#fff2cc"));
        assert!(html.contains("vertical-align:super"));
        assert!(html.contains("<p><br></p>"));
    }

    #[test]
    fn xlsx_xml_preview_resolves_shared_strings() {
        let shared = xlsx_shared_strings_xml_to_vec(
            r#"<sst><si><t>Name</t></si><si><t>Value</t></si></sst>"#,
        );
        let html = xlsx_sheet_xml_to_html(
            r#"<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c><v>42</v></c></row></sheetData></worksheet>"#,
            &shared,
        );

        assert!(html.contains("<td>Name</td>"));
        assert!(html.contains("<td>Value</td>"));
        assert!(html.contains("<td>42</td>"));
    }

    #[test]
    fn pptx_xml_preview_collects_slide_text() {
        let paragraphs = pptx_slide_xml_to_paragraphs(
            r#"<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>
                <a:p><a:r><a:t>Title</a:t></a:r></a:p>
                <a:p><a:r><a:t>Body</a:t></a:r></a:p>
            </p:spTree></p:cSld></p:sld>"#,
        );

        assert_eq!(paragraphs, vec!["Title".to_string(), "Body".to_string()]);
    }

    #[test]
    fn markdown_preview_escapes_raw_html_and_unsafe_links() {
        let html = markdown_to_static_html(
            "# レポート\n\n<script>alert(1)</script>\n\n- [safe](https://example.com)\n- [bad](file:///C:/Users/miyaz/.ssh/id_rsa)\n\n```\n<div>code</div>\n```",
        );
        assert!(html.contains("<h1>レポート</h1>"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(html.contains("<a href=\"https://example.com\""));
        assert!(html.contains("[bad](file:///C:/Users/miyaz/.ssh/id_rsa)"));
        assert!(html.contains("&lt;div&gt;code&lt;/div&gt;"));
        assert!(!html.contains("<script>"));
        assert!(!html.contains("href=\"file://"));
    }

    #[test]
    fn preview_info_for_html_artifact_returns_source_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let html_path = dir.path().join("report.html");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();

        let info = preview_info_for_artifact("session-1", &html_path, true).unwrap();

        assert_eq!(info.source_kind, "html");
        assert_eq!(
            normalize_preview_path(Path::new(&info.source_path)),
            normalize_preview_path(&html_path)
        );
        assert_eq!(
            normalize_preview_path(Path::new(&info.preview_path)),
            normalize_preview_path(&html_path)
        );
    }

    #[test]
    fn save_editable_artifact_creates_backup_before_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let html_path = dir.path().join("report.html");
        std::fs::write(&html_path, "<h1>old</h1>").unwrap();

        let result = save_editable_artifact_inner(
            html_path.to_string_lossy().to_string(),
            "html".to_string(),
            "<!doctype html><html><body><h1>new</h1></body></html>".to_string(),
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&html_path).unwrap(),
            "<!doctype html><html><body><h1>new</h1></body></html>"
        );
        assert!(Path::new(&result.backup_path).is_file());
        assert_eq!(
            std::fs::read_to_string(&result.backup_path).unwrap(),
            "<h1>old</h1>"
        );
        assert!(result.backup_path.contains("report.html.bak-"));
    }

    #[test]
    fn save_editable_artifact_rejects_invalid_targets() {
        let dir = tempfile::tempdir().unwrap();
        let text_path = dir.path().join("secret.txt");
        let markdown_path = dir.path().join("report.md");
        let office_path = dir.path().join("report.xlsx");
        std::fs::write(&text_path, "secret").unwrap();
        std::fs::write(&markdown_path, "# ok").unwrap();
        std::fs::write(&office_path, "office").unwrap();

        assert!(save_editable_artifact_inner(
            "relative.html".to_string(),
            "html".to_string(),
            "x".to_string()
        )
        .is_err());
        assert!(save_editable_artifact_inner(
            dir.path()
                .join("missing.html")
                .to_string_lossy()
                .to_string(),
            "html".to_string(),
            "x".to_string()
        )
        .is_err());
        assert!(save_editable_artifact_inner(
            text_path.to_string_lossy().to_string(),
            "html".to_string(),
            "x".to_string()
        )
        .is_err());
        assert!(save_editable_artifact_inner(
            dir.path().to_string_lossy().to_string(),
            "html".to_string(),
            "x".to_string()
        )
        .is_err());
        assert!(save_editable_artifact_inner(
            markdown_path.to_string_lossy().to_string(),
            "html".to_string(),
            "x".to_string()
        )
        .is_err());
        assert!(save_editable_artifact_inner(
            office_path.to_string_lossy().to_string(),
            "office".to_string(),
            "x".to_string()
        )
        .is_err());
    }

    #[test]
    fn save_docx_serializes_body_and_creates_backup() {
        let dir = tempfile::tempdir().unwrap();
        let docx_path = dir.path().join("report.docx");
        write_test_docx(
            &docx_path,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Old</w:t></w:r></w:p><w:sectPr/></w:body></w:document>"#,
        );

        let result = save_editable_artifact_inner(
            docx_path.to_string_lossy().to_string(),
            "office".to_string(),
            r#"<h1>Title</h1><p>Hello <strong>bold</strong> <em>italic</em></p><table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>"#.to_string(),
        )
        .unwrap();

        assert!(Path::new(&result.backup_path).is_file());
        assert!(Path::new(&result.preview_path).is_file());
        let saved_xml = read_zip_text_entry(&docx_path, "word/document.xml").unwrap();
        assert!(saved_xml.contains("Heading1"));
        assert!(saved_xml.contains("Hello "));
        assert!(saved_xml.contains("<w:b/>"));
        assert!(saved_xml.contains("<w:i/>"));
        assert!(saved_xml.contains("<w:tbl>"));
        assert!(saved_xml.contains(">A<"));
        let preview_html = docx_to_html(&docx_path).unwrap();
        assert!(preview_html.contains("<td>A</td>"));
        assert!(preview_html.contains("<td>B</td>"));
    }

    #[test]
    fn save_docx_serializes_word_editor_formatting() {
        let dir = tempfile::tempdir().unwrap();
        let docx_path = dir.path().join("formatted.docx");
        write_test_docx(
            &docx_path,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Old</w:t></w:r></w:p><w:sectPr/></w:body></w:document>"#,
        );

        let result = save_editable_artifact_inner(
            docx_path.to_string_lossy().to_string(),
            "office".to_string(),
            r#"<p style="text-align:right;margin-left:0.5in">Hello <span style="font-family: Aptos; font-size: 14pt"><strong>bold</strong></span> <span class="mycmux-equation" data-mycmux-equation="x^2">x^2</span></p>"#.to_string(),
        )
        .unwrap();

        assert!(Path::new(&result.backup_path).is_file());
        let saved_xml = read_zip_text_entry(&docx_path, "word/document.xml").unwrap();
        assert!(saved_xml.contains(r#"<w:jc w:val="right"/>"#));
        assert!(saved_xml.contains(r#"<w:ind w:left="720"/>"#));
        assert!(
            saved_xml.contains(r#"<w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Aptos"/>"#)
        );
        assert!(saved_xml.contains(r#"<w:sz w:val="28"/>"#));
        assert!(saved_xml.contains(r#"<w:rStyle w:val="MycmuxEquation"/>"#));
        assert!(saved_xml.contains("x^2"));
        let preview_html = docx_to_html(&docx_path).unwrap();
        assert!(preview_html.contains("text-align:right"));
        assert!(preview_html.contains("class=\"mycmux-equation\""));
    }

    #[test]
    fn save_docx_serializes_extended_run_formatting() {
        let dir = tempfile::tempdir().unwrap();
        let docx_path = dir.path().join("extended.docx");
        write_test_docx(
            &docx_path,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Old</w:t></w:r></w:p><w:sectPr/></w:body></w:document>"#,
        );

        save_editable_artifact_inner(
            docx_path.to_string_lossy().to_string(),
            "office".to_string(),
            r##"<p><span style="text-decoration: underline line-through; color: #00AAFF; background-color: #fff2cc; vertical-align: super">Marked</span></p>"##.to_string(),
        )
        .unwrap();

        let saved_xml = read_zip_text_entry(&docx_path, "word/document.xml").unwrap();
        assert!(saved_xml.contains(r#"<w:u w:val="single"/>"#));
        assert!(saved_xml.contains("<w:strike/>"));
        assert!(saved_xml.contains(r#"<w:color w:val="00AAFF"/>"#));
        assert!(saved_xml.contains(r#"<w:highlight w:val="yellow"/>"#));
        assert!(saved_xml.contains(r#"<w:vertAlign w:val="superscript"/>"#));
    }

    #[test]
    fn save_docx_rejects_unsupported_complex_word_features() {
        let dir = tempfile::tempdir().unwrap();
        let docx_path = dir.path().join("image.docx");
        write_test_docx(
            &docx_path,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:drawing/></w:r></w:p><w:sectPr/></w:body></w:document>"#,
        );

        let error = match save_editable_artifact_inner(
            docx_path.to_string_lossy().to_string(),
            "office".to_string(),
            "<p>Edited</p>".to_string(),
        ) {
            Ok(_) => panic!("complex Word document should be rejected"),
            Err(error) => error,
        };
        assert!(error.contains("images or drawings"));
        let saved_xml = read_zip_text_entry(&docx_path, "word/document.xml").unwrap();
        assert!(saved_xml.contains("<w:drawing/>"));
        assert!(!saved_xml.contains("Edited"));
    }

    #[test]
    fn markdown_dom_serializer_preserves_common_blocks_and_table_html() {
        let markdown = html_fragment_to_markdown(
            r#"
            <h2>Summary</h2>
            <p>Hello <strong>bold</strong> <em>italic</em> <a href="https://example.com">link</a></p>
            <ul><li>First</li><li>Second</li></ul>
            <ol><li>One</li><li>Two</li></ol>
            <pre><code>let x = 1;</code></pre>
            <table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>
            "#,
        );

        assert!(markdown.contains("## Summary"));
        assert!(markdown.contains("Hello **bold** *italic* [link](https://example.com)"));
        assert!(markdown.contains("- First\n- Second"));
        assert!(markdown.contains("1. One\n2. Two"));
        assert!(markdown.contains("```\nlet x = 1;\n```"));
        assert!(markdown.contains("<table>"));
        assert!(markdown.contains("<td>A</td>"));
    }

    #[test]
    fn save_markdown_serializes_dom_and_keeps_table_as_html() {
        let dir = tempfile::tempdir().unwrap();
        let markdown_path = dir.path().join("report.md");
        std::fs::write(&markdown_path, "# old").unwrap();

        let result = save_editable_artifact_inner(
            markdown_path.to_string_lossy().to_string(),
            "markdown".to_string(),
            "<h1>New</h1><p>See <a href=\"https://example.com\">link</a></p><table><tbody><tr><td>A</td></tr></tbody></table>".to_string(),
        )
        .unwrap();
        let saved = std::fs::read_to_string(&markdown_path).unwrap();

        assert!(saved.contains("# New"));
        assert!(saved.contains("[link](https://example.com)"));
        assert!(saved.contains("<table>"));
        assert!(Path::new(&result.backup_path).is_file());
        assert!(Path::new(&result.preview_path).is_file());
    }

    #[test]
    fn markdown_editor_reads_and_saves_raw_text() {
        let dir = tempfile::tempdir().unwrap();
        let markdown_path = dir.path().join("raw.md");
        let raw = "# Title\n\n- keep\n- markdown\n\n```rust\nlet x = 1;\n```\n";
        std::fs::write(&markdown_path, raw).unwrap();

        let source =
            read_editable_artifact_inner(markdown_path.to_string_lossy().to_string()).unwrap();
        assert_eq!(source.raw_content.as_deref(), Some(raw));

        let next = "# Next\n\nText with **markdown** syntax.\n";
        save_editable_artifact_inner(
            markdown_path.to_string_lossy().to_string(),
            "markdown".to_string(),
            next.to_string(),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&markdown_path).unwrap(), next);
    }

    #[test]
    fn safe_session_id_rejects_path_segments() {
        assert!(is_safe_session_id("pane-123"));
        assert!(!is_safe_session_id("../secret"));
        assert!(!is_safe_session_id("pane/secret"));
        assert!(!is_safe_session_id("pane\\secret"));
        assert!(!is_safe_session_id("."));
        assert!(!is_safe_session_id(""));
    }

    #[test]
    fn file_uri_decode_preserves_utf8_names() {
        assert_eq!(
            decode_file_uri("C:/Users/miyaz/%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.md"),
            "C:/Users/miyaz/レポート.md"
        );
        assert_eq!(
            decode_file_uri("C:/Users/miyaz/レポート.md"),
            "C:/Users/miyaz/レポート.md"
        );
    }

    #[test]
    fn file_uri_decode_survives_a_percent_before_a_multibyte_char() {
        // Reading the two hex digits by slicing the &str panicked whenever the
        // '%' was followed by a multi-byte character, and this runs over every
        // line scanned for path links - a Japanese sentence or a box-drawing
        // rule in ordinary terminal output was enough to hit it repeatedly.
        assert_eq!(decode_file_uri("100%。次へ"), "100%。次へ");
        assert_eq!(decode_file_uri("│ 50% │"), "│ 50% │");
        assert_eq!(decode_file_uri("%E3%83%AC%あ"), "レ%あ");
        // A trailing '%' has no digits left to read.
        assert_eq!(decode_file_uri("done 100%"), "done 100%");
        assert_eq!(decode_file_uri("%"), "%");
        assert_eq!(decode_file_uri("%4"), "%4");
        // Non-hex after '%' stays literal rather than being consumed.
        assert_eq!(decode_file_uri("%zz"), "%zz");
    }

    #[test]
    fn artifact_path_from_raw_windows_path_trims_cli_decoration() {
        let path = artifact_path_from_uri(r"C:\Users\miyaz\report.html＋＋＋").unwrap();
        assert_eq!(
            path.file_name().and_then(|file_name| file_name.to_str()),
            Some("report.html")
        );
    }

    #[test]
    fn artifact_path_from_uri_repairs_soft_wrap_padding_before_separator() {
        let dir = tempfile::tempdir().unwrap();
        let nested_dir = dir.path().join("folder");
        std::fs::create_dir_all(&nested_dir).unwrap();
        let html_path = nested_dir.join("report.html");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();

        let uri = html_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace("/report.html", "   /report.html");
        let path = artifact_path_from_uri(&uri).unwrap();

        assert_eq!(
            normalize_preview_path(&path),
            normalize_preview_path(&html_path)
        );
    }

    #[test]
    fn artifact_path_from_uri_collapses_soft_wrap_padding_between_words() {
        let dir = tempfile::tempdir().unwrap();
        let spaced_dir = dir.path().join("company Dropbox");
        std::fs::create_dir_all(&spaced_dir).unwrap();
        let html_path = spaced_dir.join("report.html");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();

        let uri = html_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace("company Dropbox", "company   Dropbox");
        let path = artifact_path_from_uri(&uri).unwrap();

        assert_eq!(
            normalize_preview_path(&path),
            normalize_preview_path(&html_path)
        );
    }

    #[test]
    fn artifact_path_from_uri_repairs_missing_space_at_wrap_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let spaced_dir = dir.path().join("company Dropbox");
        std::fs::create_dir_all(&spaced_dir).unwrap();
        let html_path = spaced_dir.join("report.html");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();

        let uri = html_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace("company Dropbox", "companyDropbox");
        let path = artifact_path_from_uri(&uri).unwrap();

        assert_eq!(
            normalize_preview_path(&path),
            normalize_preview_path(&html_path)
        );
    }
}

//! Office document conversion: docx/xlsx/pptx to preview HTML, and the Word
//! editor round trip back from HTML into `word/document.xml`.
//!
//! Both directions walk the OOXML by hand rather than through a document model,
//! so only the formatting the editor can produce survives; anything richer is
//! detected by `unsupported_docx_editing_feature` and refused before it can be
//! silently dropped from the user's file.

use kuchikiki::traits::TendrilSink;
use kuchikiki::{NodeData, NodeRef};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

use super::path_resolve::decode_file_uri;
use super::{element_name, ensure_artifact_file_within_read_limit, escape_html, text_content};
fn office_kind_label(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("doc") | Some("docx") | Some("docm") | Some("dot") | Some("dotx") | Some("dotm") => {
            "Word"
        }
        Some("xls") | Some("xlsx") | Some("xlsm") | Some("xlsb") | Some("xlt") | Some("xltx")
        | Some("xltm") => "Excel",
        Some("ppt") | Some("pptx") | Some("pptm") | Some("pot") | Some("potx") | Some("potm")
        | Some("pps") | Some("ppsx") | Some("ppsm") => "PowerPoint",
        _ => "Office",
    }
}

fn xml_local_name(name: &[u8]) -> &[u8] {
    name.iter()
        .position(|byte| *byte == b':')
        .map(|index| &name[index + 1..])
        .unwrap_or(name)
}

fn decode_xml_text(value: &quick_xml::events::BytesText<'_>) -> String {
    value
        .decode()
        .map(|text| text.into_owned())
        .unwrap_or_default()
}

fn xml_attr_value(element: &quick_xml::events::BytesStart<'_>, key: &[u8]) -> Option<String> {
    element.attributes().flatten().find_map(|attribute| {
        if xml_local_name(attribute.key.as_ref()) == key {
            Some(String::from_utf8_lossy(attribute.value.as_ref()).to_string())
        } else {
            None
        }
    })
}

#[derive(Clone, Debug, Default)]
struct DocxRunFormat {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    font_family: Option<String>,
    font_size_half_points: Option<u32>,
    color: Option<String>,
    highlight: Option<String>,
    vertical_align: Option<String>,
    equation: bool,
}

impl DocxRunFormat {
    fn has_properties(&self) -> bool {
        self.bold
            || self.italic
            || self.underline
            || self.strike
            || self.font_family.is_some()
            || self.font_size_half_points.is_some()
            || self.color.is_some()
            || self.highlight.is_some()
            || self.vertical_align.is_some()
            || self.equation
    }
}

#[derive(Clone, Debug, Default)]
struct DocxParagraphFormat {
    style_id: Option<String>,
    alignment: Option<String>,
    indent_twips: Option<u32>,
}

impl DocxParagraphFormat {
    fn has_properties(&self) -> bool {
        self.style_id.is_some() || self.alignment.is_some() || self.indent_twips.is_some()
    }
}

fn xml_enabled(element: &quick_xml::events::BytesStart<'_>) -> bool {
    !matches!(
        xml_attr_value(element, b"val")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "0" | "false" | "off"
    )
}

fn xml_first_attr_value(
    element: &quick_xml::events::BytesStart<'_>,
    keys: &[&[u8]],
) -> Option<String> {
    keys.iter().find_map(|key| xml_attr_value(element, key))
}

fn normalize_alignment(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "left" | "start" => Some("left".to_string()),
        "center" | "centre" => Some("center".to_string()),
        "right" | "end" => Some("right".to_string()),
        _ => None,
    }
}

fn normalize_word_hex_color(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_start_matches('#');
    if trimmed.eq_ignore_ascii_case("auto") {
        return None;
    }
    if trimmed.len() == 6 && trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(trimmed.to_ascii_uppercase())
    } else {
        None
    }
}

fn word_highlight_to_css(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "yellow" => Some("#fff2cc".to_string()),
        "green" => Some("#d9ead3".to_string()),
        "cyan" => Some("#d9eaf7".to_string()),
        "magenta" => Some("#eadcf8".to_string()),
        "blue" => Some("#cfe2f3".to_string()),
        "red" => Some("#f4cccc".to_string()),
        "darkyellow" => Some("#f1c232".to_string()),
        "darkgreen" => Some("#6aa84f".to_string()),
        "darkcyan" => Some("#45818e".to_string()),
        "darkmagenta" => Some("#674ea7".to_string()),
        "darkblue" => Some("#3d85c6".to_string()),
        "darkred" => Some("#cc0000".to_string()),
        "black" => Some("#000000".to_string()),
        "darkgray" => Some("#666666".to_string()),
        "lightgray" => Some("#d9d9d9".to_string()),
        _ => None,
    }
}

fn css_color_to_word_hex(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if let Some(hex) = normalize_word_hex_color(trimmed) {
        return Some(hex);
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "black" => Some("000000".to_string()),
        "white" => Some("FFFFFF".to_string()),
        "red" => Some("FF0000".to_string()),
        "green" => Some("008000".to_string()),
        "blue" => Some("0000FF".to_string()),
        "yellow" => Some("FFFF00".to_string()),
        _ => None,
    }
}

fn css_background_to_word_highlight(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "yellow" | "#ffff00" | "#fff2cc" => Some("yellow".to_string()),
        "green" | "#00ff00" | "#d9ead3" => Some("green".to_string()),
        "cyan" | "#00ffff" | "#d9eaf7" => Some("cyan".to_string()),
        "magenta" | "#ff00ff" | "#eadcf8" => Some("magenta".to_string()),
        "red" | "#ff0000" | "#f4cccc" => Some("red".to_string()),
        "blue" | "#0000ff" | "#cfe2f3" => Some("blue".to_string()),
        _ => None,
    }
}

fn run_font_family_from_xml(element: &quick_xml::events::BytesStart<'_>) -> Option<String> {
    xml_first_attr_value(
        element,
        &[
            b"ascii".as_ref(),
            b"hAnsi".as_ref(),
            b"eastAsia".as_ref(),
            b"cs".as_ref(),
        ],
    )
    .and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn push_style_declaration(style: &mut String, name: &str, value: &str) {
    if !style.is_empty() {
        style.push(' ');
    }
    style.push_str(name);
    style.push(':');
    style.push_str(value);
    style.push(';');
}

fn docx_half_points_to_pt(value: u32) -> String {
    if value.is_multiple_of(2) {
        (value / 2).to_string()
    } else {
        format!("{:.1}", value as f32 / 2.0)
    }
}

fn docx_run_format_html_open_close(format: &DocxRunFormat) -> (String, String) {
    let mut open = String::new();
    let mut close = String::new();
    let mut span_style = String::new();
    if let Some(font_family) = format.font_family.as_deref() {
        push_style_declaration(
            &mut span_style,
            "font-family",
            &format!("'{}'", escape_html(font_family)),
        );
    }
    if let Some(size) = format.font_size_half_points {
        push_style_declaration(
            &mut span_style,
            "font-size",
            &format!("{}pt", docx_half_points_to_pt(size)),
        );
    }
    if let Some(color) = format.color.as_deref() {
        push_style_declaration(&mut span_style, "color", &format!("#{color}"));
    }
    if let Some(highlight) = format.highlight.as_deref().and_then(word_highlight_to_css) {
        push_style_declaration(&mut span_style, "background-color", &highlight);
    }
    if let Some(vertical_align) = format.vertical_align.as_deref() {
        let css_value = match vertical_align {
            "superscript" => Some("super"),
            "subscript" => Some("sub"),
            _ => None,
        };
        if let Some(css_value) = css_value {
            push_style_declaration(&mut span_style, "vertical-align", css_value);
            push_style_declaration(&mut span_style, "font-size", "0.75em");
        }
    }
    if format.underline || format.strike {
        let mut values = Vec::new();
        if format.underline {
            values.push("underline");
        }
        if format.strike {
            values.push("line-through");
        }
        push_style_declaration(&mut span_style, "text-decoration", &values.join(" "));
    }
    if format.equation {
        open.push_str("<span class=\"mycmux-equation\" data-mycmux-equation=\"true\"");
        if !span_style.is_empty() {
            open.push_str(" style=\"");
            open.push_str(&span_style);
            open.push('"');
        }
        open.push('>');
        close.insert_str(0, "</span>");
    } else if !span_style.is_empty() {
        open.push_str("<span style=\"");
        open.push_str(&span_style);
        open.push_str("\">");
        close.insert_str(0, "</span>");
    }
    if format.bold {
        open.push_str("<strong>");
        close.insert_str(0, "</strong>");
    }
    if format.italic {
        open.push_str("<em>");
        close.insert_str(0, "</em>");
    }
    (open, close)
}

fn docx_paragraph_tag(format: &DocxParagraphFormat) -> &'static str {
    match format.style_id.as_deref() {
        Some("Heading1") | Some("heading 1") => "h1",
        Some("Heading2") | Some("heading 2") => "h2",
        Some("Heading3") | Some("heading 3") => "h3",
        _ => "p",
    }
}

fn docx_paragraph_style_attr(format: &DocxParagraphFormat) -> String {
    let mut style = String::new();
    if let Some(alignment) = format.alignment.as_deref() {
        push_style_declaration(&mut style, "text-align", alignment);
    }
    if let Some(indent) = format.indent_twips {
        let inches = indent as f32 / 1440.0;
        push_style_declaration(&mut style, "margin-left", &format!("{inches:.2}in"));
    }
    if style.is_empty() {
        String::new()
    } else {
        format!(" style=\"{}\"", style)
    }
}

fn open_office_archive(path: &Path) -> Result<ZipArchive<File>, String> {
    ensure_artifact_file_within_read_limit(path, "preview")?;
    let file = File::open(path).map_err(|error| format!("Failed to open Office file: {error}"))?;
    ZipArchive::new(file).map_err(|error| format!("Failed to read Office archive: {error}"))
}

fn read_archive_text_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    entry_name: &str,
) -> Result<String, String> {
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|error| format!("Office entry not found ({entry_name}): {error}"))?;
    let mut contents = String::new();
    entry
        .read_to_string(&mut contents)
        .map_err(|error| format!("Failed to read Office XML ({entry_name}): {error}"))?;
    Ok(contents)
}

fn archive_entry_names<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    prefix: &str,
    suffix: &str,
) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect Office archive: {error}"))?;
        let name = entry.name();
        if name.starts_with(prefix) && name.ends_with(suffix) {
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

pub(super) fn read_zip_text_entry(path: &Path, entry_name: &str) -> Result<String, String> {
    let mut archive = open_office_archive(path)?;
    read_archive_text_entry(&mut archive, entry_name)
}

fn zip_entry_names(path: &Path, prefix: &str, suffix: &str) -> Result<Vec<String>, String> {
    let mut archive = open_office_archive(path)?;
    archive_entry_names(&mut archive, prefix, suffix)
}

// --- Pictures ----------------------------------------------------------
//
// The two preview routes render the same HTML in different places: the Word
// editor hands it to an iframe through `srcDoc`, while the xlsx/pptx preview is
// written to a `.office.preview.html` beside the document and loaded over the
// asset protocol. A relative path or a custom scheme resolves in at most one of
// them, so every picture is inlined as a `data:` URI, which resolves in both.

/// Cap for one picture. base64 inflates the bytes by 4/3 and the preview HTML
/// is handed to the webview as a single string, so one oversized photo would
/// stall the pane instead of showing a document.
const MAX_PREVIEW_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// Cap for one document. A picture-heavy deck can hold dozens of photos;
/// past this point the rest are shown as placeholders rather than letting the
/// HTML grow without bound.
const MAX_PREVIEW_IMAGE_TOTAL_BYTES: usize = 24 * 1024 * 1024;

/// English Metric Units per CSS pixel: 914400 EMU per inch at 96 dpi.
const EMU_PER_PIXEL: f64 = 9525.0;

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (RFC 4648 section 4). Spelled out here because
/// the preview is the only caller in this crate that needs an encoder, and a
/// new dependency for twenty lines of arithmetic is not worth its cost.
fn base64_encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = *chunk.get(1).unwrap_or(&0) as u32;
        let third = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (first << 16) | (second << 8) | third;
        encoded.push(BASE64_ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        encoded.push(BASE64_ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            encoded.push(BASE64_ALPHABET[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
        if chunk.len() > 2 {
            encoded.push(BASE64_ALPHABET[(triple & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
    }
    encoded
}

/// Only the formats a webview actually paints. EMF, WMF and TIFF are all common
/// inside Word files and none of them render, so they are reported in place
/// instead of being emitted as an `<img>` that shows a broken icon.
fn image_mime_from_name(name: &str) -> Option<&'static str> {
    let without_query = name.split(['?', '#']).next().unwrap_or(name);
    if !without_query.contains('.') {
        return None;
    }
    let extension = without_query
        .rsplit('.')
        .next()?
        .trim()
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" | "jpe" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// What the bytes themselves say they are, for the one case where the file
/// being read was named by the document rather than found inside it.
///
/// An external relationship can point anywhere on this machine, so the name is
/// a claim and not a fact: `C:\\Users\\me\\private.png` opens whatever is at
/// that path. Reading it is only defensible while what comes back is a picture,
/// and the extension does not establish that. SVG is text and has no signature,
/// so it is recognised by its first tag instead.
fn image_mime_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if looks_like_svg(bytes) {
        return Some("image/svg+xml");
    }
    None
}

/// The first tag of an SVG, past a byte order mark, whitespace, an XML
/// declaration and a doctype. Only the opening is read: this decides whether to
/// show the file, not whether it is valid.
fn looks_like_svg(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]);
    let mut rest = text.trim_start_matches('\u{feff}').trim_start();
    for opening in ["<?xml", "<!doctype", "<!DOCTYPE"] {
        if rest.starts_with(opening) {
            let Some(after) = rest.find('>') else { return false };
            rest = rest[after + 1..].trim_start();
        }
    }
    while rest.starts_with("<!--") {
        let Some(after) = rest.find("-->") else { return false };
        rest = rest[after + 3..].trim_start();
    }
    rest.starts_with("<svg")
}

fn unsupported_format_reason(name: &str) -> String {
    let without_query = name.split(['?', '#']).next().unwrap_or(name);
    match without_query.rsplit('.').next() {
        Some(extension)
            if without_query.contains('.') && !extension.is_empty() && extension.len() <= 8 =>
        {
            format!("未対応の形式 .{}", extension.to_ascii_lowercase())
        }
        _ => "未対応の形式".to_string(),
    }
}

fn human_megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

#[derive(Clone, Debug)]
enum MediaImage {
    /// A value that can go straight into `<img src=...>`.
    Ready(String),
    /// Nothing renderable. The reason is printed where the picture belongs so
    /// that a dropped figure is visible instead of silent.
    Unavailable(String),
}

/// Relationship id (`rId7`) to picture, for one part of the package.
#[derive(Debug, Default)]
struct MediaMap {
    images: HashMap<String, MediaImage>,
}

impl MediaMap {
    /// Used by the XML-only entry points, which only the tests call.
    #[cfg_attr(not(test), allow(dead_code))]
    fn empty() -> Self {
        Self::default()
    }

    fn image_html(&self, rel_id: &str, size: Option<(u32, u32)>) -> String {
        match self.images.get(rel_id) {
            Some(MediaImage::Ready(src)) => {
                let mut html = String::from("<img src=\"");
                html.push_str(&escape_html(src));
                html.push('"');
                if let Some((width, height)) = size {
                    html.push_str(&format!(" width=\"{width}\" height=\"{height}\""));
                }
                html.push_str(" alt=\"\">");
                html
            }
            Some(MediaImage::Unavailable(reason)) => media_unavailable_html(reason),
            None => media_unavailable_html("参照先が見つかりません"),
        }
    }
}

fn media_unavailable_html(reason: &str) -> String {
    format!(
        "<span class=\"media-missing\">[図 — 表示できません ({})]</span>",
        escape_html(reason)
    )
}

#[derive(Debug)]
struct MediaRelationship {
    target: String,
    external: bool,
}

/// Reads the `<Relationship>` entries of a `.rels` part and keeps the ones that
/// point at a picture. The relationship type decides; the file extension is a
/// fallback for writers that spell the type differently.
fn parse_media_relationships(xml: &str) -> Vec<(String, MediaRelationship)> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut relationships = Vec::new();
    loop {
        let element = match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => element,
            Ok(Event::Eof) | Err(_) => break,
            _ => continue,
        };
        if xml_local_name(element.name().as_ref()) != b"Relationship" {
            continue;
        }
        let (Some(id), Some(target)) = (
            xml_attr_value(&element, b"Id"),
            xml_attr_value(&element, b"Target"),
        ) else {
            continue;
        };
        let relationship_type = xml_attr_value(&element, b"Type").unwrap_or_default();
        let is_image = relationship_type.to_ascii_lowercase().ends_with("/image")
            || image_mime_from_name(&target).is_some();
        if !is_image {
            continue;
        }
        let external = xml_attr_value(&element, b"TargetMode")
            .is_some_and(|mode| mode.eq_ignore_ascii_case("External"))
            // A target carrying a scheme is external whether or not the writer
            // said so; resolving it inside the package would go looking for a
            // folder called `https:`.
            || target.contains("://");
        relationships.push((id, MediaRelationship { target, external }));
    }
    relationships
}

fn part_directory(part_name: &str) -> &str {
    part_name
        .rfind('/')
        .map(|index| &part_name[..index])
        .unwrap_or("")
}

fn part_relationships_name(part_name: &str) -> String {
    match part_name.rfind('/') {
        Some(index) => format!(
            "{}/_rels/{}.rels",
            &part_name[..index],
            &part_name[index + 1..]
        ),
        None => format!("_rels/{part_name}.rels"),
    }
}

/// A relationship target is relative to the part that declares it, so
/// `word/document.xml` + `media/image1.png` is `word/media/image1.png`, and
/// `ppt/slides/slide1.xml` + `../media/image1.png` is `ppt/media/image1.png`.
fn resolve_package_target(part_name: &str, target: &str) -> String {
    let normalized = target.replace('\\', "/");
    let trimmed = normalized.trim();
    if let Some(absolute) = trimmed.strip_prefix('/') {
        return absolute.to_string();
    }
    let mut segments: Vec<&str> = part_directory(part_name)
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    for segment in trimmed.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments.join("/")
}

fn read_archive_image_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    entry_name: &str,
) -> Result<Vec<u8>, String> {
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|_| "画像データが見つかりません".to_string())?;
    let declared = entry.size();
    if declared > MAX_PREVIEW_IMAGE_BYTES as u64 {
        return Err(format!("画像が大きすぎます {}", human_megabytes(declared)));
    }
    // The declared size is only a header field, so the read itself is capped
    // as well: a doctored archive must not be able to fill memory here.
    let mut bytes = Vec::with_capacity(declared.min(MAX_PREVIEW_IMAGE_BYTES as u64) as usize);
    entry
        .by_ref()
        .take(MAX_PREVIEW_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "画像を読み込めません".to_string())?;
    if bytes.len() > MAX_PREVIEW_IMAGE_BYTES {
        return Err(format!(
            "画像が大きすぎます {}",
            human_megabytes(bytes.len() as u64)
        ));
    }
    Ok(bytes)
}

fn embed_media_bytes(mime: &str, bytes: &[u8], used_bytes: &mut usize) -> MediaImage {
    if bytes.is_empty() {
        return MediaImage::Unavailable("画像データが空です".to_string());
    }
    if used_bytes.saturating_add(bytes.len()) > MAX_PREVIEW_IMAGE_TOTAL_BYTES {
        return MediaImage::Unavailable("この文書の画像量が上限に達しました".to_string());
    }
    *used_bytes += bytes.len();
    MediaImage::Ready(format!("data:{mime};base64,{}", base64_encode(bytes)))
}

fn resolve_embedded_media<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    entry_name: &str,
    used_bytes: &mut usize,
) -> MediaImage {
    let Some(mime) = image_mime_from_name(entry_name) else {
        return MediaImage::Unavailable(unsupported_format_reason(entry_name));
    };
    match read_archive_image_entry(archive, entry_name) {
        Ok(bytes) => embed_media_bytes(mime, &bytes, used_bytes),
        Err(reason) => MediaImage::Unavailable(reason),
    }
}

/// `TargetMode="External"` covers two different things. A picture linked from
/// this machine is read and inlined exactly like an embedded one: the preview
/// is not served from that folder, so a relative reference would not resolve.
/// Only what `image_mime_from_name` accepts is read, and only inside the same
/// size caps, so a crafted link cannot pull an arbitrary file into the page.
///
/// A picture linked from the web is **not** fetched. Loading it would turn
/// opening a document into a request to whoever wrote it, which tells them the
/// file was opened, when, and from which address. Word and Outlook block it for
/// the same reason, and a document that arrived from outside is exactly the
/// case this preview is for. The reader is told where the picture would have
/// come from and can open the file in Word if they want it.
fn resolve_external_media(target: &str, used_bytes: &mut usize) -> MediaImage {
    let trimmed = target.trim();
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("http://") || lowered.starts_with("https://") {
        return MediaImage::Unavailable(format!(
            "外部の画像は読みに行きません ({})",
            external_media_host(trimmed)
        ));
    }
    let Some(path) = local_media_path(trimmed) else {
        return MediaImage::Unavailable("外部の参照先を開けません".to_string());
    };
    let name = path.to_string_lossy().to_string();
    let Some(mime) = image_mime_from_name(&name) else {
        return MediaImage::Unavailable(unsupported_format_reason(&name));
    };
    let Ok(metadata) = std::fs::metadata(&path) else {
        return MediaImage::Unavailable("外部ファイルが見つかりません".to_string());
    };
    if !metadata.is_file() {
        return MediaImage::Unavailable("外部ファイルが見つかりません".to_string());
    }
    if metadata.len() > MAX_PREVIEW_IMAGE_BYTES as u64 {
        return MediaImage::Unavailable(format!(
            "画像が大きすぎます {}",
            human_megabytes(metadata.len())
        ));
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return MediaImage::Unavailable("画像を読み込めません".to_string());
    };
    // The name said it was a picture; the bytes have to agree. Without this a
    // crafted document could have any readable file on this machine opened and
    // laid into the page, as long as it was named with an image extension.
    let Some(actual) = image_mime_from_bytes(&bytes) else {
        return MediaImage::Unavailable("外部ファイルが画像ではありません".to_string());
    };
    if actual != mime {
        return MediaImage::Unavailable("外部ファイルが拡張子と違う形式です".to_string());
    }
    embed_media_bytes(mime, &bytes, used_bytes)
}

/// Just the host of a web target, for the note that stands in for the picture.
/// The whole URL can be longer than the paragraph it sits in, and the host is
/// the part that answers "who would this have called".
fn external_media_host(target: &str) -> String {
    let after_scheme = target
        .split_once("//")
        .map(|(_, rest)| rest)
        .unwrap_or(target);
    let host = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme)
        .trim();
    let host = host.rsplit('@').next().unwrap_or(host);
    if host.is_empty() {
        return "外部".to_string();
    }
    host.chars().take(64).collect()
}

/// `file:///C:/x/y.png`, `file://server/share/y.png` and a bare `C:\x\y.png`
/// all appear in real documents. Only absolute paths are accepted: a relative
/// link would resolve against this process's working directory, which has
/// nothing to do with where the document lives.
fn local_media_path(target: &str) -> Option<PathBuf> {
    let candidate = if let Some(rest) = target.strip_prefix("file:///") {
        let decoded = decode_file_uri(rest);
        let bytes = decoded.as_bytes();
        let drive_letter = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
        if drive_letter {
            decoded
        } else {
            format!("/{decoded}")
        }
    } else if let Some(rest) = target.strip_prefix("file://") {
        format!("//{}", decode_file_uri(rest))
    } else if target.contains("://") {
        return None;
    } else {
        target.to_string()
    };
    let path = PathBuf::from(candidate);
    path.is_absolute().then_some(path)
}

/// What one document spends on pictures, across all of its parts.
#[derive(Debug, Default)]
struct MediaBudget {
    used_bytes: usize,
    /// Pictures already encoded, keyed by package entry name or external
    /// target. A deck puts the same logo on every slide and a document can
    /// place one picture many times; encoding it once keeps the preview small
    /// and stops the same bytes from being charged over and over, which would
    /// otherwise turn the later slides into placeholders.
    resolved: HashMap<String, MediaImage>,
}

/// Word keeps relationships for pictures that editing has since removed: one
/// real document declares 21 image relationships for the 10 pictures its body
/// still names. Resolving the other 11 would read and encode bytes nothing
/// displays, and spend the budget on them. The id is matched with its quotes so
/// that `rId1` cannot match `rId18`.
fn relationship_is_referenced(part_xml: &str, rel_id: &str) -> bool {
    part_xml.contains(&format!("\"{rel_id}\"")) || part_xml.contains(&format!("'{rel_id}'"))
}

/// Resolves the picture relationships one part actually names, up front, so
/// that the XML walk stays a pure function of the XML plus this map. Pictures
/// are resolved in relationship order, which is therefore also the order the
/// document-wide budget is spent in.
fn collect_part_media<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    part_name: &str,
    part_xml: &str,
    budget: &mut MediaBudget,
) -> MediaMap {
    let mut images = HashMap::new();
    let Ok(rels_xml) = read_archive_text_entry(archive, &part_relationships_name(part_name)) else {
        return MediaMap { images };
    };
    for (id, relationship) in parse_media_relationships(&rels_xml) {
        if !relationship_is_referenced(part_xml, &id) {
            continue;
        }
        let (key, entry_name) = if relationship.external {
            (format!("external:{}", relationship.target), String::new())
        } else {
            let entry_name = resolve_package_target(part_name, &relationship.target);
            (entry_name.clone(), entry_name)
        };
        let resolved = match budget.resolved.get(&key) {
            Some(image) => image.clone(),
            None => {
                let image = if relationship.external {
                    resolve_external_media(&relationship.target, &mut budget.used_bytes)
                } else {
                    resolve_embedded_media(archive, &entry_name, &mut budget.used_bytes)
                };
                budget.resolved.insert(key, image.clone());
                image
            }
        };
        images.insert(id, resolved);
    }
    MediaMap { images }
}

/// `<wp:extent cx cy>` states the size the author gave the picture, in EMU.
fn docx_extent_pixels(element: &quick_xml::events::BytesStart<'_>) -> Option<(u32, u32)> {
    let width = emu_to_pixels(&xml_attr_value(element, b"cx")?)?;
    let height = emu_to_pixels(&xml_attr_value(element, b"cy")?)?;
    Some((width, height))
}

fn emu_to_pixels(value: &str) -> Option<u32> {
    let emu = value.trim().parse::<f64>().ok()?;
    let pixels = (emu / EMU_PER_PIXEL).round();
    // A nonsense extent would tear the page layout apart, and the CSS cap only
    // constrains the width, so an out-of-range value is dropped instead.
    (1.0..=20000.0).contains(&pixels).then_some(pixels as u32)
}

fn apply_docx_paragraph_property(
    element: &quick_xml::events::BytesStart<'_>,
    format: &mut DocxParagraphFormat,
) {
    match xml_local_name(element.name().as_ref()) {
        b"jc" => {
            if let Some(alignment) =
                xml_attr_value(element, b"val").and_then(|value| normalize_alignment(&value))
            {
                format.alignment = Some(alignment);
            }
        }
        b"ind" => {
            if let Some(indent) = xml_attr_value(element, b"left")
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|value| *value > 0)
            {
                format.indent_twips = Some(indent);
            }
        }
        b"pStyle" => {
            if let Some(style_id) = xml_attr_value(element, b"val") {
                format.style_id = Some(style_id);
            }
        }
        _ => {}
    }
}

fn apply_docx_run_property(
    element: &quick_xml::events::BytesStart<'_>,
    format: &mut DocxRunFormat,
) {
    match xml_local_name(element.name().as_ref()) {
        b"b" => format.bold = xml_enabled(element),
        b"i" => format.italic = xml_enabled(element),
        b"u" => {
            format.underline = !matches!(
                xml_attr_value(element, b"val")
                    .unwrap_or_else(|| "single".to_string())
                    .to_ascii_lowercase()
                    .as_str(),
                "none" | "0" | "false" | "off"
            );
        }
        b"strike" | b"dstrike" => format.strike = xml_enabled(element),
        b"rFonts" => {
            if let Some(font_family) = run_font_family_from_xml(element) {
                format.font_family = Some(font_family);
            }
        }
        b"sz" => {
            if let Some(size) = xml_attr_value(element, b"val")
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|value| *value > 0)
            {
                format.font_size_half_points = Some(size);
            }
        }
        b"color" => {
            if let Some(color) =
                xml_attr_value(element, b"val").and_then(|value| normalize_word_hex_color(&value))
            {
                format.color = Some(color);
            }
        }
        b"highlight" => {
            if let Some(highlight) = xml_attr_value(element, b"val") {
                format.highlight = Some(highlight);
            }
        }
        b"vertAlign" => {
            if let Some(value) = xml_attr_value(element, b"val") {
                if matches!(value.as_str(), "superscript" | "subscript") {
                    format.vertical_align = Some(value);
                }
            }
        }
        b"rStyle" => {
            if matches!(
                xml_attr_value(element, b"val").as_deref(),
                Some("MycmuxEquation")
            ) {
                format.equation = true;
            }
        }
        _ => {}
    }
}

fn push_html_text(target: &mut String, text: &str, format: &DocxRunFormat) {
    if !text.is_empty() {
        let (open, close) = docx_run_format_html_open_close(format);
        target.push_str(&open);
        target.push_str(&escape_html(text));
        target.push_str(&close);
    }
}

fn flush_docx_paragraph(
    body: &mut String,
    paragraph: &mut String,
    format: &DocxParagraphFormat,
    preserve_empty: bool,
) {
    let trimmed = paragraph.trim();
    if !trimmed.is_empty() || preserve_empty {
        let tag = docx_paragraph_tag(format);
        body.push('<');
        body.push_str(tag);
        body.push_str(&docx_paragraph_style_attr(format));
        body.push('>');
        if trimmed.is_empty() {
            body.push_str("<br>");
        } else {
            body.push_str(trimmed);
        }
        body.push_str("</");
        body.push_str(tag);
        body.push_str(">\n");
    }
    paragraph.clear();
}

/// The XML-only view of the Word preview, which the paragraph, table and
/// formatting tests pin. The preview itself goes through
/// `docx_xml_to_html_with_media` so that pictures resolve against the package.
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn docx_xml_to_html(xml: &str) -> String {
    docx_xml_to_html_with_media(xml, &MediaMap::empty())
}

fn docx_xml_to_html_with_media(xml: &str, media: &MediaMap) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut body = String::new();
    let mut paragraph = String::new();
    let mut cell = String::new();
    let mut paragraph_format = DocxParagraphFormat::default();
    let mut run_format = DocxRunFormat::default();
    let mut in_text = false;
    let mut in_table = false;
    let mut in_cell = false;
    let mut in_paragraph_properties = false;
    let mut in_run_properties = false;
    let mut equation_depth = 0usize;
    // Inside a picture, a chart, an OLE preview or a text box. Everything in
    // there is part of the figure, not of the sentence around it. Without this
    // depth the local-name matching would take the `<w:t>` of a text box and
    // the `<a:t>` of a chart label for body text, and the `<w:p>` inside a text
    // box would flush the paragraph holding the drawing, cutting it in half.
    let mut drawing_depth = 0usize;
    let mut drawing_text = String::new();
    let mut drawing_extent: Option<(u32, u32)> = None;
    // `<mc:AlternateContent>` carries one shape twice: a `<w:drawing>` under
    // `<mc:Choice>` and a legacy `<w:pict>` under `<mc:Fallback>`. Reading both
    // would show every such picture and every such text box twice.
    let mut fallback_depth = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let qname = element.name();
                let name = xml_local_name(qname.as_ref());
                if name == b"Fallback" {
                    fallback_depth += 1;
                    continue;
                }
                if fallback_depth > 0 {
                    continue;
                }
                match name {
                    b"drawing" | b"pict" | b"object" => {
                        drawing_depth += 1;
                        if drawing_depth == 1 {
                            drawing_text.clear();
                            drawing_extent = None;
                        }
                    }
                    b"extent" if drawing_depth > 0 => {
                        if drawing_extent.is_none() {
                            drawing_extent = docx_extent_pixels(&element);
                        }
                    }
                    b"blip" | b"imagedata" if drawing_depth > 0 => {
                        let target = if in_cell { &mut cell } else { &mut paragraph };
                        target.push_str(&docx_media_html(media, &element, name, drawing_extent));
                    }
                    b"p" if drawing_depth > 0 => {
                        if !drawing_text.is_empty() && !drawing_text.ends_with("<br>") {
                            drawing_text.push_str("<br>");
                        }
                    }
                    b"tbl" if drawing_depth == 0 => {
                        flush_docx_paragraph(&mut body, &mut paragraph, &paragraph_format, false);
                        paragraph_format = DocxParagraphFormat::default();
                        body.push_str("<table><tbody>\n");
                        in_table = true;
                    }
                    b"p" if !in_table => {
                        paragraph.clear();
                        paragraph_format = DocxParagraphFormat::default();
                    }
                    b"pPr" if drawing_depth == 0 => in_paragraph_properties = true,
                    b"r" if drawing_depth == 0 => run_format = DocxRunFormat::default(),
                    b"rPr" if drawing_depth == 0 => in_run_properties = true,
                    b"tr" if in_table && drawing_depth == 0 => body.push_str("<tr>"),
                    b"tc" if in_table && drawing_depth == 0 => {
                        in_cell = true;
                        cell.clear();
                    }
                    b"oMath" | b"oMathPara" if drawing_depth == 0 => {
                        equation_depth += 1;
                        run_format.equation = true;
                    }
                    b"t" => in_text = true,
                    _ => {
                        if drawing_depth == 0 {
                            if in_paragraph_properties {
                                apply_docx_paragraph_property(&element, &mut paragraph_format);
                            }
                            if in_run_properties {
                                apply_docx_run_property(&element, &mut run_format);
                            }
                        }
                    }
                }
            }
            Ok(Event::Empty(element)) => {
                let qname = element.name();
                let name = xml_local_name(qname.as_ref());
                if fallback_depth > 0 {
                    continue;
                }
                match name {
                    b"extent" if drawing_depth > 0 => {
                        if drawing_extent.is_none() {
                            drawing_extent = docx_extent_pixels(&element);
                        }
                    }
                    b"blip" | b"imagedata" if drawing_depth > 0 => {
                        let target = if in_cell { &mut cell } else { &mut paragraph };
                        target.push_str(&docx_media_html(media, &element, name, drawing_extent));
                    }
                    b"tab" => {
                        if drawing_depth > 0 {
                            drawing_text.push(' ');
                        } else if in_cell {
                            cell.push(' ');
                        } else {
                            paragraph.push(' ');
                        }
                    }
                    b"br" => {
                        if drawing_depth > 0 {
                            drawing_text.push_str("<br>");
                        } else if in_cell {
                            cell.push_str("<br>");
                        } else {
                            paragraph.push_str("<br>");
                        }
                    }
                    _ => {
                        if drawing_depth == 0 {
                            if in_paragraph_properties {
                                apply_docx_paragraph_property(&element, &mut paragraph_format);
                            }
                            if in_run_properties {
                                apply_docx_run_property(&element, &mut run_format);
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(text)) => {
                if !in_text || fallback_depth > 0 {
                    continue;
                }
                let decoded = decode_xml_text(&text);
                if drawing_depth > 0 {
                    drawing_text.push_str(&escape_html(&decoded));
                    continue;
                }
                let mut effective_run_format = run_format.clone();
                if equation_depth > 0 {
                    effective_run_format.equation = true;
                }
                if in_cell {
                    push_html_text(&mut cell, &decoded, &effective_run_format);
                } else {
                    push_html_text(&mut paragraph, &decoded, &effective_run_format);
                }
            }
            Ok(Event::End(element)) => {
                let qname = element.name();
                let name = xml_local_name(qname.as_ref());
                if name == b"Fallback" {
                    fallback_depth = fallback_depth.saturating_sub(1);
                    continue;
                }
                if fallback_depth > 0 {
                    continue;
                }
                match name {
                    b"drawing" | b"pict" | b"object" => {
                        drawing_depth = drawing_depth.saturating_sub(1);
                        if drawing_depth == 0 {
                            // The words in a text box are kept, but as part of
                            // the figure: they are shown where the figure sits
                            // instead of being spliced into the sentence.
                            let trimmed = drawing_text.trim();
                            if !trimmed.is_empty() {
                                let markup =
                                    format!("<span class=\"office-textbox\">{trimmed}</span>");
                                if in_cell {
                                    cell.push_str(&markup);
                                } else {
                                    paragraph.push_str(&markup);
                                }
                            }
                            drawing_text.clear();
                            drawing_extent = None;
                        }
                    }
                    b"t" => in_text = false,
                    b"p" if !in_table && drawing_depth == 0 => {
                        flush_docx_paragraph(&mut body, &mut paragraph, &paragraph_format, true);
                        paragraph_format = DocxParagraphFormat::default();
                    }
                    b"pPr" if drawing_depth == 0 => in_paragraph_properties = false,
                    b"rPr" if drawing_depth == 0 => in_run_properties = false,
                    b"r" if drawing_depth == 0 => run_format = DocxRunFormat::default(),
                    b"oMath" | b"oMathPara" if drawing_depth == 0 => {
                        equation_depth = equation_depth.saturating_sub(1);
                    }
                    b"tc" if in_table && drawing_depth == 0 => {
                        let trimmed = cell.trim();
                        body.push_str("<td>");
                        if trimmed.is_empty() {
                            body.push_str("&nbsp;");
                        } else {
                            body.push_str(trimmed);
                        }
                        body.push_str("</td>");
                        cell.clear();
                        in_cell = false;
                    }
                    b"tr" if in_table && drawing_depth == 0 => body.push_str("</tr>\n"),
                    b"tbl" if drawing_depth == 0 => {
                        body.push_str("</tbody></table>\n");
                        in_table = false;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    flush_docx_paragraph(&mut body, &mut paragraph, &paragraph_format, false);
    if body.trim().is_empty() {
        "<p class=\"office-empty\">No readable text was found in this Word document.</p>"
            .to_string()
    } else {
        body
    }
}

/// `<a:blip r:embed>` is the modern picture reference and `<v:imagedata r:id>`
/// the one Word wrote before 2007; both name a relationship of this part.
fn docx_media_html(
    media: &MediaMap,
    element: &quick_xml::events::BytesStart<'_>,
    local_name: &[u8],
    size: Option<(u32, u32)>,
) -> String {
    let keys: &[&[u8]] = if local_name == b"blip" {
        &[b"embed", b"link"]
    } else {
        &[b"id", b"href"]
    };
    match xml_first_attr_value(element, keys) {
        Some(rel_id) => media.image_html(&rel_id, size),
        None => media_unavailable_html("画像の参照が読み取れません"),
    }
}

pub(super) fn docx_to_html(path: &Path) -> Result<String, String> {
    let mut archive = open_office_archive(path)?;
    let xml = read_archive_text_entry(&mut archive, "word/document.xml")?;
    let mut budget = MediaBudget::default();
    // Only the main document part is previewed today, so only its pictures are
    // resolved; headers, footers and footnotes are not read at all.
    let media = collect_part_media(&mut archive, "word/document.xml", &xml, &mut budget);
    Ok(docx_xml_to_html_with_media(&xml, &media))
}

fn docx_default_section_properties() -> String {
    r#"<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>"#.to_string()
}

fn docx_section_properties(original_xml: &str) -> String {
    let Some(start) = original_xml.rfind("<w:sectPr") else {
        return docx_default_section_properties();
    };
    let tail = &original_xml[start..];
    if let Some(end) = tail.find("</w:sectPr>") {
        return tail[..end + "</w:sectPr>".len()].to_string();
    }
    if let Some(end) = tail.find("/>") {
        return tail[..end + 2].to_string();
    }
    docx_default_section_properties()
}

fn html_attr(node: &NodeRef, name: &str) -> Option<String> {
    match node.data() {
        NodeData::Element(element) => element
            .attributes
            .borrow()
            .get(name)
            .map(|value| value.to_string()),
        _ => None,
    }
}

fn html_style_property(style: &str, name: &str) -> Option<String> {
    style.split(';').find_map(|declaration| {
        let (property, value) = declaration.split_once(':')?;
        if property.trim().eq_ignore_ascii_case(name) {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        } else {
            None
        }
    })
}

fn parse_css_number(value: &str, suffix: &str) -> Option<f32> {
    value
        .trim()
        .trim_end_matches(suffix)
        .trim()
        .parse::<f32>()
        .ok()
}

fn css_length_to_twips(value: &str) -> Option<u32> {
    let trimmed = value.trim().to_ascii_lowercase();
    if trimmed.is_empty() || trimmed == "0" || trimmed == "0px" {
        return None;
    }
    let twips = if trimmed.ends_with("in") {
        parse_css_number(&trimmed, "in")? * 1440.0
    } else if trimmed.ends_with("pt") {
        parse_css_number(&trimmed, "pt")? * 20.0
    } else if trimmed.ends_with("cm") {
        parse_css_number(&trimmed, "cm")? * 1440.0 / 2.54
    } else if trimmed.ends_with("mm") {
        parse_css_number(&trimmed, "mm")? * 1440.0 / 25.4
    } else if trimmed.ends_with("px") {
        parse_css_number(&trimmed, "px")? * 15.0
    } else {
        trimmed.parse::<f32>().ok()? * 15.0
    };
    if twips <= 0.0 {
        None
    } else {
        Some(twips.round() as u32)
    }
}

fn css_font_size_to_half_points(value: &str) -> Option<u32> {
    let trimmed = value.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    let half_points = if trimmed.ends_with("pt") {
        parse_css_number(&trimmed, "pt")? * 2.0
    } else if trimmed.ends_with("px") {
        parse_css_number(&trimmed, "px")? * 1.5
    } else {
        trimmed.parse::<f32>().ok()? * 2.0
    };
    if half_points <= 0.0 {
        None
    } else {
        Some(half_points.round() as u32)
    }
}

fn html_font_size_to_half_points(value: &str) -> Option<u32> {
    match value.trim() {
        "1" => Some(16),
        "2" => Some(20),
        "3" => Some(24),
        "4" => Some(28),
        "5" => Some(36),
        "6" => Some(48),
        "7" => Some(64),
        _ => None,
    }
}

fn first_font_family(value: &str) -> Option<String> {
    let first = value
        .split(',')
        .next()
        .unwrap_or(value)
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

fn margin_left_from_style(style: &str) -> Option<String> {
    if let Some(value) = html_style_property(style, "margin-left") {
        return Some(value);
    }
    let margin = html_style_property(style, "margin")?;
    let parts = margin.split_whitespace().collect::<Vec<_>>();
    match parts.as_slice() {
        [single] => Some((*single).to_string()),
        [_vertical, horizontal] => Some((*horizontal).to_string()),
        [_top, horizontal, _bottom] => Some((*horizontal).to_string()),
        [_top, _right, _bottom, left, ..] => Some((*left).to_string()),
        _ => None,
    }
}

fn docx_inline_format_for_node(node: &NodeRef, current: &DocxRunFormat) -> DocxRunFormat {
    let mut next = current.clone();
    let Some(name) = element_name(node) else {
        return next;
    };
    match name.as_str() {
        "strong" | "b" => next.bold = true,
        "em" | "i" => next.italic = true,
        "u" => next.underline = true,
        "s" | "strike" | "del" => next.strike = true,
        "sup" => next.vertical_align = Some("superscript".to_string()),
        "sub" => next.vertical_align = Some("subscript".to_string()),
        "font" => {
            if let Some(face) = html_attr(node, "face").and_then(|value| first_font_family(&value))
            {
                next.font_family = Some(face);
            }
            if let Some(size) =
                html_attr(node, "size").and_then(|value| html_font_size_to_half_points(&value))
            {
                next.font_size_half_points = Some(size);
            }
        }
        _ => {}
    }
    if html_attr(node, "data-mycmux-equation").is_some()
        || html_attr(node, "class")
            .map(|class| {
                class
                    .split_whitespace()
                    .any(|name| name == "mycmux-equation")
            })
            .unwrap_or(false)
    {
        next.equation = true;
    }
    if let Some(style) = html_attr(node, "style") {
        if let Some(font_family) =
            html_style_property(&style, "font-family").and_then(|value| first_font_family(&value))
        {
            next.font_family = Some(font_family);
        }
        if let Some(size) = html_style_property(&style, "font-size")
            .and_then(|value| css_font_size_to_half_points(&value))
        {
            next.font_size_half_points = Some(size);
        }
        if let Some(color) =
            html_style_property(&style, "color").and_then(|value| css_color_to_word_hex(&value))
        {
            next.color = Some(color);
        }
        if let Some(highlight) = html_style_property(&style, "background-color")
            .or_else(|| html_style_property(&style, "background"))
            .and_then(|value| css_background_to_word_highlight(&value))
        {
            next.highlight = Some(highlight);
        }
        if let Some(decoration) = html_style_property(&style, "text-decoration") {
            let lower = decoration.to_ascii_lowercase();
            if lower.contains("underline") {
                next.underline = true;
            }
            if lower.contains("line-through") {
                next.strike = true;
            }
        }
        if let Some(vertical_align) = html_style_property(&style, "vertical-align") {
            match vertical_align.to_ascii_lowercase().as_str() {
                "super" | "superscript" => next.vertical_align = Some("superscript".to_string()),
                "sub" | "subscript" => next.vertical_align = Some("subscript".to_string()),
                _ => {}
            }
        }
    }
    next
}

fn docx_paragraph_format_from_node(node: &NodeRef, style_id: Option<&str>) -> DocxParagraphFormat {
    let mut format = DocxParagraphFormat {
        style_id: style_id.map(|value| value.to_string()),
        ..DocxParagraphFormat::default()
    };
    if let Some(align) = html_attr(node, "align").and_then(|value| normalize_alignment(&value)) {
        format.alignment = Some(align);
    }
    if let Some(style) = html_attr(node, "style") {
        if let Some(align) =
            html_style_property(&style, "text-align").and_then(|value| normalize_alignment(&value))
        {
            format.alignment = Some(align);
        }
        if let Some(indent) =
            margin_left_from_style(&style).and_then(|value| css_length_to_twips(&value))
        {
            format.indent_twips = Some(indent);
        }
    }
    if matches!(element_name(node).as_deref(), Some("blockquote")) && format.indent_twips.is_none()
    {
        format.indent_twips = Some(720);
    }
    format
}

fn push_docx_paragraph_properties(target: &mut String, format: &DocxParagraphFormat) {
    if !format.has_properties() {
        return;
    }
    target.push_str("<w:pPr>");
    if let Some(style_id) = format.style_id.as_deref() {
        target.push_str("<w:pStyle w:val=\"");
        target.push_str(&escape_html(style_id));
        target.push_str("\"/>");
    }
    if let Some(alignment) = format.alignment.as_deref() {
        target.push_str("<w:jc w:val=\"");
        target.push_str(&escape_html(alignment));
        target.push_str("\"/>");
    }
    if let Some(indent) = format.indent_twips {
        target.push_str("<w:ind w:left=\"");
        target.push_str(&indent.to_string());
        target.push_str("\"/>");
    }
    target.push_str("</w:pPr>");
}

fn push_docx_run(target: &mut String, text: &str, format: &DocxRunFormat) {
    if text.is_empty() {
        return;
    }
    target.push_str("<w:r>");
    if format.has_properties() {
        target.push_str("<w:rPr>");
        if format.equation {
            target.push_str("<w:rStyle w:val=\"MycmuxEquation\"/>");
        }
        if format.bold {
            target.push_str("<w:b/>");
        }
        if format.italic || format.equation {
            target.push_str("<w:i/>");
        }
        if format.underline {
            target.push_str("<w:u w:val=\"single\"/>");
        }
        if format.strike {
            target.push_str("<w:strike/>");
        }
        if let Some(font_family) = format.font_family.as_deref().or(if format.equation {
            Some("Cambria Math")
        } else {
            None
        }) {
            let escaped = escape_html(font_family);
            target.push_str("<w:rFonts w:ascii=\"");
            target.push_str(&escaped);
            target.push_str("\" w:hAnsi=\"");
            target.push_str(&escaped);
            target.push_str("\" w:eastAsia=\"");
            target.push_str(&escaped);
            target.push_str("\"/>");
        }
        if let Some(size) = format.font_size_half_points {
            target.push_str("<w:sz w:val=\"");
            target.push_str(&size.to_string());
            target.push_str("\"/>");
        }
        if let Some(color) = format.color.as_deref() {
            target.push_str("<w:color w:val=\"");
            target.push_str(&escape_html(color));
            target.push_str("\"/>");
        }
        if let Some(highlight) = format.highlight.as_deref() {
            target.push_str("<w:highlight w:val=\"");
            target.push_str(&escape_html(highlight));
            target.push_str("\"/>");
        }
        if let Some(vertical_align) = format.vertical_align.as_deref() {
            target.push_str("<w:vertAlign w:val=\"");
            target.push_str(&escape_html(vertical_align));
            target.push_str("\"/>");
        }
        if format.equation {
            target.push_str("<w:color w:val=\"1D4ED8\"/>");
        }
        target.push_str("</w:rPr>");
    }
    target.push_str("<w:t xml:space=\"preserve\">");
    target.push_str(&escape_html(text));
    target.push_str("</w:t></w:r>");
}

fn docx_inline_runs(node: &NodeRef, target: &mut String, format: &DocxRunFormat) {
    match node.data() {
        NodeData::Text(text) => push_docx_run(target, &text.borrow(), format),
        NodeData::Element(element) => {
            let name = element.name.local.to_string();
            match name.as_str() {
                "script" | "style" => {}
                "br" => target.push_str("<w:r><w:br/></w:r>"),
                _ => {
                    let next = docx_inline_format_for_node(node, format);
                    for child in node.children() {
                        docx_inline_runs(&child, target, &next);
                    }
                }
            }
        }
        _ => {
            for child in node.children() {
                docx_inline_runs(&child, target, format);
            }
        }
    }
}

fn docx_paragraph_xml(node: &NodeRef, style: Option<&str>, prefix: Option<&str>) -> Option<String> {
    let text = text_content(node);
    if text.trim().is_empty() && prefix.is_none() {
        return None;
    }
    let paragraph_format = docx_paragraph_format_from_node(node, style);
    let mut paragraph = String::from("<w:p>");
    push_docx_paragraph_properties(&mut paragraph, &paragraph_format);
    if let Some(prefix) = prefix {
        push_docx_run(&mut paragraph, prefix, &DocxRunFormat::default());
    }
    for child in node.children() {
        docx_inline_runs(&child, &mut paragraph, &DocxRunFormat::default());
    }
    paragraph.push_str("</w:p>");
    Some(paragraph)
}

fn docx_table_xml(node: &NodeRef) -> Option<String> {
    let rows = node
        .select("tr")
        .ok()?
        .filter_map(|row| {
            let row_node = row.as_node().clone();
            let cells = row_node
                .select("th,td")
                .ok()?
                .map(|cell| {
                    let cell_node = cell.as_node().clone();
                    let mut cell_xml = String::from("<w:tc><w:p>");
                    for child in cell_node.children() {
                        docx_inline_runs(&child, &mut cell_xml, &DocxRunFormat::default());
                    }
                    if text_content(&cell_node).trim().is_empty() {
                        cell_xml.push_str("<w:r><w:t></w:t></w:r>");
                    }
                    cell_xml.push_str("</w:p></w:tc>");
                    Some(cell_xml)
                })
                .collect::<Option<Vec<_>>>()?;
            if cells.is_empty() {
                None
            } else {
                Some(format!("<w:tr>{}</w:tr>", cells.join("")))
            }
        })
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return None;
    }
    Some(format!(
        "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr>{}</w:tbl>",
        rows.join("")
    ))
}

fn docx_block_xml(node: &NodeRef, target: &mut Vec<String>) {
    match node.data() {
        NodeData::Text(text) => {
            let value = text.borrow();
            if !value.trim().is_empty() {
                target.push(format!(
                    "<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                    escape_html(value.trim())
                ));
            }
        }
        NodeData::Element(element) => {
            let name = element.name.local.to_string();
            match name.as_str() {
                "script" | "style" => {}
                "h1" => {
                    if let Some(paragraph) = docx_paragraph_xml(node, Some("Heading1"), None) {
                        target.push(paragraph);
                    }
                }
                "h2" => {
                    if let Some(paragraph) = docx_paragraph_xml(node, Some("Heading2"), None) {
                        target.push(paragraph);
                    }
                }
                "h3" | "h4" | "h5" | "h6" => {
                    if let Some(paragraph) = docx_paragraph_xml(node, Some("Heading3"), None) {
                        target.push(paragraph);
                    }
                }
                "p" | "div" | "blockquote" => {
                    if let Some(paragraph) = docx_paragraph_xml(node, None, None) {
                        target.push(paragraph);
                    }
                }
                "ul" => {
                    if let Ok(items) = node.select("li") {
                        for item in items {
                            if let Some(paragraph) =
                                docx_paragraph_xml(item.as_node(), None, Some("- "))
                            {
                                target.push(paragraph);
                            }
                        }
                    }
                }
                "ol" => {
                    if let Ok(items) = node.select("li") {
                        for (index, item) in items.enumerate() {
                            if let Some(paragraph) = docx_paragraph_xml(
                                item.as_node(),
                                None,
                                Some(&format!("{}. ", index + 1)),
                            ) {
                                target.push(paragraph);
                            }
                        }
                    }
                }
                "table" => {
                    if let Some(table) = docx_table_xml(node) {
                        target.push(table);
                    }
                }
                "section" | "article" | "main" | "body" => {
                    for child in node.children() {
                        docx_block_xml(&child, target);
                    }
                }
                _ => {
                    if let Some(paragraph) = docx_paragraph_xml(node, None, None) {
                        target.push(paragraph);
                    }
                }
            }
        }
        _ => {
            for child in node.children() {
                docx_block_xml(&child, target);
            }
        }
    }
}

pub(super) fn html_fragment_to_docx_document_xml(fragment: &str, original_xml: &str) -> String {
    let document = kuchikiki::parse_html()
        .one(format!(
            "<!doctype html><html><body>{fragment}</body></html>"
        ))
        .document_node;
    let body = document
        .select_first("body")
        .ok()
        .map(|node| node.as_node().clone())
        .unwrap_or(document);
    let mut blocks = Vec::new();
    for child in body.children() {
        docx_block_xml(&child, &mut blocks);
    }
    if blocks.is_empty() {
        blocks.push("<w:p/>".to_string());
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{}{}</w:body></w:document>"#,
        blocks.join(""),
        docx_section_properties(original_xml)
    )
}

pub(super) fn unsupported_docx_editing_feature(document_xml: &str) -> Option<&'static str> {
    const UNSUPPORTED_MARKERS: &[(&str, &str)] = &[
        ("<w:drawing", "images or drawings"),
        ("<w:pict", "legacy images or drawings"),
        ("<w:object", "embedded objects"),
        ("<w:altChunk", "embedded external document chunks"),
        ("<w:footnoteReference", "footnotes"),
        ("<w:endnoteReference", "endnotes"),
        ("<w:commentReference", "comments"),
        ("<w:ins", "tracked insertions"),
        ("<w:del", "tracked deletions"),
        ("<w:numPr", "Word-managed numbering"),
        ("<w:gridSpan", "merged table cells"),
        ("<w:vMerge", "merged table cells"),
    ];
    UNSUPPORTED_MARKERS
        .iter()
        .find_map(|(marker, label)| document_xml.contains(marker).then_some(*label))
}

pub(super) fn xlsx_shared_strings_xml_to_vec(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut values = Vec::new();
    let mut current = String::new();
    let mut in_item = false;
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => match xml_local_name(element.name().as_ref()) {
                b"si" => {
                    current.clear();
                    in_item = true;
                }
                b"t" if in_item => in_text = true,
                _ => {}
            },
            Ok(Event::Text(text)) if in_item && in_text => {
                current.push_str(&decode_xml_text(&text));
            }
            Ok(Event::End(element)) => match xml_local_name(element.name().as_ref()) {
                b"t" => in_text = false,
                b"si" => {
                    values.push(current.clone());
                    current.clear();
                    in_item = false;
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }

    values
}

pub(super) fn xlsx_sheet_xml_to_html(xml: &str, shared_strings: &[String]) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut body = String::new();
    let mut cell_type = String::new();
    let mut cell_value = String::new();
    let mut in_value = false;
    let mut in_row = false;

    body.push_str("<table><tbody>\n");
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => match xml_local_name(element.name().as_ref()) {
                b"row" => {
                    in_row = true;
                    body.push_str("<tr>");
                }
                b"c" => {
                    cell_type = xml_attr_value(&element, b"t").unwrap_or_default();
                    cell_value.clear();
                }
                b"v" | b"t" => in_value = true,
                _ => {}
            },
            Ok(Event::Text(text)) if in_value => {
                cell_value.push_str(&decode_xml_text(&text));
            }
            Ok(Event::End(element)) => match xml_local_name(element.name().as_ref()) {
                b"v" | b"t" => in_value = false,
                b"c" if in_row => {
                    let value = if cell_type == "s" {
                        cell_value
                            .trim()
                            .parse::<usize>()
                            .ok()
                            .and_then(|index| shared_strings.get(index))
                            .cloned()
                            .unwrap_or_default()
                    } else {
                        cell_value.clone()
                    };
                    body.push_str("<td>");
                    let trimmed = value.trim();
                    if trimmed.is_empty() {
                        body.push_str("&nbsp;");
                    } else {
                        body.push_str(&escape_html(trimmed));
                    }
                    body.push_str("</td>");
                    cell_value.clear();
                    cell_type.clear();
                }
                b"row" => {
                    in_row = false;
                    body.push_str("</tr>\n");
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    body.push_str("</tbody></table>\n");
    body
}

fn xlsx_to_html(path: &Path) -> Result<String, String> {
    let shared_strings = read_zip_text_entry(path, "xl/sharedStrings.xml")
        .map(|xml| xlsx_shared_strings_xml_to_vec(&xml))
        .unwrap_or_default();
    let sheets = zip_entry_names(path, "xl/worksheets/sheet", ".xml")?;
    if sheets.is_empty() {
        return Ok("<p class=\"office-empty\">No readable worksheets were found.</p>".to_string());
    }

    let mut body = String::new();
    for (index, sheet_name) in sheets.iter().take(6).enumerate() {
        let xml = read_zip_text_entry(path, sheet_name)?;
        body.push_str(&format!(
            "<section class=\"sheet\"><h2>Sheet {}</h2>",
            index + 1
        ));
        body.push_str(&xlsx_sheet_xml_to_html(&xml, &shared_strings));
        body.push_str("</section>\n");
    }
    Ok(body)
}

enum PptxSlideBlock {
    Text(String),
    /// A `<a:blip>` reference, or `None` when the shape names no relationship.
    Picture(Option<String>),
}

fn pptx_slide_xml_to_blocks(xml: &str) -> Vec<PptxSlideBlock> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut blocks = Vec::new();
    let mut current = String::new();
    let mut in_paragraph = false;
    let mut in_text = false;
    // `<p:bg>` holds the slide's background fill. It is the same picture on
    // every slide of a themed deck, so repeating it would drown the content and
    // spend the whole picture budget on wallpaper.
    let mut background_depth = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let qname = element.name();
                match xml_local_name(qname.as_ref()) {
                    // Only a start tag opens a region; `<p:bg/>` on its own
                    // holds no fill and must not leave the depth raised.
                    b"bg" => background_depth += 1,
                    b"blip" if background_depth == 0 => {
                        blocks.push(PptxSlideBlock::Picture(xml_first_attr_value(
                            &element,
                            &[b"embed", b"link"],
                        )));
                    }
                    b"p" => {
                        current.clear();
                        in_paragraph = true;
                    }
                    b"t" if in_paragraph => in_text = true,
                    _ => {}
                }
            }
            Ok(Event::Empty(element)) => {
                let qname = element.name();
                if xml_local_name(qname.as_ref()) == b"blip" && background_depth == 0 {
                    blocks.push(PptxSlideBlock::Picture(xml_first_attr_value(
                        &element,
                        &[b"embed", b"link"],
                    )));
                }
            }
            Ok(Event::Text(text)) if in_text => current.push_str(&decode_xml_text(&text)),
            Ok(Event::End(element)) => {
                let qname = element.name();
                match xml_local_name(qname.as_ref()) {
                    b"bg" => background_depth = background_depth.saturating_sub(1),
                    b"t" => in_text = false,
                    b"p" if in_paragraph => {
                        let trimmed = current.trim();
                        if !trimmed.is_empty() {
                            blocks.push(PptxSlideBlock::Text(trimmed.to_string()));
                        }
                        current.clear();
                        in_paragraph = false;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    blocks
}

/// The text-only view of a slide, which the slide test pins. The preview
/// itself keeps the pictures interleaved with the text through
/// `pptx_slide_html`.
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn pptx_slide_xml_to_paragraphs(xml: &str) -> Vec<String> {
    pptx_slide_xml_to_blocks(xml)
        .into_iter()
        .filter_map(|block| match block {
            PptxSlideBlock::Text(text) => Some(text),
            PptxSlideBlock::Picture(_) => None,
        })
        .collect()
}

fn pptx_slide_html(xml: &str, media: &MediaMap) -> String {
    let mut html = String::new();
    for block in pptx_slide_xml_to_blocks(xml) {
        match block {
            PptxSlideBlock::Text(text) => {
                html.push_str("<p>");
                html.push_str(&escape_html(&text));
                html.push_str("</p>");
            }
            PptxSlideBlock::Picture(rel_id) => {
                html.push_str("<p class=\"slide-figure\">");
                match rel_id {
                    // A slide states its own size for a picture in its shape
                    // transform, which the preview does not lay out, so the
                    // width is left to the stylesheet.
                    Some(rel_id) => html.push_str(&media.image_html(&rel_id, None)),
                    None => html.push_str(&media_unavailable_html("画像の参照が読み取れません")),
                }
                html.push_str("</p>");
            }
        }
    }
    html
}

fn pptx_to_html(path: &Path) -> Result<String, String> {
    let mut archive = open_office_archive(path)?;
    let slides = archive_entry_names(&mut archive, "ppt/slides/slide", ".xml")?;
    if slides.is_empty() {
        return Ok("<p class=\"office-empty\">No readable slides were found.</p>".to_string());
    }

    let mut body = String::new();
    let mut budget = MediaBudget::default();
    for (index, slide_name) in slides.iter().take(24).enumerate() {
        let xml = read_archive_text_entry(&mut archive, slide_name)?;
        // Every slide names its pictures through its own `.rels` part, and a
        // deck normally shares those pictures between slides.
        let media = collect_part_media(&mut archive, slide_name, &xml, &mut budget);
        let slide_html = pptx_slide_html(&xml, &media);
        body.push_str(&format!(
            "<section class=\"slide\"><h2>Slide {}</h2>",
            index + 1
        ));
        if slide_html.is_empty() {
            body.push_str("<p class=\"office-empty\">No text on this slide.</p>");
        } else {
            body.push_str(&slide_html);
        }
        body.push_str("</section>\n");
    }
    Ok(body)
}

fn office_document_body_html(path: &Path) -> Result<String, String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("docx") | Some("docm") | Some("dotx") | Some("dotm") => docx_to_html(path),
        Some("xlsx") | Some("xlsm") | Some("xltx") | Some("xltm") => xlsx_to_html(path),
        Some("pptx") | Some("pptm") | Some("potx") | Some("potm") | Some("ppsx") | Some("ppsm") => {
            pptx_to_html(path)
        }
        _ => Err("This Office format cannot be previewed in-app yet.".to_string()),
    }
}

pub(super) fn office_to_static_html(path: &Path) -> String {
    let file_name = path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .unwrap_or("Office document");
    let parent = path
        .parent()
        .map(|parent| parent.to_string_lossy().to_string())
        .unwrap_or_default();
    let source_path = path.to_string_lossy();
    let preview = ensure_artifact_file_within_read_limit(path, "preview")
        .and_then(|_| office_document_body_html(path))
        .unwrap_or_else(|error| {
            format!(
                "<p class=\"office-empty\">{}</p>",
                escape_html(&format!(
                    "{error} Use the Open button in the toolbar to edit/check this document in the desktop app."
                ))
            )
        });
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>{}</style></head><body><section class=\"office-shell\"><header class=\"office-header\"><div class=\"office-type\">{}</div><h1>{}</h1><dl><dt>Folder</dt><dd>{}</dd><dt>Path</dt><dd>{}</dd></dl><p class=\"office-note\">Use Open in the toolbar to edit this document in the default desktop app.</p></header><main class=\"office-preview\">{}</main></section></body></html>",
        r#"html{background:#edf1f5;color:#1f2937}body{margin:0;min-height:100vh;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-sizing:border-box}.office-shell{width:min(1040px,100%);margin:0 auto;box-sizing:border-box;border:1px solid #d6dbe3;background:#fff;box-shadow:0 18px 50px rgba(15,23,42,.10)}.office-header{padding:24px 28px 18px;border-bottom:1px solid #e5e7eb}.office-type{display:inline-flex;align-items:center;height:24px;padding:0 9px;border:1px solid #c8d0da;background:#f5f7fa;color:#475569;font-size:11px;font-weight:700;letter-spacing:0;text-transform:uppercase}h1{margin:14px 0 16px;font-size:25px;line-height:1.2;font-weight:720;letter-spacing:0;color:#111827;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:72px minmax(0,1fr);gap:6px 14px;margin:0;padding:14px 0;border-top:1px solid #eef2f7}dt{color:#64748b;font-size:12px;font-weight:700}dd{margin:0;color:#1f2937;font-size:13px;line-height:1.45;overflow-wrap:anywhere}.office-note{margin:12px 0 0;color:#475569;font-size:13px;line-height:1.55}.office-preview{padding:28px;font-size:14px;line-height:1.65}.office-preview p{margin:0 0 .85em}.office-preview h2{margin:0 0 12px;font-size:16px;line-height:1.3;color:#111827}.office-preview table{width:100%;border-collapse:collapse;margin:0 0 18px;display:block;overflow-x:auto}.office-preview th,.office-preview td{border:1px solid #d8dee8;padding:7px 9px;vertical-align:top;min-width:56px}.office-preview tr:nth-child(even) td{background:#fbfcfe}.office-preview .mycmux-equation,.office-preview [data-mycmux-equation]{display:inline-block;margin:0 .12em;padding:.06em .34em;border:1px solid #bfdbfe;border-radius:4px;background:#eff6ff;color:#1d4ed8;font-family:'Cambria Math','Times New Roman',serif;font-style:italic;white-space:pre-wrap}.sheet,.slide{margin:0 0 22px;padding-bottom:18px;border-bottom:1px solid #eef2f7}.office-empty{color:#64748b;font-style:italic}.office-preview img{max-width:100%;height:auto;vertical-align:middle}.office-preview .media-missing{display:inline-block;padding:1px 7px;border:1px dashed #c8d0da;background:#f8fafc;color:#64748b;font-size:12px;font-style:normal;vertical-align:middle}.office-preview .office-textbox{display:inline-block;padding:0 7px;border-left:2px solid #d8dee8;color:#334155}.office-preview .slide-figure{margin:0 0 12px}@media(max-width:640px){body{padding:14px}.office-header,.office-preview{padding:18px}h1{font-size:21px}dl{grid-template-columns:1fr;gap:4px}}"#,
        escape_html(office_kind_label(path)),
        escape_html(file_name),
        escape_html(&parent),
        escape_html(&source_path),
        preview
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    const PNG_BYTES: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
    ];

    const IMAGE_RELATIONSHIP: &str =
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

    /// Assembles an Office package in memory.
    fn office_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut buffer);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for (entry_name, bytes) in entries {
                writer.start_file(*entry_name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    /// The same package on disk, because the preview entry points take a path.
    fn office_file(dir: &Path, name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, office_zip(entries)).unwrap();
        path
    }

    fn relationships(entries: &[(&str, &str, bool)]) -> String {
        let mut xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
        );
        for (id, target, external) in entries {
            xml.push_str(&format!(
                r#"<Relationship Id="{id}" Type="{IMAGE_RELATIONSHIP}" Target="{target}"{}/>"#,
                if *external {
                    r#" TargetMode="External""#
                } else {
                    ""
                }
            ));
        }
        xml.push_str("</Relationships>");
        xml
    }

    fn word_document(body: &str) -> String {
        format!(
            r#"<w:document xmlns:w="w" xmlns:r="r" xmlns:a="a" xmlns:wp="wp" xmlns:pic="pic" xmlns:v="v" xmlns:mc="mc" xmlns:wps="wps"><w:body>{body}</w:body></w:document>"#
        )
    }

    fn inline_picture(rel_id: &str, extent: Option<&str>) -> String {
        format!(
            r#"<w:drawing><wp:inline>{}<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="{rel_id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>"#,
            extent.unwrap_or("")
        )
    }

    fn docx_preview(document_xml: &str, rels_xml: &str, media: &[(&str, &[u8])]) -> String {
        let dir = tempfile::tempdir().unwrap();
        let mut entries: Vec<(&str, &[u8])> = vec![
            ("word/document.xml", document_xml.as_bytes()),
            ("word/_rels/document.xml.rels", rels_xml.as_bytes()),
        ];
        entries.extend(media.iter().copied());
        let path = office_file(dir.path(), "report.docx", &entries);
        docx_to_html(&path).expect("the preview is produced")
    }

    #[test]
    fn base64_matches_the_rfc_4648_test_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64_encode(&[0x00, 0x00, 0x00]), "AAAA");
    }

    #[test]
    fn a_relationship_target_is_resolved_against_the_part_that_declares_it() {
        assert_eq!(
            resolve_package_target("word/document.xml", "media/image1.png"),
            "word/media/image1.png"
        );
        assert_eq!(
            resolve_package_target("ppt/slides/slide1.xml", "../media/image1.png"),
            "ppt/media/image1.png"
        );
        assert_eq!(
            resolve_package_target("word/document.xml", "./media/image1.png"),
            "word/media/image1.png"
        );
        assert_eq!(
            resolve_package_target("word/document.xml", "/word/media/image1.png"),
            "word/media/image1.png"
        );
        assert_eq!(
            resolve_package_target("word/document.xml", "..\\media\\image1.png"),
            "media/image1.png"
        );
        assert_eq!(
            part_relationships_name("word/document.xml"),
            "word/_rels/document.xml.rels"
        );
        assert_eq!(
            part_relationships_name("ppt/slides/slide3.xml"),
            "ppt/slides/_rels/slide3.xml.rels"
        );
    }

    #[test]
    fn an_embedded_png_becomes_a_data_uri() {
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId4", None)
            )),
            &relationships(&[("rId4", "media/photo.png", false)]),
            &[("word/media/photo.png", PNG_BYTES)],
        );

        let expected = format!(
            "<img src=\"data:image/png;base64,{}\" alt=\"\">",
            base64_encode(PNG_BYTES)
        );
        assert!(html.contains(&expected), "{html}");
        // No <wp:extent>, so the picture is left to the stylesheet.
        assert!(!html.contains("width="), "{html}");
    }

    #[test]
    fn a_relationship_target_that_climbs_out_of_the_part_folder_still_resolves() {
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId4", None)
            )),
            &relationships(&[("rId4", "../media/photo.png", false)]),
            &[("media/photo.png", PNG_BYTES)],
        );

        assert!(html.contains("<img src=\"data:image/png;base64,"), "{html}");
        assert!(!html.contains("media-missing"), "{html}");
    }

    #[test]
    fn a_drawing_extent_becomes_a_pixel_width_and_height() {
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId4", Some(r#"<wp:extent cx="952500" cy="476250"/>"#))
            )),
            &relationships(&[("rId4", "media/photo.png", false)]),
            &[("word/media/photo.png", PNG_BYTES)],
        );

        // 952500 EMU / 9525 = 100 px, 476250 EMU / 9525 = 50 px.
        assert!(html.contains("width=\"100\" height=\"50\""), "{html}");
    }

    #[test]
    fn a_legacy_vml_picture_is_rendered_too() {
        let html = docx_preview(
            &word_document(
                r#"<w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId4"/></v:shape></w:pict></w:r></w:p>"#,
            ),
            &relationships(&[("rId4", "media/photo.png", false)]),
            &[("word/media/photo.png", PNG_BYTES)],
        );

        assert!(html.contains("<img src=\"data:image/png;base64,"), "{html}");
    }

    #[test]
    fn an_external_web_picture_is_not_fetched() {
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p><w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId4", None),
                inline_picture("rId5", None)
            )),
            &relationships(&[
                ("rId4", "https://example.com/photo.png", true),
                // Same thing without the TargetMode a writer is supposed to
                // set: the scheme alone says this is not inside the package.
                ("rId5", "http://example.com/other.png", false),
            ]),
            &[],
        );

        // Nothing is requested, in either spelling of the relationship.
        assert!(!html.contains("<img"), "{html}");
        assert!(!html.contains("example.com/photo.png"), "{html}");
        assert_eq!(
            html.matches("外部の画像は読みに行きません (example.com)").count(),
            2,
            "{html}"
        );
    }

    #[test]
    fn the_note_for_a_web_picture_names_the_host_and_nothing_else() {
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId4", None)
            )),
            &relationships(&[(
                "rId4",
                "https://user:secret@tracker.example.net/pixel.png?doc=42#x",
                true,
            )]),
            &[],
        );

        assert!(html.contains("(tracker.example.net)"), "{html}");
        // The query string can carry the identifier that the request was for.
        assert!(!html.contains("doc=42"), "{html}");
        assert!(!html.contains("secret"), "{html}");
    }

    #[test]
    fn an_external_file_on_this_machine_is_read_and_inlined() {
        let dir = tempfile::tempdir().unwrap();
        // The space exercises the percent-decoding Word writes into `file:` targets.
        let picture = dir.path().join("linked photo.png");
        std::fs::write(&picture, PNG_BYTES).unwrap();
        let target = format!(
            "file:///{}",
            picture
                .to_string_lossy()
                .replace('\\', "/")
                .trim_start_matches('/')
                .replace(' ', "%20")
        );

        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId4", None)
            )),
            &relationships(&[("rId4", &target, true)]),
            &[],
        );

        assert!(
            html.contains(&format!(
                "<img src=\"data:image/png;base64,{}\"",
                base64_encode(PNG_BYTES)
            )),
            "{html}"
        );
    }

    #[test]
    fn an_external_file_that_is_not_a_picture_is_not_read_into_the_page() {
        let dir = tempfile::tempdir().unwrap();
        // Named like a picture, holding something else entirely. Nothing stops a
        // document from pointing at a file like this one.
        let decoy = dir.path().join("private.png");
        std::fs::write(&decoy, b"-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId4", None)
            )),
            &relationships(&[("rId4", &decoy.to_string_lossy(), true)]),
            &[],
        );

        assert!(html.contains("外部ファイルが画像ではありません"), "{html}");
        assert!(!html.contains("<img"), "{html}");
        assert!(!html.contains("OPENSSH"), "{html}");
        assert!(!html.contains("LS0tLS1"), "{html}");
    }

    #[test]
    fn an_external_picture_whose_bytes_are_another_format_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mislabelled = dir.path().join("photo.png");
        std::fs::write(&mislabelled, [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).unwrap();
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId4", None)
            )),
            &relationships(&[("rId4", &mislabelled.to_string_lossy(), true)]),
            &[],
        );

        assert!(html.contains("拡張子と違う形式"), "{html}");
        assert!(!html.contains("<img"), "{html}");
    }

    #[test]
    fn an_external_svg_is_recognised_past_its_declaration() {
        let dir = tempfile::tempdir().unwrap();
        let drawing = dir.path().join("figure.svg");
        std::fs::write(
            &drawing,
            b"<?xml version=\"1.0\"?>\n<!-- drawn by hand -->\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId4", None)
            )),
            &relationships(&[("rId4", &drawing.to_string_lossy(), true)]),
            &[],
        );

        assert!(html.contains("<img src=\"data:image/svg+xml;base64,"), "{html}");
    }

    #[test]
    fn an_external_file_that_is_not_there_leaves_a_visible_note() {
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId4", None)
            )),
            &relationships(&[("rId4", "file:///C:/mycmux-no-such-folder/photo.png", true)]),
            &[],
        );

        assert!(html.contains("media-missing"), "{html}");
        assert!(html.contains("外部ファイルが見つかりません"), "{html}");
    }

    #[test]
    fn a_missing_reference_and_an_unsupported_format_leave_a_visible_note() {
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p><w:p><w:r>{}</w:r></w:p><w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId9", None),
                inline_picture("rId4", None),
                inline_picture("rId5", None)
            )),
            &relationships(&[
                ("rId4", "media/diagram.emf", false),
                ("rId5", "media/gone.png", false),
            ]),
            &[("word/media/diagram.emf", b"not a web image")],
        );

        assert!(html.contains("参照先が見つかりません"), "{html}");
        assert!(html.contains("未対応の形式 .emf"), "{html}");
        assert!(html.contains("画像データが見つかりません"), "{html}");
        assert!(!html.contains("<img"), "{html}");
        assert_eq!(html.matches("media-missing").count(), 3, "{html}");
    }

    #[test]
    fn a_picture_over_the_single_image_limit_is_replaced_by_a_note() {
        let oversized = vec![0u8; MAX_PREVIEW_IMAGE_BYTES + 1024];
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r>{}</w:r></w:p>",
                inline_picture("rId4", None)
            )),
            &relationships(&[("rId4", "media/photo.png", false)]),
            &[("word/media/photo.png", &oversized)],
        );

        assert!(html.contains("画像が大きすぎます"), "{html}");
        assert!(!html.contains("<img"), "{html}");
    }

    #[test]
    fn the_document_wide_budget_stops_further_pictures() {
        let mut used_bytes = MAX_PREVIEW_IMAGE_TOTAL_BYTES - 1;
        match embed_media_bytes("image/png", PNG_BYTES, &mut used_bytes) {
            MediaImage::Unavailable(reason) => assert!(reason.contains("上限"), "{reason}"),
            MediaImage::Ready(src) => panic!("expected a placeholder, got {src}"),
        }
        assert_eq!(used_bytes, MAX_PREVIEW_IMAGE_TOTAL_BYTES - 1);

        let mut fresh = 0usize;
        match embed_media_bytes("image/png", PNG_BYTES, &mut fresh) {
            MediaImage::Ready(src) => assert!(src.starts_with("data:image/png;base64,")),
            MediaImage::Unavailable(reason) => panic!("expected a picture, got {reason}"),
        }
        assert_eq!(fresh, PNG_BYTES.len());
    }

    #[test]
    fn text_in_a_text_box_stays_out_of_the_paragraph_around_it() {
        let html = docx_preview(
            &word_document(
                r#"<w:p><w:r><w:t>前半</w:t></w:r><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>図の中</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r><w:r><w:t>後半</w:t></w:r></w:p>"#,
            ),
            &relationships(&[]),
            &[],
        );

        // One paragraph, not three: the `<w:p>` inside the text box used to
        // flush the paragraph that contains the drawing.
        assert_eq!(html.matches("<p>").count(), 1, "{html}");
        assert!(html.contains("office-textbox"), "{html}");
        let first = html.find("前半").expect("the text before the box");
        let boxed = html.find("図の中").expect("the text inside the box");
        let last = html.find("後半").expect("the text after the box");
        assert!(first < boxed && boxed < last, "{html}");
    }

    #[test]
    fn an_alternate_content_fallback_is_not_rendered_a_second_time() {
        let choice = format!(
            r#"<mc:Choice Requires="wps">{}<w:drawing><wp:inline><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>一度だけ</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice>"#,
            inline_picture("rId4", None)
        );
        let fallback = r#"<mc:Fallback><w:pict><v:shape><v:imagedata r:id="rId4"/><v:textbox><w:txbxContent><w:p><w:r><w:t>一度だけ</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>"#;
        let html = docx_preview(
            &word_document(&format!(
                "<w:p><w:r><mc:AlternateContent>{choice}{fallback}</mc:AlternateContent></w:r></w:p>"
            )),
            &relationships(&[("rId4", "media/photo.png", false)]),
            &[("word/media/photo.png", PNG_BYTES)],
        );

        assert_eq!(html.matches("<img").count(), 1, "{html}");
        assert_eq!(html.matches("一度だけ").count(), 1, "{html}");
    }

    #[test]
    fn a_word_preview_without_pictures_is_unchanged() {
        let html = docx_preview(
            &word_document(r#"<w:p><w:r><w:t>Hello</w:t></w:r></w:p>"#),
            &relationships(&[]),
            &[],
        );

        assert_eq!(html.trim(), "<p>Hello</p>");
    }

    #[test]
    fn a_slide_picture_is_rendered_next_to_its_text() {
        let dir = tempfile::tempdir().unwrap();
        let slide = r#"<p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r"><p:cSld>
            <p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId3"/></a:blipFill></p:bgPr></p:bg>
            <p:spTree>
              <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
              <p:sp><p:txBody><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>
            </p:spTree></p:cSld></p:sld>"#;
        let rels = relationships(&[
            ("rId2", "../media/photo.png", false),
            ("rId3", "../media/wallpaper.png", false),
        ]);
        let path = office_file(
            dir.path(),
            "deck.pptx",
            &[
                ("ppt/slides/slide1.xml", slide.as_bytes()),
                ("ppt/slides/_rels/slide1.xml.rels", rels.as_bytes()),
                ("ppt/media/photo.png", PNG_BYTES),
                ("ppt/media/wallpaper.png", PNG_BYTES),
            ],
        );

        let html = office_document_body_html(&path).expect("the preview is produced");

        assert!(
            html.contains("<p class=\"slide-figure\"><img src=\"data:image/png;base64,"),
            "{html}"
        );
        assert!(html.contains("<p>Title</p>"), "{html}");
        // The background fill is not slide content; drawing it on every slide
        // would bury the text and spend the picture budget on wallpaper.
        assert_eq!(html.matches("<img").count(), 1, "{html}");
    }

    #[test]
    fn a_relationship_the_body_never_names_is_not_read_at_all() {
        let document = word_document(&format!(
            "<w:p><w:r>{}</w:r></w:p>",
            inline_picture("rId4", None)
        ));
        let rels = relationships(&[
            ("rId4", "media/used.png", false),
            ("rId5", "media/orphan.png", false),
        ]);
        let mut archive = ZipArchive::new(Cursor::new(office_zip(&[
            ("word/document.xml", document.as_bytes()),
            ("word/_rels/document.xml.rels", rels.as_bytes()),
            ("word/media/used.png", PNG_BYTES),
            ("word/media/orphan.png", &[7u8; 4096]),
        ])))
        .unwrap();

        let mut budget = MediaBudget::default();
        let media = collect_part_media(&mut archive, "word/document.xml", &document, &mut budget);

        assert!(media.images.contains_key("rId4"));
        assert!(!media.images.contains_key("rId5"));
        assert_eq!(budget.used_bytes, PNG_BYTES.len());
    }

    #[test]
    fn a_picture_two_slides_share_is_encoded_once() {
        let slide = r#"<p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r"><p:cSld><p:spTree>
            <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
            </p:spTree></p:cSld></p:sld>"#;
        let rels = relationships(&[("rId2", "../media/photo.png", false)]);
        let mut archive = ZipArchive::new(Cursor::new(office_zip(&[
            ("ppt/slides/slide1.xml", slide.as_bytes()),
            ("ppt/slides/slide2.xml", slide.as_bytes()),
            ("ppt/slides/_rels/slide1.xml.rels", rels.as_bytes()),
            ("ppt/slides/_rels/slide2.xml.rels", rels.as_bytes()),
            ("ppt/media/photo.png", PNG_BYTES),
        ])))
        .unwrap();

        let mut budget = MediaBudget::default();
        let first = collect_part_media(&mut archive, "ppt/slides/slide1.xml", slide, &mut budget);
        let after_first = budget.used_bytes;
        let second = collect_part_media(&mut archive, "ppt/slides/slide2.xml", slide, &mut budget);

        assert_eq!(after_first, PNG_BYTES.len());
        // A deck puts one logo on every slide; charging it per slide would
        // turn the later slides into placeholders.
        assert_eq!(budget.used_bytes, after_first);
        for media in [first, second] {
            assert!(
                matches!(media.images.get("rId2"), Some(MediaImage::Ready(_))),
                "both slides still show the picture"
            );
        }
    }

    #[test]
    fn the_preview_stylesheet_carries_the_picture_rules() {
        let dir = tempfile::tempdir().unwrap();
        let path = office_file(
            dir.path(),
            "report.docx",
            &[(
                "word/document.xml",
                word_document(r#"<w:p><w:r><w:t>Hello</w:t></w:r></w:p>"#).as_bytes(),
            )],
        );

        let html = office_to_static_html(&path);

        assert!(
            html.contains(".office-preview img{max-width:100%;height:auto"),
            "{html}"
        );
        assert!(html.contains(".office-preview .media-missing{"), "{html}");
    }
}

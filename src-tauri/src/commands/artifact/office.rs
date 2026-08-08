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
use std::fs::File;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

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

pub(super) fn read_zip_text_entry(path: &Path, entry_name: &str) -> Result<String, String> {
    ensure_artifact_file_within_read_limit(path, "preview")?;
    let file = File::open(path).map_err(|error| format!("Failed to open Office file: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Failed to read Office archive: {error}"))?;
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|error| format!("Office entry not found ({entry_name}): {error}"))?;
    let mut contents = String::new();
    entry
        .read_to_string(&mut contents)
        .map_err(|error| format!("Failed to read Office XML ({entry_name}): {error}"))?;
    Ok(contents)
}

fn zip_entry_names(path: &Path, prefix: &str, suffix: &str) -> Result<Vec<String>, String> {
    ensure_artifact_file_within_read_limit(path, "preview")?;
    let file = File::open(path).map_err(|error| format!("Failed to open Office file: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Failed to read Office archive: {error}"))?;
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

pub(super) fn docx_xml_to_html(xml: &str) -> String {
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

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => match xml_local_name(element.name().as_ref()) {
                b"tbl" => {
                    flush_docx_paragraph(&mut body, &mut paragraph, &paragraph_format, false);
                    paragraph_format = DocxParagraphFormat::default();
                    body.push_str("<table><tbody>\n");
                    in_table = true;
                }
                b"p" if !in_table => {
                    paragraph.clear();
                    paragraph_format = DocxParagraphFormat::default();
                }
                b"pPr" => in_paragraph_properties = true,
                b"r" => run_format = DocxRunFormat::default(),
                b"rPr" => in_run_properties = true,
                b"tr" if in_table => body.push_str("<tr>"),
                b"tc" if in_table => {
                    in_cell = true;
                    cell.clear();
                }
                b"oMath" | b"oMathPara" => {
                    equation_depth += 1;
                    run_format.equation = true;
                }
                b"t" => in_text = true,
                _ => {
                    if in_paragraph_properties {
                        apply_docx_paragraph_property(&element, &mut paragraph_format);
                    }
                    if in_run_properties {
                        apply_docx_run_property(&element, &mut run_format);
                    }
                }
            },
            Ok(Event::Empty(element)) => match xml_local_name(element.name().as_ref()) {
                b"tab" => {
                    if in_cell {
                        cell.push(' ');
                    } else {
                        paragraph.push(' ');
                    }
                }
                b"br" => {
                    if in_cell {
                        cell.push_str("<br>");
                    } else {
                        paragraph.push_str("<br>");
                    }
                }
                _ => {
                    if in_paragraph_properties {
                        apply_docx_paragraph_property(&element, &mut paragraph_format);
                    }
                    if in_run_properties {
                        apply_docx_run_property(&element, &mut run_format);
                    }
                }
            },
            Ok(Event::Text(text)) if in_text => {
                let decoded = decode_xml_text(&text);
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
            Ok(Event::End(element)) => match xml_local_name(element.name().as_ref()) {
                b"t" => in_text = false,
                b"p" if !in_table => {
                    flush_docx_paragraph(&mut body, &mut paragraph, &paragraph_format, true);
                    paragraph_format = DocxParagraphFormat::default();
                }
                b"pPr" => in_paragraph_properties = false,
                b"rPr" => in_run_properties = false,
                b"r" => run_format = DocxRunFormat::default(),
                b"oMath" | b"oMathPara" => {
                    equation_depth = equation_depth.saturating_sub(1);
                }
                b"tc" if in_table => {
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
                b"tr" if in_table => body.push_str("</tr>\n"),
                b"tbl" => {
                    body.push_str("</tbody></table>\n");
                    in_table = false;
                }
                _ => {}
            },
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

pub(super) fn docx_to_html(path: &Path) -> Result<String, String> {
    ensure_artifact_file_within_read_limit(path, "preview")?;
    let xml = read_zip_text_entry(path, "word/document.xml")?;
    Ok(docx_xml_to_html(&xml))
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

pub(super) fn pptx_slide_xml_to_paragraphs(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut paragraphs = Vec::new();
    let mut current = String::new();
    let mut in_paragraph = false;
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => match xml_local_name(element.name().as_ref()) {
                b"p" => {
                    current.clear();
                    in_paragraph = true;
                }
                b"t" if in_paragraph => in_text = true,
                _ => {}
            },
            Ok(Event::Text(text)) if in_text => current.push_str(&decode_xml_text(&text)),
            Ok(Event::End(element)) => match xml_local_name(element.name().as_ref()) {
                b"t" => in_text = false,
                b"p" if in_paragraph => {
                    let trimmed = current.trim();
                    if !trimmed.is_empty() {
                        paragraphs.push(trimmed.to_string());
                    }
                    current.clear();
                    in_paragraph = false;
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    paragraphs
}

fn pptx_to_html(path: &Path) -> Result<String, String> {
    let slides = zip_entry_names(path, "ppt/slides/slide", ".xml")?;
    if slides.is_empty() {
        return Ok("<p class=\"office-empty\">No readable slides were found.</p>".to_string());
    }

    let mut body = String::new();
    for (index, slide_name) in slides.iter().take(24).enumerate() {
        let xml = read_zip_text_entry(path, slide_name)?;
        let paragraphs = pptx_slide_xml_to_paragraphs(&xml);
        body.push_str(&format!(
            "<section class=\"slide\"><h2>Slide {}</h2>",
            index + 1
        ));
        if paragraphs.is_empty() {
            body.push_str("<p class=\"office-empty\">No text on this slide.</p>");
        } else {
            for paragraph in paragraphs {
                body.push_str("<p>");
                body.push_str(&escape_html(&paragraph));
                body.push_str("</p>");
            }
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
        r#"html{background:#edf1f5;color:#1f2937}body{margin:0;min-height:100vh;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-sizing:border-box}.office-shell{width:min(1040px,100%);margin:0 auto;box-sizing:border-box;border:1px solid #d6dbe3;background:#fff;box-shadow:0 18px 50px rgba(15,23,42,.10)}.office-header{padding:24px 28px 18px;border-bottom:1px solid #e5e7eb}.office-type{display:inline-flex;align-items:center;height:24px;padding:0 9px;border:1px solid #c8d0da;background:#f5f7fa;color:#475569;font-size:11px;font-weight:700;letter-spacing:0;text-transform:uppercase}h1{margin:14px 0 16px;font-size:25px;line-height:1.2;font-weight:720;letter-spacing:0;color:#111827;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:72px minmax(0,1fr);gap:6px 14px;margin:0;padding:14px 0;border-top:1px solid #eef2f7}dt{color:#64748b;font-size:12px;font-weight:700}dd{margin:0;color:#1f2937;font-size:13px;line-height:1.45;overflow-wrap:anywhere}.office-note{margin:12px 0 0;color:#475569;font-size:13px;line-height:1.55}.office-preview{padding:28px;font-size:14px;line-height:1.65}.office-preview p{margin:0 0 .85em}.office-preview h2{margin:0 0 12px;font-size:16px;line-height:1.3;color:#111827}.office-preview table{width:100%;border-collapse:collapse;margin:0 0 18px;display:block;overflow-x:auto}.office-preview th,.office-preview td{border:1px solid #d8dee8;padding:7px 9px;vertical-align:top;min-width:56px}.office-preview tr:nth-child(even) td{background:#fbfcfe}.office-preview .mycmux-equation,.office-preview [data-mycmux-equation]{display:inline-block;margin:0 .12em;padding:.06em .34em;border:1px solid #bfdbfe;border-radius:4px;background:#eff6ff;color:#1d4ed8;font-family:'Cambria Math','Times New Roman',serif;font-style:italic;white-space:pre-wrap}.sheet,.slide{margin:0 0 22px;padding-bottom:18px;border-bottom:1px solid #eef2f7}.office-empty{color:#64748b;font-style:italic}@media(max-width:640px){body{padding:14px}.office-header,.office-preview{padding:18px}h1{font-size:21px}dl{grid-template-columns:1fr;gap:4px}}"#,
        escape_html(office_kind_label(path)),
        escape_html(file_name),
        escape_html(&parent),
        escape_html(&source_path),
        preview
    )
}

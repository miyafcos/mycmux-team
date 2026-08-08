//! Markdown to preview HTML, and the HTML editor round trip back to Markdown.
//!
//! The HTML this produces is rendered in a webview, so nothing from the source
//! document may reach it unescaped: raw HTML in the Markdown is shown as text,
//! and link targets are restricted to schemes that cannot execute script.

use kuchikiki::traits::TendrilSink;
use kuchikiki::{NodeData, NodeRef};

use super::{element_name, escape_html, text_content};
fn is_safe_link_target(target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with('#')
}

fn render_inline_markdown(value: &str) -> String {
    let mut rendered = String::new();
    let mut rest = value;
    while let Some(open) = rest.find('[') {
        rendered.push_str(&escape_html(&rest[..open]));
        let Some(close_rel) = rest[open + 1..].find(']') else {
            rendered.push_str(&escape_html(&rest[open..]));
            return rendered;
        };
        let close = open + 1 + close_rel;
        let after_label = &rest[close + 1..];
        if !after_label.starts_with('(') {
            rendered.push_str(&escape_html(&rest[open..=close]));
            rest = after_label;
            continue;
        }
        let Some(end_rel) = after_label[1..].find(')') else {
            rendered.push_str(&escape_html(&rest[open..]));
            return rendered;
        };
        let target = &after_label[1..1 + end_rel];
        let label = &rest[open + 1..close];
        if is_safe_link_target(target) {
            rendered.push_str("<a href=\"");
            rendered.push_str(&escape_html(target.trim()));
            rendered.push_str("\" rel=\"noreferrer\" target=\"_blank\">");
            rendered.push_str(&escape_html(label));
            rendered.push_str("</a>");
        } else {
            rendered.push_str(&escape_html(&rest[open..close + 3 + end_rel]));
        }
        rest = &after_label[2 + end_rel..];
    }
    rendered.push_str(&escape_html(rest));
    rendered
}

fn flush_paragraph(html: &mut String, paragraph: &mut Vec<String>) {
    if paragraph.is_empty() {
        return;
    }
    html.push_str("<p>");
    html.push_str(&render_inline_markdown(&paragraph.join(" ")));
    html.push_str("</p>\n");
    paragraph.clear();
}

fn parse_heading(line: &str) -> Option<(usize, &str)> {
    let marker_len = line.chars().take_while(|ch| *ch == '#').count();
    if marker_len == 0 || marker_len > 6 {
        return None;
    }
    let rest = &line[marker_len..];
    rest.strip_prefix(' ')
        .map(|text| (marker_len, text.trim()))
        .filter(|(_, text)| !text.is_empty())
}

fn render_safe_table_html(value: &str) -> Option<String> {
    let document = kuchikiki::parse_html()
        .one(format!("<!doctype html><html><body>{value}</body></html>"))
        .document_node;
    if document.select_first("script").is_ok() {
        return None;
    }
    let table = document.select_first("table").ok()?;
    let html = serialize_node_html(table.as_node());
    if html.trim().is_empty() {
        None
    } else {
        Some(html)
    }
}

pub(super) fn markdown_to_static_html(markdown: &str) -> String {
    let mut body = String::new();
    let mut paragraph: Vec<String> = Vec::new();
    let mut in_code = false;
    let mut code = String::new();
    let mut in_ul = false;

    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            if in_code {
                body.push_str("<pre><code>");
                body.push_str(&escape_html(&code));
                body.push_str("</code></pre>\n");
                code.clear();
                in_code = false;
            } else {
                flush_paragraph(&mut body, &mut paragraph);
                if in_ul {
                    body.push_str("</ul>\n");
                    in_ul = false;
                }
                in_code = true;
            }
            continue;
        }
        if in_code {
            code.push_str(line);
            code.push('\n');
            continue;
        }
        if trimmed.is_empty() {
            flush_paragraph(&mut body, &mut paragraph);
            if in_ul {
                body.push_str("</ul>\n");
                in_ul = false;
            }
            continue;
        }
        if trimmed.starts_with("<table") && trimmed.contains("</table>") {
            flush_paragraph(&mut body, &mut paragraph);
            if in_ul {
                body.push_str("</ul>\n");
                in_ul = false;
            }
            if let Some(table_html) = render_safe_table_html(trimmed) {
                body.push_str(&table_html);
                body.push('\n');
                continue;
            }
        }
        if let Some((level, text)) = parse_heading(trimmed) {
            flush_paragraph(&mut body, &mut paragraph);
            if in_ul {
                body.push_str("</ul>\n");
                in_ul = false;
            }
            body.push_str(&format!("<h{level}>"));
            body.push_str(&render_inline_markdown(text));
            body.push_str(&format!("</h{level}>\n"));
            continue;
        }
        if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            flush_paragraph(&mut body, &mut paragraph);
            if !in_ul {
                body.push_str("<ul>\n");
                in_ul = true;
            }
            body.push_str("<li>");
            body.push_str(&render_inline_markdown(item));
            body.push_str("</li>\n");
            continue;
        }
        paragraph.push(trimmed.to_string());
    }

    if in_code {
        body.push_str("<pre><code>");
        body.push_str(&escape_html(&code));
        body.push_str("</code></pre>\n");
    }
    flush_paragraph(&mut body, &mut paragraph);
    if in_ul {
        body.push_str("</ul>\n");
    }

    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>{}</style></head><body>{}</body></html>",
        r#"html{background:#eef1f5;color:#1f2937}body{box-sizing:border-box;min-height:100vh;max-width:940px;margin:0 auto;padding:40px 46px 72px;background:#fff;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.72}h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.45em 0 .55em;color:#111827;font-weight:720;letter-spacing:0}h1{font-size:2rem;margin-top:.25em;padding-bottom:.35em;border-bottom:1px solid #e5e7eb}h2{font-size:1.45rem;padding-bottom:.25em;border-bottom:1px solid #eef2f7}h3{font-size:1.18rem}p,ul,ol,pre,blockquote,table{margin:0 0 1.05em}ul,ol{padding-left:1.6em}li+li{margin-top:.25em}blockquote{padding:10px 16px;border-left:4px solid #c7d2fe;background:#f8fafc;color:#475569}pre{background:#0f172a;color:#e2e8f0;border:1px solid #1e293b;border-radius:6px;padding:14px 16px;overflow:auto}code{font-family:'JetBrains Mono','Consolas','SFMono-Regular',monospace;font-size:.92em}p code,li code{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;color:#0f172a;padding:1px 4px}a{color:#0f66d0;text-decoration-thickness:1px;text-underline-offset:2px}table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid #d8dee8;padding:8px 10px;vertical-align:top}th{background:#f6f8fb;color:#111827;font-weight:700}tr:nth-child(even) td{background:#fbfcfe}img{max-width:100%;height:auto}@media(max-width:720px){body{padding:26px 22px 56px;font-size:14px}h1{font-size:1.65rem}h2{font-size:1.28rem}}"#,
        body
    )
}

fn normalize_markdown_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_inline_markdown(value: &str) -> String {
    normalize_markdown_text(value)
}

fn serialize_node_html(node: &NodeRef) -> String {
    let mut bytes = Vec::new();
    if node.serialize(&mut bytes).is_err() {
        return String::new();
    }
    String::from_utf8(bytes).unwrap_or_default()
}

fn is_block_element(name: &str) -> bool {
    matches!(
        name,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "div"
            | "dl"
            | "fieldset"
            | "figcaption"
            | "figure"
            | "footer"
            | "form"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hr"
            | "li"
            | "main"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "table"
            | "ul"
    )
}

fn inline_children_to_markdown(node: &NodeRef) -> String {
    node.children()
        .map(|child| inline_node_to_markdown(&child))
        .collect::<Vec<_>>()
        .join("")
}

fn inline_node_to_markdown(node: &NodeRef) -> String {
    match node.data() {
        NodeData::Text(text) => text.borrow().to_string(),
        NodeData::Element(element) => {
            let name = element.name.local.to_string();
            match name.as_str() {
                "strong" | "b" => {
                    let inner = inline_children_to_markdown(node);
                    if inner.is_empty() {
                        String::new()
                    } else {
                        format!("**{}**", inner.trim())
                    }
                }
                "em" | "i" => {
                    let inner = inline_children_to_markdown(node);
                    if inner.is_empty() {
                        String::new()
                    } else {
                        format!("*{}*", inner.trim())
                    }
                }
                "code" => {
                    let inner = text_content(node);
                    if inner.contains('`') {
                        format!("``{inner}``")
                    } else {
                        format!("`{inner}`")
                    }
                }
                "a" => {
                    let inner = inline_children_to_markdown(node);
                    let attrs = element.attributes.borrow();
                    if let Some(href) = attrs.get("href") {
                        if inner.is_empty() {
                            href.to_string()
                        } else {
                            format!("[{inner}]({href})")
                        }
                    } else {
                        inner
                    }
                }
                "br" => "  \n".to_string(),
                "img" => {
                    let attrs = element.attributes.borrow();
                    let alt = attrs.get("alt").unwrap_or("");
                    let src = attrs.get("src").unwrap_or("");
                    if src.is_empty() {
                        String::new()
                    } else {
                        format!("![{alt}]({src})")
                    }
                }
                "span" | "small" | "sub" | "sup" | "mark" => inline_children_to_markdown(node),
                _ if is_block_element(&name) => serialize_node_html(node),
                _ => inline_children_to_markdown(node),
            }
        }
        _ => String::new(),
    }
}

fn list_to_markdown(node: &NodeRef, ordered: bool) -> String {
    let mut lines = Vec::new();
    let mut index = 1;
    for child in node.children() {
        if element_name(&child).as_deref() != Some("li") {
            continue;
        }
        let item = normalize_inline_markdown(&inline_children_to_markdown(&child));
        let item = if item.trim().is_empty() {
            text_content(&child)
        } else {
            item
        };
        let marker = if ordered {
            let marker = format!("{index}.");
            index += 1;
            marker
        } else {
            "-".to_string()
        };
        lines.push(format!("{marker} {}", item.trim()));
    }
    lines.join("\n")
}

fn block_node_to_markdown(node: &NodeRef) -> Option<String> {
    match node.data() {
        NodeData::Text(text) => {
            let value = normalize_markdown_text(&text.borrow());
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        }
        NodeData::Element(element) => {
            let name = element.name.local.to_string();
            match name.as_str() {
                "script" | "style" => None,
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    let level = name[1..].parse::<usize>().unwrap_or(1).clamp(1, 6);
                    let text = normalize_inline_markdown(&inline_children_to_markdown(node));
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(format!("{} {}", "#".repeat(level), text.trim()))
                    }
                }
                "p" => {
                    let text = normalize_inline_markdown(&inline_children_to_markdown(node));
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(text.trim().to_string())
                    }
                }
                "ul" => Some(list_to_markdown(node, false)).filter(|text| !text.trim().is_empty()),
                "ol" => Some(list_to_markdown(node, true)).filter(|text| !text.trim().is_empty()),
                "pre" => {
                    let code = text_content(node);
                    Some(format!("```\n{}\n```", code.trim_matches('\n')))
                }
                "blockquote" => {
                    let inner = node
                        .children()
                        .filter_map(|child| block_node_to_markdown(&child))
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    if inner.trim().is_empty() {
                        None
                    } else {
                        Some(
                            inner
                                .lines()
                                .map(|line| format!("> {line}"))
                                .collect::<Vec<_>>()
                                .join("\n"),
                        )
                    }
                }
                "table" => {
                    let html = serialize_node_html(node);
                    if html.trim().is_empty() {
                        None
                    } else {
                        Some(html)
                    }
                }
                "div" | "section" | "article" | "main" | "body" => {
                    let blocks = node
                        .children()
                        .filter_map(|child| block_node_to_markdown(&child))
                        .collect::<Vec<_>>();
                    if blocks.is_empty() {
                        let text = normalize_inline_markdown(&inline_children_to_markdown(node));
                        if text.trim().is_empty() {
                            None
                        } else {
                            Some(text.trim().to_string())
                        }
                    } else {
                        Some(blocks.join("\n\n"))
                    }
                }
                "br" => Some(String::new()),
                _ if is_block_element(&name) => {
                    let html = serialize_node_html(node);
                    if html.trim().is_empty() {
                        None
                    } else {
                        Some(html)
                    }
                }
                _ => {
                    let text = normalize_inline_markdown(&inline_children_to_markdown(node));
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(text.trim().to_string())
                    }
                }
            }
        }
        _ => None,
    }
}

pub(super) fn html_fragment_to_markdown(fragment: &str) -> String {
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
    let markdown = body
        .children()
        .filter_map(|child| block_node_to_markdown(&child))
        .collect::<Vec<_>>()
        .join("\n\n");
    let trimmed = markdown.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}\n")
    }
}

pub(super) fn looks_like_html_fragment(value: &str) -> bool {
    let trimmed = value.trim_start();
    trimmed.starts_with('<') && trimmed.contains('>')
}

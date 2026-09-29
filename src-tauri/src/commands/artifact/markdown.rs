//! The HTML editor round trip back to Markdown.
//!
//! The editor hands back the body it was editing, so this turns that DOM into
//! Markdown again: what Markdown has a syntax for becomes Markdown, and what it
//! does not (a table, an unknown block) stays the HTML it already was.
//!
//! The other direction - Markdown to the HTML the preview pane shows - lives in
//! `markdown_preview.rs`.

use kuchikiki::traits::TendrilSink;
use kuchikiki::{NodeData, NodeRef};

use super::{element_name, text_content};

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

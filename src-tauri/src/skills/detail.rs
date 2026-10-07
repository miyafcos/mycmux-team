use super::{catalog, files, frontmatter};
use kuchikiki::{traits::TendrilSink, NodeData, NodeRef};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn safe_link(link: &str) -> bool {
    let lower = link.trim().to_lowercase();
    lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:")
        || (lower.starts_with('#') && !lower.contains(char::is_whitespace))
}
fn sanitize(node: &NodeRef, depth: usize, out: &mut String) {
    if depth > 128 {
        return;
    }
    match node.data() {
        NodeData::Text(text) => out.push_str(&escape(&text.borrow())),
        NodeData::Element(element) => {
            let tag = element.name.local.to_string();
            if element.name.ns.as_ref() != "http://www.w3.org/1999/xhtml" {
                return;
            }
            if [
                "script", "style", "iframe", "object", "embed", "form", "input", "textarea",
                "button", "img", "svg", "math",
            ]
            .contains(&tag.as_str())
            {
                return;
            }
            let allowed = [
                "p",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "ul",
                "ol",
                "li",
                "pre",
                "code",
                "blockquote",
                "strong",
                "em",
                "del",
                "s",
                "a",
                "hr",
                "br",
                "table",
                "thead",
                "tbody",
                "tr",
                "td",
                "th",
                "sup",
                "sub",
            ]
            .contains(&tag.as_str());
            if allowed {
                out.push('<');
                out.push_str(&tag);
                if tag == "a" {
                    if let Some(href) = element
                        .attributes
                        .borrow()
                        .get("href")
                        .filter(|h| safe_link(h))
                    {
                        out.push_str(" href=\"");
                        out.push_str(&escape(href));
                        out.push_str("\"");
                    }
                }
                out.push('>');
            }
            for child in node.children() {
                sanitize(&child, depth + 1, out);
            }
            if allowed && tag != "hr" && tag != "br" {
                out.push_str("</");
                out.push_str(&tag);
                out.push('>');
            }
        }
        _ => {
            for child in node.children() {
                sanitize(&child, depth + 1, out);
            }
        }
    }
}
pub fn markdown(body: &str) -> String {
    let mut options = comrak::Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.render.r#unsafe = true;
    let rendered = comrak::markdown_to_html(body, &options);
    let tree = kuchikiki::parse_html()
        .one(format!("<br>{rendered}"))
        .document_node;
    let mut html = String::new();
    if let Ok(body) = tree.select_first("body") {
        for child in body.as_node().children().skip(1) {
            sanitize(&child, 0, &mut html);
        }
    }
    html
}
pub fn content(path: &Path) -> Value {
    let text = catalog::text(path);
    let (fm, body) = frontmatter::split(&text);
    let html = markdown(body);
    let tree = kuchikiki::parse_html().one(html.clone()).document_node;
    let toc: Vec<_> = tree
        .select("h1,h2,h3,h4,h5,h6")
        .into_iter()
        .flatten()
        .map(|heading| {
            let level = heading.name.local.to_string()[1..]
                .parse::<usize>()
                .unwrap_or(1);
            json!({"level":level,"text":heading.text_contents()})
        })
        .collect();
    json!({"frontmatter":fm,"body":body,"html":html,"toc":toc,"lines":text.lines().count(),"modifiedAt":catalog::mtime(path)*1000.0,"size":text.len()})
}
fn wrapper_target(home: &Path, body: &str) -> Option<PathBuf> {
    let mut choices = Vec::new();
    for (index, chunk) in body.split('`').enumerate() {
        if index % 2 == 1 && chunk.to_lowercase().ends_with("skill.md") {
            choices.push(chunk.to_owned());
        }
    }
    for raw in choices {
        let raw = raw.replace('\\', "/");
        let candidate = if let Some(rel) = raw.strip_prefix("~/") {
            home.join(rel)
        } else {
            PathBuf::from(raw)
        };
        if candidate.is_absolute() && !files::private_path(&candidate) {
            return Some(candidate);
        }
    }
    None
}
pub fn locations(home: &Path, id: &str) -> Value {
    let (docs, _, claude) = catalog::sources(home);
    let codex_paths: std::collections::BTreeSet<_> = docs
        .iter()
        .filter(|doc| doc.agent == "codex")
        .map(|doc| doc.path.clone())
        .collect();
    let mut candidates: Vec<_> = docs
        .into_iter()
        .filter(|d| {
            let text = catalog::text(&d.path);
            let (fm, _) = frontmatter::split(&text);
            fm["name"]
                .as_str()
                .unwrap_or(
                    d.path
                        .parent()
                        .unwrap()
                        .file_name()
                        .unwrap()
                        .to_str()
                        .unwrap_or(""),
                )
                .eq_ignore_ascii_case(id)
        })
        .map(|d| d.path)
        .collect();
    candidates.extend(
        claude
            .into_iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(id))
            .map(|(_, p)| p),
    );
    // Missing reparse targets have no document, but still belong in the map.
    for root in [
        ".claude/skills",
        ".agents/skills",
        ".codex/skills",
        ".hermes/skills",
    ] {
        let folder = home.join(root).join(id);
        if files::reparse(&folder) && !folder.join("SKILL.md").is_file() {
            candidates.push(folder.join("SKILL.md"));
        }
    }
    candidates.sort();
    candidates.dedup();
    candidates.sort_by_key(|p| {
        if p.starts_with(home.join(".claude/skills")) {
            0
        } else if p.starts_with(home.join(".codex/skills")) {
            1
        } else if p.starts_with(home.join(".agents/skills")) {
            2
        } else {
            3
        }
    });
    let canonical_source = candidates
        .iter()
        .find(|p| p.starts_with(home.join(".claude/skills")) && p.is_file())
        .or_else(|| candidates.iter().find(|p| p.is_file()));
    let original = canonical_source
        .map(|p| catalog::text(p))
        .unwrap_or_default();
    let (original_fm, _) = frontmatter::split(&original);
    let codex_count = candidates
        .iter()
        .filter(|path| codex_paths.contains(*path) && path.is_file())
        .count();
    let mut items = Vec::new();
    for path in &candidates {
        let folder = path.parent().unwrap();
        let text = catalog::text(path);
        let (fm, body) = frontmatter::split(&text);
        let wrapper = body
            .trim_start()
            .trim_start_matches(['#', ' '])
            .starts_with("Compatibility wrapper");
        let target = if wrapper {
            wrapper_target(home, body)
        } else {
            None
        };
        let relation = if files::reparse(folder) {
            if path.is_file() {
                "junction"
            } else {
                "brokenJunction"
            }
        } else if wrapper {
            "wrapper"
        } else if canonical_source == Some(path) {
            "source"
        } else if !original.is_empty()
            && (text == original || path.starts_with(home.join(".agents/skills")))
        {
            "copy"
        } else {
            "independent"
        };
        let plan = files::plan(path, id).ok();
        let file_count = plan
            .as_ref()
            .and_then(|p| p["files"].as_array())
            .map(Vec::len);
        let implicit = frontmatter::parse(&catalog::text(&folder.join("agents/openai.yaml")))
            ["policy"]["allow_implicit_invocation"]
            .as_bool();
        let mut target_exists = None;
        let mut description_same = None;
        if let Some(target) = &target {
            target_exists = Some(target.is_file());
            if target.is_file() {
                let text = catalog::text(target);
                description_same =
                    Some(frontmatter::split(&text).0["description"] == fm["description"]);
            }
        }
        let is_same = if relation == "copy" {
            Some(text == original)
        } else {
            None
        };
        items.push(json!({"path":path,"folder":folder,"relation":relation,"modifiedAt":catalog::mtime(path)*1000.0,"lines":text.lines().count(),"fileCount":file_count,"allowImplicitInvocation":implicit,"target":target,"targetExists":target_exists,"descriptionSame":description_same,"sameContent":is_same,"description":fm["description"],"originalDescription":original_fm["description"],"hash":format!("{:x}",Sha256::digest(text.as_bytes()))}));
    }
    json!({"id":id,"duplicateCodex":codex_count>1,"codexCount":codex_count,"items":items})
}
pub fn diff(left: &str, right: &str) -> Value {
    let a: Vec<_> = left.lines().collect();
    let b: Vec<_> = right.lines().collect();
    if a.len() * b.len() > 4_000_000 {
        return json!({"truncated":true,"lines":[]});
    }
    let mut lcs = vec![vec![0u32; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut lines = Vec::new();
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            lines.push(json!({"kind":"equal","left":i+1,"right":j+1,"text":a[i]}));
            i += 1;
            j += 1;
        } else if j < b.len() && (i == a.len() || lcs[i][j + 1] >= lcs[i + 1][j]) {
            lines.push(json!({"kind":"add","right":j+1,"text":b[j]}));
            j += 1;
        } else {
            lines.push(json!({"kind":"remove","left":i+1,"text":a[i]}));
            i += 1;
        }
    }
    json!({"truncated":false,"lines":lines})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markdown_drops_active_html_attributes_and_remote_images() {
        let rendered=markdown("# Title\n\n<script>alert(1)</script><svg><script>bad</script></svg><a href=\"javascript:bad\" onclick=\"bad\">x</a>\n\n[ok](https://example.test)\n\n| A | B |\n|---|---|\n| a | b |\n");
        assert!(!rendered.contains("<script"));
        assert!(!rendered.contains("onclick"));
        assert!(!rendered.contains("javascript:"));
        assert!(rendered.contains("https://example.test"));
        assert!(rendered.contains("<table>"));
    }
    #[test]
    fn line_diff_accounts_for_every_line() {
        let diff = diff("same\nold\n", "same\nnew\n");
        assert_eq!(diff["lines"].as_array().unwrap().len(), 3);
    }
}

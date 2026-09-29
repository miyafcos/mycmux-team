//! Markdown to the static HTML the preview pane shows.
//!
//! comrak parses the document and writes the first HTML. That HTML is parsed
//! again with kuchikiki and rebuilt through an allowlist, because a Markdown
//! document may carry raw HTML and because a link target decides what a click
//! is allowed to reach. Nothing leaves this module that the allowlist did not
//! put there, and the internal `data-mycmux-*` attributes the pane reads are
//! added *after* the sanitiser runs, so a document cannot forge them.
//!
//! Colours are custom properties declared in `markdown_preview.css`. The pane
//! paints the active theme over them (`src/lib/markdownPreviewTheme.ts`), so the
//! same file opened on its own still reads correctly.
//!
//! Design memo: `docs/design/markdown-preview.md`.

use std::path::{Component, Path, PathBuf};

use comrak::nodes::{AstNode, NodeValue};
use comrak::{format_html, parse_document, Arena, Options};
use super::local_path::{is_safe_path_segment, normalize_local_path, starts_with_two_separators};
use kuchikiki::traits::TendrilSink;
use kuchikiki::{Attribute, ExpandedName, NodeData, NodeRef};

use super::path_resolve::decode_file_uri;

const PREVIEW_CSS: &str = include_str!("markdown_preview.css");

/// Every element the HTML parser puts in the body carries this namespace.
/// Anything else came from `<svg>` or `<math>` and is dropped with its contents.
const HTML_NS: &str = "http://www.w3.org/1999/xhtml";

/// `default-src 'none'` with pictures allowed from anywhere: a document may
/// point at an image on the web, and a local image is rewritten to the asset
/// protocol by the pane before the frame sees it. Scripts have no source at
/// all, and the frame is sandboxed without `allow-scripts` on top of this.
const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; img-src * data: blob: asset: http://asset.localhost https://asset.localhost; style-src 'unsafe-inline'; font-src * data:; base-uri 'none'; form-action 'none'";

/// Marks the `<br>` inserted ahead of the rendered HTML. Its only job is to set
/// the parser's frameset-ok flag to "not ok": a document whose first raw tag is
/// `<frameset>` would otherwise replace the body element and take the whole
/// document with it. It is removed again before anything else runs.
const SENTINEL_ATTRIBUTE: &str = "data-mycmux-body-sentinel";

/// Elements nested deeper than this are unwrapped. The HTML serialiser recurses
/// once per level, and a document can nest block quotes without limit.
const MAX_ELEMENT_DEPTH: usize = 256;

/// Upper bound for the column bookkeeping below, so a forged `colspan` cannot
/// make the table pass allocate.
const MAX_TABLE_COLUMNS: usize = 64;

/// A column whose widest cell fits in this many character widths keeps its cells
/// on one line; anything wider wraps like ordinary text.
const NOWRAP_MAX_DISPLAY_WIDTH: usize = 16;

/// Renders `markdown` as a standalone HTML document.
///
/// `source_path` is the file the Markdown came from; relative links and images
/// resolve against its directory. Without it, relative targets are dropped -
/// there is no honest answer for what they point at.
pub(super) fn markdown_to_static_html(markdown: &str, source_path: Option<&Path>) -> String {
    let options = comrak_options();
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options);
    let front_matter = take_front_matter(root);
    keep_single_tildes_literal(&arena, root);

    let mut rendered = String::new();
    // Writing into a String cannot fail. A formatter error could only cut the
    // body short, and the document is still assembled from what was written.
    let _ = format_html(root, &options, &mut rendered);

    let body = rebuild_body(&rendered, front_matter.as_deref(), source_path);
    format!(
        "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"{CONTENT_SECURITY_POLICY}\"><style>{PREVIEW_CSS}</style></head><body>{body}</body></html>"
    )
}

/// The extensions a report written for this app actually uses. `tagfilter` is
/// deprecated in comrak 0.55 but still turns `<script>` and friends into text
/// one layer before the sanitiser sees them, which is worth keeping.
#[allow(deprecated)]
fn comrak_options() -> Options<'static> {
    let mut options = Options::default();

    options.extension.strikethrough = true;
    options.extension.tagfilter = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    options.extension.alerts = true;
    options.extension.math_dollars = true;
    options.extension.math_code = true;
    // Single tildes become subscript nodes, which the AST pass below turns back
    // into literal `~` characters. Without this they would be strikethrough,
    // and `9/15~9/17` would read as struck-out text.
    options.extension.subscript = true;
    options.extension.cjk_friendly_emphasis = true;
    // An empty prefix still gives every heading an id, which is what `#anchor`
    // links in the same document need.
    options.extension.header_id_prefix = Some(String::new());
    options.extension.front_matter_delimiter = Some("---".to_string());

    options.parse.smart = false;

    // Typora shows a single newline inside a paragraph as a line break, and so
    // does every editor these documents are written in.
    options.render.hardbreaks = true;
    // Raw HTML is rendered, then filtered by the sanitiser below. Escaping it
    // instead would show the markup as text, which is what the old renderer did.
    options.render.r#unsafe = true;
    options.render.escape = false;
    options.render.tasklist_classes = true;

    options
}

// ---------------------------------------------------------------------------
// AST pass
// ---------------------------------------------------------------------------

/// Takes the front matter out of the tree and returns its body without the
/// delimiter lines. The HTML formatter drops front matter entirely, and a
/// document that opens with `---` should not silently lose its header.
fn take_front_matter<'a>(root: &'a AstNode<'a>) -> Option<String> {
    let node = root
        .children()
        .find(|child| matches!(child.data().value, NodeValue::FrontMatter(_)))?;
    let raw = match node.data().value {
        NodeValue::FrontMatter(ref text) => text.clone(),
        _ => return None,
    };
    node.detach();

    let mut lines: Vec<&str> = raw.lines().collect();
    if lines.first().is_some_and(|line| line.trim_end() == "---") {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    if lines.last().is_some_and(|line| line.trim_end() == "---") {
        lines.pop();
    }
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    let body = lines.join("\n");
    let body = body.trim_end().to_string();
    (!body.is_empty()).then_some(body)
}

/// Rewrites every subscript node as `~` + its children + `~`.
///
/// The subscript extension is on only so that a single tilde stops being
/// strikethrough; ranges like `9/15~9/17` and `1~2 件` must survive as typed.
fn keep_single_tildes_literal<'a>(arena: &'a Arena<'a>, root: &'a AstNode<'a>) {
    let subscripts: Vec<&'a AstNode<'a>> = root
        .descendants()
        .filter(|node| matches!(node.data().value, NodeValue::Subscript))
        .collect();
    for node in subscripts {
        let opening = arena.alloc(NodeValue::Text("~".into()).into());
        node.insert_before(opening);
        for child in node.children().collect::<Vec<_>>() {
            node.insert_before(child);
        }
        let closing = arena.alloc(NodeValue::Text("~".into()).into());
        node.insert_before(closing);
        node.detach();
    }
}

// ---------------------------------------------------------------------------
// HTML pass
// ---------------------------------------------------------------------------

fn rebuild_body(rendered: &str, front_matter: Option<&str>, source_path: Option<&Path>) -> String {
    let document = kuchikiki::parse_html()
        .one(format!(
            "<!doctype html><html><body><br {SENTINEL_ATTRIBUTE}=\"\">{rendered}</body></html>"
        ))
        .document_node;
    let Ok(body) = document.select_first("body") else {
        return String::new();
    };
    let body = body.as_node().clone();

    remove_sentinel(&body);
    sanitize_subtree(&body);
    resolve_targets(&body, source_path);
    strip_heading_anchors(&body);
    translate_alert_titles(&body);
    trim_autolinks(&body);
    lay_out_tables(&body);
    if let Some(front_matter) = front_matter {
        prepend_front_matter(&body, front_matter);
    }

    body.children()
        .map(|child| serialize_node(&child))
        .collect()
}

fn remove_sentinel(body: &NodeRef) {
    let Some(first) = body.first_child() else {
        return;
    };
    let is_sentinel = first
        .as_element()
        .is_some_and(|element| element.attributes.borrow().contains(SENTINEL_ATTRIBUTE));
    if is_sentinel {
        first.detach();
    }
}

enum ElementPolicy {
    /// Kept, with its attributes filtered.
    Keep,
    /// Removed together with everything inside it.
    Drop,
    /// Removed, with its children left in its place.
    Unwrap,
    /// `input`: kept only as a disabled checkbox, dropped otherwise.
    Checkbox,
}

fn element_policy(name: &str) -> ElementPolicy {
    if matches!(
        name,
        "script"
            | "style"
            | "template"
            | "noscript"
            | "iframe"
            | "frame"
            | "frameset"
            | "object"
            | "embed"
            | "applet"
            | "noembed"
            | "noframes"
            | "xmp"
            | "plaintext"
            | "title"
            | "textarea"
            | "select"
            | "button"
            | "svg"
            | "math"
            | "canvas"
            | "audio"
            | "video"
            | "link"
            | "meta"
            | "base"
            | "head"
    ) {
        return ElementPolicy::Drop;
    }
    if name == "input" {
        return ElementPolicy::Checkbox;
    }
    if matches!(
        name,
        "p" | "div"
            | "span"
            | "br"
            | "hr"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "blockquote"
            | "pre"
            | "code"
            | "kbd"
            | "samp"
            | "var"
            | "ul"
            | "ol"
            | "li"
            | "dl"
            | "dt"
            | "dd"
            | "table"
            | "thead"
            | "tbody"
            | "tfoot"
            | "tr"
            | "th"
            | "td"
            | "caption"
            | "colgroup"
            | "col"
            | "a"
            | "img"
            | "strong"
            | "b"
            | "em"
            | "i"
            | "u"
            | "s"
            | "strike"
            | "del"
            | "ins"
            | "mark"
            | "small"
            | "sub"
            | "sup"
            | "abbr"
            | "cite"
            | "q"
            | "dfn"
            | "time"
            | "ruby"
            | "rt"
            | "rp"
            | "bdi"
            | "bdo"
            | "wbr"
            | "details"
            | "summary"
            | "figure"
            | "figcaption"
            | "section"
            | "center"
    ) {
        return ElementPolicy::Keep;
    }
    ElementPolicy::Unwrap
}

/// Walks the body once and rebuilds it from the allowlist. Comments, processing
/// instructions and foreign (SVG / MathML) elements leave with their contents;
/// an element nobody listed keeps its text but loses the element itself.
fn sanitize_subtree(body: &NodeRef) {
    let mut stack: Vec<(NodeRef, usize)> = body.children().map(|child| (child, 1)).collect();
    while let Some((node, depth)) = stack.pop() {
        let name = match node.data() {
            NodeData::Text(_) => continue,
            NodeData::Element(element) => {
                if &*element.name.ns != HTML_NS {
                    node.detach();
                    continue;
                }
                // The parser lowercases HTML tag names; the fold is here so the
                // allowlist below cannot be stepped around by a spelling.
                let local: &str = &element.name.local;
                local.to_ascii_lowercase()
            }
            // Comments, processing instructions, stray doctypes and fragments.
            _ => {
                node.detach();
                continue;
            }
        };

        let policy = if depth > MAX_ELEMENT_DEPTH {
            ElementPolicy::Unwrap
        } else {
            element_policy(&name)
        };
        match policy {
            ElementPolicy::Drop => node.detach(),
            ElementPolicy::Unwrap => {
                for child in node.children().collect::<Vec<_>>() {
                    node.insert_before(child.clone());
                    stack.push((child, depth));
                }
                node.detach();
            }
            // A checkbox has no children to visit.
            ElementPolicy::Checkbox => {
                if !keep_as_checkbox(&node) {
                    node.detach();
                }
            }
            ElementPolicy::Keep => {
                sanitize_attributes(&node, &name);
                for child in node.children().collect::<Vec<_>>() {
                    stack.push((child, depth + 1));
                }
            }
        }
    }
}

/// `<input type=checkbox>` is the one form control worth keeping: the task list
/// extension emits it. It keeps its classes and its checked state, is forced to
/// `disabled`, and loses every other attribute.
fn keep_as_checkbox(node: &NodeRef) -> bool {
    let Some(element) = node.as_element() else {
        return false;
    };
    let mut attributes = element.attributes.borrow_mut();
    let is_checkbox = attributes
        .get("type")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("checkbox"));
    if !is_checkbox {
        return false;
    }
    let classes = attributes.get("class").and_then(sanitized_class_value);
    let checked = attributes.contains("checked");
    attributes.map.clear();
    if let Some(classes) = classes {
        attributes.insert("class", classes);
    }
    if checked {
        attributes.insert("checked", String::new());
    }
    // The type is re-added rather than kept, so a document cannot smuggle
    // another control in by spelling it `TYPE=" CheckBox "`.
    attributes.insert("type", "checkbox".to_string());
    attributes.insert("disabled", String::new());
    true
}

fn sanitize_attributes(node: &NodeRef, name: &str) {
    let Some(element) = node.as_element() else {
        return;
    };
    let mut attributes = element.attributes.borrow_mut();
    attributes.map.retain(|key, attribute| {
        // Namespaced attributes only exist inside foreign content (`xlink:href`),
        // which never survives the element pass.
        if !key.ns.is_empty() {
            return false;
        }
        let local: &str = &key.local;
        keep_attribute(name, &local.to_ascii_lowercase(), &mut attribute.value)
    });
}

/// Decides one attribute, normalising the value in place where the allowlist
/// only accepts a fixed set of spellings.
fn keep_attribute(element: &str, attribute: &str, value: &mut String) -> bool {
    match attribute {
        "id" => value.chars().count() <= 256,
        "class" => match sanitized_class_value(value) {
            Some(classes) => {
                *value = classes;
                true
            }
            None => false,
        },
        "title"
        | "lang"
        | "aria-label"
        | "aria-hidden"
        | "data-footnote-ref"
        | "data-footnotes"
        | "data-footnote-backref"
        | "data-footnote-backref-idx"
        | "data-math-style" => true,
        "dir" => keep_enumerated(value, &["ltr", "rtl", "auto"]),
        "align" => keep_enumerated(value, &["left", "right", "center", "justify"]),
        "href" | "name" => element == "a",
        "src" | "alt" => element == "img",
        "width" | "height" => element == "img" && is_dimension(value),
        "colspan" | "rowspan" => matches!(element, "td" | "th") && is_small_number(value),
        "scope" => matches!(element, "td" | "th"),
        "start" => element == "ol" && is_small_number(value),
        "reversed" | "type" => element == "ol",
        "value" => element == "li" && is_small_number(value),
        "span" => matches!(element, "col" | "colgroup") && is_small_number(value),
        "open" => element == "details",
        "datetime" => element == "time",
        "cite" => matches!(element, "q" | "blockquote" | "del" | "ins"),
        // Everything else, `on*` / `style` / `target` / `srcset` / `data-mycmux-*`
        // / `data-label*` included.
        _ => false,
    }
}

/// Keeps the class tokens that look like class names and drops the rest, so a
/// document cannot hand the stylesheet a value it never expected.
fn sanitized_class_value(value: &str) -> Option<String> {
    let classes: Vec<&str> = value
        .split_whitespace()
        .filter(|token| {
            token.len() <= 64
                && token
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        })
        .collect();
    (!classes.is_empty()).then(|| classes.join(" "))
}

fn keep_enumerated(value: &mut String, allowed: &[&str]) -> bool {
    let trimmed = value.trim().to_ascii_lowercase();
    if allowed.contains(&trimmed.as_str()) {
        *value = trimmed;
        true
    } else {
        false
    }
}

fn is_small_number(value: &str) -> bool {
    !value.is_empty() && value.len() <= 6 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_dimension(value: &str) -> bool {
    is_small_number(value.strip_suffix('%').unwrap_or(value))
}

// ---------------------------------------------------------------------------
// Link and image targets
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum TargetKind {
    Href,
    ImageSrc,
    Cite,
}

enum Target {
    /// Usable by the webview as it stands.
    Keep(String),
    /// A file on this machine; the pane decides what opening it means.
    Local(String),
    /// Nothing safe to point at.
    Drop,
}

fn resolve_targets(body: &NodeRef, source_path: Option<&Path>) {
    let base_dir = source_path.map(dunce::simplified).and_then(Path::parent);
    let elements: Vec<NodeRef> = body
        .descendants()
        .filter(|node| node.as_element().is_some())
        .collect();

    for node in elements {
        let Some(name) = element_local_name(&node) else {
            continue;
        };
        match name.as_str() {
            "a" => resolve_anchor(&node, base_dir),
            "img" => resolve_image(&node, base_dir),
            "q" | "blockquote" | "del" | "ins" => resolve_cite(&node, base_dir),
            _ => {}
        }
    }
}

fn resolve_anchor(node: &NodeRef, base_dir: Option<&Path>) {
    let Some(element) = node.as_element() else {
        return;
    };
    let Some(href) = element.attributes.borrow().get("href").map(str::to_string) else {
        return;
    };
    match resolve_target(&href, TargetKind::Href, base_dir) {
        Target::Keep(value) => {
            element.attributes.borrow_mut().insert("href", value);
        }
        Target::Local(path) => {
            // The href stays as written - the pane intercepts the click and
            // opens the path from the attribute below, and leaving the href in
            // place keeps the link readable when the file is opened elsewhere.
            let mut attributes = element.attributes.borrow_mut();
            attributes.insert("data-mycmux-local-path", path.clone());
            if attributes.get("title").is_none() {
                attributes.insert("title", path);
            }
        }
        Target::Drop => {
            element.attributes.borrow_mut().remove("href");
        }
    }
}

fn resolve_image(node: &NodeRef, base_dir: Option<&Path>) {
    let Some(element) = node.as_element() else {
        return;
    };
    let Some(src) = element.attributes.borrow().get("src").map(str::to_string) else {
        return;
    };
    match resolve_target(&src, TargetKind::ImageSrc, base_dir) {
        Target::Keep(value) => {
            element.attributes.borrow_mut().insert("src", value);
        }
        Target::Local(path) => {
            let mut attributes = element.attributes.borrow_mut();
            attributes.remove("src");
            attributes.insert("data-mycmux-local-src", path);
            attributes.insert("loading", "lazy".to_string());
        }
        Target::Drop => {
            let alt = element
                .attributes
                .borrow()
                .get("alt")
                .unwrap_or_default()
                .to_string();
            if !alt.is_empty() {
                node.insert_before(NodeRef::new_text(alt));
            }
            node.detach();
        }
    }
}

fn resolve_cite(node: &NodeRef, base_dir: Option<&Path>) {
    let Some(element) = node.as_element() else {
        return;
    };
    let Some(cite) = element.attributes.borrow().get("cite").map(str::to_string) else {
        return;
    };
    match resolve_target(&cite, TargetKind::Cite, base_dir) {
        Target::Keep(value) => {
            element.attributes.borrow_mut().insert("cite", value);
        }
        _ => {
            element.attributes.borrow_mut().remove("cite");
        }
    }
}

fn resolve_target(raw: &str, kind: TargetKind, base_dir: Option<&Path>) -> Target {
    let cleaned = clean_target(raw);
    if cleaned.is_empty() {
        return Target::Drop;
    }
    if cleaned.starts_with('#') {
        return if kind == TargetKind::Href {
            Target::Keep(cleaned)
        } else {
            Target::Drop
        };
    }

    let decoded = clean_target(&decode_file_uri(&cleaned));
    if starts_with_two_separators(&cleaned) || starts_with_two_separators(&decoded) {
        // UNC (`\\server\share`) and protocol relative (`//host/x`) targets
        // reach another machine; loading one as an image is enough to send the
        // user's credentials there.
        return Target::Drop;
    }
    // `C:\...` parses as a one letter scheme, so the drive shape comes first.
    if looks_like_drive_path(&decoded) {
        return local_target(&decoded_path_of(&cleaned), kind);
    }

    // The decoded spelling is checked too, so `java%09script:` cannot slip past
    // as a relative path.
    match scheme_of(&cleaned).or_else(|| scheme_of(&decoded)) {
        Some(scheme) => match scheme.as_str() {
            "http" | "https" => Target::Keep(cleaned),
            "mailto" if kind == TargetKind::Href => Target::Keep(cleaned),
            "data" if kind == TargetKind::ImageSrc && is_image_data_url(&cleaned) => {
                Target::Keep(cleaned)
            }
            "file" => file_url_target(&cleaned, kind),
            _ => Target::Drop,
        },
        None => path_target(&decoded_path_of(&cleaned), kind, base_dir),
    }
}

/// Strips what the URL parser would strip: tabs and newlines anywhere, C0
/// controls and spaces at either end. `java<TAB>script:` is one link target.
fn clean_target(value: &str) -> String {
    let without_breaks: String = value
        .chars()
        .filter(|ch| !matches!(ch, '\t' | '\n' | '\r'))
        .collect();
    without_breaks
        .trim_matches(|ch: char| ch <= '\u{1f}' || ch == ' ')
        .to_string()
}

fn decoded_path_of(cleaned: &str) -> String {
    let path = match cleaned.find(['?', '#']) {
        Some(index) => &cleaned[..index],
        None => cleaned,
    };
    clean_target(&decode_file_uri(path))
}

fn looks_like_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

fn scheme_of(value: &str) -> Option<String> {
    let mut characters = value.char_indices();
    if !characters.next()?.1.is_ascii_alphabetic() {
        return None;
    }
    for (index, ch) in characters {
        if ch == ':' {
            return Some(value[..index].to_ascii_lowercase());
        }
        if !(ch.is_ascii_alphanumeric() || ch == '+' || ch == '-' || ch == '.') {
            return None;
        }
    }
    None
}

fn is_image_data_url(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    let Some(rest) = lowered.strip_prefix("data:image/") else {
        return false;
    };
    [
        "png", "gif", "jpeg", "jpg", "webp", "avif", "bmp", "svg+xml",
    ]
    .iter()
    .any(|subtype| {
        rest.strip_prefix(subtype)
            .is_some_and(|after| after.starts_with(';') || after.starts_with(','))
    })
}

fn file_url_target(cleaned: &str, kind: TargetKind) -> Target {
    let Some(rest) = cleaned.get("file:".len()..) else {
        return Target::Drop;
    };
    let path = match rest.strip_prefix("//") {
        Some(after_slashes) => {
            let (host, path) = match after_slashes.find(['/', '\\']) {
                Some(index) => after_slashes.split_at(index),
                None => (after_slashes, ""),
            };
            // A host means the file lives on another machine.
            if !(host.is_empty() || host.eq_ignore_ascii_case("localhost")) {
                return Target::Drop;
            }
            path
        }
        None => rest,
    };
    let path = decoded_path_of(path);
    if path.is_empty() {
        return Target::Drop;
    }
    rooted_target(&path, kind)
}

fn path_target(decoded: &str, kind: TargetKind, base_dir: Option<&Path>) -> Target {
    if decoded.is_empty() || decoded.starts_with('~') || decoded.starts_with('\\') {
        return Target::Drop;
    }
    if decoded.starts_with('/') {
        return rooted_target(decoded, kind);
    }
    let Some(base_dir) = base_dir else {
        return Target::Drop;
    };
    let relative = if cfg!(windows) {
        decoded.replace('/', "\\")
    } else {
        decoded.to_string()
    };
    local_target_from(base_dir.join(relative), kind)
}

/// An absolute target: a drive path, a Git-Bash drive path (`/c/...`), or a
/// POSIX root. A bare `/docs/x` on Windows is not a file path at all, so it is
/// dropped rather than guessed at.
fn rooted_target(decoded: &str, kind: TargetKind) -> Target {
    if starts_with_two_separators(decoded) {
        return Target::Drop;
    }
    #[cfg(windows)]
    {
        if looks_like_drive_path(decoded) {
            return local_target(decoded, kind);
        }
        let without_leading_slash = decoded.strip_prefix('/').unwrap_or(decoded);
        if looks_like_drive_path(without_leading_slash) {
            return local_target(without_leading_slash, kind);
        }
        let converted = crate::pty::path_norm::posix_drive_to_windows(decoded);
        if converted != decoded {
            return local_target(&converted, kind);
        }
        Target::Drop
    }
    #[cfg(not(windows))]
    {
        if decoded.starts_with('/') {
            local_target(decoded, kind)
        } else {
            Target::Drop
        }
    }
}

fn local_target(path: &str, kind: TargetKind) -> Target {
    local_target_from(PathBuf::from(path), kind)
}

fn local_target_from(path: PathBuf, kind: TargetKind) -> Target {
    if kind == TargetKind::Cite {
        return Target::Drop;
    }
    match normalize_local_path(&path) {
        Some(normalized) => Target::Local(normalized.to_string_lossy().into_owned()),
        None => Target::Drop,
    }
}

// ---------------------------------------------------------------------------
// Finishing passes
// ---------------------------------------------------------------------------

/// comrak puts an empty `<a class="anchor">` in every heading for the id it
/// generated. The id is what `#links` need; the empty link is noise.
fn strip_heading_anchors(body: &NodeRef) {
    let anchors: Vec<NodeRef> = body
        .descendants()
        .filter(|node| {
            element_local_name(node).as_deref() == Some("a")
                && has_class(node, "anchor")
                && node.ancestors().any(|ancestor| {
                    element_local_name(&ancestor).is_some_and(|name| {
                        matches!(name.as_str(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
                    })
                })
        })
        .collect();
    for anchor in anchors {
        anchor.detach();
    }
}

/// comrak writes the English default title of a GitHub alert. A title the
/// author wrote is left exactly as written.
fn translate_alert_titles(body: &NodeRef) {
    let titles: Vec<NodeRef> = body
        .descendants()
        .filter(|node| has_class(node, "markdown-alert-title"))
        .collect();
    for title in titles {
        let translated = match title.text_contents().trim() {
            "Note" => "メモ",
            "Tip" => "ヒント",
            "Important" => "重要",
            "Warning" => "警告",
            "Caution" => "注意",
            _ => continue,
        };
        replace_children_with_text(&title, translated);
    }
}

/// An autolink runs until the next space, so `https://example.com/docsを参照`
/// swallows the Japanese that follows it. The link is cut at the first
/// non-ASCII character and the rest goes back to being text.
fn trim_autolinks(body: &NodeRef) {
    let anchors: Vec<NodeRef> = body
        .descendants()
        .filter(|node| element_local_name(node).as_deref() == Some("a"))
        .collect();

    for anchor in anchors {
        let Some(element) = anchor.as_element() else {
            continue;
        };
        let href = match element.attributes.borrow().get("href") {
            Some(href) => href.to_string(),
            None => continue,
        };
        let text = anchor.text_contents();
        let Some(prefix) = autolink_prefix(&href, &text) else {
            continue;
        };
        if text.is_ascii() {
            continue;
        }

        let cut = text
            .char_indices()
            .find(|(_, ch)| !ch.is_ascii())
            .map(|(index, _)| index)
            .unwrap_or(text.len());
        let kept = trim_autolink_tail(&text[..cut]);
        let target = format!("{prefix}{kept}");

        if kept.is_empty() || is_scheme_only(&target) {
            // Nothing but `https://` would be left; the whole run is text.
            anchor.insert_before(NodeRef::new_text(text.clone()));
            anchor.detach();
            continue;
        }

        anchor.insert_after(NodeRef::new_text(text[kept.len()..].to_string()));
        replace_children_with_text(&anchor, kept);
        element.attributes.borrow_mut().insert("href", target);
    }
}

/// The part of `href` that the link text does not spell out, when the link is an
/// autolink (its text *is* its target). `None` when the two differ.
fn autolink_prefix(href: &str, text: &str) -> Option<&'static str> {
    let decoded = decode_file_uri(href);
    for candidate in [href, decoded.as_str()] {
        if candidate == text {
            return Some("");
        }
        for prefix in ["mailto:", "http://"] {
            // The bytes are compared first: matching them proves the prefix is
            // ASCII, which is what makes the slice below a char boundary.
            if candidate.len() > prefix.len()
                && candidate.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
                && candidate[prefix.len()..] == *text
            {
                return Some(prefix);
            }
        }
    }
    None
}

/// The trailing punctuation GFM leaves out of an autolink, applied again after
/// the link was cut short: `(https://example.com/x)を` must not keep the `)`.
fn trim_autolink_tail(value: &str) -> &str {
    let mut end = value.len();
    while end > 0 {
        let last = value.as_bytes()[end - 1];
        let trim = match last {
            b'?' | b'!' | b'.' | b',' | b':' | b'*' | b'_' | b'~' | b'\'' | b'"' | b';' => true,
            b')' => {
                let head = &value[..end];
                head.matches(')').count() > head.matches('(').count()
            }
            _ => false,
        };
        if !trim {
            break;
        }
        end -= 1;
    }
    &value[..end]
}

fn is_scheme_only(value: &str) -> bool {
    match scheme_of(value) {
        Some(scheme) => value[scheme.len() + 1..].chars().all(|ch| ch == '/'),
        None => false,
    }
}

/// Wraps every table so a narrow pane can turn its rows into cards, and tags the
/// cells with the column they belong to. The stylesheet does the rest.
fn lay_out_tables(body: &NodeRef) {
    let tables: Vec<NodeRef> = body
        .descendants()
        .filter(|node| element_local_name(node).as_deref() == Some("table"))
        .collect();

    for table in tables {
        let rows = table_rows(&table);
        let header = header_row(&rows);
        let labels = header
            .as_ref()
            .map(|row| header_labels(row))
            .unwrap_or_default();
        let columns = rows
            .iter()
            .map(|(row, _)| row_width(row))
            .max()
            .unwrap_or(0)
            .min(MAX_TABLE_COLUMNS);

        label_body_cells(&rows, header.as_ref(), &labels);
        mark_narrow_columns(&rows, columns);
        wrap_table(body, &table, columns);
    }
}

/// The table's own rows: nested tables bring their own and are handled when the
/// walk reaches them.
fn table_rows(table: &NodeRef) -> Vec<(NodeRef, bool)> {
    let mut rows = Vec::new();
    for child in table.children() {
        match element_local_name(&child).as_deref() {
            Some("tr") => rows.push((child.clone(), false)),
            Some(section @ ("thead" | "tbody" | "tfoot")) => {
                for row in child.children() {
                    if element_local_name(&row).as_deref() == Some("tr") {
                        rows.push((row, section == "thead"));
                    }
                }
            }
            _ => {}
        }
    }
    rows
}

fn header_row(rows: &[(NodeRef, bool)]) -> Option<NodeRef> {
    if let Some((row, _)) = rows.iter().find(|(_, in_head)| *in_head) {
        return Some(row.clone());
    }
    let (first, _) = rows.first()?;
    let cells = row_cells(first);
    let all_headers = !cells.is_empty()
        && cells
            .iter()
            .all(|cell| element_local_name(cell).as_deref() == Some("th"));
    all_headers.then(|| first.clone())
}

fn row_cells(row: &NodeRef) -> Vec<NodeRef> {
    row.children()
        .filter(|cell| matches!(element_local_name(cell).as_deref(), Some("td") | Some("th")))
        .collect()
}

fn cell_colspan(cell: &NodeRef) -> usize {
    cell.as_element()
        .and_then(|element| {
            element
                .attributes
                .borrow()
                .get("colspan")
                .map(str::to_string)
        })
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1)
        .clamp(1, MAX_TABLE_COLUMNS)
}

fn row_width(row: &NodeRef) -> usize {
    row_cells(row).iter().map(cell_colspan).sum()
}

fn header_labels(row: &NodeRef) -> Vec<String> {
    let mut labels: Vec<String> = Vec::new();
    for cell in row_cells(row) {
        let text = cell_text(&cell);
        for _ in 0..cell_colspan(&cell) {
            if labels.len() >= MAX_TABLE_COLUMNS {
                return labels;
            }
            labels.push(text.clone());
        }
    }
    labels
}

fn label_body_cells(rows: &[(NodeRef, bool)], header: Option<&NodeRef>, labels: &[String]) {
    for (row, in_head) in rows {
        if *in_head || header.is_some_and(|header| header == row) {
            continue;
        }
        let mut column = 0usize;
        for cell in row_cells(row) {
            let Some(label) = labels.get(column).filter(|label| !label.is_empty()) else {
                column += cell_colspan(&cell);
                continue;
            };
            let Some(element) = cell.as_element() else {
                continue;
            };
            if column == 0 {
                // A short first cell reads as a number or a key, so the column
                // name goes in front of it instead of above it.
                if cell_text(&cell).chars().count() <= 4 {
                    element
                        .attributes
                        .borrow_mut()
                        .insert("data-label-first", label.clone());
                }
            } else {
                element
                    .attributes
                    .borrow_mut()
                    .insert("data-label", label.clone());
            }
            column += cell_colspan(&cell);
            if column >= MAX_TABLE_COLUMNS {
                break;
            }
        }
    }
}

fn mark_narrow_columns(rows: &[(NodeRef, bool)], columns: usize) {
    if columns == 0 {
        return;
    }
    let mut widths = vec![0usize; columns];
    let mut members: Vec<Vec<NodeRef>> = vec![Vec::new(); columns];
    for (row, _) in rows {
        let mut column = 0usize;
        for cell in row_cells(row) {
            let span = cell_colspan(&cell);
            // A merged cell says nothing about how wide one column is.
            if span == 1 && column < columns {
                widths[column] = widths[column].max(display_width(&cell_text(&cell)));
                members[column].push(cell);
            }
            column += span;
            if column >= MAX_TABLE_COLUMNS {
                break;
            }
        }
    }
    for (column, cells) in members.iter().enumerate() {
        if widths[column] > NOWRAP_MAX_DISPLAY_WIDTH {
            continue;
        }
        for cell in cells {
            add_class(cell, "md-nowrap");
        }
    }
}

fn wrap_table(body: &NodeRef, table: &NodeRef, columns: usize) {
    let Some(wrapper) = new_html_element(body, "div") else {
        return;
    };
    let class = match columns {
        0..=2 => "table-wrap cols-2",
        3 => "table-wrap cols-3",
        4 => "table-wrap cols-4",
        _ => "table-wrap cols-many",
    };
    if let Some(element) = wrapper.as_element() {
        element
            .attributes
            .borrow_mut()
            .insert("class", class.to_string());
    }
    table.insert_before(wrapper.clone());
    wrapper.append(table.clone());
}

fn prepend_front_matter(body: &NodeRef, front_matter: &str) {
    let (Some(block), Some(code)) = (
        new_html_element(body, "pre"),
        new_html_element(body, "code"),
    ) else {
        return;
    };
    if let Some(element) = block.as_element() {
        element
            .attributes
            .borrow_mut()
            .insert("class", "front-matter".to_string());
    }
    code.append(NodeRef::new_text(front_matter.to_string()));
    block.append(code);
    body.prepend(block);
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

fn element_local_name(node: &NodeRef) -> Option<String> {
    let element = node.as_element()?;
    (&*element.name.ns == HTML_NS).then(|| element.name.local.to_string())
}

fn has_class(node: &NodeRef, class: &str) -> bool {
    node.as_element().is_some_and(|element| {
        element
            .attributes
            .borrow()
            .get("class")
            .is_some_and(|value| value.split_whitespace().any(|token| token == class))
    })
}

fn add_class(node: &NodeRef, class: &str) {
    let Some(element) = node.as_element() else {
        return;
    };
    let mut attributes = element.attributes.borrow_mut();
    let next = match attributes.get("class") {
        Some(existing) if existing.split_whitespace().any(|token| token == class) => return,
        Some(existing) if !existing.trim().is_empty() => format!("{} {class}", existing.trim()),
        _ => class.to_string(),
    };
    attributes.insert("class", next);
}

fn replace_children_with_text(node: &NodeRef, text: &str) {
    for child in node.children().collect::<Vec<_>>() {
        child.detach();
    }
    node.append(NodeRef::new_text(text.to_string()));
}

/// A new element in the same namespace as the document being rebuilt. The name
/// is borrowed from an element that is already there, because the HTML types
/// that spell one out live in a crate this module does not depend on.
fn new_html_element(template: &NodeRef, local: &str) -> Option<NodeRef> {
    let element = template.as_element()?;
    let mut name = element.name.clone();
    name.local = local.into();
    Some(NodeRef::new_element(
        name,
        std::iter::empty::<(ExpandedName, Attribute)>(),
    ))
}

fn cell_text(cell: &NodeRef) -> String {
    cell.text_contents()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Roughly how many character widths a string takes in a proportional font:
/// East Asian wide characters count double, everything else once.
fn display_width(text: &str) -> usize {
    text.chars()
        .map(|ch| if is_wide_character(ch) { 2 } else { 1 })
        .sum()
}

fn is_wide_character(ch: char) -> bool {
    matches!(ch as u32,
        0x1100..=0x115F
            | 0x2E80..=0x303E
            | 0x3041..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA000..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE19
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x1F300..=0x1F64F
            | 0x1F900..=0x1F9FF
            | 0x20000..=0x3FFFD)
}

fn serialize_node(node: &NodeRef) -> String {
    let mut bytes = Vec::new();
    if node.serialize(&mut bytes).is_err() {
        return String::new();
    }
    String::from_utf8(bytes).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The file the tests pretend the document was read from.
    #[cfg(windows)]
    const SOURCE_FILE: &str = r"C:\docs\x.md";
    #[cfg(not(windows))]
    const SOURCE_FILE: &str = "/docs/x.md";

    fn render(markdown: &str) -> String {
        markdown_to_static_html(markdown, None)
    }

    fn render_from_source(markdown: &str) -> String {
        markdown_to_static_html(markdown, Some(Path::new(SOURCE_FILE)))
    }

    fn body_of(html: &str) -> &str {
        let start = html.find("<body>").expect("the document has a body");
        &html[start + "<body>".len()..]
    }

    #[test]
    fn table_rows_carry_their_column_names() {
        let html = render(
            "| 検査 | 結果 |\n|---|---|\n| ビルド | とても長い説明がここに入ります。折り返しても読めるように書いてあります |\n",
        );

        assert!(html.contains("<div class=\"table-wrap cols-2\">"));
        assert!(html.contains("data-label=\"結果\""));
        // A first cell short enough to read as a key keeps its column name in
        // front of it instead of above it.
        assert!(html.contains("data-label-first=\"検査\""));
        // Only the narrow column is held on one line: the wide one must wrap.
        // (The stylesheet in the head carries the rule itself.)
        assert_eq!(body_of(&html).matches("md-nowrap").count(), 2);
    }

    #[test]
    fn a_numbered_first_column_labels_its_cells() {
        let html = render(
            "| # | 見つけたこと | 根拠 |\n|---|---|---|\n| 1 | 定期実行が止まっていた | `config/cron.json` |\n",
        );

        assert!(html.contains("data-label-first=\"#\""));
        assert!(html.contains("data-label=\"見つけたこと\""));
        assert!(html.contains("data-label=\"根拠\""));
    }

    #[test]
    fn the_table_wrapper_records_how_many_columns_there_are() {
        let two = render("| a | b |\n|---|---|\n| 1 | 2 |\n");
        let three = render("| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n");
        let four = render("| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n");
        let many = render("| a | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |\n");

        assert!(two.contains("table-wrap cols-2"));
        assert!(three.contains("table-wrap cols-3"));
        assert!(four.contains("table-wrap cols-4"));
        assert!(many.contains("table-wrap cols-many"));
    }

    #[test]
    fn inline_markup_becomes_real_markup() {
        let html = render("**太字**と*斜体*と`code`と~~取り消し~~です。\n");

        assert!(html.contains("<strong>太字</strong>"));
        assert!(html.contains("<em>斜体</em>"));
        assert!(html.contains("<code>code</code>"));
        assert!(html.contains("<del>取り消し</del>"));
    }

    #[test]
    fn bold_holds_around_japanese_quotation_marks() {
        let html = render("これは**「重要」**です\n");

        assert!(html.contains("<strong>「重要」</strong>"));
    }

    #[test]
    fn a_single_tilde_stays_a_tilde() {
        let html = render("範囲の書き方 9/15~9/17 と 1~2 件は取り消し線になりません。\n");

        assert!(html.contains("9/15~9/17 と 1~2 件"));
        assert!(!html.contains("<del"));
        assert!(!html.contains("<sub"));
    }

    #[test]
    fn a_newline_inside_a_paragraph_is_a_line_break() {
        let html = render("一行目\n二行目\n");

        assert!(html.contains("<br"));
        assert!(html.contains("一行目"));
        assert!(html.contains("二行目"));
    }

    #[test]
    fn lists_keep_their_numbering_nesting_and_checkboxes() {
        let html = render("1. 一つ目\n2. 二つ目\n   - 入れ子\n\n- [x] 済み\n- [ ] これから\n");

        assert!(html.contains("<ol>"));
        assert!(html.contains("<ul>"));
        assert!(html.contains("class=\"contains-task-list\""));
        assert!(html.contains("class=\"task-list-item\""));
        assert!(html.contains("type=\"checkbox\""));
        assert!(html.contains("disabled=\"\""));
        assert!(html.contains("checked=\"\""));
        // One of the two boxes is ticked, not both.
        assert_eq!(html.matches("checked=\"\"").count(), 1);
    }

    #[test]
    fn alerts_speak_japanese_unless_the_author_named_them() {
        let html = render("> [!NOTE]\n> 注記です。\n\n> [!WARNING] 独自の題\n> 警告です。\n");

        assert!(html.contains("markdown-alert-note"));
        assert!(html.contains(">メモ</p>"));
        assert!(html.contains("markdown-alert-warning"));
        assert!(html.contains(">独自の題</p>"));
        assert!(!html.contains(">Note</p>"));
        assert!(!html.contains(">Warning</p>"));
    }

    #[test]
    fn footnotes_link_both_ways() {
        let html = render("本文です[^1]。\n\n[^1]: 脚注の本文です。\n");

        assert!(html.contains("class=\"footnotes\""));
        assert!(html.contains("class=\"footnote-ref\""));
        assert!(html.contains("id=\"fn-1\""));
        assert!(html.contains("脚注の本文です。"));
    }

    #[test]
    fn front_matter_is_shown_as_a_block_not_a_rule() {
        let html = render("---\nname: sample\ndescription: 見本\n---\n\n# 見出し\n");

        assert!(body_of(&html).starts_with("<pre class=\"front-matter\"><code>"));
        assert!(html.contains("name: sample"));
        assert!(html.contains("description: 見本"));
        // The delimiters are neither a rule nor a heading.
        assert!(!html.contains("<hr"));
        assert!(!html.contains("<h2"));
    }

    #[test]
    fn headings_get_an_id_and_lose_the_anchor_link() {
        let html = render("## 結論\n");

        assert!(html.contains("<h2 id=\"結論\">結論</h2>"));
        assert!(!html.contains("class=\"anchor\""));
    }

    #[test]
    fn dollar_math_is_marked_up_instead_of_left_as_text() {
        let html = render("数式 $x^2$ です。\n");

        assert!(html.contains("<span data-math-style=\"inline\">x^2</span>"));
    }

    #[test]
    fn an_autolink_stops_before_the_japanese_that_follows_it() {
        let html = render("詳しくは https://example.com/docsを参照 してください。\n");

        assert!(html
            .contains("<a href=\"https://example.com/docs\">https://example.com/docs</a>を参照"));
    }

    #[test]
    fn an_autolink_that_is_only_a_scheme_goes_back_to_text() {
        let html = render("https://日本語.example と書いた場合。\n");

        assert!(!html.contains("<a "));
        assert!(html.contains("https://日本語.example"));
    }

    #[test]
    fn raw_html_is_rebuilt_from_the_allowlist() {
        let html = render(concat!(
            "<details><summary>折りたたみ</summary>\n\n中身<br>改行\n\n</details>\n\n",
            "<script>alert(1)</script>\n\n",
            "<img src=\"x\" onerror=\"alert(1)\">\n\n",
            "<p style=\"color:red\" onclick=\"alert(1)\">段落</p>\n\n",
            "<!-- コメント -->\n\n",
            "<iframe src=\"https://example.com/frame\"></iframe>\n\n",
            "<svg><desc>ベクタの中身</desc></svg>\n\n",
            "<form action=\"/x\"><input type=\"text\" name=\"q\"><button>送信</button></form>\n\n",
            "<meta http-equiv=\"refresh\" content=\"0\">\n\n",
            "<base href=\"https://evil.example/\">\n\n",
            "<link rel=\"stylesheet\" href=\"https://evil.example/x.css\">\n\n",
            "<table onclick=\"alert(1)\"><tr><td>表</td></tr></table>\n\n",
            "<a href=\"javascript:alert(1)\">js</a>",
            "<a href=\"JaVaScRiPt:alert(1)\">JS</a>",
            "<a href=\"java&#9;script:alert(1)\">tab</a>",
            "<a href=\"vbscript:msgbox(1)\">vb</a>",
            "<a href=\"data:text/html,x\">data</a>\n\n",
            "<a href=\"https://example.com\" data-mycmux-local-path=\"C:\\Windows\\system32\\cmd.exe\">forged</a>\n",
        ));

        // What the allowlist keeps.
        assert!(html.contains("<details>"));
        assert!(html.contains("<summary>折りたたみ</summary>"));
        assert!(html.contains("<br>"));
        assert!(html.contains("<p>段落</p>"));
        assert!(html.contains("<div class=\"table-wrap"));
        assert!(html.contains("<a href=\"https://example.com\""));

        // What it does not.
        assert!(!html.contains("<script"));
        assert!(!html.contains("onerror"));
        assert!(!html.contains("onclick"));
        assert!(!html.contains(" style="));
        assert!(!html.contains("<iframe"));
        assert!(!html.contains("<svg"));
        assert!(!html.contains("ベクタの中身"));
        assert!(!html.contains("<form"));
        assert!(!html.contains("<input"));
        assert!(!html.contains("<button"));
        assert!(!html.contains("送信"));
        assert!(!html.contains("http-equiv=\"refresh\""));
        assert!(!html.contains("<base"));
        assert!(!html.contains("<link"));
        assert!(!html.contains("<!--"));
        assert!(!html.contains("コメント"));

        // Every spelling of a scheme the webview must not follow.
        assert!(!html.contains("javascript:"));
        assert!(!html.contains("JaVaScRiPt:"));
        assert!(!html.contains("vbscript:"));
        assert!(!html.contains("data:text/html"));
        // The text of a dropped link stays; only its target goes.
        for label in ["js", "JS", "tab", "vb", "data"] {
            assert!(html.contains(&format!(">{label}</a>")));
        }

        // A document cannot hand itself the attribute the pane trusts.
        assert!(!html.contains("system32"));
        assert_eq!(html.matches("data-mycmux-local-path").count(), 0);
    }

    #[test]
    fn local_images_and_links_are_resolved_against_the_source_file() {
        let html = render_from_source(
            "![](img/a.png)\n\n[b](../b.md)\n\n![web](https://example.com/x.png)\n",
        );

        #[cfg(windows)]
        {
            assert!(html.contains("data-mycmux-local-src=\"C:\\docs\\img\\a.png\""));
            assert!(html.contains("data-mycmux-local-path=\"C:\\b.md\""));
        }
        #[cfg(not(windows))]
        {
            assert!(html.contains("data-mycmux-local-src=\"/docs/img/a.png\""));
            assert!(html.contains("data-mycmux-local-path=\"/b.md\""));
        }
        assert!(html.contains("loading=\"lazy\""));
        // The pane mints the asset URL; the frame never sees the bare path.
        assert!(!html.contains("src=\"img/a.png\""));
        assert!(!html.contains("src=\"../b.md\""));
        assert!(html.contains("src=\"https://example.com/x.png\""));
        // The link keeps the spelling the document used, plus the resolved path.
        assert!(html.contains("href=\"../b.md\""));
        assert!(html.contains("title=\""));
    }

    #[cfg(windows)]
    #[test]
    fn windows_spellings_of_a_local_file_resolve() {
        let html = render_from_source(concat!(
            "<img src=\"file:///C:/x/y.png\">\n\n",
            "<img src=\"/c/x/z.png\">\n\n",
            "<img src=\"C:\\x\\w.png\">\n",
        ));

        assert!(html.contains("data-mycmux-local-src=\"C:\\x\\y.png\""));
        assert!(html.contains("data-mycmux-local-src=\"C:\\x\\z.png\""));
        assert!(html.contains("data-mycmux-local-src=\"C:\\x\\w.png\""));
    }

    #[test]
    fn targets_on_another_machine_are_dropped() {
        let html = render_from_source(concat!(
            "<img src=\"\\\\server\\share\\a.png\">\n\n",
            "<img src=\"//server/share/b.png\">\n\n",
            "<img src=\"file://server/share/c.png\">\n\n",
            "<img src=\"/\\server/share/d.png\">\n\n",
            "<img src=\"%5C%5Cserver%5Cshare%5Ce.png\">\n\n",
            "<a href=\"\\\\?\\C:\\Windows\\win.ini\">device</a>\n\n",
            "<a href=\"\\\\server\\share\\f.md\">share</a>\n",
        ));

        assert!(!html.contains("server"));
        assert!(!html.contains("win.ini"));
        assert!(!html.contains("data-mycmux-local-src"));
        assert!(!html.contains("data-mycmux-local-path"));
        assert!(!html.contains("<img"));
    }

    #[test]
    fn a_path_cannot_climb_out_of_its_own_root() {
        // Percent encoding is decoded before the path is resolved, and `..` is
        // resolved lexically, so neither spelling walks above the drive.
        let html = render_from_source(
            "<a href=\"%2E%2E/%2E%2E/%2E%2E/secret.md\">up</a>\n\n<a href=\"a/../b/./c.md\">dots</a>\n",
        );

        // The href keeps the document's own spelling; the resolved path - the
        // one the pane acts on - carries no `..` at all.
        #[cfg(windows)]
        {
            assert!(html.contains("data-mycmux-local-path=\"C:\\secret.md\""));
            assert!(html.contains("data-mycmux-local-path=\"C:\\docs\\b\\c.md\""));
        }
        #[cfg(not(windows))]
        {
            assert!(html.contains("data-mycmux-local-path=\"/secret.md\""));
            assert!(html.contains("data-mycmux-local-path=\"/docs/b/c.md\""));
        }
        for value in html.split("data-mycmux-local-path=\"").skip(1) {
            assert!(!value[..value.find('"').unwrap_or(0)].contains(".."));
        }
    }

    #[test]
    fn a_cite_attribute_may_only_name_the_web() {
        let html = render_from_source(concat!(
            "<blockquote cite=\"https://example.com/source\">引用</blockquote>\n\n",
            "<blockquote cite=\"javascript:alert(1)\">危ない</blockquote>\n\n",
            "<del cite=\"other.md\">消した</del>\n\n",
            "<q cite=\"\\\\server\\share\\a.txt\">共有</q>\n",
        ));

        assert!(html.contains("cite=\"https://example.com/source\""));
        assert_eq!(html.matches("cite=").count(), 1);
        assert!(!html.contains("javascript:"));
        assert!(!html.contains("server"));
    }

    #[test]
    fn a_tilde_path_and_a_home_relative_link_are_dropped() {
        let html = render_from_source("<a href=\"~/.ssh/id_rsa\">key</a>\n");

        assert!(!html.contains("href="));
        assert!(!html.contains("data-mycmux-local-path"));
        assert!(html.contains(">key</a>"));
    }

    #[test]
    fn relative_targets_need_a_source_file() {
        let html = render("![画像](img/a.png)\n\n[文書](other.md)\n");

        assert!(!html.contains("data-mycmux-local-src"));
        assert!(!html.contains("data-mycmux-local-path"));
        assert!(!html.contains("href="));
        // A picture with nowhere to load from leaves its alt text behind.
        assert!(!html.contains("<img"));
        assert!(html.contains("画像"));
    }

    #[test]
    fn an_image_may_carry_its_own_data_url_but_a_link_may_not() {
        let html = render(concat!(
            "<img src=\"data:image/png;base64,iVBORw0KGgo=\" alt=\"点\">\n\n",
            "<img src=\"data:text/html,x\" alt=\"偽\">\n\n",
            "<a href=\"data:image/png;base64,iVBORw0KGgo=\">link</a>\n",
        ));

        assert!(html.contains("src=\"data:image/png;base64,iVBORw0KGgo=\""));
        assert!(!html.contains("data:text/html"));
        assert!(!html.contains("href=\"data:"));
        assert!(html.contains("偽"));
    }

    #[test]
    fn the_document_carries_its_policy_language_and_styles() {
        let html = render("# 見出し\n");

        assert!(html.starts_with("<!doctype html><html lang=\"ja\">"));
        assert!(html.contains(
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';"
        ));
        assert!(html.contains("base-uri 'none'"));
        assert!(html.contains("--md-bg"));
        assert!(html.contains("</style></head><body>"));
        assert!(html.ends_with("</body></html>"));
    }

    #[test]
    fn the_sample_document_renders_every_block_kind() {
        let html = markdown_to_static_html(
            include_str!("testdata/markdown_kitchen_sink.md"),
            Some(Path::new(SOURCE_FILE)),
        );

        assert!(body_of(&html).starts_with("<pre class=\"front-matter\">"));
        assert!(html.contains("table-wrap cols-3"));
        assert!(html.contains("markdown-alert-note"));
        assert!(html.contains(">メモ</p>"));
        assert!(html.contains("class=\"footnotes\""));
        assert!(html.contains("class=\"task-list-item\""));
        assert!(html.contains("<del>ここは取り消し線</del>"));
        assert!(html.contains("9/15~9/17 と 1~2 件"));
        assert!(html
            .contains("<a href=\"https://example.com/docs\">https://example.com/docs</a>を参照"));
        assert!(html.contains("data-mycmux-local-src="));
        assert!(!html.contains("<script"));
        // The sample writes `[危ないリンク](javascript:alert(1))` inside a raw
        // HTML block, so it stays text: what must not exist is the link.
        assert!(!html.contains("href=\"javascript"));
        assert!(!html.contains("onerror"));
    }

    #[test]
    #[ignore = "writes an HTML file to look at; needs MYCMUX_MD_DUMP_IN and MYCMUX_MD_DUMP_OUT"]
    fn dump_markdown_preview_for_visual_check() {
        let (Ok(input), Ok(output)) = (
            std::env::var("MYCMUX_MD_DUMP_IN"),
            std::env::var("MYCMUX_MD_DUMP_OUT"),
        ) else {
            return;
        };
        let source = PathBuf::from(input);
        let markdown =
            std::fs::read_to_string(&source).expect("read the markdown named by MYCMUX_MD_DUMP_IN");
        std::fs::write(output, markdown_to_static_html(&markdown, Some(&source)))
            .expect("write the HTML named by MYCMUX_MD_DUMP_OUT");
    }
}

//! Turns a plain-text file into the page the preview pane shows.
//!
//! The Markdown preview next door (`markdown_preview.rs`) renders a document;
//! this renders a file as it was typed. Nothing in the text is markup, so the
//! whole body is escaped into one `<pre>` and the only things the renderer adds
//! are the links a reader would otherwise have to copy out by hand.
//!
//! The document is standalone: styles inline, no scripts, and a policy that
//! allows nothing to load. The pane drops the theme in afterwards as custom
//! properties, exactly as it does for Markdown.

use std::iter::Peekable;
use std::path::{Component, Path, PathBuf};
use std::str::Chars;

use encoding_rs::SHIFT_JIS;

/// The stylesheet the document carries. Kept beside this file so it can be read
/// and edited as CSS rather than as a Rust string.
const PREVIEW_CSS: &str = include_str!("text_preview.css");

/// Nothing loads and nothing runs: the document is its own text and its own
/// stylesheet. One notch tighter than the Markdown preview, which has to let
/// pictures in.
const CONTENT_SECURITY_POLICY: &str =
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/// How far in we look for a NUL before calling the bytes a file rather than a
/// text. A `.txt` is sometimes an executable someone renamed, and 8 KB is well
/// past the header of anything that arrives that way. Looking at the whole file
/// instead would refuse a long log over one stray byte near its end.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// Text past this much is left out. The frame lays the whole `<pre>` out at
/// once, so the size of the document decides how long the pane stays frozen
/// after a click; five megabytes of text is already more than a reader will
/// scroll through, and a log that big is a job for the terminal.
const MAX_TEXT_BYTES: usize = 5 * 1024 * 1024;

/// Lines past this are left out, for the same reason as the byte limit: a log
/// of a million short lines is far below the byte limit and still lays out for
/// seconds.
const MAX_LINES: usize = 50_000;

/// What `escape_html` writes, and the only entities anything here reads back.
const ENTITIES: [(&str, char); 5] = [
    ("&amp;", '&'),
    ("&lt;", '<'),
    ("&gt;", '>'),
    ("&quot;", '"'),
    ("&#39;", '\''),
];

const UTF8_BOM: &[u8] = &[0xef, 0xbb, 0xbf];
const UTF16LE_BOM: &[u8] = &[0xff, 0xfe];
const UTF16BE_BOM: &[u8] = &[0xfe, 0xff];

/// The opening of every refusal, so the pane shows one sentence about the file
/// and then the reason.
const NOT_TEXT: &str = "テキストとして読めません";

/// How a file's bytes were read, so the reader can be told when it was not
/// UTF-8: a Shift_JIS file that decodes cleanly still deserves a label, because
/// the same bytes read as UTF-8 would have been refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    ShiftJis,
}

impl TextEncoding {
    /// The line shown above the text, or `None` when there is nothing to say.
    /// UTF-8 is what a file is expected to be - saying so on every file would
    /// train the reader to skip the line on the files that need it.
    fn notice(self) -> Option<&'static str> {
        match self {
            TextEncoding::Utf8 | TextEncoding::Utf8Bom => None,
            TextEncoding::Utf16Le => Some("UTF-16 (LE) として表示しています"),
            TextEncoding::Utf16Be => Some("UTF-16 (BE) として表示しています"),
            TextEncoding::ShiftJis => Some("Shift_JIS として表示しています"),
        }
    }
}

/// Renders one standalone HTML document for a plain-text file.
///
/// `source_path` is the file the bytes came from. It is not needed to resolve
/// anything: only absolute paths become links (see `local_link_at`), and an
/// absolute path carries its own root. The parameter stays in the signature
/// because every renderer in this module is handed the file it read, and
/// because linking relative paths later must not change how this is called.
pub(crate) fn text_to_static_html(raw: &[u8], source_path: Option<&Path>) -> Result<String, String> {
    let _ = source_path;

    let (decoded, encoding) = decode(raw)?;
    let text = scrub(&decoded);
    let (shown, cut) = cut_to_limits(&text);

    // Room for the text, for the entities escaping adds, and for the notices.
    let mut body = String::with_capacity(shown.len() + shown.len() / 8 + 256);
    if let Some(notice) = encoding.notice() {
        body.push_str("<p class=\"notice\">");
        body.push_str(&escape_html(notice));
        body.push_str("</p>");
    }
    body.push_str("<pre>");
    body.push_str(&link_up(&escape_html(shown)));
    body.push_str("</pre>");
    if let Some(cut) = cut {
        body.push_str("<p class=\"notice notice-end\">");
        body.push_str(&escape_html(&cut.message()));
        body.push_str("</p>");
    }

    Ok(format!(
        "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"{CONTENT_SECURITY_POLICY}\"><style>{PREVIEW_CSS}</style></head><body>{body}</body></html>"
    ))
}

// ---------------------------------------------------------------------------
// Reading the bytes
// ---------------------------------------------------------------------------

/// Decodes the file, in the order a text editor would guess: the byte order
/// mark, then UTF-8, then Shift_JIS, then nothing.
fn decode(raw: &[u8]) -> Result<(String, TextEncoding), String> {
    // A byte order mark is the file saying what it is, and it is believed.
    // Bytes that then fail to decode are a damaged file, not a Shift_JIS one,
    // and reading them as Shift_JIS would show mojibake instead of an error.
    if let Some(rest) = raw.strip_prefix(UTF8_BOM) {
        refuse_bytes_with_a_nul(rest)?;
        return utf8(rest).map(|text| (text, TextEncoding::Utf8Bom));
    }
    if let Some(rest) = raw.strip_prefix(UTF16LE_BOM) {
        return utf16(rest, u16::from_le_bytes).map(|text| (text, TextEncoding::Utf16Le));
    }
    if let Some(rest) = raw.strip_prefix(UTF16BE_BOM) {
        return utf16(rest, u16::from_be_bytes).map(|text| (text, TextEncoding::Utf16Be));
    }

    // Without a mark, a NUL means bytes rather than text. This sits below the
    // marks because UTF-16 is full of NULs and is not a binary.
    refuse_bytes_with_a_nul(raw)?;

    if let Ok(text) = utf8(raw) {
        return Ok((text, TextEncoding::Utf8));
    }
    // Without replacement: a Shift_JIS reading that needs U+FFFD to get through
    // is not a Shift_JIS file, it is a file we cannot read, and mojibake shown
    // as if it were the text is worse than saying so.
    match SHIFT_JIS.decode_without_bom_handling_and_without_replacement(raw) {
        Some(text) => Ok((text.into_owned(), TextEncoding::ShiftJis)),
        None => Err(format!("{NOT_TEXT} (UTF-8 でも Shift_JIS でもありません)")),
    }
}

fn refuse_bytes_with_a_nul(raw: &[u8]) -> Result<(), String> {
    if raw.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0) {
        return Err(format!(
            "{NOT_TEXT} (先頭に NUL があるので、テキストではなくバイト列です)"
        ));
    }
    Ok(())
}

fn utf8(raw: &[u8]) -> Result<String, String> {
    std::str::from_utf8(raw)
        .map(str::to_string)
        .map_err(|_| format!("{NOT_TEXT} (UTF-8 として壊れています)"))
}

/// UTF-16 through the standard library rather than through `encoding_rs`: the
/// pairing of surrogates is the whole of the format, and `decode_utf16` fails
/// on an unpaired one instead of quietly replacing it.
fn utf16(raw: &[u8], unit: fn([u8; 2]) -> u16) -> Result<String, String> {
    let broken = || format!("{NOT_TEXT} (UTF-16 として壊れています)");
    if raw.len() % 2 != 0 {
        return Err(broken());
    }
    char::decode_utf16(raw.chunks_exact(2).map(|pair| unit([pair[0], pair[1]])))
        .collect::<Result<String, _>>()
        .map_err(|_| broken())
}

// ---------------------------------------------------------------------------
// Cleaning the text
// ---------------------------------------------------------------------------

/// Removes what a terminal would have eaten rather than printed, and settles on
/// one line ending.
///
/// Escape sequences are the reason this exists: a log captured from a terminal
/// carries its colours with it, and `ESC[31m` shown as text is unreadable.
fn scrub(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(ch) = characters.next() {
        match ch {
            '\u{1b}' => skip_escape_sequence(&mut characters),
            // CRLF and a lone CR both become LF. Dropping the CR as a control
            // character would be right for CRLF and would silently join every
            // line of a file written with CR alone.
            '\r' => {
                if characters.peek() == Some(&'\n') {
                    characters.next();
                }
                out.push('\n');
            }
            '\t' | '\n' => out.push(ch),
            // Line and paragraph separators break a line in the browser but not
            // in the terminal the file came from; the file gets to decide where
            // its lines end.
            '\u{2028}' | '\u{2029}' => {}
            // Every other C0 control, and DEL: a control character no terminal
            // would have printed is not part of the text.
            ch if ch < '\u{20}' || ch == '\u{7f}' => {}
            ch => out.push(ch),
        }
    }
    out
}

/// Eats the escape sequence that starts at the ESC already taken.
///
/// The bounds matter as much as the shapes: an ESC that begins nothing (a lone
/// one in a file that is not terminal output) must cost one character, not the
/// rest of the file.
fn skip_escape_sequence(characters: &mut Peekable<Chars<'_>>) {
    match characters.peek() {
        // CSI: parameter bytes, intermediate bytes, then one final byte. A
        // character outside those ranges means this was never a CSI, so it is
        // left where it is.
        Some('[') => {
            characters.next();
            while let Some(&ch) = characters.peek() {
                if ('\u{20}'..='\u{3f}').contains(&ch) {
                    characters.next();
                    continue;
                }
                if ('\u{40}'..='\u{7e}').contains(&ch) {
                    characters.next();
                }
                break;
            }
        }
        // OSC: a string ended by BEL or by ST. A newline ends it too and is left
        // in place - an unterminated title must not swallow the next line.
        Some(']') => {
            characters.next();
            while let Some(&ch) = characters.peek() {
                if ch == '\n' {
                    break;
                }
                characters.next();
                if ch == '\u{7}' {
                    break;
                }
                if ch == '\u{1b}' {
                    if characters.peek() == Some(&'\\') {
                        characters.next();
                    }
                    break;
                }
            }
        }
        // Two-character escapes (`ESC M`, `ESC 7`) and charset selections
        // (`ESC ( B`), which the intermediate range below covers.
        Some(&ch) => {
            characters.next();
            if ('\u{20}'..='\u{2f}').contains(&ch) {
                while let Some(&next) = characters.peek() {
                    characters.next();
                    if !('\u{20}'..='\u{2f}').contains(&next) {
                        break;
                    }
                }
            }
        }
        None => {}
    }
}

/// Which limit stopped the text. The note names the one that bound, because
/// naming both prints the same rounded size twice on a file that is barely over
/// the byte limit, which reads as an arithmetic mistake.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CutBy {
    Lines,
    Size,
}

/// What was left out of the document, and how much there was.
struct Cut {
    by: CutBy,
    total_lines: usize,
    total_bytes: usize,
    shown_lines: usize,
    shown_bytes: usize,
}

impl Cut {
    fn message(&self) -> String {
        let all = format!(
            "全 {} 行 / {} のうち、",
            thousands(self.total_lines),
            size(self.total_bytes)
        );
        match self.by {
            CutBy::Lines => format!("{all}先頭 {} 行を表示しています", thousands(self.shown_lines)),
            // A single line longer than the byte limit is cut inside itself, so
            // counting its lines would say "1 line of 1 line".
            CutBy::Size => format!("{all}先頭 {} までを表示しています", size(self.shown_bytes)),
        }
    }
}

/// The part of the text the document carries, and what was left out.
fn cut_to_limits(text: &str) -> (&str, Option<Cut>) {
    let mut newlines = 0usize;
    let mut line_cut = None;
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            newlines += 1;
            if newlines == MAX_LINES && line_cut.is_none() {
                line_cut = Some(index + 1);
            }
        }
    }

    let mut end = line_cut.unwrap_or(text.len()).min(text.len());
    let mut by = CutBy::Lines;
    if end > MAX_TEXT_BYTES {
        end = char_boundary_at_or_before(text, MAX_TEXT_BYTES);
        by = CutBy::Size;
    }
    if end >= text.len() {
        return (text, None);
    }

    let shown = &text[..end];
    let total_lines = if text.ends_with('\n') {
        newlines
    } else {
        newlines + 1
    };
    (
        shown,
        Some(Cut {
            by,
            total_lines,
            total_bytes: text.len(),
            shown_lines: line_count(shown),
            shown_bytes: shown.len(),
        }),
    )
}

/// Lines as a reader counts them: a last line without a newline still counts.
fn line_count(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let newlines = text.bytes().filter(|byte| *byte == b'\n').count();
    if text.ends_with('\n') {
        newlines
    } else {
        newlines + 1
    }
}

fn char_boundary_at_or_before(text: &str, mut index: usize) -> usize {
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn thousands(value: usize) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    // The digits are ASCII, so a byte position is a character position.
    for (position, digit) in digits.char_indices() {
        if position > 0 && (digits.len() - position) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// The size of the decoded text, in the units a reader would say it in. It is
/// not the size of the file on disk: a Shift_JIS file grows on the way in.
fn size(bytes: usize) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    if bytes as f64 >= MIB {
        format!("{:.1} MB", bytes as f64 / MIB)
    } else {
        format!("{} KB", (bytes as f64 / KIB).ceil() as usize)
    }
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/// The one door text walks through on its way into the document. Everything the
/// body carries - the text, the notices, the resolved paths - is written by
/// this function and by nothing else, so there is no second spelling of an
/// escape to keep in step with this one.
fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            ch => out.push(ch),
        }
    }
    out
}

/// Reads a path back out of the escaped text before it is resolved. Only the
/// five entities `escape_html` writes are understood - this is the inverse of
/// that function and not an HTML parser.
fn unescape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        match ENTITIES
            .iter()
            .find(|(entity, _)| tail.starts_with(entity))
        {
            Some((entity, ch)) => {
                out.push(*ch);
                rest = &tail[entity.len()..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/// A link the renderer decided to make. `href` and `text` are slices of the
/// escaped text, so they carry no character that could end an attribute or
/// start a tag; `local_path` is the renderer's own and is escaped on its way in.
struct Link {
    /// How many bytes of the escaped text the link covers.
    span: usize,
    href: String,
    text: String,
    local_path: Option<String>,
}

impl Link {
    fn html(&self) -> String {
        match &self.local_path {
            Some(path) => format!(
                "<a href=\"{}\" data-mycmux-local-path=\"{}\">{}</a>",
                self.href,
                escape_html(path),
                self.text
            ),
            None => format!("<a href=\"{}\">{}</a>", self.href, self.text),
        }
    }
}

/// Finds the addresses and the paths in the escaped text and wraps them.
///
/// This runs on the escaped text on purpose: whatever it copies through is
/// already safe, so a link's text and its `href` cannot carry a quote or a tag
/// no matter what the file said. The entities `escape_html` wrote are made of
/// characters an address may contain, so they travel inside a link intact and
/// mean the same thing again once the frame parses the document.
fn link_up(escaped: &str) -> String {
    let bytes = escaped.as_bytes();
    let mut out = String::with_capacity(escaped.len());
    let mut index = 0;
    let mut copied = 0;
    while index < bytes.len() {
        let found = match bytes[index] {
            // A drive can be spelled `h:` as easily as `http:`.
            b'h' | b'H' => web_link_at(escaped, index).or_else(|| local_link_at(escaped, index)),
            byte if byte == b'/' || byte.is_ascii_alphabetic() => local_link_at(escaped, index),
            _ => None,
        };
        match found {
            Some(link) => {
                out.push_str(&escaped[copied..index]);
                out.push_str(&link.html());
                index += link.span;
                copied = index;
            }
            // Every start this looks at is ASCII, so stepping a byte at a time
            // never lands inside a character.
            None => index += 1,
        }
    }
    out.push_str(&escaped[copied..]);
    out
}

fn web_link_at(escaped: &str, index: usize) -> Option<Link> {
    if !is_left_boundary(escaped, index) {
        return None;
    }
    let rest = &escaped[index..];
    if !(starts_with_ignore_ascii_case(rest, "http://")
        || starts_with_ignore_ascii_case(rest, "https://"))
    {
        return None;
    }
    let target = trim_link_tail(take_while(rest, is_url_char));
    // `https://` on its own is a word about addresses, not an address.
    if is_scheme_only(target) {
        return None;
    }
    Some(Link {
        span: target.len(),
        href: target.to_string(),
        text: target.to_string(),
        local_path: None,
    })
}

/// A path to a file on this machine.
///
/// Only absolute paths are linked. A relative one cannot be resolved honestly
/// from a line of a log - the working directory it was written from is not in
/// the file - and prose is full of things shaped like `src/main.rs` that are not
/// paths at all; linking those would put a link under half the words in a
/// sentence.
fn local_link_at(escaped: &str, index: usize) -> Option<Link> {
    if !is_left_boundary(escaped, index) {
        return None;
    }
    let rest = &escaped[index..];
    if !(looks_like_drive_path(rest) || rest.starts_with('/')) {
        return None;
    }
    let run = trim_link_tail(take_while(rest, is_path_char));
    if run.is_empty() {
        return None;
    }
    let (spelling, _line_and_column) = split_line_suffix(run);
    let spelled = unescape_html(spelling);
    // The run was measured on escaped text, where a `<` arrives as `&lt;` and
    // is made of characters a path may contain. The stop list has to be applied
    // again once the entities are read back, or the placeholder
    // `C:\Users\<あなた>\src` from a README is offered as a file to open.
    if !spelled.chars().all(is_path_char) {
        return None;
    }
    let resolved = resolve_local_path(&spelled)?;
    Some(Link {
        // The line number stays in what the reader sees: it is how the line was
        // written and it is what makes the link worth reading.
        span: run.len(),
        // The spelling the file used, so the link still reads as the file wrote
        // it. The pane opens the attribute below, not this.
        href: spelling.to_string(),
        text: run.to_string(),
        local_path: Some(resolved),
    })
}

/// Whether a link may start here: not in the middle of a word, and not after a
/// character that makes this the middle of some other target. Japanese is not a
/// boundary the other way round - `ファイルはC:\logs\app.log` is one sentence
/// with one path in it.
fn is_left_boundary(escaped: &str, index: usize) -> bool {
    let Some(previous) = escaped[..index].chars().next_back() else {
        return true;
    };
    !(previous.is_ascii_alphanumeric()
        || matches!(previous, '/' | '\\' | '.' | '-' | '_' | '~' | '%' | ':' | '@'))
}

fn starts_with_ignore_ascii_case(value: &str, prefix: &str) -> bool {
    value.len() >= prefix.len() && value.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn take_while(value: &str, keep: impl Fn(char) -> bool) -> &str {
    let end = value
        .char_indices()
        .find(|(_, ch)| !keep(*ch))
        .map_or(value.len(), |(index, _)| index);
    &value[..end]
}

/// The characters an address is made of. Everything else ends it, which is what
/// stops `https://example.com/xを参照` from linking the sentence as well as the
/// address: Japanese is not one of them.
fn is_url_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(
            ch,
            '-' | '.'
                | '_'
                | '~'
                | ':'
                | '/'
                | '?'
                | '#'
                | '['
                | ']'
                | '@'
                | '!'
                | '$'
                | '&'
                | '\''
                | '('
                | ')'
                | '*'
                | '+'
                | ','
                | ';'
                | '='
                | '%'
        )
}

/// The characters a path is made of. Japanese belongs to a path (a folder is
/// called `ドキュメント` often enough), so the list is written the other way
/// round: whitespace, the quoting characters a path is usually written between,
/// and Japanese punctuation end it.
///
/// A path with a space in it is therefore linked only as far as the space. The
/// alternative - guessing where a run of words stops being a path - links the
/// rest of the sentence when it guesses wrong.
fn is_path_char(ch: char) -> bool {
    !(ch.is_whitespace()
        || ch.is_control()
        || matches!(
            ch,
            '`' | '|'
                | '*'
                | '<'
                | '>'
                | '"'
                | '、'
                | '。'
                | '，'
                | '．'
                | '「'
                | '」'
                | '『'
                | '』'
                | '（'
                | '）'
                | '【'
                | '】'
                | '〔'
                | '〕'
                | '…'
                | '・'
        ))
}

/// Punctuation that follows a link rather than belonging to it. The Japanese
/// stops are here as well as in `is_path_char` so that the rule survives a
/// change to either list.
fn trim_link_tail(value: &str) -> &str {
    let mut end = value.len();
    loop {
        let head = &value[..end];
        // An entity is trimmed whole: `&amp;` would otherwise lose its `;` to
        // the rule below and arrive as the literal text `&amp`.
        if let Some(entity) = ENTITIES
            .iter()
            .find(|(entity, _)| head.ends_with(entity))
            .map(|(entity, _)| entity.len())
        {
            end -= entity;
            continue;
        }
        let Some(last) = head.chars().last() else {
            break;
        };
        let trim = match last {
            // `_` and `~` are not here on purpose. Markdown trims them because
            // they mark emphasis; this is not Markdown, and `app.log~` is a file
            // an editor really does leave behind.
            '.' | ',' | ':' | ';' | '!' | '?' | '*' | '\'' | '"' => true,
            '、' | '。' | '，' | '．' | '）' | '」' | '』' | '】' | '〕' | '…' => true,
            // A closing bracket belongs to the link when the link opened it.
            ')' => head.matches(')').count() > head.matches('(').count(),
            ']' => head.matches(']').count() > head.matches('[').count(),
            _ => false,
        };
        if !trim {
            break;
        }
        end -= last.len_utf8();
    }
    &value[..end]
}

/// Whether an address is nothing but its scheme (`https://`), which is a word
/// about addresses rather than one. The caller has matched a scheme already, so
/// a value without a colon cannot reach here.
fn is_scheme_only(value: &str) -> bool {
    value
        .split_once(':')
        .is_some_and(|(_, rest)| rest.chars().all(|ch| ch == '/'))
}

/// Splits `…\app.log:12:34` into the file and the place in it. The numbers are
/// worth showing - they are why the line was written - but they are not part of
/// the name of a file, and `app.log:12` as a path on Windows means an alternate
/// data stream.
fn split_line_suffix(run: &str) -> (&str, &str) {
    let mut path = run;
    for _ in 0..2 {
        let Some(head) = strip_trailing_colon_number(path) else {
            break;
        };
        // What is left has to still be a path: `C:12` is not `C` at line 12.
        if !(looks_like_drive_path(head) || head.starts_with('/')) {
            break;
        }
        path = head;
    }
    (path, &run[path.len()..])
}

fn strip_trailing_colon_number(value: &str) -> Option<&str> {
    let index = value.rfind(':')?;
    let digits = &value[index + 1..];
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(&value[..index])
}

fn starts_with_two_separators(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && matches!(bytes[0], b'/' | b'\\') && matches!(bytes[1], b'/' | b'\\')
}

fn looks_like_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

/// The absolute path a spelling in the text points at, or `None` when it points
/// at nothing this machine should open.
#[cfg(windows)]
fn resolve_local_path(spelling: &str) -> Option<String> {
    // UNC (`\\server\share`) and protocol relative (`//host/x`) reach another
    // machine, which is not what a path in a log is offering to show.
    if starts_with_two_separators(spelling) {
        return None;
    }
    let path = if looks_like_drive_path(spelling) {
        PathBuf::from(spelling)
    } else {
        // `/c/logs/app.log` is how Git-Bash spells a drive. A bare `/var/log/x`
        // is not a path on this machine at all, so it stays text.
        let converted = crate::pty::path_norm::posix_drive_to_windows(spelling);
        if converted == spelling {
            return None;
        }
        PathBuf::from(converted)
    };
    normalize_local_path(&path).map(|path| path.to_string_lossy().into_owned())
}

#[cfg(not(windows))]
fn resolve_local_path(spelling: &str) -> Option<String> {
    // A Windows drive path is not a path here either, and `//host/x` is another
    // machine wherever it is read.
    if starts_with_two_separators(spelling) || !spelling.starts_with('/') {
        return None;
    }
    normalize_local_path(Path::new(spelling)).map(|path| path.to_string_lossy().into_owned())
}

/// Resolves `.` and `..` without touching the disk, and refuses a path that
/// climbs above its own root or names a Windows device.
///
/// The same rule as `markdown_preview::normalize_local_path`, written again
/// rather than shared: the two renderers decide what a click may reach, and a
/// change made for one of them must not loosen the other by accident.
fn normalize_local_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    let mut depth = 0usize;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    continue;
                }
                normalized.pop();
                depth -= 1;
            }
            Component::Normal(segment) => {
                if !is_safe_path_segment(&segment.to_string_lossy()) {
                    return None;
                }
                normalized.push(segment);
                depth += 1;
            }
        }
    }
    (!normalized.as_os_str().is_empty()).then_some(normalized)
}

#[cfg(windows)]
fn is_safe_path_segment(segment: &str) -> bool {
    // A colon here is an alternate data stream or a drive relative path, and a
    // reserved name is a device: opening either would not be reading a file.
    if segment.contains(':') {
        return false;
    }
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return false;
    }
    let is_numbered_device = |prefix: &str| {
        stem.strip_prefix(prefix)
            .is_some_and(|rest| rest.len() == 1 && rest.as_bytes()[0].is_ascii_digit())
    };
    !(is_numbered_device("COM") || is_numbered_device("LPT"))
}

#[cfg(not(windows))]
fn is_safe_path_segment(segment: &str) -> bool {
    !segment.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The file the tests pretend the bytes were read from. Nothing resolves
    /// against it - the tests below prove that it changes nothing - but it is
    /// what the pane passes.
    #[cfg(windows)]
    const SOURCE_FILE: &str = r"C:\logs\x.log";
    #[cfg(not(windows))]
    const SOURCE_FILE: &str = "/logs/x.log";

    fn render(text: &str) -> String {
        text_to_static_html(text.as_bytes(), None).expect("the text renders")
    }

    fn body_of(html: &str) -> &str {
        let start = html.find("<body>").expect("the document has a body");
        &html[start + "<body>".len()..]
    }

    fn pre_of(html: &str) -> &str {
        let body = body_of(html);
        let start = body.find("<pre>").expect("the document has a pre");
        let end = body.find("</pre>").expect("the pre is closed");
        &body[start + "<pre>".len()..end]
    }

    // -- what the bytes were -------------------------------------------------

    #[test]
    fn utf8_text_is_shown_as_it_was_typed() {
        let html = render("日本語の本文\nsecond line\n");

        assert!(pre_of(&html).contains("日本語の本文\nsecond line\n"));
    }

    #[test]
    fn utf8_says_nothing_about_its_encoding() {
        let plain = render("日本語\n");
        let mut with_bom = UTF8_BOM.to_vec();
        with_bom.extend_from_slice("日本語\n".as_bytes());
        let marked = text_to_static_html(&with_bom, None).expect("the text renders");

        for html in [&plain, &marked] {
            // The stylesheet in the head knows about notices; the body must not.
            assert!(!body_of(html).contains("class=\"notice\""));
            assert!(!body_of(html).contains("として表示しています"));
        }
        // The mark itself is not part of the text.
        assert!(!marked.contains('\u{feff}'));
        assert!(pre_of(&marked).starts_with("日本語"));
    }

    #[test]
    fn utf16_little_endian_text_is_read() {
        let mut raw = UTF16LE_BOM.to_vec();
        for unit in "日本語\nabc\n".encode_utf16() {
            raw.extend_from_slice(&unit.to_le_bytes());
        }
        let html = text_to_static_html(&raw, None).expect("the text renders");

        assert!(pre_of(&html).contains("日本語\nabc\n"));
        assert!(html.contains("UTF-16 (LE) として表示しています"));
    }

    #[test]
    fn utf16_big_endian_text_is_read() {
        let mut raw = UTF16BE_BOM.to_vec();
        for unit in "日本語\nabc\n".encode_utf16() {
            raw.extend_from_slice(&unit.to_be_bytes());
        }
        let html = text_to_static_html(&raw, None).expect("the text renders");

        assert!(pre_of(&html).contains("日本語\nabc\n"));
        assert!(html.contains("UTF-16 (BE) として表示しています"));
    }

    #[test]
    fn shift_jis_text_is_read_and_said_to_be_shift_jis() {
        let (raw, _, errors) = SHIFT_JIS.encode("日本語のログ\n二行目\n");
        assert!(!errors, "the sample encodes to Shift_JIS");
        let html = text_to_static_html(&raw, None).expect("the text renders");

        assert!(pre_of(&html).contains("日本語のログ\n二行目\n"));
        assert!(html.contains("<p class=\"notice\">Shift_JIS として表示しています</p>"));
        // The notice is above the text, not inside it.
        assert!(html.find("Shift_JIS として").unwrap() < html.find("<pre>").unwrap());
    }

    #[test]
    fn bytes_that_are_no_encoding_we_know_are_refused() {
        // 0xFF starts nothing in UTF-8 and is one of the four bytes Shift_JIS
        // has no meaning for at all (0xA0, 0xFD, 0xFE, 0xFF). A lead byte with
        // no trail byte after it is refused the same way.
        for raw in [
            [0x41u8, 0xff, 0x42].as_slice(),
            [0x41, 0xa0, 0x42].as_slice(),
            [0x41, 0x81].as_slice(),
        ] {
            let error = text_to_static_html(raw, None).expect_err("refused");
            assert!(error.starts_with(NOT_TEXT), "{error}");
            assert!(error.contains("Shift_JIS"), "{error}");
        }
    }

    #[test]
    fn bytes_with_a_nul_are_refused_however_the_file_is_named() {
        let error = text_to_static_html(b"MZ\x90\x00\x03text", None).expect_err("refused");

        assert!(error.starts_with(NOT_TEXT));
        assert!(error.contains("NUL"));
    }

    #[test]
    fn a_nul_past_the_sniffing_window_is_only_a_control_character() {
        let mut raw = vec![b'a'; BINARY_SNIFF_BYTES];
        raw.push(0);
        raw.extend_from_slice("末尾\n".as_bytes());
        let html = text_to_static_html(&raw, None).expect("the text renders");

        assert!(pre_of(&html).contains("a末尾\n"));
        assert!(!html.contains('\u{0}'));
    }

    #[test]
    fn carriage_returns_become_line_feeds() {
        let html = render("windows\r\nold mac\rlast");

        assert_eq!(pre_of(&html), "windows\nold mac\nlast");
        assert!(!html.contains('\r'));
    }

    // -- what the text is allowed to do ---------------------------------------

    #[test]
    fn markup_in_the_text_is_text_and_reaches_the_document_escaped_once() {
        let html = render(concat!(
            "<script>alert(1)</script>\n",
            "<img src=x onerror=alert(1)>\n",
            "</pre><p>抜け出した</p>\n",
            "<iframe src=\"frame.html\"></iframe>\n",
            "<style>body{display:none}</style>\n",
            "<!-- コメント -->\n",
            "<a href=\"javascript:alert(1)\">クリック</a>\n",
            "<a href=\"data:text/html,x\">データ</a>\n",
            "&lt;すでにエスケープ済み&gt; & \" ' \n",
        ));
        let body = body_of(&html);

        // The tags are gone as tags and kept as text.
        assert!(!body.contains("<script"));
        assert!(!body.contains("<img"));
        assert!(!body.contains("<iframe"));
        assert!(!body.contains("<style"));
        assert!(!body.contains("<p>"));
        assert!(!body.contains("<!--"));
        assert!(body.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(body.contains("&lt;p&gt;抜け出した&lt;/p&gt;"));
        assert!(body.contains("&lt;!-- コメント --&gt;"));

        // The block the text tried to close is still the only one there is.
        assert_eq!(html.matches("<pre>").count(), 1);
        assert_eq!(html.matches("</pre>").count(), 1);

        // One escape, and only one: what arrived escaped is shown escaped.
        assert!(body.contains("&amp;lt;すでにエスケープ済み&amp;gt;"));
        assert!(body.contains("&amp; &quot; &#39;"));

        // Nothing in the text becomes a link, whatever it is dressed as.
        assert!(!body.contains("<a "));
        assert!(!body.contains("href=\"javascript"));
        assert!(!body.contains("href=\"data:"));
        assert!(body.contains("javascript:alert(1)"));
    }

    #[test]
    fn the_text_cannot_hand_itself_the_attribute_the_pane_trusts() {
        let html = render("<a data-mycmux-local-path=\"C:\\Windows\\system32\\cmd.exe\">偽</a>\n");
        let body = body_of(&html);

        // The markup stayed text, so the attribute the pane reads is the one the
        // renderer wrote for the path it found - never the one the file spelled.
        assert!(body.contains("&lt;a data-mycmux-local-path=&quot;"));
        assert_eq!(body.matches("<a ").count(), body.matches("<a href=\"").count());
        assert!(body.matches("<a ").count() <= 1);
    }

    #[test]
    fn ansi_escape_sequences_are_removed() {
        let html = render(concat!(
            "\u{1b}[31m赤い行\u{1b}[0m 普通の行\n",
            "\u{1b}]0;窓の題\u{7}題のあと\n",
            "\u{1b}[2K\u{1b}[1;32mgreen\u{1b}[m\n",
            "\u{1b}(B文字集合のあと\n",
        ));
        let pre = pre_of(&html);

        assert_eq!(pre, "赤い行 普通の行\n題のあと\ngreen\n文字集合のあと\n");
        assert!(!html.contains('\u{1b}'));
    }

    #[test]
    fn control_characters_other_than_tab_and_newline_are_removed() {
        let html = render("keep\tthis\ndrop\u{1}\u{7}\u{b}\u{c}\u{7f}that\u{2028}and\u{2029}this\n");

        assert_eq!(pre_of(&html), "keep\tthis\ndropthatandthis\n");
    }

    // -- how much of it is shown ----------------------------------------------

    #[test]
    fn a_file_with_more_lines_than_the_limit_is_cut_and_says_so() {
        let html = render(&"行\n".repeat(MAX_LINES + 10));
        let body = body_of(&html);

        assert_eq!(pre_of(&html).matches('\n').count(), MAX_LINES);
        assert!(body.contains("全 50,010 行 / 196 KB のうち、先頭 50,000 行を表示しています"));
        // The note is below the text, where the text stops.
        assert!(body.find("notice-end").unwrap() > body.find("</pre>").unwrap());
    }

    #[test]
    fn a_file_larger_than_the_size_limit_is_cut_on_a_character() {
        // One line of three byte characters, so the limit falls inside one.
        let html = render(&"あ".repeat(MAX_TEXT_BYTES / 3 + 10));
        let pre = pre_of(&html);

        assert!(pre.len() <= MAX_TEXT_BYTES);
        assert!(pre.len() > MAX_TEXT_BYTES - 3);
        assert!(pre.chars().all(|ch| ch == 'あ'));
        // The note names the byte limit, not the line it was cut inside.
        assert!(body_of(&html).contains("のうち、先頭 5.0 MB までを表示しています"));
    }

    #[test]
    fn an_empty_file_is_an_empty_page() {
        let html = text_to_static_html(b"", None).expect("an empty file renders");

        assert_eq!(pre_of(&html), "");
        assert!(!body_of(&html).contains("class=\"notice\""));
    }

    #[test]
    fn a_file_inside_both_limits_says_nothing_about_its_size() {
        let body = body_of(&render("短いログ\n")).to_string();

        assert!(!body.contains("notice-end"));
        assert!(!body.contains("を表示しています"));
    }

    // -- links ----------------------------------------------------------------

    #[test]
    fn web_addresses_become_links_without_the_punctuation_after_them() {
        let html = render(concat!(
            "https://example.com/docs を参照。\n",
            "詳しくは https://example.com/a?x=1&y=2 まで。\n",
            "(http://example.com/b) と [https://example.com/c]、\n",
            "末尾は https://example.com/d. と https://example.com/e、\n",
        ));
        let pre = pre_of(&html);

        assert!(pre.contains("<a href=\"https://example.com/docs\">https://example.com/docs</a> を参照。"));
        // The query keeps its ampersand, which the document spells as an entity.
        assert!(pre.contains("<a href=\"https://example.com/a?x=1&amp;y=2\">"));
        assert!(pre.contains("<a href=\"http://example.com/b\">http://example.com/b</a>)"));
        assert!(pre.contains("<a href=\"https://example.com/c\">https://example.com/c</a>]"));
        assert!(pre.contains("<a href=\"https://example.com/d\">https://example.com/d</a>. "));
        assert!(pre.contains("<a href=\"https://example.com/e\">https://example.com/e</a>、"));
    }

    #[test]
    fn an_address_that_is_only_a_scheme_stays_text() {
        let html = render("https:// と http:// は書き方の話です\n");

        assert!(!body_of(&html).contains("<a "));
    }

    #[test]
    fn an_address_inside_a_word_is_not_an_address() {
        let html = render("xhttps://example.com\n");

        assert!(!body_of(&html).contains("<a "));
    }

    #[cfg(windows)]
    #[test]
    fn absolute_paths_become_links_to_the_file() {
        let html = render(concat!(
            "失敗: C:\\logs\\app.log を確認\n",
            "Git-Bash では /c/logs/app.log\n",
            "ファイルはC:/logs/データ/メモ.txt です\n",
        ));
        let pre = pre_of(&html);

        assert!(pre.contains("<a href=\"C:\\logs\\app.log\" data-mycmux-local-path=\"C:\\logs\\app.log\">C:\\logs\\app.log</a>"));
        assert!(pre.contains("<a href=\"/c/logs/app.log\" data-mycmux-local-path=\"C:\\logs\\app.log\">"));
        // A Japanese folder name is part of the path, and the sentence in front
        // of it is not.
        assert!(pre.contains(
            "<a href=\"C:/logs/データ/メモ.txt\" data-mycmux-local-path=\"C:\\logs\\データ\\メモ.txt\">"
        ));
        assert!(pre.contains("ファイルは<a href=\"C:/logs"));
    }

    #[cfg(not(windows))]
    #[test]
    fn absolute_paths_become_links_to_the_file() {
        let html = render("失敗: /var/log/app.log を確認\n");
        let pre = pre_of(&html);

        assert!(pre.contains(
            "<a href=\"/var/log/app.log\" data-mycmux-local-path=\"/var/log/app.log\">/var/log/app.log</a>"
        ));
    }

    #[cfg(windows)]
    #[test]
    fn a_posix_root_is_not_a_path_on_this_machine() {
        let html = render("/var/log/syslog を見た\n");

        assert!(!body_of(&html).contains("<a "));
    }

    #[test]
    fn a_line_number_after_a_path_is_shown_but_is_not_part_of_the_file() {
        #[cfg(windows)]
        let (text, path) = ("C:\\src\\main.rs:12:34 で失敗\n", "C:\\src\\main.rs");
        #[cfg(not(windows))]
        let (text, path) = ("/src/main.rs:12:34 で失敗\n", "/src/main.rs");
        let html = render(text);
        let pre = pre_of(&html);

        assert!(pre.contains(&format!("data-mycmux-local-path=\"{path}\">")));
        assert!(pre.contains(&format!("{path}:12:34</a>")));
        assert!(!pre.contains("main.rs:12:34\" "));
    }

    #[test]
    fn targets_on_another_machine_are_not_linked() {
        let html = render(concat!(
            "\\\\server\\share\\a.log を開く\n",
            "//server/share/b.log も\n",
            "\\\\?\\C:\\Windows\\win.ini も\n",
        ));
        let body = body_of(&html);

        assert!(!body.contains("<a "));
        assert!(!body.contains("data-mycmux-local-path"));
        // The text itself is still all there.
        assert!(body.contains("\\\\server\\share\\a.log"));
    }

    #[cfg(windows)]
    #[test]
    fn a_device_name_and_a_stream_are_not_linked() {
        let html = render(concat!(
            "C:\\logs\\NUL を開く\n",
            "C:\\logs\\COM1 も\n",
            "C:\\logs\\app.log:stream も\n",
        ));

        assert!(!body_of(&html).contains("<a "));
    }

    #[test]
    fn a_path_written_between_quotes_or_backticks_is_only_the_path() {
        // How a path reaches a log (quoted) and how it reaches our own reports
        // (in backticks). The quote arrives as an entity, so it has to be
        // trimmed off the link whole rather than a character at a time.
        #[cfg(windows)]
        let (text, first, second) = (
            "\"C:\\logs\\a.log\" と `C:\\logs\\b.log` を見た\n",
            "C:\\logs\\a.log",
            "C:\\logs\\b.log",
        );
        #[cfg(not(windows))]
        let (text, first, second) = (
            "\"/logs/a.log\" と `/logs/b.log` を見た\n",
            "/logs/a.log",
            "/logs/b.log",
        );
        let html = render(text);
        let pre = pre_of(&html);

        assert!(pre.contains(&format!(
            "&quot;<a href=\"{first}\" data-mycmux-local-path=\"{first}\">{first}</a>&quot;"
        )));
        assert!(pre.contains(&format!(
            "`<a href=\"{second}\" data-mycmux-local-path=\"{second}\">{second}</a>`"
        )));
    }

    #[test]
    fn a_placeholder_shaped_like_a_path_is_not_a_path() {
        // From the source distribution's README, where the angle brackets are
        // an instruction to the reader and not part of any file's name.
        let html = render("展開先: C:\\Users\\<あなた>\\mycmux-src\\ に置く\n");
        let body = body_of(&html);

        assert!(!body.contains("<a "));
        assert!(body.contains("C:\\Users\\&lt;あなた&gt;\\mycmux-src\\"));
    }

    #[test]
    fn an_ampersand_inside_a_path_survives_the_round_trip() {
        #[cfg(windows)]
        let (text, expected) = ("C:\\logs\\a&b\\x.log\n", "C:\\logs\\a&b\\x.log");
        #[cfg(not(windows))]
        let (text, expected) = ("/logs/a&b/x.log\n", "/logs/a&b/x.log");
        let html = render(text);

        // The document spells the ampersand as an entity in both places, and it
        // is one ampersand again once the frame has parsed it.
        assert!(html.contains(&format!(
            "data-mycmux-local-path=\"{}\"",
            expected.replace('&', "&amp;")
        )));
        assert!(!html.contains("&amp;amp;"));
    }

    #[test]
    fn relative_paths_stay_text() {
        let html = render(concat!(
            "src/main.rs を直した\n",
            "./config.json と ../notes.txt も\n",
            "~/.ssh/id_rsa は書いてあるだけ\n",
        ));
        let body = body_of(&html);

        assert!(!body.contains("<a "));
        assert!(body.contains("src/main.rs"));
        assert!(body.contains("~/.ssh/id_rsa"));
    }

    #[test]
    fn a_path_cannot_climb_out_of_its_own_root() {
        #[cfg(windows)]
        let (text, expected) = ("C:\\logs\\..\\..\\..\\secret.txt\n", "C:\\secret.txt");
        #[cfg(not(windows))]
        let (text, expected) = ("/logs/../../../secret.txt\n", "/secret.txt");
        let html = render(text);

        assert!(html.contains(&format!("data-mycmux-local-path=\"{expected}\"")));
        for value in html.split("data-mycmux-local-path=\"").skip(1) {
            assert!(!value[..value.find('"').unwrap_or(0)].contains(".."));
        }
    }

    #[test]
    fn an_absolute_path_is_a_link_with_or_without_a_source_file() {
        #[cfg(windows)]
        let text = "C:\\logs\\app.log\n";
        #[cfg(not(windows))]
        let text = "/logs/app.log\n";

        let without = text_to_static_html(text.as_bytes(), None).expect("renders");
        let with = text_to_static_html(text.as_bytes(), Some(Path::new(SOURCE_FILE)))
            .expect("renders");

        assert!(without.contains("data-mycmux-local-path="));
        assert_eq!(without, with);
    }

    // -- the document ---------------------------------------------------------

    #[test]
    fn the_document_carries_its_policy_language_and_styles() {
        let html = render("本文\n");

        assert!(html.starts_with("<!doctype html><html lang=\"ja\">"));
        assert!(html.contains("<meta charset=\"utf-8\">"));
        assert!(html.contains(
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">"
        ));
        assert!(!html.contains("<base"));
        assert!(!html.contains("img-src"));
        assert!(html.contains("--md-bg"));
        assert!(html.contains("</style></head><body>"));
        assert!(html.ends_with("</body></html>"));
        // The text is one block and the page is nothing else.
        assert!(body_of(&html).starts_with("<pre>"));
    }

    #[test]
    #[ignore = "writes an HTML file to look at; needs MYCMUX_TXT_DUMP_IN and MYCMUX_TXT_DUMP_OUT"]
    fn dump_text_preview_for_visual_check() {
        let (Ok(input), Ok(output)) = (
            std::env::var("MYCMUX_TXT_DUMP_IN"),
            std::env::var("MYCMUX_TXT_DUMP_OUT"),
        ) else {
            return;
        };
        let source = PathBuf::from(input);
        let raw = std::fs::read(&source).expect("read the file named by MYCMUX_TXT_DUMP_IN");
        let html = text_to_static_html(&raw, Some(&source)).expect("the file renders as text");
        std::fs::write(output, html).expect("write the HTML named by MYCMUX_TXT_DUMP_OUT");
    }
}

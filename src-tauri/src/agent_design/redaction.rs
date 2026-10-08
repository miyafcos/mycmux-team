//! Ephemeral redaction. Only Mask metadata is serializable; values never enter caches.
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

pub const PLACEHOLDER: &str = "\u{2022}\u{2022}\u{2022}\u{2022}";
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mask {
    pub index: usize,
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub label: String,
}
pub struct Masked {
    pub body: String,
    pub masks: Vec<Mask>,
    pub values: Vec<String>,
}
#[derive(Clone)]
struct Token {
    start: usize,
    end: usize,
    value: String,
    key: bool,
    quoted: bool,
}
#[derive(Clone)]
struct Range {
    start: usize,
    end: usize,
    value: String,
    label: String,
}
pub fn sensitive_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "key",
        "token",
        "secret",
        "password",
        "passwd",
        "credential",
        "auth",
        "cookie",
        "session",
    ]
    .iter()
    .any(|part| name.contains(part))
}
fn trivial(value: &str) -> bool {
    let v = value.trim();
    v.is_empty()
        || v.eq_ignore_ascii_case("true")
        || v.eq_ignore_ascii_case("false")
        || v.parse::<f64>().is_ok()
}
fn punctuation(value: &str) -> bool {
    matches!(
        value,
        "{" | "}" | "[" | "]" | ":" | "=" | "," | ";" | "|" | ">"
    )
}
fn shape(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("sk-")
        || lower.contains("ghp_")
        || lower.contains("gho_")
        || lower.contains("bearer ")
        || value.contains("AKIA")
        || (lower.contains("xox")
            && lower
                .as_bytes()
                .windows(5)
                .any(|p| p.starts_with(b"xox") && p[4] == b'-'))
        || (value.contains("-----BEGIN ") && value.contains("PRIVATE KEY-----"))
        || (value.starts_with("eyJ") && value.split('.').count() >= 3)
        || (value.len() >= 32 && value.bytes().all(|c| c.is_ascii_hexdigit()))
        || (value.len() >= 32
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"+/=_-".contains(&c)))
}
fn tokens(text: &str) -> Vec<Token> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if bytes[i] == b'#' {
            i += text[i..].find('\n').unwrap_or(bytes.len() - i);
            continue;
        }
        if b"{}[]:=,;".contains(&bytes[i]) {
            out.push(Token {
                start: i,
                end: i + 1,
                value: text[i..i + 1].into(),
                key: false,
                quoted: false,
            });
            i += 1;
            continue;
        }
        if bytes[i] == b'"' || bytes[i] == b'\'' {
            let quote = bytes[i];
            let triple = bytes
                .get(i..i + 3)
                .is_some_and(|v| v.iter().all(|c| *c == quote));
            let width = if triple { 3 } else { 1 };
            let begin = i;
            i += width;
            let start = i;
            while i < bytes.len() {
                if bytes[i] == quote
                    && (!triple
                        || bytes
                            .get(i..i + 3)
                            .is_some_and(|v| v.iter().all(|c| *c == quote)))
                {
                    break;
                }
                if quote == b'"' && bytes[i] == b'\\' {
                    i += 1;
                    if i < bytes.len() {
                        i += text[i..].chars().next().unwrap().len_utf8();
                    }
                } else {
                    i += text[i..].chars().next().unwrap().len_utf8();
                }
            }
            let end = i;
            i = (i + width).min(bytes.len());
            let value = if quote == b'"' && !triple {
                serde_json::from_str::<String>(&text[begin..i])
                    .unwrap_or_else(|_| text[start..end].into())
            } else {
                text[start..end].into()
            };
            out.push(Token {
                start,
                end,
                value,
                key: false,
                quoted: true,
            });
            continue;
        }
        let start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && !b"{}[]:=,;#\"'".contains(&bytes[i])
        {
            i += text[i..].chars().next().unwrap().len_utf8();
        }
        if i == start {
            i += 1;
        }
        out.push(Token {
            start,
            end: i,
            value: text[start..i].into(),
            key: false,
            quoted: false,
        });
    }
    for i in 0..out.len().saturating_sub(1) {
        out[i].key = matches!(out[i + 1].value.as_str(), ":" | "=");
    }
    out
}

fn decoded_offset(t: &Token, text: &str, offset: usize) -> usize {
    let raw = &text[t.start..t.end];
    if raw == t.value {
        return t.start + offset;
    }
    let mut at = 0;
    for (decoded, _) in t.value.char_indices() {
        if decoded == offset {
            return t.start + at;
        }
        if raw.as_bytes().get(at) == Some(&b'\\') {
            if raw.as_bytes().get(at + 1) == Some(&b'u') {
                let high = raw
                    .get(at + 2..at + 6)
                    .and_then(|s| u16::from_str_radix(s, 16).ok());
                let pair = high.is_some_and(|u| (0xd800..=0xdbff).contains(&u))
                    && raw.get(at + 6..at + 8) == Some("\\u");
                at += (if pair { 12 } else { 6 }).min(raw.len() - at);
            } else {
                at = (at + 2).min(raw.len());
            }
        } else {
            at += raw[at..].chars().next().map(char::len_utf8).unwrap_or(0);
        }
    }
    t.end
}

fn named_values(value: &Value, hidden: bool, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if map
                .get("name")
                .or_else(|| map.get("key"))
                .and_then(Value::as_str)
                .is_some_and(sensitive_name)
            {
                if let Some(value) = map.get("value") {
                    named_values(value, true, out);
                }
            }
            for (k, v) in map {
                named_values(v, hidden || sensitive_name(k), out);
            }
        }
        Value::Array(values) => {
            for v in values {
                named_values(v, hidden, out);
            }
        }
        Value::String(s) if hidden && !trivial(s) => {
            out.insert(s.clone());
        }
        _ => {}
    }
}
pub fn mask(text: &str, private: bool) -> Masked {
    let ts = tokens(text);
    let mut ranges = Vec::<Range>::new();
    let mut known = BTreeSet::new();
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        named_values(&v, false, &mut known);
    }
    let mut add = |t: &Token, label: &str| {
        ranges.push(Range {
            start: t.start,
            end: t.end,
            value: t.value.clone(),
            label: {
                let _ = label;
                "value".into()
            },
        });
    };
    for (i, t) in ts.iter().enumerate() {
        let mut nested = false;
        if t.quoted && !t.key {
            let inner = tokens(&t.value);
            for (at, part) in inner.iter().enumerate() {
                if !sensitive_name(&part.value) {
                    continue;
                }
                let value = if part.key {
                    inner.get(at + 2)
                } else if part.value.starts_with("--") {
                    inner[at + 1..].iter().find(|v| !punctuation(&v.value))
                } else {
                    None
                };
                if let Some(value) =
                    value.filter(|v| !v.key && !punctuation(&v.value) && !trivial(&v.value))
                {
                    let sub = Token {
                        start: decoded_offset(t, text, value.start),
                        end: decoded_offset(t, text, value.end),
                        value: value.value.clone(),
                        key: false,
                        quoted: value.quoted,
                    };
                    add(&sub, "value");
                    known.insert(value.value.clone());
                    nested = true;
                }
            }
        }
        if !t.key
            && !punctuation(&t.value)
            && (private || (!nested && shape(&t.value)) || known.contains(&t.value))
        {
            add(t, "value");
        }
        if !t.key && t.value.starts_with("--") && sensitive_name(&t.value) {
            if let Some(value) = ts[i + 1..].iter().find(|v| !punctuation(&v.value)) {
                if !value.key && !trivial(&value.value) {
                    add(value, "value");
                    known.insert(value.value.clone());
                }
            }
        }
        if !t.key || !sensitive_name(&t.value) {
            continue;
        }
        let Some(value) = ts.get(i + 2) else {
            continue;
        };
        if matches!(value.value.as_str(), "{" | "[") {
            let mut depth = 0i32;
            for v in &ts[i + 2..] {
                if matches!(v.value.as_str(), "{" | "[") {
                    depth += 1;
                    continue;
                }
                if matches!(v.value.as_str(), "}" | "]") {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    continue;
                }
                if !v.key && !punctuation(&v.value) && !trivial(&v.value) {
                    add(v, &t.value);
                    known.insert(v.value.clone());
                }
            }
        } else if !value.key && !punctuation(&value.value) && !trivial(&value.value) {
            add(value, &t.value);
            known.insert(value.value.clone());
        }
    }
    drop(add);
    // TOML sections, YAML nesting/block scalars, and NAME=unquoted values.
    let lines: Vec<_> = text.split_inclusive('\n').collect();
    let mut offset = 0;
    let mut section = false;
    let mut parents = Vec::<(usize, bool)>::new();
    let mut env_value = false;
    for (n, line) in lines.iter().enumerate() {
        let trim = line.trim();
        let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
        if trim.starts_with('[') && trim.ends_with(']') && !trim.contains('=') {
            section = sensitive_name(trim);
            env_value = false;
        }
        if trim.is_empty() || trim.starts_with('#') {
            offset += line.len();
            continue;
        }
        while parents.last().is_some_and(|(level, _)| *level >= indent) {
            parents.pop();
        }
        let inherited = parents.iter().any(|(_, h)| *h);
        let begin_token = ts.partition_point(|t| t.start < offset);
        let end_token = ts.partition_point(|t| t.start < offset + line.len());
        let local: Vec<_> = ts[begin_token..end_token].iter().collect();
        let key = local.iter().find(|t| t.key);
        if key.is_some_and(|t| t.value == "name" || t.value == "key") {
            env_value = local
                .iter()
                .filter(|t| !t.key && !punctuation(&t.value))
                .last()
                .is_some_and(|t| sensitive_name(&t.value));
        }
        let hidden = section
            || inherited
            || key.is_some_and(|t| sensitive_name(&t.value) || (env_value && t.value == "value"));
        if let Some(key) = key {
            let after = ts.partition_point(|t| t.start < key.end);
            let delimiter = ts
                .get(after)
                .filter(|t| matches!(t.value.as_str(), ":" | "="));
            if let Some(delimiter) = delimiter {
                let value_start = (delimiter.end - offset).min(line.len());
                let tail = line[value_start..].trim();
                if delimiter.value == ":"
                    && (tail.is_empty()
                        || tail == "|"
                        || tail == ">"
                        || tail == "|-"
                        || tail == ">-")
                {
                    parents.push((indent, hidden));
                    if hidden && !tail.is_empty() {
                        let begin = offset + line.len();
                        let mut end = begin;
                        for next in lines.iter().skip(n + 1) {
                            let level = next.len() - next.trim_start_matches([' ', '\t']).len();
                            if !next.trim().is_empty() && level <= indent {
                                break;
                            }
                            end += next.len();
                        }
                        if end > begin {
                            ranges.push(Range {
                                start: begin,
                                end,
                                value: text[begin..end].into(),
                                label: "value".into(),
                            });
                        }
                    }
                }
                if hidden
                    && matches!(delimiter.value.as_str(), "=" | ":")
                    && !tail.starts_with(['\x22', '\x27', '[', '{'])
                    && !matches!(tail, "|" | ">" | "|-" | ">-")
                {
                    if let Some(value) = local
                        .iter()
                        .find(|t| !t.key && t.start >= delimiter.end && !punctuation(&t.value))
                    {
                        if !value.quoted
                            && !trivial(&value.value)
                            && !matches!(value.value.as_str(), "[" | "{")
                        {
                            let mut end = offset + line.trim_end_matches(['\r', '\n']).len();
                            if let Some(comment) = text[value.start..end].find(" #") {
                                end = value.start + comment;
                            }
                            if let Some(stop) = text[value.start..end].find(';') {
                                end = value.start + stop;
                            }
                            while end > value.start
                                && text.as_bytes()[end - 1].is_ascii_whitespace()
                            {
                                end -= 1;
                            }
                            if end > value.start {
                                known.insert(text[value.start..end].into());
                                ranges.push(Range {
                                    start: value.start,
                                    end,
                                    value: text[value.start..end].into(),
                                    label: "value".into(),
                                });
                            }
                        }
                    }
                }
            }
        }
        if hidden {
            let value_begin = key.map(|key| key.end).unwrap_or(offset);
            for t in local.iter().filter(|t| {
                t.start >= value_begin && !t.key && !punctuation(&t.value) && !trivial(&t.value)
            }) {
                ranges.push(Range {
                    start: t.start,
                    end: t.end,
                    value: t.value.clone(),
                    label: "value".into(),
                });
            }
        }
        offset += line.len();
    }
    if private {
        let mut offset = 0;
        for line in text.split_inclusive('\n') {
            if let Some(at) = line.find('#') {
                if ts
                    .iter()
                    .any(|t| t.quoted && offset + at >= t.start && offset + at < t.end)
                {
                    offset += line.len();
                    continue;
                }
                let start = offset + at + 1;
                let end = offset + line.trim_end_matches(['\r', '\n']).len();
                if end > start {
                    ranges.push(Range {
                        start,
                        end,
                        value: text[start..end].into(),
                        label: "value".into(),
                    });
                }
            }
            offset += line.len();
        }
    }
    // Prefixes and long runs in ordinary Markdown/text, outside quoted values.
    let key_ranges: Vec<_> = ts
        .iter()
        .filter(|t| t.key)
        .map(|t| (t.start, t.end))
        .collect();
    let mut key_cursor = 0;
    let mut start = 0;
    for (at, c) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        if c.is_ascii_alphanumeric() || "+/=_-.".contains(c) {
            continue;
        }
        if at > start {
            let mut value_start = start;
            let mut word_end = at;
            while word_end > value_start && text.as_bytes()[word_end - 1] == b'.' {
                word_end -= 1;
            }
            let mut word = &text[value_start..word_end];
            if let Some(eq) = word.find('=') {
                if eq < word.trim_end_matches('=').len()
                    && word[..eq]
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    value_start += eq + 1;
                    word = &text[value_start..word_end];
                }
            }
            while key_ranges
                .get(key_cursor)
                .is_some_and(|(_, end)| *end <= value_start)
            {
                key_cursor += 1;
            }
            let is_key = key_ranges
                .get(key_cursor)
                .is_some_and(|(begin, end)| value_start >= *begin && at <= *end);
            if !is_key && shape(word) {
                ranges.push(Range {
                    start: value_start,
                    end: word_end,
                    value: word.into(),
                    label: "value".into(),
                });
            }
        }
        start = at + c.len_utf8();
    }
    // Bearer headers can also appear as unquoted Markdown or shell arguments.
    let lower = text.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("bearer ") {
        let begin = cursor + found;
        let token_start = begin + 7;
        let tail = &text[token_start..];
        let length = tail
            .find(|c: char| c.is_whitespace() || "\x22\x27,;<>".contains(c))
            .unwrap_or(tail.len());
        let end = token_start + length;
        if end > token_start {
            ranges.push(Range {
                start: begin,
                end,
                value: text[begin..end].into(),
                label: "authorization".into(),
            });
        }
        cursor = end.max(token_start);
        if cursor >= text.len() {
            break;
        }
    }
    // Launch-agent command arguments use one <string> per argument.
    let mut cursor = 0;
    let mut pending_argument = false;
    while let Some(found) = text[cursor..].find("<string>") {
        let start = cursor + found + 8;
        let Some(length) = text[start..].find("</string>") else { break; };
        let end = start + length;
        cursor = end + 9;
        let value = &text[start..end];
        if pending_argument && !trivial(value) {
            ranges.push(Range { start, end, value: value.into(), label: "value".into() });
        }
        pending_argument = value.trim().starts_with("--") && sensitive_name(value) && !value.contains('=') && !value.trim().contains(' ');
        let parts = tokens(value);
        for (at, part) in parts.iter().enumerate() {
            if !part.value.starts_with("--") || !sensitive_name(&part.value) { continue; }
            if let Some(value) = parts[at + 1..].iter().find(|v| !punctuation(&v.value)) {
                if !value.key && !trivial(&value.value) {
                    ranges.push(Range { start: start + value.start, end: start + value.end, value: value.value.clone(), label: "value".into() });
                }
            }
        }
    }
    // XML/plist key/value pairs (including launch-agent environment dictionaries).
    let mut cursor = 0;
    while let Some(found) = text[cursor..].find("<key>") {
        let begin = cursor + found + 5;
        let Some(length) = text[begin..].find("</key>") else {
            break;
        };
        let end = begin + length;
        cursor = end + 6;
        if !sensitive_name(&text[begin..end]) {
            continue;
        }
        let next_key = text[cursor..]
            .find("<key>")
            .map(|n| cursor + n)
            .unwrap_or(text.len());
        if let Some(found) = text[cursor..next_key].find("<dict>") {
            let start = cursor + found + 6;
            let mut at = start;
            let mut depth = 1;
            while at < text.len() {
                let open = text[at..].find("<dict>").map(|n| at + n);
                let close = text[at..].find("</dict>").map(|n| at + n);
                if let Some(close) = close {
                    if open.is_some_and(|open| open < close) {
                        depth += 1;
                        at = open.unwrap() + 6;
                    } else {
                        depth -= 1;
                        if depth == 0 {
                            ranges.push(Range {
                                start,
                                end: close,
                                value: text[start..close].into(),
                                label: "value".into(),
                            });
                            break;
                        }
                        at = close + 7;
                    }
                } else {
                    break;
                }
            }
        }
        if let Some(found) = text[cursor..next_key].find("<string>") {
            let start = cursor + found + 8;
            if let Some(length) = text[start..].find("</string>") {
                let end = start + length;
                if !trivial(&text[start..end]) {
                    ranges.push(Range {
                        start,
                        end,
                        value: text[start..end].into(),
                        label: "value".into(),
                    });
                }
            }
        }
    }
    let mut pos = 0;
    while let Some(found) = text[pos..].find("-----BEGIN ") {
        let begin = pos + found;
        let header_end = begin + text[begin..].find('\n').unwrap_or(text.len() - begin);
        pos = (header_end + 1).min(text.len());
        if !text[begin..header_end].contains("PRIVATE KEY-----") {
            if pos == text.len() {
                break;
            }
            continue;
        }
        let end = text[pos..]
            .find("-----END ")
            .map(|at| {
                let start = pos + at;
                text[start + 9..]
                    .find("-----")
                    .map(|n| start + 9 + n + 5)
                    .unwrap_or(text.len())
            })
            .unwrap_or(text.len());
        ranges.push(Range {
            start: begin,
            end,
            value: text[begin..end].into(),
            label: "private key".into(),
        });
        pos = end;
        if pos == text.len() {
            break;
        }
    }
    known.extend(ranges.iter().filter(|r| !trivial(&r.value)).map(|r| r.value.clone()));
    // Hide repeated copies too, including JSON escapes and quoted/URL headers.
    for token in ts
        .iter()
        .filter(|t| !t.key && known.contains(&t.value) && t.value.len() < 8)
    {
        ranges.push(Range {
            start: token.start,
            end: token.end,
            value: token.value.clone(),
            label: "value".into(),
        });
    }
    for value in known.iter().filter(|v| !trivial(v) && v.len() >= 8) {
        for (start, _) in text.match_indices(value) {
            ranges.push(Range {
                start,
                end: start + value.len(),
                value: value.clone(),
                label: "value".into(),
            });
        }
        let encoded = serde_json::to_string(value).unwrap_or_default();
        if encoded.len() > 2 {
            let escaped = &encoded[1..encoded.len() - 1];
            if escaped != value {
                for (start, _) in text.match_indices(escaped) {
                    ranges.push(Range {
                        start,
                        end: start + escaped.len(),
                        value: value.clone(),
                        label: "value".into(),
                    });
                }
            }
        }
    }
    ranges.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut merged = Vec::<Range>::new();
    for r in ranges {
        if let Some(last) = merged
            .last_mut()
            .filter(|last| r.start < last.end || (r.start == last.start && r.end == last.end))
        {
            if r.end > last.end {
                last.end = r.end;
                last.value = text[last.start..last.end].into();
            }
        } else {
            merged.push(r);
        }
    }
    let mut body = String::new();
    let mut masks = Vec::new();
    let mut values = Vec::new();
    let mut previous = 0;
    let mut units = 0;
    let mut line_number = 1;
    for r in merged {
        let prefix = &text[previous..r.start];
        body.push_str(prefix);
        units += prefix.encode_utf16().count();
        line_number += prefix.bytes().filter(|b| *b == b'\n').count();
        let line = line_number;
        let start = units;
        body.push_str(PLACEHOLDER);
        units += 4;
        for c in text[r.start..r.end]
            .chars()
            .filter(|c| matches!(c, '\r' | '\n'))
        {
            body.push(c);
            units += 1;
        }
        masks.push(Mask {
            index: values.len(),
            start,
            end: units,
            line,
            label: r.label,
        });
        line_number += text[r.start..r.end].bytes().filter(|b| *b == b'\n').count();
        values.push(r.value);
        previous = r.end;
    }
    body.push_str(&text[previous..]);
    Masked {
        body,
        masks,
        values,
    }
}
/// Preserve catalogue identity/placement metadata; redact every data-bearing string.
pub fn scrub(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let field_name = map.get("key").and_then(Value::as_str).map(str::to_owned);
            for (key, v) in map {
                if key == "itemIds" {
                    if let Some(ids) = v.as_array_mut() {
                        // These references have the same identity contract as item.id.
                        // Windows path segments in an ID can resemble secret values.
                        for id in ids.iter_mut().filter(|id| !id.is_string()) {
                            scrub(id);
                        }
                        continue;
                    }
                }
                if let Some(s) = v.as_str() {
                    if [
                        "id",
                        "path",
                        "root",
                        "home",
                        "cwd",
                        "workFolder",
                        "from",
                        "to",
                        "targetPath",
                        "source",
                        "file",
                        "generatedAt",
                        "generator",
                        "revision",
                        "hash",
                    ]
                    .contains(&key.as_str())
                    {
                        continue;
                    }
                    let hidden = key == "value"
                        && field_name.as_ref().is_some_and(|n| sensitive_name(n))
                        && !trivial(s);
                    *v = Value::String(if hidden {
                        PLACEHOLDER.into()
                    } else {
                        mask(s, false).body
                    });
                } else {
                    scrub(v);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                scrub(value);
            }
        }
        Value::String(s) => *s = mask(s, false).body,
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const CANARY: &str = "CANARY_SECRET_7F3A";
    fn hidden(raw: &str, private: bool) -> Masked {
        let masked = mask(raw, private);
        assert!(
            !masked.body.contains(CANARY),
            "synthetic canary escaped masking"
        );
        assert!(!serde_json::to_string(&masked.masks)
            .unwrap()
            .contains(CANARY));
        assert!(masked.body.contains(PLACEHOLDER));
        assert_eq!(
            raw.bytes().filter(|b| *b == b'\n').count(),
            masked.body.bytes().filter(|b| *b == b'\n').count()
        );
        masked
    }
    #[test]
    fn names_json_nested_arrays_env_and_repeated_values_are_hidden() {
        let raw = format!(
            r#"{{"env":{{"API_KEY":"{CANARY}","public":"{CANARY}"}},"AuTh":{{"nested":["{CANARY}",true,12]}},"session_cookie":"{CANARY}","plain":"ok"}}"#
        );
        let m = hidden(&raw, false);
        assert_eq!(m.values.iter().filter(|s| s.as_str() == CANARY).count(), 4);
        assert!(m.body.contains("\"plain\":\"ok\""));
        for name in [
            "key",
            "token",
            "secret",
            "password",
            "passwd",
            "credential",
            "auth",
            "cookie",
            "session",
        ] {
            hidden(&format!("{{\"prefix_{name}_suffix\":\"{CANARY}\"}}"), false);
        }
    }
    #[test]
    fn trivial_named_values_stay_visible_but_shape_rule_still_applies() {
        let raw = r#"{"key":"","token":true,"secret":false,"password":12,"auth":"false","cookie":"12.5","session":0}"#;
        assert_eq!(mask(raw, false).body, raw);
        let raw = r#"{"token":"12345678901234567890123456789012"}"#;
        assert!(!mask(raw, false)
            .body
            .contains("12345678901234567890123456789012"));
    }
    #[test]
    fn toml_yaml_env_containers_and_block_strings_are_hidden() {
        for raw in [
            format!("Api_TOKEN = \"{CANARY}\"\r\nvisible = true\r\n"),
            format!("[credentials]\nname = \"{CANARY}\"\n[normal]\nname = \"visible\"\n"),
            format!("auth:\n  service:\n    label: {CANARY}\npublic: visible\n"),
            format!("PASSWORD: |\n  {CANARY}\n  second-secret-line\npublic: visible\n"),
            format!("SESSION_COOKIE={CANARY} value tail # comment\n"),
            format!("token = \"\"\"{CANARY}\nsecond-line\"\"\"\n"),
            format!("token: '{CANARY}'\n"),
        ] {
            hidden(&raw, false);
        }
    }
    #[test]
    fn secret_shapes_work_inside_markdown_quotes_urls_and_plain_headers() {
        for value in [
            concat!("sk-", "CANARY_SECRET_7F3A"),
            "ghp_CANARY_SECRET_7F3A",
            "gho_CANARY_SECRET_7F3A",
            "xoxb-CANARY_SECRET_7F3A",
            "xoxp-CANARY_SECRET_7F3A",
            "AKIACANARY_SECRET_7F3A",
            "Bearer CANARY_SECRET_7F3A",
            "eyJabc.CANARY_SECRET_7F3A.signature",
            "0123456789abcdef0123456789abcdef",
            "QWxhZGRpbjpvcGVuIHNlc2FtZV9sb25nX3ZhbHVl",
        ] {
            for raw in [
                format!("plain {value}.\n"),
                format!("\"{value}\""),
                format!("[link](https://example.test/?value={value})"),
            ] {
                let masked = mask(&raw, false);
                assert!(!masked.body.contains(value), "shape not hidden");
                assert!(!masked.body.contains(CANARY), "shape fragment not hidden");
            }
        }
    }
    #[test]
    fn pem_block_is_one_value_and_line_shape_is_preserved() {
        let raw = concat!("prefix\n-----BEGIN ", "RSA PRIVATE KEY", "-----\r\nCANARY_SECRET_7F3A\r\nshort-material\r\n-----END ", "RSA PRIVATE KEY", "-----\r\nsuffix\n");
        let m = hidden(raw, false);
        assert_eq!(m.masks.len(), 1);
        assert!(m.values[0].starts_with("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(m.body.contains("suffix"));
    }
    #[test]
    fn every_value_in_private_files_is_hidden_including_comments_and_scalars() {
        let raw="USER=CANARY_SECRET_7F3A\nPUBLIC=ordinary\nPORT=123\nEMPTY=\"\"\n# CANARY_SECRET_7F3A\n";
        let m = hidden(raw, true);
        for visible in ["ordinary", "123"] {
            assert!(!m.body.contains(visible));
        }
        for key in ["USER=", "PUBLIC=", "PORT=", "EMPTY="] {
            assert!(m.body.contains(key));
        }
        hidden(
            r#"{"account":"CANARY_SECRET_7F3A","public":"ordinary","enabled":true}"#,
            true,
        );
    }
    #[test]
    fn escaped_unicode_and_command_arguments_never_leak() {
        let raw = r#"{"api_token":"CANARY\u005fSECRET\u005f7F3A","copy":"CANARY_SECRET_7F3A"}"#;
        let m = hidden(raw, false);
        assert!(m.values.iter().any(|s| s == CANARY));
        for raw in [
            format!("{{\"command\":\"python hook.py --token {CANARY}\"}}"),
            format!("{{\"args\":[\"--auth\",\"{CANARY}\"]}}"),
            format!("python hook.py --password {CANARY}\n"),
            format!("<plist><dict><key>ApiToken</key><string>{CANARY}</string></dict></plist>"),
            format!("<plist><array><string>--token</string><string>{CANARY}</string></array></plist>"),
            format!("<plist><array><string>python --password={CANARY}</string></array></plist>"),
        ] {
            hidden(&raw, false);
        }
    }
    #[test]
    fn offsets_use_utf16_and_mask_metadata_carries_no_value() {
        let raw = "\u{1f511} token = \"CANARY_SECRET_7F3A\"\r\npublic=true\r\n";
        let m = hidden(raw, false);
        let first = &m.masks[0];
        assert_eq!(first.line, 1);
        let units = m.body.encode_utf16().collect::<Vec<_>>();
        assert_eq!(
            String::from_utf16(&units[first.start..first.start + 4]).unwrap(),
            PLACEHOLDER
        );
        assert_eq!(m.values[first.index], CANARY);
        assert_eq!(m.body.matches("\r\n").count(), 2);
    }
    #[test]
    fn catalogue_scrub_masks_data_without_changing_identity_fields() {
        let mut v = serde_json::json!({"id":"stable","path":"/synthetic/SKILL.md","fields":[{"key":"api_token","value":CANARY}],"body":format!("secret = \"{CANARY}\""),"number":12});
        scrub(&mut v);
        assert!(!v.to_string().contains(CANARY));
        assert_eq!(v["id"], "stable");
        assert_eq!(v["path"], "/synthetic/SKILL.md");
        assert_eq!(v["number"], 12);
    }
    #[test]
    fn named_env_entries_and_independent_command_values_are_hidden_separately() {
        for raw in [
            r#"{"env":[{"name":"API_TOKEN","value":"CANARY_SECRET_7F3A"}]}"#,
            "env:\n  - name: API_TOKEN\n    value: CANARY_SECRET_7F3A\n",
            "[[env]]\nname=\"API_TOKEN\"\nvalue=\"CANARY_SECRET_7F3A\"\n",
        ] {
            hidden(raw, false);
        }
        let raw = r#"{"command":"python C:\\tools\\hook.py --token CANARY_SECRET_7F3A --password SECOND_PRIVATE_VALUE"}"#;
        let m = hidden(raw, false);
        assert!(m.body.contains("python C:\\\\tools\\\\hook.py"));
        assert_eq!(m.masks.len(), 2);
        assert_eq!(m.values, vec![CANARY, "SECOND_PRIVATE_VALUE"]);
        let raw = r#"{"command":"python hook.py --token \"CANARY_SECRET_7F3A\""}"#;
        let m = hidden(raw, false);
        assert_eq!(m.values, vec![CANARY]);
    }

    #[test]
    fn catalogue_scrub_preserves_windows_references_and_still_masks_values() {
        let path = r"C:\Users\runneradmin\AppData\Local\Temp\.tmpABC123\.claude\projects\C--Users-runneradmin-AppData-Local-Temp--tmpABC123\memory\MEMORY.md";
        let id = format!("claude:memoryIndex:{path}");
        let mut value = serde_json::json!({
            "items": [{"id":id,"path":path}],
            "layers": [{"itemIds":[id]}],
            "readingFlows": [{"steps":[{"itemIds":[id]}]}],
            "compareRows": [{"cells":[{"itemIds":[id]}]}],
            "findings": [{"itemIds":[id]}],
            "fields": [{"key":"api_token","value":CANARY}],
            "body": format!("api_token = \"{CANARY}\""),
            "ordinaryValues": [format!("ghp_{CANARY}")],
            "malformedReferences": {"itemIds":[{"key":"api_token","value":CANARY}]},
            "malformedArray": {"itemIds":format!("ghp_{CANARY}")}
        });
        scrub(&mut value);
        for reference in [
            &value["layers"][0]["itemIds"][0],
            &value["readingFlows"][0]["steps"][0]["itemIds"][0],
            &value["compareRows"][0]["cells"][0]["itemIds"][0],
            &value["findings"][0]["itemIds"][0],
        ] {
            assert_eq!(reference, &value["items"][0]["id"]);
            assert_eq!(reference, &serde_json::json!(id));
        }
        assert_eq!(value["items"][0]["path"], path);
        assert!(!value.to_string().contains(CANARY));
        let first = value.clone();
        scrub(&mut value);
        assert_eq!(value, first);
    }
}

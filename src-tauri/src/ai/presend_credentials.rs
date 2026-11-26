//! The pre-send lane's defense in depth; never log the supplied values.
pub(super) const OMITTED: &str = "[credential omitted]";

#[derive(Clone, Copy)]
pub(super) struct Mask {
    pub(super) start: usize,
    pub(super) end: usize,
    quoted: bool,
}

impl Mask {
    fn new(start: usize, end: usize) -> Self {
        Self { start, end, quoted: false }
    }
}

fn render_masks<'a>(value: &'a str, masks: &[Mask]) -> std::borrow::Cow<'a, str> {
    if masks.is_empty() {
        return value.into();
    }
    let mut out = String::with_capacity(value.len());
    let mut from = 0;
    for mask in masks {
        out.push_str(&value[from..mask.start]);
        if mask.quoted { out.push('"'); }
        out.push_str(OMITTED);
        if mask.quoted { out.push('"'); }
        from = mask.end;
    }
    out.push_str(&value[from..]);
    out.into()
}

fn union_masks(mut masks: Vec<Mask>) -> Vec<Mask> {
    masks.sort_by_key(|mask| (mask.start, std::cmp::Reverse(mask.end)));
    let mut merged = Vec::<Mask>::new();
    for mask in masks {
        if let Some(last) = merged.last_mut() {
            if mask.start < last.end || mask.start == last.start {
                last.end = last.end.max(mask.end);
                last.quoted |= mask.start == last.start && mask.quoted;
                continue;
            }
        }
        merged.push(mask);
    }
    merged
}

// The earlier stages use bare markers. Project sorted offsets from that
// intermediate text to the source, including the full span of a touched marker.
fn source_masks(mut earlier: Vec<Mask>, later: Vec<Mask>) -> Vec<Mask> {
    if earlier.is_empty() { return later; }
    if later.is_empty() { return earlier; }
    let mut index = 0;
    let (mut source, mut view) = (0, 0);
    let mut offset = |position, right| {
        while let Some(mask) = earlier.get(index) {
            let start = view + (mask.start - source);
            if position <= start { break; }
            let end = start + OMITTED.len();
            if position < end { return if right { mask.end } else { mask.start }; }
            source = mask.end;
            view = end;
            index += 1;
        }
        source + (position - view)
    };
    let projected: Vec<_> = later.into_iter().map(|mask| Mask {
        start: offset(mask.start, false), end: offset(mask.end, true), quoted: mask.quoted,
    }).collect();
    earlier.extend(projected);
    union_masks(earlier)
}

fn whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}
fn ascii_at(value: &str, at: usize, needle: &str) -> bool {
    value
        .get(at..at + needle.len())
        .is_some_and(|s| s.eq_ignore_ascii_case(needle))
}
fn prefix_masks(value: &str, legacy: bool) -> Vec<Mask> {
    let patterns: &[(&str, usize, bool)] = if legacy {
        &[
            ("sk-or-", 12, false),
            ("sk-proj-", 12, false),
            ("github_pat_", 12, false),
            ("ghp_", 12, false),
        ]
    } else {
        &[
            ("sk-or-", 12, false),
            ("sk-proj-", 12, false),
            ("github_pat_", 12, false),
            ("ghp_", 12, false),
            ("sk-ant-", 1, false),
            ("xoxb-", 1, false),
            ("xoxp-", 1, false),
            ("xoxa-", 1, false),
            ("xoxs-", 1, false),
            ("xoxr-", 1, false),
            ("xapp-", 1, false),
            ("gho_", 1, false),
            ("ghs_", 1, false),
            ("ghu_", 1, false),
            ("ghr_", 1, false),
            ("glpat-", 20, false),
            ("AKIA", 16, true),
            ("ASIA", 16, true),
            ("sk-", 17, false),
        ]
    };
    let mut masks = Vec::new();
    let mut i = 0;
    'scan: while i < value.len() {
        for &(prefix, minimum, alnum_only) in patterns {
            if !value[i..].starts_with(prefix) {
                continue;
            }
            if !legacy
                && prefix.starts_with("sk-")
                && value[..i]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
            {
                continue;
            }
            let start = i + prefix.len();
            let mut end = start;
            let limit = if alnum_only { (start + minimum).min(value.len()) } else { value.len() };
            let allowed = |c: u8| {
                if alnum_only {
                    c.is_ascii_uppercase() || c.is_ascii_digit()
                } else {
                    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')
                }
            };
            while end < limit && allowed(value.as_bytes()[end]) {
                end += 1;
            }
            if end - start >= minimum && (!alnum_only || !value.as_bytes().get(end).is_some_and(|&c| allowed(c))) {
                masks.push(Mask::new(i, end));
                i = end;
                continue 'scan;
            }
        }
        let c = value[i..].chars().next().unwrap();
        i += c.len_utf8();
    }
    masks
}
fn pem_marker_end(value: &str, at: usize, marker: &str) -> Option<usize> {
    if !value[at..].starts_with(marker) {
        return None;
    }
    let start = at + marker.len();
    let rest = &value[start..];
    let dash = rest.find('-')?;
    (rest[..dash].ends_with("PRIVATE KEY") && rest[dash..].starts_with("-----"))
        .then_some(start + dash + 5)
}
fn pem_masks(value: &str) -> Vec<Mask> {
    let mut masks = Vec::new();
    let mut i = 0;
    while i < value.len() {
        if let Some(body) = pem_marker_end(value, i, "-----BEGIN") {
            let mut cursor = body;
            let mut end = value.len();
            while let Some(found) = value[cursor..].find("-----END") {
                let at = cursor + found;
                if let Some(close) = pem_marker_end(value, at, "-----END") {
                    end = close;
                    break;
                }
                cursor = at + "-----END".len();
            }
            masks.push(Mask::new(i, end));
            i = end;
        } else {
            let c = value[i..].chars().next().unwrap();
            i += c.len_utf8();
        }
    }
    masks
}
#[cfg(test)]
pub(super) fn legacy(value: &str) -> String {
    let prefixed = render_masks(value, &prefix_masks(value, true));
    render_masks(&prefixed, &pem_masks(&prefixed)).into_owned()
}

fn skip_space(value: &str, mut at: usize) -> usize {
    while let Some(c) = value[at..].chars().next() {
        if !whitespace(c) {
            break;
        }
        at += c.len_utf8();
    }
    at
}
fn is_quote(c: Option<&u8>) -> bool {
    matches!(c, Some(b'\'' | b'"'))
}

fn quoted_end(value: &str, at: usize, multiline: bool) -> (usize, bool) {
    let quote = value.as_bytes()[at] as char;
    let mut end = at + 1;
    while let Some(c) = value[end..].chars().next() {
        if !multiline && has_line_break(&value[end..end + c.len_utf8()]) {
            break;
        }
        end += c.len_utf8();
        if c == '\\' {
            if let Some(escaped) = value[end..].chars().next() {
                end += escaped.len_utf8();
            }
        } else if c == quote {
            if quote == '\'' && value[end..].starts_with('\'') {
                end += 1;
            } else {
                return (end, true);
            }
        }
    }
    (end, false)
}

fn line_beginning(value: &str, at: usize) -> usize {
    value[..at]
        .rfind(['\n', '\r', '\u{2028}', '\u{2029}'])
        .map_or(0, |offset| offset + value[offset..].chars().next().unwrap().len_utf8())
}

fn line_end(value: &str, at: usize) -> usize {
    value[at..]
        .find(['\n', '\r', '\u{2028}', '\u{2029}'])
        .map_or(value.len(), |offset| at + offset)
}

fn indented_value_end(value: &str, key_at: usize, start: usize, sequence: bool) -> Option<usize> {
    let indent = key_at - line_beginning(value, key_at);
    let mut end = start;
    let mut at = start;
    while at < value.len() {
        let column = at - line_beginning(value, at);
        let item = sequence && column == indent && value[at..].strip_prefix('-')
            .is_some_and(|rest| rest.chars().next().is_none_or(whitespace));
        if column <= indent && !item {
            if !sequence || !value[at..].starts_with('#') { break; }
            at = skip_space(value, line_end(value, at));
            continue;
        }
        end = line_end(value, at);
        at = skip_space(value, end);
    }
    (end > start).then(|| start + value[start..end].trim_end_matches(whitespace).len())
}

fn structured_end(value: &str, at: usize, flow: bool) -> usize {
    let mut closing = Vec::new();
    let mut end = at;
    while let Some(c) = value[end..].chars().next() {
        match c {
            '\'' | '"' => {
                end = quoted_end(value, end, true).0;
                continue;
            }
            '#' if flow && value[..end].chars().next_back().is_some_and(whitespace) => {
                end = line_end(value, end);
                continue;
            }
            '{' => closing.push('}'),
            '[' => closing.push(']'),
            _ if closing.last() == Some(&c) => {
                closing.pop();
                if closing.is_empty() {
                    return end + 1;
                }
            }
            _ => {}
        }
        end += c.len_utf8();
    }
    end
}

#[derive(Clone, Copy)]
enum ValueMode {
    Word,
    Line,
    Flow,
    Query,
}

fn value_end(value: &str, start: usize, mode: ValueMode) -> usize {
    if is_quote(value.as_bytes().get(start)) {
        return quoted_end(value, start, true).0;
    }
    if !matches!(mode, ValueMode::Word | ValueMode::Query)
        && !value[start..].starts_with(OMITTED)
        && value[start..].starts_with(['{', '['])
    {
        return structured_end(value, start, false);
    }
    let mut end = start;
    let mut content_end = start;
    while let Some(c) = value[end..].chars().next() {
        if value[end..].starts_with(OMITTED) {
            end += OMITTED.len();
            content_end = end;
            continue;
        }
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
            || match mode {
                ValueMode::Word => whitespace(c),
                ValueMode::Query => whitespace(c) || matches!(c, '&' | '#' | '\'' | '"'),
                ValueMode::Flow => matches!(c, ',' | '}' | ']'),
                ValueMode::Line => false,
            }
        {
            break;
        }
        end += c.len_utf8();
        if !whitespace(c) {
            content_end = end;
        }
    }
    content_end
}

fn value_mask(value: &str, start: usize, end: usize, quoted_key: bool) -> Mask {
    if is_quote(value.as_bytes().get(start)) {
        Mask::new(start + 1, end - usize::from(quoted_end(value, start, true).1))
    } else {
        Mask { start, end, quoted: quoted_key }
    }
}

fn authorization_header_start(value: &str, mut at: usize) -> Option<(usize, bool)> {
    if !ascii_at(value, at, "Authorization") {
        return None;
    }
    at += 13;
    if matches!(value.as_bytes().get(at), Some(b'\'' | b'"')) {
        at += 1;
    }
    at = skip_space(value, at);
    if value.as_bytes().get(at) != Some(&b':') {
        return None;
    }
    at = skip_space(value, at + 1);
    if matches!(value.as_bytes().get(at), Some(b'\'' | b'"')) {
        at += 1;
    }
    let scheme = ["Basic", "Token", "ApiKey"]
        .into_iter()
        .find(|scheme| ascii_at(value, at, scheme))?;
    let after = at + scheme.len();
    let start = skip_space(value, after);
    (start > after).then_some((start, scheme != "Basic"))
}
fn authorization_parameter(value: &str, at: usize) -> Option<usize> {
    let field = assignment_at(value, at)?;
    let start = field.start;
    let bytes = value.as_bytes();
    let escaped_quote = bytes.get(start) == Some(&b'\\') && is_quote(bytes.get(start + 1));
    // A generic named parameter needs a quoted value. A lone '=' can be Base64 padding.
    if !(credential_key(field.key.as_deref()?) || field.delimiter == "=" && (is_quote(bytes.get(start)) || escaped_quote)) {
        return None;
    }
    if escaped_quote {
        let end = line_end(value, start);
        let closing = &value[start..start + 2];
        if end < start + 2 {
            return Some(end);
        }
        return Some(value[start + 2..end].find(closing)
            .map_or(end, |offset| start + 4 + offset));
    }
    if is_quote(bytes.get(start)) {
        return Some(quoted_end(value, start, false).0);
    }
    let end = value[start..].find(|c| whitespace(c) || matches!(c, '\'' | '"' | ','));
    Some(end.map_or(value.len(), |offset| start + offset))
}

fn l5_authorization_value(
    value: &str,
    at: usize,
    minimum: usize,
    allow_parameter: bool,
) -> Option<Mask> {
    if allow_parameter {
        if let Some(end) = authorization_parameter(value, at) {
            return Some(Mask::new(at, end));
        }
    }
    let bytes = value.as_bytes();
    let start = at + usize::from(is_quote(bytes.get(at)));
    let mut end = start;
    while bytes
        .get(end)
        .is_some_and(|c| c.is_ascii_alphanumeric() || b"._~+/=-".contains(c))
    {
        end += 1;
    }
    (end - start >= minimum).then_some(Mask::new(start, end))
}

fn v09014_authorization_value(
    value: &str,
    at: usize,
    minimum: usize,
    allow_quoted_parameter: bool,
) -> Option<Mask> {
    let bytes = value.as_bytes();
    let first = bytes.get(at).copied();
    let start = at + usize::from(matches!(first, Some(b'\'' | b'"')));
    let mut end = start;
    while bytes
        .get(end)
        .is_some_and(|c| c.is_ascii_alphanumeric() || b"._~+/=-".contains(c))
    {
        end += 1;
    }
    if end - start < minimum {
        return None;
    }
    let following = bytes.get(end).copied();
    if allow_quoted_parameter && bytes[end - 1] == b'=' && following != first {
        let mut quote_at = end;
        while matches!(bytes.get(quote_at), Some(b' ' | b'\t')) {
            quote_at += 1;
        }
        if let Some(quote @ (b'\'' | b'"')) = bytes.get(quote_at).copied() {
            end = quote_at + 1;
            let mut escaped = false;
            for c in value[end..].chars() {
                if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
                    break;
                }
                end += c.len_utf8();
                if !escaped && c == char::from(quote) {
                    break;
                }
                escaped = !escaped && c == '\\';
            }
        } else if quote_at == end {
            end = value[end..]
                .find(whitespace)
                .map_or(value.len(), |offset| end + offset);
        }
    }
    Some(Mask::new(start, end))
}
fn authorization_masks(
    value: &str,
    read_value: fn(&str, usize, usize, bool) -> Option<Mask>,
) -> Vec<Mask> {
    let mut masks = Vec::new();
    let mut i = 0;
    while i < value.len() {
        let boundary = value[..i]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_');
        let mut bearer = false;
        let header = if boundary && ascii_at(value, i, "Bearer") {
            let after = i + 6;
            let candidate = skip_space(value, after);
            bearer = true;
            (candidate > after).then_some((candidate, false))
        } else if boundary {
            authorization_header_start(value, i)
        } else {
            None
        };
        if let Some((start, allow_quoted_parameter)) = header {
            if let Some(mask) =
                read_value(value, start, if bearer { 16 } else { 1 }, allow_quoted_parameter)
            {
                masks.push(mask);
                i = mask.end;
                continue;
            }
        }
        let c = value[i..].chars().next().unwrap();
        i += c.len_utf8();
    }
    masks
}
fn identifier(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')
}
pub(super) const CREDENTIAL_KEYS: &[&str] = &[
    "password", "passwd", "pwd", "token", "secret", "apikey",
    "api_key", "access_key", "secret_key", "private_key",
    "pgpassword", "sig", "x-amz-signature", "sessionid", "session_id",
];
fn credential_parts(key: &str, keys: &[&str]) -> bool {
    let parts: Vec<_> = key.split(['_', '-']).collect();
    parts.iter().any(|part| keys.contains(part))
        || parts.windows(2).any(|pair| {
            keys.iter().any(|key| {
                key.split_once('_') == Some((pair[0], pair[1]))
            })
        })
}
fn credential_key(key: &str) -> bool {
    credential_key_in(key, CREDENTIAL_KEYS)
}

fn credential_key_in(key: &str, keys: &[&str]) -> bool {
    let lower = key.to_ascii_lowercase();
    // Check the original boundaries before further splitting acronyms.
    keys.contains(&lower.as_str())
        || credential_parts(&lower, keys)
        || credential_key_with_boundaries(key, false, keys)
        || lower == "dbpassword"
        || credential_key_with_boundaries(key, true, keys)
}
fn credential_key_with_boundaries(key: &str, split_acronyms: bool, keys: &[&str]) -> bool {
    let mut separated = String::with_capacity(key.len());
    let mut bytes = key.bytes().peekable();
    let mut previous = None::<u8>;
    while let Some(c) = bytes.next() {
        if c.is_ascii_uppercase()
            && previous.is_some_and(|p| {
                p.is_ascii_lowercase()
                    || p.is_ascii_digit()
                    || (split_acronyms
                        && p.is_ascii_uppercase()
                        && bytes.peek().is_some_and(u8::is_ascii_lowercase))
            })
        {
            separated.push('_');
        }
        separated.push(c.to_ascii_lowercase() as char);
        previous = Some(c);
    }
    credential_parts(&separated, keys)
}
fn assignment_delimiter(value: &str) -> Option<&'static str> {
    ["=>", ":=", "=", ":", "\u{ff1d}", "\u{ff1a}"]
        .into_iter()
        .find(|delimiter| value.starts_with(delimiter))
}

fn has_line_break(value: &str) -> bool {
    value.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

fn starts_assignment(value: &str) -> bool {
    let bytes = value.as_bytes();
    let quote = bytes.first().copied().filter(|c| matches!(*c, b'\'' | b'"'));
    let key_start = usize::from(quote.is_some());
    let mut end = key_start;
    while bytes.get(end).is_some_and(|c| identifier(*c)) {
        end += 1;
    }
    if end == key_start {
        return false;
    }
    if let Some(quote) = quote {
        if bytes.get(end) != Some(&quote) {
            return false;
        }
        end += 1;
    }
    let at = skip_space(value, end);
    let delimiter = bytes.get(at);
    if has_line_break(&value[end..at]) || !matches!(delimiter, Some(b':' | b'=')) {
        return false;
    }
    let rest = &value[at + 1..];
    if rest.chars().next().is_some_and(|c| !whitespace(c)) {
        return false;
    }
    if delimiter == Some(&b':') || at > end {
        return true;
    }
    // A bare '=' at the end of a line may be Base64 padding.
    let body = skip_space(rest, 0);
    body < rest.len() && !has_line_break(&rest[..body])
}

struct Assignment<'a> {
    key: Option<std::borrow::Cow<'a, str>>,
    at: usize,
    quoted: bool,
    escaped: bool,
    delimiter: &'static str,
    after: usize,
    start: usize,
}

fn key_hex(raw: &str, at: usize, digits: usize) -> Option<u32> {
    let hex = raw.get(at..at + digits)?;
    if !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(hex, 16).ok()
}

fn decode_quoted_key(raw: &str) -> Option<String> {
    let mut decoded = String::with_capacity(raw.len());
    let mut i = 0;
    while let Some(c) = raw[i..].chars().next() {
        i += c.len_utf8();
        if c != '\\' {
            decoded.push(c);
            continue;
        }
        let escape = raw[i..].chars().next()?;
        i += escape.len_utf8();
        let digits = match escape { 'u' => 4, 'x' => 2, 'U' => 8, _ => 0 };
        if digits > 0 {
            let mut point = key_hex(raw, i, digits)?;
            i += digits;
            if (0xd800..=0xdfff).contains(&point) {
                if escape != 'u' || point > 0xdbff || !raw[i..].starts_with("\\u") {
                    return None;
                }
                let low = key_hex(raw, i + 2, 4)?;
                if !(0xdc00..=0xdfff).contains(&low) {
                    return None;
                }
                point = 0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00);
                i += 6;
            }
            decoded.push(char::from_u32(point)?);
        } else {
            // Reject escape letters whose meanings differ across the input formats.
            decoded.push(match escape {
                'b' => '\u{8}',
                'f' => '\u{c}',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'v' => '\u{b}',
                '0'..='9' | 'a' | 'e' | 'N' | '_' | 'L' | 'P' | '\n' | '\r' | '\u{2028}' | '\u{2029}' => {
                    return None;
                }
                other => other,
            });
        }
    }
    Some(decoded)
}

fn is_structured_credential_key(key: &str) -> bool {
    key.eq_ignore_ascii_case("authorization") || credential_key(key)
}

fn assignment_at(value: &str, at: usize) -> Option<Assignment<'_>> {
    use std::borrow::Cow;

    let bytes = value.as_bytes();
    let quoted = is_quote(bytes.get(at));
    let (key_end, raw) = if quoted {
        if at > 0 && bytes[at - 1] == b'\\' {
            return None;
        }
        let (end, closed) = quoted_end(value, at, true);
        if !closed {
            return None;
        }
        let raw = &value[at + 1..end - 1];
        if !raw.contains('\\') && (raw.is_empty() || !raw.bytes().all(identifier)) {
            return None;
        }
        (end, raw)
    } else {
        let mut end = at;
        while bytes.get(end).is_some_and(|c| identifier(*c)) {
            end += 1;
        }
        if end == at {
            return None;
        }
        (end, &value[at..end])
    };
    let delimiter_at = skip_space(value, key_end);
    let delimiter = assignment_delimiter(&value[delimiter_at..])?;
    let after = delimiter_at + delimiter.len();
    let escaped = quoted && raw.contains('\\');
    Some(Assignment {
        key: if escaped { decode_quoted_key(raw).map(Cow::Owned) } else { Some(Cow::Borrowed(raw)) },
        at,
        quoted,
        escaped,
        delimiter,
        after,
        start: skip_space(value, after),
    })
}

fn sibling_assignment(value: &str, field_at: usize, end: usize, flow: bool) -> Option<Assignment<'_>> {
    let mut at = end;
    while matches!(value.as_bytes().get(at), Some(b' ' | b'\t')) {
        at += 1;
    }
    if value[at..].starts_with('#') {
        at = line_end(value, at);
    }
    if flow {
        at = skip_space(value, at);
        while value[at..].starts_with('#') {
            at = skip_space(value, line_end(value, at));
        }
        if !value[at..].starts_with(',') {
            return None;
        }
        at += 1;
    } else {
        let c = value[at..].chars().next()?;
        if !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            return None;
        }
        at += c.len_utf8();
    }
    at = skip_space(value, at);
    let indent = if flow { 0 } else { field_at - line_beginning(value, field_at) };
    while at < value.len() && (value[at..].starts_with('#') || !flow && at - line_beginning(value, at) > indent) {
        at = skip_space(value, line_end(value, at));
    }
    if !flow && at - line_beginning(value, at) != indent {
        return None;
    }
    assignment_at(value, at).filter(|field| field.delimiter == ":")
}

#[derive(Clone, Copy)]
enum EnvironmentName {
    Ordinary,
    Credential,
    OmitReading,
}

fn skip_yaml_comments(value: &str, at: usize) -> usize {
    let mut at = skip_space(value, at);
    while value[at..].starts_with('#') {
        at = skip_space(value, line_end(value, at));
    }
    at
}

fn environment_member_start(value: &str, field: &Assignment<'_>, flow: bool) -> usize {
    let start = skip_yaml_comments(value, field.start);
    if flow {
        return start;
    }
    let end = line_end(value, field.after);
    if start <= end {
        return start;
    }
    let indent = field.at - line_beginning(value, field.at);
    // Every block member, not just the name, ends before the next sibling.
    if start < value.len() && start - line_beginning(value, start) > indent { start } else { end }
}

fn environment_name(value: &str, start: usize) -> EnvironmentName {
    use EnvironmentName::{Credential, OmitReading, Ordinary};

    let bytes = value.as_bytes();
    if is_quote(bytes.get(start)) {
        let (end, closed) = quoted_end(value, start, true);
        if !closed {
            return OmitReading;
        }
        let raw = &value[start + 1..end - 1];
        if raw.contains('\\') {
            // Escaped credential names in split records are not sent for reading.
            return if decode_quoted_key(raw).as_deref().is_none_or(is_structured_credential_key) {
                OmitReading
            } else {
                Ordinary
            };
        }
        return if !raw.is_empty() && raw.bytes().all(identifier) && credential_key(raw) {
            Credential
        } else {
            Ordinary
        };
    }
    let mut end = start;
    while bytes.get(end).is_some_and(|c| identifier(*c)) {
        end += 1;
    }
    if end == start {
        return OmitReading;
    }
    let bounded = value[end..].chars().next().is_none_or(|c| whitespace(c) || ",}]".contains(c));
    if bounded && credential_key(&value[start..end]) {
        Credential
    } else {
        Ordinary
    }
}

fn environment_value(value: &str, field: &Assignment<'_>, flow: bool) -> Option<(usize, bool)> {
    if field.delimiter != ":" {
        return None;
    }
    let key = field.key.as_deref()?;
    let name_first = key.eq_ignore_ascii_case("name");
    if !name_first && !key.eq_ignore_ascii_case("value") {
        return None;
    }
    let mut member_at = field.at;
    let mut start = environment_member_start(value, field, flow);
    let name = name_first.then(|| environment_name(value, start));
    if matches!(name, Some(EnvironmentName::Ordinary)) {
        return None;
    }
    loop {
        // A flow boundary that cannot be established must not hide a sibling.
        let end = if flow {
            let Some(end) = yaml_flow_node_end(value, start) else { return Some((field.at, true)); };
            end
        } else {
            value_end(value, start, ValueMode::Line)
        };
        let next = sibling_assignment(value, field.at, end, flow)?;
        let next_key = next.key.as_deref()?;
        if next.at <= member_at || next_key.eq_ignore_ascii_case(key) {
            return None;
        }
        start = environment_member_start(value, &next, flow);
        if next_key.eq_ignore_ascii_case(if name_first { "value" } else { "name" }) {
            let at = if name_first { next.at } else { field.at };
            return match name.unwrap_or_else(|| environment_name(value, start)) {
                EnvironmentName::Ordinary => None,
                EnvironmentName::Credential => Some((at, false)),
                EnvironmentName::OmitReading => Some((at, true)),
            };
        }
        member_at = next.at;
    }
}

fn setting_value(key: &str, body: &str, yaml: bool) -> bool {
    let scalar = if yaml {
        body.split_once('#').filter(|(before, _)| before.ends_with([' ', '\t']))
            .map_or(body, |(before, _)| before.trim_end_matches([' ', '\t']))
    } else {
        body
    };
    match key.to_ascii_lowercase().as_str() {
        "sig_version" | "sigversion" | "httptokencount" | "oauthtokencount" | "token_count" =>
            !scalar.is_empty() && scalar.bytes().all(|c| c.is_ascii_digit()),
        "use-sig" => scalar.eq_ignore_ascii_case("true") || scalar.eq_ignore_ascii_case("false"),
        _ => false,
    }
}

fn scheme_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'+' | b'.' | b'-')
}

fn host_with_port(value: &str) -> bool {
    let rest = if let Some(unbracketed) = value.strip_prefix('[') {
        let Some((host, rest)) = unbracketed.split_once(']') else {
            return false;
        };
        if host.is_empty() || !host.bytes().all(|c| c.is_ascii_hexdigit() || b":.%".contains(&c)) {
            return false;
        }
        rest
    } else {
        let host_end = value.find(':').unwrap_or(value.len());
        let host = &value[..host_end];
        if host.is_empty() || !host.bytes().all(|c| c.is_ascii_alphanumeric() || b"._%-".contains(&c)) {
            return false;
        }
        &value[host_end..]
    };
    rest.is_empty() || rest.strip_prefix(':').is_some_and(|port| {
        (1..=5).contains(&port.len()) && port.bytes().all(|c| c.is_ascii_digit())
    })
}
fn url_authority(value: &str, start: usize, masks: &mut Vec<Mask>) -> Option<usize> {
    let bytes = value.as_bytes();
    if !bytes[start].is_ascii_alphabetic() || (start > 0 && scheme_char(bytes[start - 1])) {
        return None;
    }
    let mut at = start + 1;
    while bytes.get(at).is_some_and(|c| scheme_char(*c)) {
        at += 1;
    }
    if !value[at..].starts_with("://") {
        return None;
    }
    let body = at + 3;
    let mut end = body;
    let mut last_at = None;
    while let Some(c) = value[end..].chars().next() {
        if value[end..].starts_with(OMITTED) {
            end += OMITTED.len();
            continue;
        }
        if whitespace(c) || "/?#<>\"\u{60}".contains(c) {
            break;
        }
        if c == '@' {
            last_at = Some(end);
        }
        end += c.len_utf8();
    }
    let Some(last_at) = last_at else {
        let mut host_end = end;
        while host_end > body && b"')],".contains(&bytes[host_end - 1]) {
            if bytes[host_end - 1] == b']' && bytes[body] == b'[' {
                break;
            }
            host_end -= 1;
        }
        return host_with_port(&value[body..host_end])
            .then_some(host_end);
    };
    let password = value[body..last_at].find(':').map_or(last_at, |colon| body + colon);
    let user = &value[body..password];
    if let Some(field) = user.char_indices()
        .filter(|(at, _)| *at == 0 || !identifier(user.as_bytes()[*at - 1]))
        .find_map(|(at, _)| assignment_at(user, at).filter(|field| field.key.as_deref().is_some_and(credential_key)))
    {
        let start = if field.at == 0 { body + field.start } else { body };
        masks.push(Mask::new(start, password));
    }
    if password < last_at {
        masks.push(Mask::new(password + 1, last_at));
    }
    Some(end)
}

fn yaml_block_header(line: &str) -> bool {
    let marker = line.split('#').next().unwrap_or_default().trim_end_matches([' ', '\t']);
    let modifiers = marker.strip_prefix(['|', '>']);
    modifiers.is_some_and(|modifiers| {
        let digits = modifiers.bytes().filter(|c| (b'1'..=b'9').contains(c)).count();
        let signs = modifiers.bytes().filter(|&c| c == b'+' || c == b'-').count();
        digits <= 1 && signs <= 1 && digits + signs == modifiers.len()
    })
}

fn assignment_mask(value: &str, field: &Assignment<'_>, flow: bool) -> Option<(Mask, usize)> {
    let (start, quoted, at) = (field.start, field.quoted, field.at);
    let query = at > 0 && matches!(value.as_bytes()[at - 1], b'?' | b'&');
    let yaml = !query && !flow && field.delimiter == ":"
        && matches!(value[line_beginning(value, at)..at].trim_matches(whitespace), "" | "-");
    let crosses_line = has_line_break(&value[field.after..start]);
    if yaml && !crosses_line && value[start..].starts_with(['|', '>']) {
        let end = line_end(value, start);
        if yaml_block_header(&value[start..end]) {
            let block_start = skip_space(value, end);
            return indented_value_end(value, at, block_start, false)
                .map(|block_end| (Mask::new(block_start, block_end), block_end));
        }
    }
    let quoted_value = is_quote(value.as_bytes().get(start)) && assignment_at(value, start).is_none();
    if crosses_line && !query && !flow && (!quoted || yaml) && start < value.len() && !quoted_value {
        if let Some(block_end) = indented_value_end(value, at, start, yaml) {
            return Some((Mask { start, end: block_end, quoted }, block_end));
        }
        if starts_assignment(&value[start..]) {
            return None;
        }
    }
    if !query && !quoted_value && is_quote(value.as_bytes().get(start)) {
        let end = line_end(value, start);
        return Some((Mask::new(start, end), end));
    }
    let mode = if query {
        ValueMode::Query
    } else if flow || quoted && !yaml {
        ValueMode::Flow
    } else {
        ValueMode::Line
    };
    let mut end = value_end(value, start, mode);
    if !crosses_line && yaml && !quoted_value && end > start {
        let continuation = skip_space(value, line_end(value, end));
        end = indented_value_end(value, at, continuation, value[start..].starts_with('#')).unwrap_or(end);
    }
    if start == end || setting_value(field.key.as_deref().unwrap_or_default(), &value[start..end], yaml) {
        return None;
    }
    Some((value_mask(value, start, end, quoted), end))
}

fn yaml_node_position(value: &str, at: usize, flow: bool) -> Option<(usize, bool)> {
    let bytes = value.as_bytes();
    let mut left = at;
    while left > 0 && matches!(bytes[left - 1], b' ' | b'\t') {
        left -= 1;
    }
    let previous = value[..left].chars().next_back();
    if previous.is_none_or(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')) {
        return Some((at - left, false));
    }
    if flow && previous.is_some_and(|c| ":[{,".contains(c)) {
        return Some((0, previous == Some(':')));
    }
    if !matches!(previous, Some(':' | '-')) || left == at {
        return None;
    }
    let prefix = &value[line_beginning(value, left - 1)..left];
    let key = prefix.trim_start_matches([' ', '\t']);
    let indent = prefix.len() - key.len();
    if previous == Some('-') {
        return (key == "-").then_some((indent, false));
    }
    let sequence_prefix = key.strip_prefix('-').filter(|rest| rest.starts_with([' ', '\t']));
    let column = sequence_prefix.map_or(indent, |rest| {
        indent + 1 + rest.len() - rest.trim_start_matches([' ', '\t']).len()
    });
    Some((column, true))
}

fn yaml_property_end(value: &str, at: usize) -> Option<usize> {
    let marker = value.as_bytes()[at];
    let next = value[at + 1..].chars().next();
    if marker == b'?' {
        return next.is_none_or(whitespace).then_some(at + 1);
    }
    if !matches!(marker, b'&' | b'*' | b'!') {
        return None;
    }
    if marker == b'!' && next == Some('<') {
        if let Some(end) = value[at + 2..line_end(value, at)].find('>') {
            return Some(at + 3 + end);
        }
    }
    let mut end = at + 1;
    while let Some(c) = value[end..].chars().next() {
        if whitespace(c) || ",[]{}=\"'".contains(c) {
            break;
        }
        end += c.len_utf8();
    }
    if marker == b'*' && value[at + 1..end].contains('*') {
        return None;
    }
    (end > at + 1 || marker == b'!').then_some(end)
}

// Return the end of the actual flow value, not the legacy mask span.
fn yaml_flow_node_end(value: &str, start: usize) -> Option<usize> {
    #[derive(PartialEq)]
    enum Mode { Start, Plain, Closed }
    let mut closing = Vec::new();
    let mut mode = Mode::Start;
    let mut at = start;
    let mut end = start;
    while let Some(c) = value[at..].chars().next() {
        if whitespace(c) {
            at = skip_space(value, at);
            continue;
        }
        if c == '#' && (at == start || value[..at].chars().next_back().is_some_and(whitespace)) {
            at = line_end(value, at);
            continue;
        }
        if ",]}".contains(c) {
            if closing.is_empty() {
                return Some(end);
            }
            if c == ',' {
                mode = Mode::Start;
            } else {
                if closing.pop() != Some(c) {
                    return None;
                }
                mode = Mode::Closed;
            }
        } else if c == ':' && !closing.is_empty() && (mode == Mode::Closed
            || value[at + 1..].chars().next().is_none_or(|next| whitespace(next) || ",[]{}".contains(next)))
        {
            mode = Mode::Start;
        } else if mode == Mode::Start && matches!(c, '\'' | '"') {
            let (quoted_end, closed) = quoted_end(value, at, true);
            if !closed {
                return None;
            }
            at = quoted_end;
            end = at;
            mode = Mode::Closed;
            continue;
        } else if mode == Mode::Start && "&*!?".contains(c) {
            if let Some(property) = yaml_property_end(value, at) {
                at = property;
                end = at;
                if c == '*' {
                    mode = Mode::Closed;
                }
                continue;
            }
            mode = Mode::Plain;
        } else if mode == Mode::Start && matches!(c, '{' | '[') {
            closing.push(if c == '{' { '}' } else { ']' });
        } else {
            if mode == Mode::Closed || matches!(c, '{' | '[') {
                return None;
            }
            mode = Mode::Plain;
        }
        at += c.len_utf8();
        end = at;
    }
    None
}

fn yaml_inline_node_end(value: &str, start: usize) -> usize {
    let mut end = start;
    while let Some(c) = value[end..].chars().next() {
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            break;
        }
        end = match c {
            '#' if value[..end].chars().next_back().is_some_and(whitespace) => line_end(value, end),
            '{' | '[' => structured_end(value, end, false),
            '\'' | '"' if end == 0 || !identifier(value.as_bytes()[end - 1]) => {
                quoted_end(value, end, true).0
            }
            _ => end + c.len_utf8(),
        };
    }
    end
}

fn yaml_value_indicator(value: &str, at: usize, flow: bool) -> bool {
    value.as_bytes().get(at) == Some(&b':')
        && (flow || value[at + 1..].chars().next().is_none_or(whitespace))
}

fn yaml_scalar_tail_is_known(node: &str, end: usize) -> bool {
    let tail = &node[skip_space(node, end)..];
    tail.is_empty() || (tail.starts_with('#') && !has_line_break(tail))
}

fn yaml_anchor_may_name_credential(node: &str) -> bool {
    let mut at = skip_space(node, 0);
    while node[at..].starts_with('!') {
        at = skip_space(node, yaml_property_end(node, at).unwrap());
    }
    // Only a scalar we can classify may clear a previous sensitive binding.
    if at == node.len() {
        return true;
    }
    if is_quote(node.as_bytes().get(at)) {
        let (end, closed) = quoted_end(node, at, true);
        if !closed || has_line_break(&node[at..end]) || !yaml_scalar_tail_is_known(node, end) {
            return true;
        }
        return decode_quoted_key(&node[at + 1..end - 1]).as_deref().is_none_or(is_structured_credential_key);
    }
    let mut end = at;
    while node.as_bytes().get(end).is_some_and(|c| identifier(*c)) {
        end += 1;
    }
    end == at || !yaml_scalar_tail_is_known(node, end) || is_structured_credential_key(&node[at..end])
}

fn yaml_explicit_key_is_sensitive(key: &str, credential_anchors: &std::collections::HashSet<&str>) -> bool {
    let bytes = key.as_bytes();
    let mut at = 0;
    while let Some(c) = key[at..].chars().next() {
        if c == '#' && (at == 0 || key[..at].chars().next_back().is_some_and(whitespace)) {
            at = line_end(key, at);
        } else if is_quote(bytes.get(at)) {
            let (end, closed) = quoted_end(key, at, true);
            if !closed || decode_quoted_key(&key[at + 1..end - 1]).as_deref().is_none_or(is_structured_credential_key) {
                return true;
            }
            at = end;
        } else if matches!(c, '&' | '*' | '!') {
            let end = yaml_property_end(key, at).unwrap_or(at + 1);
            if c == '*' && credential_anchors.contains(&key[at + 1..end]) {
                return true;
            }
            at = end;
        } else if c.is_ascii() && identifier(c as u8) {
            let mut end = at + 1;
            while bytes.get(end).is_some_and(|c| identifier(*c)) {
                end += 1;
            }
            if is_structured_credential_key(&key[at..end]) {
                return true;
            }
            at = end;
        } else {
            at += c.len_utf8();
        }
    }
    false
}

// A YAML node property follows its own value or key through nested children,
// ending at the next sibling. Keep the scopes separate from plain prose.
fn yaml_node_scopes(value: &str) -> Option<Vec<Mask>> {
    let bytes = value.as_bytes();
    let mut scopes = Vec::new();
    let mut credential_anchors = std::collections::HashSet::new();
    let mut closing = Vec::new();
    let mut at = 0;
    while let Some(c) = value[at..].chars().next() {
        let flow = !closing.is_empty();
        if !flow && value[..at].chars().next_back().is_none_or(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')) {
            let line = &value[at..];
            if (line.starts_with("---") || line.starts_with("..."))
                && line[3..].chars().next().is_none_or(whitespace)
            {
                credential_anchors.clear();
            }
            if line.starts_with("\u{60}\u{60}\u{60}") || line.starts_with("~~~") {
                credential_anchors.clear();
            }
        }
        if c == '#' && (at == 0 || value[..at].chars().next_back().is_some_and(whitespace)) {
            at = line_end(value, at);
            continue;
        }
        if is_quote(bytes.get(at)) && if flow { yaml_node_position(value, at, true).is_some() }
            else { at == 0 || (!identifier(bytes[at - 1]) && bytes[at - 1] != b'\\') }
        {
            let (end, closed) = quoted_end(value, at, true);
            if closed {
                at = end;
                continue;
            }
            if flow || (yaml_node_position(value, at, false).is_some() && value[at..line_end(value, at)].contains('\\')) {
                return None;
            }
        }
        if matches!(c, '&' | '*' | '!' | '?') {
            if let Some((body, (column, after_colon))) = yaml_property_end(value, at)
                .zip(yaml_node_position(value, at, flow))
            {
                let mut end = if flow { yaml_flow_node_end(value, body)? } else { yaml_inline_node_end(value, body) };
                let mut next = skip_space(value, end);
                if !flow {
                    let rest = value[body..end].trim_start_matches([' ', '\t']);
                    let marker_only = rest.is_empty() || (rest.starts_with('#') && !has_line_break(rest));
                    while next < value.len() {
                        if bytes[next] == b'#' {
                            next = skip_space(value, line_end(value, next));
                            continue;
                        }
                        let indent = next - line_beginning(value, next);
                        let sequence = marker_only && after_colon && indent == column && bytes[next] == b'-'
                            && value[next + 1..].chars().next().is_none_or(whitespace);
                        if indent <= column && !sequence {
                            break;
                        }
                        end = yaml_inline_node_end(value, next);
                        next = skip_space(value, end);
                    }
                }
                let name = &value[at + 1..body];
                if c == '&' {
                    // A later alias may use this scalar as a mapping key.
                    if yaml_anchor_may_name_credential(&value[body..end]) {
                        credential_anchors.insert(name);
                    } else {
                        credential_anchors.remove(name);
                    }
                } else if c == '*' && !after_colon && credential_anchors.contains(name) {
                    let delimiter = skip_space(value, body);
                    if !has_line_break(&value[body..delimiter]) && yaml_value_indicator(value, delimiter, flow) {
                        return None;
                    }
                } else if c == '?' && (flow || yaml_value_indicator(value, next, false))
                    && yaml_explicit_key_is_sensitive(&value[body..end], &credential_anchors)
                {
                    return None;
                }
                scopes.push(Mask::new(at, end));
                // Continue through the node so nested markers stay visible.
                at = body;
                continue;
            }
        }
        match c {
            '{' => closing.push('}'),
            '[' => closing.push(']'),
            other if closing.last() == Some(&other) => { closing.pop(); }
            _ => {}
        }
        at += c.len_utf8();
    }
    Some(union_masks(scopes))
}

fn ambiguous_credential_field(value: &str, field: &Assignment<'_>, flow: bool, end: usize) -> bool {
    if field.delimiter != ":" {
        return false;
    }
    if is_quote(value.as_bytes().get(field.start)) && !quoted_end(value, field.start, true).1 {
        return true;
    }
    if flow {
        let next = skip_space(value, end);
        return next < value.len()
            && !matches!(value.as_bytes().get(next), Some(b',' | b'}' | b']'))
            && has_line_break(&value[end..next]);
    }
    let prefix = &value[line_beginning(value, field.at)..field.at];
    let leading = prefix.trim_start_matches([' ', '\t']);
    let indent = if leading.is_empty()
        || leading.strip_prefix('-').is_some_and(|rest| {
            !rest.is_empty() && rest.bytes().all(|c| matches!(c, b' ' | b'\t'))
        })
    {
        prefix.len()
    } else {
        prefix.len() - leading.len()
    };
    let mut next = skip_space(value, line_end(value, end));
    while value[next..].starts_with('#') {
        next = skip_space(value, line_end(value, next));
    }
    next < value.len() && next - line_beginning(value, next) > indent
}

fn l5_assignment_masks(value: &str, mut escaped_keys: Option<&mut Vec<Mask>>) -> (Vec<Mask>, bool) {
    let check_boundaries = escaped_keys.is_some();
    let mut masks = Vec::new();
    let scopes = if check_boundaries {
        let Some(scopes) = yaml_node_scopes(value) else { return (masks, true); };
        scopes
    } else {
        Vec::new()
    };
    let mut yaml_scopes = scopes.iter().peekable();
    let bytes = value.as_bytes();
    let mut closing = Vec::new();
    let mut environment_values = std::collections::HashSet::new();
    let mut quoted_through = 0;
    let mut i = 0;
    while i < value.len() {
        let c = bytes[i];
        let flow = !closing.is_empty() && i >= quoted_through;
        if (identifier(c) || is_quote(bytes.get(i))) && (i == 0 || !identifier(bytes[i - 1])) {
            if let Some(end) = identifier(c).then(|| url_authority(value, i, &mut masks)).flatten() {
                i = end;
                continue;
            }
            let field = assignment_at(value, i);
            let mut masked = None;
            if let Some(field) = &field {
                let key = field.key.as_deref();
                if check_boundaries && key.is_none() {
                    return (masks, true);
                }
                let mut paired_here = environment_values.remove(&i);
                // Continue inspecting the fields in between; they can be secrets too.
                if let Some((paired_at, omit_reading)) = environment_value(value, field, flow) {
                    if check_boundaries && omit_reading {
                        return (masks, true);
                    }
                    if paired_at == i { paired_here = true; } else { environment_values.insert(paired_at); }
                }
                let authorization = key.is_some_and(|key| key.eq_ignore_ascii_case("authorization"));
                let secret = paired_here || key.is_some_and(credential_key) || (field.escaped && authorization);
                if secret {
                    masked = assignment_mask(value, field, flow);
                }
                if check_boundaries && (secret || authorization) {
                    let end = masked.map_or_else(
                        || value_end(value, field.start, if flow { ValueMode::Flow } else { ValueMode::Line }),
                        |(_, end)| end,
                    );
                    while yaml_scopes.peek().is_some_and(|scope| scope.end <= i) {
                        yaml_scopes.next();
                    }
                    let marked = i >= quoted_through && field.delimiter == ":" && yaml_scopes.peek()
                        .is_some_and(|scope| scope.start < field.after.max(end));
                    let uncovered = secret && flow && field.delimiter == ":"
                        && yaml_flow_node_end(value, field.start).is_none_or(|flow_end| flow_end > end);
                    if uncovered || marked || ambiguous_credential_field(value, field, flow, end) {
                        return (masks, true);
                    }
                }
            }
            if let Some((mask, end)) = masked {
                if let Some(keys) = escaped_keys.as_deref_mut().filter(|_| field.as_ref().is_some_and(|field| field.escaped)) {
                    keys.push(mask);
                }
                masks.push(mask);
                i = end;
                continue;
            }
            if let Some(field) = field.as_ref().filter(|field| field.quoted) {
                i = field.after;
                continue;
            }
            if identifier(c) {
                let mut end = i + 1;
                while bytes.get(end).is_some_and(|c| identifier(*c)) {
                    end += 1;
                }
                let start = skip_space(value, end);
                if field.is_none() && start > end && matches!(
                    value[i..end].to_ascii_lowercase().as_str(),
                    "--password" | "--token" | "--secret" | "--api-key"
                ) {
                    let stop = value_end(value, start, ValueMode::Word);
                    let body = start + usize::from(is_quote(bytes.get(start)));
                    if stop > start && bytes.get(body) != Some(&b'-') {
                        masks.push(value_mask(value, start, stop, false));
                        i = stop;
                        continue;
                    }
                }
                i = end;
                continue;
            }
        }
        if i >= quoted_through {
            match c {
                b'#' if i == 0 || value[..i].chars().next_back().is_some_and(whitespace) => {
                    quoted_through = line_end(value, i);
                }
                b'{' => closing.push(b'}'),
                b'[' => closing.push(b']'),
                _ if closing.last() == Some(&c) => { closing.pop(); }
                b'\'' | b'"' if flow && yaml_node_position(value, i, true).is_some() => {
                    quoted_through = quoted_end(value, i, true).0;
                }
                _ => {}
            }
        }
        let c = value[i..].chars().next().unwrap();
        i += c.len_utf8();
    }
    (masks, false)
}

const V09014_KEYS: &[&str] = &[
    "password", "passwd", "pwd", "token", "secret", "apikey",
    "api_key", "access_key", "secret_key", "private_key",
    "pgpassword", "sig", "x-amz-signature", "sessionid",
];
fn v09014_masked_value(
    value: &str,
    at: usize,
    stop_at_quote: bool,
    allowed: impl FnOnce(&str) -> bool,
) -> Option<(Mask, usize)> {
    let first = value[at..].chars().next()?;
    let quote = matches!(first, '\'' | '"').then_some(first);
    let start = at + usize::from(quote.is_some());
    if value[start..].chars().next().is_some_and(|c| !c.is_ascii()) {
        return None;
    }
    let mut end = start;
    let mut escaped = false;
    let mut closed = false;
    while end < value.len() {
        if quote.is_none() && value[end..].starts_with(OMITTED) {
            end += OMITTED.len();
            continue;
        }
        let c = value[end..].chars().next().unwrap();
        if let Some(quote) = quote {
            if !escaped && c == quote {
                closed = true;
                break;
            }
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            }
        } else if whitespace(c) || (stop_at_quote && matches!(c, '\'' | '"')) {
            break;
        }
        end += c.len_utf8();
    }
    if (quote.is_none() && end == start) || !allowed(&value[start..end]) {
        return None;
    }
    Some((Mask::new(start, end), end + usize::from(closed)))
}

fn url_password(value: &str, start: usize) -> Option<(usize, usize)> {
    let bytes = value.as_bytes();
    if !bytes[start].is_ascii_alphabetic() || (start > 0 && scheme_char(bytes[start - 1])) {
        return None;
    }
    let mut at = start + 1;
    while bytes.get(at).is_some_and(|c| scheme_char(*c)) {
        at += 1;
    }
    if !value[at..].starts_with("://") {
        return None;
    }
    at += 3;
    let mut password_start = None;
    while at < value.len() {
        if value[at..].starts_with(OMITTED) {
            at += OMITTED.len();
            continue;
        }
        let c = value[at..].chars().next().unwrap();
        if c == '@' {
            return password_start.filter(|start| *start < at).map(|start| (start, at));
        }
        if !(c.is_ascii_alphanumeric()
            || "._~%!$&'()*+,;=:-".contains(c)
            || (!c.is_ascii() && !whitespace(c)))
        {
            return None;
        }
        if c == ':' && password_start.is_none() {
            password_start = Some(at + 1);
        }
        at += c.len_utf8();
    }
    None
}

fn v09014_assignment_masks(value: &str) -> Vec<Mask> {
    let mut masks = Vec::new();
    let mut i = 0;
    while i < value.len() {
        if identifier(value.as_bytes()[i]) && (i == 0 || !identifier(value.as_bytes()[i - 1])) {
            if let Some((start, end)) = url_password(value, i) {
                masks.push(Mask::new(start, end));
                i = end + 1;
                continue;
            }
            let mut end = i;
            while value.as_bytes().get(end).is_some_and(|c| identifier(*c)) {
                end += 1;
            }
            let key = &value[i..end];
            if credential_key_in(key, V09014_KEYS) {
                let key_end = end
                    + usize::from(matches!(value.as_bytes().get(end), Some(b'\'' | b'"')));
                let at = skip_space(value, key_end);
                let delimiter = assignment_delimiter(&value[at..]);
                let argument = delimiter.is_none()
                    && at > end
                    && matches!(
                        key.to_ascii_lowercase().as_str(),
                        "--password" | "--token" | "--secret" | "--api-key"
                    );
                let value_from = delimiter.map_or(key_end, |delimiter| at + delimiter.len());
                let start = delimiter.map_or(at, |_| skip_space(value, value_from));
                let next_assignment = has_line_break(&value[value_from..start])
                    && starts_assignment(&value[start..]);
                if (delimiter.is_some() || argument) && !next_assignment {
                    if let Some((mask, end)) = v09014_masked_value(value, start, false, |body| {
                        !argument || !body.starts_with('-')
                    }) {
                        masks.push(mask);
                        i = end;
                        continue;
                    }
                }
            }
            i = end;
            continue;
        }
        let c = value[i..].chars().next().unwrap();
        i += c.len_utf8();
    }
    masks
}
fn v09014_masks(value: &str) -> Vec<Mask> {
    let headers = authorization_masks(value, v09014_authorization_value);
    let assignments = v09014_assignment_masks(&render_masks(value, &headers));
    source_masks(headers, assignments)
}

fn l5_masks(value: &str) -> Vec<Mask> {
    let headers = authorization_masks(value, l5_authorization_value);
    let (assignments, _) = l5_assignment_masks(&render_masks(value, &headers), None);
    source_masks(headers, assignments)
}

/// Source byte offsets. Both policies share identical PEM and prefix matches.
pub(super) fn presend_credential_ranges(value: &str) -> Vec<Mask> {
    let pem = pem_masks(value);
    let prefixes = prefix_masks(&render_masks(value, &pem), false);
    let common = source_masks(pem, prefixes);
    let prepared = render_masks(value, &common);
    let mut masks = v09014_masks(&prepared);
    masks.extend(l5_masks(&prepared));
    source_masks(common, union_masks(masks))
}

pub(super) fn scrub(value: &str) -> String {
    render_masks(value, &presend_credential_ranges(value)).into_owned()
}

/// The reading pipeline can omit input whose credential value cannot be bounded.
pub(super) fn scrub_for_reading(value: &str) -> Option<String> {
    let mut escaped_keys = Vec::new();
    if l5_assignment_masks(value, Some(&mut escaped_keys)).1 {
        return None;
    }
    // Another credential pattern can mask part of a quoted key before the
    // later assignment scan. The original value ranges are still needed.
    let mut masks = presend_credential_ranges(value);
    masks.extend(escaped_keys);
    Some(render_masks(value, &union_masks(masks)).into_owned())
}

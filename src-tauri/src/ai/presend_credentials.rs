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

fn structured_end(value: &str, at: usize) -> usize {
    let mut closing = Vec::new();
    let mut end = at;
    while let Some(c) = value[end..].chars().next() {
        match c {
            '\'' | '"' => {
                end = quoted_end(value, end, true).0;
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
        return structured_end(value, start);
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
    if !(credential_key(field.key) || field.delimiter == "=" && (is_quote(bytes.get(start)) || escaped_quote)) {
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

#[derive(Clone, Copy)]
struct Assignment<'a> {
    key: &'a str,
    at: usize,
    quoted: bool,
    delimiter: &'static str,
    after: usize,
    start: usize,
}

fn assignment_at(value: &str, at: usize) -> Option<Assignment<'_>> {
    let bytes = value.as_bytes();
    let quote = bytes.get(at).filter(|_| is_quote(bytes.get(at)));
    let begin = at + usize::from(quote.is_some());
    let mut end = begin;
    while bytes.get(end).is_some_and(|c| identifier(*c)) {
        end += 1;
    }
    if end == begin || (quote.is_some() && bytes.get(end) != quote) {
        return None;
    }
    let key_end = end + usize::from(quote.is_some());
    let delimiter_at = skip_space(value, key_end);
    let delimiter = assignment_delimiter(&value[delimiter_at..])?;
    let after = delimiter_at + delimiter.len();
    Some(Assignment {
        key: &value[begin..end],
        at,
        quoted: quote.is_some(),
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

fn environment_name(value: &str, field: Assignment<'_>) -> bool {
    let bytes = value.as_bytes();
    let quoted = is_quote(bytes.get(field.start));
    let start = field.start + usize::from(quoted);
    let mut end = start;
    while bytes.get(end).is_some_and(|c| identifier(*c)) {
        end += 1;
    }
    if end == start || !credential_key(&value[start..end]) {
        return false;
    }
    if quoted {
        bytes.get(end) == bytes.get(field.start)
    } else {
        value[end..].chars().next().is_none_or(|c| whitespace(c) || ",}]".contains(c))
    }
}

fn environment_value<'a>(value: &'a str, field: Assignment<'a>, flow: bool) -> Option<Assignment<'a>> {
    if field.delimiter != ":" {
        return None;
    }
    let name_first = field.key.eq_ignore_ascii_case("name");
    if !name_first && !field.key.eq_ignore_ascii_case("value") {
        return None;
    }
    if name_first && !environment_name(value, field) {
        return None;
    }
    let mut member = field;
    loop {
        let mode = if flow { ValueMode::Flow } else { ValueMode::Line };
        let end = value_end(value, member.start, mode);
        let next = sibling_assignment(value, field.at, end, flow)?;
        if next.start <= member.start || next.key.eq_ignore_ascii_case(field.key) {
            return None;
        }
        if name_first && next.key.eq_ignore_ascii_case("value") {
            return Some(next);
        }
        if !name_first && next.key.eq_ignore_ascii_case("name") {
            return environment_name(value, next).then_some(field);
        }
        member = next;
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
        .find_map(|(at, _)| assignment_at(user, at).filter(|field| credential_key(field.key)))
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

fn assignment_mask(value: &str, field: Assignment<'_>, flow: bool) -> Option<(Mask, usize)> {
    let Assignment { start, quoted, at, .. } = field;
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
    if start == end || setting_value(field.key, &value[start..end], yaml) {
        return None;
    }
    Some((value_mask(value, start, end, quoted), end))
}

fn l5_assignment_masks(value: &str) -> Vec<Mask> {
    let mut masks = Vec::new();
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
            let secret = field.filter(|field| {
                let mut paired_here = environment_values.remove(&i);
                // Continue inspecting the fields in between; they can be secrets too.
                if let Some(paired) = environment_value(value, *field, flow) {
                    if paired.at == i { paired_here = true; } else { environment_values.insert(paired.at); }
                }
                paired_here || credential_key(field.key)
            });
            if let Some((mask, end)) = secret.and_then(|field| assignment_mask(value, field, flow)) {
                masks.push(mask);
                i = end;
                continue;
            }
            if let Some(field) = field.filter(|field| field.quoted) {
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
                b'\'' | b'"' if flow => { quoted_through = quoted_end(value, i, true).0; }
                _ => {}
            }
        }
        let c = value[i..].chars().next().unwrap();
        i += c.len_utf8();
    }
    masks
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
    let assignments = l5_assignment_masks(&render_masks(value, &headers));
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

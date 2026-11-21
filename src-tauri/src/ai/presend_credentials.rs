//! The pre-send lane's defense in depth; never log the supplied values.
pub(super) const OMITTED: &str = "[credential omitted]";

fn whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}
fn ascii_at(value: &str, at: usize, needle: &str) -> bool {
    value
        .get(at..at + needle.len())
        .is_some_and(|s| s.eq_ignore_ascii_case(needle))
}
fn prefixes(value: &str, legacy: bool) -> String {
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
    let mut out = String::new();
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
            while let Some(&c) = value.as_bytes().get(end) {
                if if alnum_only {
                    c.is_ascii_uppercase() || c.is_ascii_digit()
                } else {
                    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')
                } {
                    end += 1;
                } else {
                    break;
                }
            }
            if end - start >= minimum && (!alnum_only || end - start == 16) {
                out.push_str(OMITTED);
                i = end;
                continue 'scan;
            }
        }
        let c = value[i..].chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
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
fn pem(value: &str) -> String {
    let mut out = String::new();
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
            out.push_str(OMITTED);
            i = end;
        } else {
            let c = value[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}
#[cfg(test)]
pub(super) fn legacy(value: &str) -> String {
    pem(&prefixes(value, true))
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
fn masked_value(
    value: &str,
    at: usize,
    stop_at_quote: bool,
    allowed: impl FnOnce(&str) -> bool,
) -> Option<(usize, String)> {
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
    let opening = quote.map(|c| c.to_string()).unwrap_or_default();
    let closing = if closed { opening.as_str() } else { "" };
    Some((
        end + usize::from(closed),
        format!("{opening}{OMITTED}{closing}"),
    ))
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
fn authorization_value(
    value: &str,
    at: usize,
    minimum: usize,
    allow_quoted_parameter: bool,
) -> Option<(usize, String)> {
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
    Some((end, format!("{}{OMITTED}", &value[at..start])))
}
fn authorization(value: &str) -> String {
    let mut out = String::new();
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
            if let Some((end, masked)) =
                authorization_value(value, start, if bearer { 16 } else { 1 }, allow_quoted_parameter)
            {
                out.push_str(&value[i..start]);
                out.push_str(&masked);
                i = end;
                continue;
            }
        }
        let c = value[i..].chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
}
fn identifier(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')
}
pub(super) const CREDENTIAL_KEYS: &[&str] = &[
    "password", "passwd", "pwd", "token", "secret", "apikey",
    "api_key", "access_key", "secret_key", "private_key",
    "pgpassword", "sig", "x-amz-signature", "sessionid",
];
fn credential_parts(key: &str) -> bool {
    let parts: Vec<_> = key.split(['_', '-']).collect();
    parts.iter().any(|part| CREDENTIAL_KEYS.contains(part))
        || parts.windows(2).any(|pair| {
            CREDENTIAL_KEYS.iter().any(|key| {
                key.split_once('_') == Some((pair[0], pair[1]))
            })
        })
}
fn credential_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    // Check the original boundaries before further splitting acronyms.
    CREDENTIAL_KEYS.contains(&lower.as_str())
        || credential_parts(&lower)
        || credential_key_with_boundaries(key, false)
        || lower == "dbpassword"
        || credential_key_with_boundaries(key, true)
}
fn credential_key_with_boundaries(key: &str, split_acronyms: bool) -> bool {
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
    credential_parts(&separated)
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

fn scheme_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'+' | b'.' | b'-')
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

fn assignments(value: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < value.len() {
        if identifier(value.as_bytes()[i]) && (i == 0 || !identifier(value.as_bytes()[i - 1])) {
            if let Some((start, end)) = url_password(value, i) {
                out.push_str(&value[i..start]);
                out.push_str(OMITTED);
                out.push('@');
                i = end + 1;
                continue;
            }
            let mut end = i;
            while value.as_bytes().get(end).is_some_and(|c| identifier(*c)) {
                end += 1;
            }
            let key = &value[i..end];
            if credential_key(key) {
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
                    if let Some((end, masked)) = masked_value(value, start, false, |body| {
                        !argument || !body.starts_with('-')
                    }) {
                        out.push_str(&value[i..start]);
                        out.push_str(&masked);
                        i = end;
                        continue;
                    }
                }
            }
            out.push_str(&value[i..end]);
            i = end;
            continue;
        }
        let c = value[i..].chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
}
pub(super) fn scrub(value: &str) -> String {
    assignments(&authorization(&prefixes(&pem(value), false)))
}

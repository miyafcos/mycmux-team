use kuchikiki::traits::TendrilSink;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

#[derive(Deserialize)]
struct UnicodeData {
    decomp: BTreeMap<u32, Vec<u32>>,
    classes: BTreeMap<u32, u8>,
    compose: BTreeMap<u64, u32>,
    fold: BTreeMap<u32, String>,
}
fn data() -> &'static UnicodeData {
    static DATA: OnceLock<UnicodeData> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(include_str!("export_unicode.json")).expect("bundled Unicode data"))
}
fn pair(a: u32, b: u32) -> Option<u32> {
    if (0x1100..0x1113).contains(&a) && (0x1161..0x1176).contains(&b) {
        return Some(0xAC00 + ((a - 0x1100) * 21 + b - 0x1161) * 28);
    }
    if (0xAC00..=0xD7A3).contains(&a) && (a - 0xAC00) % 28 == 0 && (0x11A8..0x11C3).contains(&b) {
        return Some(a + b - 0x11A7);
    }
    data().compose.get(&(a as u64 * 0x110000 + b as u64)).copied()
}
fn nfkc(text: &str) -> String {
    let d = data();
    let mut ordered = Vec::<u32>::new();
    for ch in text.chars() {
        let cp = ch as u32;
        let expanded = if (0xAC00..=0xD7A3).contains(&cp) {
            let s = cp - 0xAC00;
            let mut v = vec![0x1100 + s / 588, 0x1161 + (s % 588) / 28];
            if s % 28 != 0 { v.push(0x11A7 + s % 28); }
            v
        } else { d.decomp.get(&cp).cloned().unwrap_or_else(|| vec![cp]) };
        for n in expanded {
            let class = d.classes.get(&n).copied().unwrap_or(0);
            let mut at = ordered.len();
            if class != 0 {
                while at > 0 && d.classes.get(&ordered[at - 1]).copied().unwrap_or(0) > class { at -= 1; }
            }
            ordered.insert(at, n);
        }
    }
    let mut out = Vec::<u32>::new();
    let mut starter = None;
    let mut last_class = 0;
    for n in ordered {
        let class = d.classes.get(&n).copied().unwrap_or(0);
        let combined = starter.and_then(|at| pair(out[at], n).map(|cp| (at, cp)));
        if let Some((at, cp)) = combined.filter(|_| last_class == 0 || last_class < class) {
            out[at] = cp;
        } else {
            if class == 0 { starter = Some(out.len()); }
            out.push(n);
            last_class = class;
        }
    }
    out.into_iter().filter_map(char::from_u32).collect()
}
pub(super) fn normalized(text: &str) -> String {
    let first = nfkc(text);
    let folded: String = first.chars().map(|c| data().fold.get(&(c as u32)).cloned().unwrap_or_else(|| c.to_lowercase().collect())).collect();
    nfkc(&folded)
}
fn replace_home(text: &str, prefix: &str) -> String {
    if prefix.is_empty() { return text.into(); }
    let lower = text.to_ascii_lowercase();
    let key = prefix.trim_end_matches(['/', '\\']).to_ascii_lowercase();
    let mut out = String::new();
    let mut at = 0;
    while let Some(offset) = lower[at..].find(&key) {
        let start = at + offset;
        let end = start + key.len();
        out.push_str(&text[at..start]);
        if text[end..].starts_with(['/', '\\']) {
            out.push_str("~/");
            at = end + 1;
        } else if end == text.len() || text[end..].starts_with([' ', '<', '>', '"', '\'', ')', '\n']) {
            out.push('~');
            at = end;
        } else {
            out.push_str(&text[start..end]);
            at = end;
        }
    }
    out.push_str(&text[at..]);
    out
}
pub(super) fn relative(text: &str, home: &str) -> String {
    let mut value = text.to_owned();
    for prefix in [home.to_owned(), home.replace('\\', "/"), home.replace('\\', "\\\\")] {
        value = replace_home(&value, &prefix);
    }
    // Other operating-system homes are private too, even inside selected prose.
    for prefix in ["c:/users/", "c:\\users\\", "/users/"] {
        let mut at = 0;
        loop {
            let lower = value.to_ascii_lowercase();
            let Some(offset) = lower[at..].find(prefix) else { break };
            let start = at + offset;
            let user_at = start + prefix.len();
            let length = value[user_at..].find(['/', '\\', ' ', '"', '\'', '<', '>', ')', '\n']).unwrap_or(value.len() - user_at);
            let end = user_at + length;
            if end == user_at { at = end; continue; }
            value.replace_range(start..end, "~");
            at = start + 1;
        }
    }
    value
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct NameHit { pub kind: String, pub term: String, pub line: usize }
fn boundary(text: &str, term: &str) -> bool {
    text.match_indices(term).any(|(at, _)| {
        let identifier = |c: char| c.is_ascii_alphanumeric() || c == '_';
        !text[..at].chars().next_back().is_some_and(identifier)
            && !text[at + term.len()..].chars().next().is_some_and(identifier)
    })
}
fn builtins(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for token in text.split(|c: char| !(c.is_ascii_alphanumeric() || "._%+-@".contains(c))) {
        let token = token.trim_matches('.');
        if let Some((left, right)) = token.split_once('@') {
            if !left.is_empty() && right.rsplit_once('.').is_some_and(|(host, tld)| !host.is_empty() && tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic())) {
                out.push(("email".into(), token.into()));
            }
        }
    }
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !(chars[i].is_ascii_digit() || chars[i] == '+') || (i > 0 && chars[i - 1].is_ascii_alphanumeric()) { i += 1; continue; }
        let start = i;
        let mut end = i;
        let mut digits = 0;
        let mut valid_end = None;
        while end < chars.len() && end - start < 48 && (chars[end].is_ascii_digit() || "+-() ".contains(chars[end])) {
            if chars[end].is_ascii_digit() { digits += 1; }
            end += 1;
            if digits > 15 { break; }
            if !chars[end - 1].is_ascii_digit() || (end < chars.len() && chars[end].is_ascii_alphanumeric()) { continue; }
            let value: String = chars[start..end].iter().collect();
            let groups: Vec<_> = value.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).collect();
            let continuous = groups.len() == 1 && (10..=11).contains(&digits);
            let separated = groups.len() == 3 && groups.iter().all(|g| (2..=4).contains(&g.len())) && groups.last().is_some_and(|g| g.len() == 4) && (10..=11).contains(&digits);
            let international = value.starts_with('+') && (10..=15).contains(&digits);
            if international || continuous || separated { valid_end = Some(end); }
        }
        if let Some(end) = valid_end {
            out.push(("phone".into(), chars[start..end].iter().collect()));
            i = end;
        } else { i = end.max(i + 1); }
    }
    out
}
pub(super) fn scan(html: &str, names: &[String], users: &[String]) -> Vec<NameHit> {
    let names: Vec<_> = names.iter().map(|s| normalized(s.trim())).filter(|s| !s.is_empty()).collect();
    let users: Vec<_> = users.iter().map(|s| normalized(s)).filter(|s| !s.is_empty()).collect();
    let mut hits = BTreeSet::new();
    // Scan raw HTML AND decoded text/attributes so escaping cannot hide a name.
    // Cross-line matches are included, and line is in the generated HTML.
    let raw = normalized(html);
    let parsed = kuchikiki::parse_html().one(html).document_node;
    let mut decoded = parsed.text_contents();
    for node in parsed.descendants() {
        if let Some(element) = node.as_element() {
            for attribute in element.attributes.borrow().map.values() {
                decoded.push('\n'); decoded.push_str(&attribute.value);
            }
        }
    }
    let decoded = normalized(&decoded);
    for (kind, terms) in [("list", &names), ("osUser", &users)] {
        for term in terms {
            if [&raw, &decoded].iter().any(|text| if kind == "list" { text.contains(term) } else { boundary(text, term) }) {
                let line = html.lines().position(|row| {
                    let row = normalized(row);
                    let visible = normalized(&kuchikiki::parse_html().one(row.clone()).document_node.text_contents());
                    row.contains(term) || visible.contains(term)
                }).map(|n| n + 1).unwrap_or(1);
                hits.insert(NameHit { kind: kind.into(), term: term.clone(), line });
            }
        }
    }
    for (kind, term) in builtins(&raw).into_iter().chain(builtins(&decoded)) {
        let line = html.lines().position(|row| normalized(row).contains(&term)).map(|n| n + 1).unwrap_or(1);
        hits.insert(NameHit { kind, term, line });
    }
    hits.into_iter().collect()
}

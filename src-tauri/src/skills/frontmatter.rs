//! A bounded YAML subset for SKILL.md declarations. No new YAML dependency.
use serde_json::{Map, Value};

pub fn split(text: &str) -> (Value, &str) {
    let text = text.trim_start_matches('\u{feff}');
    if !text.starts_with("---\n") && !text.starts_with("---\r\n") {
        return (Value::Object(Map::new()), text);
    }
    let first = text.find('\n').unwrap() + 1;
    let mut offset = first;
    for line in text[first..].split_inclusive('\n') {
        if line.trim() == "---" {
            let block = &text[first..offset];
            let block = block
                .strip_suffix("\r\n")
                .or_else(|| block.strip_suffix('\n'))
                .unwrap_or(block);
            return (parse(block), &text[offset + line.len()..]);
        }
        offset += line.len();
    }
    (Value::Object(Map::new()), text)
}

pub fn parse(text: &str) -> Value {
    let lines: Vec<&str> = text.lines().collect();
    let mut index = 0;
    node(&lines, &mut index, 0, text.ends_with('\n'))
}

fn indent(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}
fn ignorable(line: &str) -> bool {
    line.trim().is_empty() || line.trim_start().starts_with('#')
}
fn next_content(lines: &[&str], mut at: usize) -> Option<usize> {
    while at < lines.len() {
        if !ignorable(lines[at]) {
            return Some(at);
        }
        at += 1;
    }
    None
}

fn node(lines: &[&str], index: &mut usize, depth: usize, terminal_break: bool) -> Value {
    if depth > 40 {
        *index = lines.len();
        return Value::Null;
    }
    let Some(start) = next_content(lines, *index) else {
        return Value::Null;
    };
    *index = start;
    let level = indent(lines[start]);
    let list = lines[start].trim_start().starts_with("- ");
    let mut array = Vec::new();
    let mut map = Map::new();
    while let Some(at) = next_content(lines, *index) {
        if indent(lines[at]) != level {
            break;
        }
        *index = at + 1;
        let line = lines[at].trim_start();
        if list {
            let Some(raw) = line.strip_prefix("- ") else {
                break;
            };
            array.push(value(lines, index, level, raw, depth, terminal_break));
        } else if let Some((key, raw)) = pair(line) {
            let key = scalar(key).as_str().unwrap_or(key).to_owned();
            map.insert(
                key,
                value(lines, index, level, raw.trim_start(), depth, terminal_break),
            );
        }
    }
    if list {
        Value::Array(array)
    } else {
        Value::Object(map)
    }
}

fn value(
    lines: &[&str],
    index: &mut usize,
    level: usize,
    raw: &str,
    depth: usize,
    terminal_break: bool,
) -> Value {
    if raw.is_empty() || raw.starts_with('#') {
        if let Some(next) = next_content(lines, *index) {
            if indent(lines[next]) > level {
                *index = next;
                return node(lines, index, depth + 1, terminal_break);
            }
        }
        return Value::Null;
    }
    if raw.starts_with('|') || raw.starts_with('>') {
        let folded = raw.starts_with('>');
        let start = *index;
        let mut end = start;
        while end < lines.len() && (lines[end].trim().is_empty() || indent(lines[end]) > level) {
            end += 1;
        }
        let margin = lines[start..end]
            .iter()
            .filter(|l| !l.trim().is_empty())
            .map(|l| indent(l))
            .min()
            .unwrap_or(level + 1);
        let mut out = String::new();
        for at in start..end {
            let current = lines[at].get(margin..).unwrap_or("");
            out.push_str(current);
            let next = lines
                .get(at + 1)
                .filter(|_| at + 1 < end)
                .and_then(|l| l.get(margin..))
                .unwrap_or("");
            if folded
                && !current.is_empty()
                && !next.is_empty()
                && !current.starts_with(' ')
                && !next.starts_with(' ')
            {
                out.push(' ');
            } else if at + 1 < lines.len() || terminal_break {
                out.push('\n');
            }
        }
        *index = end;
        if raw.contains('-') {
            out.truncate(out.trim_end_matches('\n').len());
        } else if !raw.contains('+') && out.ends_with('\n') {
            out.truncate(out.trim_end_matches('\n').len());
            out.push('\n');
        }
        return Value::String(out);
    }
    let mut full = raw.to_owned();
    while *index < lines.len() && !ignorable(lines[*index]) && indent(lines[*index]) > level {
        full.push(' ');
        full.push_str(lines[*index].trim());
        *index += 1;
    }
    scalar(&full)
}

fn pair(text: &str) -> Option<(&str, &str)> {
    let mut quote = '\0';
    let mut escaped = false;
    let mut nest = 0;
    for (at, ch) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quote == '"' && ch == '\\' {
            escaped = true;
            continue;
        }
        if quote != '\0' {
            if ch == quote {
                quote = '\0';
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = ch;
        } else if ch == '[' || ch == '{' {
            nest += 1;
        } else if ch == ']' || ch == '}' {
            nest -= 1;
        } else if ch == ':'
            && nest == 0
            && (at + 1 == text.len() || text[at + 1..].starts_with(char::is_whitespace))
        {
            return Some((&text[..at], &text[at + 1..]));
        }
    }
    None
}

fn parts(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut quote = '\0';
    let mut escaped = false;
    let mut nest = 0;
    for (at, ch) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quote == '"' && ch == '\\' {
            escaped = true;
            continue;
        }
        if quote != '\0' {
            if ch == quote {
                quote = '\0';
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = ch,
            '[' | '{' => nest += 1,
            ']' | '}' => nest -= 1,
            ',' if nest == 0 => {
                out.push(text[start..at].trim());
                start = at + 1;
            }
            _ => {}
        }
    }
    if !text[start..].trim().is_empty() {
        out.push(text[start..].trim());
    }
    out
}

fn quoted(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        let Some(next) = chars.next() else {
            out.push('\\');
            break;
        };
        match next {
            '0' => out.push('\0'),
            'a' => out.push('\u{7}'),
            'b' => out.push('\u{8}'),
            't' | '\t' => out.push('\t'),
            'n' => out.push('\n'),
            'v' => out.push('\u{b}'),
            'f' => out.push('\u{c}'),
            'r' => out.push('\r'),
            'e' => out.push('\u{1b}'),
            'N' => out.push('\u{85}'),
            '_' => out.push('\u{a0}'),
            'L' => out.push('\u{2028}'),
            'P' => out.push('\u{2029}'),
            'x' | 'u' | 'U' => {
                let width = if next == 'x' {
                    2
                } else if next == 'u' {
                    4
                } else {
                    8
                };
                let hex: String = chars.by_ref().take(width).collect();
                if let Ok(code) = u32::from_str_radix(&hex, 16) {
                    if let Some(ch) = char::from_u32(code) {
                        out.push(ch);
                    }
                }
            }
            other => out.push(other),
        }
    }
    out
}

pub fn scalar(text: &str) -> Value {
    let text = text.trim();
    if text.starts_with('"') && text.ends_with('"') && text.len() >= 2 {
        return Value::String(quoted(&text[1..text.len() - 1]));
    }
    if text.starts_with('\'') && text.ends_with('\'') && text.len() >= 2 {
        return Value::String(text[1..text.len() - 1].replace("''", "'"));
    }
    if text.starts_with('[') && text.ends_with(']') {
        return Value::Array(
            parts(&text[1..text.len() - 1])
                .into_iter()
                .map(scalar)
                .collect(),
        );
    }
    if text.starts_with('{') && text.ends_with('}') {
        return Value::Object(
            parts(&text[1..text.len() - 1])
                .into_iter()
                .filter_map(pair)
                .map(|(k, v)| (k.trim().trim_matches(['\'', '"']).to_owned(), scalar(v)))
                .collect(),
        );
    }
    let text = text.split(" #").next().unwrap_or(text).trim();
    match text.to_ascii_lowercase().as_str() {
        "null" | "~" | "" => Value::Null,
        "true" | "yes" | "on" => Value::Bool(true),
        "false" | "no" | "off" => Value::Bool(false),
        _ => serde_json::from_str::<Value>(text)
            .ok()
            .filter(|v| v.is_number())
            .unwrap_or_else(|| Value::String(text.to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_quotes_lists_and_blocks() {
        let result = parse("name: test\ndescription: >-\n  one\n  two\nmetadata:\n  triggers:\n    - \"hello\\nworld\"\n  pocket:\n    label: 'Tester''s skill'\nallowed-tools: [Read, Bash]\n");
        assert_eq!(result["description"], "one two");
        assert_eq!(result["metadata"]["triggers"][0], "hello\nworld");
        assert_eq!(result["metadata"]["pocket"]["label"], "Tester's skill");
        assert_eq!(result["allowed-tools"][1], "Bash");
    }
    #[test]
    fn literal_chomping_bom_and_crlf() {
        let (fm, body) = split(
            "\u{feff}---\r\nname: demo\r\ndescription: |\r\n  one\r\n  two\r\n---\r\n# Body\r\n",
        );
        assert_eq!(fm["description"], "one\ntwo");
        assert_eq!(
            parse("description: |\n  one\n  two\n")["description"],
            "one\ntwo\n"
        );
        assert!(body.starts_with("# Body"));
    }
}

use std::ops::Range;

use serde_json::{json, Value};
use toml_edit::{Document, Item, Table};

use super::{is_managed_group, Provider, GROK_BLOCK_END, GROK_BLOCK_START};

pub(super) struct GrokConfig {
    pub groups: Vec<(String, Value)>,
    removal: Vec<Range<usize>>,
}

fn unknown() -> String {
    "unsupported Grok hooks shape; settings were not changed".into()
}

// Work on parser-proven source ranges, never a re-serialization of owner tables.
fn table_range(table: &Table, source: &str) -> Result<Range<usize>, String> {
    if table.is_dotted() || table.is_implicit() {
        return Err(unknown());
    }
    let mut range = table.span().ok_or_else(unknown)?;
    for (_, item) in table.iter() {
        if let Some(value) = item.as_value() {
            range.end = range.end.max(value.span().ok_or_else(unknown)?.end);
        }
    }
    // Include indentation, the last line's comment, and following empty lines.
    range.start = source[..range.start].rfind('\n').map_or(0, |i| i + 1);
    range.end = source[range.end..]
        .find('\n')
        .map_or(source.len(), |i| range.end + i + 1);
    while range.end < source.len() {
        let end = source[range.end..]
            .find('\n')
            .map_or(source.len(), |i| range.end + i + 1);
        if !source[range.end..end].trim().is_empty() {
            break;
        }
        range.end = end;
    }
    Ok(range)
}

pub(super) fn parse(source: &str) -> Result<GrokConfig, String> {
    let document = Document::parse(source).map_err(|_| unknown())?;
    let mut result = GrokConfig {
        groups: Vec::new(),
        removal: Vec::new(),
    };
    if let Some(hooks) = document.get("hooks") {
        let hooks = hooks
            .as_table()
            .filter(|t| !t.is_dotted())
            .ok_or_else(unknown)?;
        for (event, item) in hooks.iter() {
            let groups = item.as_array_of_tables().ok_or_else(unknown)?;
            for group in groups {
                let group_range = table_range(group, source)?;
                if group
                    .iter()
                    .any(|(key, value)| key != "hooks" && !value.is_value())
                {
                    return Err(unknown());
                }
                let handlers = group
                    .get("hooks")
                    .and_then(Item::as_array_of_tables)
                    .ok_or_else(unknown)?;
                let mut values = Vec::new();
                let mut ranges = vec![group_range];
                for handler in handlers {
                    if handler.iter().any(|(_, value)| !value.is_value()) {
                        return Err(unknown());
                    }
                    ranges.push(table_range(handler, source)?);
                    values.push(json!({
                        "type": handler.get("type").and_then(Item::as_str),
                        "command": handler.get("command").and_then(Item::as_str),
                        "mycmux_managed": handler.get("mycmux_managed").and_then(Item::as_bool),
                    }));
                }
                let value = json!({"hooks": values});
                if is_managed_group(&value, Provider::Grok) {
                    result.removal.extend(ranges);
                }
                result.groups.push((event.to_string(), value));
            }
        }
    }
    // Only real comment lines outside TOML values may be legacy markers.
    let mut protected = Vec::new();
    fn values(item: &Item, protected: &mut Vec<Range<usize>>) {
        match item {
            Item::Value(value) => {
                if let Some(span) = value.span() {
                    protected.push(span);
                }
            }
            Item::Table(table) => {
                for (_, item) in table.iter() {
                    values(item, protected);
                }
            }
            Item::ArrayOfTables(tables) => {
                for table in tables {
                    for (_, item) in table.iter() {
                        values(item, protected);
                    }
                }
            }
            Item::None => {}
        }
    }
    values(document.as_item(), &mut protected);
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        if [GROK_BLOCK_START, GROK_BLOCK_END].contains(&line.trim())
            && !protected.iter().any(|span| span.contains(&offset))
        {
            result.removal.push(offset..offset + line.len());
        }
        offset += line.len();
    }
    result.removal.sort_by_key(|span| span.start);
    Ok(result)
}

impl GrokConfig {
    pub fn without_managed(&self, source: &str) -> String {
        let mut result = String::with_capacity(source.len());
        let mut cursor = 0;
        for span in &self.removal {
            if span.start > cursor {
                result.push_str(&source[cursor..span.start]);
            }
            cursor = cursor.max(span.end);
        }
        result.push_str(&source[cursor..]);
        result
    }
}

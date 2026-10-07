use super::{model::*, safe};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const MAX_LINES: u64 = 128;
const MAX_LINE: usize = 4 * 1024 * 1024;
const MAX_BYTES: u64 = 16 * 1024 * 1024;

fn string_at(text: &str, key: &str, occurrence: usize) -> Option<String> {
    let mark = format!("\"{key}\"");
    let offset = text.match_indices(&mark).nth(occurrence)?.0 + mark.len();
    let value = text[offset..].trim_start().strip_prefix(':')?.trim_start();
    if !value.starts_with('"') {
        return None;
    }
    let mut escaped = false;
    for (i, c) in value.char_indices().skip(1) {
        if c == '"' && !escaped {
            return serde_json::from_str(&value[..=i]).ok();
        }
        escaped = c == '\\' && !escaped;
    }
    None
}
// Only the first record's metadata prefix, before any instruction or message body.
pub(super) fn initial_header<R: BufRead>(reader: &mut R, codex: bool) -> Option<String> {
    let mut prefix = Vec::new();
    for _ in 0..8192 {
        let Some(byte) = reader.fill_buf().ok()?.first().copied() else {
            break;
        };
        reader.consume(1);
        prefix.push(byte);
        if byte == b'\n' {
            break;
        }
        if byte == b'"' {
            let text = std::str::from_utf8(&prefix).ok()?;
            if [
                "base_instructions",
                "message",
                "attachment",
                "content",
                "text",
                "snapshot",
            ]
            .iter()
            .any(|key| text.ends_with(&format!("\"{key}\"")))
            {
                break;
            }
            if codex && string_at(text, "type", 0).is_some_and(|kind| kind != "session_meta") {
                return None;
            }
        }
    }
    String::from_utf8(prefix).ok()
}
fn header(path: &Path, codex: bool) -> Option<String> {
    initial_header(
        &mut BufReader::with_capacity(1024, safe::open(path).ok()?),
        codex,
    )
}
fn timestamp(text: &str, codex: bool) -> Option<String> {
    let occurrences: &[usize] = if codex { &[1, 0] } else { &[0] };
    occurrences.iter().find_map(|n| {
        chrono::DateTime::parse_from_rfc3339(&string_at(text, "timestamp", *n)?)
            .ok()
            .map(|date| date.to_rfc3339())
    })
}
fn codex_filename_order(path: &Path) -> Option<chrono::NaiveDateTime> {
    let name = safe::basename(path);
    let date = name.strip_prefix("rollout-")?.get(..19)?;
    chrono::NaiveDateTime::parse_from_str(date, "%Y-%m-%dT%H-%M-%S").ok()
}
fn codex_filename_start(path: &Path) -> Option<String> {
    use chrono::TimeZone;
    chrono::Local
        .from_local_datetime(&codex_filename_order(path)?)
        .single()
        .map(|date| date.to_rfc3339())
}

fn started_at(path: &Path, codex: bool) -> Option<String> {
    header(path, codex)
        .and_then(|text| timestamp(&text, codex))
        .or_else(|| {
            if codex {
                codex_filename_start(path)
            } else {
                let created = std::fs::metadata(path).ok()?.created().ok()?;
                Some(chrono::DateTime::<chrono::Utc>::from(created).to_rfc3339())
            }
        })
}
fn rank(
    path: &Path,
    start: Option<&str>,
) -> (Option<chrono::DateTime<chrono::Utc>>, Option<u64>, PathBuf) {
    let modified = safe::modified(path);
    let primary = start
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|date| date.with_timezone(&chrono::Utc))
        .or_else(|| {
            modified
                .and_then(|value| i64::try_from(value).ok())
                .and_then(chrono::DateTime::from_timestamp_millis)
        });
    (primary, modified, path.to_owned())
}
pub fn meta_cwd(path: &Path) -> Option<String> {
    string_at(&header(path, true)?, "cwd", 0)
}
type StartTime = chrono::DateTime<chrono::Utc>;

fn parsed_start(value: &str) -> Option<StartTime> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&chrono::Utc))
}

fn claude_order_time(path: &Path) -> Option<StartTime> {
    let metadata = std::fs::metadata(path).ok()?;
    metadata
        .created()
        .or_else(|_| metadata.modified())
        .ok()
        .map(StartTime::from)
}

// Sort civil filename times without doing a timezone lookup for every file.
// Convert only the small prefix that is examined before the cutoff.
#[derive(Eq, PartialEq, Ord, PartialOrd)]
enum OrderTime {
    Local(chrono::NaiveDateTime),
    Utc(StartTime),
}
impl OrderTime {
    fn utc(&self) -> Option<StartTime> {
        use chrono::TimeZone;
        match self {
            Self::Local(time) => chrono::Local
                .from_local_datetime(time)
                .single()
                .map(|time| time.with_timezone(&chrono::Utc)),
            Self::Utc(time) => Some(*time),
        }
    }
}

// The cheap order is not the authoritative start time. Keep the one-hour
// overlap, including its boundary for start-time ties. An observed larger
// mismatch makes the remaining dated candidates unsafe to skip.
fn select_ordered(
    mut candidates: Vec<(Option<OrderTime>, PathBuf)>,
    codex: bool,
    cwd: &Path,
) -> Option<PathBuf> {
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let mut best: Option<((Option<StartTime>, Option<u64>, PathBuf), PathBuf)> = None;
    let mut order_unreliable = false;
    let mut dated_done = false;
    let overlap = chrono::Duration::hours(1);
    for (hint, path) in candidates {
        if hint.is_some() {
            if dated_done {
                continue;
            }
            if !order_unreliable
                && hint
                    .as_ref()
                    .and_then(OrderTime::utc)
                    .as_ref()
                    .zip(best.as_ref().and_then(|v| v.0 .0.as_ref()))
                    .is_some_and(|(hint, start)| *hint < *start - overlap)
            {
                dated_done = true;
                continue;
            }
        }
        // Undated names are always examined after dated names, even after
        // the dated scan stopped. Their header timestamp can still win.
        let hint = hint.as_ref().and_then(OrderTime::utc);
        let Some(text) = header(&path, codex) else {
            continue;
        };
        let start = timestamp(&text, codex).or_else(|| {
            if codex {
                codex_filename_start(&path)
            } else {
                std::fs::metadata(&path)
                    .ok()?
                    .created()
                    .ok()
                    .map(|created| StartTime::from(created).to_rfc3339())
            }
        });
        if let Some((hint, start)) = hint
            .as_ref()
            .zip(start.as_deref().and_then(parsed_start).as_ref())
        {
            let delta = start.signed_duration_since(*hint);
            if delta > overlap || delta < -overlap {
                order_unreliable = true;
            }
        }
        if codex {
            let Some(folder) = string_at(&text, "cwd", 0) else {
                continue;
            };
            if safe::normalized(Path::new(&folder)) != safe::normalized(cwd) {
                continue;
            }
        }
        let ranked = rank(&path, start.as_deref());
        if best.as_ref().is_none_or(|current| ranked > current.0) {
            best = Some((ranked, path));
        }
    }
    best.map(|(_, path)| path)
}

pub(super) fn select_latest(
    candidates: Vec<(Option<StartTime>, PathBuf)>,
    codex: bool,
    cwd: &Path,
) -> Option<PathBuf> {
    select_ordered(
        candidates
            .into_iter()
            .map(|(time, path)| (time.map(OrderTime::Utc), path))
            .collect(),
        codex,
        cwd,
    )
}

pub fn latest_codex(root: &Path, cwd: &Path) -> Option<PathBuf> {
    let candidates = safe::files(&root.join("sessions"), Some(&["jsonl"]))?
        .into_iter()
        .filter(|path| safe::basename(path).starts_with("rollout-"))
        .map(|path| {
            let time = codex_filename_order(&path).map(OrderTime::Local);
            (time, path)
        })
        .collect();
    select_ordered(candidates, true, cwd)
}

pub fn latest_claude(root: &Path, cwd: &Path) -> Option<PathBuf> {
    let candidates = safe::children(&root.join("projects").join(safe::project_key(cwd)))?
        .into_iter()
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .map(|path| (claude_order_time(&path), path))
        .collect();
    select_latest(candidates, false, cwd)
}

// Header-first bounded reading. A first request / assistant / world_state can be
// rejected before its text is deserialised. Only the selected initial attachments
// and the initial developer / user instruction records become JSON values.
fn next_record<R: BufRead>(
    reader: &mut R,
    codex: bool,
    session: &mut Session,
) -> Result<Option<Value>, String> {
    if session.lines_read >= MAX_LINES {
        session.stopped_at = "lineLimit".into();
        return Ok(None);
    }
    if session.bytes_consumed >= MAX_BYTES {
        session.stopped_at = "byteLimit".into();
        return Ok(None);
    }
    let mut data = Vec::new();
    let mut accept = false;
    let mut skip = false;
    loop {
        let buf = reader
            .fill_buf()
            .map_err(|_| "recordUnavailable".to_owned())?;
        if buf.is_empty() {
            session.stopped_at = "eof".into();
            if data.is_empty() {
                return Ok(None);
            }
            break;
        }
        let byte = buf[0];
        if codex && !accept && byte == b'"' {
            if let Ok(prefix) = std::str::from_utf8(&data) {
                let typ = string_at(prefix, "type", 0);
                if !matches!(typ.as_deref(), Some("session_meta" | "turn_context")) {
                    if let Some(pos) = prefix.rfind("\"text\"") {
                        let tail = prefix[pos + 6..].trim();
                        if tail == ":" {
                            let initial = buf.get(1..).unwrap_or_default();
                            let initial_user = typ.as_deref() == Some("response_item")
                                && string_at(prefix, "role", 0).as_deref() == Some("user");
                            if initial_user
                                && (initial.starts_with(b"# AGENTS.md instructions")
                                    || initial.starts_with(b"<environment_context>"))
                            {
                                accept = true;
                            } else {
                                // Unknown key order cannot prove an initial instruction.
                                // Stop before its text, even when an inner type was seen first.
                                session.stopped_at = "firstRequest".into();
                                return Ok(None);
                            }
                        }
                    }
                }
            }
        }
        reader.consume(1);
        data.push(byte);
        session.bytes_consumed += 1;
        if data.len() > MAX_LINE || session.bytes_consumed > MAX_BYTES {
            session.stopped_at = "byteLimit".into();
            return Ok(None);
        }
        if !accept && !skip {
            if let Ok(prefix) = std::str::from_utf8(&data) {
                let typ = string_at(prefix, "type", 0);
                if !codex {
                    match typ.as_deref() {
                        Some("assistant") => {
                            session.stopped_at = "firstAssistant".into();
                            return Ok(None);
                        }
                        Some("skill_listing" | "hook_success") => accept = true,
                        Some("attachment") => {
                            if let Some(sub) = string_at(prefix, "type", 1) {
                                accept = ["skill_listing", "hook_success"].contains(&sub.as_str());
                                skip = !accept;
                            }
                        }
                        Some(_) => skip = true,
                        None => {}
                    }
                } else {
                    match typ.as_deref() {
                        Some("world_state") => {
                            session.stopped_at = "worldState".into();
                            return Ok(None);
                        }
                        Some("session_meta" | "turn_context") => skip = true,
                        Some("event_msg") => {
                            if let Some(sub) = string_at(prefix, "type", 1) {
                                if ["task_started", "turn_started"].contains(&sub.as_str()) {
                                    skip = true;
                                } else {
                                    session.stopped_at = "firstRequest".into();
                                    return Ok(None);
                                }
                            }
                        }
                        Some("response_item") => {
                            if let Some(role) = string_at(prefix, "role", 0) {
                                if role == "developer" {
                                    accept = true;
                                } else if role == "user" {
                                    if let Some(pos) = prefix.find("\"text\"") {
                                        let v = prefix[pos + 6..].trim_start();
                                        if let Some(v) = v
                                            .strip_prefix(':')
                                            .map(str::trim_start)
                                            .and_then(|v| v.strip_prefix('"'))
                                        {
                                            if let Some(first) = v.chars().next() {
                                                if first != '#' && first != '<' {
                                                    session.stopped_at = "firstRequest".into();
                                                    return Ok(None);
                                                }
                                                // Match an instruction prefix before accepting the rest of the line.
                                                for allowed in [
                                                    "# AGENTS.md instructions",
                                                    "<environment_context>",
                                                ] {
                                                    if v.starts_with(allowed) {
                                                        accept = true;
                                                        break;
                                                    }
                                                }
                                                if !accept && v.len() > 30 {
                                                    session.stopped_at = "firstRequest".into();
                                                    return Ok(None);
                                                }
                                            }
                                        }
                                    }
                                } else {
                                    session.stopped_at = "firstAssistant".into();
                                    return Ok(None);
                                }
                            }
                        }
                        Some(_) => skip = true,
                        None => {}
                    }
                }
            }
        }
        if byte == b'\n' {
            break;
        }
    }
    session.lines_read += 1;
    if skip {
        return Ok(Some(Value::Null));
    }
    if !accept {
        session.stopped_at = "unsupported".into();
        return Ok(None);
    }
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(|_| "recordUnsupported".into())
}

pub fn claude(
    path: &Path,
    own: &BTreeSet<String>,
    synced: &BTreeSet<String>,
    commands: &BTreeSet<String>,
    usage: Option<&serde_json::Map<String, Value>>,
) -> Session {
    let mut session = Session {
        file: Some(safe::basename(path)),
        started_at: started_at(path, false),
        ..Default::default()
    };
    let Ok(file) = safe::open(path) else {
        session.stopped_at = "unavailable".into();
        return session;
    };
    let mut reader = BufReader::new(file);
    loop {
        let row = match next_record(&mut reader, false, &mut session) {
            Ok(Some(row)) => row,
            Ok(None) => break,
            Err(_) => {
                session.stopped_at = "unsupported".into();
                break;
            }
        };
        let a = &row["attachment"];
        if a["type"] == "skill_listing" && a["isInitial"] == true {
            let content = a["content"].as_str().unwrap_or("");
            let names: Vec<_> = a["names"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(safe::identifier)
                .collect();
            let mut starts: Vec<_> = names
                .iter()
                .filter_map(|name| content.find(&format!("- {name}:")).map(|pos| (pos, name)))
                .collect();
            starts.sort_by_key(|(pos, _)| *pos);
            let mut entries = Vec::new();
            for name in &names {
                let chars = starts
                    .iter()
                    .position(|(_, n)| *n == name)
                    .map(|i| {
                        let start = starts[i].0;
                        let end = starts.get(i + 1).map(|s| s.0).unwrap_or(content.len());
                        content[start..end].chars().count() as u64
                    })
                    .unwrap_or(0);
                let suffix = name.split_once(':').map(|(_, n)| n);
                let kind = if let Some(suffix) = suffix {
                    if synced.contains(suffix) {
                        "synced"
                    } else {
                        "plugin"
                    }
                } else if own.contains(name) {
                    "own"
                } else if commands.contains(name) {
                    "command"
                } else if synced.contains(name) {
                    "synced"
                } else {
                    "builtin"
                };
                entries.push(ListedSkill {
                    name: name.clone(),
                    chars,
                    kind: kind.into(),
                    plugin: if kind == "plugin" {
                        name.split(':').next().map(str::to_owned)
                    } else {
                        None
                    },
                    path: None,
                    usage_recorded: usage.map(|u| u.contains_key(name)),
                });
            }
            session.listing = finish_listing(
                a["skillCount"].as_u64().or(Some(names.len() as u64)),
                content.chars().count() as u64,
                entries,
            );
        } else if a["type"] == "hook_success" && a["hookEvent"] == "SessionStart" {
            let chars = a["content"]
                .as_str()
                .map(|s| s.chars().count() as u64)
                .unwrap_or(0);
            session.startup_chars = Some(session.startup_chars.unwrap_or(0) + chars);
            session.startup_hooks.push(Field::new(
                &safe::script_name(a["command"].as_str().unwrap_or("")),
                chars,
            ));
        }
    }
    session
}
fn finish_listing(count: Option<u64>, chars: u64, entries: Vec<ListedSkill>) -> Listing {
    let mut groups: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let mut plugins = BTreeMap::new();
    for e in &entries {
        let group = groups.entry(e.kind.clone()).or_default();
        group.0 += 1;
        group.1 += e.chars;
        if let Some(p) = &e.plugin {
            *plugins.entry(p.clone()).or_default() += 1;
        }
    }
    Listing {
        count,
        chars: Some(chars),
        entries,
        groups: groups
            .into_iter()
            .map(|(kind, (count, chars))| ListingGroup { kind, count, chars })
            .collect(),
        plugin_counts: plugins,
        ..Default::default()
    }
}
pub fn codex_listing(text: &str, flags: &BTreeMap<String, Vec<bool>>) -> Listing {
    let mut roots = BTreeMap::new();
    let mut entries = Vec::new();
    let mut positions = Vec::new();
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end();
        if trimmed.starts_with("- ") && trimmed.contains(" = ") {
            let backtick = char::from(96);
            let parts: Vec<_> = trimmed.split(backtick).collect();
            if parts.len() >= 4 && parts[1].starts_with('r') {
                roots.insert(parts[1].to_owned(), parts[3].replace('\\', "/"));
            }
        }
        if trimmed.starts_with("- ") && trimmed.contains("(file: ") {
            if let Some((head, location)) = trimmed.rsplit_once("(file: ") {
                if let Some(name_end) = head.find(": ") {
                    let name = head[2..name_end].to_owned();
                    let location = location.trim_end_matches(')').trim();
                    let (alias, rel) = location.split_once('/').unwrap_or(("", location));
                    let root = roots.get(alias).cloned().unwrap_or_default();
                    let kind = if root.ends_with("/.system") {
                        "system"
                    } else if root.ends_with("/.codex/skills") || root.ends_with("/.agents/skills")
                    {
                        "user"
                    } else if root.is_empty() {
                        "unknown"
                    } else {
                        "plugin"
                    };
                    let plugin = if kind == "plugin" {
                        name.split_once(':').map(|(p, _)| p.to_owned())
                    } else {
                        None
                    };
                    let path = if root.is_empty() {
                        None
                    } else {
                        Some(format!("{root}/{rel}"))
                    };
                    if safe::identifier(&name).is_some()
                        && path.as_deref().is_none_or(|p| !safe::private(Path::new(p)))
                    {
                        entries.push(ListedSkill {
                            name,
                            chars: 0,
                            kind: kind.into(),
                            plugin,
                            path,
                            usage_recorded: None,
                        });
                        positions.push(offset);
                    }
                }
            }
        }
        offset += line.len();
    }
    let end = text.find("</skills_instructions>").unwrap_or(text.len());
    for i in 0..entries.len() {
        let next = positions
            .get(i + 1)
            .copied()
            .unwrap_or(end)
            .max(positions[i]);
        entries[i].chars = text[positions[i]..next].chars().count() as u64;
    }
    let mut listing = finish_listing(
        Some(entries.len() as u64),
        text.chars().count() as u64,
        entries,
    );
    for (name, count) in &listing.plugin_counts {
        if flags
            .get(name)
            .is_some_and(|values| !values.iter().any(|v| *v))
        {
            listing.disabled_counts.insert(name.clone(), *count);
        }
    }
    listing.disabled_chars = Some(
        listing
            .entries
            .iter()
            .filter(|e| {
                e.plugin
                    .as_ref()
                    .is_some_and(|p| listing.disabled_counts.contains_key(p))
            })
            .map(|e| e.chars)
            .sum(),
    );
    listing
}
pub fn codex(path: &Path, flags: &BTreeMap<String, Vec<bool>>) -> Session {
    let mut session = Session {
        file: Some(safe::basename(path)),
        started_at: started_at(path, true),
        ..Default::default()
    };
    let Ok(file) = safe::open(path) else {
        session.stopped_at = "unavailable".into();
        return session;
    };
    let mut reader = BufReader::new(file);
    loop {
        let row = match next_record(&mut reader, true, &mut session) {
            Ok(Some(row)) => row,
            Ok(None) => break,
            Err(_) => {
                session.stopped_at = "unsupported".into();
                break;
            }
        };
        let p = &row["payload"];
        if row["type"] != "response_item" || p["type"] != "message" {
            continue;
        }
        for content in p["content"].as_array().into_iter().flatten() {
            let Some(text) = content["text"].as_str() else {
                continue;
            };
            let head = text.trim_start();
            let kind = if text.contains("<skills_instructions>") {
                session.listing = codex_listing(text, flags);
                "skills"
            } else if head.starts_with("# AGENTS.md instructions") {
                "instructions"
            } else if head.starts_with("## Memory")
                || head.starts_with("# Memory")
                || text.contains("<oai-memory")
            {
                "memory"
            } else if head.starts_with("<environment_context>") {
                "environment"
            } else if [
                "<permissions",
                "<collaboration_mode",
                "<recommended_plugins",
                "<multi_agent_role",
                "<multi_agent_mode",
            ]
            .iter()
            .any(|h| head.starts_with(h))
            {
                "product"
            } else {
                "otherProduct"
            };
            // No raw instruction, summary, header, request, or log text is returned.
            session.sections.push(Section {
                kind: kind.into(),
                chars: text.chars().count() as u64,
            });
        }
    }
    session
}

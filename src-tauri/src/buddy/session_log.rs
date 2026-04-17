use serde_json::Value;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const TAIL_WINDOW_BYTES: u64 = 2 * 1024 * 1024; // 2 MB tail window
const STALE_CUTOFF_MINUTES: u64 = 30;
const MAX_TURN_CHARS: usize = 300;

pub fn load_session_tail(session_id: &str, cwd: &str, max_turns: usize) -> String {
    if max_turns == 0 {
        return String::new();
    }

    let path = match resolve_session_path(session_id, cwd) {
        Some(p) => p,
        None => return String::new(),
    };

    if !is_recent_enough(&path) {
        return String::new();
    }

    let tail_text = match read_tail(&path, TAIL_WINDOW_BYTES) {
        Some(text) => text,
        None => return String::new(),
    };

    let turns = extract_turns(&tail_text, max_turns);
    format_turns(&turns)
}

fn resolve_session_path(session_id: &str, cwd: &str) -> Option<PathBuf> {
    // basic session_id hygiene — only UUID-ish characters allowed
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }

    let home = resolve_home()?;
    let project_dir_name = mangle_cwd(cwd);
    let path = home
        .join(".claude")
        .join("projects")
        .join(&project_dir_name)
        .join(format!("{session_id}.jsonl"));

    // path traversal guard: resolved path must stay under home
    if !path.starts_with(&home) {
        return None;
    }
    if !path.exists() {
        return None;
    }
    Some(path)
}

fn resolve_home() -> Option<PathBuf> {
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        return Some(PathBuf::from(user_profile));
    }
    if let Ok(home) = std::env::var("HOME") {
        return Some(PathBuf::from(home));
    }
    None
}

fn mangle_cwd(cwd: &str) -> String {
    // Normalize Git Bash /c/Users/... to C:\Users\... style first
    let normalized = if cwd.starts_with('/')
        && cwd.len() > 2
        && cwd.as_bytes().get(2) == Some(&b'/')
    {
        let drive = cwd[1..2].to_uppercase();
        let rest = cwd[2..].replace('/', "\\");
        format!("{drive}:{rest}")
    } else {
        cwd.to_string()
    };
    normalized
        .chars()
        .map(|c| match c {
            ':' | '\\' | '/' => '-',
            other => other,
        })
        .collect()
}

fn is_recent_enough(path: &Path) -> bool {
    let metadata = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    let mtime = match metadata.modified() {
        Ok(m) => m,
        Err(_) => return false,
    };
    let cutoff = SystemTime::now() - Duration::from_secs(STALE_CUTOFF_MINUTES * 60);
    mtime >= cutoff
}

fn read_tail(path: &Path, window_bytes: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let start = size.saturating_sub(window_bytes);
    file.seek(SeekFrom::Start(start)).ok()?;

    let mut buf = Vec::with_capacity(window_bytes.min(size) as usize);
    file.take(window_bytes).read_to_end(&mut buf).ok()?;

    let text = String::from_utf8_lossy(&buf).into_owned();

    // Drop the first (likely partial) line unless we started at byte 0
    if start > 0 {
        if let Some(idx) = text.find('\n') {
            return Some(text[idx + 1..].to_string());
        }
        return Some(String::new());
    }
    Some(text)
}

struct Turn {
    role: Role,
    text: String,
}

enum Role {
    User,
    Assistant,
}

fn extract_turns(raw_text: &str, max_turns: usize) -> Vec<Turn> {
    let lines: Vec<&str> = raw_text.lines().collect();
    let mut collected: Vec<Turn> = Vec::new();

    // Walk from bottom up, stop when we have enough
    for line in lines.iter().rev() {
        if line.trim().is_empty() {
            continue;
        }
        let value = match serde_json::from_str::<Value>(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let entry_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let turn = match entry_type {
            "user" => extract_user_turn(&value),
            "assistant" => extract_assistant_turn(&value),
            _ => None,
        };
        if let Some(turn) = turn {
            collected.push(turn);
            if collected.len() >= max_turns {
                break;
            }
        }
    }

    collected.reverse();
    collected
}

fn extract_user_turn(value: &Value) -> Option<Turn> {
    let content_node = value.get("message")?.get("content")?;
    let text = match content_node {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|item| {
                    let t = item.get("type").and_then(|v| v.as_str())?;
                    if t != "text" {
                        return None;
                    }
                    item.get("text").and_then(|v| v.as_str()).map(String::from)
                })
                .collect();
            if parts.is_empty() {
                return None;
            }
            parts.join("\n")
        }
        _ => return None,
    };
    let clean = sanitize_text(&text);
    if clean.is_empty() {
        return None;
    }
    Some(Turn {
        role: Role::User,
        text: clean,
    })
}

fn extract_assistant_turn(value: &Value) -> Option<Turn> {
    let content_node = value.get("message")?.get("content")?.as_array()?;
    let parts: Vec<String> = content_node
        .iter()
        .filter_map(|item| {
            let t = item.get("type").and_then(|v| v.as_str())?;
            if t != "text" {
                return None;
            }
            item.get("text").and_then(|v| v.as_str()).map(String::from)
        })
        .collect();
    if parts.is_empty() {
        return None;
    }
    let text = parts.join("\n");
    let clean = sanitize_text(&text);
    if clean.is_empty() {
        return None;
    }
    Some(Turn {
        role: Role::Assistant,
        text: clean,
    })
}

fn sanitize_text(raw: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in raw.lines() {
        if is_sensitive_line(line) {
            lines.push("[機密コマンド]".to_string());
        } else {
            lines.push(line.to_string());
        }
    }
    let joined = lines.join(" ");
    let collapsed: String = collapse_whitespace(&joined);
    truncate_chars(&collapsed, MAX_TURN_CHARS)
}

fn is_sensitive_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let trimmed = lower.trim_start();
    // Bare command invocations that typically carry secrets on the command line.
    let sensitive_prefixes = [
        "ssh ",
        "scp ",
        "sudo ",
        "su ",
        "gpg ",
        "aws ",
        "$ ssh ",
        "$ sudo ",
        "$ scp ",
    ];
    if sensitive_prefixes.iter().any(|p| trimmed.starts_with(p)) {
        return true;
    }
    // mysql -p or psql -W variants
    if trimmed.contains("mysql") && trimmed.contains(" -p") {
        return true;
    }
    if trimmed.contains("psql") && trimmed.contains(" -w") {
        return true;
    }
    // key / password assignment patterns
    let secret_keywords = ["password", "passwd", "api_key", "api-key", "apikey", "token", "credential", "secret"];
    if secret_keywords.iter().any(|k| lower.contains(k))
        && (lower.contains('=') || lower.contains(':'))
    {
        return true;
    }
    false
}

fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_was_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            out.push(ch);
            last_was_space = false;
        }
    }
    out.trim().to_string()
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= max_chars {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}

fn format_turns(turns: &[Turn]) -> String {
    if turns.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for turn in turns {
        let label = match turn.role {
            Role::User => "You",
            Role::Assistant => "Claude",
        };
        out.push_str(&format!("- [{label}] {}\n", turn.text));
    }
    out.trim_end().to_string()
}

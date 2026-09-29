//! Bounded, read-only title adapters. Transcripts are evidence, never instructions.
mod claude;
mod codex;

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

#[derive(Clone, Deserialize)]
pub struct TitleRequest {
    pub tab_id: String,
    pub agent_kind: String,
    pub agent_session_id: Option<String>,
    pub cwd: String,
}
#[derive(Clone, Default, Serialize)]
pub struct SessionTitles {
    pub tab_id: String,
    pub session_title: Option<String>,
    pub task_title: Option<String>,
}
#[derive(Clone, Copy, Serialize)]
pub struct TitleCapabilities {
    pub session_title: bool,
}
#[derive(Clone, Default)]
pub(super) struct Evidence {
    title: Option<String>,
    prompt: Option<String>,
}
struct Adapter {
    kind: &'static str,
    capabilities: TitleCapabilities,
    locate: fn(&TitleRequest) -> Option<PathBuf>,
    read: fn(&Path) -> Evidence,
}
const ADAPTERS: &[Adapter] = &[
    Adapter {
        kind: "claude",
        capabilities: TitleCapabilities {
            session_title: true,
        },
        locate: claude::locate,
        read: claude::read,
    },
    Adapter {
        kind: "claude-codex",
        capabilities: TitleCapabilities {
            session_title: true,
        },
        locate: claude::locate_codex_wrapper,
        read: claude::read,
    },
    Adapter {
        kind: "codex",
        capabilities: TitleCapabilities {
            session_title: false,
        },
        locate: codex::locate,
        read: codex::read,
    },
    Adapter {
        kind: "grok",
        capabilities: TitleCapabilities {
            session_title: false,
        },
        locate: |_| None,
        read: |_| Evidence::default(),
    },
];
pub fn capabilities(kind: &str) -> TitleCapabilities {
    ADAPTERS
        .iter()
        .find(|a| a.kind == kind)
        .map(|a| a.capabilities)
        .unwrap_or(TitleCapabilities {
            session_title: false,
        })
}
#[derive(Hash, Eq, PartialEq)]
struct FileKey {
    path: PathBuf,
    len: u64,
    mtime: SystemTime,
}
fn file_key(path: &Path) -> Option<FileKey> {
    let m = std::fs::metadata(path).ok()?;
    if !m.is_file() {
        return None;
    }
    Some(FileKey {
        path: path.into(),
        len: m.len(),
        mtime: m.modified().ok()?,
    })
}
static CACHE: OnceLock<Mutex<HashMap<FileKey, Evidence>>> = OnceLock::new();
static HEADINGS: OnceLock<Mutex<HashMap<FileKey, Option<String>>>> = OnceLock::new();
const CACHE_LIMIT: usize = 512;

pub(super) fn chunk(path: &Path, budget: u64, tail: bool) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    let start = if tail {
        file.metadata().ok()?.len().saturating_sub(budget)
    } else {
        0
    };
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(budget).read_to_end(&mut bytes).ok()?;
    // Parse complete JSON values only. A valid first line must not be discarded
    // when the bounded window happens to begin exactly at a record boundary.
    Some(bytes)
}
pub(super) fn records(bytes: &[u8]) -> impl Iterator<Item = serde_json::Value> + '_ {
    bytes
        .split(|b| *b == b'\n')
        .filter(|line| line.len() <= 1024 * 1024)
        .filter_map(|line| serde_json::from_slice(line).ok())
}
pub(super) fn message_text(value: &serde_json::Value) -> Option<String> {
    let content = value.get("content")?;
    let text = if let Some(s) = content.as_str() {
        s.to_owned()
    } else {
        content
            .as_array()?
            .iter()
            .filter_map(|c| c.get("text")?.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}
pub(super) fn valid_session(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn heading(path: &Path) -> Option<String> {
    let key = file_key(path)?;
    let cache = HEADINGS.get_or_init(Default::default);
    if let Some(value) = cache.lock().ok()?.get(&key).cloned() {
        return value;
    }
    let bytes = chunk(path, 256 * 1024, false)?;
    let text = String::from_utf8_lossy(&bytes);
    let result = text
        .trim_start_matches('\u{feff}')
        .lines()
        .find_map(|line| {
            let head = line.strip_prefix("# ")?.trim();
            let head = head.rsplit(" — ").next().unwrap_or(head);
            let head = if let Some(rest) = head
                .strip_prefix("作業依頼:")
                .or_else(|| head.strip_prefix("作業依頼："))
            {
                let rest = rest.trim();
                rest.split_once(char::is_whitespace)
                    .map(|(_, title)| title.trim_start_matches([' ', '-', '—', ':', '：']))
                    .unwrap_or("")
            } else {
                head
            };
            (!head.is_empty()).then(|| head.chars().take(4096).collect())
        });
    if let Ok(mut cache) = cache.lock() {
        if cache.len() >= CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(key, result.clone());
    }
    result
}
/// Absolute Markdown paths named in a prompt, in order. A path starts at a drive root (`C:\`,
/// `c:/`) or `/`, may contain spaces, and ends at the first `.md` that is followed by a closing
/// mark, whitespace or the end of the text. Quotes and line breaks end a path. `regex` is only a
/// transitive dependency of this crate, so the scan is written by hand.
fn markdown_paths(prompt: &str) -> Vec<&str> {
    // ponytail: a task file is named near the start of a prompt; scanning the first 8192
    // characters with at most 4 KiB per candidate keeps a pasted log from costing O(n^2).
    const MAX_PATH_BYTES: usize = 4096;
    let text = match prompt.char_indices().nth(8192) {
        Some((cut, _)) => &prompt[..cut],
        None => prompt,
    };
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let rest = &text[start..];
        let drive = rest.len() >= 3
            && bytes[start].is_ascii_alphabetic()
            && bytes[start + 1] == b':'
            && matches!(bytes[start + 2], b'/' | b'\\');
        if drive || bytes[start] == b'/' {
            let mut end = None;
            for (offset, ch) in rest.char_indices() {
                if offset > MAX_PATH_BYTES || matches!(ch, '\r' | '\n' | '"' | '\'' | '`') {
                    break;
                }
                let upto = offset + ch.len_utf8();
                let tail = &rest.as_bytes()[..upto];
                if upto >= 3 && tail[upto - 3..].eq_ignore_ascii_case(b".md") {
                    let closes = rest[upto..].chars().next().map_or(true, |next| {
                        next.is_whitespace()
                            || matches!(next, '"' | '\'' | '`' | ')' | ']' | '>' | ',' | ';' | '.')
                    });
                    if closes {
                        end = Some(upto);
                        break;
                    }
                }
            }
            if let Some(length) = end {
                found.push(rest[..length].trim());
                start += length;
                continue;
            }
        }
        start += rest.chars().next().map_or(1, char::len_utf8);
    }
    found
}
fn task_title(cwd: &str, prompt: Option<&str>) -> Option<String> {
    if let Some(prompt) = prompt {
        for candidate in markdown_paths(prompt) {
            if let Some(title) = heading(Path::new(candidate)) {
                return Some(title);
            }
        }
    }
    if cwd.trim().is_empty() {
        return None;
    }
    heading(&Path::new(cwd).join("spec.md"))
}
fn resolve(request: TitleRequest) -> SessionTitles {
    let mut evidence = Evidence::default();
    if let Some(adapter) = ADAPTERS.iter().find(|a| a.kind == request.agent_kind) {
        if let Some(path) = (adapter.locate)(&request) {
            if let Some(key) = file_key(&path) {
                let cache = CACHE.get_or_init(Default::default);
                let cached = cache.lock().ok().and_then(|c| c.get(&key).cloned());
                evidence = cached.unwrap_or_else(|| {
                    let value = (adapter.read)(&path);
                    if let Ok(mut cache) = cache.lock() {
                        if cache.len() >= CACHE_LIMIT {
                            cache.clear();
                        }
                        cache.insert(key, value.clone());
                    }
                    value
                });
            }
        }
        if !capabilities(&request.agent_kind).session_title {
            evidence.title = None;
        }
    }
    SessionTitles {
        tab_id: request.tab_id,
        session_title: evidence.title,
        task_title: task_title(&request.cwd, evidence.prompt.as_deref()),
    }
}

#[tauri::command]
pub async fn agent_session_titles(
    requests: Vec<TitleRequest>,
) -> Result<Vec<SessionTitles>, String> {
    if requests.len() > 64 {
        return Err("At most 64 title requests are allowed".into());
    }
    static LIMIT: OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let limit = LIMIT.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)));
    let mut tasks = Vec::new();
    for request in requests {
        let permit = limit
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Title reader closed")?;
        tasks.push(tokio::task::spawn_blocking(move || {
            let _permit = permit;
            resolve(request)
        }));
    }
    let mut results = Vec::new();
    for task in tasks {
        results.push(task.await.map_err(|_| "Title reader failed")?);
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn fixture(bytes: &[u8]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(bytes).unwrap();
        file
    }
    #[test]
    fn capabilities_are_explicit() {
        assert!(capabilities("claude-codex").session_title);
        assert!(!capabilities("codex").session_title);
        assert!(!capabilities("grok").session_title);
    }
    #[test]
    fn custom_title_wins_and_latest_of_each_kind_is_used() {
        let f = fixture(b"{\"type\":\"custom-title\",\"customTitle\":\"chosen\"}\n{\"type\":\"ai-title\",\"aiTitle\":\"later AI\"}\n");
        assert_eq!(claude::read(f.path()).title.as_deref(), Some("chosen"));
    }
    #[test]
    fn tail_is_bounded_and_head_is_fallback() {
        let mut bytes = b"{\"type\":\"ai-title\",\"aiTitle\":\"head\"}\n".to_vec();
        bytes.extend(vec![b' '; 3 * 1024 * 1024]);
        bytes.push(b'\n');
        let f = fixture(&bytes);
        assert!(chunk(f.path(), 2 * 1024 * 1024, true).unwrap().len() <= 2 * 1024 * 1024);
        assert_eq!(claude::read(f.path()).title.as_deref(), Some("head"));
        bytes.extend_from_slice(b"{\"type\":\"ai-title\",\"aiTitle\":\"tail\"}\n");
        let f = fixture(&bytes);
        assert_eq!(claude::read(f.path()).title.as_deref(), Some("tail"));
    }
    #[test]
    fn codex_skips_long_lines_and_instruction_blocks() {
        let mut bytes = vec![b'x'; 1024 * 1024 + 7];
        bytes.push(b'\n');
        for text in [
            "# AGENTS.md instructions",
            "<environment>",
            "Please read the task",
        ] {
            let v = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}});
            bytes.extend(serde_json::to_vec(&v).unwrap());
            bytes.push(b'\n');
        }
        let f = fixture(&bytes);
        let evidence = codex::read(f.path());
        assert_eq!(evidence.prompt.as_deref(), Some("Please read the task"));
        assert!(evidence.title.is_none());
    }
    #[test]
    fn heading_uses_last_separator_and_file_metadata_cache() {
        let mut f = fixture("# 作業依頼: lane — old — 見出し\n".as_bytes());
        assert_eq!(heading(f.path()).as_deref(), Some("見出し"));
        f.as_file_mut().set_len(0).unwrap();
        f.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
        f.write_all(b"# Changed title\n").unwrap();
        assert_eq!(heading(f.path()).as_deref(), Some("Changed title"));
        let prompt = format!("Read \"{}\"", f.path().display());
        // The suffix rule accepts only Markdown references.
        assert!(task_title("", Some(&prompt)).is_none());
    }
    #[test]
    fn absolute_markdown_with_spaces_precedes_cwd_and_reads_only_head() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("task notes.md");
        std::fs::write(&source, "# 作業依頼: lane 検査\n").unwrap();
        std::fs::write(dir.path().join("spec.md"), "# Fallback\n").unwrap();
        let prompt = format!("Read \"{}\" in full", source.display());
        assert_eq!(
            task_title(dir.path().to_str().unwrap(), Some(&prompt)).as_deref(),
            Some("検査")
        );
        let markdown_prompt = format!("Read [task]({})", source.display());
        assert_eq!(
            task_title("", Some(&markdown_prompt)).as_deref(),
            Some("検査")
        );
        assert_eq!(
            task_title(dir.path().to_str().unwrap(), None).as_deref(),
            Some("Fallback")
        );
        let mut large = vec![b'x'; 256 * 1024];
        large.extend_from_slice(b"\n# Outside budget\n");
        std::fs::write(&source, large).unwrap();
        assert!(heading(&source).is_none());
    }
    #[test]
    fn markdown_paths_are_found_without_regex() {
        let prompt = "Read C:/Users/a/spec.md in full. Also \"C:\\Users\\a\\task notes.md\" \
                      and [lane](c:/x/G6-PA.md), then /srv/plan.md. Ignore C:/x/notes.txt and and/or.";
        assert_eq!(
            markdown_paths(prompt),
            vec![
                "C:/Users/a/spec.md",
                "C:\\Users\\a\\task notes.md",
                "c:/x/G6-PA.md",
                "/srv/plan.md",
            ]
        );
        assert!(markdown_paths("no paths here, not even C:/x/readme.mdx").is_empty());
        assert_eq!(
            markdown_paths("日本語の前置き C:/作業/依頼書.md を読む"),
            vec!["C:/作業/依頼書.md"]
        );
    }
    #[test]
    fn codex_prompt_outside_four_megabytes_is_not_read() {
        let mut bytes = vec![b'x'; 4 * 1024 * 1024];
        bytes.push(b'\n');
        bytes.extend_from_slice(
            br#"{"type":"response_item","payload":{"role":"user","content":"Too late"}}"#,
        );
        assert!(codex::read(fixture(&bytes).path()).prompt.is_none());
    }
    #[test]
    fn tail_window_keeps_a_complete_first_record() {
        let line = b"{\"type\":\"custom-title\",\"customTitle\":\"boundary\"}\n";
        let mut bytes = b"padding\n".to_vec();
        bytes.extend_from_slice(line);
        bytes.extend(vec![b' '; 2 * 1024 * 1024 - line.len()]);
        let f = fixture(&bytes);
        assert_eq!(claude::read(f.path()).title.as_deref(), Some("boundary"));
    }
    #[test]
    fn claude_skips_metadata_and_markup_before_the_first_prompt() {
        let f = fixture(
            br#"{"type":"system"}
{"type":"user","message":{"content":"<environment>"}}
{"type":"user","message":{"content":[{"type":"text","text":"Read task"}]}}
{"type":"custom-title","customTitle":"old"}
{"type":"custom-title","customTitle":"new"}
{"type":"ai-title","aiTitle":"later"}
"#,
        );
        let evidence = claude::read(f.path());
        assert_eq!(evidence.prompt.as_deref(), Some("Read task"));
        assert_eq!(evidence.title.as_deref(), Some("new"));
    }
    #[tokio::test]
    async fn batch_limit() {
        let requests = vec![
            TitleRequest {
                tab_id: "t".into(),
                agent_kind: "none".into(),
                agent_session_id: None,
                cwd: String::new()
            };
            65
        ];
        assert!(agent_session_titles(requests).await.is_err());
    }
}

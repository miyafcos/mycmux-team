//! Explicit report delivery. No filesystem watcher and no execution of report content.
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

const MAX_INBOX_BYTES: u64 = 2 * 1024 * 1024;
const RECENT_LIMIT: usize = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    pub from: String,
    pub title: String,
    /// Always relative to the inbox, never an OS path.
    pub path: String,
    pub received_at: u64,
}

fn safe_sender(value: &str) -> bool {
    let reserved = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
        "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-' || ch == b'_')
        && !reserved.contains(&value.to_ascii_lowercase().as_str())
}

fn valid_title(title: &str) -> bool {
    !title.trim().is_empty() && title.chars().count() <= 256 && !title.chars().any(char::is_control)
}

fn checked_node(path: &Path, directory: bool) -> Result<fs::Metadata, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "inbox path is unavailable".to_string())?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if metadata.file_type().is_symlink() || reparse {
        return Err("inbox paths must not contain symlinks, junctions or reparse points".into());
    }
    if directory && !metadata.is_dir() {
        return Err("inbox parent must be a directory".into());
    }
    Ok(metadata)
}

fn checked_file(runtime: &Path, relative: &str) -> Result<(PathBuf, fs::Metadata), String> {
    // One portable spelling also excludes Windows drive letters, ADS and UNC on Unix hosts.
    let parts: Vec<_> = relative.split('/').collect();
    if parts.len() != 2
        || !safe_sender(parts[0])
        || parts[1].is_empty()
        || parts[1] == "."
        || parts[1] == ".."
        || parts[1].ends_with('.')
        || parts[1].ends_with(' ')
        || relative.contains('\\')
        || relative.contains(':')
        || relative.chars().any(char::is_control)
    {
        return Err(
            "inbox path must be a relative sender/file path without traversal or UNC".into(),
        );
    }
    let file_name = parts[1];
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "md" && extension != "txt" {
        return Err("inbox accepts only .md and .txt files".into());
    }
    checked_node(runtime, true)?;
    let root = runtime.join("inbox");
    checked_node(&root, true)?;
    let sender = root.join(parts[0]);
    checked_node(&sender, true)?;
    let path = sender.join(file_name);
    let metadata = checked_node(&path, false)?;
    if !metadata.is_file() {
        return Err("inbox target must be a regular file".into());
    }
    if metadata.len() > MAX_INBOX_BYTES {
        return Err("inbox file exceeds 2MB".into());
    }
    let root = fs::canonicalize(&root).map_err(|_| "inbox root is unavailable".to_string())?;
    let canonical = fs::canonicalize(&path).map_err(|_| "inbox file is unavailable".to_string())?;
    if !canonical.starts_with(&root) {
        return Err("inbox path is outside the inbox".into());
    }
    Ok((canonical, metadata))
}

fn entry_at(
    runtime: &Path,
    from: String,
    title: String,
    path: String,
) -> Result<InboxEntry, String> {
    if !safe_sender(&from) {
        return Err("inbox sender is invalid".into());
    }
    if !valid_title(&title) {
        return Err("inbox title must be 1-256 characters without controls".into());
    }
    if path.split('/').next() != Some(from.as_str()) {
        return Err("inbox path does not match its sender".into());
    }
    let (_, metadata) = checked_file(runtime, &path)?;
    let received_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis() as u64)
        .unwrap_or(0);
    Ok(InboxEntry {
        from,
        title: title.trim().to_string(),
        path,
        received_at,
    })
}

#[tauri::command]
pub async fn inbox_post(from: String, title: String, path: String) -> Result<InboxEntry, String> {
    crate::util::task::run_blocking("inbox_post", move || {
        entry_at(&crate::test_profile::runtime_dir()?, from, title, path)
    })
    .await
}

fn recent_at(runtime: &Path) -> Result<Vec<InboxEntry>, String> {
    let root = runtime.join("inbox");
    if !root
        .try_exists()
        .map_err(|_| "cannot inspect inbox".to_string())?
    {
        return Ok(Vec::new());
    }
    checked_node(runtime, true)?;
    checked_node(&root, true)?;
    let mut recent = Vec::new();
    for sender in fs::read_dir(&root).map_err(|_| "cannot list inbox".to_string())? {
        let sender = sender.map_err(|_| "cannot list inbox sender".to_string())?;
        let from = sender.file_name().to_string_lossy().into_owned();
        if !safe_sender(&from) || checked_node(&sender.path(), true).is_err() {
            continue;
        }
        let files =
            fs::read_dir(sender.path()).map_err(|_| "cannot list inbox files".to_string())?;
        for file in files {
            let file = file.map_err(|_| "cannot list inbox file".to_string())?;
            let name = file.file_name().to_string_lossy().into_owned();
            let title = Path::new(&name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(&name);
            let title = title
                .split_once('_')
                .map(|(_, title)| title)
                .unwrap_or(title)
                .replace('_', " ");
            if let Ok(entry) = entry_at(runtime, from.clone(), title, format!("{from}/{name}")) {
                recent.push(entry);
                recent.sort_by(|a, b| {
                    b.received_at
                        .cmp(&a.received_at)
                        .then_with(|| b.path.cmp(&a.path))
                });
                recent.truncate(RECENT_LIMIT);
            }
        }
    }
    Ok(recent)
}

#[tauri::command]
pub async fn inbox_recent() -> Result<Vec<InboxEntry>, String> {
    crate::util::task::run_blocking("inbox_recent", move || {
        recent_at(&crate::test_profile::runtime_dir()?)
    })
    .await
}

/// Revalidate on every explicit open, including entries retained after a notification expires.
#[tauri::command]
pub async fn inbox_preview(
    session_id: String,
    path: String,
) -> Result<super::artifact::PreviewArtifactInfo, String> {
    crate::util::task::run_blocking("inbox_preview", move || {
        let (path, _) = checked_file(&crate::test_profile::runtime_dir()?, &path)?;
        // This is a checked OS path, not a scraped URI. Do not percent-decode or repair it.
        super::artifact::preview_info_for_artifact(&session_id, &path, true)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let runtime = tempfile::tempdir().unwrap();
        fs::create_dir_all(runtime.path().join("inbox/grokbot")).unwrap();
        fs::write(runtime.path().join("inbox/grokbot/report.md"), "# Report").unwrap();
        runtime
    }

    #[test]
    fn accepts_only_an_existing_inbox_document_and_matching_sender() {
        let runtime = fixture();
        let entry = entry_at(
            runtime.path(),
            "grokbot".into(),
            "Report".into(),
            "grokbot/report.md".into(),
        )
        .unwrap();
        assert_eq!(entry.path, "grokbot/report.md");
        assert!(entry.received_at > 0);
        assert!(entry_at(runtime.path(), "dot".into(), "Report".into(), entry.path).is_err());
        fs::write(runtime.path().join("inbox/grokbot/report.txt"), "text").unwrap();
        assert!(checked_file(runtime.path(), "grokbot/report.txt").is_ok());
    }

    #[test]
    fn refuses_absolute_unc_traversal_alternate_streams_and_bad_extensions() {
        let runtime = fixture();
        for path in [
            "../outside.md",
            "grokbot/../outside.md",
            "/tmp/outside.md",
            "C:/outside.md",
            "//server/share/note.md",
            r"\\server\share\note.md",
            r"grokbot\report.md",
            "grokbot/report.md:stream",
            "grokbot/report.html",
            "grokbot/report.md/",
            "grokbot/report.md.",
            "./grokbot/report.md",
            "grokbot/./report.md",
        ] {
            assert!(checked_file(runtime.path(), path).is_err(), "{path}");
        }
    }

    #[test]
    fn enforces_two_mb_and_regular_files() {
        let runtime = fixture();
        let file = fs::File::create(runtime.path().join("inbox/grokbot/large.md")).unwrap();
        file.set_len(MAX_INBOX_BYTES).unwrap();
        assert!(checked_file(runtime.path(), "grokbot/large.md").is_ok());
        file.set_len(MAX_INBOX_BYTES + 1).unwrap();
        assert!(checked_file(runtime.path(), "grokbot/large.md").is_err());
        fs::create_dir(runtime.path().join("inbox/grokbot/directory.md")).unwrap();
        assert!(checked_file(runtime.path(), "grokbot/directory.md").is_err());
    }

    #[test]
    fn rejects_unsafe_senders_and_invalid_titles() {
        let runtime = fixture();
        for from in ["..", "/tmp", "CON", "a/b", "x:stream", ""] {
            assert!(entry_at(
                runtime.path(),
                from.into(),
                "Report".into(),
                "grokbot/report.md".into()
            )
            .is_err());
        }
        for title in ["", "   ", "line\nbreak", "\u{7f}"] {
            assert!(entry_at(
                runtime.path(),
                "grokbot".into(),
                title.into(),
                "grokbot/report.md".into()
            )
            .is_err());
        }
        assert!(!valid_title(&"x".repeat(257)));
    }

    #[test]
    fn lists_twenty_latest_valid_files_and_ignores_partial_copies() {
        let runtime = fixture();
        for i in 0..25 {
            fs::write(
                runtime
                    .path()
                    .join(format!("inbox/grokbot/{i:02}_report.md")),
                "text",
            )
            .unwrap();
        }
        fs::write(
            runtime.path().join("inbox/grokbot/.incomplete.md.partial"),
            "partial",
        )
        .unwrap();
        fs::write(runtime.path().join("inbox/grokbot/evil.html"), "<script>").unwrap();
        let recent = recent_at(runtime.path()).unwrap();
        assert_eq!(recent.len(), 20);
        assert!(recent.iter().all(|entry| entry.path.ends_with(".md")));
        assert!(recent
            .windows(2)
            .all(|pair| pair[0].received_at >= pair[1].received_at));
        let missing = tempfile::tempdir().unwrap();
        assert!(recent_at(missing.path()).unwrap().is_empty());
    }

    #[test]
    fn includes_completed_hidden_documents_but_not_partial_copies() {
        let runtime = fixture();
        fs::write(runtime.path().join("inbox/grokbot/.hidden.md"), "complete").unwrap();
        fs::write(
            runtime.path().join("inbox/grokbot/.draft.md.partial"),
            "partial",
        )
        .unwrap();
        let recent = recent_at(runtime.path()).unwrap();
        assert_eq!(recent.len(), 2);
        assert!(recent
            .iter()
            .any(|entry| entry.path == "grokbot/.hidden.md"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_files_sender_folders_and_inbox_roots() {
        use std::os::unix::fs::symlink;
        let runtime = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("note.md"), "outside").unwrap();
        symlink(
            outside.path().join("note.md"),
            runtime.path().join("inbox/grokbot/link.md"),
        )
        .unwrap();
        symlink(outside.path(), runtime.path().join("inbox/dot")).unwrap();
        assert!(checked_file(runtime.path(), "grokbot/link.md").is_err());
        assert!(checked_file(runtime.path(), "dot/note.md").is_err());
        let other = tempfile::tempdir().unwrap();
        symlink(runtime.path().join("inbox"), other.path().join("inbox")).unwrap();
        assert!(checked_file(other.path(), "grokbot/report.md").is_err());
        assert!(recent_at(other.path()).is_err());
        assert!(recent_at(runtime.path())
            .unwrap()
            .iter()
            .all(|entry| !entry.path.contains("link")));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_junctions() {
        let runtime = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("note.md"), "outside").unwrap();
        let junction = runtime.path().join("inbox/dot");
        assert!(std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(outside.path())
            .output()
            .unwrap()
            .status
            .success());
        assert!(checked_file(runtime.path(), "dot/note.md").is_err());
    }
}

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Read pane-session mapping files written by launcher.sh
/// Returns a map of pane_session_id → claude_session_id
#[derive(Clone, serde::Serialize)]
pub struct AgentSessionMapping {
    pub agent_kind: Option<String>,
    pub session_id: String,
}

pub(crate) fn is_agent_session_kind(value: &str) -> bool {
    matches!(value, "claude" | "codex" | "claude-codex" | "grok")
}

/// Fail closed: only `<known kind>:<id>` counts as a mapping.
///
/// The old fallback treated any unrecognised line as a bare session id, so a
/// junk line such as `claude-handoff:pty-…` came back as a session id with no
/// kind. The frontend then defaulted it to "claude" and persisted the whole
/// string, and restore later failed to validate it and downgraded to
/// `claude --continue`, adopting another tab's conversation in the same cwd.
/// Every writer emits `<kind>:<id>`, so nothing legitimate needs the fallback.
fn parse_agent_session_mapping(contents: &str) -> Option<AgentSessionMapping> {
    let trimmed = contents.trim_start_matches('\u{feff}').trim();
    let (kind, session_id) = trimmed.split_once(':')?;
    let kind = kind.trim();
    let session_id = session_id.trim();
    if !is_agent_session_kind(kind) || session_id.is_empty() {
        return None;
    }
    Some(AgentSessionMapping {
        agent_kind: Some(kind.to_string()),
        session_id: session_id.to_string(),
    })
}

fn session_mapping_dir() -> Option<PathBuf> {
    crate::test_profile::runtime_dir()
        .ok()
        .map(|runtime_dir| runtime_dir.join("pane-sessions"))
}

fn is_safe_mapping_id(session_id: &str) -> bool {
    if session_id.is_empty()
        || session_id.len() > 240
        || session_id != session_id.trim()
        || matches!(session_id, "." | "..")
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return false;
    }
    let stem = session_id
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(stem.as_str(), "." | ".." | "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// A mapping follows the tab through workspace and pane moves. Older
/// `pty-<workspace>-<pane>-<tab>` identifiers are migration inputs only.
fn stable_tab_id_from_legacy_session_id(session_id: &str) -> Option<&str> {
    let tab_id_start = session_id.len().checked_sub(36)?;
    let tab_id = session_id.get(tab_id_start..)?;
    (session_id.starts_with("pty-")
        && tab_id_start > 0
        && session_id.as_bytes().get(tab_id_start - 1) == Some(&b'-')
        && crate::util::ids::is_uuid_like(tab_id))
    .then_some(tab_id)
}

fn mapping_storage_id(session_id: &str) -> &str {
    stable_tab_id_from_legacy_session_id(session_id).unwrap_or(session_id)
}

fn unique_legacy_mapping_path(map_dir: &Path, tab_id: &str) -> Option<PathBuf> {
    let suffix = format!("-{tab_id}.txt");
    let candidates = std::fs::read_dir(map_dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_type().ok()?.is_file().then_some(entry))
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("pty-") && name.ends_with(&suffix)
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    (candidates.len() == 1).then(|| candidates.into_iter().next()).flatten()
}

fn read_valid_mapping(path: &Path) -> Option<AgentSessionMapping> {
    parse_agent_session_mapping(&std::fs::read_to_string(path).ok()?)
}

fn read_session_mapping_files_for_ids<I, S>(
    map_dir: &Path,
    session_ids: I,
) -> HashMap<String, AgentSessionMapping>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut mappings = HashMap::new();
    for session_id in session_ids {
        let session_id = session_id.as_ref();
        if !is_safe_mapping_id(session_id) || mappings.contains_key(session_id) {
            continue;
        }
        let storage_id = mapping_storage_id(session_id);
        let path = map_dir.join(format!("{storage_id}.txt"));
        if path.exists() {
            if let Some(mapping) = read_valid_mapping(&path) {
                mappings.insert(session_id.to_string(), mapping);
            }
            continue;
        }
        let Some(tab_id) = stable_tab_id_from_legacy_session_id(session_id)
            .or_else(|| crate::util::ids::is_uuid_like(session_id).then_some(session_id))
        else {
            continue;
        };
        let Some(legacy_path) = unique_legacy_mapping_path(map_dir, tab_id) else {
            continue;
        };
        let Some(mapping) = read_valid_mapping(&legacy_path) else {
            continue;
        };
        if std::fs::rename(&legacy_path, &path).is_ok() {
            mappings.insert(session_id.to_string(), mapping);
        }
    }
    mappings
}

pub(crate) fn agent_mappings_for_ids<I, S>(session_ids: I) -> HashMap<String, AgentSessionMapping>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let Some(map_dir) = session_mapping_dir() else {
        return HashMap::new();
    };
    read_session_mapping_files_for_ids(&map_dir, session_ids)
}

fn unique_mapping_tmp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("mapping.txt");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    path.with_file_name(format!(
        "{file_name}.tmp-{}-{timestamp}",
        std::process::id()
    ))
}

fn write_text_file_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create mapping dir {}: {error}", parent.display()))?;
    }
    let tmp_path = unique_mapping_tmp_path(path);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|error| format!("create mapping tmp {}: {error}", tmp_path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("write mapping tmp {}: {error}", tmp_path.display()))?;
    file.sync_all()
        .map_err(|error| format!("flush mapping tmp {}: {error}", tmp_path.display()))?;
    drop(file);
    std::fs::rename(&tmp_path, path)
        .inspect_err(|_error| {
            let _ = std::fs::remove_file(&tmp_path);
        })
        .map_err(|error| {
            format!(
                "replace mapping {} with {}: {error}",
                path.display(),
                tmp_path.display()
            )
        })
}

fn write_session_mapping_file_to_dir(
    map_dir: &Path,
    session_id: &str,
    agent_kind: &str,
    agent_session_id: &str,
) -> Result<(), String> {
    if !is_safe_mapping_id(session_id)
        || agent_kind.trim().is_empty()
        || agent_session_id.trim().is_empty()
        || !is_agent_session_kind(agent_kind)
    {
        return Ok(());
    }
    let path = map_dir.join(format!("{}.txt", mapping_storage_id(session_id)));
    write_text_file_atomic(&path, &format!("{agent_kind}:{agent_session_id}\n"))?;
    Ok(())
}

pub(crate) fn write_session_mapping_file(
    session_id: &str,
    agent_kind: &str,
    agent_session_id: &str,
) -> Result<(), String> {
    let Some(map_dir) = session_mapping_dir() else {
        return Ok(());
    };
    write_session_mapping_file_to_dir(&map_dir, session_id, agent_kind, agent_session_id)
}

fn remove_session_mapping_file_from_dir(map_dir: &Path, session_id: &str) -> Result<(), String> {
    if !is_safe_mapping_id(session_id) {
        return Ok(());
    }
    let path = map_dir.join(format!("{}.txt", mapping_storage_id(session_id)));
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("remove mapping {}: {error}", path.display())),
    }
    Ok(())
}

pub(crate) fn remove_session_mapping_file(session_id: &str) -> Result<(), String> {
    let Some(map_dir) = session_mapping_dir() else {
        return Ok(());
    };
    remove_session_mapping_file_from_dir(&map_dir, session_id)
}

#[tauri::command(async)]
pub fn read_agent_session_mappings(
    session_ids: Vec<String>,
) -> HashMap<String, AgentSessionMapping> {
    agent_mappings_for_ids(session_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_agent_session_mapping_with_kind() {
        let mapping = parse_agent_session_mapping("claude:abc-123\n").unwrap();
        assert_eq!(mapping.agent_kind.as_deref(), Some("claude"));
        assert_eq!(mapping.session_id, "abc-123");
    }

    #[test]
    fn parse_agent_session_mapping_with_bom_prefixed_kind() {
        let mapping = parse_agent_session_mapping("\u{feff}claude:abc-123\n").unwrap();
        assert_eq!(mapping.agent_kind.as_deref(), Some("claude"));
        assert_eq!(mapping.session_id, "abc-123");
    }

    #[test]
    fn parse_agent_session_mapping_accepts_every_known_kind() {
        for kind in ["claude", "codex", "claude-codex", "grok"] {
            let mapping = parse_agent_session_mapping(&format!("{kind}:abc-123\n")).unwrap();
            assert_eq!(mapping.agent_kind.as_deref(), Some(kind));
            assert_eq!(mapping.session_id, "abc-123");
        }
    }

    #[test]
    fn parse_agent_session_mapping_rejects_handoff_kinds() {
        // Junk written by the pre-fix handoff branches: the source pane id, not
        // an agent session id. Adopting it downgraded restore to `--continue`.
        for line in [
            "claude-handoff:pty-0d0aaee6-6932d3e6-561f2273\n",
            "codex-handoff:pty-0d0aaee6-6932d3e6-561f2273\n",
            "claude-codex-handoff:pty-0d0aaee6-6932d3e6-561f2273\n",
        ] {
            assert!(parse_agent_session_mapping(line).is_none(), "{line}");
        }
    }

    #[test]
    fn parse_agent_session_mapping_rejects_lines_without_a_known_kind() {
        // No colon at all (legacy bare id), empty kind, empty id, blank file.
        for line in ["abc-123\n", ":abc-123\n", "claude:\n", "claude:   \n", "", "\n", "   \n"] {
            assert!(parse_agent_session_mapping(line).is_none(), "{line:?}");
        }
    }

    #[test]
    fn targeted_mapping_read_skips_unparseable_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pane-1.txt"), "claude:session-1\n").unwrap();
        std::fs::write(
            dir.path().join("pane-2.txt"),
            "claude-handoff:pty-abc-def\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("pane-3.txt"), "session-3\n").unwrap();

        let mappings =
            read_session_mapping_files_for_ids(dir.path(), ["pane-1", "pane-2", "pane-3"]);

        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings["pane-1"].session_id, "session-1");
    }

    #[test]
    fn targeted_mapping_read_ignores_stale_and_unsafe_ids() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pane-1.txt"), "codex:session-1\n").unwrap();
        std::fs::write(dir.path().join("pane-2.txt"), "claude:session-2\n").unwrap();
        for index in 0..100 {
            std::fs::write(
                dir.path().join(format!("stale-{index}.txt")),
                format!("codex:stale-{index}\n"),
            )
            .unwrap();
        }

        let mappings = read_session_mapping_files_for_ids(
            dir.path(),
            [
                "pane-1",
                "pane-2",
                "pane-1",
                "",
                ".",
                "..",
                "../pane-1",
                "C:outside",
                "name:stream",
                "unsafe id",
                "CON",
                "COM1",
            ],
        );

        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings["pane-1"].session_id, "session-1");
        assert_eq!(mappings["pane-2"].session_id, "session-2");
    }

    #[test]
    fn write_session_mapping_file_to_dir_is_atomic() {
        let dir = tempfile::tempdir().unwrap();

        write_session_mapping_file_to_dir(dir.path(), "pane-1", "codex", "old-session").unwrap();
        write_session_mapping_file_to_dir(dir.path(), "pane-1", "codex", "new-session").unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("pane-1.txt")).unwrap(),
            "codex:new-session\n"
        );
        assert!(!std::fs::read_dir(dir.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")
        }));
    }

    #[test]
    fn remove_session_mapping_file_from_dir_removes_only_the_target() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pane-1.txt"), "claude:session-1\n").unwrap();
        std::fs::write(dir.path().join("pane-2.txt"), "claude:session-2\n").unwrap();

        remove_session_mapping_file_from_dir(dir.path(), "pane-1").unwrap();

        assert!(!dir.path().join("pane-1.txt").exists());
        assert!(dir.path().join("pane-2.txt").exists());
        remove_session_mapping_file_from_dir(dir.path(), "pane-1").unwrap();
    }

    #[test]
    fn migrates_five_moved_tab_legacy_mappings_to_stable_tab_keys() {
        let dir = tempfile::tempdir().unwrap();
        let old_workspace = "5231da42-1111-4111-8111-111111111111";
        let pane_id = "bb391b49-3333-4333-8333-333333333333";
        let tab_ids = [
            "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
            "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
            "33333333-cccc-4ccc-8ccc-ccccccccccc3",
            "44444444-dddd-4ddd-8ddd-ddddddddddd4",
            "55555555-eeee-4eee-8eee-eeeeeeeeeee5",
        ];

        for (index, tab_id) in tab_ids.iter().enumerate() {
            let tab_id = *tab_id;
            let legacy_id = format!("pty-{old_workspace}-{pane_id}-{tab_id}");
            std::fs::write(
                dir.path().join(format!("{legacy_id}.txt")),
                format!("codex:session-{index}\n"),
            )
            .unwrap();

            let mappings = read_session_mapping_files_for_ids(dir.path(), [tab_id]);
            let expected = format!("session-{index}");
            assert_eq!(mappings.get(tab_id).map(|mapping| mapping.session_id.as_str()), Some(expected.as_str()));
            assert!(dir.path().join(format!("{tab_id}.txt")).exists());
            assert!(!dir.path().join(format!("{legacy_id}.txt")).exists());
        }
    }

    #[test]
    fn write_uses_the_stable_tab_key_for_a_composite_session_id() {
        let dir = tempfile::tempdir().unwrap();
        let tab_id = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
        let session_id = format!(
            "pty-5231da42-1111-4111-8111-111111111111-bb391b49-3333-4333-8333-333333333333-{tab_id}"
        );

        write_session_mapping_file_to_dir(dir.path(), &session_id, "codex", "session-a").unwrap();

        assert!(dir.path().join(format!("{tab_id}.txt")).exists());
        assert!(!dir.path().join(format!("{session_id}.txt")).exists());
    }

    #[test]
    fn ambiguous_legacy_mappings_do_not_migrate() {
        let dir = tempfile::tempdir().unwrap();
        let tab_id = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
        let old_a = format!(
            "pty-5231da42-1111-4111-8111-111111111111-bb391b49-3333-4333-8333-333333333333-{tab_id}"
        );
        let old_b = format!(
            "pty-c30892d0-2222-4222-8222-222222222222-bb391b49-3333-4333-8333-333333333333-{tab_id}"
        );
        std::fs::write(dir.path().join(format!("{old_a}.txt")), "codex:session-a\n").unwrap();
        std::fs::write(dir.path().join(format!("{old_b}.txt")), "codex:session-b\n").unwrap();

        assert!(read_session_mapping_files_for_ids(dir.path(), [tab_id]).is_empty());
        assert!(!dir.path().join(format!("{tab_id}.txt")).exists());
    }
}

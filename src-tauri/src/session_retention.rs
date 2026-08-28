use chrono::{DateTime, Local};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const RETENTION_DAYS: u64 = 30;

const DAY_SECS: u64 = 24 * 60 * 60;
const SESSION_ID_PREFIX: &str = "pty";
const APP_DATA_DIR_PREFIX: &str = "com.miyazaki.mycmux";
const SESSIONS_DIR: &str = "sessions";
const PANE_SESSIONS_DIR: &str = "pane-sessions";
const TRASH_DIR: &str = "sessions-trash";

fn current_schema_version() -> u32 {
    crate::db::storage::CURRENT_SCHEMA_VERSION
}

#[derive(Debug, Deserialize)]
struct RetentionSchemaProbe {
    #[serde(default = "current_schema_version")]
    schema_version: u32,
}

#[derive(Debug, Deserialize)]
struct RetentionData {
    #[serde(default)]
    workspaces: Vec<RetentionWorkspace>,
}

#[derive(Debug, Deserialize)]
struct RetentionWorkspace {
    id: String,
    #[serde(default)]
    panes: Vec<RetentionPane>,
}

#[derive(Debug, Deserialize)]
struct RetentionPane {
    #[serde(default)]
    pane_id: Option<String>,
    #[serde(default)]
    tabs: Option<Vec<RetentionPaneTab>>,
}

#[derive(Debug, Deserialize)]
struct RetentionPaneTab {
    #[serde(default)]
    tab_id: Option<String>,
}

#[derive(Debug)]
struct RetentionRoots {
    app_data_parent: PathBuf,
    mycmux_dir: PathBuf,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct RetentionSummary {
    moved: usize,
    skipped: usize,
}

struct LiveSessions {
    all_ids: HashSet<String>,
    tab_ids: HashSet<String>,
    scrollback_keep_sets: Vec<(PathBuf, HashSet<String>)>,
    data_json_fingerprints: Vec<DataJsonFingerprint>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DataJsonFingerprint {
    path: PathBuf,
    sha256: [u8; 32],
}

pub fn run_startup_retention(app_data_parent: Option<PathBuf>, mycmux_dir: Option<PathBuf>) {
    let _retention_task = tauri::async_runtime::spawn_blocking(move || {
        let Some(app_data_parent) = app_data_parent else {
            eprintln!("[session_retention] skipped: app data parent was not resolved");
            return;
        };
        let Some(mycmux_dir) = mycmux_dir else {
            eprintln!("[session_retention] skipped: home/.mycmux was not resolved");
            return;
        };

        let roots = RetentionRoots {
            app_data_parent,
            mycmux_dir,
        };
        match run_retention_once(&roots, SystemTime::now()) {
            Ok(summary) => eprintln!(
                "[session_retention] moved {} old orphan records, skipped {} records",
                summary.moved, summary.skipped
            ),
            Err(error) => crate::diag_warn!(
                "session_retention",
                "retention stopped: {error}"
            ),
        }
    });
}

fn run_retention_once(roots: &RetentionRoots, now: SystemTime) -> Result<RetentionSummary, String> {
    run_retention_once_with_reprobe_hooks(roots, now, || Ok(()), || Ok(()))
}

fn run_retention_once_with_before_reprobe<F>(
    roots: &RetentionRoots,
    now: SystemTime,
    before_reprobe: F,
) -> Result<RetentionSummary, String>
where
    F: FnOnce() -> Result<(), String>,
{
    run_retention_once_with_reprobe_hooks(roots, now, before_reprobe, || Ok(()))
}

fn run_retention_once_with_reprobe_hooks<F, G>(
    roots: &RetentionRoots,
    now: SystemTime,
    before_reprobe: F,
    after_reprobe: G,
) -> Result<RetentionSummary, String>
where
    F: FnOnce() -> Result<(), String>,
    G: FnOnce() -> Result<(), String>,
{
    let _initial_live_sessions = collect_live_sessions(&roots.app_data_parent)?;
    before_reprobe()?;
    // Fail closed on a profile created, removed, or replaced after the first
    // probe. No scrollback GC or record move may happen before this re-probe.
    let live_sessions = collect_live_sessions(&roots.app_data_parent)?;
    after_reprobe()?;
    let expected_fingerprints = live_sessions.data_json_fingerprints.clone();
    let mut ensure_unchanged = || {
        ensure_retention_inputs_unchanged(&roots.app_data_parent, &expected_fingerprints)
    };
    for (scrollback_dir, keep) in &live_sessions.scrollback_keep_sets {
        crate::pty::scrollback_store::gc_guarded(scrollback_dir, keep, || {
            ensure_unchanged().map_err(std::io::Error::other)
        })
            .map_err(|error| format!("sweep scrollback {} failed: {error}", scrollback_dir.display()))?;
    }
    let trash_month = trash_month(now);
    let max_age = Duration::from_secs(RETENTION_DAYS * DAY_SECS);
    let mut summary = RetentionSummary::default();

    retain_directory_records(
        &roots.mycmux_dir.join(SESSIONS_DIR),
        &roots
            .mycmux_dir
            .join(TRASH_DIR)
            .join(&trash_month)
            .join(SESSIONS_DIR),
        &live_sessions.all_ids,
        now,
        max_age,
        &mut summary,
        &mut ensure_unchanged,
    )?;
    retain_pane_session_files(
        &roots.mycmux_dir.join(PANE_SESSIONS_DIR),
        &roots
            .mycmux_dir
            .join(TRASH_DIR)
            .join(&trash_month)
            .join(PANE_SESSIONS_DIR),
        &live_sessions.all_ids,
        &live_sessions.tab_ids,
        now,
        max_age,
        &mut summary,
        &mut ensure_unchanged,
    )?;

    Ok(summary)
}

fn collect_live_sessions(app_data_parent: &Path) -> Result<LiveSessions, String> {
    let entries = fs::read_dir(app_data_parent).map_err(|error| {
        format!(
            "read app data parent {} failed: {error}",
            app_data_parent.display()
        )
    })?;
    let mut live_sessions = LiveSessions {
        all_ids: HashSet::new(),
        tab_ids: HashSet::new(),
        scrollback_keep_sets: Vec::new(),
        data_json_fingerprints: Vec::new(),
    };
    let mut parsed_data_files = 0usize;

    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "read app data entry under {} failed: {error}",
                app_data_parent.display()
            )
        })?;
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "read app data entry type {} failed: {error}",
                entry.path().display()
            )
        })?;
        if !file_type.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !name.starts_with(APP_DATA_DIR_PREFIX) {
            continue;
        }

        let mut data_paths = vec![entry.path().join("data.json")];
        let profiles_dir = entry.path().join("profiles");
        match fs::read_dir(&profiles_dir) {
            Ok(profile_entries) => {
                for profile_entry in profile_entries {
                    let profile_entry = profile_entry.map_err(|error| {
                        format!("read profile under {} failed: {error}", profiles_dir.display())
                    })?;
                    if profile_entry.file_type().map_err(|error| {
                        format!("read profile type {} failed: {error}", profile_entry.path().display())
                    })?.is_dir() {
                        data_paths.push(profile_entry.path().join("data.json"));
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("read {} failed: {error}", profiles_dir.display())),
        }

        for data_path in data_paths {
            match fs::metadata(&data_path) {
                Ok(metadata) if metadata.is_file() => {
                    let contents = fs::read(&data_path).map_err(|error| {
                        format!("read {} failed: {error}", data_path.display())
                    })?;
                    let probe: RetentionSchemaProbe =
                        serde_json::from_slice(&contents).map_err(|error| {
                            format!("parse {} failed: {error}", data_path.display())
                        })?;
                    if probe.schema_version != crate::db::storage::CURRENT_SCHEMA_VERSION {
                        return Err(format!(
                            "skip retention: {} uses unsupported schema version {}",
                            data_path.display(),
                            probe.schema_version
                        ));
                    }
                    let data: RetentionData = serde_json::from_slice(&contents).map_err(|error| {
                        format!("parse {} failed: {error}", data_path.display())
                    })?;
                    live_sessions.data_json_fingerprints.push(DataJsonFingerprint {
                        path: data_path.clone(),
                        sha256: Sha256::digest(&contents).into(),
                    });
                    let mut local_ids = HashSet::new();
                    let mut local_tab_ids = HashSet::new();
                    insert_live_session_ids(&data, &mut local_ids, &mut local_tab_ids);
                    live_sessions.all_ids.extend(local_ids.iter().cloned());
                    live_sessions.tab_ids.extend(local_tab_ids.iter().cloned());
                    let scrollback_dir = data_path.parent()
                        .ok_or_else(|| format!("data path has no parent: {}", data_path.display()))?
                        .join("scrollback");
                    live_sessions.scrollback_keep_sets.push((scrollback_dir, local_tab_ids));
                    parsed_data_files += 1;
                }
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!("metadata {} failed: {error}", data_path.display()));
                }
            }
        }
    }

    if parsed_data_files == 0 {
        return Err(format!(
            "no data.json files found under {}",
            app_data_parent.display()
        ));
    }

    live_sessions
        .data_json_fingerprints
        .sort_by(|left, right| left.path.cmp(&right.path));
    Ok(live_sessions)
}

fn ensure_retention_inputs_unchanged(
    app_data_parent: &Path,
    expected: &[DataJsonFingerprint],
) -> Result<(), String> {
    let actual = collect_live_sessions(app_data_parent)?.data_json_fingerprints;
    if actual == expected {
        return Ok(());
    }
    let changed_path = expected
        .iter()
        .zip(actual.iter())
        .find_map(|(before, after)| (before != after).then_some(&after.path))
        .or_else(|| actual.get(expected.len()).map(|fingerprint| &fingerprint.path))
        .or_else(|| expected.get(actual.len()).map(|fingerprint| &fingerprint.path));
    Err(format!(
        "{} changed after the final retention scan; aborting before destructive action",
        changed_path.map_or(app_data_parent, PathBuf::as_path).display()
    ))
}

fn insert_live_session_ids(
    data: &RetentionData,
    live_ids: &mut HashSet<String>,
    tab_ids: &mut HashSet<String>,
) {
    for workspace in &data.workspaces {
        for pane in &workspace.panes {
            let Some(pane_id) = pane.pane_id.as_deref().filter(|value| !value.is_empty()) else {
                continue;
            };
            for tab in pane.tabs.as_deref().unwrap_or_default() {
                let Some(tab_id) = tab.tab_id.as_deref().filter(|value| !value.is_empty()) else {
                    continue;
                };
                live_ids.insert(make_session_id(&workspace.id, pane_id, tab_id));
                tab_ids.insert(tab_id.to_string());
            }
        }
    }
}

fn make_session_id(workspace_id: &str, pane_id: &str, tab_id: &str) -> String {
    format!("{SESSION_ID_PREFIX}-{workspace_id}-{pane_id}-{tab_id}")
}

fn retain_directory_records(
    source_dir: &Path,
    trash_dir: &Path,
    live_ids: &HashSet<String>,
    now: SystemTime,
    max_age: Duration,
    summary: &mut RetentionSummary,
    before_move: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let entries = match fs::read_dir(source_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            summary.skipped += 1;
            eprintln!(
                "[session_retention] skipped {}: read_dir failed: {error}",
                source_dir.display()
            );
            return Ok(());
        }
    };

    for entry in entries {
        let Ok(entry) = entry else {
            summary.skipped += 1;
            continue;
        };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            summary.skipped += 1;
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Some(session_id) = entry.file_name().to_str().map(str::to_string) else {
            summary.skipped += 1;
            continue;
        };
        if !is_safe_session_record_id(&session_id) {
            continue;
        }
        if live_ids.contains(&session_id) || !is_older_than(&path, now, max_age) {
            continue;
        }
        move_record(&path, trash_dir, &entry.file_name(), summary, before_move)?;
    }
    Ok(())
}

fn retain_pane_session_files(
    source_dir: &Path,
    trash_dir: &Path,
    live_ids: &HashSet<String>,
    live_tab_ids: &HashSet<String>,
    now: SystemTime,
    max_age: Duration,
    summary: &mut RetentionSummary,
    before_move: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let entries = match fs::read_dir(source_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            summary.skipped += 1;
            eprintln!(
                "[session_retention] skipped {}: read_dir failed: {error}",
                source_dir.display()
            );
            return Ok(());
        }
    };

    for entry in entries {
        let Ok(entry) = entry else {
            summary.skipped += 1;
            continue;
        };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            summary.skipped += 1;
            continue;
        };
        let is_txt = path.extension().and_then(|value| value.to_str()) == Some("txt");
        if !file_type.is_file() || !is_txt {
            continue;
        }
        let Some(session_id) = path.file_stem().and_then(|value| value.to_str()) else {
            summary.skipped += 1;
            continue;
        };
        if !is_safe_pane_mapping_id(session_id) {
            continue;
        }
        if is_live_pane_mapping(session_id, live_ids, live_tab_ids)
            || !is_older_than(&path, now, max_age)
        {
            continue;
        }
        move_record(&path, trash_dir, &entry.file_name(), summary, before_move)?;
    }
    Ok(())
}

fn is_older_than(path: &Path, now: SystemTime, max_age: Duration) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    now.duration_since(modified)
        .map(|age| age > max_age)
        .unwrap_or(false)
}

fn is_safe_session_record_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.starts_with(&format!("{SESSION_ID_PREFIX}-"))
        && !session_id.contains('/')
        && !session_id.contains('\\')
        && session_id != "."
        && session_id != ".."
}

fn move_record(
    source_path: &Path,
    trash_dir: &Path,
    file_name: &std::ffi::OsStr,
    summary: &mut RetentionSummary,
    before_move: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let target_path = trash_dir.join(file_name);
    if target_path.exists() {
        summary.skipped += 1;
        eprintln!(
            "[session_retention] skipped {}: trash target already exists at {}",
            source_path.display(),
            target_path.display()
        );
        return Ok(());
    }
    if let Err(error) = fs::create_dir_all(trash_dir) {
        summary.skipped += 1;
        eprintln!(
            "[session_retention] skipped {}: create trash dir {} failed: {error}",
            source_path.display(),
            trash_dir.display()
        );
        return Ok(());
    }
    before_move()?;
    match fs::rename(source_path, &target_path) {
        Ok(()) => summary.moved += 1,
        Err(error) => {
            summary.skipped += 1;
            eprintln!(
                "[session_retention] skipped {}: rename to {} failed: {error}",
                source_path.display(),
                target_path.display()
            );
        }
    }
    Ok(())
}

fn trash_month(now: SystemTime) -> String {
    let local: DateTime<Local> = now.into();
    local.format("%Y-%m").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(temp: &tempfile::TempDir) -> RetentionRoots {
        RetentionRoots {
            app_data_parent: temp.path().join("appdata"),
            mycmux_dir: temp.path().join(".mycmux"),
        }
    }

    fn write_data_json(roots: &RetentionRoots, app_name: &str, live_ids: &[(&str, &str, &str)]) {
        let app_dir = roots.app_data_parent.join(app_name);
        fs::create_dir_all(&app_dir).unwrap();
        let workspaces = live_ids
            .iter()
            .map(|(workspace_id, pane_id, tab_id)| {
                serde_json::json!({
                    "id": workspace_id,
                    "panes": [
                        {
                            "pane_id": pane_id,
                            "tabs": [
                                { "tab_id": tab_id }
                            ]
                        }
                    ]
                })
            })
            .collect::<Vec<_>>();
        let json = serde_json::json!({ "workspaces": workspaces });
        fs::write(app_dir.join("data.json"), serde_json::to_string(&json).unwrap()).unwrap();
    }

    fn write_raw_data_json(roots: &RetentionRoots, app_name: &str, contents: &str) {
        let app_dir = roots.app_data_parent.join(app_name);
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(app_dir.join("data.json"), contents).unwrap();
    }

    fn create_records(roots: &RetentionRoots, session_id: &str) {
        let session_dir = roots.mycmux_dir.join(SESSIONS_DIR).join(session_id);
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(session_dir.join("out.html"), "<html></html>").unwrap();
        let pane_sessions_dir = roots.mycmux_dir.join(PANE_SESSIONS_DIR);
        fs::create_dir_all(&pane_sessions_dir).unwrap();
        fs::write(
            pane_sessions_dir.join(format!("{session_id}.txt")),
            "claude:agent-session\n",
        )
        .unwrap();
    }

    fn scrollback_path(roots: &RetentionRoots, app_name: &str, session_id: &str) -> PathBuf {
        roots.app_data_parent.join(app_name).join("scrollback").join(format!("{session_id}.bin"))
    }

    fn write_legacy_scrollback(
        roots: &RetentionRoots,
        app_name: &str,
        session_id: &str,
        data: &[u8],
    ) {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"MSBK");
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&(data.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&crc32fast::hash(data).to_le_bytes());
        bytes.extend_from_slice(data);
        let path = scrollback_path(roots, app_name, session_id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn future_old_now() -> SystemTime {
        SystemTime::now() + Duration::from_secs((RETENTION_DAYS + 1) * DAY_SECS)
    }

    fn session_path(roots: &RetentionRoots, session_id: &str) -> PathBuf {
        roots.mycmux_dir.join(SESSIONS_DIR).join(session_id)
    }

    fn pane_session_path(roots: &RetentionRoots, session_id: &str) -> PathBuf {
        roots
            .mycmux_dir
            .join(PANE_SESSIONS_DIR)
            .join(format!("{session_id}.txt"))
    }

    fn trash_session_path(roots: &RetentionRoots, now: SystemTime, session_id: &str) -> PathBuf {
        roots
            .mycmux_dir
            .join(TRASH_DIR)
            .join(trash_month(now))
            .join(SESSIONS_DIR)
            .join(session_id)
    }

    fn trash_pane_session_path(
        roots: &RetentionRoots,
        now: SystemTime,
        session_id: &str,
    ) -> PathBuf {
        roots
            .mycmux_dir
            .join(TRASH_DIR)
            .join(trash_month(now))
            .join(PANE_SESSIONS_DIR)
            .join(format!("{session_id}.txt"))
    }

    #[test]
    fn live_old_records_stay_even_when_lite_owns_the_live_id() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let now = future_old_now();
        let live_id = make_session_id("ws-live", "pane-live", "tab-live");
        write_data_json(&roots, "com.miyazaki.mycmux", &[]);
        write_data_json(
            &roots,
            "com.miyazaki.mycmux-lite",
            &[("ws-live", "pane-live", "tab-live")],
        );
        create_records(&roots, &live_id);

        let summary = run_retention_once(&roots, now).unwrap();

        assert_eq!(summary, RetentionSummary::default());
        assert!(session_path(&roots, &live_id).exists());
        assert!(pane_session_path(&roots, &live_id).exists());
        assert!(!trash_session_path(&roots, now, &live_id).exists());
        assert!(!trash_pane_session_path(&roots, now, &live_id).exists());
    }

    #[test]
    fn orphan_old_records_move_to_trash() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let now = future_old_now();
        let orphan_id = make_session_id("ws-old", "pane-old", "tab-old");
        write_data_json(&roots, "com.miyazaki.mycmux", &[]);
        create_records(&roots, &orphan_id);

        let summary = run_retention_once(&roots, now).unwrap();

        assert_eq!(summary.moved, 2);
        assert_eq!(summary.skipped, 0);
        assert!(!session_path(&roots, &orphan_id).exists());
        assert!(!pane_session_path(&roots, &orphan_id).exists());
        assert!(trash_session_path(&roots, now, &orphan_id).exists());
        assert!(trash_pane_session_path(&roots, now, &orphan_id).exists());
    }

    #[test]
    fn orphan_recent_records_stay() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let now = SystemTime::now();
        let recent_id = make_session_id("ws-recent", "pane-recent", "tab-recent");
        write_data_json(&roots, "com.miyazaki.mycmux", &[]);
        create_records(&roots, &recent_id);

        let summary = run_retention_once(&roots, now).unwrap();

        assert_eq!(summary, RetentionSummary::default());
        assert!(session_path(&roots, &recent_id).exists());
        assert!(pane_session_path(&roots, &recent_id).exists());
        assert!(!trash_session_path(&roots, now, &recent_id).exists());
        assert!(!trash_pane_session_path(&roots, now, &recent_id).exists());
    }

    #[test]
    fn startup_sweep_keeps_live_scrollback_and_removes_orphans() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let live_id = make_session_id("ws-live", "pane-live", "tab-live");
        let orphan_id = make_session_id("ws-old", "pane-old", "tab-old");
        write_data_json(&roots, "com.miyazaki.mycmux", &[("ws-live", "pane-live", "tab-live")]);
        let scrollback_dir = roots.app_data_parent.join("com.miyazaki.mycmux").join("scrollback");
        crate::pty::scrollback_store::save(&scrollback_dir, &live_id, 0, 1, b"a").unwrap();
        crate::pty::scrollback_store::save(&scrollback_dir, &orphan_id, 0, 1, b"b").unwrap();

        run_retention_once(&roots, SystemTime::now()).unwrap();

        assert!(scrollback_path(&roots, "com.miyazaki.mycmux", &live_id).exists());
        assert!(!scrollback_path(&roots, "com.miyazaki.mycmux", &orphan_id).exists());
    }

    #[test]
    fn startup_sweep_keeps_five_moved_tab_legacy_scrollback_files_for_migration() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let old_workspace = "5231da42-1111-4111-8111-111111111111";
        let current_workspace = "c30892d0-2222-4222-8222-222222222222";
        let pane_id = "bb391b49-3333-4333-8333-333333333333";
        let tab_ids = [
            "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
            "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
            "33333333-cccc-4ccc-8ccc-ccccccccccc3",
            "44444444-dddd-4ddd-8ddd-ddddddddddd4",
            "55555555-eeee-4eee-8eee-eeeeeeeeeee5",
        ];
        let live_ids = tab_ids.map(|tab_id| (current_workspace, pane_id, tab_id));
        write_data_json(&roots, "com.miyazaki.mycmux", &live_ids);

        for (index, tab_id) in tab_ids.iter().enumerate() {
            let legacy_id = make_session_id(old_workspace, pane_id, tab_id);
            write_legacy_scrollback(
                &roots,
                "com.miyazaki.mycmux",
                &legacy_id,
                &[index as u8],
            );
        }

        run_retention_once(&roots, SystemTime::now()).unwrap();

        for tab_id in tab_ids {
            let legacy_id = make_session_id(old_workspace, pane_id, tab_id);
            assert!(scrollback_path(&roots, "com.miyazaki.mycmux", &legacy_id).exists());
        }
    }

    #[test]
    fn future_schema_profile_aborts_before_any_retention_deletion() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let now = future_old_now();
        let future_id = make_session_id("ws-future", "pane-future", "tab-future");
        write_data_json(&roots, "com.miyazaki.mycmux", &[]);
        create_records(&roots, &future_id);
        let profile_dir = roots
            .app_data_parent
            .join("com.miyazaki.mycmux")
            .join("profiles")
            .join("future");
        fs::create_dir_all(profile_dir.join("scrollback")).unwrap();
        fs::write(
            profile_dir.join("data.json"),
            r#"{"schema_version":999,"future_workspaces":[{"canary":"keep-me"}]}"#,
        )
        .unwrap();
        crate::pty::scrollback_store::save(
            &profile_dir.join("scrollback"),
            "tab-future",
            0,
            1,
            b"canary",
        )
        .unwrap();

        let error = run_retention_once(&roots, now).unwrap_err();

        assert!(error.contains("schema version 999"));
        assert!(session_path(&roots, &future_id).exists());
        assert!(pane_session_path(&roots, &future_id).exists());
        assert!(profile_dir.join("scrollback").join("tab-future.bin").exists());
        assert!(!trash_session_path(&roots, now, &future_id).exists());
        assert!(!trash_pane_session_path(&roots, now, &future_id).exists());
    }

    #[test]
    fn schema_is_reprobed_immediately_before_retention_gc() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let now = future_old_now();
        let orphan_id = make_session_id("ws-race", "pane-race", "tab-race");
        write_data_json(&roots, "com.miyazaki.mycmux", &[]);
        create_records(&roots, &orphan_id);
        let scrollback_dir = roots
            .app_data_parent
            .join("com.miyazaki.mycmux")
            .join("scrollback");
        crate::pty::scrollback_store::save(&scrollback_dir, &orphan_id, 0, 1, b"canary")
            .unwrap();

        let data_path = roots
            .app_data_parent
            .join("com.miyazaki.mycmux")
            .join("data.json");
        let error = run_retention_once_with_before_reprobe(&roots, now, || {
            fs::write(
                &data_path,
                r#"{"schema_version":999,"future_workspaces":[{"canary":"keep"}]}"#,
            )
            .map_err(|error| error.to_string())
        })
        .unwrap_err();

        assert!(error.contains(&data_path.display().to_string()));
        assert!(error.contains("schema version 999"));
        assert!(session_path(&roots, &orphan_id).exists());
        assert!(pane_session_path(&roots, &orphan_id).exists());
        assert!(scrollback_path(&roots, "com.miyazaki.mycmux", &orphan_id).exists());
        assert!(!trash_session_path(&roots, now, &orphan_id).exists());
        assert!(!trash_pane_session_path(&roots, now, &orphan_id).exists());
    }

    #[test]
    fn mutation_after_second_scan_aborts_before_any_retention_action() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let now = future_old_now();
        let orphan_id = make_session_id("ws-race", "pane-race", "tab-race");
        write_data_json(&roots, "com.miyazaki.mycmux", &[]);
        create_records(&roots, &orphan_id);
        let scrollback_dir = roots
            .app_data_parent
            .join("com.miyazaki.mycmux")
            .join("scrollback");
        crate::pty::scrollback_store::save(&scrollback_dir, &orphan_id, 0, 1, b"canary")
            .unwrap();

        let data_path = roots
            .app_data_parent
            .join("com.miyazaki.mycmux")
            .join("data.json");
        let error = run_retention_once_with_reprobe_hooks(
            &roots,
            now,
            || Ok(()),
            || {
                write_data_json(
                    &roots,
                    "com.miyazaki.mycmux",
                    &[("ws-race", "pane-race", "tab-race")],
                );
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains(&data_path.display().to_string()));
        assert!(error.contains("changed after the final retention scan"));
        assert!(session_path(&roots, &orphan_id).exists());
        assert!(pane_session_path(&roots, &orphan_id).exists());
        assert!(scrollback_path(&roots, "com.miyazaki.mycmux", &orphan_id).exists());
        assert!(!trash_session_path(&roots, now, &orphan_id).exists());
        assert!(!trash_pane_session_path(&roots, now, &orphan_id).exists());
    }

    #[test]
    fn malformed_data_json_aborts_without_moving_anything() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let now = future_old_now();
        let orphan_id = make_session_id("ws-bad", "pane-bad", "tab-bad");
        write_data_json(&roots, "com.miyazaki.mycmux", &[]);
        write_raw_data_json(&roots, "com.miyazaki.mycmux-lite", "{not valid json");
        create_records(&roots, &orphan_id);
        let scrollback_dir = roots.app_data_parent.join("com.miyazaki.mycmux").join("scrollback");
        crate::pty::scrollback_store::save(&scrollback_dir, &orphan_id, 0, 1, b"a").unwrap();

        let error = run_retention_once(&roots, now).unwrap_err();

        assert!(error.contains("parse"));
        assert!(session_path(&roots, &orphan_id).exists());
        assert!(pane_session_path(&roots, &orphan_id).exists());
        assert!(!trash_session_path(&roots, now, &orphan_id).exists());
        assert!(!trash_pane_session_path(&roots, now, &orphan_id).exists());
        assert!(scrollback_path(&roots, "com.miyazaki.mycmux", &orphan_id).exists());
    }
}

fn is_safe_pane_mapping_id(mapping_id: &str) -> bool {
    is_safe_session_record_id(mapping_id)
        || (!mapping_id.is_empty()
            && mapping_id.len() <= 240
            && mapping_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
}

fn is_live_pane_mapping(
    mapping_id: &str,
    live_ids: &HashSet<String>,
    live_tab_ids: &HashSet<String>,
) -> bool {
    live_ids.contains(mapping_id)
        || live_tab_ids.contains(mapping_id)
        || (mapping_id.starts_with("pty-")
            && live_tab_ids
                .iter()
                .any(|tab_id| mapping_id.ends_with(&format!("-{tab_id}"))))
}

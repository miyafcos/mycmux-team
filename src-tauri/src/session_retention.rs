use crate::db::storage;
use chrono::{DateTime, Local};
use serde::Deserialize;
#[cfg(test)]
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const RETENTION_DAYS: u64 = 30;

const DAY_SECS: u64 = 24 * 60 * 60;
const SESSION_ID_PREFIX: &str = "pty";
use storage::APP_LAYOUT_DIR_PREFIX as APP_DATA_DIR_PREFIX;
const SESSIONS_DIR: &str = "sessions";
const PANE_SESSIONS_DIR: &str = "pane-sessions";
const TRASH_DIR: &str = "sessions-trash";

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
    session_id: Option<String>,
    #[serde(default)]
    tabs: Option<Vec<RetentionPaneTab>>,
}

#[derive(Debug, Deserialize)]
struct RetentionPaneTab {
    #[serde(default)]
    tab_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Debug)]
struct RetentionRoots {
    app_data_parent: PathBuf,
    profile_dir: PathBuf,
    mycmux_dir: PathBuf,
    scrollback_startup_cutoff: SystemTime,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct RetentionSummary {
    moved: usize,
    skipped: usize,
}

#[derive(PartialEq, Eq)]
struct LiveSessions {
    all_ids: HashSet<String>,
    tab_ids: HashSet<String>,
    scrollback_keep_sets: Vec<(PathBuf, HashSet<String>)>,
    data_json_fingerprints: Vec<DataJsonFingerprint>,
    #[cfg(test)]
    recovery_fingerprints: BTreeMap<PathBuf, [u8; 32]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DataJsonFingerprint {
    path: PathBuf,
    #[cfg(test)]
    sha256: [u8; 32],
    tab_count: usize,
}

pub fn run_startup_retention(
    profile_dir: Option<PathBuf>, mycmux_dir: Option<PathBuf>, scrollback_startup_cutoff: SystemTime,
) {
    let _retention_task = tauri::async_runtime::spawn_blocking(move || {
        let Some(profile_dir) = profile_dir else {
            eprintln!("[session_retention] skipped: app data directory was not resolved");
            return;
        };
        let Some(app_data_parent) = profile_dir.parent().map(Path::to_path_buf) else { return; };
        let Some(mycmux_dir) = mycmux_dir else {
            eprintln!("[session_retention] skipped: home/.mycmux was not resolved");
            return;
        };

        let roots = RetentionRoots {
            app_data_parent,
            profile_dir,
            mycmux_dir,
            scrollback_startup_cutoff,
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
    run_retention_once_with_reprobe_hooks(roots, now, || Ok(()), |_| Ok(()))
}

#[cfg(test)]
fn run_retention_once_with_before_reprobe<F>(
    roots: &RetentionRoots,
    now: SystemTime,
    before_reprobe: F,
) -> Result<RetentionSummary, String>
where
    F: FnOnce() -> Result<(), String>,
{
    run_retention_once_with_reprobe_hooks(roots, now, before_reprobe, |_| Ok(()))
}

fn run_retention_once_with_reprobe_hooks<F, G>(
    roots: &RetentionRoots,
    now: SystemTime,
    before_reprobe: F,
    after_reprobe: G,
) -> Result<RetentionSummary, String>
where
    F: FnOnce() -> Result<(), String>,
    G: FnOnce(&LiveSessions) -> Result<(), String>,
{
    // A startup sweep can be the first reader after a previous run broke the
    // layout. Compare with the last sweep as well as the first in-run probe.
    let checkpoint = roots.mycmux_dir.join("session-retention-live-tabs.json");
    let (mut previous, corrupt_counts) = match read_tab_counts(&checkpoint) {
        Ok(counts) => (counts, false),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => (BTreeMap::new(), true),
        Err(error) => return Err(format!("read retention tab counts failed: {:?}", error.kind())),
    };
    let initial = collect_live_sessions(&roots.app_data_parent)?;
    for file in initial.data_json_fingerprints {
        let count = previous.entry(file.path).or_default();
        *count = (*count).max(file.tab_count);
    }
    before_reprobe()?;
    // Hold the publication gate from the final observation through retirement.
    // Saving another layout or publishing new history waits for this sweep.
    let _activity = storage::lock_layout_activity(&roots.app_data_parent, Duration::from_secs(30))?;
    let live_sessions = collect_live_sessions(&roots.app_data_parent)?;
    after_reprobe(&live_sessions)?;
    let current: BTreeMap<_, _> = live_sessions.data_json_fingerprints.iter()
        .map(|file| (file.path.clone(), file.tab_count))
        .collect();
    if corrupt_counts {
        crate::util::atomic_write::preserve_in_old(&checkpoint)
            .map_err(|error| format!("could not preserve invalid tab counts: {:?}", error.kind()))?;
        crate::diag_warn!("session_retention", "preserved invalid tab counts");
        write_tab_counts(&checkpoint, &current)?;
        return Ok(RetentionSummary::default());
    }
    if !checkpoint.exists() && checkpoint.with_file_name("_old").join("session-retention-live-tabs.json").is_file() {
        // Recovery stopped after moving the invalid data but before recording
        // a fresh baseline. This pass records that baseline before pruning.
        write_tab_counts(&checkpoint, &current)?;
        return Ok(RetentionSummary::default());
    }
    for (path, before) in previous {
        let after = current.get(&path).copied().unwrap_or_default();
        if crate::db::storage::large_tab_drop(before, after) {
            crate::diag_warn!("session_retention",
                "skipped sweep after live tabs dropped {before}->{after}");
            write_tab_counts(&checkpoint, &current)?;
            return Ok(RetentionSummary::default());
        }
    }
    // Older versions of another profile may commit a layout without taking
    // this gate. Only retire history in the profile this instance owns.
    let own_scrollback = roots.profile_dir.join("scrollback");
    if let Some((dir, keep)) = live_sessions.scrollback_keep_sets.iter()
        .find(|(dir, _)| dir == &own_scrollback && roots.scrollback_startup_cutoff <= now)
    {
        // A new history file can precede the first layout that refers to it.
        let cutoff = roots.scrollback_startup_cutoff;
        crate::pty::scrollback_store::gc_guarded(dir, keep, Some(cutoff), || Ok(()))
            .map_err(|error| format!("sweep scrollback failed: {:?}", error.kind()))?;
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
        &live_sessions.tab_ids,
        now,
        max_age,
        &mut summary,
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
    )?;

    write_tab_counts(&checkpoint, &current)?;
    Ok(summary)
}

fn read_tab_counts(path: &Path) -> std::io::Result<BTreeMap<PathBuf, usize>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error),
    }
}

fn write_tab_counts(path: &Path, counts: &BTreeMap<PathBuf, usize>) -> Result<(), String> {
    let bytes = serde_json::to_vec(counts).map_err(|error| error.to_string())?;
    crate::util::atomic_write::AtomicWrite::new(
        "retention tab counts", "Failed to install retention tab counts",
    ).create_parents().write_bytes(path, &bytes)
        .map_err(|_| "could not write retention tab counts".into())
}

fn read_retention_layout(bytes: &[u8], backup: bool) -> Result<Option<RetentionData>, String> {
    let envelope = match storage::parse_layout_bytes(bytes) {
        Ok(envelope) => envelope,
        Err(_) if backup => return Ok(None),
        Err(_) => return Err("invalid main layout".into()),
    };
    if !envelope.supported {
        let kind = if backup { "recovery backup" } else { "main layout" };
        return Err(format!("{kind} uses unsupported schema version {}", envelope.schema_version));
    }
    // Also honor legacy pane-level session IDs that the product schema
    // accepts as extra fields. Validate the entire product layout first.
    let contents = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    serde_json::from_slice::<RetentionData>(contents)
        .map(Some).map_err(|_| "invalid retention layout references".into())
}

fn collect_profile(
    data_path: PathBuf, live: &mut LiveSessions,
) -> Result<bool, String> {
    let mut session_ids = HashSet::new();
    let mut tab_ids = HashSet::new();
    let main = match fs::read(&data_path) {
        Ok(contents) => {
            let data = read_retention_layout(&contents, false)?.ok_or("invalid main layout")?;
            insert_live_session_ids(&data, &mut session_ids, &mut tab_ids);
            live.data_json_fingerprints.push(DataJsonFingerprint {
                path: data_path.clone(),
                #[cfg(test)]
                sha256: Sha256::digest(&contents).into(),
                tab_count: tab_ids.len(),
            });
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("read main layout failed: {:?}", error.kind())),
    };

    let backups = storage::scan_recovery_backups(&data_path)
        .map_err(|error| format!("list recovery backups failed: {:?}", error.kind()))?;
    for backup in backups {
        let contents = fs::read(&backup)
            .map_err(|error| format!("read recovery backup failed: {:?}", error.kind()))?;
        if let Some(layout) = read_retention_layout(&contents, true)? {
            insert_live_session_ids(&layout, &mut session_ids, &mut tab_ids);
            #[cfg(test)]
            live.recovery_fingerprints.insert(backup, Sha256::digest(&contents).into());
        }
    }

    live.all_ids.extend(session_ids.iter().cloned());
    live.tab_ids.extend(tab_ids.iter().cloned());
    if main {
        let scrollback_dir = data_path.with_file_name("scrollback");
        tab_ids.extend(session_ids.iter().map(|id|
            crate::pty::scrollback_store::scrollback_storage_id(id).to_owned()));
        tab_ids.extend(session_ids);
        live.scrollback_keep_sets.push((scrollback_dir, tab_ids));
    }
    Ok(main)
}

#[cfg(test)]
thread_local! {
    static OBSERVATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn collect_live_sessions(app_data_parent: &Path) -> Result<LiveSessions, String> {
    #[cfg(test)]
    OBSERVATIONS.with(|count| count.set(count.get() + 1));
    let entries = fs::read_dir(app_data_parent)
        .map_err(|error| format!("read app data parent failed: {:?}", error.kind()))?;
    let mut live = LiveSessions {
        all_ids: HashSet::new(),
        tab_ids: HashSet::new(),
        scrollback_keep_sets: Vec::new(),
        data_json_fingerprints: Vec::new(),
        #[cfg(test)]
        recovery_fingerprints: BTreeMap::new(),
    };
    let mut has_main = false;

    for entry in entries {
        let entry = entry.map_err(|error| format!("read app data entry failed: {:?}", error.kind()))?;
        if !entry.file_type().map_err(|error| format!("read app data entry type failed: {:?}", error.kind()))?.is_dir()
            || !entry.file_name().to_str().is_some_and(|name| name.starts_with(APP_DATA_DIR_PREFIX))
        {
            continue;
        }

        has_main |= collect_profile(entry.path().join("data.json"), &mut live)?;
        let profiles_dir = entry.path().join("profiles");
        match fs::read_dir(profiles_dir) {
            Ok(profiles) => {
                for profile in profiles {
                    let profile = profile.map_err(|error| format!("read profile failed: {:?}", error.kind()))?;
                    if profile.file_type().map_err(|error| format!("read profile type failed: {:?}", error.kind()))?.is_dir() {
                        has_main |= collect_profile(profile.path().join("data.json"), &mut live)?;
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("list saved profiles failed: {:?}", error.kind())),
        }
    }
    if !has_main {
        return Err("no data.json files found under the app data parent".into());
    }
    live.data_json_fingerprints.sort_by(|left, right| left.path.cmp(&right.path));
    live.scrollback_keep_sets.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(live)
}

fn insert_live_session_ids(
    data: &RetentionData,
    live_ids: &mut HashSet<String>,
    tab_ids: &mut HashSet<String>,
) {
    for workspace in &data.workspaces {
        for pane in &workspace.panes {
            if let Some(id) = pane.session_id.as_ref().filter(|value| !value.is_empty()) {
                live_ids.insert(id.clone());
            }
            let pane_id = pane.pane_id.as_deref().filter(|value| !value.is_empty());
            for tab in pane.tabs.as_deref().unwrap_or_default() {
                if let Some(id) = tab.session_id.as_ref().filter(|value| !value.is_empty()) {
                    live_ids.insert(id.clone());
                }
                let Some(tab_id) = tab.tab_id.as_deref().filter(|value| !value.is_empty()) else {
                    continue;
                };
                tab_ids.insert(tab_id.to_string());
                if let Some(pane_id) = pane_id {
                    live_ids.insert(make_session_id(&workspace.id, pane_id, tab_id));
                }
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
    live_tab_ids: &HashSet<String>,
    now: SystemTime,
    max_age: Duration,
    summary: &mut RetentionSummary,
) -> Result<(), String> {
    let entries = match fs::read_dir(source_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            summary.skipped += 1;
            eprintln!(
                "[session_retention] list session records failed: {:?}", error.kind()
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
        if is_live_session(&session_id, live_ids, live_tab_ids)
            || !is_older_than(&path, now, max_age)
        {
            continue;
        }
        move_record(&path, trash_dir, &entry.file_name(), summary)?;
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
) -> Result<(), String> {
    let entries = match fs::read_dir(source_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            summary.skipped += 1;
            eprintln!(
                "[session_retention] list pane mappings failed: {:?}", error.kind()
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
        if is_live_session(session_id, live_ids, live_tab_ids)
            || !is_older_than(&path, now, max_age)
        {
            continue;
        }
        move_record(&path, trash_dir, &entry.file_name(), summary)?;
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
) -> Result<(), String> {
    let target_path = trash_dir.join(file_name);
    if target_path.exists() {
        summary.skipped += 1;
        eprintln!(
            "[session_retention] skipped record because its trash target exists"
        );
        return Ok(());
    }
    if let Err(error) = fs::create_dir_all(trash_dir) {
        summary.skipped += 1;
        eprintln!(
            "[session_retention] create record trash directory failed: {:?}", error.kind()
        );
        return Ok(());
    }
    match fs::rename(source_path, &target_path) {
        Ok(()) => summary.moved += 1,
        Err(error) => {
            summary.skipped += 1;
            eprintln!(
                "[session_retention] could not move record to trash: {:?}", error.kind()
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
        let app_data_parent = temp.path().join("appdata");
        RetentionRoots {
            profile_dir: app_data_parent.join(APP_DATA_DIR_PREFIX),
            app_data_parent,
            mycmux_dir: temp.path().join(".mycmux"),
            scrollback_startup_cutoff: SystemTime::now() + Duration::from_secs(60),
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
                    "name": workspace_id,
                    "grid_template_id": "1x1",
                    "created_at": 0,
                    "panes": [{
                        "pane_id": pane_id,
                        "agent_id": "shell",
                        "tabs": [{ "tab_id": tab_id, "agent_id": "shell" }],
                    }]
                })
            })
            .collect::<Vec<_>>();
        let json = serde_json::json!({
            "workspaces": workspaces,
            "settings": storage::AppSettings::default(),
        });
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
    fn moved_tab_old_records_stay_after_pane_move() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let old_id = make_session_id("wsA", "paneOld", "tabX");
        write_data_json(&roots, "com.miyazaki.mycmux", &[("wsA", "paneNew", "tabX")]);
        create_records(&roots, &old_id);
        let now = future_old_now();

        let summary = run_retention_once(&roots, now).unwrap();

        assert_eq!(summary, RetentionSummary::default());
        assert!(session_path(&roots, &old_id).join("out.html").is_file());
        assert!(pane_session_path(&roots, &old_id).is_file());
        assert!(!trash_session_path(&roots, now, &old_id).exists());
        assert!(!trash_pane_session_path(&roots, now, &old_id).exists());
    }

    #[test]
    fn moved_tab_old_records_stay_after_workspace_move() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let old_id = make_session_id("wsA", "paneOld", "tabY");
        write_data_json(&roots, "com.miyazaki.mycmux", &[("wsB", "paneNew", "tabY")]);
        create_records(&roots, &old_id);
        let now = future_old_now();

        let summary = run_retention_once(&roots, now).unwrap();

        assert_eq!(summary, RetentionSummary::default());
        assert!(session_path(&roots, &old_id).join("out.html").is_file());
        assert!(pane_session_path(&roots, &old_id).is_file());
        assert!(!trash_session_path(&roots, now, &old_id).exists());
        assert!(!trash_pane_session_path(&roots, now, &old_id).exists());
    }

    #[test]
    fn missing_moved_tab_old_records_move_to_trash() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let old_id = make_session_id("wsA", "paneOld", "tabZ");
        write_data_json(&roots, "com.miyazaki.mycmux", &[("wsA", "paneNew", "tabX")]);
        create_records(&roots, &old_id);
        let now = future_old_now();

        let summary = run_retention_once(&roots, now).unwrap();

        assert_eq!(summary, RetentionSummary { moved: 2, skipped: 0 });
        assert!(!session_path(&roots, &old_id).exists());
        assert!(!pane_session_path(&roots, &old_id).exists());
        assert!(trash_session_path(&roots, now, &old_id).join("out.html").is_file());
        assert!(trash_pane_session_path(&roots, now, &old_id).is_file());
    }

    #[test]
    fn missing_tab_records_within_retention_stay() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let recent_id = make_session_id("wsA", "paneOld", "tabZ");
        write_data_json(&roots, "com.miyazaki.mycmux", &[]);
        create_records(&roots, &recent_id);
        let now = SystemTime::now() + Duration::from_secs((RETENTION_DAYS - 1) * DAY_SECS);

        let summary = run_retention_once(&roots, now).unwrap();

        assert_eq!(summary, RetentionSummary::default());
        assert!(session_path(&roots, &recent_id).join("out.html").is_file());
        assert!(pane_session_path(&roots, &recent_id).is_file());
        assert!(!trash_session_path(&roots, now, &recent_id).exists());
        assert!(!trash_pane_session_path(&roots, now, &recent_id).exists());
    }

    #[test]
    fn live_session_matching_keeps_stable_ids_and_guards_suffix_fallback() {
        let live_ids = HashSet::from([make_session_id("wsA", "paneNew", "tabX")]);
        let live_tab_ids = HashSet::from(["tabX".to_string()]);

        assert!(is_live_session("pty-wsA-paneNew-tabX", &live_ids, &live_tab_ids));
        assert!(is_live_session("tabX", &live_ids, &live_tab_ids));
        assert!(is_live_session("pty-wsA-paneOld-tabX", &live_ids, &live_tab_ids));
        assert!(!is_live_session("other-wsA-paneOld-tabX", &live_ids, &live_tab_ids));
        assert!(!is_live_session("pty-wsA-paneOld-nottabX", &live_ids, &live_tab_ids));
        assert!(!is_live_session("pty-wsA-paneOld-tabZ", &live_ids, &live_tab_ids));
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
    fn startup_sweep_leaves_scrollback_and_records_after_a_drop_since_the_previous_run() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let app = "com.miyazaki.mycmux";
        let ids = [("ws1", "p1", "tab1"), ("ws2", "p2", "tab2"),
            ("ws3", "p3", "tab3"), ("ws4", "p4", "tab4")];
        let missing = make_session_id("ws4", "p4", "tab4");
        let now = future_old_now();
        write_data_json(&roots, app, &ids);
        write_legacy_scrollback(&roots, app, &missing, b"recent output");
        create_records(&roots, &missing);
        run_retention_once(&roots, now).unwrap();
        write_data_json(&roots, app, &ids[..1]);

        let skipped = run_retention_once(&roots, now).unwrap();

        assert!(scrollback_path(&roots, app, &missing).is_file());
        assert_eq!(skipped.moved, 0);
        assert!(session_path(&roots, &missing).is_dir());
        assert!(pane_session_path(&roots, &missing).is_file());

        // A later scan with the same count is not a new reduction.
        assert_eq!(run_retention_once(&roots, now).unwrap().moved, 2);
        assert!(!scrollback_path(&roots, app, &missing).exists());
    }

    #[test]
    fn startup_sweep_leaves_scrollback_if_one_profile_shrinks_between_probes() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let app = "com.miyazaki.mycmux";
        let ids = [("ws1", "p1", "tab1"), ("ws2", "p2", "tab2"),
            ("ws3", "p3", "tab3"), ("ws4", "p4", "tab4")];
        let missing = make_session_id("ws4", "p4", "tab4");
        write_data_json(&roots, app, &ids);
        write_legacy_scrollback(&roots, app, &missing, b"recent output");

        run_retention_once_with_before_reprobe(&roots, future_old_now(), || {
            write_data_json(&roots, app, &ids[..1]);
            write_data_json(&roots, "com.miyazaki.mycmux-lite", &ids);
            Ok(())
        }).unwrap();

        assert!(scrollback_path(&roots, app, &missing).is_file());
    }

    fn review_layout_with_tabs(count: usize, omit_pane_identity: bool) -> Vec<u8> {
        let tabs = (1..=count).map(|number| serde_json::json!({
            "tab_id": format!("aaaaaaaa-0000-4000-8000-{number:012}"),
            "agent_id": "terminal",
        })).collect::<Vec<_>>();
        let mut pane = serde_json::json!({ "agent_id": "terminal", "tabs": tabs });
        if !omit_pane_identity {
            pane["pane_id"] = serde_json::json!("pane");
        }
        let data: crate::db::storage::PersistentData = serde_json::from_value(serde_json::json!({
            "settings": crate::db::storage::AppSettings::default(),
            "workspaces": [{
                "id": "saved", "name": "Saved", "grid_template_id": "single",
                "created_at": 1, "panes": [pane],
            }]
        })).unwrap();
        serde_json::to_vec(&data).unwrap()
    }

    fn review_layout_paths(roots: &RetentionRoots, directory: &str) -> (PathBuf, PathBuf, PathBuf) {
        let app = roots.app_data_parent.join(directory);
        let backups = app.join("data-backups");
        fs::create_dir_all(&backups).unwrap();
        (app.join("data.json"), backups.join("data-1000-42.json"), app.join("scrollback"))
    }

    #[test]
    fn l3_fix2_01_bom_generation_restores_its_tab_and_scrollback_bytes() {
        use crate::db::storage;
        use crate::pty::scrollback_store;
        let _serial = storage::persistence_test_lock();
        storage::reset_quarantined_schema_for_test();
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let (main, backup, scrollback) = review_layout_paths(&roots, APP_DATA_DIR_PREFIX);
        fs::write(&main, review_layout_with_tabs(9, false)).unwrap();
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend(review_layout_with_tabs(10, false));
        fs::write(backup, bom).unwrap();
        let tab = "aaaaaaaa-0000-4000-8000-000000000010";
        let session = make_session_id("saved", "pane", tab);
        scrollback_store::save(&scrollback, &session, 0, 6, b"output").unwrap();

        run_retention_once(&roots, future_old_now()).unwrap();
        fs::rename(&main, main.with_file_name("missing-main.fixture")).unwrap();
        let restored = storage::load(main.as_path()).unwrap();
        drop(_serial);
        let tabs = restored.workspaces[0].panes[0].tabs.as_ref().unwrap();
        assert_eq!(tabs[9].tab_id.as_deref(), Some(tab));
        assert_eq!(scrollback_store::load(&scrollback, &session).unwrap().data, b"output");
    }

    #[test]
    fn l3_fix2_02_old_tab_identity_does_not_require_a_saved_pane_id() {
        use crate::pty::scrollback_store;
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let (main, backup, scrollback) = review_layout_paths(&roots, APP_DATA_DIR_PREFIX);
        fs::write(&main, review_layout_with_tabs(1, true)).unwrap();
        fs::write(backup, review_layout_with_tabs(2, true)).unwrap();
        for tab_number in 1..=2 {
            let tab = format!("aaaaaaaa-0000-4000-8000-{tab_number:012}");
            let session = make_session_id("saved", "regenerated-pane", &tab);
            scrollback_store::save(&scrollback, &session, 0, 6, b"output").unwrap();
        }
        run_retention_once(&roots, future_old_now()).unwrap();
        for tab_number in 1..=2 {
            let tab = format!("aaaaaaaa-0000-4000-8000-{tab_number:012}");
            let session = make_session_id("saved", "different-pane", &tab);
            assert_eq!(scrollback_store::load(&scrollback, &session).unwrap().data, b"output");
        }
    }

    #[test]
    fn l3_fix2_08_unreadable_backup_directory_cannot_discard_scrollback() {
        use crate::pty::scrollback_store;
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let (main, backup, scrollback) = review_layout_paths(&roots, APP_DATA_DIR_PREFIX);
        fs::write(&main, review_layout_with_tabs(9, false)).unwrap();
        fs::write(&backup, review_layout_with_tabs(10, false)).unwrap();
        let backups = backup.parent().unwrap();
        let temporarily_unavailable = main.with_file_name("unavailable-backups.fixture");
        fs::rename(backups, &temporarily_unavailable).unwrap();
        fs::write(backups, b"directory read cannot succeed").unwrap();
        let session = make_session_id("saved", "pane", "aaaaaaaa-0000-4000-8000-000000000010");
        scrollback_store::save(&scrollback, &session, 0, 6, b"output").unwrap();

        let _sweep = run_retention_once(&roots, future_old_now());
        fs::rename(backups, main.with_file_name("unavailable-file.fixture")).unwrap();
        fs::rename(temporarily_unavailable, backups).unwrap();
        assert!(backup.is_file());
        assert_eq!(scrollback_store::load(&scrollback, &session).unwrap().data, b"output");
    }

    #[test]
    fn l3_fix3_03_a_history_commit_before_the_first_layout_save_survives_startup() {
        use crate::pty::scrollback_store;
        let temp = tempfile::tempdir().unwrap();
        let mut roots = roots(&temp);
        let app = APP_DATA_DIR_PREFIX;
        let tab = "aaaaaaaa-0000-4000-8000-000000000032";
        let session = make_session_id("pending", "pane", tab);
        write_data_json(&roots, app, &[]);
        let path = scrollback_path(&roots, app, tab);
        let directory = path.parent().unwrap();
        let cutoff = SystemTime::now();
        roots.scrollback_startup_cutoff = cutoff;
        let mut written = None;
        assert!(scrollback_store::save_if_changed(directory, &session, 0, 6, b"output", &mut written).unwrap());
        fs::File::options().write(true).open(&path).unwrap()
            .set_modified(cutoff + Duration::from_secs(1)).unwrap();

        run_retention_once(&roots, cutoff).unwrap();
        write_data_json(&roots, app, &[("pending", "pane", tab)]);

        assert!(!scrollback_store::save_if_changed(directory, &session, 0, 6, b"output", &mut written).unwrap());
        assert_eq!(scrollback_store::load(directory, &session).map(|saved| saved.data), Some(b"output".to_vec()));
    }

    #[test]
    fn l3_fix3_08_retention_leaves_history_in_another_profile_for_legacy_writers() {
        use crate::pty::scrollback_store;
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let profile = format!("{APP_DATA_DIR_PREFIX}/profiles/older-writer");
        let tab = "aaaaaaaa-0000-4000-8000-000000000082";
        let session = make_session_id("pending", "pane", tab);
        write_data_json(&roots, APP_DATA_DIR_PREFIX, &[]);
        write_data_json(&roots, &profile, &[]);
        let path = scrollback_path(&roots, &profile, tab);
        let directory = path.parent().unwrap();
        scrollback_store::save(directory, &session, 0, 6, b"output").unwrap();

        run_retention_once_with_reprobe_hooks(&roots, future_old_now(), || Ok(()), |_| {
            // The old writer commits after the real final scan and does not
            // update the history file. No additional scan follows this hook.
            write_data_json(&roots, &profile, &[("pending", "pane", tab)]);
            Ok(())
        }).unwrap();

        assert_eq!(scrollback_store::load(directory, &session).map(|saved| saved.data), Some(b"output".to_vec()));
    }

    #[test]
    fn l3_fix2_25_retention_scans_once_more_before_entering_its_protected_sweep() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let (main, backup, scrollback) = review_layout_paths(&roots, APP_DATA_DIR_PREFIX);
        fs::write(main, review_layout_with_tabs(1, false)).unwrap();
        fs::write(backup, review_layout_with_tabs(1, false)).unwrap();
        let now = future_old_now();
        for number in 0..10 {
            let session = make_session_id("unreferenced", "pane", &format!("orphan-{number}"));
            create_records(&roots, &session);
            crate::pty::scrollback_store::save(&scrollback, &session, 0, 6, b"output").unwrap();
        }
        OBSERVATIONS.with(|count| count.set(0));
        let result = run_retention_once(&roots, now).unwrap();
        assert_eq!(result.moved, 20);
        assert_eq!(fs::read_dir(scrollback).unwrap().count(), 0);
        assert_eq!(OBSERVATIONS.with(|count| count.get()), 2);
    }

    #[test]
    fn l3_fix2_26_diagnostics_do_not_repeat_input_path_components() {
        let temp = tempfile::tempdir().unwrap();
        let app_data_parent = temp.path().join("fictional.editor@example.test");
        let roots = RetentionRoots {
            profile_dir: app_data_parent.join(APP_DATA_DIR_PREFIX),
            app_data_parent,
            mycmux_dir: temp.path().join("runtime"),
            scrollback_startup_cutoff: future_old_now(),
        };
        let (main, backup, _) = review_layout_paths(&roots, APP_DATA_DIR_PREFIX);
        fs::write(&main, review_layout_with_tabs(1, false)).unwrap();
        fs::write(backup.with_file_name("data-1000-42.json"), br#"{"schema_version":999}"#).unwrap();
        let diagnostic = run_retention_once(&roots, SystemTime::now()).unwrap_err();
        assert!(diagnostic.contains("schema"));
        assert!(!diagnostic.contains("fictional.editor@example.test"), "{diagnostic}");
        assert!(!diagnostic.contains("data-1000-42.json"), "{diagnostic}");
    }

    #[test]
    fn l3_fix2_31_backup_only_profile_protects_shared_records() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let (main, _, _) = review_layout_paths(&roots, APP_DATA_DIR_PREFIX);
        fs::write(main, review_layout_with_tabs(0, false)).unwrap();
        let profile = format!("{APP_DATA_DIR_PREFIX}/profiles/BackupOnly");
        let (_, backup, _) = review_layout_paths(&roots, &profile);
        fs::write(backup, review_layout_with_tabs(1, false)).unwrap();
        let session = make_session_id("saved", "pane", "aaaaaaaa-0000-4000-8000-000000000001");
        create_records(&roots, &session);

        run_retention_once(&roots, future_old_now()).unwrap();
        assert!(session_path(&roots, &session).is_dir());
        assert!(pane_session_path(&roots, &session).is_file());
    }

    #[test]
    fn l3_fix2_14_retention_keeps_scrollback_referenced_by_a_recoverable_layout() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let app = "com.miyazaki.mycmux";
        let ids = [("ws1", "pane1", "tab1"), ("ws2", "pane2", "tab2")];
        let session = make_session_id("ws2", "pane2", "tab2");
        write_data_json(&roots, app, &ids);
        write_legacy_scrollback(&roots, app, &session, b"recover this output");
        let app_dir = roots.app_data_parent.join(app);
        let backups = app_dir.join("data-backups");
        fs::create_dir(&backups).unwrap();
        fs::copy(app_dir.join("data.json"), backups.join("data-1000-42.json")).unwrap();
        write_data_json(&roots, app, &ids[..1]);

        run_retention_once(&roots, future_old_now()).unwrap();
        let _serial = crate::db::storage::persistence_test_lock();
        storage::reset_quarantined_schema_for_test();
        let main = app_dir.join("data.json");
        fs::rename(&main, app_dir.join("missing-main.fixture")).unwrap();
        let restored = crate::db::storage::load(main.as_path()).unwrap();
        drop(_serial);
        assert!(restored.workspaces.iter().any(|row| row.id == "ws2"),
            "the backup used by the retention test must also load in the product");
        let history = crate::pty::scrollback_store::load(&app_dir.join("scrollback"), &session)
            .expect("the restored session's history must be readable");
        assert_eq!(history.data, b"recover this output");
    }

    #[test]
    fn l3_88_retention_keeps_legacy_names_and_the_actual_saved_session_key() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let app = "com.miyazaki.mycmux";
        let former_key = "pty-old-pane-legacy-tab";
        let canonical = "aaaaaaaa-0000-4000-8000-000000000001";
        let canonical_upper = canonical.to_ascii_uppercase();
        let primary = serde_json::json!({
            "settings": storage::AppSettings::default(),
            "workspaces": [{"id": "new", "name": "New", "created_at": 0, "grid_template_id": "1x1", "panes": [{
                "pane_id": "pane", "agent_id": "shell", "tabs": [
                    {"tab_id": "other-id", "agent_id": "shell", "session_id": format!("pty-old-pane-{canonical}")},
                    {"tab_id": "legacy-tab", "agent_id": "shell", "session_id": former_key}
                ]
            }]}]
        });
        write_raw_data_json(&roots, app, &primary.to_string());
        write_legacy_scrollback(&roots, app, former_key, b"legacy text");
        write_legacy_scrollback(&roots, app, &canonical_upper, b"stable text");
        run_retention_once(&roots, future_old_now()).unwrap();
        assert!(scrollback_path(&roots, app, former_key).is_file());
        assert!(scrollback_path(&roots, app, &canonical_upper).is_file());
    }

    #[test]
    fn l3_103_corrupt_retention_counts_are_preserved_and_the_next_sweep_runs() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(&temp);
        let app = "com.miyazaki.mycmux";
        write_data_json(&roots, app, &[("ws", "pane", "live")]);
        fs::create_dir_all(&roots.mycmux_dir).unwrap();
        let name = "session-retention-live-tabs.json";
        let checkpoint = roots.mycmux_dir.join(name);
        fs::write(&checkpoint, b"{broken").unwrap();
        let orphan = make_session_id("other", "pane", "old");
        write_legacy_scrollback(&roots, app, &orphan, b"unused output");

        run_retention_once(&roots, future_old_now()).unwrap();
        assert!(scrollback_path(&roots, app, &orphan).exists());
        assert_eq!(read_tab_counts(&checkpoint).unwrap().values().copied().collect::<Vec<_>>(), vec![1]);
        assert_eq!(fs::read(roots.mycmux_dir.join("_old").join(name)).unwrap(), b"{broken");
        run_retention_once(&roots, future_old_now()).unwrap();
        assert!(!scrollback_path(&roots, app, &orphan).exists());
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

        run_retention_once(&roots, future_old_now()).unwrap();

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

        run_retention_once(&roots, future_old_now()).unwrap();

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

        assert!(error.contains("schema version 999"));
        assert!(!error.contains(&data_path.display().to_string()));
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
            |observed| {
                write_data_json(
                    &roots,
                    "com.miyazaki.mycmux",
                    &[("ws-race", "pane-race", "tab-race")],
                );
                // This fixture deliberately bypasses the current profile's
                // gate. Only this injected test performs a third scan.
                if *observed != collect_live_sessions(&roots.app_data_parent)? {
                    return Err("layout changed after the final retention scan; aborting before destructive action".into());
                }
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("changed after the final retention scan"));
        assert!(!error.contains(&data_path.display().to_string()));
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

        assert!(error.contains("invalid main layout"));
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

fn is_live_session(
    session_id: &str,
    live_ids: &HashSet<String>,
    live_tab_ids: &HashSet<String>,
) -> bool {
    // A moved tab keeps its original PTY ID even though data.json stores its new location.
    live_ids.contains(session_id)
        || live_tab_ids.contains(session_id)
        || (session_id.starts_with("pty-")
            && live_tab_ids
                .iter()
                .any(|tab_id| session_id.ends_with(&format!("-{tab_id}"))))
}

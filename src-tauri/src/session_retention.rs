use chrono::{DateTime, Local};
use serde::Deserialize;
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
    scrollback_keep_sets: Vec<(PathBuf, HashSet<String>)>,
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
            Err(error) => eprintln!("[session_retention] skipped: {error}"),
        }
    });
}

fn run_retention_once(roots: &RetentionRoots, now: SystemTime) -> Result<RetentionSummary, String> {
    let live_sessions = collect_live_sessions(&roots.app_data_parent)?;
    for (scrollback_dir, keep) in &live_sessions.scrollback_keep_sets {
        crate::pty::scrollback_store::gc(scrollback_dir, keep)
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
    );
    retain_pane_session_files(
        &roots.mycmux_dir.join(PANE_SESSIONS_DIR),
        &roots
            .mycmux_dir
            .join(TRASH_DIR)
            .join(&trash_month)
            .join(PANE_SESSIONS_DIR),
        &live_sessions.all_ids,
        now,
        max_age,
        &mut summary,
    );

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
        scrollback_keep_sets: Vec::new(),
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
                    let contents = fs::read_to_string(&data_path).map_err(|error| {
                        format!("read {} failed: {error}", data_path.display())
                    })?;
                    let data: RetentionData = serde_json::from_str(&contents).map_err(|error| {
                        format!("parse {} failed: {error}", data_path.display())
                    })?;
                    let mut local_ids = HashSet::new();
                    insert_live_session_ids(&data, &mut local_ids);
                    live_sessions.all_ids.extend(local_ids.iter().cloned());
                    let scrollback_dir = data_path.parent()
                        .ok_or_else(|| format!("data path has no parent: {}", data_path.display()))?
                        .join("scrollback");
                    live_sessions.scrollback_keep_sets.push((scrollback_dir, local_ids));
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

    Ok(live_sessions)
}

fn insert_live_session_ids(data: &RetentionData, live_ids: &mut HashSet<String>) {
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
) {
    let entries = match fs::read_dir(source_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            summary.skipped += 1;
            eprintln!(
                "[session_retention] skipped {}: read_dir failed: {error}",
                source_dir.display()
            );
            return;
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
        move_record(&path, trash_dir, &entry.file_name(), summary);
    }
}

fn retain_pane_session_files(
    source_dir: &Path,
    trash_dir: &Path,
    live_ids: &HashSet<String>,
    now: SystemTime,
    max_age: Duration,
    summary: &mut RetentionSummary,
) {
    let entries = match fs::read_dir(source_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            summary.skipped += 1;
            eprintln!(
                "[session_retention] skipped {}: read_dir failed: {error}",
                source_dir.display()
            );
            return;
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
        if !is_safe_session_record_id(session_id) {
            continue;
        }
        if live_ids.contains(session_id) || !is_older_than(&path, now, max_age) {
            continue;
        }
        move_record(&path, trash_dir, &entry.file_name(), summary);
    }
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
) {
    let target_path = trash_dir.join(file_name);
    if target_path.exists() {
        summary.skipped += 1;
        eprintln!(
            "[session_retention] skipped {}: trash target already exists at {}",
            source_path.display(),
            target_path.display()
        );
        return;
    }
    if let Err(error) = fs::create_dir_all(trash_dir) {
        summary.skipped += 1;
        eprintln!(
            "[session_retention] skipped {}: create trash dir {} failed: {error}",
            source_path.display(),
            trash_dir.display()
        );
        return;
    }
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

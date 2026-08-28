//! Keeping AI CLI transcripts from going missing.
//!
//! Two jobs on one schedule. The **index pass** is the one that matters:
//! the index is incremental and its rows outlive their sources, so a session
//! read once survives codex pruning `~/.codex/sessions` days later. Until
//! this scheduler existed the only trigger was opening the AI log panel.
//!
//! The **full-text mirror** then copies whole sources off this machine, to a
//! configured directory (Google Drive by default), gzipped and replaced
//! atomically whenever a source grows. The local metadata tier is disabled --
//! see `tier1_applies` for the collision that makes it harmful.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, TryLockError};
use std::time::{Duration, UNIX_EPOCH};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use sysinfo::Disks;
use tauri::AppHandle;

use crate::ailog::{
    KIND_CLAUDE, KIND_CLAUDE_CODEX, KIND_CODEX, KIND_GROK,
};
use crate::util::atomic_write::AtomicWrite;

pub const WARNING_TIER2_LOW_SPACE: &str = "ailog.mirror.warning.tier2_low_space";
pub const WARNING_TIER2_SPACE_UNKNOWN: &str = "ailog.mirror.warning.tier2_space_unknown";

const TIER2_FREE_SPACE_FLOOR: u64 = 10 * 1024 * 1024 * 1024;
// Far enough after launch that the first index pass does not land while the
// window is still painting and the shells are still starting: a pass stats
// roughly 22,000 files, and this app's startup cost is already something
// users notice.
const INITIAL_DELAY: Duration = Duration::from_secs(120);
const RUN_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const STATE_FILE_NAME: &str = ".mirror-state.json";

#[derive(Debug, Clone)]
pub(crate) struct MirrorConfig {
    pub sources: Vec<(&'static str, PathBuf)>,
    pub tier1_root: PathBuf,
    pub tier2_root: Option<PathBuf>,
    pub state_path: PathBuf,
}

impl MirrorConfig {
    fn configured(app_handle: &AppHandle) -> Result<Self, String> {
        let tier1_root = crate::ailog::archive_root()
            .ok_or_else(|| "ailog mirror home directory is unavailable".to_string())?;
        let tier2_root = crate::db::storage::load(app_handle)
            .ok()
            .and_then(|data| data.settings.ailog_mirror_full_text_root)
            .and_then(|value| {
                let trimmed = value.trim();
                (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
            });
        Ok(Self {
            sources: default_sources(),
            state_path: tier1_root.join(STATE_FILE_NAME),
            tier1_root,
            tier2_root,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MirrorReport {
    pub tier1_written: usize,
    pub tier1_skipped_unchanged: usize,
    /// Sources whose CLI keeps its own logs, so there is nothing to rescue.
    pub tier1_skipped_kind: usize,
    pub tier2_written: usize,
    pub tier2_skipped_unchanged: usize,
    pub tier2_skipped_space: usize,
    pub warning_code: Option<String>,
    pub errors: Vec<String>,
    pub busy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SourceStamp {
    size: u64,
    mtime_ns: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SourceMirrorState {
    tier1: Option<SourceStamp>,
    tier2: Option<SourceStamp>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct MirrorState {
    #[serde(default)]
    sources: HashMap<String, SourceMirrorState>,
}

fn run_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn warning_state() -> &'static Mutex<Option<String>> {
    static WARNING: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    WARNING.get_or_init(|| Mutex::new(None))
}

pub fn last_warning_code() -> Option<String> {
    warning_state()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

fn set_warning(code: Option<String>) {
    *warning_state()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = code;
}

/// Keep the index current, and keep a full-text copy off this machine.
///
/// The index is incremental and its rows outlive their source files, so a
/// session that has been read once survives codex pruning `~/.codex/sessions`
/// a few days later. What does *not* survive is a session the index never got
/// to — and until now the only thing that started an index run was opening the
/// AI log panel. Five quiet days and the window closed on data nobody had read.
///
/// So the schedule runs the index first and mirrors second. Mirroring is
/// best-effort insurance; indexing is what actually keeps the analysis whole.
pub fn start_scheduler(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let start = tokio::time::Instant::now() + INITIAL_DELAY;
        let mut interval = tokio::time::interval_at(start, RUN_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            run_index_pass(&app_handle).await;
            let app_handle = app_handle.clone();
            let result = tauri::async_runtime::spawn_blocking(move || run_configured(&app_handle)).await;
            match result {
                Ok(report) => {
                    for error in report.errors {
                        crate::diag_warn!("ailog_mirror", "{error}");
                    }
                }
                Err(error) => {
                    crate::diag_warn!("ailog_mirror", "mirror task failed: {error}");
                }
            }
        }
    });
}

/// One incremental index pass. A run already in flight (the user opened the
/// panel, or the previous tick is still going) is left alone rather than
/// queued: the next tick will find whatever it did not reach.
async fn run_index_pass(app_handle: &AppHandle) {
    // Incremental, never a full rebuild: a scheduled pass must not spend an
    // hour re-reading everything behind the user's back.
    let args = crate::commands::ailog::IndexStartArgs { full: false };
    match crate::commands::ailog::ailog_index_start(app_handle.clone(), args).await {
        Ok(result) if result.already_running => {
            crate::diag_warn!("ailog_mirror", "index already running; skipping this tick");
        }
        Ok(_) => {}
        Err(error) => crate::diag_warn!("ailog_mirror", "scheduled index failed: {error}"),
    }
}

fn run_configured(app_handle: &AppHandle) -> MirrorReport {
    let config = match MirrorConfig::configured(app_handle) {
        Ok(config) => config,
        Err(error) => {
            return MirrorReport {
                errors: vec![error],
                ..Default::default()
            };
        }
    };
    run_guarded_with(&config, &SystemFreeSpace)
}

pub(crate) trait FreeSpace {
    fn available_bytes(&self, destination: &Path) -> Option<u64>;
}

struct SystemFreeSpace;

impl FreeSpace for SystemFreeSpace {
    fn available_bytes(&self, destination: &Path) -> Option<u64> {
        let target = path_comparison_key(destination);
        Disks::new_with_refreshed_list()
            .list()
            .iter()
            .filter_map(|disk| {
                let mount = path_comparison_key(disk.mount_point());
                target
                    .starts_with(&mount)
                    .then_some((mount.len(), disk.available_space()))
            })
            .max_by_key(|(length, _)| *length)
            .map(|(_, available)| available)
    }
}

fn path_comparison_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(target_os = "windows") {
        value.to_lowercase()
    } else {
        value
    }
}

fn run_guarded_with(config: &MirrorConfig, free_space: &dyn FreeSpace) -> MirrorReport {
    let _guard = match run_lock().try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::WouldBlock) => {
            return MirrorReport {
                busy: true,
                ..Default::default()
            };
        }
        Err(TryLockError::Poisoned(error)) => error.into_inner(),
    };
    let report = run_once_with(config, free_space);
    set_warning(report.warning_code.clone());
    report
}

pub(crate) fn run_once_with(config: &MirrorConfig, free_space: &dyn FreeSpace) -> MirrorReport {
    let mut report = MirrorReport::default();
    let mut state = match load_state(&config.state_path) {
        Ok(state) => state,
        Err(error) => {
            report.errors.push(error);
            MirrorState::default()
        }
    };
    let tier2_enabled = match config.tier2_root.as_deref() {
        None => false,
        Some(root) => match free_space.available_bytes(root) {
            Some(bytes) if bytes >= TIER2_FREE_SPACE_FLOOR => true,
            Some(_) => {
                report.warning_code = Some(WARNING_TIER2_LOW_SPACE.to_string());
                false
            }
            None => {
                report.warning_code = Some(WARNING_TIER2_SPACE_UNKNOWN.to_string());
                false
            }
        },
    };
    let mut state_changed = false;

    for (kind, source_root) in &config.sources {
        let mut sources = Vec::new();
        collect_sources(
            source_root,
            &mut sources,
            (*kind == KIND_GROK).then_some("updates.jsonl"),
        );
        for source in sources {
            let Ok(before) = source_stamp(&source) else {
                continue;
            };
            let key = format!("{kind}\u{0}{}", source.to_string_lossy());
            let source_state = state.sources.entry(key).or_default();
            if !tier1_applies(kind) {
                report.tier1_skipped_kind += 1;
            } else {
            let tier1_destination = match mirror_destination(
                source_root,
                &source,
                &config.tier1_root,
                kind,
            ) {
                Ok(path) => path,
                Err(error) => {
                    report.errors.push(error);
                    continue;
                }
            };
            if source_state.tier1.as_ref() == Some(&before) && tier1_destination.is_file() {
                report.tier1_skipped_unchanged += 1;
            } else {
                match write_metadata_gzip(&source, &tier1_destination) {
                    Ok(()) => {
                        report.tier1_written += 1;
                        if source_stamp(&source).ok().as_ref() == Some(&before) {
                            source_state.tier1 = Some(before.clone());
                            state_changed = true;
                        }
                    }
                    Err(error) => report.errors.push(error),
                }
            }
            }

            let Some(tier2_root) = config.tier2_root.as_deref() else {
                continue;
            };
            if !tier2_enabled {
                report.tier2_skipped_space += 1;
                continue;
            }
            let tier2_destination = match mirror_destination(
                source_root,
                &source,
                tier2_root,
                kind,
            ) {
                Ok(path) => path,
                Err(error) => {
                    report.errors.push(error);
                    continue;
                }
            };
            if source_state.tier2.as_ref() == Some(&before) && tier2_destination.is_file() {
                report.tier2_skipped_unchanged += 1;
            } else {
                match write_full_gzip(&source, &tier2_destination) {
                    Ok(()) => {
                        report.tier2_written += 1;
                        if source_stamp(&source).ok().as_ref() == Some(&before) {
                            source_state.tier2 = Some(before);
                            state_changed = true;
                        }
                    }
                    Err(error) => report.errors.push(error),
                }
            }
        }
    }

    if state_changed {
        if let Err(error) = save_state(&config.state_path, &state) {
            report.errors.push(error);
        }
    }
    report
}

fn default_sources() -> Vec<(&'static str, PathBuf)> {
    [
        (KIND_CLAUDE, crate::ailog::claude_root()),
        (KIND_CLAUDE_CODEX, crate::ailog::claude_codex_root()),
        (KIND_CODEX, crate::ailog::codex_root()),
        (KIND_GROK, crate::ailog::grok_root()),
    ]
    .into_iter()
    .filter_map(|(kind, root)| root.map(|root| (kind, root)))
    .collect()
}

fn collect_sources(root: &Path, output: &mut Vec<PathBuf>, file_name: Option<&str>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => collect_sources(&path, output, file_name),
            Ok(file_type) if file_type.is_file() => {
                if path.extension().and_then(|value| value.to_str()) == Some("jsonl")
                    && file_name.map_or(true, |name| {
                        path.file_name().and_then(|value| value.to_str()) == Some(name)
                    })
                {
                    output.push(path);
                }
            }
            _ => {}
        }
    }
}

pub(crate) fn mirror_destination(
    source_root: &Path,
    source: &Path,
    tier_root: &Path,
    kind: &str,
) -> Result<PathBuf, String> {
    let relative = source.strip_prefix(source_root).map_err(|_| {
        format!(
            "ailog mirror source is outside its root: {}",
            source.display()
        )
    })?;
    let file_name = relative
        .file_name()
        .ok_or_else(|| format!("ailog mirror source has no file name: {}", source.display()))?;
    let mut destination = tier_root.join(kind).join(relative);
    let mut gzip_name = file_name.to_os_string();
    gzip_name.push(".gz");
    destination.set_file_name(gzip_name);
    Ok(destination)
}

pub(crate) fn write_metadata_gzip(source: &Path, destination: &Path) -> Result<(), String> {
    AtomicWrite::new("ailog metadata mirror", "failed to replace ailog metadata mirror")
        .create_parents()
        .write_with(destination, |file| {
            let input = File::open(source)
                .map_err(|error| format!("failed to open ailog source {}: {error}", source.display()))?;
            let mut reader = BufReader::new(input);
            let mut encoder = GzEncoder::new(file, Compression::default());
            let mut record = Vec::new();
            loop {
                record.clear();
                let read = reader
                    .read_until(b'\n', &mut record)
                    .map_err(|error| format!("failed to read ailog source {}: {error}", source.display()))?;
                if read == 0 {
                    break;
                }
                if !record.ends_with(b"\n") {
                    break;
                }
                let json_bytes = record
                    .strip_suffix(b"\n")
                    .unwrap_or(&record)
                    .strip_suffix(b"\r")
                    .unwrap_or_else(|| record.strip_suffix(b"\n").unwrap_or(&record));
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(json_bytes) else {
                    continue;
                };
                if is_metadata_record(&value) {
                    encoder.write_all(&record).map_err(|error| {
                        format!("failed to write ailog metadata mirror {}: {error}", destination.display())
                    })?;
                }
            }
            encoder.try_finish().map_err(|error| {
                format!("failed to finish ailog metadata mirror {}: {error}", destination.display())
            })
        })
}

/// The local metadata tier is disabled, and this is the note explaining why so
/// nobody re-enables it without reading the collision first.
///
/// `~/.mycmux/ailog-archive/` already has an owner: `session_archive.py` writes
/// **full-text** gzip there before it offloads and deletes a transcript, and it
/// skips any destination whose mtime is already newer than the source:
///
/// ```text
/// if target.is_file() and target.stat().st_mtime >= path.stat().st_mtime:
///     continue
/// ```
///
/// A metadata-only copy written here first therefore does not merely sit beside
/// the full-text one — it *prevents* it, permanently, and the loss is silent.
/// The index is incremental and its rows survive their sources, so the honest
/// fix for vanishing codex logs is running the index often enough (see
/// `start_scheduler`), not racing another tool for the same filenames.
fn tier1_applies(_kind: &str) -> bool {
    false
}

fn is_metadata_record(value: &serde_json::Value) -> bool {
    match value.get("type").and_then(serde_json::Value::as_str) {
        Some("session_meta" | "turn_context") => true,
        Some("event_msg") => value
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(serde_json::Value::as_str)
            == Some("token_count"),
        _ => false,
    }
}

fn write_full_gzip(source: &Path, destination: &Path) -> Result<(), String> {
    AtomicWrite::new("ailog full mirror", "failed to replace ailog full mirror")
        .create_parents()
        .write_with(destination, |file| {
            let mut input = File::open(source)
                .map_err(|error| format!("failed to open ailog source {}: {error}", source.display()))?;
            let mut encoder = GzEncoder::new(file, Compression::default());
            std::io::copy(&mut input, &mut encoder).map_err(|error| {
                format!("failed to write ailog full mirror {}: {error}", destination.display())
            })?;
            encoder.try_finish().map_err(|error| {
                format!("failed to finish ailog full mirror {}: {error}", destination.display())
            })
        })
}

fn source_stamp(path: &Path) -> Result<SourceStamp, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to stat ailog source {}: {error}", path.display()))?;
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    Ok(SourceStamp {
        size: metadata.len(),
        mtime_ns,
    })
}

fn load_state(path: &Path) -> Result<MirrorState, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("failed to parse ailog mirror state {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(MirrorState::default()),
        Err(error) => Err(format!("failed to read ailog mirror state {}: {error}", path.display())),
    }
}

fn save_state(path: &Path, state: &MirrorState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("failed to encode ailog mirror state: {error}"))?;
    AtomicWrite::new("ailog mirror state", "failed to replace ailog mirror state")
        .create_parents()
        .write_bytes(path, &bytes)
}

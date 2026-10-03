use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
};

const LIMIT: u64 = 1024 * 1024;
static LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrabbedKind {
    #[default]
    Pane,
    Tab,
    Workspace,
}
fn one_pane() -> usize {
    1
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    KeptWindow,
    Docked,
    EscCancelled,
    FailedRestored,
    Reordered,
    CancelledBeforeTearout,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    PrepareFailed,
    ShowFailed,
    NativeMoveFailed,
    ReceiveFailed,
    DockFailed,
    RollbackFailed,
    UnexpectedFailure,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DestinationKind {
    TabStrip,
    Center,
    Left,
    Right,
    Up,
    Down,
    Sidebar,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Destination {
    kind: DestinationKind,
    index: Option<usize>,
    workspace_id: Option<String>,
    pane_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DragRecord {
    drag_id: String,
    pane_id: String,
    source_window: String,
    switch_on: bool,
    down_at: u64,
    #[serde(default)]
    grabbed_kind: GrabbedKind,
    #[serde(default = "one_pane")]
    pane_count: usize,
    outside_at: Option<u64>,
    shown_at: Option<u64>,
    visible_at: Option<u64>,
    native_started_at: Option<u64>,
    hover_started_at: Option<u64>,
    highlighted_at: Option<u64>,
    receiver_window: Option<String>,
    released_at: Option<u64>,
    esc_at: Option<u64>,
    layout_done_at: u64,
    result: Outcome,
    destination: Option<Destination>,
    session_id_equal: Option<bool>,
    scale: Option<f64>,
    monitor: Option<String>,
    focus_stolen: bool,
    errors: Vec<ErrorCode>,
}

impl DragRecord {
    pub fn docked(mut self) -> Self {
        self.result = Outcome::Docked;
        self.layout_done_at = super::unix_ms();
        self
    }
}

fn identifier(value: &str) -> String {
    value
        .chars()
        .take(128)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn line(mut record: DragRecord, profile: &str) -> Result<Vec<u8>, String> {
    record.drag_id = identifier(&record.drag_id);
    record.pane_id = identifier(&record.pane_id);
    record.source_window = identifier(&record.source_window);
    record.receiver_window = record.receiver_window.map(|id| identifier(&id));
    if let Some(destination) = &mut record.destination {
        destination.workspace_id = destination.workspace_id.take().map(|id| identifier(&id));
        destination.pane_id = destination.pane_id.take().map(|id| identifier(&id));
    }
    record.monitor = record
        .monitor
        .map(|name| name.chars().filter(|c| !c.is_control()).take(80).collect());
    record.scale = record
        .scale
        .filter(|scale| scale.is_finite() && *scale > 0.0 && *scale <= 16.0);
    record.errors.truncate(8);
    let mut value = serde_json::to_value(record).map_err(|e| e.to_string())?;
    value["profile"] = serde_json::Value::String(identifier(profile));
    value["recorded_at"] = serde_json::json!(super::unix_ms());
    let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn append_named(root: &Path, stem: &str, bytes: &[u8], limit: u64) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let current = root.join(format!("{stem}.jsonl"));
    if current.metadata().map(|m| m.len()).unwrap_or(0) + bytes.len() as u64 > limit
        && current.exists()
    {
        // Keep every rotated file: the operational evidence is never deleted.
        let stamp = super::unix_ms();
        let mut index = 0;
        let archived = loop {
            let candidate = root.join(format!("{stem}-{stamp}-{index}.jsonl"));
            if !candidate.exists() {
                break candidate;
            }
            index += 1;
        };
        fs::rename(&current, archived).map_err(|e| e.to_string())?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(current)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|e| e.to_string())
}

// A hard aggregate cap for performance evidence; never delete older records.
// Ordinary operational drag records retain their existing rotation contract.
const PERFORMANCE_BUDGET: u64 = 8 * 1024 * 1024;
fn append_performance(root: &Path, bytes: &[u8], budget: u64) -> Result<(), String> {
    let stored: u64 = fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("tearout-performance")
                && entry.file_name().to_string_lossy().ends_with(".jsonl")
        })
        .filter_map(|entry| entry.metadata().ok().map(|metadata| metadata.len()))
        .sum();
    if stored.saturating_add(bytes.len() as u64) > budget {
        return Err("tearout_performance_storage_full".into());
    }
    append_named(root, "tearout-performance", bytes, LIMIT)
}

#[cfg(test)]
fn append(root: &Path, bytes: &[u8], limit: u64) -> Result<(), String> {
    append_named(root, "tearout-log", bytes, limit)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PerformanceKind {
    TearoutPerformance,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerformanceRecord {
    kind: PerformanceKind,
    drag_id: String,
    window_label: String,
    frames: Option<super::performance::Distribution>,
    native: Option<super::performance::NativeSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum LogRecord {
    Drag(DragRecord),
    Performance(PerformanceRecord),
}
impl From<DragRecord> for LogRecord {
    fn from(record: DragRecord) -> Self {
        Self::Drag(record)
    }
}

fn performance_line(mut record: PerformanceRecord, profile: &str) -> Result<Vec<u8>, String> {
    record.drag_id = identifier(&record.drag_id);
    record.window_label = identifier(&record.window_label);
    let mut value = serde_json::to_value(record).map_err(|e| e.to_string())?;
    value["profile"] = serde_json::json!(identifier(profile));
    value["recorded_at"] = serde_json::json!(super::unix_ms());
    let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub(super) fn native_summary(
    id: String,
    label: String,
    summary: super::performance::NativeSummary,
) {
    // Called after the move, on its sampler/probe thread, never the UI thread.
    let Ok(root) = crate::test_profile::runtime_dir() else {
        return;
    };
    let profile = crate::test_profile::name().unwrap_or("default");
    let record = PerformanceRecord {
        kind: PerformanceKind::TearoutPerformance,
        drag_id: id,
        window_label: label,
        frames: None,
        native: Some(summary),
    };
    if let Ok(bytes) = performance_line(record, profile) {
        if let Ok(_guard) = LOG_LOCK.lock() {
            if append_performance(&root, &bytes, PERFORMANCE_BUDGET).is_err() {
                eprintln!("[tearout] native summary write failed");
            }
        }
    }
}

#[tauri::command]
pub async fn tearout_log_record(record: LogRecord) -> Result<(), String> {
    let root = crate::test_profile::runtime_dir()?;
    let profile = crate::test_profile::name().unwrap_or("default").to_owned();
    tokio::task::spawn_blocking(move || {
        let _guard = LOG_LOCK
            .lock()
            .map_err(|_| "tearout_log_lock_failed".to_string())?;
        match record {
            LogRecord::Drag(record) => {
                append_named(&root, "tearout-log", &line(record, &profile)?, LIMIT)
            }
            LogRecord::Performance(record) => append_performance(
                &root,
                &performance_line(record, &profile)?,
                PERFORMANCE_BUDGET,
            ),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> DragRecord {
        serde_json::from_value(serde_json::json!({
            "drag_id": "drag", "pane_id": "tab", "source_window": "main", "switch_on": true,
            "down_at": 10, "outside_at": 20, "shown_at": 21, "visible_at": 22,
            "native_started_at": 25, "highlighted_at": null, "receiver_window": null,
            "released_at": 100, "layout_done_at": 110, "result": "kept_window", "destination": null,
            "session_id_equal": true, "scale": 1.5, "monitor": "DISPLAY1", "focus_stolen": false, "errors": []
        })).unwrap()
    }
    #[test]
    fn log_has_profile_timing_and_only_whitelisted_metadata() {
        let bytes = line(record(), "perf3").unwrap();
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["profile"], "perf3");
        assert_eq!(value["session_id_equal"], true);
        assert!(value.get("recorded_at").is_some());
        let mut injected = serde_json::to_value(record()).unwrap();
        injected["terminal_output"] = serde_json::json!("SECRET");
        assert!(serde_json::from_value::<DragRecord>(injected).is_err());
    }
    #[test]
    fn log_records_all_three_grabbed_kinds_and_transported_session_count() {
        for (kind, count) in [("pane", 1), ("tab", 3), ("workspace", 8)] {
            let mut value = serde_json::to_value(record()).unwrap();
            value["grabbed_kind"] = serde_json::json!(kind);
            value["pane_count"] = serde_json::json!(count);
            let bytes = line(serde_json::from_value(value).unwrap(), "i3").unwrap();
            let actual: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(actual["grabbed_kind"], kind);
            assert_eq!(actual["pane_count"], count);
        }
    }
    #[test]
    fn performance_records_are_typed_and_rotate_separately() {
        let record = serde_json::json!({ "kind": "tearout_performance", "drag_id": "drag",
            "window_label": "receiver", "frames": {"count": 2, "median": 16.75,
                "p95": 33.5, "max": 33.4, "over20": 1, "over33": 1}, "native": null });
        let parsed: LogRecord = serde_json::from_value(record.clone()).unwrap();
        let LogRecord::Performance(parsed) = parsed else {
            panic!("wrong record kind");
        };
        let bytes = performance_line(parsed, "t1test").unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["frames"]["count"], 2);
        assert_eq!(value["profile"], "t1test");
        let mut injected = record;
        injected["terminal_output"] = serde_json::json!("SECRET");
        assert!(serde_json::from_value::<LogRecord>(injected).is_err());
        let dir = tempfile::tempdir().unwrap();
        append_named(
            dir.path(),
            "tearout-performance",
            &bytes,
            bytes.len() as u64 + 1,
        )
        .unwrap();
        append_named(
            dir.path(),
            "tearout-performance",
            &bytes,
            bytes.len() as u64 + 1,
        )
        .unwrap();
        let files: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|p| p.unwrap().path())
            .collect();
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|p| p
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("tearout-performance")));
        assert!(!dir.path().join("tearout-log.jsonl").exists());
    }
    #[test]
    fn performance_storage_has_a_hard_cap_without_deleting_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"{\"kind\":\"tearout_performance\"}\n";
        append_performance(dir.path(), bytes, bytes.len() as u64 * 2).unwrap();
        append_performance(dir.path(), bytes, bytes.len() as u64 * 2).unwrap();
        assert_eq!(
            append_performance(dir.path(), bytes, bytes.len() as u64 * 2).unwrap_err(),
            "tearout_performance_storage_full"
        );
        assert_eq!(
            fs::read(dir.path().join("tearout-performance.jsonl")).unwrap(),
            bytes.repeat(2)
        );
    }
    #[test]
    fn rotation_preserves_old_lines_and_appends_whole_records() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = line(record(), "test").unwrap();
        append(dir.path(), &bytes, bytes.len() as u64 + 1).unwrap();
        append(dir.path(), &bytes, bytes.len() as u64 + 1).unwrap();
        let paths: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(paths.len(), 2);
        for path in paths {
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert!(path.metadata().unwrap().len() <= bytes.len() as u64 + 1);
        }
    }
}

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
    HandedOff,
    HandoffFailed,
    Docked,
    EscCancelled,
    FailedRestored,
    Reordered,
    CancelledBeforeTearout,
    RejectedBusy,
    RestoreFailed,
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
    MoveBusy,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DestinationKind {
    Handoff,
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
#[serde(rename_all = "snake_case")]
enum InputSurface { Band, Strip, Sidebar }
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InputEvidence { pointer_id: i64, event_at: f64, trusted: bool, surface: InputSurface }
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseEvidence { point: super::release::ReleasePoint, receiver_window: Option<String>, receiver_epoch: Option<u64>, client_x: Option<f64>, client_y: Option<f64> }
static INPUT_EVIDENCE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FailureCheckpoint { Consume, ReceiverValidation, ReceiptTimeout, AttachmentTimeout, Other }
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReleaseDecision { NoReceiver, NoHit, LayoutChanged, Expired, ReceiptTimeout, Approved,
    NoReleasePoint, EscCancelled, ReceiverTimeout, Cancelled, IdentityChanged }
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ConsumeFailureReason { Expired, ReceiverChanged, ReleaseIdChanged, TargetChanged, LayoutChanged,
    SenderChanged, NotApproved, AlreadyConsumed, Disposed, BackendRejected }
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DockSide { Child, Receiver }
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DockStageName {
    PrepareWait, Prepared, PhaseShown, PhaseCommitted, PublishWait, Published, DeliverySent,
    ReceiptWait, Receipt, AttachmentPreparedWait, AttachmentPrepared, ConsumeWait, Consumed,
    SessionAliveWait, SessionAlive, Layout, AttachmentWait, Attached,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RefusalSource { Band, Pointer, Phase, ObservedMove, Incoming, BackendPreOwnership, BackendRelease, BackendTransfer }
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BlockerPhase { Moving, Restoring }
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DockStage { side: DockSide, stage: DockStageName, at: u64 }

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DragRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_evidence: Option<InputEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    release_point: Option<ReleaseEvidence>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start_alignment: Option<super::geometry::StartAlignment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_start_delay_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refusal_source: Option<RefusalSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blocker_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blocker_phase: Option<BlockerPhase>,
    hover_started_at: Option<u64>,
    highlighted_at: Option<u64>,
    receiver_window: Option<String>,
    released_at: Option<u64>,
    #[serde(default)]
    released: bool,
    #[serde(default)]
    failure_reason: Option<String>,
    #[serde(default)]
    failure_phase: Option<String>,
    #[serde(default)]
    failed_session_ids: Vec<String>,
    esc_at: Option<u64>,
    layout_done_at: u64,
    result: Outcome,
    destination: Option<Destination>,
    #[serde(default)]
    attempted_destination: Option<Destination>,
    #[serde(default)]
    failure_checkpoint: Option<FailureCheckpoint>,
    #[serde(default)]
    recovery_reason: Option<String>,
    #[serde(default)]
    revoke_reason: Option<String>,
    #[serde(default)]
    receiver_cleanup_reason: Option<String>,
    #[serde(default)]
    release_cancel_reason: Option<String>,
    #[serde(default)]
    restore_unconfirmed: bool,
    #[serde(default)]
    release_receiver_window: Option<String>,
    #[serde(default)]
    transferred_session_ids: Vec<String>,
    #[serde(default)]
    failure_phase_before_restore: Option<String>,
    #[serde(default)]
    consume_failure_reason: Option<ConsumeFailureReason>,
    #[serde(default)]
    dock_stages: Vec<DockStage>,
    #[serde(default)]
    highlight_at_release: Option<bool>,
    #[serde(default)]
    highlight_cleared_at: Option<u64>,
    #[serde(default)]
    release_decision: Option<ReleaseDecision>,
    #[serde(default)]
    release_target_kind: Option<DestinationKind>,
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

fn retain_input_evidence(record: &mut DragRecord, test_profile: bool, within_budget: bool) {
    if !test_profile || !within_budget {
        record.input_evidence = None; record.release_point = None;
    }
}

fn line(mut record: DragRecord, profile: &str) -> Result<Vec<u8>, String> {
    let has_evidence = record.input_evidence.is_some() || record.release_point.is_some();
    let within_budget = !has_evidence || INPUT_EVIDENCE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < 256;
    retain_input_evidence(&mut record, crate::test_profile::is_active(), within_budget);
    record.drag_id = identifier(&record.drag_id);
    record.pane_id = identifier(&record.pane_id);
    record.source_window = identifier(&record.source_window);
    record.blocker_id = record.blocker_id.map(|id| identifier(&id));
    record.receiver_window = record.receiver_window.map(|id| identifier(&id));
    record.release_receiver_window = record.release_receiver_window.map(|id| identifier(&id));
    if let Some(evidence) = &mut record.release_point { evidence.receiver_window = evidence.receiver_window.take().map(|id| identifier(&id)); }
    for destination in [&mut record.destination, &mut record.attempted_destination].into_iter().flatten() {
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
    record.failure_reason = record.failure_reason.map(|reason| identifier(&reason));
    record.recovery_reason = record.recovery_reason.map(|reason| identifier(&reason));
    record.revoke_reason = record.revoke_reason.map(|reason| identifier(&reason));
    record.receiver_cleanup_reason = record.receiver_cleanup_reason.map(|reason| identifier(&reason));
    record.release_cancel_reason = record.release_cancel_reason.map(|reason| identifier(&reason));
    record.failure_phase = record.failure_phase.map(|phase| identifier(&phase));
    record.failure_phase_before_restore = record.failure_phase_before_restore.map(|phase| identifier(&phase));
    record.failed_session_ids.truncate(256);
    record.failed_session_ids = record.failed_session_ids.into_iter().map(|id| identifier(&id)).collect();
    record.transferred_session_ids.truncate(256);
    record.transferred_session_ids = record.transferred_session_ids.into_iter().map(|id| identifier(&id)).collect();
    record.released = record.released_at.is_some();
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

/// An isolated test profile may opt into bounded input/release correlation.
/// No production pointer coordinates or terminal contents are recorded.
#[tauri::command]
pub async fn tearout_input_evidence_enabled() -> bool {
    if !crate::test_profile::is_active() { return false; }
    tokio::task::spawn_blocking(|| {
        crate::test_profile::runtime_dir().ok()
            .and_then(|root| fs::read(root.join("tearout-diagnostics.json")).ok())
            .filter(|bytes| bytes.len() <= 4096)
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|value| value["input_release"].as_bool() == Some(true))
    }).await.unwrap_or(false)
}

#[tauri::command]
pub async fn tearout_log_record(record: serde_json::Value) -> Result<(), String> {
    match serde_json::from_value::<LogRecord>(record) {
        Ok(record) => write_record(record).await,
        Err(error) => {
            eprintln!("[tearout] invalid diagnostic record discarded: {error}");
            Ok(())
        }
    }
}

pub(super) async fn write_record(record: LogRecord) -> Result<(), String> {
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
    const SHARED_SAMPLE: &str = include_str!("../../../tests/fixtures/tearout-drag-record.sample.json");

    #[test]
    fn regrab_diagnostics_roundtrip_shared_sample_and_legacy_records() {
        let sample: serde_json::Value = serde_json::from_str(SHARED_SAMPLE).unwrap();
        for source in ["band", "pointer", "phase", "observed_move", "incoming", "backend_pre_ownership", "backend_release", "backend_transfer"] {
            for phase in ["moving", "restoring"] {
                let mut value = sample.clone();
                value["refusal_source"] = serde_json::json!(source);
                value["blocker_phase"] = serde_json::json!(phase);
                let actual = serde_json::to_value(serde_json::from_value::<DragRecord>(value.clone()).unwrap()).unwrap();
                for key in ["refusal_source", "blocker_id", "blocker_phase", "native_start_delay_ms"] {
                    assert_eq!(actual[key], value[key], "{key}");
                }
            }
        }
        assert!(serde_json::from_str::<LogRecord>(SHARED_SAMPLE).is_ok());
        let mut old = sample;
        for key in ["refusal_source", "blocker_id", "blocker_phase", "native_start_delay_ms"] {
            old.as_object_mut().unwrap().remove(key);
        }
        let parsed: DragRecord = serde_json::from_value(old).unwrap();
        assert!(parsed.refusal_source.is_none() && parsed.blocker_id.is_none() && parsed.blocker_phase.is_none());
        assert!(parsed.native_start_delay_ms.is_none());
        let serialized = serde_json::to_value(parsed).unwrap();
        for key in ["refusal_source", "blocker_id", "blocker_phase", "native_start_delay_ms"] {
            assert!(serialized.get(key).is_none());
        }
        let mut unsafe_id: DragRecord = serde_json::from_str(SHARED_SAMPLE).unwrap();
        unsafe_id.blocker_id = Some("private C:/path\n".repeat(50));
        let bounded: serde_json::Value = serde_json::from_slice(&line(unsafe_id, "test").unwrap()).unwrap();
        let blocker = bounded["blocker_id"].as_str().unwrap();
        assert_eq!(blocker.len(), 128);
        assert!(blocker.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')));
    }

    #[tokio::test]
    async fn log_record_discards_unknown_or_unreadable_diagnostics_without_failing() {
        let mut sample: serde_json::Value = serde_json::from_str(SHARED_SAMPLE).unwrap();
        sample["unknown_future_field"] = serde_json::json!(true);
        assert!(serde_json::from_value::<LogRecord>(sample.clone()).is_err());
        assert!(tearout_log_record(sample).await.is_ok());
        for value in [serde_json::Value::Null, serde_json::json!({ "drag_id": 42 }), serde_json::json!([])] {
            assert!(tearout_log_record(value).await.is_ok());
        }
    }
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
    fn review2_diagnostics_roundtrip_and_old_records_default_new_fields() {
        let old = serde_json::json!({
            "drag_id": "drag", "pane_id": "tab", "source_window": "main", "switch_on": true,
            "down_at": 10, "layout_done_at": 110, "result": "kept_window", "focus_stolen": false, "errors": []
        });
        let parsed: DragRecord = serde_json::from_value(old.clone()).unwrap();
        assert!(!parsed.restore_unconfirmed);
        assert!(parsed.transferred_session_ids.is_empty());
        assert!(parsed.receiver_cleanup_reason.is_none() && parsed.release_cancel_reason.is_none());
        assert!(parsed.release_receiver_window.is_none() && parsed.failure_phase_before_restore.is_none());
        assert!(parsed.consume_failure_reason.is_none());
        for decision in ["no_release_point", "esc_cancelled", "receiver_timeout", "cancelled", "identity_changed"] {
            let mut value = old.clone();
            for (key, value_to_add) in [
                ("receiver_cleanup_reason", serde_json::json!("cleanup_failed")),
                ("release_cancel_reason", serde_json::json!("cancel_failed")),
                ("restore_unconfirmed", serde_json::json!(true)),
                ("release_receiver_window", serde_json::json!("receiver")),
                ("transferred_session_ids", serde_json::json!(["pty-live"])),
                ("failure_phase_before_restore", serde_json::json!("docking")),
                ("consume_failure_reason", serde_json::json!("expired")),
                ("release_decision", serde_json::json!(decision)),
            ] { value[key] = value_to_add; }
            let actual = serde_json::to_value(serde_json::from_value::<DragRecord>(value.clone()).unwrap()).unwrap();
            for key in ["receiver_cleanup_reason", "release_cancel_reason", "restore_unconfirmed", "release_receiver_window",
                "transferred_session_ids", "failure_phase_before_restore", "consume_failure_reason", "release_decision"] {
                assert_eq!(actual[key], value[key], "{key}");
            }
        }
        let unknown_stage = serde_json::json!({"side":"child", "stage":"receipt", "at":10, "extra":"rejected"});
        assert!(serde_json::from_value::<DockStage>(unknown_stage).is_err());
        for reason in ["expired", "receiver_changed", "release_id_changed", "target_changed", "layout_changed",
            "sender_changed", "not_approved", "already_consumed", "disposed", "backend_rejected"] {
            assert_eq!(serde_json::to_value(serde_json::from_value::<ConsumeFailureReason>(serde_json::json!(reason)).unwrap()).unwrap(), reason);
        }
    }
    #[test]
    fn review2_log_sanitizes_every_reason_and_attempted_destination() {
        let mut value = serde_json::to_value(record()).unwrap();
        let unsafe_text = format!("path C:/private\\cwd\n{}", "x".repeat(200));
        for key in ["failure_reason", "recovery_reason", "revoke_reason", "receiver_cleanup_reason", "release_cancel_reason",
            "failure_phase", "failure_phase_before_restore", "release_receiver_window"] {
            value[key] = serde_json::json!(unsafe_text);
        }
        value["attempted_destination"] = serde_json::json!({"kind":"left", "workspace_id":unsafe_text, "pane_id":unsafe_text, "index":null});
        value["transferred_session_ids"] = serde_json::json!(vec![unsafe_text.clone(); 300]);
        let logged: serde_json::Value = serde_json::from_slice(&line(serde_json::from_value(value).unwrap(), "test").unwrap()).unwrap();
        for key in ["failure_reason", "recovery_reason", "revoke_reason", "receiver_cleanup_reason", "release_cancel_reason",
            "failure_phase", "failure_phase_before_restore", "release_receiver_window"] {
            assert_eq!(logged[key], identifier(&unsafe_text), "{key}");
        }
        for key in ["workspace_id", "pane_id"] { assert_eq!(logged["attempted_destination"][key], identifier(&unsafe_text)); }
        assert_eq!(logged["transferred_session_ids"].as_array().unwrap().len(), 256);
        assert_eq!(logged["transferred_session_ids"][0], identifier(&unsafe_text));
        assert!(identifier(&unsafe_text).len() <= 128);
        assert!(identifier(&unsafe_text).chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')));
    }
    #[test]
    fn input_release_schema_is_bounded_test_only_and_rejects_content() {
        let mut value = serde_json::to_value(record()).unwrap();
        value["input_evidence"] = serde_json::json!({"pointer_id":1,"event_at":100.5,"trusted":false,"surface":"band"});
        value["release_point"] = serde_json::json!({"point":{"x":-1200.5,"y":-30.0,"at":110,"method":"native_up"}, "receiver_window":"receiver", "receiver_epoch":4, "client_x":100.25,"client_y":50.5});
        let mut parsed: DragRecord = serde_json::from_value(value.clone()).unwrap();
        retain_input_evidence(&mut parsed, false, true);
        assert!(parsed.input_evidence.is_none() && parsed.release_point.is_none());
        let mut parsed: DragRecord = serde_json::from_value(value.clone()).unwrap();
        retain_input_evidence(&mut parsed, true, false);
        assert!(parsed.input_evidence.is_none() && parsed.release_point.is_none());
        value["input_evidence"]["terminal_output"] = serde_json::json!("forbidden");
        assert!(serde_json::from_value::<DragRecord>(value).is_err());
    }

    #[test]
    fn handoff_records_roundtrip_without_accepting_conversation_content() {
        for outcome in ["handed_off", "handoff_failed"] {
            let mut value = serde_json::to_value(record()).unwrap();
            value["result"] = serde_json::json!(outcome);
            value["destination"] = serde_json::json!({
                "kind": "handoff", "index": null,
                "workspace_id": "receiver-workspace", "pane_id": "receiver-pane"
            });
            let parsed: LogRecord = serde_json::from_value(value.clone()).unwrap();
            let LogRecord::Drag(parsed) = parsed else {
                panic!("wrong record kind");
            };
            let logged: serde_json::Value =
                serde_json::from_slice(&line(parsed, "ho-test").unwrap()).unwrap();
            assert_eq!(logged["result"], outcome);
            assert_eq!(logged["destination"]["kind"], "handoff");
            assert_eq!(logged["session_id_equal"], true);
            value["destination"]["terminal_output"] = serde_json::json!("SECRET");
            assert!(serde_json::from_value::<LogRecord>(value).is_err());
        }
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
    fn recovery_diagnostics_keep_missing_release_unmeasured_and_accept_old_records() {
        let mut value = serde_json::to_value(record()).unwrap();
        value["released_at"] = serde_json::Value::Null;
        value["result"] = serde_json::json!("rejected_busy");
        value["failure_reason"] = serde_json::json!("tearout_move_busy");
        value["failure_phase"] = serde_json::json!("restoring");
        value["failed_session_ids"] = serde_json::json!(["pty-running"]);
        let typed: DragRecord = serde_json::from_value(value).unwrap();
        let logged: serde_json::Value = serde_json::from_slice(&line(typed, "s6test").unwrap()).unwrap();
        assert!(logged["released_at"].is_null());
        assert_eq!(logged["released"], false);
        assert_eq!(logged["failure_phase"], "restoring");
        assert_eq!(logged["failed_session_ids"][0], "pty-running");
        let old = serde_json::to_value(record()).unwrap();
        let mut old = old.as_object().unwrap().clone();
        for key in ["released", "failure_reason", "failure_phase", "failed_session_ids"] { old.remove(key); }
        assert!(serde_json::from_value::<DragRecord>(serde_json::Value::Object(old)).is_ok());
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

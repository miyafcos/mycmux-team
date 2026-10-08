use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::State;

use crate::AppState;

const RECORD_CAP: usize = 64;
const MAX_JS_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalProgressRequest {
    // Routing only. This struct is deliberately not Serialize.
    session_id: String,
    sample: TerminalProgressSample,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalProgressSample {
    token: String,
    received_generation: Option<u64>,
    parsed_generation: Option<u64>,
    received_end: Option<u64>,
    parsed_end: Option<u64>,
    render_tick: u64,
    viewport_y: u64,
    base_y: u64,
    alternate: bool,
    cols: u16,
    rows: u16,
    overlay_owners: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordedProgress<'a> {
    backend_generation: u64,
    backend_end: u64,
    #[serde(flatten)]
    sample: &'a TerminalProgressSample,
}

fn valid_sample(sample: &TerminalProgressSample) -> bool {
    let token = sample.token.as_bytes();
    token.len() == 36
        && token.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
            }
        })
        && sample.cols > 0
        && sample.rows > 0
        && usize::from(sample.overlay_owners) <= RECORD_CAP
        && [sample.received_generation, sample.parsed_generation,
            sample.received_end, sample.parsed_end, Some(sample.render_tick),
            Some(sample.viewport_y), Some(sample.base_y)]
            .into_iter().flatten().all(|value| value <= MAX_JS_INTEGER)
}

fn format_record(enabled: bool, sample: &TerminalProgressSample, backend: Option<(u64, u64)>) -> Result<Option<String>, String> {
    if !enabled { return Ok(None); }
    if !valid_sample(sample) { return Err("invalid_terminal_progress".into()); }
    let Some((backend_generation, backend_end)) = backend else { return Ok(None); };
    let record = RecordedProgress { backend_generation, backend_end, sample };
    serde_json::to_string(&record)
        .map(|json| Some(format!("[terminal-progress] {json}")))
        .map_err(|_| "invalid_terminal_progress".into())
}

struct WriteBudget { since: Instant, written: usize }

impl WriteBudget {
    fn take(&mut self, now: Instant, requested: usize) -> usize {
        if now.duration_since(self.since) >= Duration::from_secs(1) {
            self.since = now;
            self.written = 0;
        }
        let accepted = requested.min(RECORD_CAP.saturating_sub(self.written));
        self.written += accepted;
        accepted
    }
}

/// Opt-in fixed-schema diagnostics. No ring read, resize, input, or flow changes.
/// diag.log already rotates at 1 MiB with five retained generations.
#[tauri::command]
pub async fn record_terminal_progress(
    state: State<'_, AppState>, enabled: bool, records: Vec<TerminalProgressRequest>,
) -> Result<(), String> {
    if !enabled { return Ok(()); }
    if records.len() > RECORD_CAP || records.iter().any(|record| {
        record.session_id.len() > 240 || !valid_sample(&record.sample)
    }) { return Err("invalid_terminal_progress".into()); }
    let manager = state.session_manager.clone();
    crate::util::task::run_blocking("record_terminal_progress", move || {
        static BUDGET: OnceLock<Mutex<WriteBudget>> = OnceLock::new();
        let now = Instant::now();
        let limit = BUDGET.get_or_init(|| Mutex::new(WriteBudget { since: now, written: 0 }))
            .lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take(now, records.len());
        for record in records.into_iter().take(limit) {
            if let Some(line) = format_record(true, &record.sample, manager.progress_snapshot(&record.session_id))? {
                crate::diag::log(&line);
            }
        }
        Ok(())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> TerminalProgressRequest {
        serde_json::from_value(serde_json::json!({
            "sessionId": "private-routing-identifier",
            "sample": { "token": "12345678-1234-4123-8123-123456789abc",
                "receivedGeneration": 2, "parsedGeneration": 2,
                "receivedEnd": 50, "parsedEnd": 40, "renderTick": 3,
                "viewportY": 5, "baseY": 8, "alternate": false,
                "cols": 80, "rows": 24, "overlayOwners": 1 }
        })).unwrap()
    }

    #[test]
    fn terminal_progress_omits_routing_identifiers_and_content() {
        let record = request();
        let line = format_record(true, &record.sample, Some((2, 60))).unwrap().unwrap();
        assert!(line.starts_with("[terminal-progress] "));
        assert!(!line.contains("private-routing-identifier"));
        assert!(!line.contains("sessionId"));
        assert!(!line.contains('\n'));
        let json: serde_json::Value = serde_json::from_str(line.strip_prefix("[terminal-progress] ").unwrap()).unwrap();
        assert_eq!(json["backendEnd"], 60);
        assert_eq!(json["receivedEnd"], 50);
        assert_eq!(json["parsedEnd"], 40);
        assert_eq!(json.as_object().unwrap().len(), 14);
    }

    #[test]
    fn terminal_progress_rejects_text_paths_input_and_extra_fields() {
        let sample = serde_json::to_value(&request().sample).unwrap();
        for field in ["body", "text", "path", "input", "env", "sessionId"] {
            let mut injected = sample.clone();
            injected[field] = serde_json::json!("private content");
            assert!(serde_json::from_value::<TerminalProgressSample>(injected).is_err());
        }
        let mut record = serde_json::json!({ "sessionId": "route", "sample": sample });
        record["path"] = serde_json::json!("/private/content");
        assert!(serde_json::from_value::<TerminalProgressRequest>(record).is_err());
    }

    #[test]
    fn terminal_progress_off_and_missing_session_produce_no_line() {
        let mut sample = request().sample;
        sample.token = "private text".into();
        assert_eq!(format_record(false, &sample, Some((1, 20))).unwrap(), None);
        assert!(format_record(true, &sample, Some((1, 20))).is_err());
        assert_eq!(format_record(true, &request().sample, None).unwrap(), None);
    }

    #[test]
    fn terminal_progress_bounds_numeric_fields_and_tokens() {
        let mut sample = request().sample;
        sample.render_tick = MAX_JS_INTEGER + 1;
        assert!(!valid_sample(&sample));
        sample.render_tick = 0;
        sample.overlay_owners = 65;
        assert!(!valid_sample(&sample));
        sample.overlay_owners = 0;
        sample.cols = 0;
        assert!(!valid_sample(&sample));
        sample.cols = 80;
        sample.token.push_str("secret");
        assert!(!valid_sample(&sample));
    }

    #[test]
    fn terminal_progress_write_budget_is_bounded_across_windows() {
        let now = Instant::now();
        let mut budget = WriteBudget { since: now, written: 0 };
        assert_eq!(budget.take(now, 60), 60);
        assert_eq!(budget.take(now, 60), 4);
        assert_eq!(budget.take(now, 1), 0);
        assert_eq!(budget.take(now + Duration::from_secs(1), 65), 64);
    }
}

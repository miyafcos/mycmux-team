//! Silent, bounded cross-window timestamps for the isolated performance driver.
use std::borrow::Cow;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const CAPACITY: usize = 2048;

mod flow;
pub(crate) use flow::{flow_start, record_flow, FlowStage, FlowToken};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfMark {
    name: Cow<'static, str>,
    at_ms: f64,
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<u64>,
}

fn marks() -> &'static Mutex<VecDeque<PerfMark>> {
    static MARKS: OnceLock<Mutex<VecDeque<PerfMark>>> = OnceLock::new();
    MARKS.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAPACITY)))
}

pub fn mark(name: &'static str, id: Option<&str>) {
    mark_value(name, id, None);
}

pub fn mark_value(name: &'static str, id: Option<&str>, value: Option<u64>) {
    let Ok(duration) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return;
    };
    let Ok(mut buffer) = marks().lock() else {
        return;
    };
    if buffer.len() == CAPACITY {
        buffer.pop_front();
    }
    buffer.push_back(PerfMark {
        name: name.into(),
        at_ms: duration.as_secs_f64() * 1000.0,
        id: id.map(str::to_owned),
        value,
    });
}

#[tauri::command]
pub async fn perf_timeline_read(
    flow_trace_session: Option<String>,
    stop_flow_trace: Option<bool>,
) -> Vec<PerfMark> {
    // Production never starts the extra hot-path timing. Ordinary reads and
    // the existing command shape remain compatible with the baseline driver.
    if crate::test_profile::is_active() {
        if let Some(session) =
            flow_trace_session.filter(|value| !value.is_empty() && value.len() <= 128)
        {
            flow::start(session);
        }
        if stop_flow_trace.unwrap_or(false) {
            flow::stop();
        }
    }
    let mut result: Vec<PerfMark> = marks()
        .lock()
        .map(|buffer| buffer.iter().cloned().collect())
        .unwrap_or_default();
    result.extend(flow::snapshot());
    result
}

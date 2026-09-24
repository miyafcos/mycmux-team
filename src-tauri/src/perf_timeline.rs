//! Silent, bounded cross-window timestamps for the isolated performance driver.
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const CAPACITY: usize = 2048;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfMark {
    name: &'static str,
    at_ms: f64,
    id: Option<String>,
}

fn marks() -> &'static Mutex<VecDeque<PerfMark>> {
    static MARKS: OnceLock<Mutex<VecDeque<PerfMark>>> = OnceLock::new();
    MARKS.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAPACITY)))
}

pub fn mark(name: &'static str, id: Option<&str>) {
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
        name,
        at_ms: duration.as_secs_f64() * 1000.0,
        id: id.map(str::to_owned),
    });
}

#[tauri::command]
pub async fn perf_timeline_read() -> Vec<PerfMark> {
    marks()
        .lock()
        .map(|buffer| buffer.iter().cloned().collect())
        .unwrap_or_default()
}

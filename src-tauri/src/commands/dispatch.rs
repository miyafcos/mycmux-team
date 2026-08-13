use std::collections::HashSet;

use tauri::State;

use crate::{dispatch::{ledger, watchdog, DispatchEntry}, session_state::AttentionKind, AppState};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchError {
    code: &'static str,
    detail: String,
}

impl DispatchError {
    fn internal(detail: impl Into<String>) -> Self { Self { code: "internal", detail: detail.into() } }
    fn ledger_unreadable(detail: impl Into<String>) -> Self { Self { code: "ledger_unreadable", detail: detail.into() } }
}

#[tauri::command]
pub async fn dispatch_scan(state: State<'_, AppState>, include_closed: Option<bool>) -> Result<Vec<DispatchEntry>, DispatchError> {
    let rate_limited_sessions: HashSet<String> = state.session_state_store.snapshot(None).sessions.into_iter()
        .filter(|snapshot| snapshot.view.attention.kind == AttentionKind::RateLimited)
        .map(|snapshot| snapshot.session_id)
        .collect();
    let entries = tokio::task::spawn_blocking(move || ledger::scan_default_with_rate_limited_sessions(&rate_limited_sessions))
        .await
        .map_err(|error| DispatchError::internal(format!("dispatch scan task failed: {error}")))?
        .map_err(|error| DispatchError::ledger_unreadable(format!("dispatch ledger could not be read: {error}")))?;
    Ok(entries.into_iter().filter(|entry| include_closed.unwrap_or(false) || !matches!(entry.status.as_deref(), Some("closed" | "abandoned"))).collect())
}

#[tauri::command]
pub async fn dispatch_claim_watchdog(ttl_ms: u64) -> Result<bool, DispatchError> {
    tokio::task::spawn_blocking(move || watchdog::claim(ttl_ms))
        .await
        .map_err(|error| DispatchError::internal(format!("dispatch watchdog task failed: {error}")))?
        .map_err(|error| DispatchError::internal(format!("dispatch watchdog lock could not be claimed: {error}")))
}

use std::time::{SystemTime, UNIX_EPOCH};

use crate::attention::{self, AttentionCardView};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[tauri::command(async)]
pub async fn attention_list_cards() -> Result<Vec<AttentionCardView>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        attention::store::open().and_then(|conn| attention::store::list_open_cards(&conn))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn attention_resolve_card(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = attention::store::open()?;
        attention::store::resolve_card(&conn, &id, now_ms()).map(|_| ())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn attention_set_tracked(pty_session_id: String, tracked: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = attention::store::open()?;
        attention::store::set_tracked(&conn, &pty_session_id, tracked, now_ms())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn attention_list_tracked() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        attention::store::open().and_then(|conn| {
            attention::store::list_tracked(&conn).map(|sessions| sessions.into_iter().collect())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

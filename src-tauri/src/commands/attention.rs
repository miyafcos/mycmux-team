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
    // session-board の外部スナップショットは 2026-08-30 で更新が止まったので、
    // 取り込みを外して DB にあるカードだけを返す。取り込み側 (attention::session_board)
    // は、session-board が動き出したときに繋ぎ直せるように残してある。
    tauri::async_runtime::spawn_blocking(|| {
        let conn = attention::store::open()?;
        attention::store::list_open_cards(&conn)
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

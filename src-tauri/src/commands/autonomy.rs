//! Tauri boundary for the persisted autonomy controls.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::workorder::{
    autonomy_settings, db_path, set_autonomy_settings, writer, AutonomySettings,
    AutonomySettingsPatch,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutonomySettingsResponse {
    pub auto_advance: bool,
    pub attention_cards: bool,
}

impl From<AutonomySettings> for AutonomySettingsResponse {
    fn from(value: AutonomySettings) -> Self {
        Self {
            auto_advance: value.auto_advance,
            attention_cards: value.attention_cards,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutonomySettingsInput {
    pub auto_advance: Option<bool>,
    pub attention_cards: Option<bool>,
}

impl From<AutonomySettingsInput> for AutonomySettingsPatch {
    fn from(value: AutonomySettingsInput) -> Self {
        Self {
            auto_advance: value.auto_advance,
            attention_cards: value.attention_cards,
        }
    }
}

fn now_ms() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock before Unix epoch: {error}"))?;
    i64::try_from(duration.as_millis()).map_err(|_| "current time exceeds i64 milliseconds".into())
}

#[tauri::command(async)]
pub async fn autonomy_get_settings() -> Result<AutonomySettingsResponse, String> {
    let path = db_path().map_err(|error| error.to_string())?;
    let conn = crate::workorder::reader(&path).map_err(|error| error.to_string())?;
    autonomy_settings(&conn)
        .map(AutonomySettingsResponse::from)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub async fn autonomy_set_settings(
    input: AutonomySettingsInput,
) -> Result<AutonomySettingsResponse, String> {
    let path = db_path().map_err(|error| error.to_string())?;
    let mut conn = writer(&path).map_err(|error| error.to_string())?;
    set_autonomy_settings(&mut conn, input.into(), now_ms()?)
        .map(AutonomySettingsResponse::from)
        .map_err(|error| error.to_string())
}

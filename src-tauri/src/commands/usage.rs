use crate::usage::{claude, codex, config::load_config, UsageSummary};
use chrono::Utc;

#[tauri::command]
pub async fn get_usage_summary() -> Result<UsageSummary, String> {
    tokio::task::spawn_blocking(|| {
        let cfg = load_config();
        let now = Utc::now();
        let (claude_5h, claude_7d) = claude::aggregate(now, &cfg)?;
        let (codex_5h, codex_7d) = codex::aggregate(now, &cfg)?;

        Ok(UsageSummary {
            claude_5h,
            claude_7d,
            codex_5h,
            codex_7d,
            tier: cfg.tier,
            generated_at: now,
        })
    })
    .await
    .map_err(|err| format!("Usage aggregation task failed: {err}"))?
}

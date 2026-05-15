use crate::usage::{oauth_claude, oauth_codex, UsageSummary};

#[tauri::command]
pub async fn get_usage_summary() -> Result<UsageSummary, String> {
    let (claude_result, codex_result) = tokio::join!(oauth_claude::fetch(), oauth_codex::fetch());

    let (claude_5h, claude_7d, claude_7d_sonnet, claude_7d_opus, claude_available, claude_error) =
        match claude_result {
            Ok(usage) => {
                let available = usage.has_usage();
                (
                    usage.five_hour,
                    usage.seven_day,
                    usage.seven_day_sonnet,
                    usage.seven_day_opus,
                    available,
                    None,
                )
            }
            Err(error) => (None, None, None, None, false, Some(error)),
        };

    let (codex_5h, codex_7d, codex_available, codex_error) = match codex_result {
        Ok(usage) => {
            let available = usage.has_usage();
            (usage.five_hour, usage.seven_day, available, None)
        }
        Err(error) => (None, None, false, Some(error)),
    };

    Ok(UsageSummary {
        claude_5h,
        claude_7d,
        claude_7d_sonnet,
        claude_7d_opus,
        codex_5h,
        codex_7d,
        claude_available,
        codex_available,
        claude_error,
        codex_error,
        generated_at: chrono::Utc::now().to_rfc3339(),
    })
}

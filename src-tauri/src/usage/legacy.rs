//! Retirement of the pre-CLI-account usage OAuth registrations.
//!
//! Usage numbers used to come from accounts registered through a browser OAuth
//! flow of our own, stored as metadata in `usage_accounts.json` with the tokens
//! themselves in the OS keyring. Usage now follows the CLI accounts the user has
//! already captured, so nothing reads either store.
//!
//! The metadata file is renamed rather than deleted, and the keyring entries are
//! left where they are. Both are recoverable that way, and neither is consulted
//! again -- reclaiming the disk is not worth destroying credentials we did not
//! ask permission to destroy.

use std::path::Path;

const MARKER_FILE: &str = "usage_legacy_retired";
const ACCOUNTS_FILE: &str = "usage_accounts.json";

/// Runs once per installation. Safe to call on every launch.
pub fn retire_legacy_usage_oauth(app: &tauri::AppHandle, base: &Path) {
    let marker = base.join(MARKER_FILE);
    if marker.exists() {
        return;
    }
    let accounts = base.join(ACCOUNTS_FILE);
    let retired = match summarize(&accounts) {
        Some(summary) => {
            let stamp = chrono::Utc::now().format("%Y%m%d").to_string();
            let destination = base.join(format!("{ACCOUNTS_FILE}.retired-{stamp}"));
            if std::fs::rename(&accounts, &destination).is_err() {
                // Leave the marker unwritten so the next launch tries again.
                return;
            }
            Some(summary)
        }
        None => None,
    };

    if let Some(summary) = &retired {
        crate::usage::log_oauth_failure(
            app,
            "usage_legacy_retired",
            &format!(
                "{} account(s) [{}] moved aside; keyring entries under service \
                 'mycmux-usage-claude' are no longer read and can be deleted by hand",
                summary.count,
                summary.short_ids.join(", ")
            ),
        );
    }

    let _ = std::fs::write(&marker, b"");

    if let Some(summary) = retired {
        if summary.count > 0 {
            use tauri::Emitter;
            let _ = app.emit("mycmux://usage-legacy-retired", summary.count);
        }
    }
}

struct LegacySummary {
    count: usize,
    /// First 8 characters only: enough to correlate with the retired file,
    /// short of writing an account identifier into a log.
    short_ids: Vec<String>,
}

fn summarize(path: &Path) -> Option<LegacySummary> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let accounts = value
        .get("accounts")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let short_ids = accounts
        .iter()
        .filter_map(|entry| entry.get("account_id").and_then(serde_json::Value::as_str))
        .map(|id| id.chars().take(8).collect::<String>())
        .collect::<Vec<_>>();
    Some(LegacySummary {
        count: accounts.len(),
        short_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn summarize_reads_count_and_truncated_ids() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(ACCOUNTS_FILE);
        std::fs::write(
            &path,
            br#"{"version":1,"accounts":[
                 {"account_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","label":"one"},
                 {"account_id":"11111111-2222-3333-4444-555555555555","label":"two"}]}"#,
        )
        .unwrap();
        let summary = summarize(&path).unwrap();
        assert_eq!(summary.count, 2);
        assert_eq!(summary.short_ids, vec!["aaaaaaaa", "11111111"]);
        // Never the whole identifier.
        assert!(summary.short_ids.iter().all(|id| id.len() == 8));
    }

    #[test]
    fn summarize_tolerates_missing_and_malformed_files() {
        let dir = tempdir().unwrap();
        assert!(summarize(&dir.path().join("absent.json")).is_none());

        let broken = dir.path().join("broken.json");
        std::fs::write(&broken, b"{not json").unwrap();
        assert!(summarize(&broken).is_none());

        let empty = dir.path().join("empty.json");
        std::fs::write(&empty, b"{}").unwrap();
        assert_eq!(summarize(&empty).unwrap().count, 0);
    }
}

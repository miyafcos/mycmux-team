use chrono::{TimeZone, Utc};
use serde_json::Value;

/// Stand-in for a secret in `Debug` output.
///
/// Token values must never reach a log line or a panic message; the length is
/// the only detail worth keeping (it distinguishes "empty" from "present").
pub(super) fn redacted(value: &str) -> String {
    format!("<redacted len={}>", value.len())
}

pub(super) fn number_field(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        let raw = value.get(*key)?;
        raw.as_f64()
            .or_else(|| raw.as_str().and_then(|text| text.parse::<f64>().ok()))
    })
}

/// Clamp a provider's percentage into the range the UI can draw.
///
/// Every provider read here reports whole percents on a 0-100 scale: Claude's
/// `utilization` and `limits[].percent`, Codex's `used_percent`, Grok's
/// `creditUsagePercent` and `usagePercent` (all confirmed against the live
/// endpoints on 2026-09-14). This used to guess that a value at or below 1.0
/// was a 0-1 fraction and multiply it by 100, so an account at exactly 1% was
/// shown as 100% -- a wall in the panel and titlebar for an account that had
/// barely been touched. A genuine fraction could only ever under-report, so
/// the guess is gone: the value is taken as the percent it is.
pub(super) fn normalize_pct(value: f64) -> f64 {
    value.clamp(0.0, 999.9)
}

pub(super) fn epoch_to_rfc3339(value: i64) -> String {
    let seconds = if value > 10_000_000_000 {
        value / 1000
    } else {
        value
    };
    Utc.timestamp_opt(seconds, 0)
        .single()
        .map(|date| date.to_rfc3339())
        .unwrap_or_default()
}

pub(super) fn number_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
}

pub(super) fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect::<String>() + "..."
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numeric_helpers_preserve_existing_normalization() {
        let value = json!({ "ratio": "0.75", "epoch": "1700000000000" });
        assert_eq!(number_field(&value, &["ratio"]), Some(0.75));
        assert_eq!(normalize_pct(12.5), 12.5);
        assert_eq!(normalize_pct(1_000.0), 999.9);
        assert_eq!(number_to_i64(&value["epoch"]), Some(1_700_000_000_000));
        assert_eq!(
            epoch_to_rfc3339(1_700_000_000_000),
            "2023-11-14T22:13:20+00:00"
        );
    }

    /// The providers report whole percents; nothing at or below 1.0 is a
    /// fraction to scale up. 1% used to come out as 100%.
    #[test]
    fn small_percents_are_not_scaled_as_fractions() {
        assert_eq!(normalize_pct(1.0), 1.0);
        assert_eq!(normalize_pct(0.75), 0.75);
        assert_eq!(normalize_pct(0.0), 0.0);
        assert_eq!(normalize_pct(-3.0), 0.0);
    }

    #[test]
    fn truncate_is_character_based_and_keeps_short_values() {
        assert_eq!(truncate("short", 5), "short");
        assert_eq!(truncate("abcdef", 3), "abc...");
        assert_eq!(truncate("日本語", 2), "日本...");
    }
}

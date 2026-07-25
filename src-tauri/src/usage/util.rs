use chrono::{TimeZone, Utc};
use serde_json::Value;

pub(super) fn number_field(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        let raw = value.get(*key)?;
        raw.as_f64()
            .or_else(|| raw.as_str().and_then(|text| text.parse::<f64>().ok()))
    })
}

pub(super) fn normalize_pct(value: f64) -> f64 {
    let pct = if value <= 1.0 { value * 100.0 } else { value };
    pct.clamp(0.0, 999.9)
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
        assert_eq!(normalize_pct(0.75), 75.0);
        assert_eq!(normalize_pct(12.5), 12.5);
        assert_eq!(normalize_pct(1_000.0), 999.9);
        assert_eq!(number_to_i64(&value["epoch"]), Some(1_700_000_000_000));
        assert_eq!(
            epoch_to_rfc3339(1_700_000_000_000),
            "2023-11-14T22:13:20+00:00"
        );
    }

    #[test]
    fn truncate_is_character_based_and_keeps_short_values() {
        assert_eq!(truncate("short", 5), "short");
        assert_eq!(truncate("abcdef", 3), "abc...");
        assert_eq!(truncate("日本語", 2), "日本...");
    }
}

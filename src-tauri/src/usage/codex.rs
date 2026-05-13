use crate::usage::{
    build_window_stat, cache, config::UsageConfig, UsageEvent, WindowBasis, WindowStat,
};
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

pub fn aggregate(
    now: DateTime<Utc>,
    cfg: &UsageConfig,
) -> Result<(WindowStat, WindowStat), String> {
    // ccusage @codex reads Codex CLI session JSONL files under ~/.codex/sessions.
    let events = cache::read_events(&cfg.codex_sessions_glob, parse_event)?;
    let five_hour = build_window_stat(
        now,
        Duration::hours(5),
        &events,
        cfg.codex_5h_limit_messages,
        WindowBasis::Messages,
    );
    let seven_day = build_window_stat(
        now,
        Duration::days(7),
        &events,
        cfg.codex_7d_limit_messages,
        WindowBasis::Messages,
    );
    Ok((five_hour, seven_day))
}

fn parse_event(value: &Value) -> Option<UsageEvent> {
    if value.get("type")?.as_str()? != "message" {
        return None;
    }

    Some(UsageEvent {
        timestamp: parse_timestamp(value)?,
        tokens: token_usage(value),
        messages: 1,
    })
}

fn parse_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    let raw = value.get("timestamp")?.as_str()?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

fn token_usage(value: &Value) -> u64 {
    let usage = value.get("usage").or_else(|| {
        value
            .get("message")
            .and_then(|message| message.get("usage"))
    });
    let Some(usage) = usage else {
        return 0;
    };

    if let Some(total) = usage.get("total_tokens").and_then(Value::as_u64) {
        return total;
    }

    [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "cached_input_tokens",
    ]
    .iter()
    .map(|key| usage.get(*key).and_then(Value::as_u64).unwrap_or(0))
    .sum()
}

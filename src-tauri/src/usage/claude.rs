use crate::usage::{
    build_window_stat, cache, config::UsageConfig, UsageEvent, WindowBasis, WindowStat,
};
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

pub fn aggregate(
    now: DateTime<Utc>,
    cfg: &UsageConfig,
) -> Result<(WindowStat, WindowStat), String> {
    let events = cache::read_events(&cfg.claude_projects_glob, parse_event)?;
    let five_hour = build_window_stat(
        now,
        Duration::hours(5),
        &events,
        cfg.claude_5h_limit_tokens,
        WindowBasis::Tokens,
    );
    let seven_day = build_window_stat(
        now,
        Duration::days(7),
        &events,
        cfg.claude_7d_limit_tokens,
        WindowBasis::Tokens,
    );
    Ok((five_hour, seven_day))
}

fn parse_event(value: &Value) -> Option<UsageEvent> {
    let timestamp = parse_timestamp(value)?;
    let usage = value.get("message")?.get("usage")?;
    // Anthropic の /usage rate-limit は cache_read_input_tokens をカウントしない (検証済)。
    // 含めると 5h 表示が 70%+ になり、実 /usage の 5% と乖離するため除外。
    let tokens = get_u64(usage, "input_tokens")
        .saturating_add(get_u64(usage, "output_tokens"))
        .saturating_add(get_u64(usage, "cache_creation_input_tokens"));

    if tokens == 0 {
        return None;
    }

    Some(UsageEvent {
        timestamp,
        tokens,
        messages: 0,
    })
}

fn parse_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    let raw = value.get("timestamp")?.as_str()?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

fn get_u64(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

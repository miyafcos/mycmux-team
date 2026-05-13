pub mod cache;
pub mod claude;
pub mod codex;
pub mod config;
pub mod tier_presets;

#[cfg(test)]
mod tests;

use chrono::{DateTime, Utc};
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct WindowStat {
    pub tokens: u64,
    pub messages: u32,
    pub limit: u64,
    pub pct: f32,
    pub reset_at: DateTime<Utc>,
}

#[derive(Serialize, Clone, Debug)]
pub struct UsageSummary {
    pub claude_5h: WindowStat,
    pub claude_7d: WindowStat,
    pub codex_5h: WindowStat,
    pub codex_7d: WindowStat,
    pub tier: String,
    pub generated_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct UsageEvent {
    pub timestamp: DateTime<Utc>,
    pub tokens: u64,
    pub messages: u32,
}

fn clamp_pct(used: u64, limit: u64) -> f32 {
    if limit == 0 {
        return 0.0;
    }
    ((used as f32 / limit as f32) * 100.0).clamp(0.0, 999.9)
}

fn build_window_stat(
    now: DateTime<Utc>,
    duration: chrono::Duration,
    events: &[UsageEvent],
    limit: u64,
    pct_basis: WindowBasis,
) -> WindowStat {
    let start = now - duration;
    let mut tokens = 0_u64;
    let mut messages = 0_u32;
    let mut oldest: Option<DateTime<Utc>> = None;

    for event in events {
        if event.timestamp < start || event.timestamp > now {
            continue;
        }
        tokens = tokens.saturating_add(event.tokens);
        messages = messages.saturating_add(event.messages);
        oldest = Some(oldest.map_or(event.timestamp, |current| current.min(event.timestamp)));
    }

    let used = match pct_basis {
        WindowBasis::Tokens => tokens,
        WindowBasis::Messages => u64::from(messages),
    };

    WindowStat {
        tokens,
        messages,
        limit,
        pct: clamp_pct(used, limit),
        reset_at: oldest.map_or(now + duration, |timestamp| timestamp + duration),
    }
}

#[derive(Clone, Copy, Debug)]
enum WindowBasis {
    Tokens,
    Messages,
}

use crate::usage::tier_presets;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct UsageConfig {
    pub claude_5h_limit_tokens: u64,
    pub claude_7d_limit_tokens: u64,
    pub codex_5h_limit_messages: u64,
    pub codex_7d_limit_messages: u64,
    pub tier: String,
    pub claude_projects_glob: String,
    pub codex_sessions_glob: String,
}

#[derive(Debug, Deserialize)]
struct UsageOverrides {
    claude_5h_limit_tokens: Option<u64>,
    claude_7d_limit_tokens: Option<u64>,
    codex_5h_limit_messages: Option<u64>,
    codex_7d_limit_messages: Option<u64>,
}

pub fn load_config() -> UsageConfig {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let claude_dir = home.join(".claude");
    let codex_dir = home.join(".codex");
    let tier =
        read_tier(&claude_dir.join(".credentials.json")).unwrap_or_else(|| "pro".to_string());
    let preset = tier_presets::for_tier(&tier);
    let overrides = read_overrides(&claude_dir.join("mycmux-usage-config.json"));

    UsageConfig {
        claude_5h_limit_tokens: overrides
            .as_ref()
            .and_then(|cfg| cfg.claude_5h_limit_tokens)
            .unwrap_or(preset.claude_5h_limit_tokens),
        claude_7d_limit_tokens: overrides
            .as_ref()
            .and_then(|cfg| cfg.claude_7d_limit_tokens)
            .unwrap_or(preset.claude_7d_limit_tokens),
        codex_5h_limit_messages: overrides
            .as_ref()
            .and_then(|cfg| cfg.codex_5h_limit_messages)
            .unwrap_or(preset.codex_5h_limit_messages),
        codex_7d_limit_messages: overrides
            .as_ref()
            .and_then(|cfg| cfg.codex_7d_limit_messages)
            .unwrap_or(preset.codex_7d_limit_messages),
        tier: preset.tier,
        claude_projects_glob: glob_for(claude_dir.join("projects").join("**").join("*.jsonl")),
        codex_sessions_glob: glob_for(codex_dir.join("sessions").join("**").join("*.jsonl")),
    }
}

fn read_tier(path: &PathBuf) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    find_string_key(&value, "rateLimitTier")
}

fn read_overrides(path: &PathBuf) -> Option<UsageOverrides> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn find_string_key(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(found)) = map.get(key) {
                return Some(found.clone());
            }
            map.values().find_map(|child| find_string_key(child, key))
        }
        Value::Array(items) => items.iter().find_map(|child| find_string_key(child, key)),
        _ => None,
    }
}

fn glob_for(path: PathBuf) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
impl UsageConfig {
    pub fn for_test(claude_projects_glob: String, codex_sessions_glob: String) -> Self {
        Self {
            claude_5h_limit_tokens: 10_000,
            claude_7d_limit_tokens: 100_000,
            codex_5h_limit_messages: 10,
            codex_7d_limit_messages: 100,
            tier: "test".to_string(),
            claude_projects_glob,
            codex_sessions_glob,
        }
    }
}

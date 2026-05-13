#[derive(Clone, Debug)]
pub struct TierPreset {
    pub tier: String,
    pub claude_5h_limit_tokens: u64,
    pub claude_7d_limit_tokens: u64,
    pub codex_5h_limit_messages: u64,
    pub codex_7d_limit_messages: u64,
}

pub fn for_tier(tier: &str) -> TierPreset {
    const CODEX_5H_LIMIT_MESSAGES: u64 = 150;
    const CODEX_7D_LIMIT_MESSAGES: u64 = 1_500;

    match tier {
        "max_20x" => TierPreset {
            tier: tier.to_string(),
            claude_5h_limit_tokens: 220_000_000, // 推定値 (estimated, derived from ccusage community data - not official Anthropic numbers)
            claude_7d_limit_tokens: 1_500_000_000, // 推定値 (estimated, derived from ccusage community data - not official Anthropic numbers)
            codex_5h_limit_messages: CODEX_5H_LIMIT_MESSAGES,
            codex_7d_limit_messages: CODEX_7D_LIMIT_MESSAGES,
        },
        "max_5x" => TierPreset {
            tier: tier.to_string(),
            claude_5h_limit_tokens: 55_000_000, // 推定値 (estimated, derived from ccusage community data - not official Anthropic numbers)
            claude_7d_limit_tokens: 375_000_000, // 推定値 (estimated, derived from ccusage community data - not official Anthropic numbers)
            codex_5h_limit_messages: CODEX_5H_LIMIT_MESSAGES,
            codex_7d_limit_messages: CODEX_7D_LIMIT_MESSAGES,
        },
        "pro" => TierPreset {
            tier: tier.to_string(),
            claude_5h_limit_tokens: 11_000_000, // 推定値 (estimated, derived from ccusage community data - not official Anthropic numbers)
            claude_7d_limit_tokens: 75_000_000, // 推定値 (estimated, derived from ccusage community data - not official Anthropic numbers)
            codex_5h_limit_messages: CODEX_5H_LIMIT_MESSAGES,
            codex_7d_limit_messages: CODEX_7D_LIMIT_MESSAGES,
        },
        _ => TierPreset {
            tier: "pro (fallback)".to_string(),
            claude_5h_limit_tokens: 11_000_000, // 推定値 (estimated, derived from ccusage community data - not official Anthropic numbers)
            claude_7d_limit_tokens: 75_000_000, // 推定値 (estimated, derived from ccusage community data - not official Anthropic numbers)
            codex_5h_limit_messages: CODEX_5H_LIMIT_MESSAGES,
            codex_7d_limit_messages: CODEX_7D_LIMIT_MESSAGES,
        },
    }
}

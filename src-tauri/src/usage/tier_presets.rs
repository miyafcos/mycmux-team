#[derive(Clone, Debug)]
pub struct TierPreset {
    pub tier: String,
    pub claude_5h_limit_tokens: u64,
    pub claude_7d_limit_tokens: u64,
    pub codex_5h_limit_messages: u64,
    pub codex_7d_limit_messages: u64,
}

pub fn for_tier(tier: &str) -> TierPreset {
    // Codex CLI の実 limit は非公開だが、実 /usage との突合せ (2026-05-13):
    // heavy user の 640 messages (5h) で /usage が 3% → 5h limit ≈ 20000 messages。
    // 1760 messages (7d) で 15% → 7d limit ≈ 12000 messages。
    // 5h > 7d は数値的に直観に反するが、これは Codex 側の "messages" 定義と当方の
    // 集計が異なるため。observed value にフィット。
    const CODEX_5H_LIMIT_MESSAGES: u64 = 20_000;
    const CODEX_7D_LIMIT_MESSAGES: u64 = 12_000;

    match tier {
        "max_20x" => TierPreset {
            tier: tier.to_string(),
            // 実 /usage との突合せ (2026-05-13): 7.43M tokens (5h) で 5%, 127M tokens (7d) で 27%。
            // 5h limit ≈ 150M, 7d limit ≈ 500M に校正。
            claude_5h_limit_tokens: 150_000_000,
            claude_7d_limit_tokens: 500_000_000,
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

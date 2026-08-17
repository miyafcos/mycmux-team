//! AI session log analytics (F1: incremental indexer + aggregation queries).
//!
//! Reads Claude Code (`~/.claude/projects/*/*.jsonl`), Codex
//! (`~/.codex/sessions/**/*.jsonl`), and Grok Build
//! (`~/.grok/sessions/**/updates.jsonl`) transcripts into a local SQLite database
//! at `~/.mycmux/ailog.db`, then answers volume / cost / rework / model questions
//! over arbitrary time ranges.
//!
//! Scope note: this module only produces the data layer and the Tauri command
//! surface. No UI (F2) and no LLM summarisation (F3) live here.
//!
//! Cost caveat: the amounts reported are "what this would have cost on
//! metered pricing", not a bill. See [`price`] for how the default table is
//! sourced and why unknown models stay at zero instead of being guessed.

pub mod db;
pub mod digest;
pub mod index;
pub mod jsonl;
pub mod metrics;
pub mod migrate;
pub mod parse_claude;
pub mod parse_codex;
pub mod parse_grok;
pub mod price;
pub mod project_rules;
pub mod query;
pub mod rollup;
pub mod schema;
pub mod summarize;
pub mod transcript;
pub mod usage;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const KIND_CLAUDE: &str = "claude";
pub const KIND_CODEX: &str = "codex";
pub const KIND_GROK: &str = "grok";

/// `origin` values stored on `session`.
///
/// F1 never emits `mycmux`: the `MYCMUX_*` environment variables that would
/// prove a session was launched from a mycmux tab are not written to either
/// transcript format, so claiming it would be a fabrication. Sessions whose
/// host is identifiable as something else (VS Code, a Claude Code-spawned
/// Codex run) get `other`; everything else stays `unknown`.
pub const ORIGIN_UNKNOWN: &str = "unknown";
pub const ORIGIN_OTHER: &str = "other";
pub const ORIGIN_AILOG_INTERNAL: &str = "ailog-internal";

/// Path of the analytics database (the active mycmux runtime directory).
pub fn db_path() -> Result<PathBuf, String> {
    Ok(crate::test_profile::runtime_dir()?.join("ailog.db"))
}

/// Default Claude transcript root (`~/.claude/projects`).
pub fn claude_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join("projects"))
}

/// Default claude-codex transcript root (`~/.claude-codex/config/projects`).
/// The wrapper keeps its own config home but writes Claude's transcript shape.
pub fn claude_codex_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude-codex").join("config").join("projects"))
}

/// Default Codex transcript root (`~/.codex/sessions`).
pub fn codex_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex").join("sessions"))
}

/// Default Grok Build transcript root (`~/.grok/sessions`).
pub fn grok_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".grok").join("sessions"))
}

pub fn open_db(path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    db::writer(path)
}

// ---------------------------------------------------------------------------
// Query inputs
// ---------------------------------------------------------------------------

/// Time window for a query, in unix milliseconds.
///
/// `from`/`to` win over `preset` whenever either is set, per spec §6.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Range {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub preset: Option<String>,
}

/// Resolved window plus a human label describing which input won.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedRange {
    pub from: i64,
    pub to: i64,
}

impl Range {
    /// Resolve to concrete bounds. `now_ms` is injected so tests are stable.
    ///
    /// Precedence: an explicit `from` or `to` always wins; `preset` only fills
    /// the sides that were left open. An unrecognised preset behaves like
    /// `all`.
    pub fn resolve(&self, now_ms: i64) -> (ResolvedRange, String) {
        const DAY: i64 = 86_400_000;
        let preset = self.preset.as_deref().unwrap_or("all");
        let (preset_from, preset_label) = match preset {
            "7d" => (Some(now_ms - 7 * DAY), "7d"),
            "30d" => (Some(now_ms - 30 * DAY), "30d"),
            "90d" => (Some(now_ms - 90 * DAY), "90d"),
            "ytd" => (Some(start_of_year_ms(now_ms)), "ytd"),
            _ => (None, "all"),
        };

        let explicit = self.from.is_some() || self.to.is_some();
        let from = self.from.or(preset_from).unwrap_or(i64::MIN / 4);
        let to = self.to.unwrap_or(now_ms);
        let label = if explicit {
            "custom".to_string()
        } else {
            preset_label.to_string()
        };
        (ResolvedRange { from, to }, label)
    }
}

fn start_of_year_ms(now_ms: i64) -> i64 {
    use chrono::{Datelike, TimeZone, Utc};
    let now = Utc.timestamp_millis_opt(now_ms).single();
    match now {
        Some(dt) => Utc
            .with_ymd_and_hms(dt.year(), 1, 1, 0, 0, 0)
            .single()
            .map(|d| d.timestamp_millis())
            .unwrap_or(0),
        None => 0,
    }
}

/// Post-range filters. Empty vectors mean "no restriction".
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Filters {
    pub kinds: Vec<String>,
    pub models: Vec<String>,
    pub projects: Vec<String>,
    pub branches: Vec<String>,
    pub efforts: Vec<String>,
    pub origins: Vec<String>,
    /// Defaults to false so sub-agent turns are not double counted against the
    /// parent session.
    pub include_sidechain: bool,
    pub min_cost: Option<f64>,
    pub query: Option<String>,
}

impl Default for Filters {
    fn default() -> Self {
        Self {
            kinds: Vec::new(),
            models: Vec::new(),
            projects: Vec::new(),
            branches: Vec::new(),
            efforts: Vec::new(),
            origins: Vec::new(),
            include_sidechain: false,
            min_cost: None,
            query: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Parser output
// ---------------------------------------------------------------------------

/// One billable exchange. Claude collapses every line sharing a `requestId`
/// into a single turn; Codex emits one per `token_count` event.
#[derive(Debug, Clone, Default)]
pub struct TurnRow {
    /// Stable identity used to merge rows that straddle an incremental read
    /// boundary. Stored in `turn.request_id`.
    pub dedup_key: String,
    pub ts: i64,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_5m_tokens: i64,
    pub cache_write_1h_tokens: i64,
    /// Informational only. On Codex this is a *subset* of `output_tokens`, so
    /// it is never added to the priced total.
    pub reasoning_tokens: i64,
    /// Provider-reported aggregate cost, when the transcript carries one.
    ///
    /// Claude and Codex leave this unset and use the local reference price
    /// table. Grok reports an exact aggregate in `costUsdTicks`, so its parser
    /// carries the converted USD value through the existing cost columns.
    pub reported_cost_usd: Option<f64>,
    pub duration_ms: Option<i64>,
    pub tool_calls: i64,
    pub tool_errors: i64,
}

#[derive(Debug, Clone)]
pub struct ToolRow {
    pub call_id: Option<String>,
    pub ts: i64,
    pub name: String,
    pub is_error: bool,
    pub target: Option<String>,
    pub turn_key: Option<String>,
}

/// A tool result observed in this chunk. `name` is filled in when the matching
/// call was seen in the same chunk; otherwise the writer resolves it from
/// `tool_event.call_id`.
#[derive(Debug, Clone)]
pub struct ResultRow {
    pub call_id: String,
    pub ts: i64,
    pub is_error: bool,
    pub chars: i64,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct FileTouchRow {
    pub edit_count: i64,
    pub read_count: i64,
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
}

impl FileTouchRow {
    pub fn stamp(&mut self, ts: i64) {
        self.first_ts = Some(self.first_ts.map_or(ts, |v| v.min(ts)));
        self.last_ts = Some(self.last_ts.map_or(ts, |v| v.max(ts)));
    }
}

/// Everything one file chunk contributed to a single session.
#[derive(Debug, Clone)]
pub struct SessionChunk {
    pub kind: &'static str,
    pub session_id: String,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub ai_title: Option<String>,
    pub first_prompt: Option<String>,
    pub slug: Option<String>,
    pub entrypoint: Option<String>,
    pub origin: String,
    pub cli_version: Option<String>,
    pub plan_type: Option<String>,
    pub is_sidechain: bool,
    pub agent_names: Vec<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub active_ms: i64,
    pub turn_count_hint: i64,
    pub user_msg_count: i64,
    pub compact_count: i64,
    pub correction_hits: i64,
    pub prompt_chars: i64,
    pub write_chars: i64,
    pub turns: Vec<TurnRow>,
    pub tools: Vec<ToolRow>,
    pub results: Vec<ResultRow>,
    pub files: BTreeMap<String, FileTouchRow>,
    /// True when the last event in this chunk was a tool invocation rather
    /// than a completed assistant message.
    pub ends_on_tool: bool,
}

impl SessionChunk {
    pub fn new(kind: &'static str, session_id: String) -> Self {
        Self {
            kind,
            session_id,
            cwd: None,
            git_branch: None,
            ai_title: None,
            first_prompt: None,
            slug: None,
            entrypoint: None,
            origin: ORIGIN_UNKNOWN.to_string(),
            cli_version: None,
            plan_type: None,
            is_sidechain: false,
            agent_names: Vec::new(),
            started_at: None,
            ended_at: None,
            active_ms: 0,
            turn_count_hint: 0,
            user_msg_count: 0,
            compact_count: 0,
            correction_hits: 0,
            prompt_chars: 0,
            write_chars: 0,
            turns: Vec::new(),
            tools: Vec::new(),
            results: Vec::new(),
            files: BTreeMap::new(),
            ends_on_tool: false,
        }
    }

    pub fn stamp(&mut self, ts: i64) {
        if ts <= 0 {
            return;
        }
        self.started_at = Some(self.started_at.map_or(ts, |v| v.min(ts)));
        self.ended_at = Some(self.ended_at.map_or(ts, |v| v.max(ts)));
    }

    pub fn touch_file(&mut self, path: &str, ts: i64, edits: i64, reads: i64) {
        let entry = self.files.entry(path.to_string()).or_default();
        entry.edit_count += edits;
        entry.read_count += reads;
        entry.stamp(ts);
    }
}

/// Result of parsing one contiguous byte range of one transcript file.
#[derive(Debug, Clone, Default)]
pub struct ChunkData {
    pub sessions: BTreeMap<String, SessionChunk>,
    pub lines: u64,
    /// Bytes consumed, counting only complete newline-terminated lines.
    pub consumed_bytes: u64,
    pub parse_errors: u64,
}

/// Parse an RFC 3339 / ISO 8601 timestamp into unix milliseconds.
pub fn parse_ts(value: Option<&str>) -> Option<i64> {
    let raw = value?;
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Normalise a working directory into a comparison key: lowercase, forward
/// slashes, no trailing separator.
pub fn project_key(cwd: &str) -> String {
    let replaced = cwd.replace('\\', "/");
    let trimmed = replaced.trim_end_matches('/');
    trimmed.to_lowercase()
}

/// Display label for a project: the last two path segments of the cwd.
pub fn project_label(cwd: &str) -> String {
    let replaced = cwd.replace('\\', "/");
    let parts: Vec<&str> = replaced
        .trim_end_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let take = parts.len().saturating_sub(2);
    let tail = &parts[take..];
    if tail.is_empty() {
        cwd.to_string()
    } else {
        tail.join("/")
    }
}

/// Truncate on a char boundary (transcripts are full of multi-byte text).
pub fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}
pub mod backfill;

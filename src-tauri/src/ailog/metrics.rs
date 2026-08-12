//! Deterministic derived metrics: tool classification, rework signals, work
//! tags and goal keys. No LLM is involved anywhere in this file — everything
//! here is a fixed rule so the same transcript always yields the same numbers.

use std::collections::BTreeMap;

use crate::ailog::{FileTouchRow, ToolRow};

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolClass {
    /// Reading the workspace: Read / Grep / Glob and Codex equivalents.
    Read,
    /// Mutating the workspace: Edit / Write / apply_patch.
    Edit,
    /// Running a command: Bash / PowerShell / Codex `exec` / `shell_command`.
    Exec,
    /// Reaching outside the machine: WebFetch / WebSearch / MCP tools.
    Fetch,
    /// Delegating work to another agent or task.
    Orchestrate,
    /// Anything the name does not identify. Never folded into read or write.
    Other,
}

/// Codex names its collaboration tools in snake_case, so the spec's
/// `Agent` / `Task*` / `Workflow` substring rule would never match them. This
/// list extends that rule to the Codex surface rather than replacing it.
const CODEX_ORCHESTRATE: &[&str] = &[
    "spawn_agent",
    "wait_agent",
    "close_agent",
    "list_agents",
    "send_message",
    "followup_task",
];

const CODEX_EXEC: &[&str] = &["exec", "shell", "shell_command", "local_shell"];
const CODEX_EDIT: &[&str] = &["apply_patch", "patch", "write_file"];
const CODEX_READ: &[&str] = &["read_file", "view", "view_image", "list_dir"];
const CODEX_FETCH: &[&str] = &["web_search", "web_fetch", "browser", "tool_search"];

pub fn classify_tool(name: &str) -> ToolClass {
    // Orchestration is checked first: `TaskCreate` would otherwise be caught
    // by nothing, and `Agent` must not be mistaken for a generic tool.
    if name.contains("Agent") || name.starts_with("Task") || name.contains("Workflow") {
        return ToolClass::Orchestrate;
    }
    if CODEX_ORCHESTRATE.contains(&name) {
        return ToolClass::Orchestrate;
    }
    match name {
        "Read" | "Grep" | "Glob" | "NotebookRead" => return ToolClass::Read,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => return ToolClass::Edit,
        "Bash" | "PowerShell" | "Monitor" => return ToolClass::Exec,
        "WebFetch" | "WebSearch" => return ToolClass::Fetch,
        _ => {}
    }
    if name.starts_with("mcp__") {
        return ToolClass::Fetch;
    }
    if CODEX_EXEC.contains(&name) {
        return ToolClass::Exec;
    }
    if CODEX_EDIT.contains(&name) {
        return ToolClass::Edit;
    }
    if CODEX_READ.contains(&name) {
        return ToolClass::Read;
    }
    if CODEX_FETCH.contains(&name) {
        return ToolClass::Fetch;
    }
    ToolClass::Other
}

// ---------------------------------------------------------------------------
// Correction detection
// ---------------------------------------------------------------------------

/// Substrings that mark a user turn as *probably* a correction.
///
/// This is a heuristic on purpose. It is named `correction_hits` in every API
/// so nobody reads it as "number of times the user got angry" — false
/// positives are expected and acceptable, and the number only supports
/// relative comparison between sessions.
pub const CORRECTION_PATTERNS: &[&str] = &[
    "違う",
    "ちがう",
    "そうじゃな",
    "戻して",
    "元に戻",
    "やり直",
    "まだ",
    "直ってない",
    "直っていない",
    "反映されてない",
    "反映されていない",
    "動かない",
    "失敗して",
    "間違っ",
    "なんで",
    "勝手に",
];

/// True when a single user utterance looks like a correction. One utterance
/// counts once no matter how many patterns it hits.
pub fn is_correction(text: &str) -> bool {
    CORRECTION_PATTERNS
        .iter()
        .any(|pattern| text.contains(pattern))
}

// ---------------------------------------------------------------------------
// Rework
// ---------------------------------------------------------------------------

/// Command stems that count as a verification run for the `verify` work tag.
pub const VERIFY_COMMANDS: &[&str] = &[
    "cargo", "npm", "npx", "pytest", "python", "tsc", "vitest", "go", "make", "gradle",
];

/// How many events after a failure still count as "immediately retried".
pub const RETRY_WINDOW: usize = 3;
/// A file edited at least this many times counts toward `churn_files`.
pub const CHURN_EDIT_THRESHOLD: i64 = 3;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ReworkStats {
    pub tool_error_count: i64,
    pub tool_call_count: i64,
    pub tool_error_rate: f64,
    pub correction_count: i64,
    pub max_file_edits: i64,
    pub churn_files: i64,
    pub retry_bash: i64,
    pub abandoned: bool,
    pub score: f64,
}

fn clamp01(value: f64) -> f64 {
    if value.is_nan() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

/// Composite 0-100 rework indicator.
///
/// This is a *relative comparison* aid, not an absolute quality judgement. Two
/// sessions with different scores can both be fine work; the number only says
/// one showed more of the mechanical signals of thrash than the other.
pub fn rework_score(
    tool_error_rate: f64,
    correction_hits: i64,
    churn_files: i64,
    abandoned: bool,
) -> f64 {
    let value = 0.35 * clamp01(tool_error_rate / 0.15)
        + 0.25 * clamp01(correction_hits as f64 / 10.0)
        + 0.25 * clamp01(churn_files as f64 / 5.0)
        + 0.15 * if abandoned { 1.0 } else { 0.0 };
    100.0 * clamp01(value)
}

/// Count failures that were immediately followed by the same command stem.
///
/// `events` must be in execution order.
pub fn count_retry_bash(events: &[ToolRow]) -> i64 {
    let mut count = 0;
    for (index, event) in events.iter().enumerate() {
        if !event.is_error || classify_tool(&event.name) != ToolClass::Exec {
            continue;
        }
        let Some(target) = event.target.as_deref() else {
            continue;
        };
        let end = (index + 1 + RETRY_WINDOW).min(events.len());
        for candidate in &events[index + 1..end] {
            if classify_tool(&candidate.name) == ToolClass::Exec
                && candidate.target.as_deref() == Some(target)
            {
                count += 1;
                break;
            }
        }
    }
    count
}

pub fn file_churn(files: &BTreeMap<String, FileTouchRow>) -> (i64, i64) {
    let mut max_edits = 0;
    let mut churn = 0;
    for row in files.values() {
        max_edits = max_edits.max(row.edit_count);
        if row.edit_count >= CHURN_EDIT_THRESHOLD {
            churn += 1;
        }
    }
    (max_edits, churn)
}

// ---------------------------------------------------------------------------
// Work tags
// ---------------------------------------------------------------------------

// These low thresholds reflect the observed sparse tool-event distribution.
// The final character-volume fallback guarantees every non-conversation
// session still receives one useful tag when no explicit signal is present.
pub const EXPLORE_RATIO: f64 = 0.25;
pub const IMPLEMENT_RATIO: f64 = 0.08;
pub const VERIFY_MIN_RUNS: i64 = 1;
pub const DEBUG_ERROR_RATE: f64 = 0.10;
pub const DEBUG_MIN_RETRY: i64 = 1;
pub const ORCHESTRATE_MIN_CALLS: i64 = 2;
pub const RESEARCH_MIN_CALLS: i64 = 1;
pub const CONVERSE_MAX_TOOLS: i64 = 3;
pub const CONVERSE_MIN_MESSAGES: i64 = 3;
pub const LONGHAUL_MIN_TURNS: i64 = 75;

#[derive(Debug, Clone, Copy, Default)]
pub struct WorkTagStats {
    pub tool_calls: i64,
    pub read_calls: i64,
    pub edit_calls: i64,
    pub verify_runs: i64,
    pub orchestrate_calls: i64,
    pub research_calls: i64,
    pub tool_error_rate: f64,
    pub retry_bash: i64,
    pub user_msg_count: i64,
    pub turn_count: i64,
    pub compact_count: i64,
    pub read_chars: i64,
    pub exec_chars: i64,
    pub write_chars: i64,
}

/// Tags are **not** mutually exclusive. Summing cost per tag therefore exceeds
/// the grand total; the aggregation APIs flag that with `overlapping: true`
/// instead of pro-rating, because pro-rating would invent a split the data
/// does not contain.
pub fn work_tags(stats: &WorkTagStats) -> Vec<String> {
    let mut tags = Vec::new();
    let calls = stats.tool_calls;

    if calls > 0 && stats.read_calls as f64 / calls as f64 >= EXPLORE_RATIO {
        tags.push("explore".to_string());
    }
    if calls > 0 && stats.edit_calls as f64 / calls as f64 >= IMPLEMENT_RATIO {
        tags.push("implement".to_string());
    }
    if stats.verify_runs >= VERIFY_MIN_RUNS {
        tags.push("verify".to_string());
    }
    if stats.tool_error_rate >= DEBUG_ERROR_RATE && stats.retry_bash >= DEBUG_MIN_RETRY {
        tags.push("debug".to_string());
    }
    if stats.orchestrate_calls >= ORCHESTRATE_MIN_CALLS {
        tags.push("orchestrate".to_string());
    }
    if stats.research_calls >= RESEARCH_MIN_CALLS {
        tags.push("research".to_string());
    }
    if calls < CONVERSE_MAX_TOOLS && stats.user_msg_count >= CONVERSE_MIN_MESSAGES {
        tags.push("converse".to_string());
    }
    if stats.turn_count >= LONGHAUL_MIN_TURNS || stats.compact_count >= 1 {
        tags.push("longhaul".to_string());
    }
    if tags.is_empty() {
        // Read, exec, write is also the deterministic tie order. This handles
        // old sparse rows whose three recorded volumes are all zero.
        let mut fallback = (stats.read_chars, "explore");
        for candidate in [
            (stats.exec_chars, "verify"),
            (stats.write_chars, "implement"),
        ] {
            if candidate.0 > fallback.0 {
                fallback = candidate;
            }
        }
        tags.push(fallback.1.to_string());
    }
    tags
}

/// True when a shell invocation looks like a build/test command.
pub fn is_verify_command(target: Option<&str>) -> bool {
    let Some(target) = target else {
        return false;
    };
    VERIFY_COMMANDS.contains(&target)
}

// ---------------------------------------------------------------------------
// Goal keys
// ---------------------------------------------------------------------------

/// Length of the `first_prompt` prefix used when no AI title exists.
pub const GOAL_PROMPT_PREFIX: usize = 40;

/// Normalise a title into a grouping key: strip symbols, collapse whitespace,
/// lowercase. Returns `None` rather than an empty string when nothing is left,
/// so `ailog_breakdown(dimension="title")` never invents a bucket.
pub fn goal_key(ai_title: Option<&str>, first_prompt: Option<&str>) -> Option<String> {
    let source = ai_title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            first_prompt
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| crate::ailog::truncate_chars(value, GOAL_PROMPT_PREFIX))
        })?;

    let cleaned: String = source
        .chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect();
    let key = cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// First whitespace-separated word of a shell command, used as `tool_event
/// .target` for exec-class calls and as the retry-detection key.
pub fn command_stem(command: &str) -> Option<String> {
    command
        .split_whitespace()
        .next()
        .map(|word| {
            let trimmed = word.trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '&');
            // `C:\path\to\python.exe` and `/usr/bin/python` both stem to the
            // executable name so the same command matches across shells.
            let tail = trimmed
                .rsplit(|ch| ch == '/' || ch == '\\')
                .next()
                .unwrap_or(trimmed);
            tail.trim_end_matches(".exe").to_string()
        })
        .filter(|word| !word.is_empty())
}

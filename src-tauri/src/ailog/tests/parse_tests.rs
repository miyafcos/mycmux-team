//! Parser-level tests: token accounting, deduplication and the deterministic
//! metric helpers.

use super::fixtures::*;
use crate::ailog::metrics::{self, WorkTagStats};
use crate::ailog::{parse_claude, parse_codex};

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

#[test]
fn split_request_lines_collapse_into_one_turn() {
    let text = CLAUDE_SPLIT_REQUEST.join("\n");
    let data = parse_claude::parse_chunk(&text, "S1");
    let session = data.sessions.get("S1").expect("session S1");

    assert_eq!(
        session.turns.len(),
        1,
        "two lines sharing a requestId must be one turn"
    );
    let turn = &session.turns[0];
    // Exactly one copy of the usage block, not two and not the mirrored
    // iterations[] entry added on top.
    assert_eq!(turn.input_tokens, 2);
    assert_eq!(turn.output_tokens, 100);
    assert_eq!(turn.cache_read_tokens, 1000);
    assert_eq!(turn.cache_write_1h_tokens, 500);
    assert_eq!(turn.cache_write_5m_tokens, 0);
    // The tool_use block from the second line is still collected.
    assert_eq!(turn.tool_calls, 1);
    assert_eq!(session.tools.len(), 1);
    assert_eq!(session.tools[0].name, "Read");
}

#[test]
fn usage_iterations_are_never_added_to_the_top_level() {
    // A single line whose iterations[] holds the same numbers as the top
    // level: reading both would exactly double every counter.
    let line = r#"{"type":"assistant","sessionId":"S9","requestId":"only","timestamp":"2026-08-01T00:00:00.000Z","uuid":"u","message":{"id":"m","model":"claude-opus-5","content":[],"usage":{"input_tokens":7,"output_tokens":11,"cache_read_input_tokens":13,"cache_creation_input_tokens":17,"iterations":[{"input_tokens":7,"output_tokens":11,"cache_read_input_tokens":13,"cache_creation_input_tokens":17}]}}}"#;
    let data = parse_claude::parse_chunk(line, "S9");
    let turn = &data.sessions["S9"].turns[0];
    assert_eq!(turn.input_tokens, 7);
    assert_eq!(turn.output_tokens, 11);
    assert_eq!(turn.cache_read_tokens, 13);
    assert_eq!(turn.cache_write_5m_tokens, 17);
}

#[test]
fn cache_creation_split_prefers_the_detailed_object() {
    let line = r#"{"type":"assistant","sessionId":"S","requestId":"r","timestamp":"2026-08-01T00:00:00.000Z","message":{"id":"m","model":"claude-opus-5","content":[],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":900,"cache_creation":{"ephemeral_5m_input_tokens":300,"ephemeral_1h_input_tokens":600}}}}"#;
    let data = parse_claude::parse_chunk(line, "S");
    let turn = &data.sessions["S"].turns[0];
    assert_eq!(turn.cache_write_5m_tokens, 300);
    assert_eq!(turn.cache_write_1h_tokens, 600);
}

#[test]
fn user_text_counts_as_a_message_but_tool_results_do_not() {
    let text = CLAUDE_IO_SESSION.join("\n");
    let data = parse_claude::parse_chunk(&text, "S2");
    let session = &data.sessions["S2"];
    assert_eq!(session.user_msg_count, 1);
    assert_eq!(session.results.len(), 4);
    assert_eq!(session.first_prompt.as_deref(), Some("最初の指示です"));
    assert_eq!(session.active_ms, 4000);
    assert_eq!(session.ai_title.as_deref(), Some("I/O  Buckets — Test!!"));
    // Edit's `new_string` is measured on the way in.
    assert_eq!(session.write_chars, 5);
}

#[test]
fn agent_name_uses_the_real_key() {
    let line = r#"{"type":"agent-name","agentName":"dnd-session-fix","sessionId":"S"}"#;
    let data = parse_claude::parse_chunk(line, "S");
    assert_eq!(data.sessions["S"].agent_names, vec!["dnd-session-fix"]);
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

#[test]
fn codex_uses_last_token_usage_not_the_cumulative_total() {
    let text = CODEX_TOKEN_COUNTS.join("\n");
    let data = parse_codex::parse_chunk(&text, "CX1");
    let session = data.sessions.get("CX1").expect("session CX1");

    assert_eq!(session.turns.len(), 2);
    // Second event: last = 2000 in / 200 out, total = 3000 / 300. Taking the
    // total here would show 3000 instead of 2000.
    let outputs: Vec<i64> = session
        .turns
        .iter()
        .map(|turn| turn.output_tokens)
        .collect();
    assert_eq!(outputs, vec![100, 200]);

    // `input_tokens` includes `cached_input_tokens`, so the cached half is
    // moved to the cache-read column instead of being billed as fresh input.
    let inputs: Vec<i64> = session.turns.iter().map(|turn| turn.input_tokens).collect();
    let cached: Vec<i64> = session
        .turns
        .iter()
        .map(|turn| turn.cache_read_tokens)
        .collect();
    assert_eq!(inputs, vec![600, 1000]);
    assert_eq!(cached, vec![400, 1000]);

    // reasoning is a subset of output and is retained for reporting only.
    let reasoning: Vec<i64> = session
        .turns
        .iter()
        .map(|turn| turn.reasoning_tokens)
        .collect();
    assert_eq!(reasoning, vec![40, 50]);

    assert_eq!(session.plan_type.as_deref(), Some("pro"));
    assert_eq!(session.session_id, "CX1");
}

#[test]
fn codex_attributes_each_turn_to_the_current_turn_context_model() {
    let text = CODEX_HANDOFF.join("\n");
    let data = parse_codex::parse_chunk(&text, "CX2");
    let models: Vec<Option<String>> = data.sessions["CX2"]
        .turns
        .iter()
        .map(|turn| turn.model.clone())
        .collect();
    assert_eq!(
        models,
        vec![
            Some("gpt-5.6-terra".to_string()),
            Some("gpt-5.6-sol".to_string()),
            Some("gpt-5.6-terra".to_string()),
        ]
    );
}

#[test]
fn codex_exit_code_drives_the_error_flag() {
    assert!(!parse_codex::output_is_error(
        "Script completed\nExit code: 0\nOutput:\nfine"
    ));
    assert!(parse_codex::output_is_error(
        "Script completed\nExit code: 1\nOutput:\nboom"
    ));
    // The wrapper prints its own line first; the inner code still wins.
    assert!(parse_codex::output_is_error(
        "Script completed\nExit code: 0\nOutput:\nExit code: 2\n"
    ));
    assert!(!parse_codex::output_is_error("no exit code anywhere"));
    assert!(parse_codex::output_is_error("{\"success\": false}"));
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

#[test]
fn rework_score_hits_both_ends_of_the_scale() {
    assert_eq!(metrics::rework_score(0.0, 0, 0, false), 0.0);
    // Every component saturated -> 0.35 + 0.25 + 0.25 + 0.15 = 1.0.
    assert_eq!(metrics::rework_score(0.15, 10, 5, true), 100.0);
    // Beyond saturation stays clamped rather than overflowing.
    assert_eq!(metrics::rework_score(0.9, 100, 50, true), 100.0);
    // Each weight contributes exactly its share.
    assert!((metrics::rework_score(0.15, 0, 0, false) - 35.0).abs() < 1e-9);
    assert!((metrics::rework_score(0.0, 10, 0, false) - 25.0).abs() < 1e-9);
    assert!((metrics::rework_score(0.0, 0, 5, false) - 25.0).abs() < 1e-9);
    assert!((metrics::rework_score(0.0, 0, 0, true) - 15.0).abs() < 1e-9);
}

fn base_stats() -> WorkTagStats {
    WorkTagStats {
        tool_calls: 100,
        read_calls: 0,
        edit_calls: 0,
        verify_runs: 0,
        orchestrate_calls: 0,
        research_calls: 0,
        tool_error_rate: 0.0,
        retry_bash: 0,
        user_msg_count: 0,
        turn_count: 0,
        compact_count: 0,
    }
}

#[test]
fn work_tag_thresholds_are_inclusive_at_the_boundary() {
    // explore: >= 50%
    let mut stats = base_stats();
    stats.read_calls = 50;
    assert!(metrics::work_tags(&stats).contains(&"explore".to_string()));
    stats.read_calls = 49;
    assert!(!metrics::work_tags(&stats).contains(&"explore".to_string()));

    // implement: >= 20%
    let mut stats = base_stats();
    stats.edit_calls = 20;
    assert!(metrics::work_tags(&stats).contains(&"implement".to_string()));
    stats.edit_calls = 19;
    assert!(!metrics::work_tags(&stats).contains(&"implement".to_string()));

    // verify: >= 5 runs
    let mut stats = base_stats();
    stats.verify_runs = 5;
    assert!(metrics::work_tags(&stats).contains(&"verify".to_string()));
    stats.verify_runs = 4;
    assert!(!metrics::work_tags(&stats).contains(&"verify".to_string()));

    // debug: rate >= 0.10 AND retry >= 2 (both required)
    let mut stats = base_stats();
    stats.tool_error_rate = 0.10;
    stats.retry_bash = 2;
    assert!(metrics::work_tags(&stats).contains(&"debug".to_string()));
    stats.retry_bash = 1;
    assert!(!metrics::work_tags(&stats).contains(&"debug".to_string()));
    stats.retry_bash = 2;
    stats.tool_error_rate = 0.09;
    assert!(!metrics::work_tags(&stats).contains(&"debug".to_string()));

    // orchestrate: >= 1
    let mut stats = base_stats();
    stats.orchestrate_calls = 1;
    assert!(metrics::work_tags(&stats).contains(&"orchestrate".to_string()));
    stats.orchestrate_calls = 0;
    assert!(!metrics::work_tags(&stats).contains(&"orchestrate".to_string()));

    // research: >= 3
    let mut stats = base_stats();
    stats.research_calls = 3;
    assert!(metrics::work_tags(&stats).contains(&"research".to_string()));
    stats.research_calls = 2;
    assert!(!metrics::work_tags(&stats).contains(&"research".to_string()));

    // converse: tool_calls < 5 AND user messages >= 3
    let mut stats = base_stats();
    stats.tool_calls = 4;
    stats.user_msg_count = 3;
    assert!(metrics::work_tags(&stats).contains(&"converse".to_string()));
    stats.tool_calls = 5;
    assert!(!metrics::work_tags(&stats).contains(&"converse".to_string()));
    stats.tool_calls = 4;
    stats.user_msg_count = 2;
    assert!(!metrics::work_tags(&stats).contains(&"converse".to_string()));

    // longhaul: turns >= 100 OR any compaction
    let mut stats = base_stats();
    stats.turn_count = 100;
    assert!(metrics::work_tags(&stats).contains(&"longhaul".to_string()));
    stats.turn_count = 99;
    assert!(!metrics::work_tags(&stats).contains(&"longhaul".to_string()));
    stats.compact_count = 1;
    assert!(metrics::work_tags(&stats).contains(&"longhaul".to_string()));
}

#[test]
fn a_session_can_carry_several_tags_at_once() {
    let stats = WorkTagStats {
        tool_calls: 10,
        read_calls: 6,
        edit_calls: 3,
        verify_runs: 5,
        orchestrate_calls: 1,
        research_calls: 3,
        tool_error_rate: 0.2,
        retry_bash: 3,
        user_msg_count: 1,
        turn_count: 120,
        compact_count: 1,
    };
    let tags = metrics::work_tags(&stats);
    for expected in [
        "explore",
        "implement",
        "verify",
        "debug",
        "orchestrate",
        "research",
        "longhaul",
    ] {
        assert!(tags.contains(&expected.to_string()), "missing {expected}");
    }
    assert!(!tags.contains(&"converse".to_string()));
}

#[test]
fn zero_tool_calls_never_produce_a_ratio_tag() {
    let mut stats = base_stats();
    stats.tool_calls = 0;
    let tags = metrics::work_tags(&stats);
    assert!(!tags.contains(&"explore".to_string()));
    assert!(!tags.contains(&"implement".to_string()));
}

#[test]
fn goal_key_normalises_and_falls_back() {
    assert_eq!(
        metrics::goal_key(Some("  Fix   the  Parser!! "), None).as_deref(),
        Some("fix the parser")
    );
    // Falls back to the prompt prefix when there is no AI title.
    assert_eq!(
        metrics::goal_key(None, Some("Refactor  the INDEXER")).as_deref(),
        Some("refactor the indexer")
    );
    // An empty title is treated as absent rather than winning over the prompt.
    assert_eq!(
        metrics::goal_key(Some("   "), Some("Fallback Title")).as_deref(),
        Some("fallback title")
    );
    // Nothing usable -> NULL, never an invented bucket.
    assert_eq!(metrics::goal_key(None, None), None);
    assert_eq!(metrics::goal_key(Some("!!!"), None), None);
    // Japanese text survives the symbol strip.
    assert_eq!(
        metrics::goal_key(Some("タブの関係性・主従の整理"), None).as_deref(),
        Some("タブの関係性 主従の整理")
    );
}

#[test]
fn correction_patterns_are_fixed_and_count_once_per_utterance() {
    assert!(metrics::is_correction("それは違う"));
    assert!(metrics::is_correction("まだ直っていない"));
    assert!(metrics::is_correction("勝手に変えないで"));
    assert!(!metrics::is_correction("ありがとう、完璧です"));
    assert_eq!(metrics::CORRECTION_PATTERNS.len(), 16);
}

#[test]
fn retry_bash_needs_the_same_command_within_the_window() {
    use crate::ailog::ToolRow;
    let tool = |name: &str, target: &str, is_error: bool| ToolRow {
        call_id: None,
        ts: 0,
        name: name.to_string(),
        is_error,
        target: Some(target.to_string()),
        turn_key: None,
    };

    // Failure immediately retried with the same stem.
    let events = vec![tool("Bash", "cargo", true), tool("Bash", "cargo", false)];
    assert_eq!(metrics::count_retry_bash(&events), 1);

    // A different command is not a retry.
    let events = vec![tool("Bash", "cargo", true), tool("Bash", "npm", false)];
    assert_eq!(metrics::count_retry_bash(&events), 0);

    // Outside the three-event window it no longer counts.
    let events = vec![
        tool("Bash", "cargo", true),
        tool("Read", "a", false),
        tool("Read", "b", false),
        tool("Read", "c", false),
        tool("Bash", "cargo", false),
    ];
    assert_eq!(metrics::count_retry_bash(&events), 0);
}

#[test]
fn command_stem_strips_paths_and_extensions() {
    assert_eq!(
        metrics::command_stem("cargo test --release").as_deref(),
        Some("cargo")
    );
    assert_eq!(
        metrics::command_stem("C:\\Python\\python.exe script.py").as_deref(),
        Some("python")
    );
    assert_eq!(metrics::command_stem("   ").as_deref(), None);
}

#[test]
fn tool_classification_covers_both_transcript_formats() {
    use crate::ailog::metrics::ToolClass;
    assert_eq!(metrics::classify_tool("Read"), ToolClass::Read);
    assert_eq!(metrics::classify_tool("Edit"), ToolClass::Edit);
    assert_eq!(metrics::classify_tool("Bash"), ToolClass::Exec);
    assert_eq!(metrics::classify_tool("WebFetch"), ToolClass::Fetch);
    assert_eq!(
        metrics::classify_tool("mcp__deepwiki__ask_question"),
        ToolClass::Fetch
    );
    assert_eq!(metrics::classify_tool("Agent"), ToolClass::Orchestrate);
    assert_eq!(metrics::classify_tool("TaskCreate"), ToolClass::Orchestrate);
    assert_eq!(metrics::classify_tool("exec"), ToolClass::Exec);
    assert_eq!(metrics::classify_tool("shell_command"), ToolClass::Exec);
    assert_eq!(metrics::classify_tool("apply_patch"), ToolClass::Edit);
    assert_eq!(
        metrics::classify_tool("spawn_agent"),
        ToolClass::Orchestrate
    );
    // Anything unrecognised stays Other so it can never pollute read/write.
    assert_eq!(metrics::classify_tool("Zzzcustom"), ToolClass::Other);
}

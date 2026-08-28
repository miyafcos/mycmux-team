//! Shared helpers for the ailog tests: temporary transcript trees, a scratch
//! database, and a synchronous wrapper around the async indexer.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use rusqlite::Connection;

use crate::ailog::index::{self, IndexOptions, IndexReport};

pub struct Fixture {
    /// Held only so the temporary tree outlives the test; dropping it deletes
    /// the transcripts and the database.
    #[allow(dead_code)]
    dir: tempfile::TempDir,
    pub logs: PathBuf,
    pub archive: PathBuf,
    pub db: PathBuf,
}

impl Fixture {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let logs = dir.path().join("logs");
        let archive = dir.path().join("archive");
        std::fs::create_dir_all(&logs).expect("create logs dir");
        std::fs::create_dir_all(&archive).expect("create archive dir");
        let db = dir.path().join("ailog.db");
        Self { dir, logs, archive, db }
    }

    pub fn write(&self, name: &str, lines: &[&str]) -> PathBuf {
        let path = self.logs.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        let mut body = lines.join("\n");
        body.push('\n');
        std::fs::write(&path, body).expect("write transcript");
        path
    }

    /// Append lines to an existing transcript, mirroring how the CLIs grow one.
    pub fn append(&self, name: &str, lines: &[&str]) {
        use std::io::Write;
        let path = self.logs.join(name);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open for append");
        for line in lines {
            writeln!(file, "{line}").expect("append line");
        }
    }

    pub fn write_gzip(&self, kind: &str, name: &str, lines: &[&str]) -> PathBuf {
        let path = self.archive.join(kind).join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create archive parent");
        }
        let mut body = lines.join("\n");
        body.push('\n');
        let file = std::fs::File::create(&path).expect("create gzip transcript");
        let mut encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        encoder.write_all(body.as_bytes()).expect("write gzip transcript");
        encoder.finish().expect("finish gzip transcript");
        path
    }

    pub fn index(&self, kind: &'static str, full: bool) -> IndexReport {
        index_dir(kind, &self.logs, &self.db, full)
    }

    pub fn index_with_archive(&self, kind: &'static str, full: bool) -> IndexReport {
        index_dir_with_archive(kind, &self.logs, &self.archive, &self.db, full)
    }

    pub fn conn(&self) -> Connection {
        crate::ailog::open_db(&self.db).expect("open db")
    }

    pub fn count(&self, table: &str) -> i64 {
        self.conn()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count rows")
    }
}

pub fn index_dir(kind: &'static str, logs: &Path, db: &Path, full: bool) -> IndexReport {
    index_dir_with_optional_archive(kind, logs, None, db, full)
}

pub fn index_dir_with_archive(
    kind: &'static str,
    logs: &Path,
    archive: &Path,
    db: &Path,
    full: bool,
) -> IndexReport {
    index_dir_with_optional_archive(kind, logs, Some(archive), db, full)
}

fn index_dir_with_optional_archive(
    kind: &'static str,
    logs: &Path,
    archive: Option<&Path>,
    db: &Path,
    full: bool,
) -> IndexReport {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let mut options = IndexOptions::new(db.to_path_buf());
    options.full = full;
    options.roots = vec![(kind, logs.to_path_buf())];
    options.archive_root = archive.map(Path::to_path_buf);
    runtime
        .block_on(index::run_index(
            options,
            Arc::new(AtomicBool::new(false)),
            None,
        ))
        .expect("index run")
}

// ---------------------------------------------------------------------------
// Claude fixtures
// ---------------------------------------------------------------------------

/// Two `assistant` records sharing one `requestId`, exactly as streaming
/// writes them: identical `usage` (including a mirrored `iterations[]`) but
/// different content blocks.
pub const CLAUDE_SPLIT_REQUEST: &[&str] = &[
    r#"{"type":"assistant","sessionId":"S1","requestId":"req_1","timestamp":"2026-08-01T00:00:00.000Z","cwd":"C:\\proj\\alpha","gitBranch":"main","entrypoint":"cli","version":"2.1.0","isSidechain":false,"effort":"high","uuid":"u1","message":{"id":"msg_1","model":"claude-opus-5","role":"assistant","content":[{"type":"thinking","thinking":""}],"usage":{"input_tokens":2,"output_tokens":100,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":500},"service_tier":"standard","iterations":[{"input_tokens":2,"output_tokens":100,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500}]}}}"#,
    r#"{"type":"assistant","sessionId":"S1","requestId":"req_1","timestamp":"2026-08-01T00:00:01.000Z","cwd":"C:\\proj\\alpha","gitBranch":"main","entrypoint":"cli","version":"2.1.0","isSidechain":false,"effort":"high","uuid":"u2","message":{"id":"msg_1","model":"claude-opus-5","role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"C:\\proj\\alpha\\a.rs"}}],"usage":{"input_tokens":2,"output_tokens":100,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":500},"service_tier":"standard","iterations":[{"input_tokens":2,"output_tokens":100,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500}]}}}"#,
];

/// A session that exercises every I/O character bucket, including a tool whose
/// name identifies nothing.
pub const CLAUDE_IO_SESSION: &[&str] = &[
    r#"{"type":"user","sessionId":"S2","timestamp":"2026-08-01T00:00:00.000Z","cwd":"C:\\proj\\beta","gitBranch":"main","entrypoint":"cli","message":{"role":"user","content":"最初の指示です"}}"#,
    r#"{"type":"assistant","sessionId":"S2","requestId":"req_a","timestamp":"2026-08-01T00:00:01.000Z","cwd":"C:\\proj\\beta","gitBranch":"main","entrypoint":"cli","uuid":"a1","message":{"id":"m_a","model":"claude-opus-5","role":"assistant","content":[{"type":"tool_use","id":"c_read","name":"Read","input":{"file_path":"C:\\proj\\beta\\x.rs"}},{"type":"tool_use","id":"c_bash","name":"Bash","input":{"command":"cargo test --release"}},{"type":"tool_use","id":"c_edit","name":"Edit","input":{"file_path":"C:\\proj\\beta\\x.rs","new_string":"abcde"}},{"type":"tool_use","id":"c_weird","name":"Zzzcustom","input":{}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
    r#"{"type":"user","sessionId":"S2","timestamp":"2026-08-01T00:00:02.000Z","cwd":"C:\\proj\\beta","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c_read","content":"1234567890"},{"type":"tool_result","tool_use_id":"c_bash","content":"123","is_error":true},{"type":"tool_result","tool_use_id":"c_edit","content":"ok"},{"type":"tool_result","tool_use_id":"c_weird","content":"1234"}]}}"#,
    r#"{"type":"ai-title","aiTitle":"  I/O  Buckets — Test!! ","sessionId":"S2"}"#,
    r#"{"type":"system","subtype":"turn_duration","sessionId":"S2","timestamp":"2026-08-01T00:00:03.000Z","durationMs":4000,"messageCount":4}"#,
    // A compaction makes this session `longhaul` as well as `implement`, so
    // the overlapping-tag behaviour has something to overlap.
    r#"{"type":"system","subtype":"compact_boundary","sessionId":"S2","timestamp":"2026-08-01T00:00:04.000Z"}"#,
];

/// One session that uses two models, with the second far more expensive so a
/// cost-based `primary_model` is distinguishable from a first-seen one.
pub const CLAUDE_MIXED_MODELS: &[&str] = &[
    r#"{"type":"assistant","sessionId":"S3","requestId":"r1","timestamp":"2026-08-02T00:00:00.000Z","cwd":"C:\\proj\\gamma","gitBranch":"dev","entrypoint":"cli","uuid":"x1","message":{"id":"m1","model":"claude-opus-5","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
    r#"{"type":"assistant","sessionId":"S3","requestId":"r2","timestamp":"2026-08-02T00:00:10.000Z","cwd":"C:\\proj\\gamma","gitBranch":"dev","entrypoint":"cli","uuid":"x2","message":{"id":"m2","model":"claude-haiku-4-5-20251001","role":"assistant","content":[],"usage":{"input_tokens":0,"output_tokens":100000000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
    r#"{"type":"assistant","sessionId":"S3","requestId":"r3","timestamp":"2026-08-02T00:00:20.000Z","cwd":"C:\\proj\\gamma","gitBranch":"dev","entrypoint":"cli","uuid":"x3","message":{"id":"m3","model":"claude-opus-5","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
];

/// A model string that is deliberately absent from the price table.
pub const CLAUDE_UNKNOWN_MODEL: &[&str] = &[
    r#"{"type":"assistant","sessionId":"S4","requestId":"q1","timestamp":"2026-08-03T00:00:00.000Z","cwd":"C:\\proj\\delta","entrypoint":"cli","uuid":"y1","message":{"id":"n1","model":"totally-unknown-model-x","role":"assistant","content":[],"usage":{"input_tokens":1000,"output_tokens":2000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
];

// ---------------------------------------------------------------------------
// Codex fixtures
// ---------------------------------------------------------------------------

/// `total_token_usage` is cumulative and `last_token_usage` is the delta; a
/// parser that reads the wrong one produces obviously different sums.
pub const CODEX_TOKEN_COUNTS: &[&str] = &[
    r#"{"timestamp":"2026-08-04T00:00:00.000Z","type":"session_meta","payload":{"id":"CX1","session_id":"root","cwd":"C:\\proj\\codex","originator":"codex-tui","cli_version":"0.147.0","source":"cli","model_provider":"openai"}}"#,
    r#"{"timestamp":"2026-08-04T00:00:01.000Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.6-terra","effort":"high","cwd":"C:\\proj\\codex"}}"#,
    r#"{"timestamp":"2026-08-04T00:00:02.000Z","ordinal":1,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"cache_write_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":40,"total_tokens":1100},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"cache_write_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":40,"total_tokens":1100}},"rate_limits":{"plan_type":"pro"}}}"#,
    r#"{"timestamp":"2026-08-04T00:00:03.000Z","ordinal":2,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":1400,"cache_write_input_tokens":0,"output_tokens":300,"reasoning_output_tokens":90,"total_tokens":3300},"last_token_usage":{"input_tokens":2000,"cached_input_tokens":1000,"cache_write_input_tokens":0,"output_tokens":200,"reasoning_output_tokens":50,"total_tokens":2200}},"rate_limits":{"plan_type":"pro"}}}"#,
];

/// A Codex session whose model changes A -> B -> A within one thread.
pub const CODEX_HANDOFF: &[&str] = &[
    r#"{"timestamp":"2026-08-05T00:00:00.000Z","type":"session_meta","payload":{"id":"CX2","cwd":"C:\\proj\\codex2","originator":"codex-tui","cli_version":"0.147.0","source":"cli"}}"#,
    r#"{"timestamp":"2026-08-05T00:00:01.000Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.6-terra","effort":"high"}}"#,
    r#"{"timestamp":"2026-08-05T00:00:02.000Z","ordinal":1,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"total_tokens":110},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"total_tokens":110}}}}"#,
    r#"{"timestamp":"2026-08-05T00:00:03.000Z","type":"turn_context","payload":{"turn_id":"t2","model":"gpt-5.6-sol","effort":"xhigh"}}"#,
    r#"{"timestamp":"2026-08-05T00:00:04.000Z","ordinal":2,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":0,"output_tokens":30,"total_tokens":330},"last_token_usage":{"input_tokens":200,"cached_input_tokens":0,"output_tokens":20,"total_tokens":220}}}}"#,
    r#"{"timestamp":"2026-08-05T00:00:05.000Z","type":"turn_context","payload":{"turn_id":"t3","model":"gpt-5.6-terra","effort":"high"}}"#,
    r#"{"timestamp":"2026-08-05T00:00:06.000Z","ordinal":3,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":400,"cached_input_tokens":0,"output_tokens":40,"total_tokens":440},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"total_tokens":110}}}}"#,
];

// ---------------------------------------------------------------------------
// Grok fixtures
// ---------------------------------------------------------------------------

/// Minimal ACP updates fixture: a split user message, one tool lifecycle, and
/// one completed turn with provider-reported usage/cost.
pub const GROK_UPDATES: &[&str] = &[
    r#"{"timestamp":1786900000,"method":"session/update","params":{"sessionId":"G1","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hello "},"_meta":{"modelId":"grok-4.6","promptIndex":0}},"_meta":{"eventId":"G1-1","agentTimestampMs":1786900000000}}}"#,
    r#"{"timestamp":1786900001,"method":"session/update","params":{"sessionId":"G1","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"world"},"_meta":{"modelId":"grok-4.6","promptIndex":0}},"_meta":{"eventId":"G1-2","agentTimestampMs":1786900001000}}}"#,
    r#"{"timestamp":1786900002,"method":"session/update","params":{"sessionId":"G1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"I will read it."}},"_meta":{"eventId":"G1-3","agentTimestampMs":1786900002000,"promptId":"P1"}}}"#,
    r#"{"timestamp":1786900003,"method":"session/update","params":{"sessionId":"G1","update":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"read_file","kind":"read","status":"in_progress","rawInput":{"path":"C:\\proj\\a.rs"}},"_meta":{"eventId":"G1-4","agentTimestampMs":1786900003000,"promptId":"P1"}}}"#,
    r#"{"timestamp":1786900004,"method":"session/update","params":{"sessionId":"G1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed","rawOutput":{"output":"ok"}},"_meta":{"eventId":"G1-5","agentTimestampMs":1786900004000,"promptId":"P1"}}}"#,
    r#"{"timestamp":1786900005,"method":"_x.ai/session/update","params":{"sessionId":"G1","update":{"sessionUpdate":"turn_completed","prompt_id":"P1","stop_reason":"end_turn","usage":{"inputTokens":1000,"outputTokens":100,"totalTokens":1100,"cachedReadTokens":400,"cacheCreationTokens":25,"reasoningTokens":40,"modelCalls":1,"apiDurationMs":55,"costUsdTicks":1234500000,"modelUsage":{"grok-4.6-build":{"inputTokens":1000,"outputTokens":100,"totalTokens":1100,"cachedReadTokens":400,"cacheCreationTokens":25,"reasoningTokens":40,"modelCalls":1,"apiDurationMs":55,"costUsdTicks":1234500000}},"numTurns":1}},"_meta":{"eventId":"G1-6","agentTimestampMs":1786900005000}}}"#,
];

/// This file must exist beside the fixture but must not become an indexed
/// source. Its content is deliberately Grok-shaped to catch extension-only
/// collection regressions.
pub const GROK_EVENTS: &[&str] = &[
    r#"{"ts":"2026-08-17T00:00:00.000Z","type":"turn_started","session_id":"G1","model_id":"grok-4.6"}"#,
];

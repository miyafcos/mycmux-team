//! Daily AI-log digest generation and persistence.

use std::collections::HashMap;
use std::env;
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use chrono::{NaiveDate, TimeZone, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::ailog::{truncate_chars, ORIGIN_AILOG_INTERNAL};

pub const PROMPT_VERSION: i64 = 1;
const PROMPT: &str = include_str!("prompts/digest_v1_ja.txt");
const MODEL: &str = "gpt-5.6-luna";
const TIMEOUT: Duration = Duration::from_secs(120);
const MARKER: &str = "[mycmux-ailog-summarizer]";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DigestContent {
    pub headline: String,
    pub wins: Vec<String>,
    pub biggest_rework: BiggestRework,
    pub value_note: String,
    pub suggestion: String,
    pub confidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BiggestRework {
    pub exists: bool,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeCounts {
    pub done: i64,
    pub partial: i64,
    pub abandoned: i64,
    pub unclear: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DigestMetrics {
    pub sessions: i64,
    pub cost_usd: f64,
    pub turns: i64,
    pub average_rework: f64,
    pub outcomes: OutcomeCounts,
    pub previous_sessions: i64,
    pub previous_cost_usd: f64,
    pub previous_turns: i64,
    pub cost_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DigestRecord {
    pub date: String,
    pub created_at: i64,
    pub prompt_version: i64,
    pub model_used: Option<String>,
    pub content: DigestContent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestReport {
    pub date: String,
    pub digest: Option<DigestRecord>,
    pub metrics: DigestMetrics,
    pub reason: Option<String>,
    pub parse_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestInput {
    date: String,
    sessions: Vec<InputSession>,
    metrics: DigestInputMetrics,
    previous_metrics: DigestInputMetrics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InputSession {
    goal: String,
    goal_cluster: String,
    outcome: String,
    findings: serde_json::Value,
    rework: serde_json::Value,
    cost_note: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestInputMetrics {
    sessions: i64,
    total_cost_usd: f64,
    total_turns: i64,
    average_rework: f64,
    tool_failures: Vec<RankedValue>,
    churn_files: Vec<RankedValue>,
}

#[derive(Debug, Clone, Serialize)]
struct RankedValue {
    name: String,
    count: i64,
}

#[derive(Debug, Deserialize)]
struct RawDigestContent {
    headline: String,
    wins: Vec<String>,
    biggest_rework: BiggestRework,
    value_note: String,
    suggestion: String,
    confidence: String,
}

pub fn get(conn: &Connection, date: &str) -> Result<DigestReport, String> {
    let (start, end) = day_bounds(date)?;
    let metrics = read_metrics(conn, start, end)?;
    let parse_error = conn
        .query_row(
            "SELECT parse_error FROM digest WHERE kind='all' AND date=?1",
            [date],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    let digest = conn
        .query_row(
            "SELECT created_at,prompt_version,model_used,json FROM digest WHERE kind='all' AND date=?1 AND json IS NOT NULL",
            [date],
            |row| {
                let created_at = row.get(0)?;
                let prompt_version = row.get(1)?;
                let model_used = row.get(2)?;
                let json: String = row.get(3)?;
                Ok((created_at, prompt_version, model_used, json))
            },
        )
        .ok()
        .and_then(|(created_at, prompt_version, model_used, json)| {
            serde_json::from_str::<DigestContent>(&json).ok().map(|content| DigestRecord {
                date: date.to_string(),
                created_at,
                prompt_version,
                model_used,
                content,
            })
        });
    let reason = if digest.is_none() {
        Some(if parse_error.is_some() {
            "生成エラーがあります".to_string()
        } else if metrics.sessions == 0 {
            "この日の要約対象がありません。先に要約が必要です".to_string()
        } else {
            "この日の要約はまだありません".to_string()
        })
    } else {
        None
    };
    Ok(DigestReport {
        date: date.to_string(),
        digest,
        metrics,
        reason,
        parse_error,
    })
}

pub fn generate(conn: &mut Connection, date: &str, force: bool) -> Result<DigestReport, String> {
    let (start, end) = day_bounds(date)?;
    if !needs_generation(conn, date, force)? {
        return get(conn, date);
    }
    let input = build_input(conn, date, start, end)?;
    if input.sessions.is_empty() {
        return get(conn, date);
    }
    match execute(&input).and_then(|raw| validate_output(&raw)) {
        Ok(content) => {
            save_success(conn, date, &content)?;
            get(conn, date)
        }
        Err(error) => {
            crate::diag_warn!(
                "ailog",
                "digest generation failed for {date} ({})",
                error_kind(&error)
            );
            save_parse_error(conn, date, &error)?;
            Err(error)
        }
    }
}

fn error_kind(error: &str) -> &'static str {
    if error.contains("timed out") {
        "timeout"
    } else if error.contains("start digest codex") {
        "spawn"
    } else if error.contains("exited") {
        "exit"
    } else if error.contains("parse") || error.contains("JSON") {
        "parse"
    } else {
        "db-or-input"
    }
}

fn needs_generation(conn: &Connection, date: &str, force: bool) -> Result<bool, String> {
    if force {
        return Ok(true);
    }
    let existing = conn
        .query_row(
            "SELECT prompt_version,json FROM digest WHERE kind='all' AND date=?1",
            [date],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?.is_some(),
                ))
            },
        )
        .ok();
    Ok(existing.is_none_or(|(version, has_json)| version < PROMPT_VERSION || !has_json))
}

fn build_input(conn: &Connection, date: &str, start: i64, end: i64) -> Result<DigestInput, String> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(x.goal_summary,s.goal_summary,s.ai_title,s.first_prompt,''), COALESCE(x.goal_cluster,s.goal_cluster,''),
                COALESCE(x.outcome,'unclear'), COALESCE(x.findings,'[]'), COALESCE(x.rework_note,'{}'), COALESCE(x.cost_note,'')
         FROM session s JOIN summary x ON x.kind=s.kind AND x.session_id=s.session_id
         WHERE s.started_at>=?1 AND s.started_at<?2 AND COALESCE(s.origin,'unknown')<>?3
         ORDER BY s.started_at ASC, s.session_id ASC",
    ).map_err(|error| format!("prepare digest sessions: {error}"))?;
    let rows = stmt
        .query_map(params![start, end, ORIGIN_AILOG_INTERNAL], |row| {
            let findings: String = row.get(3)?;
            let rework: String = row.get(4)?;
            Ok(InputSession {
                goal: truncate_chars(&row.get::<_, String>(0)?, 240),
                goal_cluster: truncate_chars(&row.get::<_, String>(1)?, 80),
                outcome: normalize_outcome(&row.get::<_, String>(2)?),
                findings: serde_json::from_str(&findings)
                    .unwrap_or(serde_json::Value::Array(Vec::new())),
                rework: serde_json::from_str(&rework).unwrap_or_else(|_| serde_json::json!({})),
                cost_note: truncate_chars(&row.get::<_, String>(5)?, 240),
            })
        })
        .map_err(|error| format!("query digest sessions: {error}"))?;
    let sessions = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read digest sessions: {error}"))?;
    let current = input_metrics(conn, start, end)?;
    let previous = input_metrics(conn, start - 86_400_000, start)?;
    Ok(DigestInput {
        date: date.to_string(),
        sessions,
        metrics: current,
        previous_metrics: previous,
    })
}

fn read_metrics(conn: &Connection, start: i64, end: i64) -> Result<DigestMetrics, String> {
    let current = input_metrics(conn, start, end)?;
    let previous = input_metrics(conn, start - 86_400_000, start)?;
    let outcomes = outcome_counts(conn, start, end)?;
    let cost_pct = if previous.total_cost_usd.abs() < f64::EPSILON {
        if current.total_cost_usd.abs() < f64::EPSILON {
            0.0
        } else {
            100.0
        }
    } else {
        (current.total_cost_usd - previous.total_cost_usd) / previous.total_cost_usd * 100.0
    };
    Ok(DigestMetrics {
        sessions: current.sessions,
        cost_usd: current.total_cost_usd,
        turns: current.total_turns,
        average_rework: current.average_rework,
        outcomes,
        previous_sessions: previous.sessions,
        previous_cost_usd: previous.total_cost_usd,
        previous_turns: previous.total_turns,
        cost_pct,
    })
}

fn input_metrics(conn: &Connection, start: i64, end: i64) -> Result<DigestInputMetrics, String> {
    let (sessions, total_cost_usd, total_turns, average_rework) = conn.query_row(
        "SELECT COUNT(*),COALESCE(SUM(s.cost_usd),0),COALESCE(SUM(s.turn_count),0),COALESCE(AVG(r.score),0)
         FROM session s LEFT JOIN rework r ON r.kind=s.kind AND r.session_id=s.session_id
         WHERE s.started_at>=?1 AND s.started_at<?2 AND COALESCE(s.origin,'unknown')<>?3",
        params![start, end, ORIGIN_AILOG_INTERNAL],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(|error| format!("read digest metrics: {error}"))?;
    Ok(DigestInputMetrics {
        sessions,
        total_cost_usd,
        total_turns,
        average_rework,
        tool_failures: ranked_values(conn, start, end, true)?,
        churn_files: ranked_values(conn, start, end, false)?,
    })
}

fn ranked_values(
    conn: &Connection,
    start: i64,
    end: i64,
    tools: bool,
) -> Result<Vec<RankedValue>, String> {
    let sql = if tools {
        "SELECT te.name,COUNT(*) FROM tool_event te JOIN session s ON s.kind=te.kind AND s.session_id=te.session_id
         WHERE s.started_at>=?1 AND s.started_at<?2 AND COALESCE(s.origin,'unknown')<>?3 AND te.is_error=1
         GROUP BY te.name ORDER BY COUNT(*) DESC,te.name ASC LIMIT 5"
    } else {
        "SELECT ft.path,SUM(ft.edit_count) FROM file_touch ft JOIN session s ON s.kind=ft.kind AND s.session_id=ft.session_id
         WHERE s.started_at>=?1 AND s.started_at<?2 AND COALESCE(s.origin,'unknown')<>?3 AND ft.edit_count>=3
         GROUP BY ft.path ORDER BY SUM(ft.edit_count) DESC,ft.path ASC LIMIT 5"
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|error| format!("prepare digest ranking: {error}"))?;
    let rows = stmt
        .query_map(params![start, end, ORIGIN_AILOG_INTERNAL], |row| {
            Ok(RankedValue {
                name: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|error| format!("query digest ranking: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read digest ranking: {error}"))
}

fn outcome_counts(conn: &Connection, start: i64, end: i64) -> Result<OutcomeCounts, String> {
    let mut counts = OutcomeCounts::default();
    let mut stmt = conn.prepare(
        "SELECT COALESCE(x.outcome,'unclear'),COUNT(*) FROM session s JOIN summary x ON x.kind=s.kind AND x.session_id=s.session_id
         WHERE s.started_at>=?1 AND s.started_at<?2 AND COALESCE(s.origin,'unknown')<>?3 GROUP BY COALESCE(x.outcome,'unclear')",
    ).map_err(|error| format!("prepare digest outcomes: {error}"))?;
    let rows = stmt
        .query_map(params![start, end, ORIGIN_AILOG_INTERNAL], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| format!("query digest outcomes: {error}"))?;
    for row in rows {
        let (outcome, count) = row.map_err(|error| format!("read digest outcome: {error}"))?;
        match normalize_outcome(&outcome).as_str() {
            "done" => counts.done += count,
            "partial" => counts.partial += count,
            "abandoned" => counts.abandoned += count,
            _ => counts.unclear += count,
        }
    }
    Ok(counts)
}

fn execute(input: &DigestInput) -> Result<String, String> {
    let payload =
        serde_json::to_string(input).map_err(|error| format!("encode digest input: {error}"))?;
    let prompt = format!("{MARKER}\n{PROMPT}\n{payload}");
    let mut args = vec![
        "exec".to_string(),
        "--model".to_string(),
        MODEL.to_string(),
        "-c".to_string(),
        "features.fast_mode=false".to_string(),
        "-".to_string(),
    ];
    let program = crate::commands::terminal::prepare_spawn_command(codex_program(), &mut args);
    let mut environment: HashMap<String, String> = env::vars().collect();
    crate::commands::terminal::sanitize_launch_env(&mut environment);
    environment.retain(|key, _| !key.to_ascii_uppercase().starts_with("MYCMUX_"));
    let cwd = env::current_dir().map_err(|err| format!("digest working directory: {err}"))?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::util::process::CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("start digest codex: {error}"))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "digest codex stdin unavailable".to_string())?;
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|error| format!("write digest prompt: {error}"))?;
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let started = Instant::now();
    loop {
        if started.elapsed() >= TIMEOUT {
            stop_child(&mut child);
            return Err("digest codex timed out after 120 seconds".to_string());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("wait digest codex: {error}"))?
        {
            let mut stdout_bytes = Vec::new();
            let mut stderr_bytes = Vec::new();
            if let Some(mut handle) = stdout {
                use std::io::Read;
                let _ = handle.read_to_end(&mut stdout_bytes);
            }
            if let Some(mut handle) = stderr {
                use std::io::Read;
                let _ = handle.read_to_end(&mut stderr_bytes);
            }
            let stdout_text = String::from_utf8_lossy(&stdout_bytes).into_owned();
            let stderr_text = String::from_utf8_lossy(&stderr_bytes).into_owned();
            if !status.success() {
                return Err(format!(
                    "digest codex exited {status}: {}",
                    stderr_text.trim()
                ));
            }
            return Ok(stdout_text);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn stop_child(child: &mut Child) {
    let mut taskkill = Command::new("taskkill");
    taskkill.args(["/PID", &child.id().to_string(), "/T", "/F"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        taskkill.creation_flags(crate::util::process::CREATE_NO_WINDOW);
    }
    let _ = taskkill.status();
    let _ = child.kill();
    let _ = child.wait();
}

fn codex_program() -> &'static str {
    if cfg!(windows) {
        "codex.cmd"
    } else {
        "codex"
    }
}

fn validate_output(raw: &str) -> Result<DigestContent, String> {
    let json =
        extract_json(raw).ok_or_else(|| "digest output contained no JSON object".to_string())?;
    let parsed: RawDigestContent =
        serde_json::from_str(json).map_err(|error| format!("parse digest JSON: {error}"))?;
    Ok(DigestContent {
        headline: truncate_chars(parsed.headline.trim(), 80),
        wins: parsed
            .wins
            .into_iter()
            .filter_map(|value| {
                let value = truncate_chars(value.trim(), 240);
                (!value.is_empty()).then_some(value)
            })
            .take(3)
            .collect(),
        biggest_rework: BiggestRework {
            exists: parsed.biggest_rework.exists,
            text: if parsed.biggest_rework.exists {
                truncate_chars(parsed.biggest_rework.text.trim(), 360)
            } else {
                String::new()
            },
        },
        value_note: truncate_chars(parsed.value_note.trim(), 240),
        suggestion: truncate_chars(parsed.suggestion.trim(), 240),
        confidence: normalize_confidence(&parsed.confidence),
    })
}

fn extract_json(raw: &str) -> Option<&str> {
    let trimmed = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    (end >= start).then(|| &trimmed[start..=end])
}

fn normalize_confidence(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if ["high", "medium", "low"].contains(&value.as_str()) {
        value
    } else {
        "low".to_string()
    }
}

fn normalize_outcome(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if ["done", "partial", "abandoned", "unclear"].contains(&value.as_str()) {
        value
    } else {
        "unclear".to_string()
    }
}

fn save_success(conn: &mut Connection, date: &str, content: &DigestContent) -> Result<(), String> {
    let json =
        serde_json::to_string(content).map_err(|error| format!("encode digest result: {error}"))?;
    conn.execute(
        "INSERT INTO digest(kind,date,created_at,prompt_version,model_used,json,parse_error) VALUES('all',?1,?2,?3,?4,?5,NULL)\
         ON CONFLICT(kind,date) DO UPDATE SET created_at=excluded.created_at,prompt_version=excluded.prompt_version,model_used=excluded.model_used,json=excluded.json,parse_error=NULL",
        params![date, Utc::now().timestamp_millis(), PROMPT_VERSION, MODEL, json],
    ).map_err(|error| format!("save digest: {error}"))?;
    Ok(())
}

fn save_parse_error(conn: &mut Connection, date: &str, error: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO digest(kind,date,created_at,prompt_version,parse_error) VALUES('all',?1,?2,?3,?4)\
         ON CONFLICT(kind,date) DO UPDATE SET created_at=excluded.created_at,prompt_version=excluded.prompt_version,json=NULL,parse_error=excluded.parse_error",
        params![date, Utc::now().timestamp_millis(), PROMPT_VERSION, truncate_chars(error, 500)],
    ).map_err(|error| format!("save digest parse error: {error}"))?;
    Ok(())
}

/// A digest date names a local (JST) day, matching the day buckets the rest of
/// ailog reports. Cutting this at UTC would put the same session on a different
/// date than the usage chart shows.
fn day_bounds(date: &str) -> Result<(i64, i64), String> {
    let day =
        NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| format!("invalid date: {date}"))?;
    let start = Utc
        .from_utc_datetime(
            &day.and_hms_opt(0, 0, 0)
                .ok_or_else(|| format!("invalid date: {date}"))?,
        )
        .timestamp_millis()
        - crate::ailog::query::DAY_BOUNDARY_OFFSET_MIN * 60_000;
    Ok((start, start + 86_400_000))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ailog::schema;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        schema::init(&conn).expect("schema");
        conn.execute("INSERT INTO session(kind,session_id,origin,started_at,cost_usd,turn_count,ai_title) VALUES('codex','today','unknown',?1,4.5,8,'today goal'),('codex','internal','ailog-internal',?1,9,9,'hidden'),('codex','previous','unknown',?2,2,3,'previous goal')", params![1_786_492_800_000i64, 1_786_406_400_000i64]).expect("sessions");
        conn.execute("INSERT INTO summary(kind,session_id,created_at,goal_summary,outcome,findings,rework_note,cost_note,prompt_version) VALUES('codex','today',1,'today goal','done','[]','{}','value',2),('codex','internal',1,'hidden','done','[]','{}','hidden',2),('codex','previous',1,'previous goal','partial','[]','{}','previous',2)", []).expect("summaries");
        conn.execute("INSERT INTO rework(kind,session_id,score) VALUES('codex','today',0.25),('codex','internal',0.9),('codex','previous',0.5)", []).expect("rework");
        conn
    }

    #[test]
    fn input_excludes_internal_and_compares_previous_day() {
        let conn = seeded();
        let input =
            build_input(&conn, "2026-08-12", 1_786_492_800_000, 1_786_579_200_000).expect("input");
        assert_eq!(input.sessions.len(), 1);
        assert_eq!(input.metrics.sessions, 1);
        assert_eq!(input.previous_metrics.sessions, 1);
        assert_eq!(input.metrics.total_cost_usd, 4.5);
    }

    #[test]
    fn validation_rounds_invalid_confidence() {
        let content = validate_output(r#"{"headline":"h","wins":[],"biggest_rework":{"exists":false,"text":"x"},"value_note":"v","suggestion":"s","confidence":"unknown"}"#).expect("valid");
        assert_eq!(content.confidence, "low");
        assert_eq!(content.biggest_rework.text, "");
    }

    #[test]
    fn prompt_version_controls_regeneration() {
        let mut conn = seeded();
        assert!(needs_generation(&conn, "2026-08-12", false).expect("missing"));
        save_success(
            &mut conn,
            "2026-08-12",
            &DigestContent {
                headline: "h".into(),
                wins: vec![],
                biggest_rework: BiggestRework {
                    exists: false,
                    text: String::new(),
                },
                value_note: "v".into(),
                suggestion: "s".into(),
                confidence: "high".into(),
            },
        )
        .expect("save");
        assert!(!needs_generation(&conn, "2026-08-12", false).expect("current"));
        conn.execute(
            "UPDATE digest SET prompt_version=0 WHERE kind='all' AND date='2026-08-12'",
            [],
        )
        .expect("old version");
        assert!(needs_generation(&conn, "2026-08-12", false).expect("old version regenerates"));
        save_success(
            &mut conn,
            "2026-08-12",
            &DigestContent {
                headline: "h".into(),
                wins: vec![],
                biggest_rework: BiggestRework {
                    exists: false,
                    text: String::new(),
                },
                value_note: "v".into(),
                suggestion: "s".into(),
                confidence: "high".into(),
            },
        )
        .expect("restore current");
        assert!(needs_generation(&conn, "2026-08-12", true).expect("force"));
        save_parse_error(&mut conn, "2026-08-12", "bad output").expect("parse error");
        assert!(needs_generation(&conn, "2026-08-12", false).expect("failed digest retries"));
    }

    #[test]
    fn saved_digest_is_returned_with_metrics() {
        let mut conn = seeded();
        let content = DigestContent {
            headline: "h".into(),
            wins: vec!["w".into()],
            biggest_rework: BiggestRework {
                exists: false,
                text: String::new(),
            },
            value_note: "v".into(),
            suggestion: "s".into(),
            confidence: "high".into(),
        };
        save_success(&mut conn, "2026-08-12", &content).expect("save");
        let report = get(&conn, "2026-08-12").expect("get");
        assert_eq!(report.digest.expect("digest").content, content);
        assert_eq!(report.metrics.outcomes.done, 1);
    }

    #[test]
    #[ignore = "calls the local Codex CLI once; run explicitly for the release smoke"]
    fn real_codex_smoke_saves_digest_json() {
        let mut conn = seeded();
        let report =
            generate(&mut conn, "2026-08-12", true).expect("generate digest through Codex");
        assert!(
            report.digest.is_some(),
            "a successful Codex response must be saved in digest"
        );
        let saved: String = conn
            .query_row(
                "SELECT json FROM digest WHERE kind='all' AND date='2026-08-12'",
                [],
                |row| row.get(0),
            )
            .expect("saved digest JSON");
        assert!(serde_json::from_str::<DigestContent>(&saved).is_ok());
    }
}

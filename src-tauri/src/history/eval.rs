//! Manual, read-only evaluation of the existing history pipeline on local
//! Claude and Codex transcripts. This module is test-only on purpose: it
//! creates no product feature and the normal test suite never needs real logs.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

use super::model::{event_value, IngestInput, JournalEvent};
use super::{search, store, SearchFilters};
use crate::livebrief::{sha256_hex, AgentAdapter, ByteRange, SemanticEventEnvelope};

const DEFAULT_SESSION_LIMIT: usize = 20;
const SESSION_CANDIDATE_MULTIPLIER: usize = 10;
const MAX_CODEX_DISCOVERY_FILES: usize = 4_000;
const MAX_QUERIES_PER_KIND: usize = 50;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const QUERY_SAMPLE_SEED: &str = "history-eval-query-sample-v1";
const MIN_SOURCE_AGE: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueryKind {
    Path,
    Error,
    Command,
    Natural,
}

impl QueryKind {
    const ALL: [Self; 4] = [Self::Path, Self::Error, Self::Command, Self::Natural];

    fn index(self) -> usize {
        match self {
            Self::Path => 0,
            Self::Error => 1,
            Self::Command => 2,
            Self::Natural => 3,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Path => "path",
            Self::Error => "error",
            Self::Command => "command",
            Self::Natural => "natural",
        }
    }
}

#[derive(Clone, Debug)]
struct FileStamp {
    len: u64,
    modified: SystemTime,
}

#[derive(Clone, Debug)]
struct SourceSession {
    kind: &'static str,
    external_session_id: String,
    path: PathBuf,
    stamp: FileStamp,
}

#[derive(Clone, Debug)]
struct QueryDraft {
    kind: QueryKind,
    text: String,
    logical_session_id: String,
    event_id: String,
    source_key: String,
    invocation: Option<InvocationKey>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct InvocationKey {
    logical_session_id: String,
    call_id: String,
}

#[derive(Clone, Debug)]
struct InvocationEvent {
    kind: String,
    timestamp: i64,
    call_id: String,
}

#[derive(Clone, Debug, Default)]
struct CategoryMetrics {
    source_candidates: usize,
    eligible_queries: usize,
    excluded_without_ground_truth: usize,
    sampled_out: usize,
    queries: usize,
    recall_at_1: usize,
    recall_at_5: usize,
    recall_at_20: usize,
    reciprocal_rank_sum: f64,
    latencies: Vec<Duration>,
}

#[derive(Clone, Debug, Default)]
struct SourceIntegrity {
    checked: usize,
    size_changed: usize,
    mtime_changed: usize,
}

#[derive(Clone, Debug, Default)]
struct SignalMetrics {
    event_kinds: BTreeMap<String, usize>,
    tool_starts: BTreeMap<String, usize>,
    failed_tool_ends: BTreeMap<String, usize>,
    write_tool_starts: BTreeMap<String, usize>,
    successful_write_tool_ends: BTreeMap<String, usize>,
    failed_write_tool_ends: BTreeMap<String, usize>,
    explicit_test_results: usize,
    failed_outputs_with_clear_error_line: usize,
}

impl SignalMetrics {
    fn merge(&mut self, other: Self) {
        merge_counts(&mut self.event_kinds, other.event_kinds);
        merge_counts(&mut self.tool_starts, other.tool_starts);
        merge_counts(&mut self.failed_tool_ends, other.failed_tool_ends);
        merge_counts(&mut self.write_tool_starts, other.write_tool_starts);
        merge_counts(
            &mut self.successful_write_tool_ends,
            other.successful_write_tool_ends,
        );
        merge_counts(
            &mut self.failed_write_tool_ends,
            other.failed_write_tool_ends,
        );
        self.explicit_test_results += other.explicit_test_results;
        self.failed_outputs_with_clear_error_line += other.failed_outputs_with_clear_error_line;
    }
}

#[derive(Clone, Debug)]
struct RankOneMissExample {
    kind: QueryKind,
    query_excerpt: String,
    query_hash: String,
    query_chars: usize,
    query_terms: usize,
    expected_event_hash: String,
    expected_type: String,
    expected_call_hash: Option<String>,
    expected_rank: Option<usize>,
    top_event_hash: String,
    top_type: String,
    top_call_hash: Option<String>,
    same_invocation: bool,
    equal_score: bool,
    timestamp_delta_ms: i64,
}

#[derive(Clone, Debug)]
struct EvalReport {
    session_limit: usize,
    sessions_discovered: usize,
    sessions_inspected: usize,
    sessions_ingested: usize,
    sessions_excluded: usize,
    candidate_files_skipped: usize,
    corpus_signature: String,
    events_ingested: usize,
    ingest_elapsed: Duration,
    db_bytes: u64,
    categories: [CategoryMetrics; 4],
    signals: SignalMetrics,
    rank_one_examples: Vec<RankOneMissExample>,
    integrity: SourceIntegrity,
}

impl EvalReport {
    fn render(&self) -> String {
        let mut out = String::new();
        out.push_str("history real-log evaluation (read-only)\n");
        out.push_str(&format!(
            "session_limit={} discovered={} inspected={} ingested={} session_excluded={} candidate_files_skipped={} events={} corpus_sha256_12={}\n",
            self.session_limit,
            self.sessions_discovered,
            self.sessions_inspected,
            self.sessions_ingested,
            self.sessions_excluded,
            self.candidate_files_skipped,
            self.events_ingested,
            self.corpus_signature,
        ));
        out.push_str(&format!(
            "ingest_decode_ms={} db_bytes={} query_sample_seed={} cap_per_kind={} source_min_age_secs={}\n",
            self.ingest_elapsed.as_millis(),
            self.db_bytes,
            QUERY_SAMPLE_SEED,
            MAX_QUERIES_PER_KIND,
            MIN_SOURCE_AGE.as_secs(),
        ));
        out.push_str(&format!(
            "source_integrity checked={} size_changed={} mtime_changed={}\n",
            self.integrity.checked, self.integrity.size_changed, self.integrity.mtime_changed,
        ));
        out.push_str("kind     candidates eligible excluded sampled queries recall@1 recall@5 recall@20 mrr median_us\n");
        for kind in QueryKind::ALL {
            let metrics = &self.categories[kind.index()];
            out.push_str(&format!(
                "{:<8} {:>10} {:>8} {:>8} {:>7} {:>7} {:>8} {:>8} {:>9} {:>8} {:>9}\n",
                kind.label(),
                metrics.source_candidates,
                metrics.eligible_queries,
                metrics.excluded_without_ground_truth,
                metrics.sampled_out,
                metrics.queries,
                rate(metrics.recall_at_1, metrics.queries),
                rate(metrics.recall_at_5, metrics.queries),
                rate(metrics.recall_at_20, metrics.queries),
                mrr(metrics),
                median_micros(&metrics.latencies),
            ));
        }
        out.push_str("event_kind_counts\n");
        for kind in [
            "userMessage",
            "agentMessage",
            "toolStart",
            "toolEnd",
            "question",
            "questionResolved",
            "testResult",
            "fileChange",
            "error",
        ] {
            out.push_str(&format!(
                "  {:<18} {}\n",
                kind,
                self.signals
                    .event_kinds
                    .get(kind)
                    .copied()
                    .unwrap_or_default()
            ));
        }
        render_count_table(&mut out, "tool_start_by_tool", &self.signals.tool_starts);
        render_count_table(
            &mut out,
            "failed_tool_end_by_tool",
            &self.signals.failed_tool_ends,
        );
        render_count_table(
            &mut out,
            "write_tool_start_by_tool",
            &self.signals.write_tool_starts,
        );
        render_count_table(
            &mut out,
            "successful_write_tool_end_by_tool",
            &self.signals.successful_write_tool_ends,
        );
        render_count_table(
            &mut out,
            "failed_write_tool_end_by_tool",
            &self.signals.failed_write_tool_ends,
        );
        out.push_str(&format!(
            "intent_candidates explicit_test_results={} failed_outputs_with_clear_error_line={}\n",
            self.signals.explicit_test_results, self.signals.failed_outputs_with_clear_error_line,
        ));
        if !self.rank_one_examples.is_empty() {
            out.push_str("rank_one_measurement_examples (hashes avoid transcript disclosure)\n");
            for example in &self.rank_one_examples {
                out.push_str(&format!(
                    "  kind={} query={:?} query_sha256_12={} chars={} terms={} expected_event_sha256_12={} expected_type={} expected_call_sha256_12={} expected_rank={} top_event_sha256_12={} top_type={} top_call_sha256_12={} same_invocation={} equal_bm25={} top_minus_expected_ms={}\n",
                    example.kind.label(),
                    example.query_excerpt,
                    example.query_hash,
                    example.query_chars,
                    example.query_terms,
                    example.expected_event_hash,
                    example.expected_type,
                    example.expected_call_hash.as_deref().unwrap_or("N/A"),
                    example.expected_rank.map(|rank| rank.to_string()).unwrap_or_else(|| ">20".to_string()),
                    example.top_event_hash,
                    example.top_type,
                    example.top_call_hash.as_deref().unwrap_or("N/A"),
                    example.same_invocation,
                    example.equal_score,
                    example.timestamp_delta_ms,
                ));
            }
        }
        out.push_str("note: natural queries require 3-10 existing FTS terms. Whitespace-free CJK text may be excluded rather than receiving a new tokenizer or character-ngram fallback.\n");
        out
    }
}

fn evaluate_local_logs(session_limit: usize) -> Result<EvalReport, String> {
    if session_limit == 0 {
        return Err("HISTORY_EVAL_SESSION_LIMIT must be greater than zero".to_string());
    }
    let candidate_limit = session_limit.saturating_mul(SESSION_CANDIDATE_MULTIPLIER);
    let discovery = discover_sessions(candidate_limit)?;
    if discovery.selected.is_empty() {
        return Err("no readable local Claude/Codex sessions selected for evaluation".to_string());
    }

    let scratch = tempfile::tempdir().map_err(|error| format!("create temp dir: {error}"))?;
    let db_path = scratch.path().join("history-eval.db");
    let started = Instant::now();
    let mut categories: [CategoryMetrics; 4] = std::array::from_fn(|_| CategoryMetrics::default());
    let mut drafts = Vec::new();
    let mut sessions_ingested = 0;
    let mut sessions_excluded = 0;
    let mut events_ingested = 0;
    let mut inspected_sources = Vec::new();
    let mut signals = SignalMetrics::default();
    let mut invocation_events = HashMap::<(String, String), InvocationEvent>::new();

    for source in &discovery.selected {
        if sessions_ingested == session_limit {
            break;
        }
        inspected_sources.push(source.clone());
        let mut session_signals = SignalMetrics::default();
        match decode_session(source, &mut session_signals) {
            Ok(events) if events.is_empty() => sessions_excluded += 1,
            Ok(events) => {
                let logical_session_id = evaluation_logical_session_id(source);
                let input = IngestInput {
                    logical_session_id: &logical_session_id,
                    agent_session_id: &source.external_session_id,
                    agent_kind: source.kind,
                    pty_session_id: "history-eval-read-only",
                    repo_id: None,
                    cwd: None,
                    branch: None,
                    source_log: &source.path,
                    events: &events,
                };
                store::ingest_at(&db_path, &input)
                    .map_err(|error| format!("ingest {}: {error}", source.path.display()))?;
                events_ingested += events.len();
                sessions_ingested += 1;
                signals.merge(session_signals);
                collect_invocation_events(&events, &logical_session_id, &mut invocation_events)?;
                collect_query_drafts(
                    &events,
                    &logical_session_id,
                    &invocation_events,
                    &mut categories,
                    &mut drafts,
                )?;
            }
            Err(_) => sessions_excluded += 1,
        }
    }
    if sessions_ingested < session_limit {
        return Err(format!(
            "only {sessions_ingested} decodable sessions found after inspecting {} candidates",
            inspected_sources.len()
        ));
    }
    let ingest_elapsed = started.elapsed();

    let mut rank_one_examples = Vec::new();
    for kind in QueryKind::ALL {
        let category = &mut categories[kind.index()];
        let mut candidates = drafts
            .iter()
            .filter(|draft| draft.kind == kind)
            .cloned()
            .collect::<Vec<_>>();
        candidates.sort_by_key(sample_key);
        if candidates.len() > MAX_QUERIES_PER_KIND {
            category.sampled_out = candidates.len() - MAX_QUERIES_PER_KIND;
            candidates.truncate(MAX_QUERIES_PER_KIND);
        }
        for query in candidates {
            let started = Instant::now();
            let hits = store::search_at(&db_path, &query.text, &SearchFilters::default(), 20)
                .map_err(|error| format!("search {}: {error}", query.kind.label()))?;
            category.latencies.push(started.elapsed());
            category.queries += 1;
            let exact_rank = hits.iter().position(|hit| {
                hit.event_id == query.event_id && hit.logical_session_id == query.logical_session_id
            });
            if let Some(rank) = hits.iter().position(|hit| {
                hit.event_id == query.event_id && hit.logical_session_id == query.logical_session_id
                    || query.invocation.as_ref().is_some_and(|expected| {
                        invocation_events
                            .get(&(hit.logical_session_id.clone(), hit.event_id.clone()))
                            .is_some_and(|actual| {
                                matches!(
                                    actual.kind.as_str(),
                                    "toolStart" | "toolEnd" | "fileChange"
                                ) && actual_call_id(
                                    &hit.logical_session_id,
                                    &hit.event_id,
                                    &invocation_events,
                                )
                                .is_some_and(|call_id| call_id == expected.call_id)
                            })
                    })
            }) {
                let position = rank + 1;
                category.reciprocal_rank_sum += 1.0 / position as f64;
                if position <= 1 {
                    category.recall_at_1 += 1;
                }
                if position <= 5 {
                    category.recall_at_5 += 1;
                }
                if position <= 20 {
                    category.recall_at_20 += 1;
                }
            }
            let should_capture_example = matches!(query.kind, QueryKind::Path | QueryKind::Command)
                && rank_one_examples
                    .iter()
                    .filter(|example: &&RankOneMissExample| example.kind == query.kind)
                    .count()
                    < 3
                && exact_rank != Some(0);
            if should_capture_example {
                let Some(top) = hits.first() else {
                    continue;
                };
                let expected = invocation_events
                    .get(&(query.logical_session_id.clone(), query.event_id.clone()));
                let top_invocation =
                    invocation_events.get(&(top.logical_session_id.clone(), top.event_id.clone()));
                let same_invocation = query.invocation.as_ref().is_some_and(|expected| {
                    top_invocation.is_some_and(|actual| {
                        matches!(actual.kind.as_str(), "toolStart" | "toolEnd" | "fileChange")
                            && actual_call_id(
                                &top.logical_session_id,
                                &top.event_id,
                                &invocation_events,
                            )
                            .is_some_and(|call_id| call_id == expected.call_id)
                    })
                });
                rank_one_examples.push(RankOneMissExample {
                    kind: query.kind,
                    query_excerpt: safe_query_excerpt(&query.text),
                    query_hash: short_hash(&query.text),
                    query_chars: query.text.chars().count(),
                    query_terms: fts_term_count(&query.text),
                    expected_event_hash: short_hash(&query.event_id),
                    expected_type: expected
                        .map(|event| event.kind.clone())
                        .unwrap_or_else(|| "unknown".to_string()),
                    expected_call_hash: query
                        .invocation
                        .as_ref()
                        .map(|invocation| short_hash(&invocation.call_id)),
                    expected_rank: exact_rank.map(|rank| rank + 1),
                    top_event_hash: short_hash(&top.event_id),
                    top_type: top.event_type.clone(),
                    top_call_hash: actual_call_id(
                        &top.logical_session_id,
                        &top.event_id,
                        &invocation_events,
                    )
                    .map(|call_id| short_hash(call_id)),
                    same_invocation,
                    equal_score: expected.is_some_and(|_| {
                        hits.get(exact_rank.unwrap_or(usize::MAX))
                            .is_some_and(|truth| truth.bm25_score == top.bm25_score)
                    }),
                    timestamp_delta_ms: top.timestamp
                        - expected
                            .map(|event| event.timestamp)
                            .unwrap_or(top.timestamp),
                });
            }
        }
    }

    let db_bytes = sqlite_artifact_bytes(&db_path)?;
    let integrity = verify_source_integrity(&inspected_sources);
    let report = EvalReport {
        session_limit,
        sessions_discovered: discovery.discovered,
        sessions_inspected: inspected_sources.len(),
        sessions_ingested,
        sessions_excluded,
        candidate_files_skipped: discovery.candidate_files_skipped,
        corpus_signature: source_signature(&inspected_sources),
        events_ingested,
        ingest_elapsed,
        db_bytes,
        categories,
        signals,
        rank_one_examples,
        integrity,
    };
    scratch
        .close()
        .map_err(|error| format!("remove temporary evaluation DB: {error}"))?;
    Ok(report)
}

#[derive(Default)]
struct Discovery {
    discovered: usize,
    candidate_files_skipped: usize,
    selected: Vec<SourceSession>,
}

fn discover_sessions(session_limit: usize) -> Result<Discovery, String> {
    let current_dir =
        std::env::current_dir().map_err(|error| format!("read current directory: {error}"))?;
    let home_dir = std::env::var_os("HISTORY_EVAL_HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or_else(|| "home directory is not available".to_string())?;
    discover_sessions_from(session_limit, &current_dir, &home_dir)
}

fn discover_sessions_from(
    session_limit: usize,
    current_dir: &Path,
    home_dir: &Path,
) -> Result<Discovery, String> {
    let current_cwd = normalize_path(&current_dir.to_string_lossy());
    let claude = discover_claude_sessions(current_dir, home_dir)?;
    let codex = discover_codex_sessions(&current_cwd, home_dir)?;
    let discovered = claude.len() + codex.sessions.len();
    let mut selected = Vec::new();
    let claude_target = session_limit / 2;
    let codex_target = session_limit - claude_target;
    selected.extend(claude.into_iter().take(claude_target));
    selected.extend(codex.sessions.into_iter().take(codex_target));
    if selected.len() < session_limit {
        let needed = session_limit - selected.len();
        let extra = discover_claude_sessions(current_dir, home_dir)?
            .into_iter()
            .skip(claude_target)
            .chain(
                discover_codex_sessions(&current_cwd, home_dir)?
                    .sessions
                    .into_iter()
                    .skip(codex_target),
            )
            .take(needed)
            .collect::<Vec<_>>();
        selected.extend(extra);
    }
    selected = interleave_kinds(selected);
    Ok(Discovery {
        discovered,
        candidate_files_skipped: codex.excluded,
        selected,
    })
}

fn interleave_kinds(sessions: Vec<SourceSession>) -> Vec<SourceSession> {
    let mut claude = sessions
        .iter()
        .filter(|session| session.kind == "claude")
        .cloned()
        .collect::<Vec<_>>()
        .into_iter();
    let mut codex = sessions
        .into_iter()
        .filter(|session| session.kind == "codex")
        .collect::<Vec<_>>()
        .into_iter();
    let mut interleaved = Vec::new();
    loop {
        let mut added = false;
        if let Some(session) = claude.next() {
            interleaved.push(session);
            added = true;
        }
        if let Some(session) = codex.next() {
            interleaved.push(session);
            added = true;
        }
        if !added {
            return interleaved;
        }
    }
}

fn discover_claude_sessions(
    current_dir: &Path,
    home_dir: &Path,
) -> Result<Vec<SourceSession>, String> {
    let root = claude_transcript_root(current_dir, home_dir);
    let mut paths = Vec::new();
    collect_jsonl_paths(&root, &mut paths)?;
    let mut sessions = paths
        .into_iter()
        .filter_map(|path| source_session("claude", path).ok())
        .filter(source_is_stable)
        .collect::<Vec<_>>();
    sessions.sort_by(newest_first);
    Ok(sessions)
}

fn claude_transcript_root(current_dir: &Path, home_dir: &Path) -> PathBuf {
    home_dir
        .join(".claude")
        .join("projects")
        .join(claude_project_key(current_dir))
}

struct CodexDiscovery {
    sessions: Vec<SourceSession>,
    excluded: usize,
}

fn discover_codex_sessions(
    current_cwd: &str,
    home_dir: &Path,
) -> Result<CodexDiscovery, String> {
    let root = codex_transcript_root(home_dir);
    let mut paths = Vec::new();
    collect_jsonl_paths(&root, &mut paths)?;
    paths.sort_by(|left, right| newest_path_first(left, right));
    paths.truncate(MAX_CODEX_DISCOVERY_FILES);

    let mut grouped = HashMap::<String, SourceSession>::new();
    let mut excluded = 0;
    for path in paths {
        let Some(session_id) = codex_session_id_for_current_cwd(&path, current_cwd) else {
            excluded += 1;
            continue;
        };
        let Ok(mut source) = source_session("codex", path) else {
            excluded += 1;
            continue;
        };
        if !source_is_stable(&source) {
            excluded += 1;
            continue;
        }
        source.external_session_id = session_id.clone();
        match grouped.get(&session_id) {
            Some(current) if !is_better_representative(&source, current) => {}
            _ => {
                grouped.insert(session_id, source);
            }
        }
    }
    let mut sessions = grouped.into_values().collect::<Vec<_>>();
    sessions.sort_by(newest_first);
    Ok(CodexDiscovery { sessions, excluded })
}

fn codex_transcript_root(home_dir: &Path) -> PathBuf {
    home_dir.join(".codex").join("sessions")
}

fn claude_project_key(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn collect_jsonl_paths(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read transcript root {}: {error}", root.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("read transcript entry: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read transcript file type: {error}"))?;
        if file_type.is_dir() {
            collect_jsonl_paths(&path, output)?;
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
        {
            output.push(path);
        }
    }
    Ok(())
}

fn source_session(kind: &'static str, path: PathBuf) -> Result<SourceSession, String> {
    let metadata =
        fs::metadata(&path).map_err(|error| format!("stat {}: {error}", path.display()))?;
    let external_session_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown-session")
        .to_string();
    Ok(SourceSession {
        kind,
        external_session_id,
        path,
        stamp: FileStamp {
            len: metadata.len(),
            modified: metadata
                .modified()
                .map_err(|error| format!("mtime: {error}"))?,
        },
    })
}

fn source_is_stable(source: &SourceSession) -> bool {
    SystemTime::now()
        .duration_since(source.stamp.modified)
        .map(|age| age >= MIN_SOURCE_AGE)
        .unwrap_or(false)
}

fn source_signature(sources: &[SourceSession]) -> String {
    let mut source_keys = sources
        .iter()
        .map(|source| {
            format!(
                "{}\0{}\0{}",
                source.kind,
                source.external_session_id,
                source.path.display()
            )
        })
        .collect::<Vec<_>>();
    source_keys.sort();
    short_hash(&source_keys.join("\n"))
}

fn codex_session_id_for_current_cwd(path: &Path, current_cwd: &str) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    for _ in 0..8 {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let value = match serde_json::from_str::<Value>(line.trim_end()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let payload = value.get("payload").unwrap_or(&value);
        let Some(session_id) = payload.get("session_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(cwd) = payload.get("cwd").and_then(Value::as_str) else {
            continue;
        };
        if normalize_path(cwd) == current_cwd {
            return Some(session_id.to_string());
        }
        return None;
    }
    None
}

fn newest_first(left: &SourceSession, right: &SourceSession) -> std::cmp::Ordering {
    right
        .stamp
        .modified
        .cmp(&left.stamp.modified)
        .then_with(|| right.stamp.len.cmp(&left.stamp.len))
        .then_with(|| left.path.cmp(&right.path))
}

fn newest_path_first(left: &PathBuf, right: &PathBuf) -> std::cmp::Ordering {
    let left_modified = fs::metadata(left)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let right_modified = fs::metadata(right)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    right_modified
        .cmp(&left_modified)
        .then_with(|| left.cmp(right))
}

fn is_better_representative(candidate: &SourceSession, current: &SourceSession) -> bool {
    candidate.stamp.len > current.stamp.len
        || (candidate.stamp.len == current.stamp.len
            && candidate.stamp.modified > current.stamp.modified)
}

fn evaluation_logical_session_id(source: &SourceSession) -> String {
    format!(
        "history-eval:{}:{}",
        source.kind,
        sha256_hex(source.path.to_string_lossy().as_bytes())
    )
}

fn decode_session(
    source: &SourceSession,
    signals: &mut SignalMetrics,
) -> Result<Vec<JournalEvent>, String> {
    let bytes = fs::read(&source.path)
        .map_err(|error| format!("read {}: {error}", source.path.display()))?;
    let lines = complete_lines_like_livebrief(&bytes)?;
    let mut adapter = AgentAdapter::new(source.kind)?;
    let mut events = Vec::new();
    let mut source_revision = 0_u64;
    let mut offset = 0_u64;
    for raw in lines {
        let start = offset;
        offset = offset.saturating_add(raw.len() as u64 + 1);
        source_revision = source_revision.saturating_add(1);
        let decoded =
            adapter.decode_record(raw, ByteRange { start, end: offset }, source_revision)?;
        observe_raw_tool_outputs(source.kind, raw, &decoded, signals)?;
        for envelope in decoded {
            events.push(JournalEvent::from_raw_line(envelope, raw));
        }
    }
    observe_signal_events(&events, signals)?;
    Ok(events)
}

fn complete_lines_like_livebrief(bytes: &[u8]) -> Result<Vec<&str>, String> {
    let mut lines = Vec::new();
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if !line.ends_with(b"\n") {
            break;
        }
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.len() > MAX_LINE_BYTES {
            return Err("live JSONL line exceeds limit".to_string());
        }
        if line.is_empty() {
            continue;
        }
        lines.push(std::str::from_utf8(line).map_err(|_| "live JSONL is not valid UTF-8")?);
    }
    Ok(lines)
}

#[derive(Clone, Debug)]
struct RawToolOutput {
    call_id: String,
    output: String,
}

fn observe_signal_events(
    events: &[JournalEvent],
    signals: &mut SignalMetrics,
) -> Result<(), String> {
    for event in events {
        let value = event_value(&event.envelope).map_err(|error| error.to_string())?;
        let Some(kind) = value.get("kind").and_then(Value::as_object) else {
            continue;
        };
        let event_type = kind
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        *signals
            .event_kinds
            .entry(event_type.to_string())
            .or_default() += 1;
        let tool = kind.get("tool").and_then(Value::as_str).unwrap_or_default();
        match event_type {
            "toolStart" => {
                *signals.tool_starts.entry(tool.to_string()).or_default() += 1;
                if is_write_tool_candidate(tool) {
                    *signals
                        .write_tool_starts
                        .entry(tool.to_string())
                        .or_default() += 1;
                }
            }
            "toolEnd" => {
                let ok = kind.get("ok").and_then(Value::as_bool).unwrap_or(false);
                if !ok {
                    *signals
                        .failed_tool_ends
                        .entry(tool.to_string())
                        .or_default() += 1;
                }
                if is_write_tool_candidate(tool) {
                    let target = if ok {
                        &mut signals.successful_write_tool_ends
                    } else {
                        &mut signals.failed_write_tool_ends
                    };
                    *target.entry(tool.to_string()).or_default() += 1;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn observe_raw_tool_outputs(
    source_kind: &str,
    raw: &str,
    decoded: &[SemanticEventEnvelope],
    signals: &mut SignalMetrics,
) -> Result<(), String> {
    let outputs = raw_tool_outputs(source_kind, raw)?;
    if outputs.is_empty() {
        return Ok(());
    }
    let ends = decoded
        .iter()
        .filter_map(tool_end_fields)
        .collect::<Vec<_>>();
    for (call_id, tool, ok) in ends {
        let Some(output) = outputs.iter().find(|output| output.call_id == call_id) else {
            continue;
        };
        if is_test_command_tool(&tool) {
            signals.explicit_test_results += explicit_test_result_count(&output.output);
        }
        if !ok && clear_error_line(&output.output).is_some() {
            signals.failed_outputs_with_clear_error_line += 1;
        }
    }
    Ok(())
}

fn tool_end_fields(envelope: &SemanticEventEnvelope) -> Option<(String, String, bool)> {
    let value = serde_json::to_value(envelope).ok()?;
    let kind = value.get("kind")?.as_object()?;
    (kind.get("type")?.as_str()? == "toolEnd").then(|| {
        (
            kind.get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            kind.get("tool")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            kind.get("ok").and_then(Value::as_bool).unwrap_or(false),
        )
    })
}

fn raw_tool_outputs(source_kind: &str, raw: &str) -> Result<Vec<RawToolOutput>, String> {
    let value: Value = serde_json::from_str(raw).map_err(|_| "invalid complete JSONL record")?;
    if source_kind == "codex" {
        let payload = value.get("payload").unwrap_or(&value);
        let outer = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let inner = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(
            (outer, inner),
            ("response_item", "function_call_output")
                | ("response_item", "custom_tool_call_output")
        ) {
            let output = payload
                .get("call_id")
                .and_then(Value::as_str)
                .and_then(|call_id| {
                    raw_collect_text(payload.get("output")).map(|output| RawToolOutput {
                        call_id: call_id.to_string(),
                        output,
                    })
                });
            return Ok(output.into_iter().collect());
        }
        return Ok(Vec::new());
    }
    let record_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = value.get("message").unwrap_or(&value);
    let blocks = match record_type {
        "tool_result" => vec![&value],
        "user" => message
            .get("content")
            .and_then(Value::as_array)
            .map(|items| items.iter().collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    Ok(blocks
        .into_iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter_map(|block| {
            let call_id = block
                .get("tool_use_id")
                .or_else(|| block.get("toolUseId"))
                .and_then(Value::as_str)?;
            let output = raw_collect_text(block.get("content"))?;
            Some(RawToolOutput {
                call_id: call_id.to_string(),
                output,
            })
        })
        .collect())
}

fn raw_collect_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.trim().is_empty() => Some(text.to_string()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then_some(text)
        }
        Value::Object(map) => map.get("text").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

fn is_write_tool_candidate(tool: &str) -> bool {
    matches!(
        tool.to_ascii_lowercase().as_str(),
        "edit" | "write" | "multiedit" | "notebookedit" | "apply_patch"
    )
}

fn is_test_command_tool(tool: &str) -> bool {
    matches!(
        tool.to_ascii_lowercase().as_str(),
        "bash" | "powershell" | "exec"
    )
}

fn explicit_test_result_count(output: &str) -> usize {
    output
        .lines()
        .filter(|line| parse_explicit_test_result(line).is_some())
        .count()
}

fn parse_explicit_test_result(line: &str) -> Option<(u32, u32)> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("test result: ") {
        let pass = count_before_marker(rest, " passed;")?;
        let fail = count_before_marker(rest, " failed;").unwrap_or(0);
        return Some((pass, fail));
    }
    if let Some(rest) = line.strip_prefix("Tests") {
        let pass = first_number(rest)?;
        if rest.contains(" passed (") {
            return Some((pass, 0));
        }
    }
    if line.starts_with('=') && line.ends_with('=') && line.contains(" passed in ") {
        let pass = count_before_marker(line, " passed in")?;
        let fail = count_before_marker(line, " failed,").unwrap_or(0);
        return Some((pass, fail));
    }
    None
}

fn count_before_marker(text: &str, marker: &str) -> Option<u32> {
    let prefix = text.split_once(marker)?.0;
    prefix
        .split_whitespace()
        .last()
        .and_then(|number| number.parse::<u32>().ok())
}

fn first_number(text: &str) -> Option<u32> {
    text.split_whitespace()
        .find_map(|word| word.parse::<u32>().ok())
}

fn clear_error_line(output: &str) -> Option<&str> {
    output.lines().map(str::trim).find(|line| {
        line.starts_with("error:")
            || line.starts_with("error[")
            || line.starts_with("FAILED")
            || line.starts_with("Traceback")
    })
}

fn collect_invocation_events(
    events: &[JournalEvent],
    logical_session_id: &str,
    output: &mut HashMap<(String, String), InvocationEvent>,
) -> Result<(), String> {
    let mut terminal_call_ids = HashMap::<String, String>::new();
    for event in events {
        let value = event_value(&event.envelope).map_err(|error| error.to_string())?;
        let Some(kind) = value.get("kind").and_then(Value::as_object) else {
            continue;
        };
        let kind_name = kind.get("type").and_then(Value::as_str).unwrap_or_default();
        if !matches!(kind_name, "toolStart" | "toolEnd") {
            continue;
        }
        let Some(call_id) = kind
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|call_id| *call_id != "missing-call-id")
        else {
            continue;
        };
        output.insert(
            (
                logical_session_id.to_string(),
                event.envelope.event_id.clone(),
            ),
            InvocationEvent {
                kind: kind_name.to_string(),
                timestamp: event.envelope.occurred_at,
                call_id: call_id.to_string(),
            },
        );
        if kind_name == "toolEnd" {
            terminal_call_ids.insert(
                event_native_id(&event.envelope.event_id),
                call_id.to_string(),
            );
        }
    }
    for event in events {
        let value = event_value(&event.envelope).map_err(|error| error.to_string())?;
        let Some(kind) = value.get("kind").and_then(Value::as_object) else {
            continue;
        };
        if kind.get("type").and_then(Value::as_str) != Some("fileChange") {
            continue;
        }
        let Some(call_id) = terminal_call_ids.get(&event_native_id(&event.envelope.event_id))
        else {
            continue;
        };
        output.insert(
            (
                logical_session_id.to_string(),
                event.envelope.event_id.clone(),
            ),
            InvocationEvent {
                kind: "fileChange".to_string(),
                timestamp: event.envelope.occurred_at,
                call_id: call_id.to_string(),
            },
        );
    }
    Ok(())
}

fn event_native_id(event_id: &str) -> String {
    event_id
        .rsplit_once(':')
        .map(|(native_id, _)| native_id)
        .unwrap_or(event_id)
        .to_string()
}

fn invocation_for_event(
    logical_session_id: &str,
    event_id: &str,
    events: &HashMap<(String, String), InvocationEvent>,
) -> Option<InvocationKey> {
    actual_call_id(logical_session_id, event_id, events).map(|call_id| InvocationKey {
        logical_session_id: logical_session_id.to_string(),
        call_id: call_id.to_string(),
    })
}

fn actual_call_id<'a>(
    logical_session_id: &str,
    event_id: &str,
    events: &'a HashMap<(String, String), InvocationEvent>,
) -> Option<&'a str> {
    events
        .get(&(logical_session_id.to_string(), event_id.to_string()))
        .map(|event| event.call_id.as_str())
}

fn merge_counts(target: &mut BTreeMap<String, usize>, source: BTreeMap<String, usize>) {
    for (key, count) in source {
        *target.entry(key).or_default() += count;
    }
}

fn render_count_table(output: &mut String, label: &str, counts: &BTreeMap<String, usize>) {
    output.push_str(label);
    output.push('\n');
    if counts.is_empty() {
        output.push_str("  (none)\n");
        return;
    }
    for (name, count) in counts {
        output.push_str(&format!("  {:<24} {}\n", name, count));
    }
}

fn short_hash(value: &str) -> String {
    sha256_hex(value.as_bytes()).chars().take(12).collect()
}

fn fts_term_count(text: &str) -> usize {
    let mut count = 0;
    let mut in_term = false;
    for character in text.chars() {
        if character.is_alphanumeric() {
            if !in_term {
                count += 1;
                in_term = true;
            }
        } else {
            in_term = false;
        }
    }
    count
}

fn safe_query_excerpt(query: &str) -> String {
    let redacted = query
        .split_whitespace()
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            if lower.contains("token")
                || lower.contains("secret")
                || lower.contains("password")
                || lower.contains("api_key")
                || lower.contains("credential")
            {
                "[redacted]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    redacted.chars().take(160).collect()
}

fn collect_query_drafts(
    events: &[JournalEvent],
    logical_session_id: &str,
    invocation_events: &HashMap<(String, String), InvocationEvent>,
    categories: &mut [CategoryMetrics; 4],
    drafts: &mut Vec<QueryDraft>,
) -> Result<(), String> {
    for event in events {
        let value = event_value(&event.envelope).map_err(|error| error.to_string())?;
        let Some(kind) = value.get("kind").and_then(Value::as_object) else {
            continue;
        };
        let event_type = kind.get("type").and_then(Value::as_str).unwrap_or_default();
        match event_type {
            "fileChange" => add_query_draft(
                QueryKind::Path,
                kind.get("path").and_then(Value::as_str).map(str::to_string),
                event,
                logical_session_id,
                invocation_for_event(
                    logical_session_id,
                    &event.envelope.event_id,
                    invocation_events,
                ),
                categories,
                drafts,
            ),
            "toolStart" => {
                let tool = kind.get("tool").and_then(Value::as_str).unwrap_or_default();
                let target = kind.get("target").and_then(Value::as_str);
                let invocation = kind
                    .get("call_id")
                    .and_then(Value::as_str)
                    .filter(|call_id| *call_id != "missing-call-id")
                    .map(|call_id| InvocationKey {
                        logical_session_id: logical_session_id.to_string(),
                        call_id: call_id.to_string(),
                    });
                if is_command_tool(tool) {
                    add_query_draft(
                        QueryKind::Command,
                        target.and_then(|target| fts_prefix(target, 2, 8)),
                        event,
                        logical_session_id,
                        invocation,
                        categories,
                        drafts,
                    );
                } else {
                    add_query_draft(
                        QueryKind::Path,
                        target
                            .filter(|target| looks_like_path(target))
                            .map(str::to_string),
                        event,
                        logical_session_id,
                        invocation,
                        categories,
                        drafts,
                    );
                }
            }
            "error" => add_query_draft(
                QueryKind::Error,
                kind.get("text")
                    .and_then(Value::as_str)
                    .and_then(|text| fts_prefix(text, 1, 8)),
                event,
                logical_session_id,
                None,
                categories,
                drafts,
            ),
            "userMessage" => {
                let text = kind.get("text").and_then(Value::as_str);
                add_query_draft(
                    QueryKind::Natural,
                    text.filter(|text| !is_injected_user_text(text))
                        .and_then(|text| fts_prefix(text, 3, 10)),
                    event,
                    logical_session_id,
                    None,
                    categories,
                    drafts,
                );
            }
            _ => {}
        }
    }
    Ok(())
}

fn add_query_draft(
    kind: QueryKind,
    text: Option<String>,
    event: &JournalEvent,
    logical_session_id: &str,
    invocation: Option<InvocationKey>,
    categories: &mut [CategoryMetrics; 4],
    drafts: &mut Vec<QueryDraft>,
) {
    let metrics = &mut categories[kind.index()];
    metrics.source_candidates += 1;
    let Some(text) = text.filter(|text| search::compile_match(text).is_some()) else {
        metrics.excluded_without_ground_truth += 1;
        return;
    };
    metrics.eligible_queries += 1;
    drafts.push(QueryDraft {
        kind,
        text,
        logical_session_id: logical_session_id.to_string(),
        event_id: event.envelope.event_id.clone(),
        source_key: logical_session_id.to_string(),
        invocation,
    });
}

fn is_command_tool(tool: &str) -> bool {
    let tool = tool.to_ascii_lowercase();
    matches!(
        tool.as_str(),
        "bash" | "cmd" | "exec" | "powershell" | "run_command" | "shell_command" | "terminal"
    ) || tool.ends_with(".exec")
}

fn looks_like_path(target: &str) -> bool {
    target.contains('/')
        || target.contains('\\')
        || target.starts_with("./")
        || target.starts_with("../")
        || target.get(1..2) == Some(":")
        || target.rsplit_once('.').is_some_and(|(_, extension)| {
            extension
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        })
}

fn is_injected_user_text(text: &str) -> bool {
    let text = text.trim_start();
    [
        "<command-name>",
        "<command-message>",
        "<local-command-stdout>",
        "<system-reminder>",
        "<recommended_plugins>",
        "<user_instructions>",
        "<environment_context>",
        "<plan_mode>",
        "<INSTRUCTIONS>",
        "# Codex CLI",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}

fn fts_prefix(text: &str, min_terms: usize, max_terms: usize) -> Option<String> {
    let mut terms = 0_usize;
    let mut in_term = false;
    let mut end = 0_usize;
    for (index, character) in text.char_indices() {
        if character.is_alphanumeric() {
            if !in_term {
                terms += 1;
                if terms > max_terms {
                    break;
                }
                in_term = true;
            }
            end = index + character.len_utf8();
        } else {
            in_term = false;
        }
    }
    (terms >= min_terms && end > 0).then(|| text[..end].trim().to_string())
}

fn sample_key(query: &QueryDraft) -> String {
    sha256_hex(
        format!(
            "{QUERY_SAMPLE_SEED}\0{}\0{}\0{}\0{}",
            query.kind.label(),
            query.source_key,
            query.event_id,
            query.text,
        )
        .as_bytes(),
    )
}

fn sqlite_artifact_bytes(db_path: &Path) -> Result<u64, String> {
    [
        db_path.to_path_buf(),
        PathBuf::from(format!("{}-wal", db_path.display())),
        PathBuf::from(format!("{}-shm", db_path.display())),
    ]
    .iter()
    .try_fold(0_u64, |total, path| match fs::metadata(path) {
        Ok(metadata) => Ok(total.saturating_add(metadata.len())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(total),
        Err(error) => Err(format!("stat temporary DB {}: {error}", path.display())),
    })
}

fn verify_source_integrity(sources: &[SourceSession]) -> SourceIntegrity {
    let mut integrity = SourceIntegrity::default();
    for source in sources {
        integrity.checked += 1;
        match fs::metadata(&source.path) {
            Ok(metadata) => {
                if metadata.len() != source.stamp.len {
                    integrity.size_changed += 1;
                }
                if metadata.modified().ok() != Some(source.stamp.modified) {
                    integrity.mtime_changed += 1;
                }
            }
            Err(_) => {
                integrity.size_changed += 1;
                integrity.mtime_changed += 1;
            }
        }
    }
    integrity
}

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn rate(numerator: usize, denominator: usize) -> String {
    (denominator > 0)
        .then(|| format!("{:.4}", numerator as f64 / denominator as f64))
        .unwrap_or_else(|| "N/A".to_string())
}

fn mrr(metrics: &CategoryMetrics) -> String {
    (metrics.queries > 0)
        .then(|| {
            format!(
                "{:.4}",
                metrics.reciprocal_rank_sum / metrics.queries as f64
            )
        })
        .unwrap_or_else(|| "N/A".to_string())
}

fn median_micros(values: &[Duration]) -> String {
    if values.is_empty() {
        return "N/A".to_string();
    }
    let mut values = values.iter().map(Duration::as_micros).collect::<Vec<_>>();
    values.sort_unstable();
    values[values.len() / 2].to_string()
}

fn configured_session_limit() -> usize {
    std::env::var("HISTORY_EVAL_SESSION_LIMIT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|limit| *limit > 0)
        .unwrap_or(DEFAULT_SESSION_LIMIT)
}

/// Requires local transcript data and is deliberately ignored by the standard
/// test suite. Optionally set HISTORY_EVAL_HOME to a fixture home, set
/// HISTORY_EVAL_SESSION_LIMIT (default 20), and run this exact test with
/// `--ignored --exact --nocapture`.
#[test]
#[ignore = "reads machine-local Claude/Codex transcripts; run deliberately with --ignored --nocapture"]
fn real_log_search_evaluation() {
    let report = evaluate_local_logs(configured_session_limit()).expect("evaluate real logs");
    println!("{}", report.render());
    assert_eq!(
        report.integrity.size_changed, 0,
        "source sizes changed during evaluation"
    );
    assert_eq!(
        report.integrity.mtime_changed, 0,
        "source mtimes changed during evaluation"
    );
}

#[test]
fn transcript_roots_are_derived_from_an_injected_posix_home() {
    let home = Path::new("/Users/example");
    let cwd = Path::new("/Users/example/work/mycmux");
    assert_eq!(
        claude_transcript_root(cwd, home),
        PathBuf::from("/Users/example/.claude/projects/-Users-example-work-mycmux")
    );
    assert_eq!(
        codex_transcript_root(home),
        PathBuf::from("/Users/example/.codex/sessions")
    );
}

#[test]
fn fts_prefix_uses_existing_terms_without_creating_a_new_tokenizer() {
    assert_eq!(
        fts_prefix("cargo test --release --no-run", 2, 3).as_deref(),
        Some("cargo test --release")
    );
    assert!(fts_prefix("単語なし", 3, 10).is_none());
}

#[test]
fn path_and_command_classification_stays_mechanical() {
    assert!(looks_like_path("src/history/eval.rs"));
    assert!(!looks_like_path("cargo test --release"));
    assert!(is_command_tool("shell_command"));
    assert!(!is_command_tool("Read"));
}

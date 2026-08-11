//! Aggregation queries over the indexed transcripts.
//!
//! Every report is built from a single ordered pass over the `turn` rows that
//! fall inside the requested window, joined to their session. Session-level
//! figures (user messages, wall time) are recorded once per session key rather
//! than summed per turn.
//!
//! Two invariants the whole file preserves:
//!
//! * **Model figures are accumulated per turn, never per session.** A session
//!   that used two models contributes to both, so per-model session counts can
//!   sum to more than the session total. That overlap is reported, not hidden.
//! * **Nothing is pro-rated.** Work tags overlap and cost per tag therefore
//!   exceeds the grand total; the response sets `overlapping` instead of
//!   inventing a split.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use crate::ailog::price::{normalize, PriceTable};
use crate::ailog::{Filters, Range, ResolvedRange};

type SessionKey = (String, String);

// ---------------------------------------------------------------------------
// SQL filter construction
// ---------------------------------------------------------------------------

struct Where {
    sql: String,
    params: Vec<SqlValue>,
}

fn push_in(clauses: &mut Vec<String>, params: &mut Vec<SqlValue>, column: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    let holes = vec!["?"; values.len()].join(",");
    clauses.push(format!("{column} IN ({holes})"));
    for value in values {
        params.push(SqlValue::Text(value.clone()));
    }
}

/// Build the shared `WHERE` fragment.
///
/// `force_sidechain` exists for `dimension="agent"`, where excluding
/// sub-agents would empty the report by definition.
fn build_where(range: &ResolvedRange, filters: &Filters, force_sidechain: bool) -> Where {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();

    clauses.push("t.ts >= ?".to_string());
    params.push(SqlValue::Integer(range.from));
    clauses.push("t.ts <= ?".to_string());
    params.push(SqlValue::Integer(range.to));

    if !filters.include_sidechain && !force_sidechain {
        clauses.push("s.is_sidechain = 0".to_string());
    }

    push_in(&mut clauses, &mut params, "t.kind", &filters.kinds);
    push_in(&mut clauses, &mut params, "t.effort", &filters.efforts);
    push_in(&mut clauses, &mut params, "s.git_branch", &filters.branches);
    push_in(&mut clauses, &mut params, "s.origin", &filters.origins);

    if !filters.models.is_empty() {
        let holes = vec!["?"; filters.models.len()].join(",");
        clauses.push(format!(
            "(t.model_family IN ({holes}) OR t.model IN ({holes}))"
        ));
        for _ in 0..2 {
            for value in &filters.models {
                params.push(SqlValue::Text(value.clone()));
            }
        }
    }

    if !filters.projects.is_empty() {
        let holes = vec!["?"; filters.projects.len()].join(",");
        clauses.push(format!(
            "(s.project_key IN ({holes}) OR s.project_label IN ({holes}))"
        ));
        for value in &filters.projects {
            params.push(SqlValue::Text(value.to_lowercase()));
        }
        for value in &filters.projects {
            params.push(SqlValue::Text(value.clone()));
        }
    }

    if let Some(min_cost) = filters.min_cost {
        clauses.push("s.cost_usd >= ?".to_string());
        params.push(SqlValue::Real(min_cost));
    }

    if let Some(query) = filters.query.as_ref().filter(|value| !value.is_empty()) {
        clauses.push(
            "(COALESCE(s.ai_title,'') LIKE ? OR COALESCE(s.first_prompt,'') LIKE ? \
             OR COALESCE(s.project_label,'') LIKE ?)"
                .to_string(),
        );
        let pattern = format!("%{query}%");
        for _ in 0..3 {
            params.push(SqlValue::Text(pattern.clone()));
        }
    }

    Where {
        sql: clauses.join(" AND "),
        params,
    }
}

const TURN_SELECT: &str = "SELECT t.kind, t.session_id, t.seq, t.ts, t.model, t.model_family, \
     t.effort, t.input_tokens, t.output_tokens, t.cache_read_tokens, \
     t.cache_write_5m_tokens, t.cache_write_1h_tokens, t.reasoning_tokens, t.duration_ms, \
     t.tool_calls, t.tool_errors, t.cost_usd, t.ingest_cost_usd, t.generate_cost_usd, \
     s.project_key, s.project_label, s.git_branch, s.origin, s.ai_title, s.goal_key, \
     s.is_sidechain, s.work_tags, s.agent_names, s.cost_usd, s.user_msg_count, \
     s.wall_ms, s.active_ms, s.compact_count, COALESCE(r.score, 0), s.first_prompt, s.ends_on_tool \
     FROM turn t \
     JOIN session s ON s.kind = t.kind AND s.session_id = t.session_id \
     LEFT JOIN rework r ON r.kind = t.kind AND r.session_id = t.session_id";

#[derive(Debug, Clone)]
struct TurnRecord {
    kind: String,
    session_id: String,
    ts: i64,
    model: Option<String>,
    family: Option<String>,
    effort: Option<String>,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    reasoning: i64,
    duration_ms: i64,
    tool_calls: i64,
    tool_errors: i64,
    cost: f64,
    ingest: f64,
    generate: f64,
    project_label: Option<String>,
    branch: Option<String>,
    origin: Option<String>,
    ai_title: Option<String>,
    goal_key: Option<String>,
    is_sidechain: bool,
    work_tags: Option<String>,
    agent_names: Option<String>,
    user_msgs: i64,
    wall_ms: i64,
    active_ms: i64,
    compacts: i64,
    rework: f64,
    first_prompt: Option<String>,
    abandoned: bool,
}

fn read_turns(
    conn: &Connection,
    range: &ResolvedRange,
    filters: &Filters,
    force_sidechain: bool,
) -> Result<Vec<TurnRecord>, String> {
    let filter = build_where(range, filters, force_sidechain);
    let sql = format!(
        "{TURN_SELECT} WHERE {} ORDER BY t.kind, t.session_id, t.seq",
        filter.sql
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("prepare turn query: {err}"))?;
    let rows = stmt
        .query_map(params_from_iter(filter.params.iter()), |row| {
            Ok(TurnRecord {
                kind: row.get(0)?,
                session_id: row.get(1)?,
                ts: row.get(3)?,
                model: row.get(4)?,
                family: row.get(5)?,
                effort: row.get(6)?,
                input: row.get(7)?,
                output: row.get(8)?,
                cache_read: row.get(9)?,
                cache_write: row.get::<_, i64>(10)? + row.get::<_, i64>(11)?,
                reasoning: row.get(12)?,
                duration_ms: row.get::<_, Option<i64>>(13)?.unwrap_or(0),
                tool_calls: row.get(14)?,
                tool_errors: row.get(15)?,
                cost: row.get(16)?,
                ingest: row.get(17)?,
                generate: row.get(18)?,
                project_label: row.get(20)?,
                branch: row.get(21)?,
                origin: row.get(22)?,
                ai_title: row.get(23)?,
                goal_key: row.get(24)?,
                is_sidechain: row.get::<_, i64>(25)? != 0,
                work_tags: row.get(26)?,
                agent_names: row.get(27)?,
                user_msgs: row.get(29)?,
                wall_ms: row.get::<_, Option<i64>>(30)?.unwrap_or(0),
                active_ms: row.get::<_, Option<i64>>(31)?.unwrap_or(0),
                compacts: row.get(32)?,
                rework: row.get(33)?,
                first_prompt: row.get(34)?,
                abandoned: row.get::<_, i64>(35)? != 0,
            })
        })
        .map_err(|err| format!("run turn query: {err}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| format!("turn row: {err}"))?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Accumulators
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct TokenAcc {
    turns: i64,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    reasoning: i64,
    cost: f64,
    ingest: f64,
    generate: f64,
    duration_ms: i64,
    timed_turns: i64,
    tool_calls: i64,
    tool_errors: i64,
    first_used: Option<i64>,
    last_used: Option<i64>,
}

impl TokenAcc {
    fn add(&mut self, turn: &TurnRecord) {
        self.turns += 1;
        self.input += turn.input;
        self.output += turn.output;
        self.cache_read += turn.cache_read;
        self.cache_write += turn.cache_write;
        self.reasoning += turn.reasoning;
        self.cost += turn.cost;
        self.ingest += turn.ingest;
        self.generate += turn.generate;
        self.tool_calls += turn.tool_calls;
        self.tool_errors += turn.tool_errors;
        if turn.duration_ms > 0 {
            self.duration_ms += turn.duration_ms;
            self.timed_turns += 1;
        }
        self.first_used = Some(self.first_used.map_or(turn.ts, |v| v.min(turn.ts)));
        self.last_used = Some(self.last_used.map_or(turn.ts, |v| v.max(turn.ts)));
    }

    /// `cache_read / (cache_read + input + cache_write)`. Higher is cheaper.
    fn cache_hit_rate(&self) -> f64 {
        let denominator = self.cache_read + self.input + self.cache_write;
        if denominator <= 0 {
            0.0
        } else {
            self.cache_read as f64 / denominator as f64
        }
    }

    /// Output tokens produced per dollar of estimated spend.
    fn output_density(&self) -> f64 {
        if self.cost <= 0.0 {
            0.0
        } else {
            self.output as f64 / self.cost
        }
    }

    fn avg_turn_ms(&self) -> f64 {
        if self.timed_turns == 0 {
            0.0
        } else {
            self.duration_ms as f64 / self.timed_turns as f64
        }
    }
}

#[derive(Debug, Clone)]
struct SessionAcc {
    project_label: Option<String>,
    ai_title: Option<String>,
    first_prompt: Option<String>,
    tags: Vec<String>,
    user_msgs: i64,
    wall_ms: i64,
    active_ms: i64,
    rework: f64,
    abandoned: bool,
    families: BTreeSet<String>,
    tokens: TokenAcc,
}

fn parse_json_array(value: Option<&str>) -> Vec<String> {
    value
        .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
        .unwrap_or_default()
}

/// One pass over the turn rows, producing everything the reports need.
struct Pass {
    totals: TokenAcc,
    sessions: BTreeMap<SessionKey, SessionAcc>,
    by_family: BTreeMap<String, TokenAcc>,
    by_raw: BTreeMap<String, TokenAcc>,
    family_sessions: BTreeMap<String, HashSet<SessionKey>>,
    raw_sessions: BTreeMap<String, HashSet<SessionKey>>,
    family_effort: BTreeMap<(String, String), TokenAcc>,
    unpriced: BTreeSet<String>,
    tag_model: BTreeMap<(String, String), TokenAcc>,
    tag_model_sessions: BTreeMap<(String, String), HashSet<SessionKey>>,
}

fn run_pass(turns: &[TurnRecord], prices: &PriceTable) -> Pass {
    let mut pass = Pass {
        totals: TokenAcc::default(),
        sessions: BTreeMap::new(),
        by_family: BTreeMap::new(),
        by_raw: BTreeMap::new(),
        family_sessions: BTreeMap::new(),
        raw_sessions: BTreeMap::new(),
        family_effort: BTreeMap::new(),
        unpriced: BTreeSet::new(),
        tag_model: BTreeMap::new(),
        tag_model_sessions: BTreeMap::new(),
    };
    for turn in turns {
        let key: SessionKey = (turn.kind.clone(), turn.session_id.clone());
        pass.totals.add(turn);

        let entry = pass
            .sessions
            .entry(key.clone())
            .or_insert_with(|| SessionAcc {
                project_label: turn.project_label.clone(),
                ai_title: turn.ai_title.clone(),
                first_prompt: turn.first_prompt.clone(),
                tags: parse_json_array(turn.work_tags.as_deref()),
                user_msgs: turn.user_msgs,
                wall_ms: turn.wall_ms,
                active_ms: turn.active_ms,
                rework: turn.rework,
                abandoned: turn.abandoned,
                families: BTreeSet::new(),
                tokens: TokenAcc::default(),
            });
        entry.tokens.add(turn);

        if let Some(model) = &turn.model {
            if prices.lookup(model).is_none() {
                pass.unpriced.insert(model.clone());
            }
            pass.by_raw.entry(model.clone()).or_default().add(turn);
            pass.raw_sessions
                .entry(model.clone())
                .or_default()
                .insert(key.clone());
        }

        if let Some(family) = &turn.family {
            entry.families.insert(family.clone());
            pass.by_family.entry(family.clone()).or_default().add(turn);
            pass.family_sessions
                .entry(family.clone())
                .or_default()
                .insert(key.clone());

            let effort = turn.effort.clone().unwrap_or_else(|| "(none)".to_string());
            pass.family_effort
                .entry((family.clone(), effort))
                .or_default()
                .add(turn);

            let tags = entry.tags.clone();
            for tag in tags {
                pass.tag_model
                    .entry((tag.clone(), family.clone()))
                    .or_default()
                    .add(turn);
                pass.tag_model_sessions
                    .entry((tag, family.clone()))
                    .or_default()
                    .insert(key.clone());
            }
        }
    }

    pass
}

fn avg_rework(sessions: &BTreeMap<SessionKey, SessionAcc>, keys: &HashSet<SessionKey>) -> f64 {
    if keys.is_empty() {
        return 0.0;
    }
    let sum: f64 = keys
        .iter()
        .filter_map(|key| sessions.get(key))
        .map(|session| session.rework)
        .sum();
    sum / keys.len() as f64
}

// ---------------------------------------------------------------------------
// Shared response pieces
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeOut {
    pub from: i64,
    pub to: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub sessions: i64,
    pub turns: i64,
    pub user_messages: i64,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub reasoning: i64,
    pub cost_usd: f64,
    pub wall_ms: i64,
    pub active_ms: i64,
    pub projects: i64,
    pub models: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparePrevious {
    pub sessions_pct: f64,
    pub cost_pct: f64,
    pub tokens_pct: f64,
    pub rework_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub model: String,
    pub family: String,
    pub sessions: i64,
    pub turns: i64,
    pub user_messages: i64,
    pub cost_usd: f64,
    pub ingest_cost_usd: f64,
    pub generate_cost_usd: f64,
    pub share_pct: f64,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub reasoning: i64,
    pub cache_hit_rate: f64,
    pub output_density: f64,
    pub duration_ms: i64,
    pub avg_turn_ms: f64,
    pub avg_rework: f64,
    pub tool_error_rate: f64,
    pub abandoned_rate: f64,
    pub first_used_at: i64,
    pub last_used_at: i64,
    pub by_effort: Vec<EffortRow>,
    pub priced: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortRow {
    pub effort: String,
    pub turns: i64,
    pub cost_usd: f64,
    pub input: i64,
    pub output: i64,
    pub avg_turn_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub project_label: String,
    pub sessions: i64,
    pub cost_usd: f64,
    pub share_pct: f64,
    pub top_title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleRow {
    pub title: String,
    pub kind: String,
    pub session_id: String,
    pub cost_usd: f64,
    pub turns: i64,
    pub rework_score: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReworkSummary {
    pub avg_score: f64,
    pub tool_error_rate: f64,
    pub correction_hits: i64,
    pub churn_files: i64,
    pub abandoned_sessions: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFreshness {
    pub last_indexed_at: i64,
    pub stale_files: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub range: RangeOut,
    pub totals: Totals,
    pub compare_previous: ComparePrevious,
    pub top_models: Vec<ModelRow>,
    pub mixed_model_sessions: i64,
    pub top_projects: Vec<ProjectRow>,
    pub top_titles: Vec<TitleRow>,
    pub rework: ReworkSummary,
    pub cache_hit_rate: f64,
    pub price_source: String,
    pub unpriced_models: Vec<String>,
    pub index_freshness: IndexFreshness,
    /// Reminder for the UI: these are metered-equivalent estimates, not bills.
    pub cost_note: String,
}

pub const COST_NOTE: &str =
    "Costs are reference estimates of metered pricing, not actual billing. \
     Models without a published rate contribute zero and are listed in unpricedModels.";

// ---------------------------------------------------------------------------
// Rework aggregation helper
// ---------------------------------------------------------------------------

fn rework_summary(
    conn: &Connection,
    sessions: &BTreeMap<SessionKey, SessionAcc>,
) -> Result<ReworkSummary, String> {
    if sessions.is_empty() {
        return Ok(ReworkSummary::default());
    }
    let mut summary = ReworkSummary::default();
    let mut score_sum = 0.0;
    let mut errors = 0i64;
    let mut calls = 0i64;

    let mut stmt = conn
        .prepare(
            "SELECT tool_error_count, tool_call_count, correction_count, churn_files, \
             abandoned, score FROM rework WHERE kind = ?1 AND session_id = ?2",
        )
        .map_err(|err| format!("prepare rework: {err}"))?;

    for (kind, session_id) in sessions.keys() {
        let row = stmt.query_row(rusqlite::params![kind, session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, f64>(5)?,
            ))
        });
        if let Ok((error_count, call_count, corrections, churn, abandoned, score)) = row {
            errors += error_count;
            calls += call_count;
            summary.correction_hits += corrections;
            summary.churn_files += churn;
            if abandoned != 0 {
                summary.abandoned_sessions += 1;
            }
            score_sum += score;
        }
    }

    summary.avg_score = score_sum / sessions.len() as f64;
    summary.tool_error_rate = if calls > 0 {
        errors as f64 / calls as f64
    } else {
        0.0
    };
    Ok(summary)
}

fn pct_change(current: f64, previous: f64) -> f64 {
    if previous.abs() < f64::EPSILON {
        if current.abs() < f64::EPSILON {
            0.0
        } else {
            100.0
        }
    } else {
        (current - previous) / previous * 100.0
    }
}

fn build_model_rows(pass: &Pass, granularity: &str, prices: &PriceTable) -> Vec<ModelRow> {
    let (source, session_index) = if granularity == "raw" {
        (&pass.by_raw, &pass.raw_sessions)
    } else {
        (&pass.by_family, &pass.family_sessions)
    };
    let total_cost: f64 = pass.totals.cost;

    let mut rows: Vec<ModelRow> = source
        .iter()
        .map(|(name, acc)| {
            let keys = session_index.get(name).cloned().unwrap_or_default();
            let user_messages: i64 = keys
                .iter()
                .filter_map(|key| pass.sessions.get(key))
                .map(|session| session.user_msgs)
                .sum();
            // "Abandoned" means the transcript ends on a tool invocation with
            // no closing message — the stored flag, not a rework proxy.
            let abandoned = keys
                .iter()
                .filter_map(|key| pass.sessions.get(key))
                .filter(|session| session.abandoned)
                .count();
            let family = if granularity == "raw" {
                normalize(name).family
            } else {
                name.clone()
            };
            let by_effort = pass
                .family_effort
                .iter()
                .filter(|((model, _), _)| model == &family)
                .map(|((_, effort), acc)| EffortRow {
                    effort: effort.clone(),
                    turns: acc.turns,
                    cost_usd: acc.cost,
                    input: acc.input,
                    output: acc.output,
                    avg_turn_ms: acc.avg_turn_ms(),
                })
                .collect();

            ModelRow {
                model: name.clone(),
                family,
                sessions: keys.len() as i64,
                turns: acc.turns,
                user_messages,
                cost_usd: acc.cost,
                ingest_cost_usd: acc.ingest,
                generate_cost_usd: acc.generate,
                share_pct: if total_cost > 0.0 {
                    acc.cost / total_cost * 100.0
                } else {
                    0.0
                },
                input: acc.input,
                output: acc.output,
                cache_read: acc.cache_read,
                cache_write: acc.cache_write,
                reasoning: acc.reasoning,
                cache_hit_rate: acc.cache_hit_rate(),
                output_density: acc.output_density(),
                duration_ms: acc.duration_ms,
                avg_turn_ms: acc.avg_turn_ms(),
                avg_rework: avg_rework(&pass.sessions, &keys),
                tool_error_rate: if acc.tool_calls > 0 {
                    acc.tool_errors as f64 / acc.tool_calls as f64
                } else {
                    0.0
                },
                abandoned_rate: if keys.is_empty() {
                    0.0
                } else {
                    abandoned as f64 / keys.len() as f64
                },
                first_used_at: acc.first_used.unwrap_or(0),
                last_used_at: acc.last_used.unwrap_or(0),
                by_effort,
                priced: prices.lookup(name).is_some(),
            }
        })
        .collect();

    rows.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.turns.cmp(&a.turns))
            .then_with(|| a.model.cmp(&b.model))
    });
    rows
}

fn index_freshness(conn: &Connection) -> IndexFreshness {
    let last_indexed_at = conn
        .query_row(
            "SELECT value FROM index_state WHERE key = 'last_finished_at'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let stale_files = conn
        .query_row(
            "SELECT COUNT(*) FROM source_file WHERE parsed_bytes < size_bytes \
             OR parse_error IS NOT NULL",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);
    IndexFreshness {
        last_indexed_at,
        stale_files,
    }
}

// ---------------------------------------------------------------------------
// ailog_overview
// ---------------------------------------------------------------------------

pub fn overview(
    conn: &Connection,
    range: &Range,
    filters: &Filters,
    now_ms: i64,
) -> Result<Overview, String> {
    let (resolved, label) = range.resolve(now_ms);
    let prices = PriceTable::load(conn)?;
    let turns = read_turns(conn, &resolved, filters, false)?;
    let pass = run_pass(&turns, &prices);

    let sessions_count = pass.sessions.len() as i64;
    let projects: BTreeSet<String> = pass
        .sessions
        .values()
        .filter_map(|session| session.project_label.clone())
        .collect();

    let totals = Totals {
        sessions: sessions_count,
        turns: pass.totals.turns,
        user_messages: pass.sessions.values().map(|s| s.user_msgs).sum(),
        input: pass.totals.input,
        output: pass.totals.output,
        cache_read: pass.totals.cache_read,
        cache_write: pass.totals.cache_write,
        reasoning: pass.totals.reasoning,
        cost_usd: pass.totals.cost,
        wall_ms: pass.sessions.values().map(|s| s.wall_ms).sum(),
        active_ms: pass.sessions.values().map(|s| s.active_ms).sum(),
        projects: projects.len() as i64,
        models: pass.by_family.len() as i64,
    };

    // Same-length window immediately before the requested one.
    let span = (resolved.to - resolved.from).max(0);
    let previous_range = ResolvedRange {
        from: resolved.from - span,
        to: resolved.from,
    };
    let previous_turns = read_turns(conn, &previous_range, filters, false)?;
    let previous = run_pass(&previous_turns, &prices);
    let previous_rework = rework_summary(conn, &previous.sessions)?;
    let current_rework = rework_summary(conn, &pass.sessions)?;

    let compare_previous = ComparePrevious {
        sessions_pct: pct_change(sessions_count as f64, previous.sessions.len() as f64),
        cost_pct: pct_change(pass.totals.cost, previous.totals.cost),
        tokens_pct: pct_change(
            (pass.totals.input + pass.totals.output + pass.totals.cache_read) as f64,
            (previous.totals.input + previous.totals.output + previous.totals.cache_read) as f64,
        ),
        rework_pct: pct_change(current_rework.avg_score, previous_rework.avg_score),
    };

    // Projects, ranked by cost, with their most expensive title attached.
    let mut project_cost: BTreeMap<String, (f64, i64, Option<(f64, String)>)> = BTreeMap::new();
    for session in pass.sessions.values() {
        let Some(label) = &session.project_label else {
            continue;
        };
        let entry = project_cost.entry(label.clone()).or_insert((0.0, 0, None));
        entry.0 += session.tokens.cost;
        entry.1 += 1;
        let title = session
            .ai_title
            .clone()
            .or_else(|| session.first_prompt.clone());
        if let Some(title) = title {
            if entry
                .2
                .as_ref()
                .map_or(true, |(cost, _)| session.tokens.cost > *cost)
            {
                entry.2 = Some((session.tokens.cost, title));
            }
        }
    }
    let mut top_projects: Vec<ProjectRow> = project_cost
        .into_iter()
        .map(|(label, (cost, count, title))| ProjectRow {
            project_label: label,
            sessions: count,
            cost_usd: cost,
            share_pct: if pass.totals.cost > 0.0 {
                cost / pass.totals.cost * 100.0
            } else {
                0.0
            },
            top_title: title.map(|(_, value)| value),
        })
        .collect();
    top_projects.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    top_projects.truncate(20);

    let mut top_titles: Vec<TitleRow> = pass
        .sessions
        .iter()
        .filter_map(|((kind, session_id), session)| {
            let title = session
                .ai_title
                .clone()
                .or_else(|| session.first_prompt.clone())?;
            Some(TitleRow {
                title,
                kind: kind.clone(),
                session_id: session_id.clone(),
                cost_usd: session.tokens.cost,
                turns: session.tokens.turns,
                rework_score: session.rework,
            })
        })
        .collect();
    top_titles.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    top_titles.truncate(20);

    Ok(Overview {
        range: RangeOut {
            from: resolved.from,
            to: resolved.to,
            label,
        },
        totals,
        compare_previous,
        top_models: build_model_rows(&pass, "family", &prices),
        mixed_model_sessions: pass
            .sessions
            .values()
            .filter(|session| session.families.len() >= 2)
            .count() as i64,
        top_projects,
        top_titles,
        rework: current_rework,
        cache_hit_rate: pass.totals.cache_hit_rate(),
        price_source: prices.source_summary(),
        unpriced_models: pass.unpriced.iter().cloned().collect(),
        index_freshness: index_freshness(conn),
        cost_note: COST_NOTE.to_string(),
    })
}

// ---------------------------------------------------------------------------
// ailog_series
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct SeriesOptions {
    pub bucket: String,
    pub group_by: String,
}

impl Default for SeriesOptions {
    fn default() -> Self {
        Self {
            bucket: "day".to_string(),
            group_by: "none".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesGroup {
    pub group: String,
    pub turns: i64,
    pub sessions: i64,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesBucket {
    pub bucket: i64,
    pub turns: i64,
    pub sessions: i64,
    pub cost_usd: f64,
    pub groups: Vec<SeriesGroup>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesReport {
    pub range: RangeOut,
    pub bucket: String,
    pub group_by: String,
    pub buckets: Vec<SeriesBucket>,
    pub price_source: String,
    pub unpriced_models: Vec<String>,
    pub cost_note: String,
}

/// Snap a timestamp to the start of its bucket, in UTC.
pub fn bucket_start(ts: i64, bucket: &str) -> i64 {
    use chrono::{Datelike, TimeZone, Utc};
    let Some(dt) = Utc.timestamp_millis_opt(ts).single() else {
        return ts;
    };
    let day = Utc
        .with_ymd_and_hms(dt.year(), dt.month(), dt.day(), 0, 0, 0)
        .single();
    match bucket {
        "week" => {
            // ISO weeks start on Monday.
            let offset = dt.weekday().num_days_from_monday() as i64;
            day.map(|d| d.timestamp_millis() - offset * 86_400_000)
                .unwrap_or(ts)
        }
        "month" => Utc
            .with_ymd_and_hms(dt.year(), dt.month(), 1, 0, 0, 0)
            .single()
            .map(|d| d.timestamp_millis())
            .unwrap_or(ts),
        _ => day.map(|d| d.timestamp_millis()).unwrap_or(ts),
    }
}

fn group_value(turn: &TurnRecord, group_by: &str) -> String {
    match group_by {
        "model" => turn
            .family
            .clone()
            .unwrap_or_else(|| "(unknown)".to_string()),
        "kind" => turn.kind.clone(),
        "project" => turn
            .project_label
            .clone()
            .unwrap_or_else(|| "(unknown)".to_string()),
        "effort" => turn.effort.clone().unwrap_or_else(|| "(none)".to_string()),
        _ => "all".to_string(),
    }
}

pub fn series(
    conn: &Connection,
    range: &Range,
    filters: &Filters,
    options: &SeriesOptions,
    now_ms: i64,
) -> Result<SeriesReport, String> {
    let (resolved, label) = range.resolve(now_ms);
    let prices = PriceTable::load(conn)?;
    let turns = read_turns(conn, &resolved, filters, false)?;

    let mut buckets: BTreeMap<i64, BTreeMap<String, TokenAcc>> = BTreeMap::new();
    let mut bucket_sessions: BTreeMap<i64, HashSet<SessionKey>> = BTreeMap::new();
    let mut group_sessions: BTreeMap<(i64, String), HashSet<SessionKey>> = BTreeMap::new();
    let mut unpriced = BTreeSet::new();

    for turn in &turns {
        let bucket = bucket_start(turn.ts, &options.bucket);
        let group = group_value(turn, &options.group_by);
        let key: SessionKey = (turn.kind.clone(), turn.session_id.clone());
        buckets
            .entry(bucket)
            .or_default()
            .entry(group.clone())
            .or_default()
            .add(turn);
        bucket_sessions
            .entry(bucket)
            .or_default()
            .insert(key.clone());
        group_sessions
            .entry((bucket, group))
            .or_default()
            .insert(key);
        if let Some(model) = &turn.model {
            if prices.lookup(model).is_none() {
                unpriced.insert(model.clone());
            }
        }
    }

    let out = buckets
        .into_iter()
        .map(|(bucket, groups)| {
            let rows: Vec<SeriesGroup> = groups
                .iter()
                .map(|(group, acc)| SeriesGroup {
                    group: group.clone(),
                    turns: acc.turns,
                    sessions: group_sessions
                        .get(&(bucket, group.clone()))
                        .map(|set| set.len() as i64)
                        .unwrap_or(0),
                    input: acc.input,
                    output: acc.output,
                    cache_read: acc.cache_read,
                    cost_usd: acc.cost,
                })
                .collect();
            SeriesBucket {
                bucket,
                turns: rows.iter().map(|row| row.turns).sum(),
                sessions: bucket_sessions
                    .get(&bucket)
                    .map(|set| set.len() as i64)
                    .unwrap_or(0),
                cost_usd: rows.iter().map(|row| row.cost_usd).sum(),
                groups: rows,
            }
        })
        .collect();

    Ok(SeriesReport {
        range: RangeOut {
            from: resolved.from,
            to: resolved.to,
            label,
        },
        bucket: options.bucket.clone(),
        group_by: options.group_by.clone(),
        buckets: out,
        price_source: prices.source_summary(),
        unpriced_models: unpriced.into_iter().collect(),
        cost_note: COST_NOTE.to_string(),
    })
}

// ---------------------------------------------------------------------------
// ailog_breakdown
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownRow {
    pub key: String,
    pub sessions: i64,
    pub turns: i64,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost_usd: f64,
    pub share_pct: f64,
    pub cache_hit_rate: f64,
    pub avg_rework: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownReport {
    pub range: RangeOut,
    pub dimension: String,
    pub rows: Vec<BreakdownRow>,
    /// True when one turn can land in several rows (`agent`, `title` via
    /// multi-agent sessions), so the rows deliberately sum above the total.
    pub overlapping: bool,
    pub price_source: String,
    pub unpriced_models: Vec<String>,
    pub cost_note: String,
}

pub fn breakdown(
    conn: &Connection,
    range: &Range,
    filters: &Filters,
    dimension: &str,
    now_ms: i64,
) -> Result<BreakdownReport, String> {
    let (resolved, label) = range.resolve(now_ms);
    let prices = PriceTable::load(conn)?;
    // Sub-agent turns are the entire subject of the agent dimension, so the
    // default exclusion is overridden there.
    let force_sidechain = dimension == "agent";
    let turns = read_turns(conn, &resolved, filters, force_sidechain)?;

    let mut groups: BTreeMap<String, TokenAcc> = BTreeMap::new();
    let mut sessions: BTreeMap<String, HashSet<SessionKey>> = BTreeMap::new();
    let mut session_rework: HashMap<SessionKey, f64> = HashMap::new();
    let mut unpriced = BTreeSet::new();
    let mut total_cost = 0.0;
    let mut overlapping = false;

    for turn in &turns {
        total_cost += turn.cost;
        let key: SessionKey = (turn.kind.clone(), turn.session_id.clone());
        session_rework.insert(key.clone(), turn.rework);
        if let Some(model) = &turn.model {
            if prices.lookup(model).is_none() {
                unpriced.insert(model.clone());
            }
        }

        let keys: Vec<String> = match dimension {
            "model" => vec![turn.family.clone().unwrap_or_else(|| "(unknown)".into())],
            "project" => vec![turn
                .project_label
                .clone()
                .unwrap_or_else(|| "(unknown)".into())],
            "branch" => vec![turn.branch.clone().unwrap_or_else(|| "(none)".into())],
            "effort" => vec![turn.effort.clone().unwrap_or_else(|| "(none)".into())],
            "origin" => vec![turn.origin.clone().unwrap_or_else(|| "unknown".into())],
            "title" => vec![turn.goal_key.clone().unwrap_or_else(|| "(untitled)".into())],
            "agent" => {
                let names = parse_json_array(turn.agent_names.as_deref());
                if names.len() > 1 {
                    overlapping = true;
                }
                if names.is_empty() {
                    vec!["(main)".to_string()]
                } else {
                    names
                }
            }
            _ => vec!["(all)".to_string()],
        };

        for group in keys {
            groups.entry(group.clone()).or_default().add(turn);
            sessions.entry(group).or_default().insert(key.clone());
        }
    }

    let mut rows: Vec<BreakdownRow> = groups
        .into_iter()
        .map(|(key, acc)| {
            let session_keys = sessions.get(&key).cloned().unwrap_or_default();
            let rework = if session_keys.is_empty() {
                0.0
            } else {
                session_keys
                    .iter()
                    .filter_map(|item| session_rework.get(item))
                    .sum::<f64>()
                    / session_keys.len() as f64
            };
            BreakdownRow {
                key,
                sessions: session_keys.len() as i64,
                turns: acc.turns,
                input: acc.input,
                output: acc.output,
                cache_read: acc.cache_read,
                cache_write: acc.cache_write,
                cost_usd: acc.cost,
                share_pct: if total_cost > 0.0 {
                    acc.cost / total_cost * 100.0
                } else {
                    0.0
                },
                cache_hit_rate: acc.cache_hit_rate(),
                avg_rework: rework,
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.key.cmp(&b.key))
    });

    Ok(BreakdownReport {
        range: RangeOut {
            from: resolved.from,
            to: resolved.to,
            label,
        },
        dimension: dimension.to_string(),
        rows,
        overlapping,
        price_source: prices.source_summary(),
        unpriced_models: unpriced.into_iter().collect(),
        cost_note: COST_NOTE.to_string(),
    })
}

// ---------------------------------------------------------------------------
// ailog_models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ModelsOptions {
    pub granularity: String,
    pub bucket: String,
}

impl Default for ModelsOptions {
    fn default() -> Self {
        Self {
            granularity: "family".to_string(),
            bucket: "day".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSeriesEntry {
    pub model: String,
    pub cost_usd: f64,
    pub tokens: i64,
    pub sessions: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSeriesBucket {
    pub bucket: i64,
    pub per_model: Vec<ModelSeriesEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    pub from: String,
    pub to: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagModelEntry {
    pub model: String,
    pub sessions: i64,
    pub turns: i64,
    pub cost_usd: f64,
    pub ingest_cost: f64,
    pub generate_cost: f64,
    pub avg_rework: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTagRow {
    pub work_tag: String,
    pub per_model: Vec<TagModelEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsReport {
    pub range: RangeOut,
    pub granularity: String,
    pub rows: Vec<ModelRow>,
    pub series: Vec<ModelSeriesBucket>,
    pub mixed_sessions: i64,
    pub handoffs: Vec<Handoff>,
    pub by_work_tag: Vec<WorkTagRow>,
    /// Work tags are not exclusive: one session can carry several, so costs
    /// summed across tags exceed the total. Never pro-rated.
    pub overlapping: bool,
    pub total_sessions: i64,
    pub price_source: String,
    pub unpriced_models: Vec<String>,
    pub cost_note: String,
}

pub fn models(
    conn: &Connection,
    range: &Range,
    filters: &Filters,
    options: &ModelsOptions,
    now_ms: i64,
) -> Result<ModelsReport, String> {
    let (resolved, label) = range.resolve(now_ms);
    let prices = PriceTable::load(conn)?;
    let turns = read_turns(conn, &resolved, filters, false)?;
    let pass = run_pass(&turns, &prices);
    let rows = build_model_rows(&pass, &options.granularity, &prices);

    let mut series_map: BTreeMap<i64, BTreeMap<String, TokenAcc>> = BTreeMap::new();
    let mut series_sessions: BTreeMap<(i64, String), HashSet<SessionKey>> = BTreeMap::new();
    for turn in &turns {
        let name = if options.granularity == "raw" {
            turn.model.clone()
        } else {
            turn.family.clone()
        };
        let Some(name) = name else { continue };
        let bucket = bucket_start(turn.ts, &options.bucket);
        series_map
            .entry(bucket)
            .or_default()
            .entry(name.clone())
            .or_default()
            .add(turn);
        series_sessions
            .entry((bucket, name))
            .or_default()
            .insert((turn.kind.clone(), turn.session_id.clone()));
    }

    let series = series_map
        .into_iter()
        .map(|(bucket, per_model)| ModelSeriesBucket {
            bucket,
            per_model: per_model
                .into_iter()
                .map(|(model, acc)| ModelSeriesEntry {
                    cost_usd: acc.cost,
                    tokens: acc.input + acc.output + acc.cache_read + acc.cache_write,
                    sessions: series_sessions
                        .get(&(bucket, model.clone()))
                        .map(|set| set.len() as i64)
                        .unwrap_or(0),
                    model,
                })
                .collect(),
        })
        .collect();

    // A model change between consecutive turns of one session is a hand-off.
    // Counted at the requested granularity so a terra -> sol switch is visible
    // in `raw` mode even though both share the `gpt-5.6` family. Counts only;
    // no claim about whether the switch helped.
    let mut handoff_counts: BTreeMap<(String, String), i64> = BTreeMap::new();
    let mut last_seen: HashMap<SessionKey, String> = HashMap::new();
    for turn in &turns {
        let name = if options.granularity == "raw" {
            turn.model.clone()
        } else {
            turn.family.clone()
        };
        let Some(name) = name else { continue };
        let key: SessionKey = (turn.kind.clone(), turn.session_id.clone());
        match last_seen.get(&key) {
            Some(previous) if previous != &name => {
                *handoff_counts
                    .entry((previous.clone(), name.clone()))
                    .or_insert(0) += 1;
            }
            _ => {}
        }
        last_seen.insert(key, name);
    }

    let mut handoffs: Vec<Handoff> = handoff_counts
        .iter()
        .map(|((from, to), count)| Handoff {
            from: from.clone(),
            to: to.clone(),
            count: *count,
        })
        .collect();
    handoffs.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.from.cmp(&b.from)));

    let mut tags: BTreeMap<String, Vec<TagModelEntry>> = BTreeMap::new();
    for ((tag, model), acc) in &pass.tag_model {
        let keys = pass
            .tag_model_sessions
            .get(&(tag.clone(), model.clone()))
            .cloned()
            .unwrap_or_default();
        tags.entry(tag.clone()).or_default().push(TagModelEntry {
            model: model.clone(),
            sessions: keys.len() as i64,
            turns: acc.turns,
            cost_usd: acc.cost,
            ingest_cost: acc.ingest,
            generate_cost: acc.generate,
            avg_rework: avg_rework(&pass.sessions, &keys),
        });
    }
    let by_work_tag = tags
        .into_iter()
        .map(|(work_tag, mut per_model)| {
            per_model.sort_by(|a, b| {
                b.cost_usd
                    .partial_cmp(&a.cost_usd)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            WorkTagRow {
                work_tag,
                per_model,
            }
        })
        .collect();

    Ok(ModelsReport {
        range: RangeOut {
            from: resolved.from,
            to: resolved.to,
            label,
        },
        granularity: options.granularity.clone(),
        rows,
        series,
        mixed_sessions: pass
            .sessions
            .values()
            .filter(|session| session.families.len() >= 2)
            .count() as i64,
        handoffs,
        by_work_tag,
        overlapping: true,
        total_sessions: pass.sessions.len() as i64,
        price_source: prices.source_summary(),
        unpriced_models: pass.unpriced.iter().cloned().collect(),
        cost_note: COST_NOTE.to_string(),
    })
}

// ---------------------------------------------------------------------------
// ailog_sessions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct SessionsOptions {
    pub sort: String,
    pub limit: i64,
    pub offset: i64,
}

impl Default for SessionsOptions {
    fn default() -> Self {
        Self {
            sort: "cost".to_string(),
            limit: 50,
            offset: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub kind: String,
    pub session_id: String,
    pub title: Option<String>,
    pub project_label: Option<String>,
    pub git_branch: Option<String>,
    pub origin: Option<String>,
    pub primary_model: Option<String>,
    pub model_count: i64,
    pub is_sidechain: bool,
    pub work_tags: Vec<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub wall_ms: Option<i64>,
    pub active_ms: Option<i64>,
    pub turn_count: i64,
    pub user_msg_count: i64,
    pub compact_count: i64,
    pub cost_usd: f64,
    pub rework_score: f64,
    pub goal_summary: Option<String>,
    pub goal_cluster: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsReport {
    pub range: RangeOut,
    pub rows: Vec<SessionRow>,
    pub total: i64,
    pub price_source: String,
    pub cost_note: String,
}

pub fn sessions(
    conn: &Connection,
    range: &Range,
    filters: &Filters,
    options: &SessionsOptions,
    now_ms: i64,
) -> Result<SessionsReport, String> {
    let (resolved, label) = range.resolve(now_ms);
    let prices = PriceTable::load(conn)?;
    let turns = read_turns(conn, &resolved, filters, false)?;
    let pass = run_pass(&turns, &prices);

    let mut keys: Vec<SessionKey> = pass.sessions.keys().cloned().collect();
    let sort = options.sort.as_str();
    keys.sort_by(|a, b| {
        let left = &pass.sessions[a];
        let right = &pass.sessions[b];
        match sort {
            "recent" => right
                .tokens
                .last_used
                .unwrap_or(0)
                .cmp(&left.tokens.last_used.unwrap_or(0)),
            "turns" => right.tokens.turns.cmp(&left.tokens.turns),
            "rework" => right
                .rework
                .partial_cmp(&left.rework)
                .unwrap_or(std::cmp::Ordering::Equal),
            _ => right
                .tokens
                .cost
                .partial_cmp(&left.tokens.cost)
                .unwrap_or(std::cmp::Ordering::Equal),
        }
    });

    let total = keys.len() as i64;
    let offset = options.offset.max(0) as usize;
    let limit = options.limit.max(0) as usize;
    let page: Vec<SessionKey> = keys.into_iter().skip(offset).take(limit).collect();

    let mut rows = Vec::with_capacity(page.len());
    for key in page {
        let row = conn
            .query_row(
                "SELECT ai_title, first_prompt, project_label, git_branch, origin, \
                 primary_model, model_count, is_sidechain, work_tags, started_at, ended_at, \
                 wall_ms, active_ms, turn_count, user_msg_count, compact_count, cost_usd, \
                 goal_summary, goal_cluster \
                 FROM session WHERE kind = ?1 AND session_id = ?2",
                rusqlite::params![key.0, key.1],
                |row| {
                    Ok(SessionRow {
                        kind: key.0.clone(),
                        session_id: key.1.clone(),
                        title: row
                            .get::<_, Option<String>>(0)?
                            .or(row.get::<_, Option<String>>(1)?),
                        project_label: row.get(2)?,
                        git_branch: row.get(3)?,
                        origin: row.get(4)?,
                        primary_model: row.get(5)?,
                        model_count: row.get(6)?,
                        is_sidechain: row.get::<_, i64>(7)? != 0,
                        work_tags: parse_json_array(row.get::<_, Option<String>>(8)?.as_deref()),
                        started_at: row.get(9)?,
                        ended_at: row.get(10)?,
                        wall_ms: row.get(11)?,
                        active_ms: row.get(12)?,
                        turn_count: row.get(13)?,
                        user_msg_count: row.get(14)?,
                        compact_count: row.get(15)?,
                        cost_usd: row.get(16)?,
                        rework_score: 0.0,
                        goal_summary: row.get(17)?,
                        goal_cluster: row.get(18)?,
                    })
                },
            )
            .map_err(|err| format!("read session row: {err}"))?;
        let mut row = row;
        row.rework_score = pass.sessions.get(&key).map(|s| s.rework).unwrap_or(0.0);
        rows.push(row);
    }

    Ok(SessionsReport {
        range: RangeOut {
            from: resolved.from,
            to: resolved.to,
            label,
        },
        rows,
        total,
        price_source: prices.source_summary(),
        cost_note: COST_NOTE.to_string(),
    })
}

// ---------------------------------------------------------------------------
// ailog_session_detail
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestSide {
    pub tokens: i64,
    pub cost_usd: f64,
    pub input: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSide {
    pub tokens: i64,
    pub cost_usd: f64,
    pub output: i64,
    pub reasoning: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IoChars {
    pub read: i64,
    pub exec: i64,
    pub write: i64,
    pub fetch: i64,
    pub prompt: i64,
    pub other: i64,
    /// Marks the block as a character count, never converted to tokens.
    pub estimation: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IoFiles {
    pub read_files: i64,
    pub written_files: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCostBreakdown {
    pub ingest: IngestSide,
    pub generate: GenerateSide,
    pub ingest_ratio: f64,
    pub cache_hit_rate: f64,
    pub io_chars: IoChars,
    pub io_files: IoFiles,
    pub note: String,
}

pub const BREAKDOWN_NOTE: &str =
    "Ingest cost covers everything sent to the model — conversation history, \
     system prompt, file contents and tool results — so it is an upper bound on \
     reading cost, not reading cost itself. The character counts are a separate \
     estimate and are never converted to tokens.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnDetail {
    pub seq: i64,
    pub request_id: Option<String>,
    pub ts: i64,
    pub model: Option<String>,
    pub model_family: Option<String>,
    pub effort: Option<String>,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub reasoning: i64,
    pub duration_ms: Option<i64>,
    pub tool_calls: i64,
    pub tool_errors: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSummary {
    pub name: String,
    pub calls: i64,
    pub errors: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReworkDetail {
    pub tool_error_count: i64,
    pub tool_call_count: i64,
    pub tool_error_rate: f64,
    pub correction_hits: i64,
    pub max_file_edits: i64,
    pub churn_files: i64,
    pub retry_bash: i64,
    pub abandoned: bool,
    pub score: f64,
    pub score_note: String,
}

pub const SCORE_NOTE: &str =
    "score is a 0-100 composite for relative comparison between sessions, not an \
     absolute quality judgement.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRow {
    pub created_at: i64,
    pub model_used: Option<String>,
    pub findings: Option<String>,
    pub rework_note: Option<String>,
    pub cost_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session: SessionRow,
    pub cwd: Option<String>,
    pub ai_title: Option<String>,
    pub first_prompt: Option<String>,
    pub goal_key: Option<String>,
    pub agent_names: Vec<String>,
    pub cli_version: Option<String>,
    pub plan_type: Option<String>,
    pub turns: Vec<TurnDetail>,
    pub tools: Vec<ToolSummary>,
    pub rework: ReworkDetail,
    pub cost_breakdown: SessionCostBreakdown,
    pub summary: Option<SummaryRow>,
    pub price_source: String,
    pub unpriced_models: Vec<String>,
    pub cost_note: String,
}

pub fn session_detail(
    conn: &Connection,
    kind: &str,
    session_id: &str,
) -> Result<SessionDetail, String> {
    let prices = PriceTable::load(conn)?;

    let (
        ai_title,
        first_prompt,
        project_label,
        git_branch,
        origin,
        primary_model,
        model_count,
        is_sidechain,
        work_tags,
        started_at,
        ended_at,
        wall_ms,
        active_ms,
        turn_count,
        user_msg_count,
        compact_count,
        cost_usd,
        cwd,
        goal_key,
        agent_names,
        cli_version,
        plan_type,
        read_chars,
        exec_chars,
        write_chars,
        fetch_chars,
        other_chars,
        prompt_chars,
        read_files,
        written_files,
        goal_summary,
        goal_cluster,
    ) = conn
        .query_row(
            "SELECT ai_title, first_prompt, project_label, git_branch, origin, primary_model, \
             model_count, is_sidechain, work_tags, started_at, ended_at, wall_ms, active_ms, \
             turn_count, user_msg_count, compact_count, cost_usd, cwd, goal_key, agent_names, \
             cli_version, plan_type, read_chars, exec_chars, write_chars, fetch_chars, \
             other_chars, prompt_chars, read_files, written_files, goal_summary, goal_cluster \
             FROM session WHERE kind = ?1 AND session_id = ?2",
            rusqlite::params![kind, session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)? != 0,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                    row.get::<_, Option<i64>>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                    row.get::<_, i64>(13)?,
                    row.get::<_, i64>(14)?,
                    row.get::<_, i64>(15)?,
                    row.get::<_, f64>(16)?,
                    row.get::<_, Option<String>>(17)?,
                    row.get::<_, Option<String>>(18)?,
                    row.get::<_, Option<String>>(19)?,
                    row.get::<_, Option<String>>(20)?,
                    row.get::<_, Option<String>>(21)?,
                    row.get::<_, i64>(22)?,
                    row.get::<_, i64>(23)?,
                    row.get::<_, i64>(24)?,
                    row.get::<_, i64>(25)?,
                    row.get::<_, i64>(26)?,
                    row.get::<_, i64>(27)?,
                    row.get::<_, i64>(28)?,
                    row.get::<_, i64>(29)?,
                    row.get::<_, Option<String>>(30)?,
                    row.get::<_, Option<String>>(31)?,
                ))
            },
        )
        .map_err(|err| format!("session {kind}/{session_id} not found: {err}"))?;

    let mut turns = Vec::new();
    let mut unpriced = BTreeSet::new();
    let mut ingest = IngestSide {
        tokens: 0,
        cost_usd: 0.0,
        input: 0,
        cache_read: 0,
        cache_write: 0,
    };
    let mut generate = GenerateSide {
        tokens: 0,
        cost_usd: 0.0,
        output: 0,
        reasoning: 0,
    };
    {
        let mut stmt = conn
            .prepare(
                "SELECT seq, request_id, ts, model, model_family, effort, input_tokens, \
                 output_tokens, cache_read_tokens, cache_write_5m_tokens, \
                 cache_write_1h_tokens, reasoning_tokens, duration_ms, tool_calls, \
                 tool_errors, cost_usd, ingest_cost_usd, generate_cost_usd \
                 FROM turn WHERE kind = ?1 AND session_id = ?2 ORDER BY seq",
            )
            .map_err(|err| format!("prepare turns: {err}"))?;
        let rows = stmt
            .query_map(rusqlite::params![kind, session_id], |row| {
                let cache_write = row.get::<_, i64>(9)? + row.get::<_, i64>(10)?;
                Ok((
                    TurnDetail {
                        seq: row.get(0)?,
                        request_id: row.get(1)?,
                        ts: row.get(2)?,
                        model: row.get(3)?,
                        model_family: row.get(4)?,
                        effort: row.get(5)?,
                        input: row.get(6)?,
                        output: row.get(7)?,
                        cache_read: row.get(8)?,
                        cache_write,
                        reasoning: row.get(11)?,
                        duration_ms: row.get(12)?,
                        tool_calls: row.get(13)?,
                        tool_errors: row.get(14)?,
                        cost_usd: row.get(15)?,
                    },
                    row.get::<_, f64>(16)?,
                    row.get::<_, f64>(17)?,
                ))
            })
            .map_err(|err| format!("read turns: {err}"))?;
        for row in rows {
            let (turn, ingest_cost, generate_cost) = row.map_err(|err| format!("turn: {err}"))?;
            if let Some(model) = &turn.model {
                if prices.lookup(model).is_none() {
                    unpriced.insert(model.clone());
                }
            }
            ingest.input += turn.input;
            ingest.cache_read += turn.cache_read;
            ingest.cache_write += turn.cache_write;
            ingest.cost_usd += ingest_cost;
            generate.output += turn.output;
            generate.reasoning += turn.reasoning;
            generate.cost_usd += generate_cost;
            turns.push(turn);
        }
    }
    ingest.tokens = ingest.input + ingest.cache_read + ingest.cache_write;
    generate.tokens = generate.output;

    let mut tools = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT name, COUNT(*), SUM(is_error) FROM tool_event \
                 WHERE kind = ?1 AND session_id = ?2 GROUP BY name ORDER BY COUNT(*) DESC",
            )
            .map_err(|err| format!("prepare tools: {err}"))?;
        let rows = stmt
            .query_map(rusqlite::params![kind, session_id], |row| {
                Ok(ToolSummary {
                    name: row.get(0)?,
                    calls: row.get(1)?,
                    errors: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                })
            })
            .map_err(|err| format!("read tools: {err}"))?;
        for row in rows {
            tools.push(row.map_err(|err| format!("tool: {err}"))?);
        }
    }

    let rework = conn
        .query_row(
            "SELECT tool_error_count, tool_call_count, tool_error_rate, correction_count, \
             max_file_edits, churn_files, retry_bash, abandoned, score FROM rework \
             WHERE kind = ?1 AND session_id = ?2",
            rusqlite::params![kind, session_id],
            |row| {
                Ok(ReworkDetail {
                    tool_error_count: row.get(0)?,
                    tool_call_count: row.get(1)?,
                    tool_error_rate: row.get(2)?,
                    correction_hits: row.get(3)?,
                    max_file_edits: row.get(4)?,
                    churn_files: row.get(5)?,
                    retry_bash: row.get(6)?,
                    abandoned: row.get::<_, i64>(7)? != 0,
                    score: row.get(8)?,
                    score_note: SCORE_NOTE.to_string(),
                })
            },
        )
        .unwrap_or(ReworkDetail {
            tool_error_count: 0,
            tool_call_count: 0,
            tool_error_rate: 0.0,
            correction_hits: 0,
            max_file_edits: 0,
            churn_files: 0,
            retry_bash: 0,
            abandoned: false,
            score: 0.0,
            score_note: SCORE_NOTE.to_string(),
        });

    let summary = conn
        .query_row(
            "SELECT created_at, model_used, findings, rework_note, cost_note FROM summary \
             WHERE kind = ?1 AND session_id = ?2",
            rusqlite::params![kind, session_id],
            |row| {
                Ok(SummaryRow {
                    created_at: row.get(0)?,
                    model_used: row.get(1)?,
                    findings: row.get(2)?,
                    rework_note: row.get(3)?,
                    cost_note: row.get(4)?,
                })
            },
        )
        .ok();

    let total_cost = ingest.cost_usd + generate.cost_usd;
    let cache_denominator = ingest.tokens;
    let cost_breakdown = SessionCostBreakdown {
        ingest_ratio: if total_cost > 0.0 {
            ingest.cost_usd / total_cost
        } else {
            0.0
        },
        cache_hit_rate: if cache_denominator > 0 {
            ingest.cache_read as f64 / cache_denominator as f64
        } else {
            0.0
        },
        io_chars: IoChars {
            read: read_chars,
            exec: exec_chars,
            write: write_chars,
            fetch: fetch_chars,
            prompt: prompt_chars,
            other: other_chars,
            estimation: "char_count_only".to_string(),
        },
        io_files: IoFiles {
            read_files,
            written_files,
        },
        note: BREAKDOWN_NOTE.to_string(),
        ingest,
        generate,
    };

    Ok(SessionDetail {
        session: SessionRow {
            kind: kind.to_string(),
            session_id: session_id.to_string(),
            title: ai_title.clone().or_else(|| first_prompt.clone()),
            project_label,
            git_branch,
            origin,
            primary_model,
            model_count,
            is_sidechain,
            work_tags: parse_json_array(work_tags.as_deref()),
            started_at,
            ended_at,
            wall_ms,
            active_ms,
            turn_count,
            user_msg_count,
            compact_count,
            cost_usd,
            rework_score: rework.score,
            goal_summary,
            goal_cluster,
        },
        cwd,
        ai_title,
        first_prompt,
        goal_key,
        agent_names: parse_json_array(agent_names.as_deref()),
        cli_version,
        plan_type,
        turns,
        tools,
        rework,
        cost_breakdown,
        summary,
        price_source: prices.source_summary(),
        unpriced_models: unpriced.into_iter().collect(),
        cost_note: COST_NOTE.to_string(),
    })
}

// ---------------------------------------------------------------------------
// ailog_efficiency
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EfficiencyRow {
    pub key: String,
    pub sessions: i64,
    pub turns: i64,
    pub avg_session_cost: f64,
    pub avg_rework: f64,
    pub cache_hit_rate: f64,
    pub output_density: f64,
    pub abandoned_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuantileRow {
    pub quantile: String,
    pub min_turns: i64,
    pub max_turns: i64,
    pub sessions: i64,
    pub avg_cost: f64,
    pub avg_rework: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EfficiencyReport {
    pub range: RangeOut,
    pub by_model: Vec<EfficiencyRow>,
    pub by_effort: Vec<EfficiencyRow>,
    pub by_subagent: Vec<EfficiencyRow>,
    pub by_compaction: Vec<EfficiencyRow>,
    pub turn_quantiles: Vec<QuantileRow>,
    pub price_source: String,
    pub unpriced_models: Vec<String>,
    /// Everything here is a side-by-side comparison. No causal claim is made
    /// or implied by any field.
    pub interpretation_note: String,
    pub cost_note: String,
}

pub const INTERPRETATION_NOTE: &str =
    "These groups are reported side by side. Differences between them are not \
     evidence of cause: a model, effort level or compaction event is chosen for \
     reasons that also affect the work itself.";

fn efficiency_rows(
    groups: BTreeMap<String, (TokenAcc, HashSet<SessionKey>)>,
    sessions: &BTreeMap<SessionKey, SessionAcc>,
) -> Vec<EfficiencyRow> {
    let mut rows: Vec<EfficiencyRow> = groups
        .into_iter()
        .map(|(key, (acc, keys))| {
            let abandoned = keys
                .iter()
                .filter_map(|item| sessions.get(item))
                .filter(|session| session.abandoned)
                .count();
            EfficiencyRow {
                key,
                sessions: keys.len() as i64,
                turns: acc.turns,
                avg_session_cost: if keys.is_empty() {
                    0.0
                } else {
                    acc.cost / keys.len() as f64
                },
                avg_rework: avg_rework(sessions, &keys),
                cache_hit_rate: acc.cache_hit_rate(),
                output_density: acc.output_density(),
                abandoned_rate: if keys.is_empty() {
                    0.0
                } else {
                    abandoned as f64 / keys.len() as f64
                },
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        b.avg_session_cost
            .partial_cmp(&a.avg_session_cost)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.key.cmp(&b.key))
    });
    rows
}

pub fn efficiency(
    conn: &Connection,
    range: &Range,
    filters: &Filters,
    now_ms: i64,
) -> Result<EfficiencyReport, String> {
    let (resolved, label) = range.resolve(now_ms);
    let prices = PriceTable::load(conn)?;
    // Sub-agent comparison needs the sub-agent rows present regardless of the
    // caller's default.
    let mut effective = filters.clone();
    effective.include_sidechain = true;
    let turns = read_turns(conn, &resolved, &effective, true)?;
    let pass = run_pass(&turns, &prices);

    let mut by_model: BTreeMap<String, (TokenAcc, HashSet<SessionKey>)> = BTreeMap::new();
    let mut by_effort: BTreeMap<String, (TokenAcc, HashSet<SessionKey>)> = BTreeMap::new();
    let mut by_subagent: BTreeMap<String, (TokenAcc, HashSet<SessionKey>)> = BTreeMap::new();
    let mut by_compaction: BTreeMap<String, (TokenAcc, HashSet<SessionKey>)> = BTreeMap::new();

    for turn in &turns {
        let key: SessionKey = (turn.kind.clone(), turn.session_id.clone());
        let model = turn.family.clone().unwrap_or_else(|| "(unknown)".into());
        let effort = turn.effort.clone().unwrap_or_else(|| "(none)".into());
        let subagent = if turn.is_sidechain {
            "subagent"
        } else {
            "main"
        };
        let compaction = if turn.compacts > 0 {
            "compacted"
        } else {
            "not-compacted"
        };

        for (map, group) in [
            (&mut by_model, model),
            (&mut by_effort, effort),
            (&mut by_subagent, subagent.to_string()),
            (&mut by_compaction, compaction.to_string()),
        ] {
            let entry = map
                .entry(group)
                .or_insert_with(|| (TokenAcc::default(), HashSet::new()));
            entry.0.add(turn);
            entry.1.insert(key.clone());
        }
    }

    // Session-length quantiles, ranked by turn count.
    let mut lengths: Vec<(i64, f64, f64)> = pass
        .sessions
        .values()
        .map(|session| (session.tokens.turns, session.tokens.cost, session.rework))
        .collect();
    lengths.sort_by_key(|(turns, _, _)| *turns);
    let mut turn_quantiles = Vec::new();
    if !lengths.is_empty() {
        let quartile = (lengths.len() as f64 / 4.0).ceil().max(1.0) as usize;
        for (index, chunk) in lengths.chunks(quartile).enumerate().take(4) {
            let sessions = chunk.len() as f64;
            turn_quantiles.push(QuantileRow {
                quantile: format!("Q{}", index + 1),
                min_turns: chunk.first().map(|item| item.0).unwrap_or(0),
                max_turns: chunk.last().map(|item| item.0).unwrap_or(0),
                sessions: chunk.len() as i64,
                avg_cost: chunk.iter().map(|item| item.1).sum::<f64>() / sessions,
                avg_rework: chunk.iter().map(|item| item.2).sum::<f64>() / sessions,
            });
        }
    }

    Ok(EfficiencyReport {
        range: RangeOut {
            from: resolved.from,
            to: resolved.to,
            label,
        },
        by_model: efficiency_rows(by_model, &pass.sessions),
        by_effort: efficiency_rows(by_effort, &pass.sessions),
        by_subagent: efficiency_rows(by_subagent, &pass.sessions),
        by_compaction: efficiency_rows(by_compaction, &pass.sessions),
        turn_quantiles,
        price_source: prices.source_summary(),
        unpriced_models: pass.unpriced.iter().cloned().collect(),
        interpretation_note: INTERPRETATION_NOTE.to_string(),
        cost_note: COST_NOTE.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceEntry {
    pub model: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub cache_write_5m_per_mtok: f64,
    pub cache_write_1h_per_mtok: f64,
    pub source: String,
    pub updated_at: i64,
}

pub fn get_prices(conn: &Connection) -> Result<Vec<PriceEntry>, String> {
    let table = PriceTable::load(conn)?;
    Ok(table
        .all()
        .into_iter()
        .map(|row| PriceEntry {
            model: row.model,
            input_per_mtok: row.price.input,
            output_per_mtok: row.price.output,
            cache_read_per_mtok: row.price.cache_read,
            cache_write_5m_per_mtok: row.price.cache_write_5m,
            cache_write_1h_per_mtok: row.price.cache_write_1h,
            source: row.source,
            updated_at: row.updated_at,
        })
        .collect())
}

/// Upsert one rate as a user override, then re-price the whole database so the
/// stored costs match the table that produced them.
pub fn set_price(conn: &mut Connection, entry: &PriceEntry) -> Result<usize, String> {
    conn.execute(
        "INSERT INTO price (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, \
         cache_write_5m_per_mtok, cache_write_1h_per_mtok, source, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'user', ?7) \
         ON CONFLICT(model) DO UPDATE SET input_per_mtok=excluded.input_per_mtok, \
         output_per_mtok=excluded.output_per_mtok, \
         cache_read_per_mtok=excluded.cache_read_per_mtok, \
         cache_write_5m_per_mtok=excluded.cache_write_5m_per_mtok, \
         cache_write_1h_per_mtok=excluded.cache_write_1h_per_mtok, \
         source='user', updated_at=excluded.updated_at",
        rusqlite::params![
            entry.model,
            entry.input_per_mtok,
            entry.output_per_mtok,
            entry.cache_read_per_mtok,
            entry.cache_write_5m_per_mtok,
            entry.cache_write_1h_per_mtok,
            chrono::Utc::now().timestamp_millis(),
        ],
    )
    .map_err(|err| format!("upsert price: {err}"))?;
    crate::ailog::index::reprice_all(conn)
}

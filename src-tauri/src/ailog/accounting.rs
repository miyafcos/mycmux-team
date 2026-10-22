//! Usage identity is independent of source occurrence and display ancestry.
use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{rollup, SessionChunk, TurnRow, KIND_CODEX};

pub const STATE_VERSION: i64 = 2;
pub type Touched = HashSet<(String, String)>;

pub fn key(prefix: &str, value: &impl Serialize) -> String {
    let bytes = serde_json::to_vec(value).expect("serializable usage identity");
    format!("{prefix}:{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone)]
pub struct Occurrence {
    pub line: u64,
    pub event_id: Option<String>,
    pub execution_key: Option<String>,
    pub ts: i64,
    pub decision: String,
    /// Structural fields only; never message text or tool arguments.
    pub evidence: Value,
}

pub fn migrate(conn: &Connection) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (table, column, definition) in [
        ("session", "parent_kind", "TEXT"),
        ("session", "parent_session_id", "TEXT"),
        (
            "session",
            "relationship_type",
            "TEXT NOT NULL DEFAULT 'unknown'",
        ),
        ("session", "lineage_state", "TEXT NOT NULL DEFAULT 'legacy'"),
        ("turn", "execution_key", "TEXT"),
        ("turn", "cost_owner_session_id", "TEXT"),
        ("turn", "usage_state", "TEXT NOT NULL DEFAULT 'legacy'"),
    ] {
        let present = tx
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
            .iter()
            .any(|name| name == column);
        if !present {
            tx.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|e| format!("add {table}.{column}: {e}"))?;
        }
    }
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS ix_session_parent_v3
           ON session(parent_kind,parent_session_id,relationship_type);
         CREATE INDEX IF NOT EXISTS ix_turn_execution_v3 ON turn(kind,execution_key);
         CREATE UNIQUE INDEX IF NOT EXISTS ux_turn_canonical_execution
           ON turn(kind,execution_key)
           WHERE usage_state='canonical' AND execution_key IS NOT NULL;
         CREATE TABLE IF NOT EXISTS usage_occurrence (
           kind TEXT NOT NULL, source_path TEXT NOT NULL, source_generation TEXT NOT NULL,
           source_line INTEGER NOT NULL, source_event_id TEXT, source_session_id TEXT,
           execution_key TEXT, observed_ts INTEGER, decision TEXT NOT NULL, evidence_json TEXT,
           PRIMARY KEY(kind,source_path,source_generation,source_line));
         CREATE INDEX IF NOT EXISTS ix_usage_occurrence_session
           ON usage_occurrence(kind,source_session_id,execution_key);
         CREATE INDEX IF NOT EXISTS ix_usage_occurrence_execution
           ON usage_occurrence(kind,execution_key);
         CREATE TABLE IF NOT EXISTS usage_checkpoint (
           kind TEXT NOT NULL, source_path TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
           parsed_bytes INTEGER NOT NULL, state_version INTEGER NOT NULL, state_json TEXT NOT NULL,
           PRIMARY KEY(kind,source_path));
         CREATE TABLE IF NOT EXISTS session_identity_alias (
           kind TEXT NOT NULL, legacy_session_id TEXT NOT NULL, execution_session_id TEXT NOT NULL,
           source_path TEXT NOT NULL,
           PRIMARY KEY(kind,legacy_session_id,execution_session_id,source_path));
         CREATE INDEX IF NOT EXISTS ix_session_identity_alias_source
           ON session_identity_alias(kind,source_path);
         CREATE TABLE IF NOT EXISTS usage_repair_group (
           kind TEXT NOT NULL, session_id TEXT NOT NULL, signature TEXT NOT NULL,
           version INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,session_id));
         CREATE TABLE IF NOT EXISTS rollup_turn_session_day_v2 (
           day INTEGER NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL,
           model TEXT NOT NULL DEFAULT '', model_family TEXT NOT NULL DEFAULT '',
           effort TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'unknown',
           relationship_type TEXT NOT NULL DEFAULT 'unknown', usage_state TEXT NOT NULL,
           turns INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
           output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
           cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
           cost_usd REAL NOT NULL DEFAULT 0, ingest_cost_usd REAL NOT NULL DEFAULT 0,
           generate_cost_usd REAL NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
           timed_turns INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
           tool_errors INTEGER NOT NULL DEFAULT 0, first_ts INTEGER, last_ts INTEGER,
           PRIMARY KEY(day,kind,session_id,model,model_family,effort,origin,relationship_type,usage_state));
         CREATE INDEX IF NOT EXISTS ix_rollup_v2_session
           ON rollup_turn_session_day_v2(kind,session_id);"
    ).map_err(|e| format!("usage accounting schema: {e}"))?;
    tx.commit().map_err(|e| e.to_string())
}

/// Additive repair metadata is also installed on already-v3 caches.
pub fn migrate_r2(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS usage_repair_failure (
        kind TEXT NOT NULL, session_id TEXT NOT NULL, signature TEXT NOT NULL,
        version INTEGER NOT NULL, error TEXT NOT NULL, PRIMARY KEY(kind,session_id));
      CREATE TABLE IF NOT EXISTS usage_legacy_classification (
        kind TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        decision TEXT NOT NULL, reason TEXT NOT NULL, representative_session_id TEXT,
        representative_seq INTEGER, execution_key TEXT, source_path TEXT, source_line INTEGER,
        PRIMARY KEY(kind,session_id,seq));
      CREATE INDEX IF NOT EXISTS ix_turn_native_usage_v3 ON turn(kind,request_id,usage_state);")
        .map_err(|e|e.to_string())
}

pub fn record_occurrences(
    conn: &Connection,
    chunk: &SessionChunk,
    path: &str,
    generation: &str,
    offset: u64,
) -> Result<(), String> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO usage_occurrence(kind,source_path,source_generation,source_line,
         source_event_id,source_session_id,execution_key,observed_ts,decision,evidence_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,
           CASE WHEN ?9='canonical' AND EXISTS (SELECT 1 FROM turn WHERE kind=?1 AND execution_key=?7
             AND usage_state='canonical' AND session_id!=?6) THEN 'replay' ELSE ?9 END,?10)
         ON CONFLICT(kind,source_path,source_generation,source_line) DO UPDATE SET
         execution_key=excluded.execution_key, decision=excluded.decision,
         evidence_json=excluded.evidence_json"
    ).map_err(|e| e.to_string())?;
    for occurrence in &chunk.occurrences {
        stmt.execute(params![
            chunk.kind,
            path,
            generation,
            (offset + occurrence.line) as i64,
            occurrence.event_id,
            chunk.session_id,
            occurrence.execution_key,
            occurrence.ts,
            occurrence.decision,
            occurrence.evidence.to_string()
        ])
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resolve copies globally before inserting a priced turn. Snapshot counters
/// come from one winning observation, rather than summing streaming snapshots.
pub fn claim_turn(
    tx: &Transaction<'_>,
    chunk: &SessionChunk,
    turn: &mut TurnRow,
    touched: &mut Touched,
) -> Result<bool, String> {
    let Some(execution) = turn.execution_key.as_deref() else {
        return Ok(true);
    };
    if turn.usage_state.as_deref() != Some("canonical") {
        return Ok(true);
    }
    let stored_key: Option<String> = tx.query_row(
        "SELECT request_id FROM turn WHERE kind=?1 AND session_id=?2 AND execution_key=?3 AND usage_state='canonical'",
        params![chunk.kind,chunk.session_id,execution],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(stored_key)=stored_key {
        turn.dedup_key=stored_key;
    } else {
        let collision: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM turn WHERE kind=?1 AND session_id=?2
            AND request_id=?3 AND execution_key IS NOT ?4)",
            params![chunk.kind,chunk.session_id,turn.dedup_key,execution],|r|r.get(0)).map_err(|e|e.to_string())?;
        if collision { turn.dedup_key=execution.to_string(); }
    }
    let previous: Option<(String, i64, i64, i64, bool, Option<String>)> = tx
        .query_row(
            "SELECT t.session_id,t.seq,t.output_tokens,t.ts,s.is_sidechain,t.model FROM turn t
         JOIN session s ON s.kind=t.kind AND s.session_id=t.session_id
         WHERE t.kind=?1 AND t.execution_key=?2 AND t.usage_state='canonical'",
            params![chunk.kind, execution],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((owner, seq, output, ts, sidechain, previous_model)) = previous else {
        return Ok(true);
    };
    if owner == chunk.session_id {
        return Ok(true);
    }
    if turn.model.is_none() {
        turn.model = previous_model.clone();
    }
    rollup::mark_session_dirty(tx, chunk.kind, &owner)?;
    touched.insert((chunk.kind.to_string(), owner.clone()));
    if previous_model.is_none() && turn.model.is_some() {
        tx.execute("UPDATE turn SET model=?4 WHERE kind=?1 AND session_id=?2 AND seq=?3",
            params![chunk.kind,owner,seq,turn.model]).map_err(|e|e.to_string())?;
    }
    // Snapshot timestamps can advance when a copy supplies more output. They
    // must not change the stable representative that owns the cost.
    let new_owner = (chunk.is_sidechain, &chunk.session_id) < (sidechain, &owner);
    if new_owner {
        tx.execute(
            "UPDATE usage_occurrence SET decision='replay' WHERE kind=?1 AND execution_key=?2
            AND source_session_id!=?3",
            params![chunk.kind, execution, chunk.session_id],
        )
        .map_err(|e| e.to_string())?;
        // The snapshot and cost are copied if the newly discovered original
        // has an older (smaller) output snapshot. Ownership is not snapshot order.
        if (turn.output_tokens, turn.ts) < (output, ts) {
            tx.execute(
                "UPDATE turn SET session_id=?3, cost_owner_session_id=?3,request_id=?5,
                 seq=(SELECT COALESCE(MAX(seq),-1)+1 FROM turn WHERE kind=?1 AND session_id=?3)
                 WHERE kind=?1 AND session_id=?2 AND seq=?4",
                params![chunk.kind, owner, chunk.session_id, seq,turn.dedup_key],
            )
            .map_err(|e| e.to_string())?;
            return Ok(false);
        }
        tx.execute(
            "DELETE FROM turn WHERE kind=?1 AND session_id=?2 AND seq=?3",
            params![chunk.kind, owner, seq],
        )
        .map_err(|e| e.to_string())?;
        return Ok(true);
    }
    if (turn.output_tokens, turn.ts) > (output, ts) {
        tx.execute(
            "UPDATE turn SET input_tokens=?4,output_tokens=?5,cache_read_tokens=?6,
             cache_write_5m_tokens=?7,cache_write_1h_tokens=?8,reasoning_tokens=?9,
             ts=?10 WHERE kind=?1 AND session_id=?2 AND seq=?3",
            params![
                chunk.kind,
                owner,
                seq,
                turn.input_tokens,
                turn.output_tokens,
                turn.cache_read_tokens,
                turn.cache_write_5m_tokens,
                turn.cache_write_1h_tokens,
                turn.reasoning_tokens,
                turn.ts
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(false)
}

/// Full provider counters and an epoch survive append boundaries and restarts.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CodexUsageState {
    pub epoch: u64,
    pub total: Option<BTreeMap<String, i64>>,
    pub last: Option<BTreeMap<String, i64>>,
    pub seen: BTreeMap<String, String>,
    #[serde(rename = "seen_responses")]
    pub seen_responses: BTreeMap<String, String>,
    #[serde(rename = "turn_id")]
    pub turn_id: Option<String>,
    #[serde(rename = "event_index")]
    pub event_index: u64,
}

pub fn counters(value: &Value) -> Option<BTreeMap<String, i64>> {
    value.as_object().map(|v| {
        v.iter()
            .filter_map(|(k, v)| v.as_i64().map(|n| (k.clone(), n.max(0))))
            .collect()
    })
}

impl CodexUsageState {
    pub fn observe(
        &mut self,
        session: &str,
        info: &Value,
        payload: &Value,
        ts: i64,
        ordinal: i64,
    ) -> Option<(String, String, Value)> {
        let last = counters(info.get("last_token_usage")?)?;
        let raw_total = info.get("total_token_usage").and_then(counters);
        let total = raw_total.clone().filter(|v| v.values().any(|n| *n > 0));
        self.event_index += 1;
        let zero = [
            "input_tokens",
            "output_tokens",
            "cached_input_tokens",
            "cache_write_input_tokens",
        ]
        .iter()
        .all(|field| last.get(*field).copied().unwrap_or(0) == 0);
        let native = payload
            .get("response_id")
            .or_else(|| info.get("response_id"))
            .and_then(Value::as_str);
        let rollback = total
            .as_ref()
            .zip(self.total.as_ref())
            .is_some_and(|(now, previous)| {
                now.get("total_tokens")
                    .zip(previous.get("total_tokens"))
                    .is_some_and(|(a, b)| a < b)
                    || ["input_tokens", "output_tokens"].iter().any(|field| {
                        now.get(*field)
                            .zip(previous.get(*field))
                            .is_some_and(|(a, b)| a < b)
                    })
            });
        let zero_reset = zero
            && raw_total
                .as_ref()
                .is_some_and(|v| v.get("total_tokens") == Some(&0))
            && self
                .total
                .as_ref()
                .is_some_and(|v| v.values().any(|n| *n > 0));
        if rollback && !zero || zero_reset {
            self.epoch += 1;
            self.seen.clear();
            self.seen_responses.clear();
        }
        let evidence = serde_json::json!({"total":raw_total,"last":last,"epoch":self.epoch,
            "turn_id":self.turn_id,"response_id":native,"ordinal":ordinal});
        if zero {
            self.last = Some(last);
            if zero_reset || total.is_some() {
                self.total = raw_total;
            }
            return Some((
                key("codex-zero", &(session, self.epoch, self.event_index)),
                "zero".into(),
                evidence,
            ));
        }
        let signature = key("usage", &(&total, &last));
        let usable_total = total.is_some();
        let repeated = usable_total
            .then(|| self.seen.get(&signature))
            .flatten()
            .cloned();
        let conflicting_response = repeated.is_some() && native.zip(self.seen_responses.get(&signature))
            .is_some_and(|(now, previous)| now != previous);
        let advanced = total
            .as_ref()
            .zip(self.total.as_ref())
            .is_some_and(|(now, previous)| {
                now.iter()
                    .any(|(field, n)| *n > previous.get(field).copied().unwrap_or(0))
            });
        // A logical turn can contain multiple API responses. Without totals,
        // only an explicit response identity proves a distinct execution.
        let proven =
            usable_total && (self.total.is_none() || advanced || rollback) || native.is_some();
        let execution = if conflicting_response {
            key("codex-unresolved-native", &(session, self.epoch, &signature, native))
        } else { repeated.clone().unwrap_or_else(|| {
            if proven {
                key(
                    "codex-exec",
                    &(
                        session,
                        self.epoch,
                        &total,
                        &last,
                        (!usable_total).then_some((&self.turn_id, native)),
                    ),
                )
            } else {
                key(
                    "codex-unresolved",
                    &(session, self.epoch, self.event_index, ts, ordinal, &last),
                )
            }
        })
        };
        let decision = if conflicting_response {
            "unresolved"
        } else if repeated.is_some() {
            "replay"
        } else if proven {
            "canonical"
        } else {
            "unresolved"
        };
        if usable_total && !conflicting_response {
            if let Some(native) = native { self.seen_responses.entry(signature.clone()).or_insert_with(||native.to_string()); }
            self.seen.insert(signature, execution.clone());
            self.total = total;
        }
        self.last = Some(last);
        Some((execution, decision.into(), evidence))
    }
}

/// Walk ancestry with a visited set. A fork immediately below a root is a
/// separate execution; forks below a subagent remain part of that subagent.
pub fn inclusive_sessions(
    conn: &Connection,
    kind: &str,
    root: &str,
) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT session_id,parent_session_id,relationship_type FROM session
        WHERE kind=?1 AND parent_kind=?1 AND parent_session_id IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let mut children: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for row in stmt
        .query_map([kind], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
    {
        let (id, parent, relation) = row.map_err(|e| e.to_string())?;
        children.entry(parent).or_default().push((id, relation));
    }
    let mut seen = HashSet::from([root.to_string()]);
    let mut pending = vec![root.to_string()];
    while let Some(parent) = pending.pop() {
        for (child, relation) in children.get(&parent).into_iter().flatten() {
            if relation == "fork" && parent == root {
                continue;
            }
            if seen.insert(child.clone()) {
                pending.push(child.clone());
            }
        }
    }
    Ok(seen)
}

/// Remove a fork's copied prefix only when an ancestor proves the same native
/// turn and the same full usage counters. Missing ancestors never discard data.
pub fn reconcile_codex_copies(tx: &Transaction<'_>, touched: &mut Touched) -> Result<(), String> {
    let parents: HashMap<String, String> = {
        let mut stmt = tx
            .prepare(
                "SELECT session_id,parent_session_id FROM session
            WHERE kind='codex' AND parent_kind='codex' AND parent_session_id IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    if parents.is_empty() {
        return Ok(());
    }
    let mut signatures: HashMap<(String, String), String> = HashMap::new();
    let mut observations = Vec::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT source_session_id,execution_key,evidence_json,source_path,source_generation,decision FROM usage_occurrence
            WHERE kind='codex' AND execution_key IS NOT NULL AND decision!='zero'
            ORDER BY source_session_id,source_path,source_generation,source_line",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (sid, execution, evidence, source, generation, decision) =
                row.map_err(|e| e.to_string())?;
            let evidence: Value = serde_json::from_str(&evidence).map_err(|e| e.to_string())?;
            if evidence.get("turn_id").and_then(Value::as_str).is_none() {
                observations.push((sid, execution, None, source, generation));
                continue;
            }
            let signature = key(
                "fork",
                &(
                    evidence.get("turn_id"),
                    evidence.get("total"),
                    evidence.get("last"),
                ),
            );
            if decision != "replay" {
                signatures.insert((sid.clone(), signature.clone()), execution.clone());
            }
            observations.push((sid, execution, Some(signature), source, generation));
        }
    }
    let mut merged = HashSet::new();
    let mut closed_prefixes = HashSet::new();
    for (sid, execution, signature, source, generation) in observations {
        let source_key = (sid.clone(), source, generation);
        if closed_prefixes.contains(&source_key) {
            continue;
        }
        let Some(signature) = signature else {
            closed_prefixes.insert(source_key);
            continue;
        };
        let mut seen = HashSet::from([sid.clone()]);
        let mut cursor = sid.as_str();
        let mut owner = None;
        let mut path = vec![sid.clone()];
        let mut candidates = vec![(sid.clone(), execution.clone())];
        while let Some(parent) = parents.get(cursor) {
            if !seen.insert(parent.clone()) {
                let start = path.iter().position(|id| id == parent).unwrap_or(0);
                // A malformed cycle has no topmost ancestor. All members
                // choose the same stable survivor, including a copied prefix
                // outside the cycle. Never delete every canonical row.
                owner = candidates
                    .iter()
                    .filter(|(id, _)| path[start..].contains(id))
                    .min()
                    .cloned();
                break;
            }
            path.push(parent.clone());
            if let Some(found) = signatures.get(&(parent.clone(), signature.clone())) {
                owner = Some((parent.clone(), found.clone()));
                candidates.push((parent.clone(), found.clone()));
            }
            cursor = parent;
        }
        let Some((parent, canonical)) = owner else {
            closed_prefixes.insert(source_key);
            continue;
        };
        if canonical == execution || !merged.insert(execution.clone()) {
            continue;
        }
        rollup::mark_session_dirty(tx, KIND_CODEX, &sid)?;
        tx.execute(
            "DELETE FROM turn WHERE kind='codex' AND execution_key=?1 AND usage_state='canonical'",
            [&execution],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("UPDATE usage_occurrence SET execution_key=?2,decision='replay' WHERE kind='codex' AND execution_key=?1",params![execution,canonical]).map_err(|e|e.to_string())?;
        touched.insert((KIND_CODEX.to_string(), sid));
        touched.insert((KIND_CODEX.to_string(), parent));
    }
    Ok(())
}

/// If a prior repair classified an ancestor-like suffix after the child's own
/// usage as a copy, restage just that source family. This also makes repair
/// retries recoverable across an interrupted upgrade of the copy gate.
/// Revisit source-scoped keys that can now use a stable provider message id.
pub fn claude_message_key_repair_sources(conn: &Connection) -> Result<Vec<(String,String)>, String> {
    let mut stmt=conn.prepare("SELECT DISTINCT kind,source_path FROM usage_occurrence
        WHERE kind IN ('claude','claude-codex') AND execution_key GLOB 'claude-uuid:*'
          AND json_extract(evidence_json,'$.message_id') IS NOT NULL")
        .map_err(|e|e.to_string())?;
    let rows=stmt.query_map([],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    rows.collect::<Result<_,_>>().map_err(|e|e.to_string())
}

/// Recover families damaged by an overlapping legacy-id swap. Retry by source:
/// compound family keys need not equal any physical execution session id.
pub fn codex_orphan_repair_sources(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt=conn.prepare("SELECT DISTINCT o.source_path FROM usage_occurrence o
        WHERE o.kind='codex' AND o.decision='canonical' AND o.execution_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM turn t INDEXED BY ux_turn_canonical_execution
            WHERE t.kind='codex' AND t.usage_state='canonical' AND t.execution_key=o.execution_key)")
        .map_err(|e|e.to_string())?;
    let rows=stmt.query_map([],|r|r.get(0)).map_err(|e|e.to_string())?;
    rows.collect::<Result<_,_>>().map_err(|e|e.to_string())
}

pub fn codex_suffix_repair_sources(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt=conn.prepare("WITH own_keys AS MATERIALIZED (
          SELECT session_id,execution_key FROM turn WHERE kind='codex' AND execution_key IS NOT NULL
        ), first_own AS MATERIALIZED (
          SELECT e.source_path,e.source_generation,e.source_session_id,MIN(e.source_line) AS first_line
          FROM own_keys own CROSS JOIN usage_occurrence e INDEXED BY ix_usage_occurrence_session
            WHERE e.kind='codex' AND e.source_session_id=own.session_id AND e.execution_key=own.execution_key
          GROUP BY e.source_path,e.source_generation,e.source_session_id
        ) SELECT DISTINCT o.source_path FROM usage_occurrence o
        JOIN first_own first ON first.source_path=o.source_path AND first.source_generation=o.source_generation
          AND first.source_session_id=o.source_session_id AND first.first_line<o.source_line
        JOIN turn copied ON copied.kind=o.kind AND copied.execution_key=o.execution_key
          AND copied.usage_state='canonical' AND copied.session_id!=o.source_session_id
        WHERE o.kind='codex' AND o.decision='replay'")
        .map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// A failed sibling keeps a whole source family intact. A canonical execution
/// already installed by an earlier pass can still prove an exact legacy copy:
/// same session, native request/message/event, observed time, complete counters,
/// model and saved cost. Remove only that proven old debit; do not restage a
/// partial family or infer anything about unmatched historical rows.
pub fn reconcile_claude_legacy_copies(tx: &Transaction<'_>, touched: &mut Touched) -> Result<(), String> {
    let duplicates: Vec<(String,String,i64)> = {
        let mut stmt=tx.prepare("WITH mixed AS MATERIALIZED (
            SELECT kind,session_id FROM turn WHERE kind IN ('claude','claude-codex')
            GROUP BY kind,session_id HAVING MAX(usage_state='canonical')=1
              AND MAX(usage_state='legacy' AND cost_usd>0)=1)
            SELECT DISTINCT legacy.kind,legacy.session_id,legacy.seq FROM mixed m
            CROSS JOIN turn canonical INDEXED BY ux_turn_request
            CROSS JOIN usage_occurrence e INDEXED BY ix_usage_occurrence_execution
            CROSS JOIN turn legacy INDEXED BY ux_turn_request
            WHERE canonical.kind=m.kind AND canonical.session_id=m.session_id
              AND canonical.usage_state='canonical' AND canonical.execution_key GLOB 'claude-exec:*'
              AND e.kind=canonical.kind AND e.execution_key=canonical.execution_key
              AND legacy.kind=canonical.kind AND legacy.session_id=canonical.session_id
              AND legacy.request_id IN (json_extract(e.evidence_json,'$.request_id'),
                json_extract(e.evidence_json,'$.message_id'),e.source_event_id)
              AND legacy.usage_state='legacy' AND legacy.cost_usd>0
              AND legacy.ts=e.observed_ts AND legacy.model IS canonical.model
              AND ABS(legacy.cost_usd-canonical.cost_usd)<0.000000001
              AND legacy.input_tokens=canonical.input_tokens AND legacy.output_tokens=canonical.output_tokens
              AND legacy.cache_read_tokens=canonical.cache_read_tokens
              AND legacy.cache_write_5m_tokens=canonical.cache_write_5m_tokens
              AND legacy.cache_write_1h_tokens=canonical.cache_write_1h_tokens
              AND legacy.reasoning_tokens=canonical.reasoning_tokens
              AND (legacy.session_id=e.source_session_id
                OR legacy.session_id=json_extract(e.evidence_json,'$.source_session_id')
                OR EXISTS (SELECT 1 FROM session_identity_alias a INDEXED BY ix_session_identity_alias_source
                  WHERE a.kind=e.kind AND a.source_path=e.source_path AND a.legacy_session_id=legacy.session_id))
              AND legacy.input_tokens=COALESCE(json_extract(e.evidence_json,'$.last.input_tokens'),0)
              AND legacy.output_tokens=COALESCE(json_extract(e.evidence_json,'$.last.output_tokens'),0)
              AND legacy.cache_read_tokens=COALESCE(json_extract(e.evidence_json,'$.last.cache_read_input_tokens'),0)
              AND legacy.cache_write_5m_tokens=CASE
                WHEN COALESCE(json_extract(e.evidence_json,'$.last.cache_creation.ephemeral_5m_input_tokens'),0)>0
                  OR COALESCE(json_extract(e.evidence_json,'$.last.cache_creation.ephemeral_1h_input_tokens'),0)>0
                THEN COALESCE(json_extract(e.evidence_json,'$.last.cache_creation.ephemeral_5m_input_tokens'),0)
                ELSE COALESCE(json_extract(e.evidence_json,'$.last.cache_creation_input_tokens'),0) END
              AND legacy.cache_write_1h_tokens=CASE
                WHEN COALESCE(json_extract(e.evidence_json,'$.last.cache_creation.ephemeral_5m_input_tokens'),0)>0
                  OR COALESCE(json_extract(e.evidence_json,'$.last.cache_creation.ephemeral_1h_input_tokens'),0)>0
                THEN COALESCE(json_extract(e.evidence_json,'$.last.cache_creation.ephemeral_1h_input_tokens'),0)
                ELSE 0 END") .map_err(|e|e.to_string())?;
        let rows=stmt.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e|e.to_string())?
    };
    for (kind,sid,seq) in duplicates {
        rollup::mark_session_dirty(tx,&kind,&sid)?;
        tx.execute("DELETE FROM turn WHERE kind=?1 AND session_id=?2 AND seq=?3 AND usage_state='legacy'",
            params![kind,sid,seq]).map_err(|e|e.to_string())?;
        touched.insert((kind,sid));
    }
    Ok(())
}

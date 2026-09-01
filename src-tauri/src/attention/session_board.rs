use std::{
    collections::BTreeSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use chrono::DateTime;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use super::{
    card_id, store, AttentionActor, AttentionCard, AttentionFreshness, AttentionKind, CardState,
    EvidenceRef, PrimaryAction, ReplyRoute, ResolutionPredicate, SessionRef, Severity, Waiting,
};

const CACHE_KEY: &str = "session-board-attention-v1";
const FINGERPRINT_PREFIX: &str = "session-board:";
const INCOMPLETE_FINGERPRINT: &str = "session-board:observation-incomplete";
const INCOMPLETE_OBSERVATION_KEY: &str = "session-board:observation-incomplete";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperatorAttentionSnapshot {
    schema_version: u32,
    snapshot_id: String,
    generated_at: String,
    source_watermark: u64,
    coverage: Coverage,
    items: Vec<SnapshotItem>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Coverage {
    state: CoverageState,
    expected_sessions: u64,
    observed_sessions: u64,
    stale_sessions: u64,
    failed_probes: u64,
    status_untracked_sessions: u64,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum CoverageState {
    Complete,
    Partial,
    Unavailable,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotItem {
    attention_id: String,
    incident_group_id: String,
    kind: String,
    severity: Severity,
    requires_human_action: bool,
    actor: AttentionActor,
    summary: String,
    why_now: String,
    next_action: NextAction,
    affected_lane_ids: Vec<String>,
    evidence_refs: Vec<String>,
    first_seen_at: String,
    last_changed_at: String,
    freshness: AttentionFreshness,
    rank: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NextAction {
    r#type: String,
    label: String,
    target: String,
}

pub(crate) fn sync_default(conn: &Connection, now: i64) -> Result<bool, String> {
    let Some(path) = default_snapshot_path() else {
        return Ok(false);
    };
    sync_path(conn, &path, now)
}

fn default_snapshot_path() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|home| {
            home.join("session-board")
                .join("data")
                .join("attention_snapshot.json")
        })
}

pub(crate) fn sync_path(conn: &Connection, path: &Path, now: i64) -> Result<bool, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return upsert_incomplete(
                conn,
                now,
                "snapshotRead",
                format!("{}: {error}", path.display()),
            );
        }
    };
    let modified_at = modified_at_ns(&metadata).unwrap_or(now);
    let file_length = metadata.len();
    if cached_stamp(conn)? == Some((modified_at, file_length)) {
        return Ok(false);
    }

    let payload = match fs::read(path) {
        Ok(payload) => payload,
        Err(error) => {
            let changed = upsert_incomplete(
                conn,
                now,
                "snapshotRead",
                format!("{}: {error}", path.display()),
            )?;
            save_stamp(conn, modified_at, file_length)?;
            return Ok(changed);
        }
    };
    let snapshot = match serde_json::from_slice::<OperatorAttentionSnapshot>(&payload) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let changed = upsert_incomplete(
                conn,
                now,
                "snapshotDecode",
                format!("{}: {error}", path.display()),
            )?;
            save_stamp(conn, modified_at, file_length)?;
            return Ok(changed);
        }
    };
    let validation = validate_snapshot(&snapshot);
    if let Err(error) = validation {
        let changed = upsert_incomplete(conn, now, "snapshotSchema", error)?;
        save_stamp(conn, modified_at, file_length)?;
        return Ok(changed);
    }
    if snapshot.coverage.state != CoverageState::Complete {
        let detail = format!(
            "coverage={:?}; observed={}/{}; stale={}; failed={}; status_untracked={}",
            snapshot.coverage.state,
            snapshot.coverage.observed_sessions,
            snapshot.coverage.expected_sessions,
            snapshot.coverage.stale_sessions,
            snapshot.coverage.failed_probes,
            snapshot.coverage.status_untracked_sessions,
        );
        let changed = upsert_incomplete(
            conn,
            parse_timestamp_ms(&snapshot.generated_at).unwrap_or(now),
            "snapshotCoverage",
            detail,
        )?;
        save_stamp(conn, modified_at, file_length)?;
        return Ok(changed);
    }

    let cards = snapshot
        .items
        .iter()
        .map(snapshot_item_card)
        .collect::<Result<Vec<_>, _>>();
    let cards = match cards {
        Ok(cards) => cards,
        Err(error) => {
            let changed = upsert_incomplete(conn, now, "snapshotSchema", error)?;
            save_stamp(conn, modified_at, file_length)?;
            return Ok(changed);
        }
    };
    let changed = reconcile_complete(conn, &cards, now)?;
    save_stamp(conn, modified_at, file_length)?;
    Ok(changed)
}

fn validate_snapshot(snapshot: &OperatorAttentionSnapshot) -> Result<(), String> {
    if snapshot.schema_version != 1 {
        return Err(format!(
            "unsupported schema_version {}",
            snapshot.schema_version
        ));
    }
    if !snapshot.snapshot_id.starts_with("snap-") || snapshot.snapshot_id.len() == 5 {
        return Err("snapshot_id must start with snap-".into());
    }
    parse_timestamp_ms(&snapshot.generated_at)?;
    let _ = snapshot.source_watermark;
    let mut incident_groups = BTreeSet::new();
    for item in &snapshot.items {
        validate_item(item)?;
        if !incident_groups.insert(item.incident_group_id.as_str()) {
            return Err(format!(
                "duplicate incident_group_id {}",
                item.incident_group_id
            ));
        }
    }
    Ok(())
}

fn validate_item(item: &SnapshotItem) -> Result<(), String> {
    if !item.attention_id.starts_with("incident-") || item.attention_id.len() == 9 {
        return Err("attention_id must start with incident-".into());
    }
    for (name, value) in [
        ("incident_group_id", item.incident_group_id.as_str()),
        ("kind", item.kind.as_str()),
        ("summary", item.summary.as_str()),
        ("why_now", item.why_now.as_str()),
        ("next_action.type", item.next_action.r#type.as_str()),
        ("next_action.label", item.next_action.label.as_str()),
        ("next_action.target", item.next_action.target.as_str()),
    ] {
        if value.is_empty() || value.contains('\r') || value.contains('\n') {
            return Err(format!("{name} must be one non-empty line"));
        }
    }
    if item.rank == 0 {
        return Err("rank must be at least 1".into());
    }
    if item.evidence_refs.is_empty() {
        return Err("evidence_refs must not be empty".into());
    }
    if item.evidence_refs.iter().any(|value| value.is_empty())
        || item.affected_lane_ids.iter().any(|value| value.is_empty())
    {
        return Err("lane and evidence references must be non-empty".into());
    }
    if item.evidence_refs.iter().collect::<BTreeSet<_>>().len() != item.evidence_refs.len()
        || item.affected_lane_ids.iter().collect::<BTreeSet<_>>().len()
            != item.affected_lane_ids.len()
    {
        return Err("lane and evidence references must be unique".into());
    }
    let first_seen = parse_timestamp_ms(&item.first_seen_at)?;
    let last_changed = parse_timestamp_ms(&item.last_changed_at)?;
    if first_seen > last_changed {
        return Err("first_seen_at must not follow last_changed_at".into());
    }
    Ok(())
}

fn waiting_for(requires_human_action: bool, severity: Severity) -> Waiting {
    if requires_human_action {
        Waiting::Human
    } else if severity == Severity::Advisory {
        Waiting::None
    } else {
        Waiting::Work
    }
}

fn snapshot_item_card(item: &SnapshotItem) -> Result<AttentionCard, String> {
    let fingerprint = format!("session-board:incident:{}", item.incident_group_id);
    let target = identifiable_session(item);
    let action_session = target.clone().unwrap_or_else(|| SessionRef::Logical {
        logical_session_id: item.next_action.target.clone(),
    });
    let reply_route = target
        .clone()
        .map(|session| ReplyRoute::Session { session })
        .unwrap_or(ReplyRoute::None);
    Ok(AttentionCard {
        id: card_id(&fingerprint),
        fingerprint,
        kind: AttentionKind::SessionBoardIncident,
        waiting: waiting_for(item.requires_human_action, item.severity),
        severity: item.severity,
        actor: Some(item.actor),
        freshness: Some(item.freshness),
        source_rank: Some(item.rank),
        workorder_id: None,
        session: target,
        why_now: item.why_now.clone(),
        impact: item.summary.clone(),
        evidence: item.evidence_refs.iter().map(evidence_ref).collect(),
        primary_action: PrimaryAction::OpenSession {
            session: action_session,
        },
        reply_route,
        resolution_predicate: ResolutionPredicate::ObservationMissing {
            observation_key: format!("session-board:{}", item.incident_group_id),
        },
        state: CardState::Open,
        first_seen_at: parse_timestamp_ms(&item.first_seen_at)?,
        last_seen_at: parse_timestamp_ms(&item.last_changed_at)?,
        revision: 1,
        resolved_at: None,
    })
}

fn identifiable_session(item: &SnapshotItem) -> Option<SessionRef> {
    item.affected_lane_ids
        .iter()
        .find(|lane_id| lane_id.starts_with("pty-"))
        .cloned()
        .or_else(|| {
            item.evidence_refs.iter().find_map(|reference| {
                reference
                    .strip_prefix("session:")
                    .filter(|session_id| session_id.starts_with("pty-"))
                    .map(str::to_owned)
            })
        })
        .map(|pty_session_id| SessionRef::Pty { pty_session_id })
        .or_else(|| {
            item.affected_lane_ids
                .first()
                .cloned()
                .map(|logical_session_id| SessionRef::Logical { logical_session_id })
        })
}

fn evidence_ref(reference: &String) -> EvidenceRef {
    let kind = reference
        .split_once(':')
        .map(|(kind, _)| kind)
        .unwrap_or("snapshot");
    EvidenceRef {
        source: "session-board".into(),
        kind: kind.into(),
        ref_id: reference.clone(),
        detail: reference.clone(),
    }
}

fn incomplete_card(now: i64, evidence_kind: &str, detail: String) -> AttentionCard {
    AttentionCard {
        id: card_id(INCOMPLETE_FINGERPRINT),
        fingerprint: INCOMPLETE_FINGERPRINT.into(),
        kind: AttentionKind::SessionBoardIncident,
        waiting: Waiting::Work,
        severity: Severity::Warning,
        actor: None,
        freshness: None,
        source_rank: Some(1),
        workorder_id: None,
        session: None,
        why_now: "調整面のデータが読めません".into(),
        impact: "session-board の観測が不完全なため、現在の調整事項を確定できません".into(),
        evidence: vec![EvidenceRef {
            source: "session-board".into(),
            kind: evidence_kind.into(),
            ref_id: INCOMPLETE_OBSERVATION_KEY.into(),
            detail,
        }],
        primary_action: PrimaryAction::OpenSession {
            session: SessionRef::Logical {
                logical_session_id: "session-board".into(),
            },
        },
        reply_route: ReplyRoute::None,
        resolution_predicate: ResolutionPredicate::ObservationMissing {
            observation_key: INCOMPLETE_OBSERVATION_KEY.into(),
        },
        state: CardState::Open,
        first_seen_at: now,
        last_seen_at: now,
        revision: 1,
        resolved_at: None,
    }
}

fn upsert_incomplete(
    conn: &Connection,
    now: i64,
    evidence_kind: &str,
    detail: String,
) -> Result<bool, String> {
    store::upsert(conn, &incomplete_card(now, evidence_kind, detail))
}

fn reconcile_complete(
    conn: &Connection,
    cards: &[AttentionCard],
    now: i64,
) -> Result<bool, String> {
    let fingerprints = cards
        .iter()
        .map(|card| card.fingerprint.as_str())
        .collect::<BTreeSet<_>>();
    let mut changed = false;
    for card in cards {
        changed |= store::upsert(conn, card)?;
    }
    for existing in store::list_all_cards(conn)? {
        if existing.state == CardState::Open
            && existing.fingerprint.starts_with(FINGERPRINT_PREFIX)
            && !fingerprints.contains(existing.fingerprint.as_str())
        {
            changed |= store::resolve_card(conn, &existing.id, now)?;
        }
    }
    Ok(changed)
}

fn parse_timestamp_ms(value: &str) -> Result<i64, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .map_err(|error| format!("invalid RFC 3339 timestamp {value:?}: {error}"))
}

fn modified_at_ns(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos()
        .try_into()
        .ok()
}

fn cached_stamp(conn: &Connection) -> Result<Option<(i64, u64)>, String> {
    conn.query_row(
        "SELECT updated_at, payload_json FROM attention_snapshots WHERE snapshot_key=?1",
        [CACHE_KEY],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .map(|(modified_at, length)| {
        length
            .parse::<u64>()
            .map(|length| (modified_at, length))
            .map_err(|error| error.to_string())
    })
    .transpose()
}

fn save_stamp(conn: &Connection, modified_at: i64, file_length: u64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO attention_snapshots(snapshot_key, payload_json, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(snapshot_key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at",
        params![CACHE_KEY, file_length.to_string(), modified_at],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rusqlite::Connection;

    use super::*;

    const COMPLETE: &str = r#"{
      "schema_version": 1,
      "snapshot_id": "snap-test",
      "generated_at": "2026-08-30T12:00:00.000Z",
      "source_watermark": 1,
      "coverage": {
        "state": "complete",
        "expected_sessions": 1,
        "observed_sessions": 1,
        "stale_sessions": 0,
        "failed_probes": 0,
        "status_untracked_sessions": 0
      },
      "items": [{
        "attention_id": "incident-test",
        "incident_group_id": "group:test",
        "kind": "file_lease_conflict",
        "severity": "blocking",
        "requires_human_action": true,
        "actor": "human",
        "summary": "Resolve the conflict",
        "why_now": "Two writers overlap.",
        "next_action": {"type": "open_lane", "label": "Open", "target": "lane-a"},
        "affected_lane_ids": ["lane-a"],
        "evidence_refs": ["session:pty-test"],
        "first_seen_at": "2026-08-30T11:59:00.000Z",
        "last_changed_at": "2026-08-30T12:00:00.000Z",
        "freshness": "fresh",
        "rank": 3
      }]
    }"#;

    #[test]
    fn reads_a_real_snapshot_file_into_one_stable_ranked_card() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("attention_snapshot.json");
        fs::write(&path, COMPLETE).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        store::init_for_test(&conn).unwrap();

        assert!(sync_path(&conn, &path, 1_000).unwrap());
        let cards = store::list_open_cards(&conn).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].kind, AttentionKind::SessionBoardIncident);
        assert_eq!(cards[0].waiting, Waiting::Human);
        assert_eq!(cards[0].severity, Severity::Blocking);
        assert_eq!(cards[0].actor, Some(AttentionActor::Human));
        assert_eq!(cards[0].freshness, Some(AttentionFreshness::Fresh));
        assert_eq!(cards[0].source_rank, Some(3));
        assert_eq!(cards[0].impact, "Resolve the conflict");
        assert_eq!(
            cards[0].primary_action,
            PrimaryAction::OpenSession {
                session: SessionRef::Pty {
                    pty_session_id: "pty-test".into(),
                },
            }
        );
        assert!(!sync_path(&conn, &path, 2_000).unwrap());
        assert_eq!(store::list_open_cards(&conn).unwrap()[0].revision, 1);
    }

    #[test]
    fn t2_non_human_blocking_item_waits_for_work() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("attention_snapshot.json");
        fs::write(
            &path,
            include_str!(
                "../../../tests/fixtures/session_board_attention/resolved_before_click.json"
            ),
        )
        .unwrap();
        let conn = Connection::open_in_memory().unwrap();
        store::init_for_test(&conn).unwrap();

        assert!(sync_path(&conn, &path, 1_000).unwrap());
        let cards = store::list_open_cards(&conn).unwrap();
        assert_eq!(cards.len(), 1);
        let card = serde_json::to_value(&cards[0]).unwrap();
        assert_eq!(card["waiting"], "work");
        assert_eq!(card["severity"], "blocking");
        assert_eq!(card["actor"], "system");
        assert_eq!(card["freshness"], "fresh");
    }

    #[test]
    fn partial_unavailable_and_bad_schema_become_incomplete_cards() {
        for payload in [
            COMPLETE.replace("\"complete\"", "\"partial\""),
            COMPLETE.replace("\"complete\"", "\"unavailable\""),
            COMPLETE.replace("\"schema_version\": 1", "\"schema_version\": 2"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("attention_snapshot.json");
            fs::write(&path, payload).unwrap();
            let conn = Connection::open_in_memory().unwrap();
            store::init_for_test(&conn).unwrap();

            sync_path(&conn, &path, 1_000).unwrap();
            let cards = store::list_open_cards(&conn).unwrap();
            assert_eq!(cards.len(), 1);
            assert_eq!(cards[0].fingerprint, INCOMPLETE_FINGERPRINT);
            assert_eq!(cards[0].why_now, "調整面のデータが読めません");
            assert_eq!(cards[0].waiting, Waiting::Work);
            assert_eq!(cards[0].severity, Severity::Warning);
            assert_eq!(cards[0].actor, None);
            assert_eq!(cards[0].freshness, None);
        }
    }

    #[test]
    fn a_complete_snapshot_resolves_incidents_that_are_no_longer_present() {
        let conn = Connection::open_in_memory().unwrap();
        store::init_for_test(&conn).unwrap();
        let snapshot: OperatorAttentionSnapshot = serde_json::from_str(COMPLETE).unwrap();
        let card = snapshot_item_card(&snapshot.items[0]).unwrap();
        store::upsert(&conn, &card).unwrap();

        assert!(reconcile_complete(&conn, &[], 2_000).unwrap());
        assert!(store::list_open_cards(&conn).unwrap().is_empty());
        let cards = store::list_all_cards(&conn).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].state, CardState::Resolved);
        assert_eq!(cards[0].resolved_at, Some(2_000));
    }

    #[test]
    fn consumes_the_default_written_snapshot_when_it_exists() {
        let Some(path) = default_snapshot_path() else {
            return;
        };
        if !path.is_file() {
            return;
        }
        let payload: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let coverage = payload
            .pointer("/coverage/state")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        let conn = Connection::open_in_memory().unwrap();
        store::init_for_test(&conn).unwrap();

        sync_path(&conn, &path, 1_000).unwrap();
        assert!(cached_stamp(&conn).unwrap().is_some());
        let cards = store::list_open_cards(&conn).unwrap();
        if coverage == "complete" {
            let expected = payload["items"].as_array().unwrap().len();
            assert_eq!(cards.len(), expected);
        } else {
            assert_eq!(cards.len(), 1);
            assert_eq!(cards[0].fingerprint, INCOMPLETE_FINGERPRINT);
        }
    }
}

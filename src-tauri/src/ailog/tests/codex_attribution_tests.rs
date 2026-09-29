//! Codex 0.57.1: new-source identity, incremental attribution, legacy compat.

use rusqlite::params;

use super::fixtures::Fixture;
use crate::ailog::{parse_codex, KIND_CLAUDE, KIND_CODEX, KIND_GROK};

const SOL_UUID: &str = "01a031ef-e449-74a0-b12c-d69ae559cc9e";
const SOL_FILE: &str = "rollout-2026-08-24T13-03-20-01a031ef-e449-74a0-b12c-d69ae559cc9e.jsonl";
const TERRA_UUID: &str = "01a03180-c8a8-7392-81a8-1f4314d8bf74";
const TERRA_FILE: &str = "rollout-2026-08-24T11-02-00-01a03180-c8a8-7392-81a8-1f4314d8bf74.jsonl";
const PARENT_UUID: &str = "01a031ee-64b1-7b50-a51a-cd56a2abc586";
const CHILD_B: &str = "01a031ef-aaaa-74a0-b12c-d69ae559cc9e";
const CHILD_B_FILE: &str = "rollout-2026-08-24T13-04-00-01a031ef-aaaa-74a0-b12c-d69ae559cc9e.jsonl";

fn session_meta(id: &str) -> String {
    format!(
        r#"{{"timestamp":"2026-08-24T13:03:20.000Z","type":"session_meta","payload":{{"id":"{id}","cwd":"C:\\proj\\codex","originator":"codex-tui","source":"cli"}}}}"#
    )
}

fn turn_context(model: &str, effort: &str) -> String {
    format!(
        r#"{{"timestamp":"2026-08-24T13:03:20.100Z","type":"turn_context","payload":{{"turn_id":"t1","model":"{model}","effort":"{effort}","cwd":"C:\\proj\\codex"}}}}"#
    )
}

fn turn_context_fields(model: Option<&str>, effort: Option<&str>, padding: usize) -> String {
    let mut payload = serde_json::json!({
        "turn_id": "t-partial",
        "cwd": "C:\\proj\\codex",
    });
    if let Some(model) = model {
        payload["model"] = serde_json::Value::String(model.to_string());
    }
    if let Some(effort) = effort {
        payload["effort"] = serde_json::Value::String(effort.to_string());
    }
    if padding > 0 {
        payload["padding"] = serde_json::Value::String("z".repeat(padding));
    }
    serde_json::json!({
        "timestamp": "2026-08-24T13:03:20.100Z",
        "type": "turn_context",
        "payload": payload,
    })
    .to_string()
}

fn thread_settings(model: &str, effort: &str) -> String {
    serde_json::json!({
        "timestamp": "2026-08-24T13:03:20.100Z",
        "type": "event_msg",
        "payload": {
            "type": "thread_settings_applied",
            "thread_settings": {
                "model": model,
                "reasoning_effort": effort,
            }
        }
    })
    .to_string()
}

fn token_count(ordinal: i64, ts: &str, output: i64) -> String {
    let input = output * 10;
    let total = input + output;
    format!(
        r#"{{"timestamp":"{ts}","ordinal":{ordinal},"type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":0,"output_tokens":{output},"total_tokens":{total}}},"last_token_usage":{{"input_tokens":{input},"cached_input_tokens":0,"output_tokens":{output},"total_tokens":{total}}}}}}}}}"#
    )
}

fn models_and_efforts(
    fixture: &Fixture,
    session_id: &str,
) -> Vec<(Option<String>, Option<String>)> {
    let conn = fixture.conn();
    let mut stmt = conn
        .prepare("SELECT model, effort FROM turn WHERE kind = ?1 AND session_id = ?2 ORDER BY seq")
        .unwrap();
    stmt.query_map(params![KIND_CODEX, session_id], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })
    .unwrap()
    .map(|row| row.unwrap())
    .collect()
}

fn session_count(fixture: &Fixture) -> i64 {
    fixture.count("session")
}

fn session_ids(fixture: &Fixture) -> Vec<String> {
    let conn = fixture.conn();
    let mut stmt = conn
        .prepare("SELECT session_id FROM session ORDER BY session_id")
        .unwrap();
    stmt.query_map([], |row| row.get(0))
        .unwrap()
        .map(|row| row.unwrap())
        .collect()
}

fn turn_count_for(fixture: &Fixture, session_id: &str) -> i64 {
    fixture
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM turn WHERE kind = ?1 AND session_id = ?2",
            params![KIND_CODEX, session_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn source_session(fixture: &Fixture, file_name: &str) -> String {
    let needle = format!("%{file_name}");
    fixture
        .conn()
        .query_row(
            "SELECT session_id FROM source_file WHERE path LIKE ?1",
            params![needle],
            |row| row.get(0),
        )
        .unwrap()
}

fn plant_stored_session(fixture: &Fixture, file_name: &str, stored: &str) {
    let needle = format!("%{file_name}");
    fixture
        .conn()
        .execute(
            "UPDATE source_file SET session_id = ?1 WHERE path LIKE ?2",
            params![stored, needle],
        )
        .unwrap();
}

/// Collapse every Codex turn onto `stored` with unique seqs, and point both
/// source rows at that id. Used to reproduce a legacy shared session.
fn force_shared_legacy(fixture: &Fixture, stored: &str) {
    let conn = fixture.conn();
    let turns: Vec<(Option<String>, Option<String>, i64, i64, i64)> = {
        let mut stmt = conn
            .prepare(
                "SELECT model, effort, ts, input_tokens, output_tokens \
                 FROM turn WHERE kind = ?1 ORDER BY session_id, seq",
            )
            .unwrap();
        stmt.query_map(params![KIND_CODEX], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })
        .unwrap()
        .map(|row| row.unwrap())
        .collect()
    };
    conn.execute("DELETE FROM turn WHERE kind = ?1", params![KIND_CODEX])
        .unwrap();
    conn.execute("DELETE FROM session WHERE kind = ?1", params![KIND_CODEX])
        .unwrap();
    conn.execute(
        "INSERT INTO session (kind, session_id) VALUES (?1, ?2)",
        params![KIND_CODEX, stored],
    )
    .unwrap();
    for (seq, (model, effort, ts, input, output)) in turns.into_iter().enumerate() {
        conn.execute(
            "INSERT INTO turn (kind, session_id, seq, ts, model, effort, input_tokens, output_tokens) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![KIND_CODEX, stored, seq as i64, ts, model, effort, input, output],
        )
        .unwrap();
    }
    conn.execute(
        "UPDATE source_file SET session_id = ?1 WHERE kind = ?2",
        params![stored, KIND_CODEX],
    )
    .unwrap();
}

fn replay_version(fixture: &Fixture) -> Option<String> {
    fixture
        .conn()
        .query_row(
            "SELECT value FROM index_state WHERE key = 'codex_replay_version'",
            [],
            |row| row.get(0),
        )
        .ok()
}

fn parse_error(fixture: &Fixture, file_name: &str) -> Option<String> {
    let needle = format!("%{file_name}");
    fixture
        .conn()
        .query_row(
            "SELECT parse_error FROM source_file WHERE path LIKE ?1",
            params![needle],
            |row| row.get(0),
        )
        .unwrap()
}

fn source_content_snapshot(
    fixture: &Fixture,
) -> Vec<(String, Option<String>, i64, i64, i64)> {
    let conn = fixture.conn();
    let mut stmt = conn
        .prepare(
            "SELECT path, session_id, size_bytes, parsed_bytes, parsed_lines \
             FROM source_file WHERE kind = ?1 ORDER BY path",
        )
        .unwrap();
    stmt.query_map(params![KIND_CODEX], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        ))
    })
    .unwrap()
    .map(|row| row.unwrap())
    .collect()
}

fn codex_turn_snapshot(
    fixture: &Fixture,
) -> Vec<(String, i64, i64, Option<String>, Option<String>, i64, i64)> {
    let conn = fixture.conn();
    let mut stmt = conn
        .prepare(
            "SELECT session_id, seq, ts, model, effort, input_tokens, output_tokens \
             FROM turn WHERE kind = ?1 ORDER BY session_id, seq",
        )
        .unwrap();
    stmt.query_map(params![KIND_CODEX], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
        ))
    })
    .unwrap()
    .map(|row| row.unwrap())
    .collect()
}

fn index_model_case(file_name: &str, uuid: &str, model: &str, effort: &str) {
    let fixture = Fixture::new();
    let first = [
        session_meta(uuid),
        turn_context(model, effort),
        token_count(1, "2026-08-24T13:03:21.000Z", 10),
    ];
    let first_refs: Vec<&str> = first.iter().map(String::as_str).collect();
    fixture.write(file_name, &first_refs);
    fixture.index(KIND_CODEX, false);

    assert_eq!(
        models_and_efforts(&fixture, uuid),
        vec![(Some(model.to_string()), Some(effort.to_string()))]
    );
    assert_eq!(session_count(&fixture), 1);
    assert_eq!(source_session(&fixture, file_name), uuid);

    let appended = token_count(2, "2026-08-24T13:03:22.000Z", 20);
    fixture.append(file_name, &[appended.as_str()]);
    fixture.index(KIND_CODEX, false);

    let rows = models_and_efforts(&fixture, uuid);
    assert_eq!(
        rows,
        vec![
            (Some(model.to_string()), Some(effort.to_string())),
            (Some(model.to_string()), Some(effort.to_string())),
        ]
    );
    assert_eq!(session_count(&fixture), 1);
    assert_eq!(fixture.count("turn"), 2);

    let again = fixture.index(KIND_CODEX, false);
    assert_eq!(again.files_skipped, 1);
    assert_eq!(session_count(&fixture), 1);
    assert_eq!(fixture.count("turn"), 2);
    assert_eq!(models_and_efforts(&fixture, uuid), rows);
    assert!(replay_version(&fixture).is_none());
}

#[test]
fn sol_full_chunk_then_token_only_append_keeps_model_and_uuid() {
    index_model_case(SOL_FILE, SOL_UUID, "gpt-5.6-sol", "high");
}

#[test]
fn terra_full_chunk_then_token_only_append_keeps_model_and_uuid() {
    index_model_case(TERRA_FILE, TERRA_UUID, "gpt-5.6-terra", "xhigh");
}

#[test]
fn filename_uuid_is_authoritative_for_a_new_standard_rollout() {
    assert_eq!(
        parse_codex::session_id_from_filename(
            "rollout-2026-08-24T13-03-20-01a031ef-e449-74a0-b12c-d69ae559cc9e"
        ),
        SOL_UUID
    );
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    assert_eq!(session_ids(&fixture), vec![SOL_UUID.to_string()]);
}

#[test]
fn aba_handoff_is_attributed_from_raw_turn_context() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            turn_context("gpt-5.6-terra", "xhigh").as_str(),
            token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(3, "2026-08-24T13:03:23.000Z", 30).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    assert_eq!(
        models_and_efforts(&fixture, SOL_UUID),
        vec![
            (Some("gpt-5.6-sol".into()), Some("high".into())),
            (Some("gpt-5.6-terra".into()), Some("xhigh".into())),
            (Some("gpt-5.6-sol".into()), Some("high".into())),
        ]
    );
}

#[test]
fn parent_only_suffix_does_not_replace_filename_uuid() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    fixture.append(
        SOL_FILE,
        &[
            session_meta(PARENT_UUID).as_str(),
            token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    assert_eq!(session_ids(&fixture), vec![SOL_UUID.to_string()]);
    assert_eq!(fixture.count("turn"), 2);
}

#[test]
fn legacy_mismatched_source_appends_to_stored_id() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    let ghost = format!("08-24T13-03-20-{SOL_UUID}");
    {
        let conn = fixture.conn();
        conn.execute(
            "UPDATE session SET session_id = ?1 WHERE session_id = ?2",
            params![ghost, SOL_UUID],
        )
        .unwrap();
        conn.execute(
            "UPDATE turn SET session_id = ?1 WHERE session_id = ?2",
            params![ghost, SOL_UUID],
        )
        .unwrap();
    }
    plant_stored_session(&fixture, SOL_FILE, &ghost);
    fixture
        .conn()
        .execute("DELETE FROM index_state WHERE key LIKE 'codex_ps:%'", [])
        .unwrap();

    fixture.append(
        SOL_FILE,
        &[token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str()],
    );
    fixture.index(KIND_CODEX, false);

    assert_eq!(source_session(&fixture, SOL_FILE), ghost);
    assert_eq!(session_ids(&fixture), vec![ghost.clone()]);
    assert_eq!(turn_count_for(&fixture, &ghost), 2);
    assert_eq!(turn_count_for(&fixture, SOL_UUID), 0);
    assert_eq!(
        models_and_efforts(&fixture, &ghost)[1],
        (Some("gpt-5.6-sol".into()), Some("high".into()))
    );
}

#[test]
fn incomplete_legacy_append_does_not_persist_unrecovered_state() {
    use std::io::Write;

    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    let ghost = format!("08-24T13-03-20-{SOL_UUID}");
    {
        let conn = fixture.conn();
        conn.execute(
            "UPDATE session SET session_id = ?1 WHERE session_id = ?2",
            params![ghost, SOL_UUID],
        )
        .unwrap();
        conn.execute(
            "UPDATE turn SET session_id = ?1 WHERE session_id = ?2",
            params![ghost, SOL_UUID],
        )
        .unwrap();
        conn.execute(
            "UPDATE source_file SET session_id = ?1",
            params![ghost],
        )
        .unwrap();
        conn.execute("DELETE FROM index_state WHERE key LIKE 'codex_ps:%'", [])
            .unwrap();
    }

    let token = token_count(2, "2026-08-24T13:03:22.000Z", 20);
    let split = token.len() / 2;
    let path = fixture.logs.join(SOL_FILE);
    {
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(&token.as_bytes()[..split]).unwrap();
    }
    fixture.index(KIND_CODEX, false);
    let state_rows: i64 = fixture
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM index_state WHERE key LIKE 'codex_ps:%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state_rows, 0, "unrecovered state must not become trusted");

    {
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(&token.as_bytes()[split..]).unwrap();
        file.write_all(b"\n").unwrap();
    }
    fixture.index(KIND_CODEX, false);
    assert_eq!(
        models_and_efforts(&fixture, &ghost)[1],
        (Some("gpt-5.6-sol".into()), Some("high".into()))
    );
}

#[test]
fn shared_legacy_truncate_does_not_mutate_and_records_repair_pending() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str(),
        ],
    );
    fixture.write(
        CHILD_B_FILE,
        &[
            session_meta(CHILD_B).as_str(),
            turn_context("gpt-5.6-terra", "high").as_str(),
            token_count(1, "2026-08-24T13:04:21.000Z", 11).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    force_shared_legacy(&fixture, PARENT_UUID);
    assert_eq!(turn_count_for(&fixture, PARENT_UUID), 3);
    let sources_before = source_content_snapshot(&fixture);
    let turns_before = codex_turn_snapshot(&fixture);

    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    let report = fixture.index(KIND_CODEX, false);
    assert_eq!(turn_count_for(&fixture, PARENT_UUID), 3);
    assert_eq!(source_content_snapshot(&fixture), sources_before);
    assert_eq!(codex_turn_snapshot(&fixture), turns_before);
    assert!(
        report
            .errors
            .iter()
            .any(|err| err.contains("historical repair pending")),
        "shared truncate must record repair-pending: {:?}",
        report.errors
    );
}

#[test]
fn shared_legacy_replacement_does_not_mutate_and_records_repair_pending() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.write(
        CHILD_B_FILE,
        &[
            session_meta(CHILD_B).as_str(),
            turn_context("gpt-5.6-terra", "high").as_str(),
            token_count(1, "2026-08-24T13:04:21.000Z", 11).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    force_shared_legacy(&fixture, PARENT_UUID);
    assert_eq!(turn_count_for(&fixture, PARENT_UUID), 2);
    let sources_before = source_content_snapshot(&fixture);
    let turns_before = codex_turn_snapshot(&fixture);

    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-max", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str(),
        ],
    );
    let report = fixture.index(KIND_CODEX, false);
    assert_eq!(turn_count_for(&fixture, PARENT_UUID), 2);
    assert_eq!(turn_count_for(&fixture, SOL_UUID), 0);
    assert_eq!(source_content_snapshot(&fixture), sources_before);
    assert_eq!(codex_turn_snapshot(&fixture), turns_before);
    assert!(
        report
            .errors
            .iter()
            .any(|err| err.contains("historical repair pending")),
        "shared replacement must record repair-pending: {:?}",
        report.errors
    );
}

#[test]
fn unshared_truncate_does_not_duplicate_rows() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    assert_eq!(session_count(&fixture), 1);
    assert_eq!(fixture.count("turn"), 1);
    let again = fixture.index(KIND_CODEX, false);
    assert_eq!(again.files_skipped, 1);
}

#[test]
fn same_length_replacement_is_not_skipped() {
    let fixture = Fixture::new();
    let first = [
        session_meta(SOL_UUID),
        turn_context("gpt-5.6-sol", "high"),
        token_count(1, "2026-08-24T13:03:21.000Z", 10),
    ];
    let first_refs: Vec<&str> = first.iter().map(String::as_str).collect();
    fixture.write(SOL_FILE, &first_refs);
    fixture.index(KIND_CODEX, false);
    let second = [
        session_meta(SOL_UUID),
        turn_context("gpt-5.6-max", "high"),
        token_count(1, "2026-08-24T13:03:21.000Z", 10),
    ];
    let second_refs: Vec<&str> = second.iter().map(String::as_str).collect();
    fixture.write(SOL_FILE, &second_refs);
    fixture.index(KIND_CODEX, false);
    assert_eq!(
        models_and_efforts(&fixture, SOL_UUID),
        vec![(Some("gpt-5.6-max".into()), Some("high".into()))]
    );
    assert_eq!(fixture.count("turn"), 1);
}

#[test]
fn same_session_id_in_another_kind_does_not_block_codex_reset() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    fixture
        .conn()
        .execute(
            "INSERT INTO source_file \
             (path, kind, size_bytes, mtime_ns, parsed_bytes, parsed_lines, session_id, last_indexed) \
             VALUES ('C:\\fake-claude.jsonl', ?1, 0, 0, 0, 0, ?2, 0)",
            params![KIND_CLAUDE, SOL_UUID],
        )
        .unwrap();

    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-max", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    let report = fixture.index(KIND_CODEX, false);
    assert!(report.errors.is_empty(), "cross-kind id must not look shared");
    assert_eq!(
        models_and_efforts(&fixture, SOL_UUID),
        vec![(Some("gpt-5.6-max".into()), Some("high".into()))]
    );
}

#[test]
fn same_length_middle_only_replacement_is_not_skipped() {
    let fixture = Fixture::new();
    let before = format!(
        r#"{{"timestamp":"2026-08-24T13:03:20.050Z","type":"response_item","payload":{{"padding":"{}"}}}}"#,
        "a".repeat(6000)
    );
    let after = format!(
        r#"{{"timestamp":"2026-08-24T13:03:21.500Z","type":"response_item","payload":{{"padding":"{}"}}}}"#,
        "b".repeat(6000)
    );
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            before.as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            after.as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);

    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            before.as_str(),
            turn_context("gpt-5.6-max", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            after.as_str(),
        ],
    );
    let report = fixture.index(KIND_CODEX, false);
    assert_eq!(report.files_skipped, 0);
    assert_eq!(
        models_and_efforts(&fixture, SOL_UUID),
        vec![(Some("gpt-5.6-max".into()), Some("high".into()))]
    );
}

#[test]
fn same_content_mtime_refresh_is_not_rehashed_on_next_index() {
    let fixture = Fixture::new();
    let lines = [
        session_meta(SOL_UUID),
        turn_context("gpt-5.6-sol", "high"),
        token_count(1, "2026-08-24T13:03:21.000Z", 10),
    ];
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    fixture.write(SOL_FILE, &refs);
    fixture.index(KIND_CODEX, false);

    std::thread::sleep(std::time::Duration::from_millis(20));
    let path = fixture.write(SOL_FILE, &refs);
    let touched = fixture.index(KIND_CODEX, false);
    assert_eq!(touched.files_total, 1, "mtime-only change needs one metadata job");
    assert_eq!(touched.bytes_done, 0);

    let stored_mtime: i64 = fixture
        .conn()
        .query_row(
            "SELECT mtime_ns FROM source_file WHERE path = ?1",
            params![path.to_string_lossy().to_string()],
            |row| row.get(0),
        )
        .unwrap();
    let actual_mtime = std::fs::metadata(&path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        .min(i64::MAX as u128) as i64;
    assert_eq!(stored_mtime, actual_mtime);

    let unchanged = fixture.index(KIND_CODEX, false);
    assert_eq!(unchanged.files_total, 0);
    assert_eq!(unchanged.files_skipped, 1);
}

#[test]
fn larger_replacement_does_not_reuse_stale_state() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-terra", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "xhigh").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    let rows = models_and_efforts(&fixture, SOL_UUID);
    assert!(
        rows.iter()
            .all(|(m, e)| m.as_deref() == Some("gpt-5.6-sol") && e.as_deref() == Some("xhigh")),
        "replacement must not keep the old terra/high seed: {rows:?}"
    );
}

#[test]
fn state_line_spanning_one_mib_window_keeps_latest() {
    let fixture = Fixture::new();
    let spanning_state = turn_context_fields(
        Some("gpt-5.6-sol"),
        Some("xhigh"),
        1024 * 1024 + 80,
    );
    let trailing_padding = serde_json::json!({
        "timestamp": "2026-08-24T13:03:21.500Z",
        "type": "response_item",
        "payload": { "padding": "p".repeat(1024 * 1024 + 160) }
    })
    .to_string();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-terra", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            spanning_state.as_str(),
            trailing_padding.as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    fixture
        .conn()
        .execute("DELETE FROM index_state WHERE key LIKE 'codex_ps:%'", [])
        .unwrap();
    fixture.append(
        SOL_FILE,
        &[token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str()],
    );
    fixture.index(KIND_CODEX, false);
    let rows = models_and_efforts(&fixture, SOL_UUID);
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[1],
        (Some("gpt-5.6-sol".into()), Some("xhigh".into()))
    );
}

#[test]
fn crlf_lf_partial_utf8_and_mid_line_offset() {
    let fixture = Fixture::new();
    let body = format!(
        "{}\r\n{}\r\n{}\n",
        session_meta(SOL_UUID),
        turn_context("gpt-5.6-sol", "high"),
        token_count(1, "2026-08-24T13:03:21.000Z", 10)
    );
    std::fs::write(fixture.logs.join(SOL_FILE), body).unwrap();
    fixture.index(KIND_CODEX, false);
    assert_eq!(fixture.count("turn"), 1);

    let parsed_before: i64 = fixture
        .conn()
        .query_row("SELECT parsed_bytes FROM source_file", [], |row| row.get(0))
        .unwrap();
    let partial = token_count(2, "2026-08-24T13:03:22.000Z", 20);
    let cut = partial.len() / 2;
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(fixture.logs.join(SOL_FILE))
            .unwrap();
        file.write_all(&partial.as_bytes()[..cut]).unwrap();
        file.write_all(&[0x80]).unwrap();
    }
    fixture.index(KIND_CODEX, false);
    assert_eq!(fixture.count("turn"), 1);
    let parsed_partial: i64 = fixture
        .conn()
        .query_row("SELECT parsed_bytes FROM source_file", [], |row| row.get(0))
        .unwrap();
    assert_eq!(parsed_partial, parsed_before);

    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(fixture.logs.join(SOL_FILE))
            .unwrap();
        let rest = format!("\n{}\n", token_count(3, "2026-08-24T13:03:23.000Z", 30));
        file.write_all(rest.as_bytes()).unwrap();
        file.flush().unwrap();
    }
    let after_invalid = fixture.index(KIND_CODEX, false);
    assert_eq!(
        fixture.count("turn"),
        2,
        "valid record after a skipped invalid UTF-8 line must be indexed: errors={:?} skipped={}",
        after_invalid.errors,
        after_invalid.files_skipped
    );

    let parsed_now: i64 = fixture
        .conn()
        .query_row("SELECT parsed_bytes FROM source_file", [], |row| row.get(0))
        .unwrap();
    fixture
        .conn()
        .execute(
            "UPDATE source_file SET parsed_bytes = ?1",
            params![parsed_before + 17],
        )
        .unwrap();
    fixture
        .conn()
        .execute("DELETE FROM index_state WHERE key LIKE 'codex_ps:%'", [])
        .unwrap();
    fixture.append(
        SOL_FILE,
        &[token_count(4, "2026-08-24T13:03:24.000Z", 40).as_str()],
    );
    fixture.index(KIND_CODEX, false);
    assert!(fixture.count("turn") >= 2);
    assert!(parsed_now > parsed_before);
}

#[test]
fn invalid_complete_json_does_not_reset_existing_session() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    fixture.write(SOL_FILE, &[r#"{not-json}"#]);
    fixture.index(KIND_CODEX, false);
    assert_eq!(fixture.count("turn"), 2);
    assert!(parse_error(&fixture, SOL_FILE).is_some());
}

#[test]
fn non_standard_filename_is_not_authoritative_uuid() {
    let name = format!("rollout-x-{SOL_UUID}.jsonl");
    let fixture = Fixture::new();
    fixture.write(
        &name,
        &[
            session_meta("CX-fallback").as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    let ids = session_ids(&fixture);
    assert!(
        !ids.contains(&SOL_UUID.to_string()),
        "rollout-x-UUID must not be a standard filename identity: {ids:?}"
    );
    assert!(ids.contains(&"CX-fallback".to_string()));
}

#[test]
fn bare_uuid_filename_is_not_authoritative() {
    let name = format!("{SOL_UUID}.jsonl");
    let fixture = Fixture::new();
    fixture.write(
        &name,
        &[
            session_meta("CX-bare").as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    assert_eq!(session_ids(&fixture), vec!["CX-bare".to_string()]);
}

#[test]
fn mixed_nulls_stay_null_on_unchanged_index() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-terra", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            turn_context("gpt-5.6-sol", "xhigh").as_str(),
            token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    fixture
        .conn()
        .execute(
            "UPDATE turn SET model = NULL, model_family = NULL, model_variant = NULL, effort = NULL \
             WHERE kind = ?1 AND session_id = ?2 AND seq = 0",
            params![KIND_CODEX, SOL_UUID],
        )
        .unwrap();
    let report = fixture.index(KIND_CODEX, false);
    assert_eq!(report.files_skipped, 1);
    let rows = models_and_efforts(&fixture, SOL_UUID);
    assert_eq!(rows[0], (None, None));
    assert_eq!(
        rows[1],
        (Some("gpt-5.6-sol".into()), Some("xhigh".into()))
    );
}

#[test]
fn unchanged_second_index_schedules_no_work_and_preserves_nulls() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    {
        let conn = fixture.conn();
        conn.execute(
            "INSERT INTO session (kind, session_id) VALUES (?1, 'claude-null'), (?2, 'grok-null')",
            params![KIND_CLAUDE, KIND_GROK],
        )
        .unwrap();
        let mut stmt = conn
            .prepare(
                "INSERT INTO turn (kind, session_id, seq, ts, model, effort) VALUES (?1, ?2, ?3, ?4, NULL, NULL)",
            )
            .unwrap();
        for seq in 0..400 {
            stmt.execute(params![KIND_CLAUDE, "claude-null", seq, seq])
                .unwrap();
            if seq < 50 {
                stmt.execute(params![KIND_GROK, "grok-null", seq, seq])
                    .unwrap();
            }
        }
    }
    let turns_before = fixture.count("turn");
    let report = fixture.index(KIND_CODEX, false);
    assert_eq!(report.files_total, 0);
    assert_eq!(report.files_done, 0);
    assert_eq!(report.files_skipped, 1);
    assert_eq!(fixture.count("turn"), turns_before);
    let claude_nulls: i64 = fixture
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM turn WHERE kind = ?1 AND model IS NULL",
            params![KIND_CLAUDE],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(claude_nulls, 400);
    assert!(replay_version(&fixture).is_none());
}

#[test]
fn production_index_has_no_historical_null_heal_sql() {
    let source = include_str!("../index.rs");
    for forbidden in [
        "UPDATE turn SET model",
        "WHERE model IS NULL",
        "codex_replay_version",
        "carry_forward_missing_models",
        "fill_monomorphic",
    ] {
        assert!(
            !source.contains(forbidden),
            "historical heal marker remains in production index: {forbidden}"
        );
    }
}

#[test]
fn default_roots_exclude_claude_codex_projects() {
    let roots = crate::ailog::index::default_roots_for_test();
    for (_, path) in roots {
        let rendered = path.to_string_lossy();
        assert!(
            !rendered.contains(".claude-codex"),
            "default roots must not include claude-codex: {rendered}"
        );
    }
}

#[test]
fn genuine_model_less_transcript_stays_unknown() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str()],
    );
    fixture.index(KIND_CODEX, false);
    assert_eq!(models_and_efforts(&fixture, SOL_UUID), vec![(None, None)]);
}

#[test]
fn append_invalid_json_keeps_prior_rows_and_indexes_later_valid_record() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    fixture.append(
        SOL_FILE,
        &[
            "{not-json}",
            token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str(),
        ],
    );
    let report = fixture.index(KIND_CODEX, false);
    assert_eq!(fixture.count("turn"), 2);
    assert_eq!(session_count(&fixture), 1);
    assert!(
        parse_error(&fixture, SOL_FILE).is_some() || !report.errors.is_empty(),
        "invalid complete JSON on append must be reported"
    );
    assert_eq!(
        models_and_efforts(&fixture, SOL_UUID)[1],
        (Some("gpt-5.6-sol".into()), Some("high".into()))
    );
    fixture.append(
        SOL_FILE,
        &[token_count(3, "2026-08-24T13:03:23.000Z", 30).as_str()],
    );
    fixture.index(KIND_CODEX, false);
    assert!(
        parse_error(&fixture, SOL_FILE).is_some(),
        "a clean append must not hide a previously skipped invalid record"
    );
}

#[test]
fn mid_line_offset_rewinds_to_record_start() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    let parsed: i64 = fixture
        .conn()
        .query_row("SELECT parsed_bytes FROM source_file", [], |row| row.get(0))
        .unwrap();
    fixture
        .conn()
        .execute(
            "UPDATE source_file SET parsed_bytes = ?1",
            params![parsed - 17],
        )
        .unwrap();
    fixture
        .conn()
        .execute("DELETE FROM index_state WHERE key LIKE 'codex_ps:%'", [])
        .unwrap();
    fixture.append(
        SOL_FILE,
        &[token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str()],
    );
    fixture.index(KIND_CODEX, false);
    assert_eq!(fixture.count("turn"), 2);
    assert_eq!(session_count(&fixture), 1);
}

#[test]
fn rollout_cx1_uses_in_file_identity() {
    let fixture = Fixture::new();
    fixture.write(
        "rollout-CX1.jsonl",
        &[
            session_meta("CX-fallback").as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    assert_eq!(session_ids(&fixture), vec!["CX-fallback".to_string()]);
}

#[test]
fn nonstandard_in_file_identity_survives_token_only_append() {
    for file_name in [
        "rollout-CX1.jsonl".to_string(),
        format!("rollout-x-{SOL_UUID}.jsonl"),
    ] {
        let fixture = Fixture::new();
        fixture.write(
            &file_name,
            &[
                session_meta("CX-fallback").as_str(),
                turn_context("gpt-5.6-sol", "high").as_str(),
                token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            ],
        );
        fixture.index(KIND_CODEX, false);
        let stored = source_session(&fixture, &file_name);
        fixture.append(
            &file_name,
            &[token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str()],
        );
        fixture.index(KIND_CODEX, false);

        assert_eq!(stored, "CX-fallback");
        assert_eq!(source_session(&fixture, &file_name), stored);
        assert_eq!(session_ids(&fixture), vec![stored.clone()]);
        assert_eq!(turn_count_for(&fixture, &stored), 2);
        assert_eq!(
            models_and_efforts(&fixture, &stored),
            vec![
                (Some("gpt-5.6-sol".into()), Some("high".into())),
                (Some("gpt-5.6-sol".into()), Some("high".into())),
            ]
        );
    }
}

#[test]
fn nonstandard_identity_can_be_established_after_initial_meta_less_chunk() {
    let fixture = Fixture::new();
    let name = "rollout-CX-delayed.jsonl";
    fixture.write(
        name,
        &[token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str()],
    );
    fixture.index(KIND_CODEX, false);
    assert_eq!(session_ids(&fixture), vec!["rollout-CX-delayed".to_string()]);

    fixture.append(
        name,
        &[
            session_meta("CX-delayed").as_str(),
            turn_context("gpt-5.6-sol", "high").as_str(),
            token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);

    assert_eq!(session_ids(&fixture), vec!["CX-delayed".to_string()]);
    assert_eq!(source_session(&fixture, name), "CX-delayed");
    assert_eq!(turn_count_for(&fixture, "CX-delayed"), 2);
}

fn assert_partial_reverse_recovery(latest_model: Option<&str>, latest_effort: Option<&str>) {
    let fixture = Fixture::new();
    let partial = turn_context_fields(latest_model, latest_effort, 0);
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            turn_context("gpt-5.6-terra", "high").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
            partial.as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    fixture
        .conn()
        .execute("DELETE FROM index_state WHERE key LIKE 'codex_ps:%'", [])
        .unwrap();
    fixture.append(
        SOL_FILE,
        &[token_count(2, "2026-08-24T13:03:22.000Z", 20).as_str()],
    );
    fixture.index(KIND_CODEX, false);
    assert_eq!(
        models_and_efforts(&fixture, SOL_UUID)[1],
        (
            Some(latest_model.unwrap_or("gpt-5.6-terra").to_string()),
            Some(latest_effort.unwrap_or("high").to_string()),
        )
    );
}

#[test]
fn reverse_recovery_collects_effort_before_latest_model_only_context() {
    assert_partial_reverse_recovery(Some("gpt-5.6-sol"), None);
}

#[test]
fn reverse_recovery_collects_model_before_latest_effort_only_context() {
    assert_partial_reverse_recovery(None, Some("xhigh"));
}

#[test]
fn thread_settings_applied_attributes_token_without_turn_context() {
    let fixture = Fixture::new();
    fixture.write(
        SOL_FILE,
        &[
            session_meta(SOL_UUID).as_str(),
            thread_settings("gpt-5.6-sol", "xhigh").as_str(),
            token_count(1, "2026-08-24T13:03:21.000Z", 10).as_str(),
        ],
    );
    fixture.index(KIND_CODEX, false);
    assert_eq!(
        models_and_efforts(&fixture, SOL_UUID),
        vec![(Some("gpt-5.6-sol".into()), Some("xhigh".into()))]
    );
}

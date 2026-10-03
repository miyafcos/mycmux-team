//! Local-day bucketing, raw-model grouping, and the usage rhythm aggregation.

use rusqlite::Connection;

use super::fixtures::*;
use crate::ailog::{query, usage, Filters, Range, KIND_CLAUDE, KIND_CODEX};

const NOW: i64 = 1_800_000_000_000;
const DAY: i64 = 86_400_000;
const HOUR: i64 = 3_600_000;
const JST_MIN: i64 = 9 * 60;

/// 2026-08-12T00:00:00Z. Anchors every timestamp below so the expected values
/// are visibly derived rather than copied from a run.
const AUG12_UTC: i64 = 1_786_492_800_000;

/// Local midnight opening 2026-08-13 JST — 15:00Z on the 12th.
const AUG13_JST: i64 = AUG12_UTC + 15 * HOUR;
/// Local midnight opening 2026-08-12 JST — 15:00Z on the 11th.
const AUG12_JST: i64 = AUG12_UTC - 9 * HOUR;

// ---------------------------------------------------------------------------
// bucket_start
// ---------------------------------------------------------------------------

#[test]
fn the_local_day_turns_over_at_15z() {
    let last_of_the_12th = AUG13_JST - 1;
    assert_eq!(
        query::bucket_start_at(last_of_the_12th, "day", JST_MIN),
        AUG12_JST
    );
    assert_eq!(query::bucket_start_at(AUG13_JST, "day", JST_MIN), AUG13_JST);
    assert_ne!(
        query::bucket_start_at(last_of_the_12th, "day", JST_MIN),
        query::bucket_start_at(AUG13_JST, "day", JST_MIN),
    );
}

#[test]
fn a_zero_offset_still_buckets_in_utc() {
    // The same two instants are one UTC day, which is exactly the behaviour
    // that used to file 17% of turns under the previous date.
    let last_of_the_12th = AUG13_JST - 1;
    assert_eq!(
        query::bucket_start_at(last_of_the_12th, "day", 0),
        AUG12_UTC
    );
    assert_eq!(query::bucket_start_at(AUG13_JST, "day", 0), AUG12_UTC);
}

#[test]
fn bucket_start_defaults_to_the_local_offset() {
    assert_eq!(
        query::bucket_start(AUG13_JST, "day"),
        query::bucket_start_at(AUG13_JST, "day", query::DAY_BOUNDARY_OFFSET_MIN),
    );
    assert_eq!(query::DAY_BOUNDARY_OFFSET_MIN, JST_MIN);
}

#[test]
fn weeks_start_on_the_local_monday() {
    // 2026-08-13 JST is a Thursday, so its ISO week opens on the 10th.
    let monday = AUG13_JST - 3 * DAY;
    assert_eq!(query::bucket_start_at(AUG13_JST, "week", JST_MIN), monday);
    assert_eq!(
        query::bucket_start_at(AUG13_JST + 12 * HOUR, "week", JST_MIN),
        monday
    );
}

#[test]
fn months_start_on_the_local_first() {
    let first = AUG13_JST - 12 * DAY;
    assert_eq!(query::bucket_start_at(AUG13_JST, "month", JST_MIN), first);
    assert_eq!(
        query::bucket_start_at(first + 20 * DAY, "month", JST_MIN),
        first
    );
}

// ---------------------------------------------------------------------------
// series
// ---------------------------------------------------------------------------

fn series_groups(conn: &Connection, group_by: &str) -> Vec<query::SeriesGroup> {
    query::series(
        conn,
        &Range::default(),
        &Filters::default(),
        &query::SeriesOptions {
            bucket: "day".to_string(),
            group_by: group_by.to_string(),
        },
        NOW,
    )
    .unwrap()
    .buckets
    .into_iter()
    .flat_map(|bucket| bucket.groups)
    .collect()
}

#[test]
fn raw_grouping_separates_variants_that_the_family_hides() {
    let fixture = Fixture::new();
    fixture.write("CX2.jsonl", CODEX_HANDOFF);
    fixture.index(KIND_CODEX, false);
    let conn = fixture.conn();

    let families: Vec<String> = series_groups(&conn, "model")
        .into_iter()
        .map(|row| row.group)
        .collect();
    assert_eq!(families, vec!["gpt-5.6".to_string()]);

    let mut raw: Vec<String> = series_groups(&conn, "model_raw")
        .into_iter()
        .map(|row| row.group)
        .collect();
    raw.sort();
    raw.dedup();
    assert_eq!(
        raw,
        vec!["gpt-5.6-sol".to_string(), "gpt-5.6-terra".to_string()]
    );
}

#[test]
fn provider_grouping_is_shared_by_daily_series_and_model_rows() {
    let fixture = Fixture::new();
    fixture.write("S1.jsonl", CLAUDE_SPLIT_REQUEST);
    fixture.write("S4.jsonl", CLAUDE_UNKNOWN_MODEL);
    let openai_turn = CLAUDE_SPLIT_REQUEST[0]
        .replace("\"sessionId\":\"S1\"", "\"sessionId\":\"S5\"")
        .replace("\"requestId\":\"req_1\"", "\"requestId\":\"req_openai\"")
        .replace("claude-opus-5", "gpt-5.6-terra");
    fixture.write("S2.jsonl", &[openai_turn.as_str()]);
    fixture.index(KIND_CLAUDE, false);
    let conn = fixture.conn();

    let mut groups: Vec<String> = series_groups(&conn, "provider")
        .into_iter()
        .map(|row| row.group)
        .collect();
    groups.sort();
    groups.dedup();
    assert_eq!(groups, vec!["anthropic", "openai", "other"]);

    let models = query::models(
        &conn,
        &Range::default(),
        &Filters::default(),
        &query::ModelsOptions {
            granularity: "provider".to_string(),
            bucket: "day".to_string(),
        },
        NOW,
    )
    .unwrap();
    let mut rows: Vec<String> = models.rows.into_iter().map(|row| row.model).collect();
    rows.sort();
    assert_eq!(rows, vec!["anthropic", "openai", "other"]);
}

#[test]
fn series_reports_cache_writes_as_the_sum_of_both_ttls() {
    let fixture = Fixture::new();
    // CLAUDE_SPLIT_REQUEST carries 0 ephemeral-5m and 500 ephemeral-1h tokens
    // across one collapsed request.
    fixture.write("S1.jsonl", CLAUDE_SPLIT_REQUEST);
    fixture.index(KIND_CLAUDE, false);
    let conn = fixture.conn();

    let (write_5m, write_1h): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(cache_write_5m_tokens),0), COALESCE(SUM(cache_write_1h_tokens),0) FROM turn",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((write_5m, write_1h), (0, 500));

    let groups = series_groups(&conn, "model");
    let total: i64 = groups.iter().map(|row| row.cache_write).sum();
    assert_eq!(total, write_5m + write_1h);
}

// ---------------------------------------------------------------------------
// rhythm
// ---------------------------------------------------------------------------

/// Insert one turn at `ts`. Sessions are created on demand so the join in the
/// rhythm queries has something to match.
fn turn_at(conn: &Connection, session: &str, seq: i64, ts: i64, input: i64, output: i64) {
    conn.execute(
        "INSERT OR IGNORE INTO session (kind, session_id, started_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![KIND_CLAUDE, session, ts],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO turn (kind, session_id, seq, ts, model, model_family, input_tokens, \
         output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cost_usd) \
         VALUES (?1, ?2, ?3, ?4, 'claude-opus-5', 'opus-5', ?5, ?6, 7, 3, 1, 0.5)",
        rusqlite::params![KIND_CLAUDE, session, seq, ts, input, output],
    )
    .unwrap();
}

fn rhythm_of(conn: &Connection) -> usage::UsageRhythmReport {
    usage::rhythm(conn, &Range::default(), &Filters::default(), NOW).unwrap()
}

#[test]
fn totals_exclude_reasoning_and_split_io_from_the_grand_total() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    turn_at(&conn, "A", 0, AUG13_JST + HOUR, 100, 20);
    turn_at(&conn, "A", 1, AUG13_JST + 2 * HOUR, 50, 10);

    let report = rhythm_of(&conn);
    assert_eq!(report.totals.turns, 2);
    assert_eq!(report.totals.input, 150);
    assert_eq!(report.totals.output, 30);
    assert_eq!(report.totals.cache_read, 14);
    assert_eq!(report.totals.cache_write, 8);
    assert_eq!(report.totals.io, 180);
    assert_eq!(report.totals.total, 150 + 30 + 14 + 8);
    assert_eq!(report.day_offset_minutes, JST_MIN);
    assert_eq!(report.timings.path, "raw");
    assert_eq!(report.timings.rows_scanned, 2);
}

#[test]
fn turns_either_side_of_local_midnight_land_on_different_days() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    turn_at(&conn, "A", 0, AUG13_JST - 1, 10, 1);
    turn_at(&conn, "B", 0, AUG13_JST, 20, 2);

    let report = rhythm_of(&conn);
    let days: Vec<i64> = report.days.iter().map(|day| day.day).collect();
    assert_eq!(days, vec![AUG12_JST, AUG13_JST]);
    assert_eq!(report.active_days, 2);
    assert_eq!(report.first_day, Some(AUG12_JST));
    assert_eq!(report.last_day, Some(AUG13_JST));
}

#[test]
fn streaks_count_consecutive_local_days_and_name_their_end() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    // Three in a row, a two-day gap, then two more.
    for (index, offset) in [0i64, 1, 2, 5, 6].iter().enumerate() {
        turn_at(
            &conn,
            &format!("S{index}"),
            0,
            AUG13_JST + offset * DAY + HOUR,
            10,
            1,
        );
    }

    let report = rhythm_of(&conn);
    assert_eq!(report.active_days, 5);
    assert_eq!(report.span_days, 7);
    assert_eq!(report.streak.longest, 3);
    assert_eq!(report.streak.longest_end_day, Some(AUG13_JST + 2 * DAY));
    assert_eq!(report.streak.current, 2);
    assert_eq!(report.streak.current_through_day, Some(AUG13_JST + 6 * DAY));
}

#[test]
fn hour_and_weekday_slots_cover_the_full_cycle() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    // 2026-08-13 JST is a Thursday; 09:00 local.
    turn_at(&conn, "A", 0, AUG13_JST + 9 * HOUR, 10, 1);

    let report = rhythm_of(&conn);
    assert_eq!(report.by_hour.len(), 24);
    assert_eq!(report.by_weekday.len(), 7);
    assert!(report
        .by_hour
        .iter()
        .enumerate()
        .all(|(i, s)| s.slot == i as i64));

    let busy: Vec<&usage::RhythmSlot> = report
        .by_hour
        .iter()
        .filter(|slot| slot.turns > 0)
        .collect();
    assert_eq!(busy.len(), 1);
    assert_eq!(busy[0].slot, 9);
    assert_eq!(busy[0].io, 11);

    let active_weekday: Vec<i64> = report
        .by_weekday
        .iter()
        .filter(|slot| slot.turns > 0)
        .map(|slot| slot.slot)
        .collect();
    // Sunday = 0, so Thursday is 4.
    assert_eq!(active_weekday, vec![4]);
}

#[test]
fn an_empty_database_reports_zeroes_rather_than_failing() {
    let fixture = Fixture::new();
    let conn = fixture.conn();

    let report = rhythm_of(&conn);
    assert_eq!(report.totals.turns, 0);
    assert_eq!(report.active_days, 0);
    assert_eq!(report.span_days, 0);
    assert_eq!(report.streak.current, 0);
    assert_eq!(report.streak.longest, 0);
    assert!(report.first_day.is_none());
    assert!(report.busiest_total.is_none());
    assert!(report.busiest_io.is_none());
    assert_eq!(report.by_hour.len(), 24);
    assert_eq!(report.by_weekday.len(), 7);
}

#[test]
fn the_busiest_day_is_picked_per_metric() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    // Day one has the larger fresh input/output; day two wins on cache volume
    // only, which is what separates the two "busiest" answers.
    turn_at(&conn, "A", 0, AUG13_JST + HOUR, 500, 100);
    for seq in 0..5 {
        turn_at(&conn, "B", seq, AUG13_JST + DAY + HOUR + seq, 10, 2);
    }

    let report = rhythm_of(&conn);
    assert_eq!(
        report.busiest_io.as_ref().map(|day| day.day),
        Some(AUG13_JST)
    );
    assert_eq!(
        report.busiest_total.as_ref().map(|day| day.day),
        Some(AUG13_JST)
    );
    let second = report
        .days
        .iter()
        .find(|day| day.day == AUG13_JST + DAY)
        .expect("second day present");
    assert_eq!(second.turns, 5);
    assert_eq!(second.io, 60);
}

#[test]
fn hourly_fold_matches_legacy_sql_for_filtered_partial_windows() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    for (session, seq, ts, input) in [
        ("A", 0, AUG13_JST - 1, 100),
        ("A", 1, AUG13_JST, 110),
        ("A", 2, AUG13_JST + HOUR, 120),
        ("A", 3, AUG13_JST + HOUR + 1, 130),
        ("B", 0, AUG13_JST + DAY + 9 * HOUR, 140),
        ("C", 0, AUG13_JST + 10 * HOUR, 150),
        ("D", 0, AUG13_JST + 11 * HOUR, 160),
        ("B", 1, AUG13_JST + 3 * DAY, 170),
    ] {
        turn_at(&conn, session, seq, ts, input, 10);
    }
    conn.execute("UPDATE session SET project_label='project', project_key='project', git_branch='main', first_prompt='needle', cost_usd=1 WHERE session_id='A'", []).unwrap();
    conn.execute("UPDATE session SET is_sidechain=1 WHERE session_id='C'", [])
        .unwrap();
    conn.execute(
        "UPDATE session SET origin='ailog-internal' WHERE session_id='D'",
        [],
    )
    .unwrap();
    conn.execute("UPDATE turn SET effort='high' WHERE session_id='A'", [])
        .unwrap();
    let range = Range {
        from: Some(AUG13_JST - 1),
        to: Some(AUG13_JST + DAY + 9 * HOUR),
        preset: None,
        anchor: None,
    };
    let mut cases = vec![Filters::default()];
    cases.push(Filters {
        include_sidechain: true,
        ..Filters::default()
    });
    cases.push(Filters {
        origins: vec!["ailog-internal".into()],
        ..Filters::default()
    });
    cases.push(Filters {
        models: vec!["opus-5".into()],
        ..Filters::default()
    });
    cases.push(Filters {
        projects: vec!["project".into()],
        ..Filters::default()
    });
    cases.push(Filters {
        branches: vec!["main".into()],
        ..Filters::default()
    });
    cases.push(Filters {
        efforts: vec!["high".into()],
        ..Filters::default()
    });
    cases.push(Filters {
        query: Some("needle".into()),
        ..Filters::default()
    });
    cases.push(Filters {
        min_cost: Some(0.5),
        ..Filters::default()
    });
    cases.push(Filters {
        kinds: vec![KIND_CODEX.into()],
        ..Filters::default()
    });
    let shift = JST_MIN * 60_000;
    for filters in cases {
        let report = usage::rhythm(&conn, &range, &filters, NOW).unwrap();
        let (resolved, _) = range.resolve(NOW);
        let (where_sql, params) = query::shared_where(&resolved, &filters);
        let source = format!("FROM turn t JOIN session s ON s.kind=t.kind AND s.session_id=t.session_id WHERE {where_sql}");
        let total_sql = format!("SELECT COUNT(*), COALESCE(SUM(t.input_tokens),0), COALESCE(SUM(t.output_tokens),0), COALESCE(SUM(t.cache_read_tokens),0), COALESCE(SUM(t.cache_write_5m_tokens+t.cache_write_1h_tokens),0), COALESCE(SUM(t.cost_usd),0) {source}");
        let expected = conn
            .query_row(&total_sql, rusqlite::params_from_iter(params.iter()), |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, f64>(5)?,
                ))
            })
            .unwrap();
        assert_eq!(
            (
                report.totals.turns,
                report.totals.input,
                report.totals.output,
                report.totals.cache_read,
                report.totals.cache_write,
                report.totals.cost_usd
            ),
            expected
        );
        let io = "t.input_tokens+t.output_tokens";
        let total = "t.input_tokens+t.output_tokens+t.cache_read_tokens+t.cache_write_5m_tokens+t.cache_write_1h_tokens";
        let days_sql = format!("SELECT (t.ts+{shift})/{DAY} AS d, COUNT(*), SUM({io}), SUM({total}), SUM(t.cost_usd) {source} GROUP BY d ORDER BY d");
        let mut stmt = conn.prepare(&days_sql).unwrap();
        let expected_days = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                Ok((
                    r.get::<_, i64>(0)? * DAY - shift,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, f64>(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            report
                .days
                .iter()
                .map(|d| (d.day, d.turns, d.io, d.total, d.cost_usd))
                .collect::<Vec<_>>(),
            expected_days
        );
        for (expression, slots, cycle) in [
            (
                format!("((t.ts+{shift})/{HOUR})%24"),
                &report.by_hour,
                24usize,
            ),
            (
                format!("((t.ts+{shift})/{DAY}+4)%7"),
                &report.by_weekday,
                7usize,
            ),
        ] {
            let sql = format!("SELECT {expression} AS slot, COUNT(*), SUM({io}), SUM({total}) {source} GROUP BY slot");
            let mut stmt = conn.prepare(&sql).unwrap();
            let rows = stmt
                .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                })
                .unwrap();
            let mut expected = vec![(0, 0, 0); cycle];
            for row in rows {
                let (slot, turns, io, total) = row.unwrap();
                expected[slot.rem_euclid(cycle as i64) as usize] = (turns, io, total);
            }
            assert_eq!(
                slots
                    .iter()
                    .map(|s| (s.turns, s.io, s.total))
                    .collect::<Vec<_>>(),
                expected
            );
        }
    }
}

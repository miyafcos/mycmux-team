//! Opt-in, byte-exact paired report checks on an owned, frozen database copy.
use std::io::Write;
use std::time::Instant;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::ailog::{query, usage, Filters, Range};
use super::fixtures::{Fixture, CLAUDE_IO_SESSION, CLAUDE_SPLIT_REQUEST};

fn cache_fixture() -> Fixture {
    let fixture=Fixture::new();
    fixture.write("split.jsonl",CLAUDE_SPLIT_REQUEST);
    fixture.index(crate::ailog::KIND_CLAUDE,false);
    fixture
}

#[test]
fn shared_pass_reuses_hydrated_rows_across_model_axes_and_cache_modes() {
    let fixture=cache_fixture();
    let conn=crate::ailog::db::reader(&fixture.db).unwrap();
    let range=Range {preset:Some("all".into()),anchor:Some(1_800_000_000_000),..Default::default()};
    let overview=query::overview(&conn,&range,&Filters::default(),0).unwrap();
    let filters=Filters {report_cache:Some(crate::ailog::report_cache::CacheMode::Refresh),..Default::default()};
    for granularity in ["provider","family","raw"] {
        let report=query::models(&conn,&range,&filters,&query::ModelsOptions{granularity:granularity.into(),bucket:"day".into()},0).unwrap();
        assert_eq!(report.total_sessions,overview.totals.sessions);
        assert_eq!(report.timings.rows_scanned,0,"model axes must reuse the current pass");
    }
}

#[test]
fn shared_pass_is_invalidated_after_index_and_session_tag_mutations() {
    let fixture=cache_fixture();
    let range=Range {preset:Some("all".into()),anchor:Some(1_800_000_000_000),..Default::default()};
    let conn=crate::ailog::db::reader(&fixture.db).unwrap();
    let first=query::models(&conn,&range,&Filters::default(),&query::ModelsOptions::default(),0).unwrap();
    fixture.write("io.jsonl",CLAUDE_IO_SESSION);
    fixture.index(crate::ailog::KIND_CLAUDE,false);
    let next=query::models(&conn,&range,&Filters::default(),&query::ModelsOptions::default(),0).unwrap();
    assert!(next.timings.rows_scanned>0);
    assert!(next.total_sessions>first.total_sessions);
    let writer=crate::ailog::db::writer(&fixture.db).unwrap();
    writer.execute("UPDATE session SET work_tags='[\"t2-tag\"]'",[]).unwrap();
    let tagged=query::models(&conn,&range,&Filters::default(),&query::ModelsOptions::default(),0).unwrap();
    assert!(tagged.timings.rows_scanned>0);
    assert!(tagged.by_work_tag.iter().any(|row|row.work_tag=="t2-tag"));
}

#[test]
fn shared_pass_does_not_cross_database_identities_or_resolved_windows() {
    let first=cache_fixture();
    let second=cache_fixture();
    let range=Range {preset:Some("all".into()),anchor:Some(1_800_000_000_000),..Default::default()};
    let conn=crate::ailog::db::reader(&first.db).unwrap();
    query::models(&conn,&range,&Filters::default(),&query::ModelsOptions::default(),0).unwrap();
    let other=crate::ailog::db::reader(&second.db).unwrap();
    let fresh=query::models(&other,&range,&Filters::default(),&query::ModelsOptions::default(),0).unwrap();
    assert!(fresh.timings.rows_scanned>0);
    let next_range=Range {anchor:Some(1_800_000_000_001),..range};
    let next=query::models(&conn,&next_range,&Filters::default(),&query::ModelsOptions::default(),0).unwrap();
    assert!(next.timings.rows_scanned>0);
}

fn record<T: Serialize>(
    out: &mut impl Write,
    key: String,
    started: Instant,
    report: Result<T, String>,
) {
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut value = match report {
        Ok(report) => serde_json::to_value(report).unwrap(),
        Err(error) => serde_json::json!({"error":error}),
    };
    if let Some(fields) = value.as_object_mut() {
        fields.remove("timings");
        fields.remove("cache");
    }
    let bytes = serde_json::to_vec(&value).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    writeln!(out, "{}", serde_json::json!({"key":key,"sha256":digest,"bytes":bytes.len(),"elapsedMs":elapsed_ms})).unwrap();
    out.flush().unwrap();
}

#[test]
#[ignore = "requires the owned t2 frozen real-data copy and output path"]
fn real_data_t2_report_matrix() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap().join("dist/t2-performance").canonicalize().unwrap();
    let path = std::path::PathBuf::from(std::env::var("MYCMUX_T2_DB").unwrap()).canonicalize().unwrap();
    assert!(path.starts_with(&root));
    assert_eq!(path.file_name().unwrap(), "ailog-copy.db");
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let anchor: i64 = std::env::var("MYCMUX_T2_ANCHOR").unwrap().parse().unwrap();
    let output = std::path::PathBuf::from(std::env::var("MYCMUX_T2_OUT").unwrap());
    assert!(output.starts_with(&root));
    let mut out = std::fs::File::create(output).unwrap();
    let sample = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, String>(0)).unwrap_or_else(|_| "t2-missing".into());
    let model = sample("SELECT model FROM turn WHERE model IS NOT NULL GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1");
    let project = sample("SELECT project_label FROM session WHERE project_label IS NOT NULL GROUP BY project_label ORDER BY COUNT(*) DESC LIMIT 1");
    let branch = sample("SELECT git_branch FROM session WHERE git_branch IS NOT NULL GROUP BY git_branch ORDER BY COUNT(*) DESC LIMIT 1");
    let effort = sample("SELECT effort FROM turn WHERE effort IS NOT NULL GROUP BY effort ORDER BY COUNT(*) DESC LIMIT 1");
    let cases = vec![
        ("default", Filters::default()),
        ("sidechain", Filters { include_sidechain: true, ..Default::default() }),
        ("kind", Filters { kinds: vec!["codex".into()], ..Default::default() }),
        ("model", Filters { models: vec![model.clone()], ..Default::default() }),
        ("project", Filters { projects: vec![project.clone()], ..Default::default() }),
        ("branch", Filters { branches: vec![branch], ..Default::default() }),
        ("effort", Filters { efforts: vec![effort], ..Default::default() }),
        ("origin", Filters { origins: vec!["other".into()], ..Default::default() }),
        ("internal", Filters { origins: vec!["ailog-internal".into()], ..Default::default() }),
        // Nonempty predicates deliberately exercise the legacy/raw fallback.
        ("min-cost", Filters { min_cost: Some(1000.0), ..Default::default() }),
        ("query", Filters { query: Some("t2-no-matching-report-text-261003".into()), ..Default::default() }),
        ("combined", Filters { models: vec![model], projects: vec![project], include_sidechain: true, kinds:vec!["codex".into()], ..Default::default() }),
    ];
    let axes = ["provider", "model", "model_raw", "project", "kind", "effort"];
    let pivot_axes = ["provider", "model", "model_raw", "project", "kind", "effort", "origin"];
    for preset in ["7d", "30d", "90d", "ytd", "all", "custom"] {
        let range = if preset == "custom" {
            Range { from: Some(anchor - 14 * 86_400_000), to: Some(anchor - 7 * 86_400_000), ..Default::default() }
        } else { Range { preset: Some(preset.into()), anchor: Some(anchor), ..Default::default() } };
        for (filter_name, filters) in &cases {
            let prefix = format!("{preset}/{filter_name}");
            macro_rules! check {
                ($name:expr, $call:expr) => {{ let start=Instant::now(); record(&mut out,format!("{prefix}/{}",$name),start,$call); }};
            }
            check!("overview", query::overview(&conn,&range,filters,anchor));
            for axis in axes {
                for bucket in ["day", "week", "month"] {
                    let options=query::SeriesOptions { bucket:bucket.into(),group_by:axis.into() };
                    check!(format!("series/{axis}/{bucket}"),query::series(&conn,&range,filters,&options,anchor));
                }
            }
            for row in pivot_axes {
                for col in pivot_axes {
                    if row == col { continue; }
                    let options=query::PivotOptions { row_by:row.into(), col_by:col.into() };
                    check!(format!("pivot/{row}/{col}"),query::pivot(&conn,&range,filters,&options,anchor));
                }
            }
            for dim in ["model","project","branch","effort","origin","title","agent"] {
                check!(format!("breakdown/{dim}"),query::breakdown(&conn,&range,filters,dim,anchor));
            }
            for granularity in ["provider","family","raw"] {
                for bucket in ["day","week","month"] {
                    let options=query::ModelsOptions {granularity:granularity.into(),bucket:bucket.into()};
                    check!(format!("models/{granularity}/{bucket}"),query::models(&conn,&range,filters,&options,anchor));
                }
                let options=query::ModelsOptions {granularity:granularity.into(),bucket:"day".into()};
                check!(format!("handoffs/{granularity}"),query::model_handoffs(&conn,&range,filters,&options,anchor));
            }
            for sort in ["cost","rework","recent","turns"] {
                let options=query::SessionsOptions { sort:sort.into(),limit:100,offset:0 };
                check!(format!("sessions/{sort}"),query::sessions(&conn,&range,filters,&options,anchor));
            }
            check!("rhythm",usage::rhythm(&conn,&range,filters,anchor));
            check!("rankings",query::rework_rankings(&conn,&range,filters,anchor));
            check!("efficiency",query::efficiency(&conn,&range,filters,anchor));
            check!("findings",query::findings(&conn,&range,filters,&query::FindingsOptions::default(),anchor));
            check!("rule-check",query::rule_check(&conn,&range,filters,anchor));
            check!("dashboard",query::dashboard(&conn,&range,filters,"raw",anchor));
            println!("T2_MATRIX {prefix}");
        }
    }
}

#[test]
#[ignore = "requires the owned t2 frozen real-data copy and output path"]
fn real_data_t2_native_timings() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap().join("dist/t2-performance").canonicalize().unwrap();
    let path = std::path::PathBuf::from(std::env::var("MYCMUX_T2_DB").unwrap()).canonicalize().unwrap();
    assert!(path.starts_with(&root));
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let anchor: i64=std::env::var("MYCMUX_T2_ANCHOR").unwrap().parse().unwrap();
    let output=std::path::PathBuf::from(std::env::var("MYCMUX_T2_OUT").unwrap());
    assert!(output.starts_with(&root));
    let mut out=std::fs::File::create(output).unwrap();
    for preset in ["7d","30d","90d","ytd","all"] {
        for run in 0..5 {
            let range=Range {preset:Some(preset.into()),anchor:Some(anchor+run),..Default::default()};
            let start=Instant::now();
            let overview=query::overview(&conn,&range,&Filters::default(),anchor).unwrap();
            let overview_ms=start.elapsed().as_secs_f64()*1000.0;
            let start=Instant::now();
            let models=query::models(&conn,&range,&Filters::default(),&query::ModelsOptions::default(),anchor).unwrap();
            let models_ms=start.elapsed().as_secs_f64()*1000.0;
            writeln!(out,"{}",serde_json::json!({"preset":preset,"run":run,"overviewMs":overview_ms,"overviewTimings":overview.timings,"modelsMs":models_ms,"modelsTimings":models.timings})).unwrap();
        }
    }
}

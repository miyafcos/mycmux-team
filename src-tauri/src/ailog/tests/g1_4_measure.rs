//! Portable source-only performance harness, also compiled at 5db18863b.
use std::path::PathBuf;
use std::time::Instant;
use rusqlite::{Connection,OpenFlags};
use crate::ailog::{query,Filters,Range};

fn skipped(key:&str)->bool { std::env::var("AILOG_G14_SKIP").ok().is_some_and(|keys|keys.split(';').any(|item|item==key)) }

fn path() -> PathBuf {
    assert!(!cfg!(windows),"Rust real-data measurements are not authorized on Windows");
    let path=PathBuf::from(std::env::var("AILOG_G14_SYNTHETIC_DB").unwrap());
    assert!(path.is_absolute());
    assert_eq!(path.file_name().unwrap(),"g1-4-synthetic.db");
    assert!(path.to_string_lossy().contains("/04_macrun/mirrors/mycmux-wt-grass-perf-261030-"));
    let conn=read(&path);
    let marker:String=conn.query_row("SELECT value FROM index_state WHERE key='g1_3_synthetic_only'",[],|r|r.get(0)).unwrap();
    assert_eq!(marker,"random-fixture-from-spec-only-v2");
    path
}

fn read(path:&std::path::Path)->Connection {
    let conn=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    conn.execute_batch("PRAGMA query_only=ON").unwrap(); conn
}

fn call(conn:&Connection,name:&str,range:&Range,now:i64)->Result<query::ReportTimings,String> {
    let filters=Filters::default();
    match name {
        "overview"=>query::overview(conn,range,&filters,now).map(|r|r.timings),
        "series"=>query::series(conn,range,&filters,&query::SeriesOptions {bucket:"day".into(),group_by:"model_raw".into()},now).map(|r|r.timings),
        "models"=>query::models(conn,range,&filters,&query::ModelsOptions {granularity:"raw".into(),bucket:"day".into()},now).map(|r|r.timings),
        "sessions"=>query::sessions(conn,range,&filters,&query::SessionsOptions {sort:"rework".into(),limit:100,offset:0},now).map(|r|r.timings),
        "breakdown"=>query::breakdown(conn,range,&filters,"project",now).map(|r|r.timings),
        "pivot"=>query::pivot(conn,range,&filters,&query::PivotOptions::default(),now).map(|r|r.timings),
        "model_handoffs"=>query::model_handoffs(conn,range,&filters,&query::ModelsOptions {granularity:"raw".into(),bucket:"day".into()},now).map(|r|r.timings),
        "rework_rankings"=>query::rework_rankings(conn,range,&filters,now).map(|r|r.timings),
        _=>crate::ailog::usage::rhythm(conn,range,&filters,now).map(|r|r.timings),
    }
}

// G14_GATE_START: the baseline copy substitutes its original Semaphore(2).
pub(super) async fn gated(name:&'static str,preset:&str,now:i64)->Result<query::ReportTimings,String> {
    use crate::ailog::report_runtime::{runtime,Lane};
    let path=path(); let range=Range {preset:Some(preset.into()),anchor:Some(now),..Default::default()};
    let lane=if ["model_handoffs","rework_rankings","usage_rhythm"].contains(&name) { Lane::Heavy } else { Lane::Light };
    runtime().run("g1-4-measure",name,None,lane,move ||Ok(read(&path)),move |conn|call(conn,name,&range,now)).await
}
// G14_GATE_END

fn scene(name:&str,now:i64) {
    let conn=Connection::open_with_flags(path(),OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    let day=(now+32_400_000)/86_400_000;
    for table in ["rollup_dirty","heavy_aggregate_dirty"] {
        let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",[table],|r|r.get(0)).unwrap();
        if !exists { continue; }
        conn.execute(&format!("DELETE FROM {table}"),[]).unwrap();
        if name!="clean" { conn.execute(&format!("INSERT INTO {table}(day) VALUES (?1)"),
            [if name=="today_dirty" {day}else{day-30}]).unwrap(); }
    }
}

#[test]
#[ignore="explicit Mac synthetic-only same-profile comparison"]
fn g1_4_measure_reports() {
    let now=std::env::var("AILOG_PERF_NOW").unwrap().parse().unwrap();
    for name in ["clean","today_dirty","day_30_before_dirty"] {
        scene(name,now);
        let conn=read(&path());
        for preset in ["7d","30d","90d","all"] {
            let range=Range {preset:Some(preset.into()),anchor:Some(now),..Default::default()};
            for report in ["overview","series","models","sessions","breakdown","pivot","model_handoffs","rework_rankings","usage_rhythm"] {
                if skipped(&format!("report/{name}/{preset}/{report}")) { continue; }
                for iteration in 0..4 {
                    let start=Instant::now(); let result=call(&conn,report,&range,now);
                    let wall_ms=start.elapsed().as_secs_f64()*1000.0;
                    let value=match result {
                        Ok(timings)=>serde_json::json!({"scene":name,"preset":preset,"report":report,"iteration":iteration,"wall_ms":wall_ms,"timings":timings}),
                        Err(error)=>serde_json::json!({"scene":name,"preset":preset,"report":report,"iteration":iteration,"wall_ms":wall_ms,"error":if error.contains("too many SQL variables") {"too_many_sql_variables"}else{"report_error"}}),
                    };
                    println!("G14_REPORT={value}");
                }
            }
        }
    }
    scene("clean",now);
}

#[tokio::test(flavor="multi_thread",worker_threads=4)]
#[ignore="explicit Mac synthetic-only real production gate comparison"]
async fn g1_4_measure_opening() {
    let now=std::env::var("AILOG_PERF_NOW").unwrap().parse().unwrap();
    for name in ["clean","today_dirty","day_30_before_dirty"] {
        scene(name,now);
        for preset in ["7d","30d","90d","all"] {
            for heavy in [false,true] {
                if skipped(&format!("opening/{name}/{preset}/{heavy}")) { continue; }
                for iteration in 0..4 {
                    let heavy_job=if heavy { Some(tokio::spawn(gated("model_handoffs","all",now))) } else { None };
                    // Give the real heavy query the first opportunity to
                    // occupy its production permit; report whether it lasts.
                    if heavy { tokio::time::sleep(std::time::Duration::from_millis(10)).await; }
                    let start=Instant::now();
                    let overview=tokio::spawn(gated("overview",preset,now));
                    let series=tokio::spawn(gated("series",preset,now));
                    let models=tokio::spawn(gated("models",preset,now));
                    let sessions=tokio::spawn(gated("sessions",preset,now));
                    let first=series.await.unwrap();
                    let breakdown=tokio::spawn(gated("breakdown",preset,now));
                    let pivot=tokio::spawn(gated("pivot",preset,now));
                    let values=[overview.await.unwrap(),first,models.await.unwrap(),sessions.await.unwrap(),breakdown.await.unwrap(),pivot.await.unwrap()];
                    let wall_ms=start.elapsed().as_secs_f64()*1000.0;
                    let overlapping=heavy_job.as_ref().map(|job|!job.is_finished()).unwrap_or(false);
                    let failures=values.iter().filter(|r|r.is_err()).count();
                    println!("G14_OPENING={}",serde_json::json!({"scene":name,"preset":preset,"heavy":heavy,"iteration":iteration,
                        "wall_ms":wall_ms,"heavy_active_through_light":overlapping,"report_failures":failures}));
                    if let Some(job)=heavy_job { let _=job.await.unwrap(); }
                }
            }
        }
    }
    scene("clean",now);
}

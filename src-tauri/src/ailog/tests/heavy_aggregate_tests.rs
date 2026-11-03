#[path="legacy_migrate_0900.rs"]
mod legacy_migrate_0900;

use rusqlite::{params,Connection};
use serde_json::Value;

use crate::ailog::{heavy_aggregate as agg,query,usage,Filters,Range};

fn retry_worker<T>(mut run: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match run() {
            Err(error) if error == "ailog product writer busy" && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(1));
            },
            result => return result,
        }
    }
}

fn build_next(conn: &mut Connection, bytes: Option<u64>, checkpoint: &dyn Fn(&str) -> Result<(), String>)
    -> Result<agg::Step, String> {
    retry_worker(|| agg::build_next(conn, bytes, checkpoint))
}

fn reconcile_startup(conn: &Connection, checkpoint: &dyn Fn(&str) -> Result<(), String>) -> Result<bool, String> {
    retry_worker(|| agg::reconcile_startup(conn, checkpoint))
}

fn record_idle_source_mark(conn: &Connection) -> Result<(), String> {
    retry_worker(|| agg::record_idle_source_mark(conn))
}

fn initialize(conn: &Connection) {
    crate::ailog::schema::init(conn).unwrap();
    crate::ailog::migrate::apply(conn).unwrap();
    agg::forget_startup_check(conn);
}

fn fixture() -> Connection {
    populated_fixture(Connection::open_in_memory().unwrap())
}

fn populated_fixture(conn: Connection) -> Connection {
    initialize(&conn);
    for session in 0..16 {
        let id=format!("session-{session:02}");
        conn.execute("INSERT INTO session(kind,session_id,origin,project_key,git_branch,cost_usd)
            VALUES ('codex',?1,?2,'project','main',2.0)",params![id,if session==15 { "ailog-internal" } else { "other" }]).unwrap();
        // Revisit days in sequence order, with gaps and missing names. A
        // per-day first/last pair alone would silently give wrong handoffs.
        // The final three eligible turns share a day: both raw and family
        // handoffs must exercise persisted in-day pairs, not only bridges.
        for (i,day) in [20000,20001,20000,20002,20001,20004,20004,20005,20005,20005].iter().enumerate() {
            let ts=agg::day_bounds(*day).0 + 3600000 + (i as i64)*1000;
            let model=if i==4 { None } else if i%2==0 { Some("gpt-5") } else { Some("gpt-6") };
            let family=if i==2 { None } else if i%3==0 { Some("gpt-5") } else { Some("gpt-6") };
            conn.execute("INSERT INTO turn(kind,session_id,seq,ts,model,model_family,input_tokens,
                output_tokens,cache_read_tokens,cache_write_5m_tokens,cost_usd,usage_state)
                VALUES ('codex',?1,?2,?3,?4,?5,20,3,2,1,0.125,?6)",
                params![id,(i*3) as i64,ts,model,family,if i==6 { "unresolved" } else { "legacy" }]).unwrap();
            conn.execute("INSERT INTO tool_event(kind,session_id,seq,ts,name,target,is_error)
                VALUES ('codex',?1,?2,?3,'Bash',?4,?5)",
                params![id,i as i64,ts,if i%2==0 { " cargo test " } else { "cargo test" },i%3==0]).unwrap();
        }
        for file in 0..14 {
            conn.execute("INSERT INTO file_touch(kind,session_id,path,edit_count)
                VALUES ('codex',?1,?2,?3)",params![id,format!("file-{file:02}"),if file==13 { 2 } else { 3+session%3 }]).unwrap();
        }
        // Null/blank targets must share a single NULL group. Success-only
        // executions remain in the denominator before the top-ten cutoff.
        conn.execute("INSERT INTO tool_event(kind,session_id,seq,ts,name,target,is_error)
            VALUES ('codex',?1,50,?2,'Bash','   ',0)",params![id,agg::day_bounds(20000).0+1]).unwrap();
    }
    // A tool-only session is not a selected session, even if events are in
    // range. The file totals have lifetime, rather than last_ts, semantics.
    conn.execute("INSERT INTO session(kind,session_id) VALUES ('codex','tool-only')",[]).unwrap();
    conn.execute("INSERT INTO tool_event(kind,session_id,seq,ts,name,is_error)
        VALUES ('codex','tool-only',0,?1,'ignored',1)",[agg::day_bounds(20000).0]).unwrap();
    crate::ailog::rollup::mark_all_dirty(&conn).unwrap();
    crate::ailog::rollup::rebuild_dirty(&conn).unwrap();
    conn
}

fn normalized(mut value: Value) -> Value {
    fn visit(value: &mut Value) {
        match value {
            Value::Object(map)=> {
                for name in ["timings","cache","indexFreshness"] { map.remove(name); }
                for child in map.values_mut() { visit(child); }
            },
            Value::Array(items)=>for child in items { visit(child); },
            _=>{},
        }
    }
    visit(&mut value); value
}

fn reports(conn:&Connection,range:&Range,filters:&Filters)->Vec<Value> {
    let mut values=Vec::new();
    for granularity in ["raw","family","provider"] {
        values.push(normalized(serde_json::to_value(query::model_handoffs(conn,range,filters,
            &query::ModelsOptions { granularity:granularity.into(),bucket:"day".into() },2_000_000_000_000).unwrap()).unwrap()));
    }
    values.push(normalized(serde_json::to_value(query::rework_rankings(conn,range,filters,2_000_000_000_000).unwrap()).unwrap()));
    values.push(normalized(serde_json::to_value(usage::rhythm(conn,range,filters,2_000_000_000_000).unwrap()).unwrap()));
    values
}

fn assert_matches_raw(conn:&Connection,range:&Range,filters:&Filters) {
    let actual=reports(conn,range,filters);
    // Turn off both aggregate families: rework's selected-key reader must
    // not get its reference keys from the older rollups either.
    let old:Option<String>=conn.query_row("SELECT value FROM index_state WHERE key='rollup_version'",[],|r|r.get(0)).ok();
    conn.execute("UPDATE index_state SET value='0' WHERE key IN ('heavy_aggregate_version','rollup_version')",[]).unwrap();
    let expected=reports(conn,range,filters);
    conn.execute("UPDATE index_state SET value='1' WHERE key='heavy_aggregate_version'",[]).unwrap();
    if let Some(old)=old { conn.execute("UPDATE index_state SET value=?1 WHERE key='rollup_version'",[old]).unwrap(); }
    assert_eq!(actual,expected,"daily/hybrid reports must equal completely raw reports");
}

fn ranges()->Vec<Range> {
    let (first,_)=agg::day_bounds(20000); let (_,last)=agg::day_bounds(20005);
    vec![
        Range { from:Some(first),to:Some(last),..Default::default() },
        Range { from:Some(first+3600500),to:Some(last-1000),..Default::default() },
        Range { from:Some(agg::day_bounds(20001).0),to:Some(agg::day_bounds(20002).1),..Default::default() },
        Range { from:Some(first-10_000_000_000),to:Some(last+10_000_000_000),..Default::default() },
    ]
}

fn finish(conn:&mut Connection) {
    loop { match build_next(conn,Some(u64::MAX),&|_|Ok(())).unwrap() {
        agg::Step::Complete=>break,agg::Step::Built(_)|agg::Step::Resetting=>{},other=>panic!("{other:?}"),
    }}
}

#[test]
fn daily_aggregate_reports_match_raw_in_every_build_and_dirty_scene() {
    let mut conn=fixture();
    // Partial initial build, empty days, and every progress boundary.
    loop {
        for range in ranges() { assert_matches_raw(&conn,&range,&Filters::default()); }
        if build_next(&mut conn,Some(u64::MAX),&|_|Ok(())).unwrap()==agg::Step::Complete { break; }
    }
    assert_eq!(conn.query_row("SELECT COUNT(DISTINCT granularity) FROM heavy_handoff_pair",[],|r|r.get::<_,i64>(0)).unwrap(),2,
        "fixture must exercise persisted in-day pairs for raw and family");
    for days in [vec![],vec![20000],vec![20002],vec![20000,20002,20005]] {
        conn.execute("DELETE FROM heavy_aggregate_dirty",[]).unwrap();
        for day in days {
            conn.execute("INSERT INTO heavy_aggregate_dirty(day) VALUES (?1)",[day]).unwrap();
            // If the reader accidentally uses a dirty day, each aggregate's
            // result changes visibly rather than matching a stale fixture.
            conn.execute("UPDATE heavy_handoff_pair SET n=n+111 WHERE day=?1",[day]).unwrap();
            conn.execute("UPDATE heavy_tool_day SET failures=failures+111 WHERE day=?1",[day]).unwrap();
            conn.execute("UPDATE heavy_rhythm_day SET turns=turns+111 WHERE day=?1",[day]).unwrap();
        }
        for range in ranges() { assert_matches_raw(&conn,&range,&Filters::default()); }
        finish(&mut conn);
    }
}

#[test]
fn daily_aggregate_filter_routes_and_top_ten_keep_original_semantics() {
    let mut conn=fixture(); finish(&mut conn);
    let filters=vec![
        Filters { kinds:vec!["codex".into()],..Default::default() },
        Filters { models:vec!["gpt-5".into()],..Default::default() },
        Filters { projects:vec!["project".into()],..Default::default() },
        Filters { branches:vec!["main".into()],..Default::default() },
        Filters { efforts:vec!["high".into()],..Default::default() },
        Filters { origins:vec!["ailog-internal".into()],..Default::default() },
        Filters { min_cost:Some(1.0),..Default::default() },
        Filters { query:Some("project".into()),..Default::default() },
    ];
    for filter in filters {
        assert!(!agg::eligible(&conn,&filter));
        for range in ranges() { assert_matches_raw(&conn,&range,&filter); }
    }
    let result=query::rework_rankings(&conn,&ranges()[0],&Filters::default(),2_000_000_000_000).unwrap();
    assert_eq!(result.rewritten_files.len(),10);
    assert_eq!(result.rewritten_files[0].path,"file-00");
    assert!(agg::eligible(&conn,&Filters { include_sidechain:true,..Default::default() }));
}

#[test]
fn daily_aggregate_chunk_interruption_rolls_back_and_resumes_after_reopen() {
    let dir=tempfile::tempdir().unwrap(); let path=dir.path().join("fixture.db");
    let mut conn=Connection::open(&path).unwrap(); initialize(&conn);
    conn.execute("INSERT INTO session(kind,session_id) VALUES ('codex','s')",[]).unwrap();
    for day in [20000,20001] {
        conn.execute("INSERT INTO turn(kind,session_id,seq,ts,model,model_family) VALUES ('codex','s',?1,?2,'a','a')",
            params![day,agg::day_bounds(day).0]).unwrap();
    }
    assert_eq!(build_next(&mut conn,Some(u64::MAX),&|_|Ok(())).unwrap(),agg::Step::Built(20000));
    let error=build_next(&mut conn,Some(u64::MAX),&|stage| {
        if stage=="tools" { Err("injected mid-chunk interruption".into()) } else { Ok(()) }
    }).unwrap_err();
    assert!(error.contains("interruption"));
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    drop(conn);
    let mut conn=Connection::open(&path).unwrap();
    assert_eq!(build_next(&mut conn,Some(u64::MAX),&|_|Ok(())).unwrap(),agg::Step::Built(20001));
    assert_eq!(build_next(&mut conn,Some(u64::MAX),&|_|Ok(())).unwrap(),agg::Step::Complete);
}

#[test]
fn daily_aggregate_ingestion_invalidation_survives_old_rollup_rebuild() {
    let mut conn=fixture(); finish(&mut conn);
    let tx=conn.transaction().unwrap();
    crate::ailog::rollup::mark_session_dirty(&tx,"codex","session-00").unwrap();
    tx.execute("UPDATE turn SET model='changed',model_family='changed' WHERE session_id='session-00'",[]).unwrap();
    tx.execute("UPDATE file_touch SET edit_count=edit_count+10 WHERE session_id='session-00'",[]).unwrap();
    tx.execute("DELETE FROM tool_event WHERE session_id='session-00'",[]).unwrap();
    crate::ailog::rollup::mark_session_dirty(&tx,"codex","session-00").unwrap();
    crate::ailog::rollup::rebuild_dirty(&tx).unwrap();
    tx.commit().unwrap();
    assert!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_dirty",[],|r|r.get::<_,i64>(0)).unwrap()>0);
    for range in ranges() { assert_matches_raw(&conn,&range,&Filters::default()); }
    while build_next(&mut conn,Some(u64::MAX),&|_|Ok(())).unwrap()!=agg::Step::Complete {
        for range in ranges() { assert_matches_raw(&conn,&range,&Filters::default()); }
    }
}

#[test]
fn daily_aggregate_low_space_new_and_legacy_database_are_additive() {
    let mut conn=Connection::open_in_memory().unwrap();
    crate::ailog::schema::init(&conn).unwrap();
    let definitions=|c:&Connection| {
        let mut s=c.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").unwrap();
        s.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))
            .unwrap().collect::<Result<Vec<_>,_>>().unwrap()
    };
    legacy_migrate_0900::apply(&conn).unwrap();
    let before=definitions(&conn);
    let old_versions:Vec<(String,String)>=conn.prepare("SELECT key,value FROM index_state WHERE key IN ('rollup_version','usage_rollup_version') ORDER BY key").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
    agg::migrate(&conn).unwrap();
    let after=definitions(&conn);
    for definition in before { assert!(after.contains(&definition),"existing schema changed: {}",definition.0); }
    agg::migrate(&conn).unwrap();
    conn.execute("INSERT INTO session(kind,session_id) VALUES ('codex','old-writer')",[]).unwrap();
    conn.execute("INSERT INTO turn(kind,session_id,seq,ts) VALUES ('codex','old-writer',0,1)",[]).unwrap();
    for bytes in [None,Some(0),Some(agg::MIN_FREE_BYTES-1)] {
        assert_eq!(build_next(&mut conn,bytes,&|_|panic!("must not begin a chunk")).unwrap(),agg::Step::LowDisk);
    }
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    let versions:Vec<(String,String)>=conn.prepare("SELECT key,value FROM index_state WHERE key IN ('rollup_version','usage_rollup_version') ORDER BY key").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(versions,old_versions);
    legacy_migrate_0900::apply(&conn).unwrap();
    conn.execute("UPDATE turn SET input_tokens=input_tokens+1 WHERE session_id='old-writer'",[]).unwrap();
    for range in ranges() { assert_matches_raw(&conn,&range,&Filters::default()); }
}

#[test]
fn rework_raw_key_diagnostics_distinguish_unknown_turns_from_measured_zero() {
    let conn=Connection::open_in_memory().unwrap();initialize(&conn);
    conn.execute("INSERT INTO session(kind,session_id,cost_usd) VALUES ('codex','only-turn',10)",[]).unwrap();
    let start=agg::day_bounds(20000).0;
    conn.execute("INSERT INTO turn(kind,session_id,seq,ts,input_tokens) VALUES ('codex','only-turn',0,?1,1)",[start+1000]).unwrap();
    agg::mark_session_dirty(&conn,"codex","only-turn").unwrap();
    agg::record_source_mark(&conn).unwrap();
    assert!(reconcile_startup(&conn,&|_|Ok(())).unwrap());
    let range=Range {from:Some(start+500),to:Some(start+1500),..Default::default()};
    let measured=query::rework_rankings(&conn,&range,&Filters::default(),start+2000).unwrap();
    assert!(measured.failed_commands.is_empty() && measured.rewritten_files.is_empty());
    assert!(measured.timings.raw_rows>0);
    assert_eq!(measured.timings.raw_turns,2);
    assert!(measured.timings.raw_turns_measured);
    conn.execute("UPDATE index_state SET value='0' WHERE key='heavy_aggregate_version'",[]).unwrap();
    for filter in [Filters::default(),Filters {min_cost:Some(1.0),..Default::default()}] {
        let report=query::rework_rankings(&conn,&range,&filter,start+2000).unwrap();
        assert!(report.failed_commands.is_empty() && report.rewritten_files.is_empty());
        assert!(report.timings.rows_scanned>0);
        assert_eq!(report.timings.raw_rows,report.timings.rows_scanned);
        assert_eq!(report.timings.raw_turns,0);
        assert!(!report.timings.raw_turns_measured,"DISTINCT session keys do not measure input turn count");
    }
    let empty=Range {from:Some(start-100),to:Some(start-1),..Default::default()};
    conn.execute("UPDATE index_state SET value='1' WHERE key='heavy_aggregate_version'",[]).unwrap();
    let measured_zero=query::rework_rankings(&conn,&empty,&Filters::default(),start+2000).unwrap();
    assert_eq!(measured_zero.timings.raw_turns,0);
    assert!(measured_zero.timings.raw_turns_measured);
}

#[tokio::test(flavor="multi_thread",worker_threads=4)]
#[ignore="explicit Mac synthetic fixture only; build resources and real light reports"]
async fn daily_aggregate_measure_background_build() {
    use std::time::Instant;
    use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
    assert!(!cfg!(windows));
    let path=std::path::PathBuf::from(std::env::var("AILOG_G14_SYNTHETIC_DB").unwrap());
    assert_eq!(path.file_name().unwrap(),"g1-4-synthetic.db");
    assert!(path.to_string_lossy().contains("/04_macrun/mirrors/mycmux-wt-grass-perf-261030-"));
    let now:i64=std::env::var("AILOG_PERF_NOW").unwrap().parse().unwrap();
    let conn=Connection::open(&path).unwrap();
    let marker:String=conn.query_row("SELECT value FROM index_state WHERE key='g1_3_synthetic_only'",[],|r|r.get(0)).unwrap();
    assert_eq!(marker,"random-fixture-from-spec-only-v2");
    agg::migrate(&conn).unwrap();
    drop(conn);
    let active=Arc::new(AtomicBool::new(false));
    let mut worker=None;
    for building in [false,true] {
        if building {
            let path=path.clone(); let active=active.clone();
            active.store(true,Ordering::Release);
            worker=Some(tokio::task::spawn_blocking(move || {
                agg::lower_priority();
                let mut conn=Connection::open(&path).unwrap();
                conn.execute_batch("PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA busy_timeout=100;").unwrap();
                let started=Instant::now();let mut days=0;let mut slowest=0.0_f64;
                loop {
                    let t=Instant::now();
                    match build_next(&mut conn,Some(u64::MAX),&|_|Ok(())).unwrap() {
                        agg::Step::Built(_)=>{days+=1;slowest=slowest.max(t.elapsed().as_secs_f64()*1000.0);},
                        agg::Step::Resetting=>{},
                        agg::Step::Complete=>break,other=>panic!("{other:?}"),
                    }
                    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)").unwrap();
                    std::thread::sleep(std::time::Duration::from_millis(agg::YIELD_MS));
                }
                let elapsed_ms=started.elapsed().as_secs_f64()*1000.0;
                active.store(false,Ordering::Release);
                #[cfg(unix)]
                let max_rss=unsafe {let mut usage:libc::rusage=std::mem::zeroed();libc::getrusage(libc::RUSAGE_SELF,&mut usage);usage.ru_maxrss};
                #[cfg(not(unix))]
                let max_rss=0_i64;
                println!("G14_BUILD={}",serde_json::json!({"days":days,"elapsed_ms":elapsed_ms,"slowest_day_ms":slowest,"max_rss_native":max_rss,
                    "rss_unit":if cfg!(target_os="macos") {"bytes"}else{"KiB"},"sleep_per_day_ms":agg::YIELD_MS,"cache_mib":8}));
            }));
        }
        for iteration in 0..4 {
            for preset in ["7d","30d","90d","all"] {
                let start=Instant::now();
                let a=tokio::spawn(super::g1_4_measure::gated("overview",preset,now));
                let b=tokio::spawn(super::g1_4_measure::gated("series",preset,now));
                let c=tokio::spawn(super::g1_4_measure::gated("models",preset,now));
                let d=tokio::spawn(super::g1_4_measure::gated("sessions",preset,now));
                let e=tokio::spawn(super::g1_4_measure::gated("breakdown",preset,now));
                let f=tokio::spawn(super::g1_4_measure::gated("pivot",preset,now));
                let results=[a.await.unwrap(),b.await.unwrap(),c.await.unwrap(),d.await.unwrap(),e.await.unwrap(),f.await.unwrap()];
                println!("G14_BUILD_LIGHT={}",serde_json::json!({"building":building,"preset":preset,"iteration":iteration,
                    "wall_ms":start.elapsed().as_secs_f64()*1000.0,"builder_active_at_end":active.load(Ordering::Acquire),
                    "failures":results.iter().filter(|r|r.is_err()).count()}));
            }
        }
    }
    worker.unwrap().await.unwrap();
    let mut conn=Connection::open(&path).unwrap();
    let day=(now+agg::SHIFT_MS)/agg::DAY_MS-30;
    conn.execute("INSERT OR IGNORE INTO heavy_aggregate_dirty(day) VALUES (?1)",[day]).unwrap();
    let start=Instant::now();
    assert_eq!(build_next(&mut conn,Some(u64::MAX),&|_|Ok(())).unwrap(),agg::Step::Built(day));
    println!("G14_REBUILD_DAY={}",serde_json::json!({"elapsed_ms":start.elapsed().as_secs_f64()*1000.0}));
}

#[test]
fn daily_aggregate_tool_only_updates_invalidate_event_days_before_and_after_reset() {
    let mut conn=Connection::open_in_memory().unwrap();initialize(&conn);
    for (id,day) in [("only-first-day",20000),("second-day",20001)] {
        conn.execute("INSERT INTO session(kind,session_id) VALUES ('codex',?1)",[id]).unwrap();
        conn.execute("INSERT INTO turn(kind,session_id,seq,ts,model,model_family) VALUES ('codex',?1,0,?2,'a','a')",params![id,agg::day_bounds(day).0+1000]).unwrap();
    }
    let event_time=agg::day_bounds(20001).0+2000;
    conn.execute("INSERT INTO tool_event(kind,session_id,seq,ts,name,target,is_error) VALUES ('codex','only-first-day',0,?1,'Bash','test',0)",[event_time]).unwrap();
    finish(&mut conn);
    let range=Range {from:Some(agg::day_bounds(20000).0),to:Some(agg::day_bounds(20001).1),..Default::default()};
    conn.execute("INSERT INTO tool_event(kind,session_id,seq,ts,name,target,is_error) VALUES ('codex','only-first-day',1,?1,'Bash','test',1)",[event_time+1]).unwrap();
    crate::ailog::rollup::mark_session_dirty(&conn,"codex","only-first-day").unwrap();
    crate::ailog::rollup::rebuild_dirty(&conn).unwrap();
    let event_day_dirty:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM heavy_aggregate_dirty WHERE day=20001)",[],|r|r.get(0)).unwrap();
    assert!(event_day_dirty,"tool timestamps can fall on a day without this session's turns");
    assert_matches_raw(&conn,&range,&Filters::default());finish(&mut conn);
    let report=query::rework_rankings(&conn,&range,&Filters::default(),2_000_000_000_000).unwrap();
    assert_eq!(report.failed_commands[0].executions,2);assert_eq!(report.failed_commands[0].failures,1);
    crate::ailog::rollup::mark_session_dirty(&conn,"codex","only-first-day").unwrap();
    conn.execute("DELETE FROM tool_event WHERE session_id='only-first-day'",[]).unwrap();
    crate::ailog::rollup::mark_session_dirty(&conn,"codex","only-first-day").unwrap();
    crate::ailog::rollup::rebuild_dirty(&conn).unwrap();
    assert!(conn.query_row("SELECT EXISTS(SELECT 1 FROM heavy_aggregate_dirty WHERE day=20001)",[],|r|r.get::<_,bool>(0)).unwrap());
    assert_matches_raw(&conn,&range,&Filters::default());finish(&mut conn);
    assert_matches_raw(&conn,&range,&Filters::default());
}

#[test]
fn full_reingest_clears_heavy_state_for_empty_removed_and_cancelled_inputs() {
    use super::fixtures::{Fixture, CLAUDE_MIXED_MODELS};
    use crate::ailog::{index::{self,IndexOptions},KIND_CLAUDE};
    use std::sync::{Arc,atomic::AtomicBool};
    for scene in ["empty","removed","cancelled"] {
        let f=Fixture::new();
        let mut conn=populated_fixture(Connection::open(&f.db).unwrap());
        conn.execute("INSERT OR REPLACE INTO index_state(key,value) VALUES ('derivation_version','project-work-v2')",[]).unwrap();
        finish(&mut conn);
        assert!(conn.query_row("SELECT COUNT(*) FROM heavy_handoff_pair",[],|r|r.get::<_,i64>(0)).unwrap()>0);
        drop(conn);
        // Old fixture sessions live on days the replacement will never touch.
        if scene!="empty" { f.write("replacement.jsonl",CLAUDE_MIXED_MODELS); }
        // run_index clears full input before observing cancellation while
        // queuing sources. Nonempty input is therefore left unimported here.
        let cancel=Arc::new(AtomicBool::new(scene=="cancelled"));
        let mut options=IndexOptions::new(f.db.clone());
        options.full=true;options.roots=vec![(KIND_CLAUDE,f.logs.clone())];
        let runtime=tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let report=runtime.block_on(index::run_index(options,cancel,None)).unwrap();
        assert!(report.errors.is_empty(),"{:?}",report.errors);
        assert_eq!(report.cancelled,scene=="cancelled");
        if scene=="cancelled" { assert_eq!(report.files_done,0,"cancelled replacement must leave input unimported"); }
        let mut conn=f.conn();
        for table in ["heavy_aggregate_day","heavy_aggregate_dirty","heavy_session_day",
            "heavy_handoff_chunk","heavy_handoff_pair","heavy_tool_day","heavy_file_session",
            "heavy_file_ready","heavy_rhythm_day"] {
            // Dirty rows from the new import are expected, published values are not.
            if table=="heavy_aggregate_dirty" || table=="heavy_file_ready" { continue; }
            assert_eq!(conn.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get::<_,i64>(0)).unwrap(),0,
                "full import must clear {table} atomically");
        }
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM index_state WHERE key='heavy_aggregate_cursor'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_version'",[],|r|r.get::<_,String>(0)).unwrap(),agg::VERSION);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM session WHERE session_id LIKE 'session-%'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        for range in ranges().into_iter().chain([Range::default()]) {
            assert_matches_raw(&conn,&range,&Filters::default());
        }
        drop(conn);
        conn=Connection::open(&f.db).unwrap();initialize(&conn);
        for range in ranges().into_iter().chain([Range::default()]) {
            assert_matches_raw(&conn,&range,&Filters::default());
        }
        finish(&mut conn);
        for range in ranges().into_iter().chain([Range::default()]) {
            assert_matches_raw(&conn,&range,&Filters::default());
        }
    }
}

#[test]
fn full_reingest_heavy_reset_rolls_back_with_the_raw_reset() {
    use super::fixtures::Fixture;
    use crate::ailog::{index::{self,IndexOptions},KIND_CLAUDE};
    use std::sync::{Arc,atomic::AtomicBool};
    let f=Fixture::new();
    let mut conn=populated_fixture(Connection::open(&f.db).unwrap());finish(&mut conn);
    let before=reports(&conn,&ranges()[0],&Filters::default());
    conn.execute_batch("CREATE TRIGGER abort_heavy_clear BEFORE DELETE ON heavy_rhythm_day
        BEGIN SELECT RAISE(ABORT,'injected clear rollback'); END;").unwrap();
    drop(conn);
    let mut options=IndexOptions::new(f.db.clone());
    options.full=true;options.roots=vec![(KIND_CLAUDE,f.logs.clone())];
    let runtime=tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let error=runtime.block_on(index::run_index(options,Arc::new(AtomicBool::new(false)),None)).unwrap_err();
    assert!(error.contains("injected clear rollback"));
    let conn=f.conn();
    assert_eq!(reports(&conn,&ranges()[0],&Filters::default()),before,
        "raw and heavy reset must roll back together");
    assert_matches_raw(&conn,&ranges()[0],&Filters::default());
}

fn trace_reports(conn:&Connection,range:&Range)->(Vec<Value>,Vec<String>) {
    use std::{ffi::{c_void,CStr},os::raw::c_int};
    unsafe extern "C" fn observe(_:u32,data:*mut c_void,stmt:*mut c_void,_:*mut c_void)->c_int {
        let sql=unsafe { rusqlite::ffi::sqlite3_sql(stmt.cast()) };
        if !sql.is_null() {
            let text=unsafe { CStr::from_ptr(sql) }.to_string_lossy().into_owned();
            unsafe { &mut *data.cast::<Vec<String>>() }.push(text);
        }
        0
    }
    let mut sql=Vec::<String>::new();
    unsafe {
        assert_eq!(rusqlite::ffi::sqlite3_trace_v2(conn.handle(),rusqlite::ffi::SQLITE_TRACE_STMT as u32,
            Some(observe),(&mut sql as *mut Vec<String>).cast()),0);
    }
    let values=reports(conn,range,&Filters::default());
    unsafe { assert_eq!(rusqlite::ffi::sqlite3_trace_v2(conn.handle(),0,None,std::ptr::null_mut()),0); }
    (values,sql)
}

#[test]
fn unbuilt_low_disk_and_many_dirty_days_use_complete_g13_readers() {
    let mut conn=fixture();
    for day in 20006..20010 {
        conn.execute("INSERT INTO turn(kind,session_id,seq,ts,model,model_family,input_tokens)
            VALUES ('codex','session-00',?1,?2,'gpt-6','gpt-6',7)",
            params![day,agg::day_bounds(day).0+1000]).unwrap();
    }
    crate::ailog::rollup::mark_all_dirty(&conn).unwrap();
    crate::ailog::rollup::rebuild_dirty(&conn).unwrap();
    assert!(crate::ailog::rollup::ready(&conn).unwrap());
    let range=Range::default();let resolved=range.resolve(2_000_000_000_000).0;
    for scene in ["empty","low-disk","partial","many-dirty"] {
        match scene {
            "low-disk"=>assert_eq!(build_next(&mut conn,Some(agg::MIN_FREE_BYTES-1),
                &|_|panic!("low disk must not build")).unwrap(),agg::Step::LowDisk),
            "partial"=>{build_next(&mut conn,Some(u64::MAX),&|_|Ok(())).unwrap();},
            "many-dirty"=>{
                finish(&mut conn);
                for day in 20000..20008 { conn.execute("INSERT INTO heavy_aggregate_dirty(day) VALUES (?1)",[day]).unwrap(); }
            },
            _=>{},
        }
        assert!(!agg::eligible_for_range(&conn,&Filters::default(),&resolved),
            "{scene} must retain the complete G1-3 path");
        let (actual,sql)=trace_reports(&conn,&range);
        assert!(!sql.iter().any(|s|s.starts_with("WITH ready AS MATERIALIZED")),
            "{scene} must not read heavy SQL with raw compensation");
        assert!(sql.iter().any(|s|s.contains("rollup_turn_session_day")),
            "{scene} must retain G1-3 selected-key rollups");
        assert!(sql.iter().filter(|s|s.contains("FROM turn t NOT INDEXED")).count()>=3,
            "{scene} must retain G1-3 all-history handoff/rhythm scans");
        conn.execute("UPDATE index_state SET value='0' WHERE key='heavy_aggregate_version'",[]).unwrap();
        let expected=reports(&conn,&range,&Filters::default());
        conn.execute("UPDATE index_state SET value='1' WHERE key='heavy_aggregate_version'",[]).unwrap();
        assert_eq!(actual,expected,"G1-3 fallback values must match");
        assert_matches_raw(&conn,&range,&Filters::default());
    }
    conn.execute("DELETE FROM heavy_aggregate_dirty WHERE day=20007",[]).unwrap();
    assert!(agg::eligible_for_range(&conn,&Filters::default(),&resolved),"seven published dirty days may use hybrid");
    conn.execute("DELETE FROM heavy_aggregate_day WHERE day=20009",[]).unwrap();
    assert!(!agg::eligible_for_range(&conn,&Filters::default(),&resolved),"a missing published day never qualifies as a small dirty gap");
    finish(&mut conn);
    // The range ends inside an unbuilt boundary day; its raw interval is small
    // and no complete selected day is missing.
    conn.execute("DELETE FROM heavy_aggregate_day WHERE day=20009",[]).unwrap();
    let partial=Range {from:Some(agg::day_bounds(20008).0),to:Some(agg::day_bounds(20009).0+3600000),..Default::default()};
    assert!(agg::eligible_for_range(&conn,&Filters::default(),&partial.resolve(2_000_000_000_000).0));
    assert_matches_raw(&conn,&partial,&Filters::default());
}

#[path="legacy_io_0900.rs"]
mod legacy_io_0900;

#[test]
fn frozen_0900_read_write_and_two_reopens_keep_nonempty_updated_values() {
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("legacy-roundtrip.db");
    let mut conn=Connection::open(&path).unwrap();initialize(&conn);
    let a=agg::day_bounds(20000).0;let b=agg::day_bounds(20001).0;
    for (request,seq,ts,model,input) in [("r0",0,a+3600000,"a",10),("r1",1,a+7200000,"b",20),("r2",2,b+3600000,"a",30)] {
        legacy_io_0900::ingest(&conn,request,seq,ts,model,input,2);
    }
    crate::ailog::rollup::mark_all_dirty(&conn).unwrap();
    crate::ailog::rollup::rebuild_dirty(&conn).unwrap();finish(&mut conn);
    let old=reports(&conn,&ranges()[0],&Filters::default());
    assert!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day",[],|r|r.get::<_,i64>(0)).unwrap()>0);
    drop(conn);
    // First old-version reopen reads the already populated new-schema DB.
    let legacy=legacy_io_0900::open(&path);
    assert_eq!(legacy_io_0900::light(&legacy),vec![("legacy".into(),3,0.375)]);
    assert_eq!(legacy_io_0900::rhythm(&legacy),vec![(20000,1,1,10,2),(20000,2,1,20,2),(20001,1,1,30,2)]);
    legacy_io_0900::ingest(&legacy,"r0",0,a+3600000,"a",99,3);
    legacy_io_0900::ingest(&legacy,"r3",3,b+7200000,"c",40,2);
    assert_eq!(legacy_io_0900::light(&legacy),vec![("legacy".into(),4,0.5)]);
    drop(legacy);
    // Second old-version reopen asserts the updated values and exact order.
    let legacy=legacy_io_0900::open(&path);
    assert_eq!(legacy_io_0900::light(&legacy),vec![("legacy".into(),4,0.5)]);
    assert_eq!(legacy_io_0900::rhythm(&legacy),vec![(20000,1,1,99,3),(20000,2,1,20,2),(20001,1,1,30,2),(20001,2,1,40,2)]);
    agg::forget_startup_check(&legacy);
    assert!(!agg::eligible(&legacy,&Filters::default()),"a new process waits for startup reconciliation");
    drop(legacy);
    let mut conn=Connection::open(&path).unwrap();initialize(&conn);
    assert!(!agg::eligible(&conn,&Filters::default()),"new reopen must wait for the background check");
    assert_eq!(build_next(&mut conn,Some(u64::MAX),&|_|Ok(())).unwrap(),agg::Step::Resetting);
    assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_reset'",[],|r|r.get::<_,String>(0)).unwrap(),"0");
    assert_ne!(reports(&conn,&ranges()[0],&Filters::default()),old,"old writes must change nonempty report values");
    for range in ranges().into_iter().chain([Range::default()]) { assert_matches_raw(&conn,&range,&Filters::default()); }
    finish(&mut conn);drop(conn);
    let conn=Connection::open(&path).unwrap();initialize(&conn);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_dirty",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    for range in ranges().into_iter().chain([Range::default()]) { assert_matches_raw(&conn,&range,&Filters::default()); }
}

#[test]
fn frozen_0900_file_only_write_invalidates_lifetime_values_on_new_reopen() {
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("legacy-file.db");
    let mut conn=populated_fixture(Connection::open(&path).unwrap());finish(&mut conn);
    drop(conn);
    let legacy=legacy_io_0900::open(&path);
    legacy.execute(legacy_io_0900::FILE_SQL,params!["codex","session-00","file-00",99,0,
        agg::day_bounds(20000).0,agg::day_bounds(20000).0]).unwrap();
    drop(legacy);
    let mut conn=Connection::open(&path).unwrap();initialize(&conn);
    assert_matches_raw(&conn,&ranges()[0],&Filters::default());
    finish(&mut conn);
    assert_matches_raw(&conn,&ranges()[0],&Filters::default());
}

#[test]
fn old_full_clear_and_missing_source_mark_cannot_publish_stale_days() {
    let mut conn=fixture();finish(&mut conn);
    // Old clear_all does not know heavy tables or call any new hook.
    conn.execute_batch("DELETE FROM session; DELETE FROM turn; DELETE FROM tool_event; DELETE FROM file_touch;
        DELETE FROM rollup_turn_session_day; DELETE FROM rollup_dirty;").unwrap();
    agg::forget_startup_check(&conn);
    agg::migrate(&conn).unwrap();
    for range in ranges() { assert_matches_raw(&conn,&range,&Filters::default()); }
    finish(&mut conn);
    for range in ranges() { assert_matches_raw(&conn,&range,&Filters::default()); }
    let mut conn=fixture();finish(&mut conn);
    // A database already extended by G1-4 has no source fingerprint yet.
    conn.execute("DELETE FROM index_state WHERE key='heavy_aggregate_source_mark'",[]).unwrap();
    agg::forget_startup_check(&conn);
    agg::migrate(&conn).unwrap();
    assert!(!agg::eligible(&conn,&Filters::default()));
    assert_eq!(build_next(&mut conn,Some(u64::MAX),&|_|Ok(())).unwrap(),agg::Step::Resetting);
    for range in ranges() { assert_matches_raw(&conn,&range,&Filters::default()); }
    finish(&mut conn);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_dirty",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn fingerprint_revision_covers_writes_without_source_file_and_removes_prototype() {
    let mut conn=fixture();finish(&mut conn);
    let mark=agg::source_mark(&conn).unwrap();
    // Both paths exist in 5db18863b: derived repricing updates turn values;
    // internal-origin backfill updates session metadata without source_file.
    conn.execute("UPDATE turn SET cost_usd=cost_usd+1 WHERE session_id='session-00'",[]).unwrap();
    assert_ne!(agg::source_mark(&conn).unwrap(),mark);
    agg::forget_startup_check(&conn);
    agg::migrate(&conn).unwrap();
    assert_matches_raw(&conn,&ranges()[0],&Filters::default());finish(&mut conn);
    let mark=agg::source_mark(&conn).unwrap();
    conn.execute("UPDATE session SET origin='ailog-internal' WHERE session_id='session-00'",[]).unwrap();
    assert_ne!(agg::source_mark(&conn).unwrap(),mark);
    agg::forget_startup_check(&conn);
    agg::migrate(&conn).unwrap();
    assert_matches_raw(&conn,&ranges()[0],&Filters::default());finish(&mut conn);
    // The unshipped prototype can be safely opened by the correction.
    conn.execute_batch("CREATE TABLE heavy_aggregate_untracked_session(kind TEXT,session_id TEXT);
        CREATE TRIGGER heavy_legacy_turn_insert AFTER INSERT ON turn BEGIN SELECT 1; END;
        INSERT INTO index_state(key,value) VALUES ('heavy_aggregate_writer_guard','1');").unwrap();
    agg::migrate(&conn).unwrap();
    let remnants:i64=conn.query_row("SELECT COUNT(*) FROM sqlite_master
        WHERE name='heavy_aggregate_untracked_session' OR name GLOB 'heavy_legacy_*'",[],|r|r.get(0)).unwrap();
    assert_eq!(remnants,0,"correction must remove prototype schema");
    let existing:i64=conn.query_row("SELECT COUNT(*) FROM sqlite_master
        WHERE type='trigger' AND name GLOB 'report_revision_*'",[],|r|r.get(0)).unwrap();
    assert_eq!(existing,24,"the old application's revision triggers must remain unchanged");
    assert_matches_raw(&conn,&ranges()[0],&Filters::default());
}

#[test]
fn rework_diagnostics_count_each_sql_raw_key_input() {
    let conn=Connection::open_in_memory().unwrap();initialize(&conn);
    let start=agg::day_bounds(20000).0;
    conn.execute("INSERT INTO session(kind,session_id) VALUES ('codex','one')",[]).unwrap();
    conn.execute("INSERT INTO turn(kind,session_id,seq,ts) VALUES ('codex','one',0,?1)",[start+1000]).unwrap();
    conn.execute("INSERT INTO tool_event(kind,session_id,seq,ts,name,target,is_error)
        VALUES ('codex','one',0,?1,'Bash','test',1)",[start+1000]).unwrap();
    conn.execute("INSERT INTO file_touch(kind,session_id,path,edit_count) VALUES ('codex','one','a.rs',4)",[]).unwrap();
    agg::mark_session_dirty(&conn,"codex","one").unwrap();
    agg::record_source_mark(&conn).unwrap();
    assert!(reconcile_startup(&conn,&|_|Ok(())).unwrap());
    let range=Range {from:Some(start+500),to:Some(start+1500),..Default::default()};
    assert!(agg::eligible_for_range(&conn,&Filters::default(),&range.resolve(start+2000).0));
    let tool_keys:i64=conn.query_row(agg::TOOL_SQL,params![start+500,start+1500],|r|r.get(4)).unwrap();
    let file_keys:i64=conn.query_row(agg::FILE_SQL,params![start+500,start+1500],|r|r.get(5)).unwrap();
    assert_eq!(tool_keys,1);assert_eq!(file_keys,1);
    let report=query::rework_rankings(&conn,&range,&Filters::default(),start+2000).unwrap();
    assert_eq!(report.failed_commands.len(),1);assert_eq!(report.rewritten_files.len(),1);
    assert_eq!(report.timings.raw_turns,2,"both SQL statements read the selection turn");
    assert_eq!(report.timings.raw_rows,4,"two key inputs, one event, one file");
    assert_eq!(report.timings.rows_scanned,4);
    assert_eq!(report.timings.rollup_rows,0);
    assert!(report.timings.raw_turns_measured);
    assert_matches_raw(&conn,&range,&Filters::default());
}

#[test]
fn partial_initial_build_complements_unbuilt_intervals_from_raw() {
    let mut conn=fixture();
    assert_eq!(build_next(&mut conn,Some(u64::MAX),&|_|Ok(())).unwrap(),agg::Step::Built(20000));
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day WHERE day=20001",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    // Exercise the SQL's unbuilt full-day gap independently of the public
    // range gate, which correctly retains G1-3 for this initial-build scene.
    let all=ranges()[0].clone();
    let resolved=all.resolve(2_000_000_000_000).0;
    assert!(!agg::eligible_for_range(&conn,&Filters::default(),&resolved));
    let (actual,_)=agg::read_handoffs(&conn,&resolved,"raw").unwrap();
    conn.execute("UPDATE index_state SET value='0' WHERE key='heavy_aggregate_version'",[]).unwrap();
    let expected=query::model_handoffs(&conn,&all,&Filters::default(),
        &query::ModelsOptions {granularity:"raw".into(),bucket:"day".into()},2_000_000_000_000).unwrap();
    conn.execute("UPDATE index_state SET value='1' WHERE key='heavy_aggregate_version'",[]).unwrap();
    assert_eq!(serde_json::to_value(actual).unwrap(),serde_json::to_value(expected.handoffs).unwrap(),
        "unbuilt intervals must retain raw handoffs");
    // A fully ready complete day plus an unbuilt partial boundary interval is
    // an allowed public hybrid request; all four outputs must also match raw.
    let range=Range {from:Some(agg::day_bounds(20000).0),
        to:Some(agg::day_bounds(20001).0+7200000),..Default::default()};
    assert!(agg::eligible_for_range(&conn,&Filters::default(),&range.resolve(2_000_000_000_000).0));
    assert_matches_raw(&conn,&range,&Filters::default());
}

fn observe_sql(conn: &Connection, sql: &mut Vec<String>) {
    use std::{ffi::{c_void, CStr}, os::raw::c_int};
    unsafe extern "C" fn observe(_: u32, data: *mut c_void, stmt: *mut c_void, _: *mut c_void) -> c_int {
        let text = unsafe { rusqlite::ffi::sqlite3_sql(stmt.cast()) };
        if !text.is_null() {
            unsafe { &mut *data.cast::<Vec<String>>() }
                .push(unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned());
        }
        0
    }
    unsafe {
        assert_eq!(rusqlite::ffi::sqlite3_trace_v2(conn.handle(),
            rusqlite::ffi::SQLITE_TRACE_STMT as u32, Some(observe),
            (sql as *mut Vec<String>).cast()), 0);
    }
}

#[test]
fn first_foreground_open_never_scans_turns_or_resets_heavy_tables() {
    for scene in ["0900-no-tables-or-mark", "mismatched-published-tables"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("startup.db");
        let before;
        if scene == "0900-no-tables-or-mark" {
            let conn = legacy_io_0900::open(&path);
            legacy_io_0900::ingest(&conn, "r0", 0, agg::day_bounds(20000).0, "a", 10, 2);
            legacy_io_0900::ingest(&conn, "r1", 1, agg::day_bounds(20002).0, "b", 20, 3);
            before = 0;
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM sqlite_master
                WHERE name='heavy_aggregate_day'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM index_state
                WHERE key='heavy_aggregate_source_mark'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        } else {
            let mut conn = populated_fixture(Connection::open(&path).unwrap());
            finish(&mut conn);
            before = conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day", [],
                |r| r.get::<_, i64>(0)).unwrap();
            agg::forget_startup_check(&conn);
            conn.execute("UPDATE turn SET input_tokens=input_tokens+1", []).unwrap();
        }
        let mut sql = Vec::new();
        crate::ailog::db::ensure_initialized_observed(&path, |conn| observe_sql(conn, &mut sql)).unwrap();
        let reader = crate::ailog::db::reader(&path).unwrap();
        let history_work: Vec<_> = sql.iter().filter(|s| {
            let s = s.to_ascii_lowercase();
            !s.trim_start().starts_with("create ") && (
                s.contains("from turn") || s.contains("heavy_aggregate_source_mark")
                || s.contains("delete from heavy_") || s.contains("update heavy_")
                || s.contains("insert or ignore into heavy_aggregate_dirty"))
        }).collect();
        assert!(history_work.is_empty(),
            "foreground must not scan turns, reconcile fingerprints or reset tables: {history_work:?}");
        assert_eq!(reader.query_row("SELECT COUNT(*) FROM heavy_aggregate_day", [],
            |r| r.get::<_, i64>(0)).unwrap(), before, "foreground preserves existing publications");
        assert!(!agg::eligible(&reader, &Filters::default()));
        drop(reader);
        let mut conn = Connection::open(&path).unwrap();
        assert_eq!(build_next(&mut conn, Some(agg::MIN_FREE_BYTES - 1),
            &|_| panic!("low disk must not reconcile")).unwrap(), agg::Step::LowDisk);
        assert!(!agg::eligible(&conn, &Filters::default()));
        if before == 0 {
            assert_eq!(build_next(&mut conn, Some(u64::MAX), &|_| Ok(())).unwrap(), agg::Step::Built(20000));
        } else {
            assert_eq!(build_next(&mut conn, Some(u64::MAX), &|_| Ok(())).unwrap(), agg::Step::Resetting);
            assert_eq!(conn.query_row("SELECT value FROM index_state
                WHERE key='heavy_aggregate_reset'", [], |r| r.get::<_, String>(0)).unwrap(), "0");
            assert!(!agg::eligible(&conn, &Filters::default()));
        }
        finish(&mut conn);
        assert!(agg::eligible_for_range(&conn, &Filters::default(),
            &Range::default().resolve(2_000_000_000_000).0));
        assert_matches_raw(&conn, &Range::default(), &Filters::default());
        println!("G16_FOREGROUND scene={scene} statements={} history_operations=0", sql.len());
    }
}

#[test]
fn startup_reset_is_bounded_durable_and_resumes_after_interruption() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("reset.db");
    let mut conn = populated_fixture(Connection::open(&path).unwrap());
    finish(&mut conn);
    for i in 0..800 {
        conn.execute("INSERT INTO heavy_file_session(kind,session_id,path,edit_count)
            VALUES ('codex','stale',?1,999)", [format!("stale-{i}")]).unwrap();
    }
    conn.execute("UPDATE turn SET input_tokens=input_tokens+1", []).unwrap();
    agg::forget_startup_check(&conn);
    let error = build_next(&mut conn, Some(u64::MAX), &|stage| {
        if stage == "reset_mark" { Err("interrupted after durable reset mark".into()) } else { Ok(()) }
    }).unwrap_err();
    assert!(error.contains("durable reset mark"));
    assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_reset'",
        [], |r| r.get::<_, String>(0)).unwrap(), "0");
    let published = conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day", [],
        |r| r.get::<_, i64>(0)).unwrap();
    let error = build_next(&mut conn, Some(u64::MAX), &|stage| {
        if stage == "reset_commit" { Err("interrupted reset transaction".into()) } else { Ok(()) }
    }).unwrap_err();
    assert!(error.contains("reset transaction"));
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day", [],
        |r| r.get::<_, i64>(0)).unwrap(), published, "an interrupted batch rolls back");
    while conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_reset'",
        [], |r| r.get::<_, String>(0)).unwrap() != "6" {
        assert_eq!(build_next(&mut conn, Some(u64::MAX), &|_| Ok(())).unwrap(), agg::Step::Resetting);
    }
    let rows = conn.query_row("SELECT COUNT(*) FROM heavy_file_session", [],
        |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(build_next(&mut conn, Some(u64::MAX), &|_| Ok(())).unwrap(), agg::Step::Resetting);
    assert_eq!(rows - conn.query_row("SELECT COUNT(*) FROM heavy_file_session", [],
        |r| r.get::<_, i64>(0)).unwrap(), agg::RESET_BATCH_ROWS as i64,
        "one reset transaction removes at most one bounded batch");
    // New ingestion before the startup check cannot overwrite the old mark.
    let stored: String = conn.query_row("SELECT value FROM index_state
        WHERE key='heavy_aggregate_source_mark'", [], |r| r.get(0)).unwrap();
    agg::record_source_mark(&conn).unwrap();
    assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_source_mark'",
        [], |r| r.get::<_, String>(0)).unwrap(), stored);
    assert!(!agg::eligible(&conn, &Filters::default()));
    drop(conn);
    let mut conn = Connection::open(&path).unwrap();
    initialize(&conn);
    assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_reset'",
        [], |r| r.get::<_, String>(0)).unwrap(), "6", "restart keeps reset progress");
    finish(&mut conn);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_file_session WHERE session_id='stale'",
        [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM index_state WHERE key='heavy_aggregate_reset'",
        [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert!(agg::eligible_for_range(&conn, &Filters::default(), &ranges()[0].resolve(2_000_000_000_000).0));
    assert_matches_raw(&conn, &ranges()[0], &Filters::default());
}

fn history_lines(session: &str, days: &[i64]) -> Vec<String> {
    days.iter().enumerate().map(|(i, day)| serde_json::json!({
        "type":"assistant", "sessionId":session, "requestId":format!("{session}-r{i}"),
        "uuid":format!("{session}-u{i}"), "timestamp":chrono::DateTime::from_timestamp_millis(
            agg::day_bounds(*day).0+3_600_000+i as i64*1000).unwrap().to_rfc3339(),
        "message":{"id":format!("{session}-m{i}"),"role":"assistant","content":[],
            "model":if i%2==0 {"claude-opus-5"}else{"claude-haiku-4-5-20251001"},
            "usage":{"input_tokens":10,"output_tokens":20}}
    }).to_string()).collect()
}

#[test]
fn older_history_from_current_ingestion_and_0900_publishes_every_gap() {
    use super::fixtures::Fixture;
    for legacy_write in [false, true] {
        let f = Fixture::new();
        let lines = history_lines("recent", &[20000, 20002]);
        f.write("recent.jsonl", &lines.iter().map(String::as_str).collect::<Vec<_>>());
        assert!(f.index(crate::ailog::KIND_CLAUDE, false).errors.is_empty());
        let mut conn = f.conn();
        finish(&mut conn);
        assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_lower_day'",
            [], |r| r.get::<_, String>(0)).unwrap(), "20000");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day", [],
            |r| r.get::<_, i64>(0)).unwrap(), 3);
        if legacy_write {
            agg::forget_startup_check(&conn);
            drop(conn);
            let old = legacy_io_0900::open(&f.db);
            legacy_io_0900::ingest(&old, "older-r0", 0, agg::day_bounds(19998).0+1000, "a", 10, 2);
            legacy_io_0900::ingest(&old, "older-r1", 1, agg::day_bounds(19998).0+2000, "b", 20, 3);
            drop(old);
            conn = Connection::open(&f.db).unwrap();
            initialize(&conn);
        } else {
            drop(conn);
            let lines = history_lines("older", &[19998, 19998]);
            f.write("older.jsonl", &lines.iter().map(String::as_str).collect::<Vec<_>>());
            assert!(f.index(crate::ailog::KIND_CLAUDE, false).errors.is_empty());
            conn = f.conn();
        }
        finish(&mut conn);
        let range = Range { from:Some(agg::day_bounds(19998).0),
            to:Some(agg::day_bounds(20002).1), ..Default::default() };
        for reopen in 0..2 {
            if reopen == 1 {
                drop(conn);
                conn = Connection::open(&f.db).unwrap();
                initialize(&conn);
                assert!(!agg::eligible(&conn, &Filters::default()));
                finish(&mut conn);
            }
            assert!(agg::eligible_for_range(&conn, &Filters::default(),
                &range.resolve(2_000_000_000_000).0),
                "past-side gaps must be published after complete: legacy={legacy_write} reopen={reopen}");
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day
                WHERE day BETWEEN 19998 AND 20002", [], |r| r.get::<_, i64>(0)).unwrap(), 5);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day WHERE day=19999",
                [], |r| r.get::<_, i64>(0)).unwrap(), 1, "empty past-side day must be published");
            let (_, sql) = trace_reports(&conn, &range);
            for table in ["heavy_handoff_chunk", "heavy_tool_day", "heavy_file_session", "heavy_rhythm_day"] {
                assert!(sql.iter().any(|s| s.starts_with("WITH ready AS MATERIALIZED") && s.contains(table)),
                    "completed history must use new SQL for {table}");
            }
            assert_matches_raw(&conn, &range, &Filters::default());
        }
        // Repair metadata even when every day is already published: Complete
        // must commit lower/cursor repair, rather than roll it back on drop.
        conn.execute("DELETE FROM index_state WHERE key='heavy_aggregate_lower_day'", []).unwrap();
        assert_eq!(build_next(&mut conn, Some(u64::MAX), &|_| Ok(())).unwrap(), agg::Step::Complete);
        assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_lower_day'",
            [], |r| r.get::<_, String>(0)).unwrap(), "19998",
            "completed coverage must commit its lower/cursor repair even without another day");
        assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_cursor'",
            [], |r| r.get::<_, String>(0)).unwrap(), "19997");
    }
}

#[test]
fn own_summary_writes_keep_heavy_routes_during_and_after_build() {
    for complete in [true, false] {
        let mut conn = fixture();
        if complete { finish(&mut conn); }
        else {
            assert_eq!(build_next(&mut conn, Some(u64::MAX), &|_| Ok(())).unwrap(), agg::Step::Built(20000));
        }
        for success in [true, false] {
            let dirty = conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_dirty",
                [], |r| r.get::<_, i64>(0)).unwrap();
            let published = conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day",
                [], |r| r.get::<_, i64>(0)).unwrap();
            let before = reports(&conn, &ranges()[0], &Filters::default());
            let mark = agg::source_mark(&conn).unwrap();
            crate::ailog::summarize::save_summary_for_heavy_test(&mut conn, success);
            assert_ne!(agg::source_mark(&conn).unwrap(), mark, "real summary writes must change the old revision");
            assert!(agg::eligible(&conn, &Filters::default()),
                "own summary writes must keep the heavy route: complete={complete} success={success}");
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_dirty",
                [], |r| r.get::<_, i64>(0)).unwrap(), dirty);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day",
                [], |r| r.get::<_, i64>(0)).unwrap(), published);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM index_state WHERE key='heavy_aggregate_reset'",
                [], |r| r.get::<_, i64>(0)).unwrap(), 0);
            assert_eq!(reports(&conn, &ranges()[0], &Filters::default()), before);
            if complete {
                assert!(agg::eligible_for_range(&conn, &Filters::default(),
                    &ranges()[0].resolve(2_000_000_000_000).0));
                let (_, sql) = trace_reports(&conn, &ranges()[0]);
                assert!(sql.iter().any(|s| s.starts_with("WITH ready AS MATERIALIZED")));
                record_idle_source_mark(&conn).unwrap();
            } else {
                assert!(matches!(build_next(&mut conn, Some(u64::MAX), &|_| Ok(())).unwrap(),
                    agg::Step::Built(_)), "a running build must not restart for summary metadata");
            }
            assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_source_mark'",
                [], |r| r.get::<_, String>(0)).unwrap(), agg::source_mark(&conn).unwrap(),
                "idle/per-day work must persist the current fingerprint");
            assert_matches_raw(&conn, &ranges()[0], &Filters::default());
        }
        finish(&mut conn);
        assert!(agg::eligible_for_range(&conn, &Filters::default(),
            &ranges()[0].resolve(2_000_000_000_000).0));
    }
}

#[test]
fn interrupted_day_rolls_back_its_fingerprint_with_publication() {
    let mut conn = fixture();
    assert_eq!(build_next(&mut conn, Some(u64::MAX), &|_| Ok(())).unwrap(), agg::Step::Built(20000));
    let stored: String = conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_source_mark'",
        [], |r| r.get(0)).unwrap();
    crate::ailog::summarize::save_summary_for_heavy_test(&mut conn, true);
    let error = build_next(&mut conn, Some(u64::MAX), &|stage| {
        if stage == "commit" { Err("interrupt day and fingerprint".into()) } else { Ok(()) }
    }).unwrap_err();
    assert!(error.contains("interrupt day and fingerprint"));
    assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_source_mark'",
        [], |r| r.get::<_, String>(0)).unwrap(), stored);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_day",
        [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    finish(&mut conn);
    assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_source_mark'",
        [], |r| r.get::<_, String>(0)).unwrap(), agg::source_mark(&conn).unwrap());
}

#[test]
fn backfill_and_price_updates_dirty_heavy_inputs_in_their_transactions() {
    for rollback in [true, false] {
        let mut conn = fixture();
        conn.execute("UPDATE session SET first_prompt='[mycmux-ailog-summarizer] trial'
            WHERE session_id='session-00'", []).unwrap();
        finish(&mut conn);
        let before = reports(&conn, &ranges()[0], &Filters::default());
        let tx = conn.transaction().unwrap();
        crate::ailog::backfill::internal_origin(&tx).unwrap();
        let old_dirty = tx.query_row("SELECT COUNT(*) FROM rollup_dirty", [],
            |r| r.get::<_, i64>(0)).unwrap();
        let heavy_dirty = tx.query_row("SELECT COUNT(*) FROM heavy_aggregate_dirty", [],
            |r| r.get::<_, i64>(0)).unwrap();
        assert!(old_dirty > 0 && heavy_dirty > 0, "backfill must dirty both aggregate families");
        assert_eq!(tx.query_row("SELECT ready FROM heavy_file_ready
            WHERE kind='codex' AND session_id='session-00'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_matches_raw(&tx, &ranges()[0], &Filters::default());
        if rollback {
            tx.rollback().unwrap();
            assert_eq!(reports(&conn, &ranges()[0], &Filters::default()), before);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_dirty", [],
                |r| r.get::<_, i64>(0)).unwrap(), 0);
        } else {
            tx.commit().unwrap();
            assert_ne!(reports(&conn, &ranges()[0], &Filters::default()), before);
            crate::ailog::rollup::rebuild_dirty(&conn).unwrap();
            finish(&mut conn);
            assert_matches_raw(&conn, &ranges()[0], &Filters::default());
        }
    }
    let mut conn = fixture();
    finish(&mut conn);
    let before = reports(&conn, &ranges()[0], &Filters::default());
    query::set_price(&mut conn, &query::PriceEntry {
        model:"gpt-5".into(), input_per_mtok:20.0, output_per_mtok:40.0,
        cache_read_per_mtok:2.0, cache_write_5m_per_mtok:3.0, cache_write_1h_per_mtok:4.0,
        source:"user".into(), updated_at:0,
    }).unwrap();
    assert!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_dirty", [],
        |r| r.get::<_, i64>(0)).unwrap() > 0, "repricing must dirty heavy cost inputs");
    assert_ne!(reports(&conn, &ranges()[0], &Filters::default()), before);
    assert_matches_raw(&conn, &ranges()[0], &Filters::default());
    finish(&mut conn);
    assert_matches_raw(&conn, &ranges()[0], &Filters::default());
}


// Writer gates are scoped to each database file, so unrelated tests can run in parallel.
// Writer-gate checkpoints and worker waits have explicit time bounds.
// Every test thread owns its inputs. A failed checkpoint can report the
// completed result (including a panic) without an implicit scoped-thread join.
const WRITER_TEST_WAIT: std::time::Duration = std::time::Duration::from_secs(4);
const WRITER_TEST_PAUSE: std::time::Duration = std::time::Duration::from_secs(9);

struct WriterTestThread<T> {
    name: &'static str,
    finished: std::sync::mpsc::Receiver<Result<T, String>>,
    outcome: Option<Result<T, String>>,
}

impl<T: std::fmt::Debug + Send + 'static> WriterTestThread<T> {
    fn spawn(name: &'static str, work: impl FnOnce() -> T + Send + 'static) -> Self {
        let (done, finished) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
                .map_err(|panic| {
                    let text = panic.downcast_ref::<String>().map(String::as_str)
                        .or_else(|| panic.downcast_ref::<&str>().copied())
                        .unwrap_or("non-string panic");
                    format!("{name} panic: {text}")
                });
            let _ = done.try_send(result);
        });
        Self { name, finished, outcome: None }
    }

    fn poll(&mut self) {
        if self.outcome.is_none() {
            match self.finished.try_recv() {
                Ok(result) => self.outcome = Some(result),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    self.outcome = Some(Err(format!("{} result channel closed", self.name)));
                },
                Err(std::sync::mpsc::TryRecvError::Empty) => {},
            }
        }
    }

    fn wait_for(&mut self, marker: &str, mut ready: impl FnMut() -> bool) -> Result<(), String> {
        let deadline = std::time::Instant::now() + WRITER_TEST_WAIT;
        loop {
            if ready() { return Ok(()); }
            self.poll();
            if let Some(result) = &self.outcome {
                return Err(format!("{marker}; {} result: {result:?}", self.name));
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!("{marker}; {} result: pending after {WRITER_TEST_WAIT:?}", self.name));
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    fn checkpoint(&mut self, entered: &std::sync::mpsc::Receiver<()>, marker: &str) -> Result<(), String> {
        self.wait_for(marker, || entered.try_recv().is_ok())
    }

    fn completed_within(&mut self, timeout: std::time::Duration) -> bool {
        self.poll();
        if self.outcome.is_none() {
            self.outcome = self.finished.recv_timeout(timeout).ok();
        }
        self.outcome.is_some()
    }

    fn finish(mut self) -> Result<T, String> {
        self.poll();
        self.outcome.unwrap_or_else(|| {
            self.finished.recv_timeout(WRITER_TEST_WAIT)
                .unwrap_or_else(|error| Err(format!("{} result: {error} after {WRITER_TEST_WAIT:?}", self.name)))
        })
    }
}

// Drop also releases the paused callback if a query or assertion unwinds.
struct WriterTestRelease(Option<std::sync::mpsc::SyncSender<()>>);

impl WriterTestRelease {
    fn new() -> (Self, std::sync::Mutex<std::sync::mpsc::Receiver<()>>) {
        let (release, released) = std::sync::mpsc::sync_channel(1);
        (Self(Some(release)), std::sync::Mutex::new(released))
    }

    fn release(&mut self) {
        if let Some(release) = self.0.take() { let _ = release.try_send(()); }
    }
}

impl Drop for WriterTestRelease {
    fn drop(&mut self) { self.release(); }
}

fn writer_test_wait_for_release(released: &std::sync::Mutex<std::sync::mpsc::Receiver<()>>) {
    released.try_lock().expect("only one callback may pause")
        .recv_timeout(WRITER_TEST_PAUSE).expect("test must release its paused writer within nine seconds");
}

fn retry_writer_gate_worker<T>(mut attempt: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match attempt() {
            Err(error) if error == "ailog product writer busy" && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(1));
            },
            result => return result,
        }
    }
}

fn assert_writer_gate_worker_available(conn: &Connection, marker: &str) {
    let result = retry_writer_gate_worker(|| {
        match crate::ailog::db::try_write_transaction(conn).map_err(|error| error.to_string())? {
            Some(_) => Ok(()),
            None => Err("ailog product writer busy".into()),
        }
    });
    assert!(result.is_ok(), "{marker}: {result:?}");
}

#[test]
fn price_writer_wait_defaults_to_five_seconds() {
    assert_eq!(query::PRICE_WRITER_WAIT, std::time::Duration::from_millis(5_000));
}

fn writer_race_fixture() -> (std::sync::Arc<super::fixtures::Fixture>, Vec<String>) {
    let f = super::fixtures::Fixture::new();
    let lines = history_lines("session-00", &[20000, 20000]);
    f.write("recent.jsonl", &[&lines[0]]);
    assert!(f.index(crate::ailog::KIND_CLAUDE, false).errors.is_empty());
    let mut conn = f.conn();
    assert_eq!(conn.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0)).unwrap(), "wal");
    finish(&mut conn);
    // An earlier own summary makes the idle fingerprint save a real change.
    crate::ailog::summarize::save_summary_for_writer_test(&mut conn, "claude", "session-00", false).unwrap();
    let stored: String = conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_source_mark'",
        [], |r| r.get(0)).unwrap();
    assert_ne!(stored, agg::source_mark(&conn).unwrap());
    (std::sync::Arc::new(f), lines)
}

fn writer_progress(conn: &Connection) -> (i64, i64, i64, i64) {
    conn.query_row("SELECT (SELECT COALESCE(SUM(parsed_lines),0) FROM source_file),
        (SELECT COALESCE(SUM(parsed_bytes),0) FROM source_file),
        (SELECT COUNT(*) FROM turn),
        (SELECT COALESCE(SUM(turns),0) FROM rollup_turn_session_day_v2)", [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap()
}

fn paused_writer_with_idle_attempt(
    path: &std::path::Path, stage: &'static str, success_assertion: &str,
    write: impl FnOnce() -> Result<(), String> + Send + 'static,
) {
    use std::sync::{Arc, mpsc};
    use std::sync::atomic::{AtomicBool, Ordering};
    let mut worker = Connection::open(path).unwrap();
    worker.busy_timeout(std::time::Duration::from_millis(100)).unwrap();
    let before = writer_progress(&worker);
    let mark_before: String = worker.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_source_mark'",
        [], |r| r.get(0)).unwrap();
    let (ready, entered) = mpsc::sync_channel(1);
    let (mut release, released) = WriterTestRelease::new();
    let observed = AtomicBool::new(false);
    let hook = crate::ailog::db::observe_write(path, Arc::new(move |conn, actual| {
        if actual != stage || observed.swap(true, Ordering::SeqCst) { return; }
        // Summary/price establish the same read-to-write snapshot as ingestion.
        if actual != "parsed_lines" {
            conn.query_row("SELECT COUNT(*) FROM source_file", [], |r| r.get::<_, i64>(0)).unwrap();
        }
        ready.try_send(()).unwrap();
        writer_test_wait_for_release(&released);
    }));
    let mut writer = WriterTestThread::spawn("snapshot writer", write);
    let reached = writer.checkpoint(&entered, "the real writer must reach the snapshot barrier");
    if reached.is_err() {
        release.release();
        let written = writer.finish();
        drop(hook);
        panic!("{success_assertion}: {reached:?}; writer result: {written:?}");
    }
    let started = std::time::Instant::now();
    let idle = agg::record_idle_source_mark(&worker);
    let build = agg::build_next(&mut worker, Some(u64::MAX), &|_| Ok(()));
    let elapsed = started.elapsed();
    let during = writer_progress(&worker);
    let mark_during: String = worker.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_source_mark'",
        [], |r| r.get(0)).unwrap();
    // Release before checking every outcome, including a deliberately broken build.
    release.release();
    let written = writer.finish();
    drop(hook);
    assert!(written.as_ref().is_ok_and(|result| result.is_ok()), "{success_assertion}: {written:?}");
    assert_eq!(idle.unwrap_err(), "ailog product writer busy", "idle worker must yield without opening a transaction");
    assert_eq!(build.unwrap_err(), "ailog product writer busy", "daily worker must yield to the same product writer");
    assert!(elapsed < std::time::Duration::from_secs(1), "worker try_lock must not wait for the paused writer: {elapsed:?}");
    assert_eq!(during, before, "progress, raw and aggregates must stay in their committed view at the barrier");
    assert_eq!(mark_during, mark_before, "a skipped worker must not save a fingerprint");
    record_idle_source_mark(&worker).unwrap();
    assert_eq!(worker.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_source_mark'",
        [], |r| r.get::<_, String>(0)).unwrap(), agg::source_mark(&worker).unwrap(),
        "the worker must retry successfully after product commit");
}

#[test]
fn writer_gate_keeps_incremental_ingestion_atomic_with_idle_worker() {
    let (f, lines) = writer_race_fixture();
    let before = writer_progress(&f.conn());
    assert_eq!((before.0, before.2, before.3), (1, 1, 1));
    f.append("recent.jsonl", &[&lines[1]]);
    let input = f.clone();
    paused_writer_with_idle_attempt(&f.db, "parsed_lines",
        "incremental ingestion must commit after the worker attempt", move || {
        let f = input;
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let mut options = crate::ailog::index::IndexOptions::new(f.db.clone());
        options.roots = vec![(crate::ailog::KIND_CLAUDE, f.logs.clone())];
        let report = runtime.block_on(crate::ailog::index::run_index(options,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)), None))?;
        assert!(!report.cancelled && report.errors.is_empty(), "{report:?}");
        Ok(())
    });
    let mut conn = f.conn();
    let after = writer_progress(&conn);
    assert_eq!((after.0, after.2, after.3), (2, 2, 2), "source progress, raw and rollups must advance together");
    assert!(after.1 > before.1);
    assert_eq!(after.1 as u64, std::fs::metadata(f.logs.join("recent.jsonl")).unwrap().len());
    assert!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_dirty", [], |r| r.get::<_, i64>(0)).unwrap() > 0);
    finish(&mut conn);
    assert_matches_raw(&conn, &Range::default(), &Filters::default());
}

#[test]
fn writer_gate_keeps_summary_atomic_with_idle_worker() {
    for success in [true, false] {
        let (f, _) = writer_race_fixture();
        let before = writer_progress(&f.conn());
        let input = f.clone();
        paused_writer_with_idle_attempt(&f.db, "summary",
            "summary persistence must commit after the worker attempt", move || {
            let mut conn = input.conn();
            crate::ailog::summarize::save_summary_for_writer_test(&mut conn, "claude", "session-00", success)
        });
        let conn = f.conn();
        assert_eq!(writer_progress(&conn), before);
        let (goal, summary, error): (Option<String>, Option<String>, Option<String>) = conn.query_row(
            "SELECT s.goal_summary,m.goal_summary,m.parse_error FROM session s JOIN summary m
             ON m.kind=s.kind AND m.session_id=s.session_id WHERE s.kind='claude' AND s.session_id='session-00'",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        if success {
            assert_eq!(goal.as_deref(), Some("saved summary"));
            assert_eq!(goal, summary, "session and summary must commit together");
            assert!(error.is_none());
        } else {
            assert_eq!(error.as_deref(), Some("injected parse error"));
            assert_eq!(conn.query_row("SELECT attempt_count FROM summary", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        }
        assert!(agg::eligible(&conn, &Filters::default()));
        assert_matches_raw(&conn, &Range::default(), &Filters::default());
    }
}

#[test]
fn writer_gate_keeps_price_update_atomic_with_idle_worker() {
    let (f, _) = writer_race_fixture();
    let conn = f.conn();
    let before = writer_progress(&conn);
    let old_cost: f64 = conn.query_row("SELECT SUM(cost_usd) FROM turn", [], |r| r.get(0)).unwrap();
    drop(conn);
    let input = f.clone();
    paused_writer_with_idle_attempt(&f.db, "price",
        "price update and repricing must commit after the worker attempt", move || {
        let mut conn = input.conn();
        query::set_price(&mut conn, &query::PriceEntry {
            model:"claude-opus-5".into(), input_per_mtok:1000.0, output_per_mtok:2000.0,
            cache_read_per_mtok:100.0, cache_write_5m_per_mtok:150.0, cache_write_1h_per_mtok:200.0,
            source:"user".into(), updated_at:0,
        }).map(|_| ())
    });
    let mut conn = f.conn();
    assert_eq!(writer_progress(&conn), before);
    let (price, cost, rollup): (f64, f64, f64) = conn.query_row(
        "SELECT (SELECT input_per_mtok FROM price WHERE model='claude-opus-5'),
         (SELECT SUM(cost_usd) FROM turn), (SELECT SUM(cost_usd) FROM rollup_turn_session_day_v2)", [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!(price, 1000.0);
    assert!((cost - 0.05).abs() < 1e-12 && (cost - rollup).abs() < 1e-12,
        "price, raw costs and derived costs must advance atomically: price={price} cost={cost} rollup={rollup}");
    assert_ne!(cost, old_cost);
    assert!(conn.query_row("SELECT COUNT(*) FROM heavy_aggregate_dirty", [], |r| r.get::<_, i64>(0)).unwrap() > 0);
    finish(&mut conn);
    assert_matches_raw(&conn, &Range::default(), &Filters::default());
}

fn writer_test_price() -> query::PriceEntry {
    query::PriceEntry {
        model: "claude-opus-5".into(), input_per_mtok: 1000.0, output_per_mtok: 2000.0,
        cache_read_per_mtok: 100.0, cache_write_5m_per_mtok: 150.0, cache_write_1h_per_mtok: 200.0,
        source: "user".into(), updated_at: 0,
    }
}

// The price checkpoint holds the gate before writing; a waiter must read the
// committed price only after that gate has passed to its own transaction.
fn behind_paused_price<T: std::fmt::Debug + Send + 'static>(
    path: &std::path::Path, write: impl FnOnce() -> T + Send + 'static,
) -> T {
    use std::sync::{Arc, mpsc};
    let (ready, entered) = mpsc::sync_channel(1);
    let (mut release, released) = WriterTestRelease::new();
    let hook = crate::ailog::db::observe_write(path, Arc::new(move |_, stage| {
        if stage == "price" {
            ready.try_send(()).unwrap();
            writer_test_wait_for_release(&released);
        }
    }));
    let price_path = path.to_path_buf();
    let mut price = WriterTestThread::spawn("paused price", move || {
        let mut conn = Connection::open(price_path).unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
        query::set_price(&mut conn, &writer_test_price())
    });
    let reached = price.checkpoint(&entered, "the price writer must reach its checkpoint");
    if reached.is_err() {
        release.release();
        let result = price.finish();
        drop(hook);
        panic!("{reached:?}; price result: {result:?}");
    }
    let mut writer = WriterTestThread::spawn("queued product writer", write);
    let waiting = writer.wait_for("the real product writer must queue behind the paused price within ten seconds",
        || crate::ailog::db::waiting_writers_for_test(path) >= 1);
    release.release();
    let written = writer.finish();
    let price = price.finish();
    drop(hook);
    assert!(waiting.is_ok(), "{waiting:?}; writer result: {written:?}; price result: {price:?}");
    assert!(price.as_ref().is_ok_and(|result| result.is_ok()),
        "the paused price must commit before the queued writer: {price:?}; writer result: {written:?}");
    written.unwrap_or_else(|error| panic!("queued product writer result: {error}"))
}

fn assert_writer_cost(conn: &Connection, expected: f64, marker: &str) {
    let (price, turns, session, rollup): (f64, f64, f64, f64) = conn.query_row(
        "SELECT (SELECT input_per_mtok FROM price WHERE model='claude-opus-5'),
         (SELECT SUM(cost_usd) FROM turn), (SELECT SUM(cost_usd) FROM session),
         (SELECT SUM(cost_usd) FROM rollup_turn_session_day_v2)", [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
    assert!(price == 1000.0 && [turns, session, rollup].iter().all(|v| (*v - expected).abs() < 1e-12),
        "{marker}: price={price} turn={turns} session={session} rollup={rollup} expected={expected}");
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM turn WHERE ABS(cost_usd-0.05)>0.000000000001", [],
        |r| r.get::<_, i64>(0)).unwrap(), 0, "each 10-input/20-output turn must cost 0.05 USD");
}

#[test]
fn writer_gate_ingestion_loads_price_after_waiting() {
    let (f, mut lines) = writer_race_fixture();
    let mut second: Value = serde_json::from_str(&lines[1]).unwrap();
    second["message"]["model"] = Value::String("claude-opus-5".into());
    lines[1] = second.to_string();
    f.append("recent.jsonl", &[&lines[1]]);
    let input = f.clone();
    let report = behind_paused_price(&f.db, move || input.index(crate::ailog::KIND_CLAUDE, false));
    assert!(!report.cancelled && report.errors.is_empty(), "{report:?}");
    let mut conn = f.conn();
    // Two turns * (10 * 1000 + 20 * 2000) / 1_000_000 = 0.10 USD.
    assert_writer_cost(&conn, 0.10, "ingestion must use the price committed while it waited");
    assert_eq!(writer_progress(&conn).2, 2);
    assert_matches_raw(&conn, &Range::default(), &Filters::default());
    finish(&mut conn);
    assert_matches_raw(&conn, &Range::default(), &Filters::default());
}

fn writer_repair_options(f: &super::fixtures::Fixture) -> crate::ailog::repair::RepairOptions {
    crate::ailog::repair::RepairOptions {
        claude_root: Some(f.logs.clone()), codex_root: None, claude_codex_root: None,
        fallback_root: None, archive_root: None,
    }
}

#[test]
fn writer_gate_repair_family_loads_price_after_waiting() {
    use std::sync::{Arc, mpsc};
    let (f, _) = writer_race_fixture();
    let (ready, entered) = mpsc::sync_channel(1);
    let (mut release, released) = WriterTestRelease::new();
    let progress: crate::ailog::index::ProgressSink = Arc::new(move |p| {
        if p.phase == "repair-swap" {
            ready.try_send(()).unwrap();
            writer_test_wait_for_release(&released);
        }
    });
    let input = f.clone();
    let mut repair = WriterTestThread::spawn("staged family repair", move || {
        crate::ailog::repair::run_with_progress(&mut input.conn(), &writer_repair_options(&input),
            &std::sync::atomic::AtomicBool::new(false), Some(progress), true)
    });
    let staged = repair.checkpoint(&entered, "repair must finish staging before pausing the price writer");
    if staged.is_err() {
        release.release();
        let result = repair.finish();
        panic!("{staged:?}; repair result: {result:?}");
    }
    let report = behind_paused_price(&f.db, move || {
        release.release();
        repair.finish()
    }).unwrap_or_else(|error| panic!("staged family repair result: {error}")).unwrap();
    assert_eq!(report.groups_repaired, 1, "the real family swap must execute");
    assert!(report.errors.is_empty() && !report.cancelled, "{report:?}");
    let mut conn = f.conn();
    // One turn * (10 * 1000 + 20 * 2000) / 1_000_000 = 0.05 USD.
    assert_writer_cost(&conn, 0.05, "repair family must use the price committed while it waited");
    finish(&mut conn);
    assert_matches_raw(&conn, &Range::default(), &Filters::default());
}

#[test]
fn writer_gate_repair_finalization_loads_price_after_waiting() {
    let f = std::sync::Arc::new(super::fixtures::Fixture::new());
    let mut conn = f.conn();
    // An unpaired suspected legacy turn is restored by finalization, without
    // staging a family. That path really recomputes this session's costs.
    conn.execute("INSERT INTO session(kind,session_id) VALUES ('claude','unpaired')", []).unwrap();
    conn.execute("INSERT INTO turn(kind,session_id,seq,ts,model,input_tokens,output_tokens,usage_state)
        VALUES ('claude','unpaired',0,?1,'claude-opus-5',10,20,'suspected_duplicate')",
        [agg::day_bounds(20000).0]).unwrap();
    crate::ailog::rollup::mark_all_dirty(&conn).unwrap();
    crate::ailog::rollup::rebuild_dirty(&conn).unwrap();
    finish(&mut conn);
    drop(conn);
    let input = f.clone();
    let report = behind_paused_price(&f.db, move || crate::ailog::repair::run(&mut input.conn(),
        &writer_repair_options(&input), &std::sync::atomic::AtomicBool::new(false))).unwrap();
    assert_eq!(report.groups_seen, 0);
    assert!(report.errors.is_empty() && !report.cancelled, "{report:?}");
    let mut conn = f.conn();
    assert_eq!(conn.query_row("SELECT usage_state FROM turn", [], |r| r.get::<_, String>(0)).unwrap(), "legacy");
    assert_writer_cost(&conn, 0.05, "repair finalization must use the price committed while it waited");
    finish(&mut conn);
    assert_matches_raw(&conn, &Range::default(), &Filters::default());
}

#[test]
fn writer_gate_first_reader_does_not_block_worker_or_price() {
    use std::sync::{Arc, mpsc};
    use std::time::{Duration, Instant};
    let (f, lines) = writer_race_fixture();
    let before = writer_progress(&f.conn());
    f.append("recent.jsonl", &[&lines[1]]);
    let (reader_ready, reader_entered) = mpsc::sync_channel(1);
    let (mut release, released) = WriterTestRelease::new();
    let reader_hook = crate::ailog::index::observe_reader(&f.db, Arc::new(move || {
        reader_ready.try_send(()).unwrap();
        writer_test_wait_for_release(&released);
    }));
    let (writer_ready, writer_entered) = mpsc::sync_channel(1);
    let writer_hook = crate::ailog::db::observe_write(&f.db, Arc::new(move |_, stage| {
        if stage == "index-first-message" { writer_ready.try_send(()).unwrap(); }
    }));
    let mut worker = Connection::open(&f.db).unwrap();
    worker.busy_timeout(Duration::from_millis(100)).unwrap();
    let input = f.clone();
    let mut writer = WriterTestThread::spawn("first-message ingestion", move || input.index(crate::ailog::KIND_CLAUDE, false));
    let (mut reader_seen, mut writer_seen) = (false, false);
    let ready = writer.wait_for("both the first parsed reader and the waiting writer must be observed", || {
        reader_seen |= reader_entered.try_recv().is_ok();
        writer_seen |= writer_entered.try_recv().is_ok();
        reader_seen && writer_seen
    });
    let started = Instant::now();
    let mut longest_attempt = Duration::ZERO;
    let idle = if ready.is_ok() {
        retry_writer_gate_worker(|| {
            let attempt_started = Instant::now();
            let result = agg::record_idle_source_mark(&worker);
            longest_attempt = longest_attempt.max(attempt_started.elapsed());
            result
        })
    } else { Err("ingestion did not reach its checkpoints".into()) };
    let elapsed = (started.elapsed(), longest_attempt);
    // A broken early-lock build releases the reader before its worker failure.
    let price = if idle.is_ok() {
        query::set_price(&mut worker, &writer_test_price())
    } else { Err("worker did not advance while the first reader was paused".into()) };
    let during = writer_progress(&worker);
    release.release();
    let report = writer.finish();
    drop(writer_hook);
    drop(reader_hook);
    assert!(ready.is_ok(), "{ready:?}; writer result: {report:?}");
    assert!(idle.is_ok(), "worker must advance while the first reader is paused: {idle:?}; writer result: {report:?}");
    assert!(elapsed.0 < Duration::from_secs(4), "idle worker must advance within four seconds: {elapsed:?}");
    assert!(elapsed.1 < Duration::from_secs(1), "each worker try_lock attempt must return within one second: {elapsed:?}");
    assert!(price.is_ok(), "price must save while the first reader is paused: {price:?}");
    let report = report.unwrap_or_else(|error| panic!("first-message ingestion result: {error}"));
    assert_eq!(during, before, "source progress, raw and rollups must stay together before the first message");
    assert!(!report.cancelled && report.errors.is_empty(), "{report:?}");
    let after = writer_progress(&worker);
    assert_eq!((after.0, after.2, after.3), (2, 2, 2), "source progress, raw and rollups must advance together");
    assert!(after.1 > before.1);
    assert_eq!(after.1 as u64, std::fs::metadata(f.logs.join("recent.jsonl")).unwrap().len());
    assert!(worker.query_row("SELECT COUNT(*) FROM heavy_aggregate_dirty", [],
        |r| r.get::<_, i64>(0)).unwrap() > 0);
    finish(&mut worker);
    assert_matches_raw(&worker, &Range::default(), &Filters::default());
}

#[test]
fn writer_gate_price_wait_times_out_without_leaking_waiters() {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    let (f, _) = writer_race_fixture();
    let before = query::get_prices(&f.conn()).unwrap();
    let (ready, entered) = mpsc::sync_channel(1);
    let (mut release, released) = WriterTestRelease::new();
    let wait_limit = Duration::from_millis(250);
    let hold_time = Duration::from_secs(3);
    let input = f.clone();
    let mut holder = WriterTestThread::spawn("price gate holder", move || {
        let conn = Connection::open(&input.db).unwrap();
        let tx = crate::ailog::db::write_transaction(&conn).unwrap();
        ready.try_send(()).unwrap();
        writer_test_wait_for_release(&released);
        tx.commit()
    });
    let reached = holder.checkpoint(&entered, "the price gate holder must acquire its transaction");
    if reached.is_err() {
        release.release();
        let result = holder.finish();
        panic!("{reached:?}; holder result: {result:?}");
    }
    let started = Instant::now();
    let input = f.clone();
    let mut writer = WriterTestThread::spawn("bounded price update", move || {
        let mut conn = Connection::open(&input.db).unwrap();
        let started = Instant::now();
        let result = query::with_price_writer_wait_for_test(wait_limit, || {
            query::set_price(&mut conn, &writer_test_price())
        });
        (result, started.elapsed())
    });
    let timely = writer.completed_within(Duration::from_secs(2));
    std::thread::sleep(hold_time.saturating_sub(started.elapsed()));
    release.release();
    let holder = holder.finish();
    let outcome = writer.finish();
    assert!(holder.as_ref().is_ok_and(|result| result.is_ok()), "holder result: {holder:?}; writer result: {outcome:?}");
    assert!(timely, "price update must return busy before the three-second holder is released: {outcome:?}");
    let (result, elapsed) = outcome.unwrap_or_else(|error| panic!("bounded price update result: {error}"));
    assert!(result.as_ref().is_err_and(|error| error.contains("database is locked")),
        "price wait expiry must return SQLite busy: {result:?}");
    assert!(elapsed >= wait_limit && elapsed < hold_time,
        "price wait must reach its limit and expire before the holder is released: {elapsed:?}");
    let conn = f.conn();
    assert_eq!(serde_json::to_value(query::get_prices(&conn).unwrap()).unwrap(),
        serde_json::to_value(before).unwrap(), "a timed out price update must not change a price row");
    assert_writer_gate_worker_available(&conn,
        "worker must acquire after the timed out waiter and holder leave");
    eprintln!("price wait expired in {elapsed:?}; worker acquired after holder release");
}

#[test]
fn writer_gate_closed_first_channel_still_finalizes_empty_and_cancelled_passes() {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    for cancelled in [false, true] {
        let f = super::fixtures::Fixture::new();
        let mut conn = f.conn();
        // Preserve the existing rule: ingestion saves a fingerprint only
        // after the worker has reconciled this database's startup identity.
        finish(&mut conn);
        drop(conn);
        if cancelled { f.write("not-read.jsonl", &[&history_lines("not-read", &[20000])[0]]); }
        let mut options = crate::ailog::index::IndexOptions::new(f.db.clone());
        options.roots = vec![(crate::ailog::KIND_CLAUDE, f.logs.clone())];
        let report = tokio::runtime::Runtime::new().unwrap().block_on(crate::ailog::index::run_index(
            options, Arc::new(AtomicBool::new(cancelled)), None)).unwrap();
        assert_eq!(report.cancelled, cancelled);
        assert!(report.errors.is_empty(), "{report:?}");
        let conn = f.conn();
        assert_eq!(writer_progress(&conn), (0, 0, 0, 0));
        assert!(crate::ailog::rollup::version_matches(&conn).unwrap());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM index_state WHERE key='last_finished_at'", [],
            |r| r.get::<_, i64>(0)).unwrap(), 1, "a closed first channel must still commit finalization");
        assert_eq!(conn.query_row("SELECT value FROM index_state WHERE key='heavy_aggregate_source_mark'", [],
            |r| r.get::<_, String>(0)).unwrap(), agg::source_mark(&conn).unwrap());
        assert_writer_gate_worker_available(&conn,
            "worker must acquire after an empty or cancelled pass");
    }
}


#[test]
fn writer_gate_initialized_reader_does_not_wait_for_other_path_initialization() {
    use std::sync::{Arc, mpsc};
    use std::time::Duration;
    let dir = Arc::new(tempfile::tempdir().unwrap());
    let path_a = dir.path().join("new-a.db");
    let path_b = dir.path().join("initialized-b.db");
    crate::ailog::db::ensure_initialized(&path_b).unwrap();
    // Initialization of A must now be held by A's own gate, independently of B.
    let holder = Connection::open(&path_a).unwrap();
    let held = crate::ailog::db::write_transaction(&holder).unwrap();
    let (started, observed) = mpsc::sync_channel(1);
    let input = dir.clone();
    let mut initialization = WriterTestThread::spawn("path A initialization", move || {
        crate::ailog::db::ensure_initialized_observed(&input.path().join("new-a.db"), |_| {
            let _ = started.try_send(());
        })
    });
    let observed = initialization.checkpoint(&observed, "new path A initialization must reach its observe hook");
    let waiting = initialization.wait_for("new path A initialization must wait behind the held writer gate",
        || crate::ailog::db::waiting_writers_for_test(&path_a) > 0);
    let input = dir.clone();
    let mut reader = WriterTestThread::spawn("initialized path B reader", move || {
        crate::ailog::db::reader(&input.path().join("initialized-b.db")).map(|_| ())
    });
    let timely = reader.completed_within(Duration::from_secs(3));
    // Also releases the global-initialization-lock mutation before reporting it.
    drop(held);
    let initialized = initialization.finish();
    let read = reader.finish();
    assert!(observed.is_ok(), "{observed:?}; initialization result: {initialized:?}");
    assert!(waiting.is_ok(), "{waiting:?}; initialization result: {initialized:?}");
    assert!(initialized.as_ref().is_ok_and(|result| result.is_ok()),
        "new path A initialization must finish after writer release: {initialized:?}");
    assert!(timely, "initialized path B reader must not wait for path A initialization: {read:?}");
    assert!(read.as_ref().is_ok_and(|result| result.is_ok()), "initialized path B reader must open successfully: {read:?}");
}

#[test]
fn writer_gate_other_database_does_not_block_or_defer_worker() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let dir = Arc::new(tempfile::tempdir().unwrap());
    let path_a = dir.path().join("held-a.db");
    let path_b = dir.path().join("worker-b.db");
    let holder = Connection::open(&path_a).unwrap();
    let worker = Connection::open(&path_b).unwrap();
    let held = crate::ailog::db::write_transaction(&holder).unwrap();
    let started = Instant::now();
    let while_held = crate::ailog::db::try_write_transaction(&worker).map(|tx| tx.is_some());
    let held_elapsed = started.elapsed();
    let input = dir.clone();
    let mut waiter = WriterTestThread::spawn("other database waiter", move || {
        let conn = Connection::open(input.path().join("held-a.db")).unwrap();
        crate::ailog::db::write_transaction(&conn).unwrap().commit()
    });
    let waiting = waiter.wait_for("database A writer must queue behind its holder",
        || crate::ailog::db::waiting_writers_for_test(&path_a) > 0);
    let started = Instant::now();
    let while_waiting = crate::ailog::db::try_write_transaction(&worker).map(|tx| tx.is_some());
    let waiting_elapsed = started.elapsed();
    drop(held);
    let written = waiter.finish();
    assert!(waiting.is_ok(), "{waiting:?}; waiter result: {written:?}");
    assert!(written.as_ref().is_ok_and(|result| result.is_ok()), "other database waiter result: {written:?}");
    assert!(matches!(while_held, Ok(true)) && matches!(while_waiting, Ok(true)),
        "another database's held gate or queued writer must not defer this worker: held={while_held:?}, waiting={while_waiting:?}");
    assert!(held_elapsed < Duration::from_secs(1) && waiting_elapsed < Duration::from_secs(1),
        "another database must not make this worker wait: held={held_elapsed:?}, waiting={waiting_elapsed:?}");
}

#[test]
fn writer_gate_same_file_aliases_share_gate() {
    use std::sync::Arc;
    let cwd = std::env::current_dir().unwrap();
    let dir = Arc::new(tempfile::tempdir_in(&cwd).unwrap());
    let path = dir.path().join("shared.db");
    let relative = path.strip_prefix(&cwd).unwrap().parent().unwrap().join("./shared.db");
    let holder = Connection::open(&path).unwrap();
    let mut aliases = vec![relative];
    #[cfg(unix)]
    {
        let link = dir.path().join("linked");
        std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        aliases.push(link.join("shared.db"));
    }
    let held = crate::ailog::db::write_transaction(&holder).unwrap();
    let input = dir.clone();
    let mut waiter = WriterTestThread::spawn("same-file alias waiter", move || {
        let conn = Connection::open(input.path().join("shared.db")).unwrap();
        crate::ailog::db::write_transaction(&conn).unwrap().commit()
    });
    let waiting = waiter.wait_for("the same-file writer must queue behind its holder",
        || crate::ailog::db::waiting_writers_for_test(&path) > 0);
    let results: Vec<_> = aliases.iter().map(|alias| {
        // SQLite may already resolve connection filenames. Reading the waiter
        // through each alias independently exercises our own key normalization.
        let alias_waiting = crate::ailog::db::waiting_writers_for_test(alias);
        let attempt = Connection::open(alias).and_then(|conn| {
            crate::ailog::db::try_write_transaction(&conn).map(|tx| tx.is_none())
        });
        (alias, alias_waiting, attempt)
    }).collect();
    drop(held);
    let written = waiter.finish();
    assert!(waiting.is_ok(), "{waiting:?}; waiter result: {written:?}");
    assert!(written.as_ref().is_ok_and(|result| result.is_ok()), "same-file waiter result: {written:?}");
    assert!(results.iter().all(|(_, count, attempt)| *count > 0 && matches!(attempt, Ok(true))),
        "same-file aliases must share the held gate and waiting count: {results:?}");
}

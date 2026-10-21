//! Fix-round regression fixtures. No live profile is opened by regular tests.
use super::*;
use std::sync::{Arc,Mutex};
use std::sync::atomic::Ordering;
use crate::ailog::{index as indexer,legacy,rollup};

fn amounts(conn: &Connection) -> query::AccountingTotals {
    query::accounting_totals(conn,&Range { from:Some(0),to:Some(2_000_000_000_000),..Default::default() },
        &Filters::default(),2_000_000_000_000).unwrap()
}
fn classify(f: &Fixture) {
    let mut conn=f.conn(); let tx=conn.transaction().unwrap();
    legacy::classify_suspected(&tx,&repair_options(f,false),&mut accounting::Touched::new(),&|_|Ok(())).unwrap();
    tx.commit().unwrap();
}
fn seed_row(conn: &Connection,kind: &str,sid: &str,seq: i64,request: &str,ts: i64,input: i64,output: i64,cost: f64) {
    conn.execute("INSERT OR IGNORE INTO session(kind,session_id,origin) VALUES (?1,?2,'unknown')",params![kind,sid]).unwrap();
    conn.execute("INSERT INTO turn(kind,session_id,seq,request_id,ts,model,input_tokens,output_tokens,cost_usd)
        VALUES (?1,?2,?3,?4,?5,'stage1-a',?6,?7,?8)",params![kind,sid,seq,request,ts,input,output,cost]).unwrap();
}

#[test]
fn stage1_r2_f01_all_599_synthetic_copies_including_five_additions() {
    let f=fixture(); let mut c=f.conn();
    let cases:Vec<Value>=serde_json::from_str(include_str!("r2_legacy_copies.json")).unwrap();
    assert_eq!(cases.len(),599);
    let mut added=0; let mut added_usd=0.;
    {
        let tx=c.transaction().unwrap();
        for (i,r) in cases.iter().enumerate() {
            let kind="claude"; let cs=r["canonical_sid"].as_str().unwrap(); let ls=r["legacy_sid"].as_str().unwrap();
            let ex=r["execution_key"].as_str().unwrap(); let req=r["request_id"].as_str().unwrap();
            let model=r["model"].as_str(); let ts=r["observed_ts"].as_i64().unwrap(); let cost=r["cost_usd"].as_f64().unwrap();
            let t=r["tokens"].as_array().unwrap().iter().map(|v|v.as_i64().unwrap()).collect::<Vec<_>>();
            for sid in [cs,ls] { tx.execute("INSERT OR IGNORE INTO session(kind,session_id) VALUES (?1,?2)",params![kind,sid]).unwrap(); }
            tx.execute("INSERT OR IGNORE INTO turn(kind,session_id,seq,request_id,ts,model,input_tokens,output_tokens,
                cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,reasoning_tokens,cost_usd,execution_key,cost_owner_session_id,usage_state)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?4,?2,'canonical')",
                params![kind,cs,i as i64,ex,r["canonical_ts"].as_i64(),model,t[0],t[1],t[2],t[3],t[4],t[5],cost]).unwrap();
            tx.execute("INSERT INTO turn(kind,session_id,seq,request_id,ts,model,input_tokens,output_tokens,
                cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,reasoning_tokens,cost_usd)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![kind,ls,10000+i as i64,req,ts,model,t[0],t[1],t[2],t[3],t[4],t[5],cost]).unwrap();
            let evidence=json!({"request_id":req,"message_id":r["message_id"],"model":model,
                "last":{"input_tokens":t[0],"output_tokens":t[1],"cache_read_input_tokens":t[2],
                    "cache_creation":{"ephemeral_5m_input_tokens":t[3],"ephemeral_1h_input_tokens":t[4]}}});
            tx.execute("INSERT INTO usage_occurrence(kind,source_path,source_generation,source_line,source_session_id,execution_key,observed_ts,decision,evidence_json)
                VALUES (?1,?2,'fixture',1,?3,?4,?5,'canonical',?6)",params![kind,format!("proof/{i}"),cs,ex,ts,evidence.to_string()]).unwrap();
            if r["category"]=="new_global_native" { added+=1; added_usd+=cost; }
        }
        tx.commit().unwrap();
    }
    assert_eq!(added,5); close(added_usd,0.17);
    let rows=scalar(&c,"SELECT COUNT(*) FROM turn"); let before=amounts(&c).cost_usd;
    let proofs=legacy::claude_copy_proofs(&c).unwrap(); assert_eq!(proofs.len(),599);
    {
        let tx=c.transaction().unwrap();
        assert_eq!(legacy::reconcile_proven(&tx,&mut accounting::Touched::new(),&|_|Ok(())).unwrap(),599);
        tx.commit().unwrap();
    }
    close(before-amounts(&c).cost_usd,23.90);
    assert_eq!(rows,scalar(&c,"SELECT COUNT(*) FROM turn"));
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM usage_legacy_classification WHERE decision='duplicate'"),599);
    assert!(legacy::claude_copy_proofs(&c).unwrap().is_empty());
}

#[test]
fn stage1_r2_checkpoint_preserves_snake_case_storage_keys() {
    let stored=json!({"seen_responses":{"synthetic-usage":"synthetic-response"},
        "turn_id":"synthetic-turn","event_index":7});
    let state:accounting::CodexUsageState=serde_json::from_value(stored.clone()).unwrap();
    assert_eq!(state.event_index,7);
    assert_eq!(state.turn_id.as_deref(),Some("synthetic-turn"));
    assert_eq!(state.seen_responses.get("synthetic-usage").map(String::as_str),Some("synthetic-response"));
    let serialized=serde_json::to_value(&state).unwrap();
    for field in ["seen_responses","turn_id","event_index"] {
        assert_eq!(serialized[field],stored[field]);
    }
    assert!(serialized.get("seenResponses").is_none());
    assert!(serialized.get("turnId").is_none());
    assert!(serialized.get("eventIndex").is_none());
}

#[test]
fn stage1_r2_f01_similar_but_unproven_legacy_remains_chargeable() {
    let f=fixture(); f.write("p.jsonl",&[&claude("p","mp","rp",1000,100,false,TS)]); index(&f,KIND_CLAUDE);
    let mut c=f.conn(); let ts=parse_ts(Some(TS)).unwrap();
    seed_row(&c,"claude","other",0,"rp",ts+1,1000,100,0.003);
    seed_row(&c,"claude","other",1,"unrelated",ts,1000,100,0.003);
    seed_row(&c,"claude","other",2,"rp-counter",ts,1000,101,0.00301);
    let tx=c.transaction().unwrap();
    assert_eq!(legacy::reconcile_proven(&tx,&mut accounting::Touched::new(),&|_|Ok(())).unwrap(),0);
    tx.commit().unwrap(); assert_eq!(scalar(&c,"SELECT COUNT(*) FROM turn WHERE usage_state='legacy'"),3);
}

#[test]
fn stage1_r2_f02_old_writer_same_native_response_does_not_double_count() {
    for has_request in [true,false] {
        let f=fixture(); let mut v:Value=serde_json::from_str(&claude("p","mp","rp",1000,100,false,TS)).unwrap();
        if !has_request { v.as_object_mut().unwrap().remove("requestId"); }
        f.write("p.jsonl",&[&v.to_string()]); index(&f,KIND_CLAUDE); run_repair(&f,false);
        let c=f.conn(); let key=if has_request {"rp"} else {"mp"};
        assert_eq!(scalar(&c,"SELECT COUNT(*) FROM turn"),1);
        assert_eq!(c.query_row("SELECT request_id FROM turn",[],|r|r.get::<_,String>(0)).unwrap(),key);
        // Old df8403f2f writes this native-key shape and only updates metadata
        // on conflict; it has no execution_key or usage_state columns.
        c.execute("INSERT INTO turn(kind,session_id,seq,request_id,ts,model,input_tokens,output_tokens,tool_calls)
            VALUES ('claude','p',99,?1,?2,'stage1-a',1000,100,0)
            ON CONFLICT(kind,session_id,request_id) DO UPDATE SET tool_calls=turn.tool_calls+excluded.tool_calls,
                duration_ms=COALESCE(excluded.duration_ms,turn.duration_ms),model=COALESCE(turn.model,excluded.model)",
            params![key,parse_ts(Some(TS)).unwrap()]).unwrap();
        assert_eq!(scalar(&c,"SELECT COUNT(*) FROM turn"),1);
        close(amounts(&c).cost_usd,0.003);
    }
}

#[test]
fn stage1_r2_f02_pre_v3_backup_is_once_byte_exact_and_restorable() {
    use sha2::{Digest,Sha256};
    let f=fixture();
    // Fixture initialization above is intentionally discarded here: use a new
    // path so this really passes through the first writer initialization.
    let path=f.logs.join("old.db");
    {
        let c=Connection::open(&path).unwrap(); crate::ailog::schema::init(&c).unwrap();
        c.pragma_update(None,"user_version",2).unwrap();
        seed_row(&c,"claude","old",0,"old",1,1000,100,0.003);
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    }
    let before=std::fs::read(&path).unwrap();
    drop(crate::ailog::open_db(&path).unwrap());
    let backups=||std::fs::read_dir(&f.logs).unwrap().filter_map(Result::ok).map(|e|e.path())
        .filter(|p|p.file_name().unwrap().to_string_lossy().starts_with("old.db.pre-v3-")).collect::<Vec<_>>();
    let paths=backups(); assert_eq!(paths.len(),1);
    let bytes=std::fs::read(&paths[0]).unwrap(); assert_eq!(Sha256::digest(&bytes),Sha256::digest(&before));
    drop(crate::ailog::open_db(&path).unwrap()); assert_eq!(backups(),paths);
    let restored=f.logs.join("restored.db"); std::fs::copy(&paths[0],&restored).unwrap();
    let c=Connection::open(&restored).unwrap(); close(total(&c),0.003);
    assert_eq!(scalar(&c,"PRAGMA user_version"),2);
    assert!(c.prepare("SELECT execution_key FROM turn").is_err());
}

#[test]
fn stage1_r2_f02_wal_backup_includes_uncheckpointed_usage() {
    let f=fixture(); let path=f.logs.join("wal.db");
    let c=Connection::open(&path).unwrap(); crate::ailog::schema::init(&c).unwrap();
    c.execute_batch("PRAGMA wal_autocheckpoint=0").unwrap();
    seed_row(&c,"claude","wal",0,"wal",1,1000,100,0.003);
    drop(crate::ailog::open_db(&path).unwrap());
    let backup=std::fs::read_dir(&f.logs).unwrap().filter_map(Result::ok).map(|e|e.path())
        .find(|p|p.file_name().unwrap().to_string_lossy().starts_with("wal.db.pre-v3-")).unwrap();
    let b=Connection::open_with_flags(backup,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    close(total(&b),0.003); assert_eq!(scalar(&b,"SELECT COUNT(*) FROM turn"),1);
}

#[test]
fn stage1_r2_f03_owner_shrink_and_recreation_preserve_unchanged_child_maximum() {
    let f=fixture(); let p=claude("p","mp","rp",1000,50,false,TS);
    let child=claude("p","mp","rp",1000,100,true,"2026-09-15T00:00:01Z");
    f.write("p.jsonl",&[&p,&json!({"type":"padding","value":"x".repeat(2048)}).to_string()]);
    f.write("p/subagents/agent-copy.jsonl",&[&child]); index(&f,KIND_CLAUDE);
    let child_before=std::fs::read(f.logs.join("p/subagents/agent-copy.jsonl")).unwrap();
    close(amounts(&f.conn()).cost_usd,0.003);
    f.write("p.jsonl",&[&p]); index(&f,KIND_CLAUDE);
    close(amounts(&f.conn()).cost_usd,0.003);
    assert_eq!(scalar(&f.conn(),"SELECT output_tokens FROM turn WHERE usage_state='canonical'"),100);
    std::fs::write(f.logs.join("p.jsonl"),b"").unwrap(); index(&f,KIND_CLAUDE);
    close(amounts(&f.conn()).cost_usd,0.003);
    f.write("p.jsonl",&[&p]); index(&f,KIND_CLAUDE);
    close(amounts(&f.conn()).cost_usd,0.003);
    assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM turn WHERE usage_state='canonical'"),1);
    assert_eq!(f.conn().query_row("SELECT cost_owner_session_id FROM turn",[],|r|r.get::<_,String>(0)).unwrap(),"p");
    assert_eq!(std::fs::read(f.logs.join("p/subagents/agent-copy.jsonl")).unwrap(),child_before);
}

#[test]
fn stage1_r2_f04_equal_positive_total_with_distinct_response_is_unresolved() {
    let f=fixture(); let mut a:Value=serde_json::from_str(&notification(1000,100,1000,100,1)).unwrap();
    a["payload"]["response_id"]=json!("A");
    f.write("p.jsonl",&[&meta("p",None,false),&context(Some("turn"),Some("stage1-a")),&a.to_string()]); index(&f,KIND_CODEX);
    let mut b=a.clone(); b["payload"]["response_id"]=json!("B"); b["ordinal"]=json!(2);
    f.append("p.jsonl",&[&b.to_string()]); index(&f,KIND_CODEX);
    f.append("p.jsonl",&[&b.to_string()]); index(&f,KIND_CODEX);
    let x=amounts(&f.conn()); close(x.cost_usd,0.003); close(x.unresolved_usd,0.003);
    assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM turn WHERE usage_state='unresolved'"),1);
    f.index(KIND_CODEX,true); let x=amounts(&f.conn()); close(x.cost_usd,0.003); close(x.unresolved_usd,0.003);
    let overview=query::overview(&f.conn(),&Range::default(),&Filters::default(),parse_ts(Some("2026-09-16T00:00:00Z")).unwrap()).unwrap();
    close(overview.totals.cost_usd,0.003);
}

#[test]
fn stage1_r2_f05_failed_signature_skips_reads_and_changed_input_retries() {
    let f=fixture(); let (p,c)=seed_legacy(&f); f.write("p.jsonl",&[&p]); f.write("p/subagents/agent-c.jsonl",&["{"]);
    let first=run_repair(&f,false); assert!(first.files_read>0 && first.failed_family_files_read>0);
    let second=run_repair(&f,false); assert_eq!(second.files_read,0); assert_eq!(second.failed_family_files_read,0); assert_eq!(second.cached_failed_groups,1);
    f.write("p/subagents/agent-c.jsonl",&[&c]); let third=run_repair(&f,false);
    assert_eq!(third.groups_repaired,1); assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM usage_repair_failure"),0);
    close(amounts(&f.conn()).cost_usd,0.009);
}

#[test]
fn stage1_r2_f05_changed_fallback_version_and_explicit_retry_read_again() {
    let f=fixture(); let (p,_)=seed_legacy(&f); f.write("p.jsonl",&[&p]); f.write("p/subagents/agent-c.jsonl",&["{"]);
    run_repair(&f,false); assert_eq!(run_repair(&f,false).files_read,0);
    let mut opts=repair_options(&f,true);
    assert!(repair::run(&mut f.conn(),&opts,&AtomicBool::new(false)).unwrap().files_read>0);
    assert_eq!(repair::run(&mut f.conn(),&opts,&AtomicBool::new(false)).unwrap().files_read,0);
    f.conn().execute("UPDATE usage_repair_failure SET version=version-1",[]).unwrap();
    assert!(repair::run(&mut f.conn(),&opts,&AtomicBool::new(false)).unwrap().files_read>0);
    assert!(repair::run_with_progress(&mut f.conn(),&opts,&AtomicBool::new(false),None,true).unwrap().files_read>0);
    opts.archive_root=Some(f.archive.clone());
    assert!(repair::run(&mut f.conn(),&opts,&AtomicBool::new(false)).unwrap().files_read>0);
}

fn cancel_fixture_at(phase: &'static str) {
    let f=fixture(); let (p,c)=seed_legacy(&f); f.write("p.jsonl",&[&p]); f.write("p/subagents/agent-c.jsonl",&[&c]);
    let before=snapshot(&f.conn()); let cancel=Arc::new(AtomicBool::new(false)); let copy=cancel.clone();
    let observed=Arc::new(Mutex::new(Vec::new())); let events=observed.clone();
    let progress:indexer::ProgressSink=Arc::new(move |p| { events.lock().unwrap().push(p.phase.clone()); if p.phase==phase { copy.store(true,Ordering::Relaxed); } });
    let result=repair::run_with_progress(&mut f.conn(),&repair_options(&f,false),&cancel,Some(progress),false).unwrap();
    assert!(result.cancelled); assert!(observed.lock().unwrap().iter().any(|s|s==phase));
    assert_eq!(before,snapshot(&f.conn()));
    assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM usage_repair_failure"),0);
    assert!(run_repair(&f,false).errors.is_empty()); close(amounts(&f.conn()).cost_usd,0.009);
}
#[test]
fn stage1_r2_f06_cancel_during_staging_rolls_back_and_resumes() { cancel_fixture_at("repair-stage-batch"); }
#[test]
fn stage1_r2_f06_cancel_during_family_swap_rolls_back_and_resumes() { cancel_fixture_at("repair-swap-row"); }

#[test]
fn stage1_r2_f06_cancel_during_final_rollup_rolls_back_only_final_transaction() {
    let f=fixture(); let (p,c)=seed_legacy(&f); f.write("p.jsonl",&[&p]); f.write("p/subagents/agent-c.jsonl",&[&c]);
    let cancel=Arc::new(AtomicBool::new(false)); let copy=cancel.clone();
    let at_rollup=Arc::new(Mutex::new(None)); let saved=at_rollup.clone(); let path=f.db.clone();
    let progress:indexer::ProgressSink=Arc::new(move |p| {
        if p.phase=="repair-rollup" { let c=Connection::open_with_flags(&path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            *saved.lock().unwrap()=Some((snapshot(&c),scalar(&c,"SELECT COUNT(*) FROM rollup_turn_session_day"),scalar(&c,"SELECT COUNT(*) FROM rollup_dirty"))); }
        if p.phase=="repair-rollup-v1-written" { copy.store(true,Ordering::Relaxed); }
    });
    let result=repair::run_with_progress(&mut f.conn(),&repair_options(&f,false),&cancel,Some(progress),false).unwrap(); assert!(result.cancelled);
    let before=at_rollup.lock().unwrap().clone().unwrap(); assert_eq!(before.0,snapshot(&f.conn()));
    assert_eq!(before.1,scalar(&f.conn(),"SELECT COUNT(*) FROM rollup_turn_session_day"));
    assert!(before.2>0); assert_eq!(before.2,scalar(&f.conn(),"SELECT COUNT(*) FROM rollup_dirty"));
    let resumed=run_repair(&f,false); assert!(resumed.errors.is_empty()); assert_eq!(resumed.files_read,0);
    assert!(rollup::ready(&f.conn()).unwrap()); close(amounts(&f.conn()).cost_usd,0.009);
}

#[test]
fn stage1_r2_f06_transaction_error_after_deletion_can_resume() {
    let f=fixture(); let (p,c)=seed_legacy(&f); f.write("p.jsonl",&[&p]); f.write("p/subagents/agent-c.jsonl",&[&c]);
    let before=snapshot(&f.conn());
    f.conn().execute_batch("CREATE TRIGGER r2_fail_swap BEFORE INSERT ON turn WHEN NEW.usage_state='canonical'
        BEGIN SELECT RAISE(ABORT,'forced swap failure'); END;").unwrap();
    let err=repair::run(&mut f.conn(),&repair_options(&f,false),&AtomicBool::new(false)).unwrap_err(); assert!(err.contains("forced swap failure"));
    assert_eq!(before,snapshot(&f.conn())); f.conn().execute_batch("DROP TRIGGER r2_fail_swap").unwrap();
    assert!(run_repair(&f,false).errors.is_empty()); close(amounts(&f.conn()).cost_usd,0.009);
}

#[test]
fn stage1_r2_f06_request_stream_final_snapshot_tie_and_256kb_boundary() {
    for initial in [2,8] {
        let f=fixture(); let initial_line=claude("p","mp","rp",1000,initial,false,TS);
        let mut complete:Value=serde_json::from_str(&claude("p","mp","rp",1000,100,false,"2026-09-15T00:00:01Z")).unwrap();
        complete["message"]["stop_reason"]=json!("end_turn");
        let mut latest=complete.clone(); latest["timestamp"]=json!("2026-09-15T00:00:02Z");
        latest["message"]["usage"]["input_tokens"]=json!(2000); latest["message"]["usage"]["cache_read_input_tokens"]=json!(777);
        let padding=json!({"type":"padding","value":"x".repeat(256*1024)}).to_string();
        let path=f.write("p.jsonl",&[&initial_line,&padding,&complete.to_string(),&latest.to_string()]);
        let c=f.conn(); seed_row(&c,"claude","p",0,"rp",parse_ts(Some(TS)).unwrap(),1000,initial,0.002+initial as f64*0.00001);
        c.execute("INSERT INTO source_file(path,kind,size_bytes,mtime_ns,parsed_bytes,parsed_lines,session_id,last_indexed)
            VALUES (?1,'claude',?2,0,?2,4,'p',0)",params![path.to_string_lossy(),std::fs::metadata(&path).unwrap().len() as i64]).unwrap();
        assert!(run_repair(&f,false).errors.is_empty()); close(amounts(&f.conn()).cost_usd,0.005);
        assert_eq!(scalar(&f.conn(),"SELECT cache_read_tokens FROM turn"),777);
        assert_eq!(scalar(&f.conn(),"SELECT ts FROM turn"),parse_ts(Some("2026-09-15T00:00:02Z")).unwrap());
        assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM usage_occurrence"),3);
        let before=snapshot(&f.conn()); run_repair(&f,false); assert_eq!(before,snapshot(&f.conn()));
        latest["message"]["usage"]["output_tokens"]=json!(120); latest["timestamp"]=json!("2026-09-15T00:00:03Z");
        f.append("p.jsonl",&[&latest.to_string()]); index(&f,KIND_CLAUDE); close(amounts(&f.conn()).cost_usd,0.0052);
        f.index(KIND_CLAUDE,true); close(amounts(&f.conn()).cost_usd,0.0052);
    }
}

#[test]
fn stage1_r2_f06_workflow_subagent_has_physical_child_identity() {
    let f=fixture(); f.write("p.jsonl",&[&claude("p","mp","rp",1000,100,false,TS)]);
    f.write("p/subagents/workflows/wf_42/agent-x.jsonl",&[&claude("p","mc","rc",2000,200,true,TS)]); index(&f,KIND_CLAUDE);
    close(amounts(&f.conn()).cost_usd,0.009);
    assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM session WHERE parent_session_id='p' AND is_sidechain=1 AND relationship_type='subagent'"),1);
}

#[test]
fn stage1_r2_f06_fallback_rejects_parent_drive_and_unc_escapes() {
    let f=fixture(); let opts=repair_options(&f,true); std::fs::create_dir_all(f.archive.join("claude")).unwrap();
    std::fs::write(f.archive.join("outside.jsonl"),b"{}\n").unwrap();
    for p in [f.logs.join("../outside.jsonl"),std::path::PathBuf::from(r"Z:\outside\evil.jsonl"),
        std::path::PathBuf::from(r"\\r2.invalid\share\evil.jsonl")] {
        assert!(repair::resolve_source(&p,KIND_CLAUDE,&opts).is_none(),"{}",p.display());
    }
}

#[cfg(windows)]
#[test]
fn stage1_r2_f06_fallback_rejects_junction_outside_root() {
    let f=fixture(); let opts=repair_options(&f,true); let root=f.archive.join("claude");
    let outside=f.archive.join("outside"); std::fs::create_dir_all(&root).unwrap(); std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("evil.jsonl"),b"{}\n").unwrap(); let link=root.join("link");
    let out=std::process::Command::new("cmd").args(["/d","/c","mklink","/J"]).arg(&link).arg(&outside).output().unwrap();
    assert!(out.status.success(),"junction creation failed: {:?}",out.status);
    assert!(link.join("evil.jsonl").is_file());
    assert!(repair::resolve_source(&f.logs.join("link/evil.jsonl"),KIND_CLAUDE,&opts).is_none());
    let direct=repair::RepairOptions { archive_root:Some(root.clone()),..opts };
    assert!(repair::resolve_source(&link.join("evil.jsonl"),KIND_CLAUDE,&direct).is_none());
}

#[cfg(any(windows,unix))]
#[test]
fn stage1_r2_f06_fallback_rejects_symlink_outside_and_accepts_inside_root() {
    let f=fixture(); let opts=repair_options(&f,true); let root=f.archive.join("claude"); std::fs::create_dir_all(&root).unwrap();
    let outside=f.archive.join("evil.jsonl"); std::fs::write(&outside,b"{}\n").unwrap();
    let inside=root.join("good.jsonl"); std::fs::write(&inside,b"{}\n").unwrap();
    #[cfg(windows)] let link=std::os::windows::fs::symlink_file;
    #[cfg(unix)] let link=std::os::unix::fs::symlink;
    link(&outside,root.join("evil.jsonl")).expect("actual symlink fixture is required");
    link(&inside,root.join("inside-link.jsonl")).unwrap();
    assert!(repair::resolve_source(&f.logs.join("evil.jsonl"),KIND_CLAUDE,&opts).is_none());
    assert!(repair::resolve_source(&f.logs.join("inside-link.jsonl"),KIND_CLAUDE,&opts).is_some());
    let direct=repair::RepairOptions { archive_root:Some(root.clone()),..opts };
    assert!(repair::resolve_source(&root.join("evil.jsonl"),KIND_CLAUDE,&direct).is_none());
    assert!(repair::resolve_source(&root.join("inside-link.jsonl"),KIND_CLAUDE,&direct).is_some());
    link(&outside,f.logs.join("original-link.jsonl")).unwrap();
    assert!(repair::resolve_source(&f.logs.join("original-link.jsonl"),KIND_CLAUDE,&direct).is_none());
}

#[test]
fn stage1_r2_ruling_preserves_rows_excludes_suspects_and_fixes_representative() {
    let f=fixture(); let c=f.conn(); let ts=parse_ts(Some(TS)).unwrap();
    for (sid,seq,req,ms) in [("b",0,"req-b",ts),("a",0,"req-a",ts),("c",0,"req-c",ts),("different-time",0,"req-d",ts+1)] {
        seed_row(&c,"claude",sid,seq,req,ms,1000,100,0.003);
    }
    for (seq,req,ms) in [(0,"tc:1:10:1100",10),(1,"tc:2:11:1100",11),(2,"tc:3:12:2200",12),(3,"tc:4:13:1100",13)] {
        seed_row(&c,"codex","cx",seq,req,ms,1000,100,0.003);
    }
    let rows=scalar(&c,"SELECT COUNT(*) FROM turn"); classify(&f); let first=snapshot(&f.conn());
    assert_eq!(rows,scalar(&c,"SELECT COUNT(*) FROM turn")); assert_eq!(scalar(&c,"SELECT COUNT(*) FROM turn WHERE usage_state='suspected_duplicate'"),4);
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM turn WHERE kind='claude' AND session_id='a' AND usage_state='legacy'"),1);
    let a=amounts(&c); close(a.cost_usd,0.012); close(a.suspected_duplicate_usd,0.012); assert_eq!(a.suspected_duplicate_rows,4);
    classify(&f); assert_eq!(first,snapshot(&f.conn()));
    { let tx=c.unchecked_transaction().unwrap(); rollup::mark_all_dirty(&tx).unwrap(); rollup::rebuild_dirty(&tx).unwrap(); tx.commit().unwrap(); }
    close(c.query_row("SELECT SUM(cost_usd) FROM rollup_turn_session_day",[],|r|r.get(0)).unwrap(),0.012);
    close(c.query_row("SELECT SUM(cost_usd) FROM rollup_turn_session_day_v2 WHERE usage_state='suspected_duplicate'",[],|r|r.get(0)).unwrap(),0.012);
    let range=Range { from:Some(0),to:Some(2_000_000_000_000),..Default::default() };
    let rolled=query::overview(&c,&range,&Filters::default(),2_000_000_000_000).unwrap(); close(rolled.totals.cost_usd,0.012);
    c.execute("DELETE FROM index_state WHERE key='rollup_version'",[]).unwrap();
    close(query::overview(&c,&range,&Filters::default(),2_000_000_000_000).unwrap().totals.cost_usd,0.012);
}

#[test]
fn stage1_r2_ruling_available_source_and_different_counters_are_not_suspects() {
    let f=fixture();
    f.write("available.jsonl",&[&claude("available","m","r",1000,100,false,TS)]);
    index(&f,KIND_CLAUDE);
    let c=f.conn(); let ts=parse_ts(Some(TS)).unwrap();
    seed_row(&c,"claude","missing",0,"s",ts,1000,100,0.003);
    seed_row(&c,"claude","different",0,"t",ts,1000,101,0.00301);
    classify(&f); assert_eq!(scalar(&c,"SELECT COUNT(*) FROM turn WHERE usage_state='suspected_duplicate'"),0);
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM turn WHERE usage_state='canonical'"),1);
}


fn r2_file_sha(path: &std::path::Path) -> String {
    use sha2::{Digest,Sha256}; use std::io::Read;
    let mut file=std::fs::File::open(path).unwrap(); let mut hash=Sha256::new(); let mut buf=vec![0;8*1024*1024];
    loop { let n=file.read(&mut buf).unwrap(); if n==0 { break; } hash.update(&buf[..n]); }
    format!("{:x}",hash.finalize())
}
fn r2_full_fingerprint(c: &Connection) -> String { r2_full_fingerprint_parts(c).0 }

fn r2_full_fingerprint_parts(c: &Connection) -> (String,Vec<Value>) {
    use sha2::{Digest,Sha256};
    let core=realdata_fingerprint(c);let mut hash=Sha256::new();hash.update(&core);
    let mut parts=vec![json!({"scope":"turn/session/alias/occurrence","sha256":core})];
    for (name,sql) in [
        ("usage_repair_group","SELECT * FROM usage_repair_group ORDER BY kind,session_id"),
        ("usage_repair_failure","SELECT * FROM usage_repair_failure ORDER BY kind,session_id"),
        ("usage_legacy_classification","SELECT * FROM usage_legacy_classification ORDER BY kind,session_id,seq"),
        ("rollup_v1","SELECT * FROM rollup_turn_session_day ORDER BY day,kind,session_id,model,model_family,effort,origin,is_sidechain"),
        ("rollup_v2","SELECT * FROM rollup_turn_session_day_v2 ORDER BY day,kind,session_id,model,model_family,effort,origin,relationship_type,usage_state")
    ] {
        let mut part=Sha256::new();let mut count=0usize;
        let mut stmt=c.prepare(sql).unwrap();let cols=stmt.column_count();let mut rows=stmt.query([]).unwrap();
        while let Some(row)=rows.next().unwrap() {
            count+=1;
            for i in 0..cols {
                use rusqlite::types::ValueRef;
                let mut both=|bytes:&[u8]| { hash.update(bytes);part.update(bytes); };
                match row.get_ref(i).unwrap() {
                    ValueRef::Null=>both(&[0]),
                    ValueRef::Integer(v)=>{both(&[1]);both(&v.to_le_bytes())},
                    ValueRef::Real(v)=>{both(&[2]);both(&v.to_le_bytes())},
                    ValueRef::Text(v)=>{both(&[3]);both(&(v.len() as u64).to_le_bytes());both(v)},
                    ValueRef::Blob(v)=>{both(&[4]);both(&(v.len() as u64).to_le_bytes());both(v)},
                }
            }
        }
        let digest=format!("{:x}",part.finalize());
        eprintln!("R2 fingerprint {name}: {count} rows, {digest}");
        parts.push(json!({"scope":name,"rows":count,"sha256":digest}));
    }
    (format!("{:x}",hash.finalize()),parts)
}

#[test]
#[ignore = "explicit R2 offline DB-copy acceptance; never opens stage-1 DB or a live profile"]
fn stage1_r2_realdata_repair() {
    assert_eq!(std::env::var("AILOG_R2_REALDATA").as_deref(),Ok("1"));
    let root=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch=root.join(".mycmux/ailog-r1"); let path=scratch.join("db/ailog_r2.db");
    assert!(path.is_file(),"prepare a fresh independent R2 DB copy first");
    let baseline:Value=serde_json::from_slice(&std::fs::read(scratch.join("evidence/realdata_baseline_r2.json")).unwrap()).unwrap();
    assert_eq!(baseline["fresh_from_original_copy"],true);
    let source_commit=std::env::var("AILOG_R2_SOURCE_COMMIT").expect("freeze and record the final source commit");
    let actual_head=std::process::Command::new("git").arg("-C").arg(root).args(["rev-parse","HEAD"]).output().unwrap();
    assert!(actual_head.status.success());
    assert_eq!(String::from_utf8(actual_head.stdout).unwrap().trim(),source_commit);
    assert_eq!(source_commit.len(),40);
    assert!(source_commit.bytes().all(|b|b.is_ascii_hexdigit()));
    // A continuation DB cannot pass this pre-open byte check.
    let actual_fresh_sha=r2_file_sha(&path);
    assert_eq!(actual_fresh_sha,baseline["source_db_sha256"].as_str().unwrap());
    eprintln!("R2 genuine fresh copy verified: {actual_fresh_sha}; source {source_commit}");
    let restore:Value=serde_json::from_slice(&std::fs::read("D:/ailog-rawlog-restore/RESTORE_DONE.json").unwrap()).unwrap();
    assert_eq!(restore["complete"],true); assert_eq!(restore["planned"],4050);
    let mut conn=crate::ailog::open_db(&path).unwrap();
    let backups=std::fs::read_dir(path.parent().unwrap()).unwrap().filter_map(Result::ok).map(|e|e.path())
        .filter(|p|p.file_name().unwrap().to_string_lossy().starts_with("ailog_r2.db.pre-v3-")).collect::<Vec<_>>();
    assert_eq!(backups.len(),1);
    let previous_backup=baseline["previous_pre_repair_backup_name"].as_str().expect("record the previous backup name");
    assert_ne!(backups[0].file_name().unwrap().to_string_lossy(),previous_backup);
    assert_eq!(std::fs::metadata(&backups[0]).unwrap().len(),baseline["source_db_size_bytes"].as_u64().unwrap());
    let backup_sha=r2_file_sha(&backups[0]);
    assert_eq!(backup_sha,baseline["source_db_sha256"].as_str().unwrap());
    let options=repair::RepairOptions {
        claude_root:Some("C:/Users/miyaz/.claude/projects".into()),codex_root:Some("C:/Users/miyaz/.codex/sessions".into()),
        claude_codex_root:Some("C:/Users/miyaz/.claude-codex/config/projects".into()),
        fallback_root:Some("D:/ailog-rawlog-restore/claude-projects".into()),
        archive_root:Some("C:/Users/miyaz/.mycmux/ailog-archive".into()),
    };
    let progress_path=scratch.join("r2/realdata_progress.json");
    let progress:indexer::ProgressSink=Arc::new(move |p| {
        let bytes=serde_json::to_vec(&json!({"phase":p.phase,"files_done":p.files_done,"files_total":p.files_total,
            "elapsed_ms":p.elapsed_ms,"at":chrono::Utc::now().to_rfc3339()})).unwrap();
        std::fs::write(&progress_path,bytes).unwrap();
    });
    let started=std::time::Instant::now();
    let first=repair::run_with_progress(&mut conn,&options,&AtomicBool::new(false),Some(progress.clone()),false).unwrap();
    assert!(!first.cancelled); let first_seconds=started.elapsed().as_secs_f64();
    eprintln!("R2 first repair complete: {}",serde_json::to_string(&first).unwrap());
    assert!(first.files_read>0 && first.groups_repaired>0,"the first call must actually repair a pre-v3 source copy");
    let (fingerprint,first_fingerprint_parts)=r2_full_fingerprint_parts(&conn);
    std::fs::write(scratch.join("r2/first_run_checkpoint.json"),serde_json::to_vec_pretty(&json!({
        "realdata_source_commit":source_commit,"first_run":first,"first_seconds":first_seconds,
        "fingerprint":fingerprint,"fingerprint_parts":first_fingerprint_parts})).unwrap()).unwrap();
    let second_started=std::time::Instant::now();
    let second=repair::run_with_progress(&mut conn,&options,&AtomicBool::new(false),Some(progress),false).unwrap();
    assert!(!second.cancelled); let second_seconds=second_started.elapsed().as_secs_f64();
    eprintln!("R2 second repair complete: {}",serde_json::to_string(&second).unwrap());
    let (second_fingerprint,second_fingerprint_parts)=r2_full_fingerprint_parts(&conn);
    let from=parse_ts(Some("2026-09-13T15:00:00Z")).unwrap(); let to=parse_ts(Some("2026-10-13T15:00:00Z")).unwrap();
    let sum=|condition: &str| conn.query_row(&format!("SELECT COALESCE(SUM(t.cost_usd),0) FROM turn t JOIN session s
        ON s.kind=t.kind AND s.session_id=t.session_id WHERE t.ts>=?1 AND t.ts<?2
        AND COALESCE(s.origin,'unknown')!='ailog-internal' AND ({condition})"),params![from,to],|r|r.get::<_,f64>(0)).unwrap();
    let w4=sum("t.usage_state IN ('canonical','legacy')");
    close(query::accounting_totals(&conn,&Range {from:Some(from),to:Some(to-1),..Default::default()},&Filters::default(),to).unwrap().cost_usd,w4);
    let all_time:f64=conn.query_row("SELECT COALESCE(SUM(cost_usd),0) FROM turn WHERE usage_state IN ('canonical','legacy')",[],|r|r.get(0)).unwrap();
    let state=|kind: &str,state: &str|conn.query_row("SELECT COUNT(*),COALESCE(SUM(cost_usd),0) FROM turn WHERE kind=?1 AND usage_state=?2",
        params![kind,state],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,f64>(1)?))).unwrap();
    let cl=state("claude","suspected_duplicate"); let cc=state("claude-codex","suspected_duplicate"); let cx=state("codex","suspected_duplicate");
    eprintln!("R2 final global F01 residual check");
    let f01=legacy::claude_copy_proofs(&conn).unwrap().len();
    let unresolved:f64=conn.query_row("SELECT COALESCE(SUM(cost_usd),0) FROM turn WHERE usage_state='unresolved'",[],|r|r.get(0)).unwrap();
    let result=json!({"fresh_from_original_copy":true,"source_db_sha256":actual_fresh_sha,"restore_done_present":true,
        "realdata_source_commit":source_commit,"source_db_size_bytes":baseline["source_db_size_bytes"],
        "pre_repair_backup":{"path":backups[0],"sha256":backup_sha},
        "all_time_total_before_usd":baseline["all_time_total_before_usd"],"all_time_total_after_usd":all_time,
        "w4_before_inclusive_usd":baseline["w4_before_inclusive_usd"],"w4_default_total_usd":w4,
        "suspected_duplicate":{"claude_rows":cl.0+cc.0,"claude_usd":cl.1+cc.1,"codex_rows":cx.0,"codex_usd":cx.1},
        "unresolved_usd":unresolved,"f01_residual_rows":f01,"second_run_identical":fingerprint==second_fingerprint,
        "second_run_failed_family_files_read":second.failed_family_files_read,
        "first_run":first,"second_run":second,"first_run_seconds":first_seconds,"second_run_seconds":second_seconds,
        "first_fingerprint":fingerprint,"second_fingerprint":second_fingerprint,
        "first_fingerprint_parts":first_fingerprint_parts,"second_fingerprint_parts":second_fingerprint_parts,
        "original_claude_root":options.claude_root,"original_codex_root":options.codex_root,
        "original_claude_codex_root":options.claude_codex_root,"archive_root":options.archive_root,"fallback_root":options.fallback_root,
        "w4_legacy_usd":sum("t.usage_state='legacy'"),"w4_unresolved_usd":sum("t.usage_state='unresolved'"),
        "w4_suspected_duplicate_usd":sum("t.usage_state='suspected_duplicate'"),
        "turn_count":scalar(&conn,"SELECT COUNT(*) FROM turn"),"session_count":scalar(&conn,"SELECT COUNT(*) FROM session"),
        "db_path":path,"financial_cause_analysis_pending":true});
    std::fs::write(scratch.join("evidence/realdata_check_r2.json"),serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    eprintln!("{}",serde_json::to_string_pretty(&result).unwrap());
    assert_eq!(fingerprint,second_fingerprint); assert_eq!(second.failed_family_files_read,0); assert_eq!(f01,0);
}

#[test]
fn stage1_r2_f02_shared_request_owner_transfer_keeps_distinct_messages() {
    let f=fixture();
    f.write("z.jsonl",&[&claude("z","msg-A","same-request",1000,100,false,TS)]);
    f.write("a.jsonl",&[&claude("a","msg-B","same-request",2000,200,false,TS)]);
    index(&f,KIND_CLAUDE); close(amounts(&f.conn()).cost_usd,0.009);
    f.append("a.jsonl",&[&claude("a","msg-A","same-request",1000,50,false,TS)]);
    index(&f,KIND_CLAUDE); close(amounts(&f.conn()).cost_usd,0.009);
    assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM turn WHERE session_id='a' AND usage_state='canonical'"),2);
    assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM turn WHERE request_id='same-request'"),1);
    f.index(KIND_CLAUDE,true); close(amounts(&f.conn()).cost_usd,0.009);
    assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM turn WHERE usage_state='canonical'"),2);
}


#[test]
fn stage1_r2_ruling_available_sibling_does_not_witness_unmatched_legacy() {
    let f=fixture(); let c=f.conn(); let ts=parse_ts(Some(TS)).unwrap();
    for sid in ["a","b","c"] { seed_row(&c,"claude",sid,0,sid,ts,1000,100,0.003); }
    let child=f.write("a/subagents/agent-unrelated.jsonl",&[&claude("a","other-message","other-request",2000,200,true,TS)]);
    c.execute("INSERT INTO source_file(path,kind,size_bytes,mtime_ns,parsed_bytes,parsed_lines,session_id,last_indexed)
        VALUES (?1,'claude',0,0,0,0,'a',0)",params![child.to_string_lossy()]).unwrap();
    c.execute("INSERT INTO session_identity_alias VALUES ('claude','b','unrelated',?1)",params![child.to_string_lossy()]).unwrap();
    classify(&f);
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM turn WHERE usage_state='suspected_duplicate'"),2);
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM turn WHERE session_id='a' AND usage_state='legacy'"),1);
    let before=snapshot(&c); classify(&f); assert_eq!(before,snapshot(&c));
    c.execute("DELETE FROM turn WHERE kind='claude' AND session_id='a'",[]).unwrap();
    classify(&f);
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM turn WHERE session_id='b' AND usage_state='legacy'"),1);
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM usage_legacy_classification WHERE representative_session_id='b'"),1);
    seed_row(&c,"claude","0",0,"new-earlier-representative",ts,1000,100,0.003);
    classify(&f);
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM turn WHERE usage_state='suspected_duplicate'"),2);
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM usage_legacy_classification WHERE representative_session_id='0'"),2);
}

#[test]
fn stage1_r2_f06_late_family_orphan_is_recovered_before_first_run_returns() {
    let f=fixture();
    for sid in ["a","z"] {
        f.write(&format!("{sid}.jsonl"),&[&meta(sid,None,false),&context(Some(sid),Some("stage1-a")),&notification(1000,100,1000,100,1)]);
    }
    index(&f,KIND_CODEX); let c=f.conn();
    c.execute_batch("DELETE FROM usage_repair_group;
      CREATE TABLE r2_fault_once(done INTEGER);
      CREATE TRIGGER r2_late_orphan AFTER INSERT ON usage_repair_group
      WHEN NEW.kind='codex' AND NEW.session_id='z' AND NOT EXISTS(SELECT 1 FROM r2_fault_once)
      BEGIN DELETE FROM turn WHERE kind='codex' AND session_id='a' AND usage_state='canonical';
        INSERT INTO r2_fault_once VALUES (1); END;").unwrap();
    let first=run_repair(&f,false);
    assert_eq!(first.consistency_retries,1); assert_eq!(first.groups_repaired,3);
    assert!(accounting::codex_orphan_repair_sources(&c).unwrap().is_empty());
    assert!(accounting::codex_suffix_repair_sources(&c).unwrap().is_empty());
    close(amounts(&c).cost_usd,0.006);
    let before=r2_full_fingerprint(&c);let next=run_repair(&f,false);
    assert_eq!(next.files_read,0);assert_eq!(next.consistency_retries,0);
    assert_eq!(before,r2_full_fingerprint(&c));
}

#[test]
fn stage1_r2_f06_malformed_old_codex_ids_keep_first_repair_family_keys() {
    let f=fixture();let c=f.conn();
    for index in 0..7 {
        let sid=format!("01a00000-0000-7000-8000-{:012}",100+index);
        let day=if index<4 { "01" } else { "02" };
        let clock=format!("00-00-{:02}",index+1);
        let legacy=format!("08-{day}T{clock}-{sid}");
        assert!(sid<legacy);
        let file=format!("rollout-2020-08-{day}T{clock}-{sid}.jsonl");
        let path=f.write(&file,&[&meta(&sid,None,false),&context(Some(&sid),Some("stage1-a")),
            &notification(1000,100,1000,100,1)]);
        let bytes=std::fs::metadata(&path).unwrap().len() as i64;
        let ts=parse_ts(Some("2026-09-15T00:00:01Z")).unwrap();
        seed_row(&c,"codex",&legacy,0,&format!("tc:1:{ts}:1100"),ts,1000,100,0.003);
        c.execute("INSERT INTO source_file(path,kind,size_bytes,mtime_ns,parsed_bytes,parsed_lines,session_id,last_indexed)
            VALUES (?1,'codex',?2,0,?2,3,?3,0)",params![path.to_string_lossy(),bytes,legacy]).unwrap();
    }
    let first=run_repair(&f,false);
    assert_eq!(first.groups_repaired,7);assert_eq!(first.files_read,7);
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM usage_repair_group"),7);
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM session_identity_alias WHERE legacy_session_id!=execution_session_id"),7);
    close(amounts(&c).cost_usd,0.021);
    let before=r2_full_fingerprint(&c);let second=run_repair(&f,false);
    assert_eq!(second.groups_repaired,0);assert_eq!(second.files_read,0);
    assert_eq!(second.consistency_retries,0);
    assert_eq!(scalar(&c,"SELECT COUNT(*) FROM usage_repair_group"),7);
    assert_eq!(before,r2_full_fingerprint(&c));
}

//! SQL literals extracted without semantic edits from 5db18863b.
//! G1-5/legacy-source-manifest.json records originals, SQL and the sole DB adapter.
#[path="legacy_db_0900.rs"]
mod db;
#[path="legacy_rollup_0900.rs"]
mod rollup;
use rusqlite::{Connection,params};
pub fn open(path:&std::path::Path)->Connection { db::writer(path).unwrap() }
pub const FILE_SQL:&str=include_str!("legacy_0900/file.sql");
pub fn ingest(conn:&Connection,request:&str,seq:i64,ts:i64,model:&str,input:i64,output:i64) {
    let tx=conn.unchecked_transaction().unwrap();
    rollup::mark_session_dirty(&tx,"codex","legacy-session").unwrap();
    tx.execute(include_str!("legacy_0900/session.sql"),params![
        "codex","legacy-session",None::<String>,"fixture",None::<String>,"main",
        None::<String>,None::<String>,None::<String>,"cli","other",0,None::<String>,
        None::<String>,None::<String>,ts,ts,0,0,0,0,0,0,false]).unwrap();
    tx.execute(include_str!("legacy_0900/turn.sql"),params![
        "codex","legacy-session",seq,request,ts,model,model,None::<String>,None::<String>,None::<String>,
        input,output,0,0,0,0,0,0,0.125,0.0,0.125,None::<String>,"legacy"]).unwrap();
    tx.execute(FILE_SQL,params!["codex","legacy-session","legacy.rs",3,0,ts,ts]).unwrap();
    rollup::mark_session_dirty(&tx,"codex","legacy-session").unwrap();
    rollup::rebuild_dirty(&tx).unwrap();
    tx.commit().unwrap();
}
pub fn light(conn:&Connection)->Vec<(String,i64,f64)> {
    let sql=include_str!("legacy_0900/light-accounting.sql").replace("{suffix}","");
    conn.prepare(&sql).unwrap().query_map([20000,20001],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))
        .unwrap().collect::<Result<_,_>>().unwrap()
}
pub fn rhythm(conn:&Connection)->Vec<(i64,i64,i64,i64,i64)> {
    let sql=include_str!("legacy_0900/rhythm.sql").replace("{shift}","32400000")
        .replace("{DAY_MS}","86400000")
        .replace("{where_sql}","t.usage_state IN ('canonical','legacy') AND t.ts >= ? AND t.ts <= ?");
    conn.prepare(&sql).unwrap().query_map([super::agg::day_bounds(20000).0,super::agg::day_bounds(20001).1],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap().collect::<Result<_,_>>().unwrap()
}

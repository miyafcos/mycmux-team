//! Preserve excluded legacy rows and the structural reason for their decision.
use std::collections::{BTreeMap, HashSet};
use rusqlite::{params, Connection, Transaction};
use super::{accounting, repair, rollup};

#[derive(Debug)]
pub struct CopyProof {
    pub kind: String, pub session_id: String, pub seq: i64,
    pub canonical_session_id: String, pub canonical_seq: i64,
    pub execution_key: String, pub source_path: String, pub source_line: i64,
}

/// Native key + an actual observation, including an earlier equally complete
/// snapshot, proves a debit in another physical conversation is a copy.
pub fn claude_copy_proofs(conn: &Connection) -> Result<Vec<CopyProof>,String> {
    let mut stmt=conn.prepare("SELECT DISTINCT legacy.kind,legacy.session_id,legacy.seq,
        canonical.session_id,canonical.seq,canonical.execution_key,e.source_path,e.source_line
      FROM turn canonical INDEXED BY ux_turn_canonical_execution
      CROSS JOIN usage_occurrence e INDEXED BY ix_usage_occurrence_execution
      CROSS JOIN turn legacy INDEXED BY ix_turn_native_usage_v3
      WHERE canonical.kind IN ('claude','claude-codex') AND canonical.usage_state='canonical'
        AND canonical.execution_key IS NOT NULL AND canonical.execution_key GLOB 'claude-exec:*'
        AND e.kind=canonical.kind AND e.execution_key=canonical.execution_key
        AND legacy.kind=canonical.kind AND legacy.usage_state='legacy'
        AND legacy.session_id!=canonical.session_id
        AND legacy.request_id=COALESCE(json_extract(e.evidence_json,'$.request_id'),json_extract(e.evidence_json,'$.message_id'),e.source_event_id)
        AND legacy.ts=e.observed_ts AND legacy.model IS canonical.model
        AND legacy.model IS COALESCE(json_extract(e.evidence_json,'$.model'),canonical.model)
        AND ABS(legacy.cost_usd-canonical.cost_usd)<0.000000001
        AND legacy.input_tokens=canonical.input_tokens AND legacy.output_tokens=canonical.output_tokens
        AND legacy.cache_read_tokens=canonical.cache_read_tokens
        AND legacy.cache_write_5m_tokens=canonical.cache_write_5m_tokens
        AND legacy.cache_write_1h_tokens=canonical.cache_write_1h_tokens
        AND legacy.reasoning_tokens=canonical.reasoning_tokens
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
          THEN COALESCE(json_extract(e.evidence_json,'$.last.cache_creation.ephemeral_1h_input_tokens'),0) ELSE 0 END
        AND legacy.reasoning_tokens=0
      ORDER BY legacy.kind,legacy.session_id,legacy.seq,canonical.session_id,e.source_path,e.source_line")
      .map_err(|e|e.to_string())?;
    let rows=stmt.query_map([],|r|Ok(CopyProof { kind:r.get(0)?,session_id:r.get(1)?,seq:r.get(2)?,
        canonical_session_id:r.get(3)?,canonical_seq:r.get(4)?,execution_key:r.get(5)?,source_path:r.get(6)?,source_line:r.get(7)? }))
        .map_err(|e|e.to_string())?;
    let mut seen=HashSet::new(); let mut proofs=Vec::new();
    for row in rows { let row=row.map_err(|e|e.to_string())?;
        if seen.insert((row.kind.clone(),row.session_id.clone(),row.seq)) { proofs.push(row); }
    }
    Ok(proofs)
}

pub fn reconcile_proven(tx: &Transaction<'_>, touched: &mut accounting::Touched,
    checkpoint: &dyn Fn(&str)->Result<(),String>) -> Result<usize,String> {
    checkpoint("repair-legacy-proof")?;
    let proofs=claude_copy_proofs(tx)?;
    for p in &proofs {
        checkpoint("repair-legacy-proof")?;
        rollup::mark_session_dirty(tx,&p.kind,&p.session_id)?;
        tx.execute("UPDATE turn SET usage_state='duplicate' WHERE kind=?1 AND session_id=?2 AND seq=?3 AND usage_state='legacy'",
            params![p.kind,p.session_id,p.seq]).map_err(|e|e.to_string())?;
        tx.execute("INSERT OR REPLACE INTO usage_legacy_classification
          (kind,session_id,seq,decision,reason,representative_session_id,representative_seq,execution_key,source_path,source_line)
          VALUES (?1,?2,?3,'duplicate','native-observation-exact',?4,?5,?6,?7,?8)",
          params![p.kind,p.session_id,p.seq,p.canonical_session_id,p.canonical_seq,p.execution_key,p.source_path,p.source_line]).map_err(|e|e.to_string())?;
        touched.insert((p.kind.clone(),p.session_id.clone()));
    }
    Ok(proofs.len())
}

/// A surviving legacy debit has no usable observation for that debit.
/// An available sibling or alias path is not evidence for its native usage.
/// Exact legacy-only groups are suspicion under the ruling, never proof.
pub fn classify_suspected(tx: &Transaction<'_>, _options: &repair::RepairOptions,
    touched: &mut accounting::Touched, checkpoint: &dyn Fn(&str)->Result<(),String>) -> Result<usize,String> {
    // Recompute the deterministic representative when source-backed rows
    // arrive or a formerly chosen representative leaves the legacy group.
    let candidates:Vec<(String,String,i64,String,i64)>={
        let mut stmt=tx.prepare("WITH eligible AS MATERIALIZED (
            SELECT t.* FROM turn t JOIN session s ON s.kind=t.kind AND s.session_id=t.session_id
            WHERE t.kind IN ('claude','claude-codex') AND t.usage_state IN ('legacy','suspected_duplicate')
              AND COALESCE(s.origin,'unknown')!='ailog-internal'),
          ranked AS (
            SELECT e.*,FIRST_VALUE(session_id) OVER w AS representative,
              FIRST_VALUE(seq) OVER w AS representative_seq,MIN(session_id) OVER w AS first_session,
              MAX(session_id) OVER w AS last_session
            FROM eligible e WINDOW w AS (PARTITION BY kind,ts,input_tokens,output_tokens,cache_read_tokens,
              cache_write_5m_tokens,cache_write_1h_tokens,reasoning_tokens,model,cost_usd
              ORDER BY session_id,seq ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING))
          SELECT kind,session_id,seq,representative,representative_seq FROM ranked
          WHERE first_session!=last_session
            AND (session_id!=representative OR seq!=representative_seq)")
            .map_err(|e|e.to_string())?;
        let rows=stmt.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(|e|e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e|e.to_string())?
    };
    let mut all=candidates;
    // The suffix is deliberately not an execution proof: epoch is unavailable.
    let mut codex:BTreeMap<(String,i64),Vec<(String,i64,i64)>>=BTreeMap::new();
    {
        let mut stmt=tx.prepare("SELECT t.session_id,t.seq,t.ts,t.request_id FROM turn t JOIN session s
            ON s.kind=t.kind AND s.session_id=t.session_id WHERE t.kind='codex'
              AND t.usage_state IN ('legacy','suspected_duplicate') AND t.request_id GLOB 'tc:*'
              AND COALESCE(s.origin,'unknown')!='ailog-internal'").map_err(|e|e.to_string())?;
        let mut rows=stmt.query([]).map_err(|e|e.to_string())?;
        while let Some(r)=rows.next().map_err(|e|e.to_string())? {
            checkpoint("repair-legacy-classify")?;
            let sid:String=r.get(0).map_err(|e|e.to_string())?;
            let seq:i64=r.get(1).map_err(|e|e.to_string())?;
            let ts:i64=r.get(2).map_err(|e|e.to_string())?;
            let key:String=r.get(3).map_err(|e|e.to_string())?;
            let parts=key.split(':').collect::<Vec<_>>();
            if parts.len()==4 && parts[1].parse::<i64>().is_ok() && parts[2].parse::<i64>().is_ok() {
                if let Ok(total)=parts[3].parse::<i64>() {
                    codex.entry((sid,total)).or_default().push((key,ts,seq));
                }
            }
        }
    }
    for ((sid,_),mut rows) in codex {
        rows.sort_by(|a,b|(a.1,a.2,&a.0).cmp(&(b.1,b.2,&b.0)));
        let representative=rows[0].2;
        for (_,_,seq) in rows.into_iter().skip(1) { all.push(("codex".into(),sid.clone(),seq,sid.clone(),representative)); }
    }
    let expected:HashSet<_>=all.iter().map(|(k,s,q,_,_)|(k.clone(),s.clone(),*q)).collect();
    let prior:Vec<(String,String,i64)>={
        let mut stmt=tx.prepare("SELECT kind,session_id,seq FROM turn WHERE usage_state='suspected_duplicate'")
            .map_err(|e|e.to_string())?;
        let rows=stmt.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e|e.to_string())?
    };
    for (kind,sid,seq) in prior {
        checkpoint("repair-legacy-classify")?;
        if expected.contains(&(kind.clone(),sid.clone(),seq)) { continue; }
        rollup::mark_session_dirty(tx,&kind,&sid)?;
        tx.execute("UPDATE turn SET usage_state='legacy' WHERE kind=?1 AND session_id=?2 AND seq=?3",
            params![kind,sid,seq]).map_err(|e|e.to_string())?;
        tx.execute("DELETE FROM usage_legacy_classification WHERE kind=?1 AND session_id=?2 AND seq=?3 AND decision='suspected_duplicate'",
            params![kind,sid,seq]).map_err(|e|e.to_string())?;
        touched.insert((kind,sid));
    }
    let mut count=0;
    for (kind,sid,seq,representative,representative_seq) in all {
        checkpoint("repair-legacy-classify")?;
        let changed=tx.execute("UPDATE turn SET usage_state='suspected_duplicate' WHERE kind=?1 AND session_id=?2 AND seq=?3 AND usage_state='legacy'",
            params![kind,sid,seq]).map_err(|e|e.to_string())?;
        let reason=if kind=="codex" { "unwitnessed-legacy-equal-cumulative" } else { "unwitnessed-legacy-equal-time-counters-model-cost" };
        let same:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM usage_legacy_classification WHERE kind=?1 AND session_id=?2
            AND seq=?3 AND decision='suspected_duplicate' AND reason=?4 AND representative_session_id=?5 AND representative_seq=?6)",
            params![kind,sid,seq,reason,representative,representative_seq],|r|r.get(0)).map_err(|e|e.to_string())?;
        if changed==0 && same { continue; }
        if changed>0 { rollup::mark_session_dirty(tx,&kind,&sid)?; touched.insert((kind.clone(),sid.clone())); }
        tx.execute("INSERT OR REPLACE INTO usage_legacy_classification
            (kind,session_id,seq,decision,reason,representative_session_id,representative_seq)
            VALUES (?1,?2,?3,'suspected_duplicate',?4,?5,?6)",params![kind,sid,seq,reason,representative,representative_seq]).map_err(|e|e.to_string())?;
        count+=changed;
    }
    Ok(count)
}

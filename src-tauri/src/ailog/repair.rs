//! Resumable, per-source-family repair. Original rows remain visible until a
//! staged family is ready to swap in one transaction. Missing input is legacy.
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension};
use serde::Serialize;

use super::{
    accounting, index, parse_claude, parse_codex, price::PriceTable, rollup, SessionChunk, TurnRow,
    KIND_CLAUDE, KIND_CLAUDE_CODEX, KIND_CODEX,
};

pub const VERSION: i64 = 2;
const BATCH_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone)]
pub struct RepairOptions {
    pub claude_root: Option<PathBuf>,
    pub codex_root: Option<PathBuf>,
    pub claude_codex_root: Option<PathBuf>,
    pub fallback_root: Option<PathBuf>,
    pub archive_root: Option<PathBuf>,
}

impl Default for RepairOptions {
    fn default() -> Self {
        Self {
            claude_root: super::claude_root(),
            codex_root: super::codex_root(),
            claude_codex_root: super::claude_codex_root(),
            fallback_root: None,
            archive_root: super::archive_root(),
        }
    }
}

#[derive(Debug, Default, Serialize)]
pub struct RepairReport {
    pub groups_seen: usize,
    pub groups_repaired: usize,
    pub groups_unchanged: usize,
    pub sessions_resplit: usize,
    pub sessions_still_legacy: i64,
    pub files_read: usize,
    pub failed_family_files_read: usize,
    pub cached_failed_groups: usize,
    pub consistency_retries: usize,
    pub proven_legacy_copies: usize,
    pub suspected_legacy_copies: usize,
    pub cancelled: bool,
    pub errors: Vec<String>,
}

#[derive(Clone, Serialize)]
struct Source {
    path: String,
    parsed_bytes: i64,
    size: i64,
    stored_session: String,
    legacy_session: String,
}

fn family_root(parents: &mut BTreeMap<String, String>, id: &str) -> String {
    let mut node = id.to_string();
    parents.entry(node.clone()).or_insert_with(|| node.clone());
    let mut path = Vec::new();
    loop {
        let next = parents[&node].clone();
        if next == node { break; }
        path.push(node);
        node = next;
    }
    for entry in path { parents.insert(entry, node.clone()); }
    node
}

fn join_family(parents: &mut BTreeMap<String, String>, first: &str, second: &str) {
    let first = family_root(parents, first);
    let second = family_root(parents, second);
    if first != second {
        let (root, child) = if first < second { (first, second) } else { (second, first) };
        parents.insert(child, root);
    }
}

fn expected_source_session(kind: &str, source: &Source) -> String {
    let stem=Path::new(&source.path).file_name().and_then(|s|s.to_str()).unwrap_or("")
        .trim_end_matches(".gz").trim_end_matches(".jsonl");
    if kind==KIND_CODEX {
        let physical=parse_codex::session_id_from_filename(stem);
        return if parse_codex::is_rollout_uuid(physical) { physical.to_string() }
            else { source.stored_session.clone() };
    }
    // A fresh source-aware index already holds the hashed old-style agent id.
    // Its original native parent cannot be recovered from that hash alone.
    if stem.starts_with("agent-") && source.legacy_session.starts_with("claude-child:")
        && !source.path.replace('\\',"/").contains("/subagents/") {
        return source.stored_session.clone();
    }
    parse_claude::source_identity(Path::new(&source.path),&source.legacy_session).0
}

/// Old headers can name another physical source. A family swap must
/// include the transitive closure of those identities, or a later old-session
/// cleanup can erase canonical turns that an earlier family just installed.
fn merge_source_families(groups: BTreeMap<(String,String),Vec<Source>>)
    -> BTreeMap<(String,String),Vec<Source>> {
    let mut parents: BTreeMap<String,BTreeMap<String,String>> = BTreeMap::new();
    for ((kind, sid), sources) in &groups {
        let kind_parents=parents.entry(kind.clone()).or_default();
        for source in sources {
            join_family(kind_parents, sid, &source.stored_session);
            join_family(kind_parents,sid,&expected_source_session(kind,source));
            if kind!=KIND_CODEX && source.path.replace('\\',"/").contains("/subagents/") {
                if let Some(parent)=parse_claude::source_identity(Path::new(&source.path),&source.legacy_session).1 {
                    join_family(kind_parents,sid,&parent);
                }
            }
        }
    }
    let mut result = BTreeMap::new();
    let mut components: BTreeMap<(String,String),(BTreeSet<String>,Vec<Source>)> = BTreeMap::new();
    for ((kind, sid), sources) in groups {
        let component = components.entry((kind.clone(),family_root(parents.get_mut(&kind).unwrap(),&sid))).or_default();
        component.0.insert(sid);
        component.1.extend(sources);
    }
    for ((kind,_), (members, mut sources)) in components {
        sources.sort_by(|a,b|a.path.cmp(&b.path));
        let key = if members.len()==1 { members.into_iter().next().unwrap() }
            else { accounting::key("source-family",&(&kind,&members)) };
        result.insert((kind,key),sources);
    }
    result
}

/// Only an exact relative path below the configured original root is eligible.
/// This function never opens a writable handle in either source tree.
pub fn resolve_source(path: &Path, kind: &str, options: &RepairOptions) -> Option<PathBuf> {
    let original_root = match kind {
        KIND_CLAUDE => options.claude_root.as_ref(),
        KIND_CLAUDE_CODEX => options.claude_codex_root.as_ref(),
        _ => options.codex_root.as_ref(),
    };
    // Reject a drive/UNC/component escape before probing the filesystem. This
    // also avoids network I/O for an untrusted UNC path in a stale source row.
    let lexical = |root: &Path| path.strip_prefix(root).ok().is_some_and(|r|
        r.components().all(|p|matches!(p,std::path::Component::Normal(_))));
    if original_root.is_some() && !original_root.is_some_and(|r|lexical(r))
        && !options.archive_root.as_ref().is_some_and(|r|lexical(r)) { return None; }
    let direct_root=original_root.filter(|r|lexical(r))
        .or_else(||options.archive_root.as_ref().filter(|r|lexical(r)));
    if path.is_file() {
        return direct_root.map_or(true,|root|contained_file(root,path)).then(||path.to_path_buf());
    }
    let gzip = PathBuf::from(format!("{}.gz", path.to_string_lossy()));
    if gzip.is_file() {
        return direct_root.map_or(true,|root|contained_file(root,&gzip)).then_some(gzip);
    }
    let original = if kind == KIND_CLAUDE {
        options.claude_root.clone()
    } else if kind == KIND_CLAUDE_CODEX {
        options.claude_codex_root.clone()
    } else {
        options.codex_root.clone()
    };
    let relative = path.strip_prefix(original.as_ref()?).ok()?;
    if relative
        .components()
        .any(|p| !matches!(p, std::path::Component::Normal(_)))
    {
        return None;
    }
    if kind == KIND_CLAUDE {
        if let Some(root) = &options.fallback_root {
            let candidate = root.join(relative);
            if contained_file(root, &candidate) {
                return Some(candidate);
            }
            let gzip = PathBuf::from(format!("{}.gz", candidate.to_string_lossy()));
            if contained_file(root, &gzip) {
                return Some(gzip);
            }
        }
    }
    let archive = options.archive_root.as_ref()?;
    let candidate = archive.join(kind).join(relative);
    if contained_file(archive, &candidate) {
        return Some(candidate);
    }
    let gzip = PathBuf::from(format!("{}.gz", candidate.to_string_lossy()));
    contained_file(archive, &gzip).then_some(gzip)
}

fn contained_file(root: &Path, candidate: &Path) -> bool {
    candidate.is_file() && root.canonicalize().ok().zip(candidate.canonicalize().ok())
        .is_some_and(|(root, target)| target.starts_with(root))
}

pub fn repair_pending(
    conn: &mut Connection,
    fallback: Option<&Path>,
    archive: Option<&Path>,
    cancel: &AtomicBool,
    progress: Option<index::ProgressSink>,
) -> Result<RepairReport, String> {
    run_with_progress(
        conn,
        &RepairOptions {
            fallback_root: fallback.map(Path::to_path_buf),
            archive_root: archive.map(Path::to_path_buf).or_else(super::archive_root),
            ..Default::default()
        },
        cancel, progress, false,
    )
}

fn kind_static(kind: &str) -> &'static str {
    match kind {
        KIND_CODEX => KIND_CODEX,
        KIND_CLAUDE_CODEX => KIND_CLAUDE_CODEX,
        _ => KIND_CLAUDE,
    }
}

/// Each proof retains the old native session as well as its physical alias.
/// A source can contain copied rows whose old turn lived under another native
/// session; remove only its witnessed request/message/event keys, never all of
/// that other session's unavailable history.
fn legacy_usage_proofs(stage: &Connection, sources: &[&Source]) -> Result<BTreeSet<(String,String,String,String)>,String> {
    let mut proofs=BTreeSet::new();
    let mut stmt=stage.prepare("SELECT source_path,source_session_id,
        CASE WHEN json_type(evidence_json,'$.source_session_id')='text' THEN json_extract(evidence_json,'$.source_session_id') END,
        CASE WHEN kind='codex' THEN 'tc:' || COALESCE(json_extract(evidence_json,'$.ordinal'),-1) || ':' || COALESCE(observed_ts,0)
            || ':' || COALESCE(json_extract(evidence_json,'$.total.total_tokens'),0)
          ELSE COALESCE(json_extract(evidence_json,'$.request_id'),json_extract(evidence_json,'$.message_id'),source_event_id) END,
        CASE WHEN kind!='codex' THEN json_extract(evidence_json,'$.message_id') END,
        CASE WHEN kind!='codex' THEN source_event_id END FROM usage_occurrence")
        .map_err(|e|e.to_string())?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,
        r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?)))
        .map_err(|e|e.to_string())?;
    for row in rows {
        let (path,physical,native,key,message,event)=row.map_err(|e|e.to_string())?;
        let source=sources.iter().find(|s|s.path==path).ok_or("native proof source missing from family")?;
        let execution_session=physical.clone().unwrap_or_else(||source.stored_session.clone());
        let sessions=[Some(source.legacy_session.clone()),physical,native];
        for sid in sessions.into_iter().flatten() {
            for request in [key.as_ref(),message.as_ref(),event.as_ref()].into_iter().flatten() {
                proofs.insert((sid.clone(),request.clone(),execution_session.clone(),path.clone()));
            }
        }
    }
    Ok(proofs)
}

/// Retry legacy families when a configured root or input availability changes.
/// Successful family signatures are durable; cancellation commits no partial
/// family, and a later invocation resumes the remaining families.
pub fn run(conn: &mut Connection, options: &RepairOptions, cancel: &AtomicBool) -> Result<RepairReport,String> {
    run_with_progress(conn, options, cancel, None, false)
}

struct Control<'a> {
    cancel: &'a AtomicBool,
    progress: Option<index::ProgressSink>,
    started: std::time::Instant,
    last_emit: std::cell::RefCell<(String,std::time::Instant)>,
    files: std::cell::Cell<usize>,
    total: std::cell::Cell<usize>,
}
impl Control<'_> {
    fn check(&self) -> Result<(),String> {
        if self.cancel.load(Ordering::Relaxed) { Err("usage repair cancelled".into()) } else { Ok(()) }
    }
    fn pulse(&self, phase: &str) -> Result<(),String> {
        self.check()?;
        let mut last=self.last_emit.borrow_mut();
        if last.0!=phase || last.1.elapsed()>=std::time::Duration::from_millis(250) {
            if let Some(progress)=&self.progress {
                progress(index::IndexProgress { phase:phase.to_string(),files_done:self.files.get(),
                    files_total:self.total.get(),elapsed_ms:self.started.elapsed().as_millis() as u64,..Default::default() });
            }
            *last=(phase.to_string(),std::time::Instant::now());
        }
        self.check()
    }
}

pub fn run_with_progress(conn: &mut Connection, options: &RepairOptions, cancel: &AtomicBool,
    progress: Option<index::ProgressSink>, force_retry: bool) -> Result<RepairReport,String> {
    let mut report=RepairReport::default();
    let started=std::time::Instant::now();
    let control=Control { cancel,progress,started,last_emit:std::cell::RefCell::new((String::new(),started)),
        files:std::cell::Cell::new(0),total:std::cell::Cell::new(0) };
    let interrupt=conn.get_interrupt_handle();
    let done=AtomicBool::new(false);
    let result=std::thread::scope(|scope| {
        struct Stop<'a>(&'a AtomicBool);
        impl Drop for Stop<'_> { fn drop(&mut self) { self.0.store(true,Ordering::Relaxed); } }
        let done_ref=&done;
        scope.spawn(move || {
            while !done_ref.load(Ordering::Relaxed) {
                if cancel.load(Ordering::Relaxed) { interrupt.interrupt(); break; }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });
        let stop=Stop(&done);
        let result=run_inner(conn,options,&control,force_retry,&mut report);
        drop(stop);
        result
    });
    if cancel.load(Ordering::Relaxed) { report.cancelled=true; return Ok(report); }
    result?;
    Ok(report)
}

fn repair_families(conn: &mut Connection, options: &RepairOptions, control: &Control<'_>, force_retry: bool,
    report: &mut RepairReport) -> Result<(),String> {
    let cancel=control.cancel;
    control.pulse("repair-discovery")?;
    accounting::migrate_r2(conn)?;
    // Early ext-v3 development copies may predate this repair-only lookup.
    conn.execute_batch("CREATE INDEX IF NOT EXISTS ix_turn_execution_v3 ON turn(kind,execution_key);")
        .map_err(|e|e.to_string())?;
    let mut retry_sources: HashSet<(String,String)> = accounting::codex_suffix_repair_sources(conn)?.into_iter()
        .chain(accounting::codex_orphan_repair_sources(conn)?)
        .map(|path|(KIND_CODEX.to_string(),path)).collect();
    retry_sources.extend(accounting::claude_message_key_repair_sources(conn)?);
    for (retry_kind,source) in &retry_sources {
        conn.execute("UPDATE usage_repair_group SET version=0 WHERE kind=?1 AND session_id IN (
            SELECT session_id FROM source_file WHERE kind=?1 AND path=?2
            UNION SELECT legacy_session_id FROM session_identity_alias WHERE kind=?1 AND source_path=?2)",
            params![retry_kind,source]).map_err(|e|e.to_string())?;
    }
    let mut groups: BTreeMap<(String, String), Vec<Source>> = BTreeMap::new();
    {
        // Keep a Codex native-to-physical alias ahead of the physical self-alias
        // added by staging. The self-alias can sort before a malformed old ID;
        // choosing it would change the successful family key on the next run.
        // Bound each lookup by physical path rather than scanning a whole kind.
        let mut stmt=conn.prepare("SELECT sf.kind,COALESCE((SELECT a.legacy_session_id
            FROM session_identity_alias a INDEXED BY ix_session_identity_alias_source
            WHERE a.kind=sf.kind AND a.source_path=sf.path
            ORDER BY (a.kind='codex' AND a.legacy_session_id=a.execution_session_id),a.legacy_session_id LIMIT 1),sf.session_id),
            sf.path,sf.parsed_bytes,sf.size_bytes,sf.session_id FROM source_file sf
            WHERE sf.kind IN ('claude','claude-codex','codex') AND sf.session_id IS NOT NULL
            ORDER BY sf.kind,sf.path").map_err(|e|e.to_string())?;
        for row in stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    Source {
                        path: r.get(2)?,
                        parsed_bytes: r.get(3)?,
                        size: r.get(4)?,
                        stored_session: r.get(5)?,
                        legacy_session: r.get(1)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?
        {
            let (kind, sid, source) = row.map_err(|e| e.to_string())?;
            groups.entry((kind, sid)).or_default().push(source);
        }
    }
    let groups = merge_source_families(groups);
    let prices = PriceTable::load(conn)?;
    for ((kind, sid), sources) in groups {
        if cancel.load(Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }
        report.groups_seen += 1;
        control.pulse("repair-families")?;
        let physical_claude_changed=kind!=KIND_CODEX && sources.iter().any(|s|
            expected_source_session(&kind,s)!=s.stored_session
                && resolve_source(Path::new(&s.path),&kind,options).is_some());
        let previous: Option<(String, i64, bool)> = if physical_claude_changed || sources.iter().any(|s|retry_sources.contains(&(kind.clone(),s.path.clone()))) {
            None
        } else { conn
            .query_row(
                "SELECT signature,version,complete FROM usage_repair_group
            WHERE kind=?1 AND session_id=?2",
                params![kind, sid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())? };
        let ids: HashSet<String> = sources
            .iter()
            .flat_map(|s| [s.stored_session.clone(),s.legacy_session.clone()])
            .collect();
        // Repaired complete families are handled by the normal incremental
        // indexer. Only unresolved legacy input needs an availability retry.
        let legacy = ids.iter().try_fold(0i64, |n, id| {
            conn.query_row(
                "SELECT COUNT(*) FROM turn
            WHERE kind=?1 AND session_id=?2 AND usage_state IN ('legacy','suspected_duplicate')",
                params![kind, id],
                |r| r.get::<_, i64>(0),
            )
            .map(|c| n + c)
            .map_err(|e| e.to_string())
        })?;
        if previous
            .as_ref()
            .is_some_and(|(_, version, complete)| *version == VERSION && *complete)
            && legacy == 0 && !force_retry
        {
            report.groups_unchanged += 1;
            continue;
        }
        let resolved: Vec<_> = sources
            .iter()
            .map(|s| resolve_source(Path::new(&s.path), &kind, options))
            .collect();
        let stamps: Vec<_> = resolved
            .iter()
            .map(|p| {
                p.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| {
                    (
                        m.len(),
                        m.modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_nanos().to_string()),
                    )
                })
            })
            .collect();
        // Session aliases and physical gzip size are repair outputs, not
        // input identity. Keeping them out avoids reparsing partial families
        // merely because their first repair updated source metadata.
        let input_prefixes: Vec<_> = sources
            .iter()
            .map(|source| (&source.path, source.parsed_bytes))
            .collect();
        let signature = if resolved.iter().all(Option::is_none) {
            accounting::key("repair",&(input_prefixes,&resolved,stamps,options.fallback_root.as_ref(),options.archive_root.as_ref(),VERSION))
        } else { accounting::key(
            "repair",
            &(
                input_prefixes,
                "native-source-proofs-v2",
                &resolved,
                stamps,
                options.fallback_root.as_ref(),options.archive_root.as_ref(),
                VERSION,
            ),
        ) };
        let cached_failure:Option<(String,i64,String)>=conn.query_row(
            "SELECT signature,version,error FROM usage_repair_failure WHERE kind=?1 AND session_id=?2",
            params![kind,sid],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
        if !force_retry && cached_failure.as_ref().is_some_and(|(old,version,_)| *version==VERSION && *old==signature) {
            report.cached_failed_groups+=1; report.groups_unchanged+=1;
            report.errors.push(format!("{kind}:{sid}: cached failure: {}",cached_failure.unwrap().2));
            continue;
        }
        if !force_retry && previous
            .as_ref()
            .is_some_and(|(old, version, _)| *version == VERSION && *old == signature)
        {
            report.groups_unchanged += 1;
            continue;
        }
        if resolved.iter().all(Option::is_none) {
            conn.execute("INSERT INTO usage_repair_group(kind,session_id,signature,version) VALUES (?1,?2,?3,?4)
                ON CONFLICT(kind,session_id) DO UPDATE SET signature=excluded.signature,version=excluded.version",
                params![kind,sid,signature,VERSION]).map_err(|e|e.to_string())?;
            continue;
        }
        let mut stage = Connection::open_in_memory().map_err(|e| e.to_string())?;
        super::schema::init(&stage)?;
        super::migrate::apply(&stage)?;
        let family_start_reads=report.files_read;
        control.total.set(control.total.get()+resolved.iter().filter(|p|p.is_some()).count());
        let mut successful = Vec::new();
        let mut failed = false;
        for (source, physical) in sources.iter().zip(&resolved) {
            let Some(physical) = physical else { continue };
            report.files_read+=1;
            control.files.set(report.files_read);
            control.pulse("repair-stage")?;
            match stage_source(&mut stage, kind_static(&kind), source, physical, control) {
                Ok(()) => {
                    successful.push(source);
                    control.check()?;
                }
                Err(error) => {
                    report.errors.push(format!("{kind}:{sid}: {error}"));
                    failed = true;
                    break;
                }
            }
        }
        if failed || cancel.load(Ordering::Relaxed) {
            if cancel.load(Ordering::Relaxed) {
                report.cancelled = true;
                break;
            }
            report.failed_family_files_read+=report.files_read-family_start_reads;
            conn.execute("INSERT INTO usage_repair_failure(kind,session_id,signature,version,error) VALUES (?1,?2,?3,?4,?5)
                ON CONFLICT(kind,session_id) DO UPDATE SET signature=excluded.signature,version=excluded.version,error=excluded.error",
                params![kind,sid,signature,VERSION,report.errors.last().cloned().unwrap_or_default()]).map_err(|e|e.to_string())?;
            continue;
        }
        let staged_turns: i64 = stage
            .query_row("SELECT COUNT(*) FROM turn", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if staged_turns == 0 {
            let observations: i64 = stage
                .query_row("SELECT COUNT(*) FROM usage_occurrence", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let mut old_rows = 0i64;
            let mut old_cost = 0f64;
            for id in &ids {
                let (rows,cost):(i64,f64)=conn.query_row("SELECT COUNT(*),COALESCE(SUM(cost_usd),0) FROM turn WHERE kind=?1 AND session_id=?2",
                    params![kind,id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
                old_rows += rows;
                old_cost += cost;
            }
            if old_rows > 0 && (observations == 0 || old_cost > 0.0) {
                report.errors.push(format!(
                    "{kind}:{sid}: source has no paid usage evidence; historical rows preserved"
                ));
                conn.execute("INSERT INTO usage_repair_failure(kind,session_id,signature,version,error) VALUES (?1,?2,?3,?4,?5)
                    ON CONFLICT(kind,session_id) DO UPDATE SET signature=excluded.signature,version=excluded.version,error=excluded.error",
                    params![kind,sid,signature,VERSION,report.errors.last().cloned().unwrap_or_default()]).map_err(|e|e.to_string())?;
                report.failed_family_files_read+=report.files_read-family_start_reads;
                continue;
            }
        }
        control.pulse("repair-swap")?;
        let complete = resolved.iter().all(Option::is_some);
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut touched = accounting::Touched::new();
        // Replace usage supported only by the inputs being staged. A global
        // execution witnessed by another family remains available for claim_turn
        // to select its best snapshot and stable owner. This also removes old
        // source-scoped UUID keys when a missing-request message is repaired.
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS stage1_repair_source_set(path TEXT PRIMARY KEY);
            DELETE FROM stage1_repair_source_set;").map_err(|e|e.to_string())?;
        for source in &successful {
            control.check()?;
            tx.execute("INSERT OR IGNORE INTO stage1_repair_source_set(path) VALUES (?1)",
                [&source.path]).map_err(|e|e.to_string())?;
        }
        let replaced: Vec<(String,i64)> = {
            // The execution-key range can otherwise beat the physical-path
            // predicate and scan the whole provider once for every input file.
            // Schema v3's primary key is (kind,path,generation,line).
            let mut stmt=tx.prepare("SELECT DISTINCT t.session_id,t.seq FROM stage1_repair_source_set p
                CROSS JOIN usage_occurrence e INDEXED BY sqlite_autoindex_usage_occurrence_1
                CROSS JOIN turn t INDEXED BY ix_turn_execution_v3
                WHERE e.kind=?1 AND e.source_path=p.path AND e.execution_key IS NOT NULL
                  AND t.kind=e.kind AND t.execution_key=e.execution_key AND t.usage_state!='legacy'
                  AND NOT EXISTS (SELECT 1 FROM usage_occurrence other INDEXED BY ix_usage_occurrence_execution
                    WHERE other.kind=e.kind AND other.execution_key=e.execution_key
                      AND NOT EXISTS (SELECT 1 FROM stage1_repair_source_set selected WHERE selected.path=other.source_path))")
                .map_err(|e|e.to_string())?;
            let rows=stmt.query_map([&kind],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
            rows.collect::<Result<_,_>>().map_err(|e|e.to_string())?
        };
        let replaced_sessions: HashSet<_> = replaced.iter().map(|(id,_)|id).collect();
        for id in replaced_sessions {
            rollup::mark_session_dirty(&tx,&kind,id)?;
            touched.insert((kind.clone(),id.clone()));
        }
        for (id,seq) in replaced {
            control.pulse("repair-swap-delete")?;
            tx.execute("DELETE FROM turn WHERE kind=?1 AND session_id=?2 AND seq=?3",
                params![kind,id,seq]).map_err(|e|e.to_string())?;
        }
        for id in &ids {
            rollup::mark_session_dirty(&tx, &kind, id)?;
            touched.insert((kind.clone(), id.clone()));
            if complete {
                for table in ["tool_event", "file_touch", "rework"] {
                    tx.execute(
                        &format!("DELETE FROM {table} WHERE kind=?1 AND session_id=?2"),
                        params![kind, id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                tx.execute(
                    "UPDATE session SET user_msg_count=0,compact_count=0,active_ms=0,
                    prompt_chars=0,write_chars=0 WHERE kind=?1 AND session_id=?2",
                    params![kind, id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        for (id,request,physical,path) in legacy_usage_proofs(&stage,&successful)? {
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM turn WHERE kind=?1 AND session_id=?2 AND request_id=?3 AND usage_state IN ('legacy','suspected_duplicate'))",
                params![kind,id,request],|r|r.get(0)).map_err(|e|e.to_string())?;
            if exists {
                if !touched.contains(&(kind.clone(),id.clone())) {
                    rollup::mark_session_dirty(&tx,&kind,&id)?;
                    touched.insert((kind.clone(),id.clone()));
                }
                tx.execute("DELETE FROM turn WHERE kind=?1 AND session_id=?2 AND request_id=?3 AND usage_state IN ('legacy','suspected_duplicate')",
                    params![kind,id,request]).map_err(|e|e.to_string())?;
                tx.execute("INSERT OR IGNORE INTO session_identity_alias(kind,legacy_session_id,execution_session_id,source_path)
                    VALUES (?1,?2,?3,?4)",params![kind,id,physical,path]).map_err(|e|e.to_string())?;
            }
        }
        for source in &successful {
            control.check()?;
            tx.execute(
                "DELETE FROM usage_occurrence WHERE kind=?1 AND source_path=?2",
                params![kind, source.path],
            )
            .map_err(|e| e.to_string())?;
        }
        copy_table(&stage, &tx, "session", true, control)?;
        let staged_ids: Vec<String> = {
            let mut stmt = stage
                .prepare("SELECT session_id FROM session ORDER BY session_id")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        for id in &staged_ids {
            control.check()?;
            let mut chunk = SessionChunk::new(kind_static(&kind), id.clone());
            chunk.is_sidechain = stage
                .query_row(
                    "SELECT is_sidechain FROM session WHERE kind=?1 AND session_id=?2",
                    params![kind, id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            chunk.turns = read_turns(&stage, &kind, id)?;
            index::apply_chunk(&tx, &chunk, &mut touched)?;
            touched.insert((kind.clone(), id.clone()));
        }
        for table in [
            "tool_event",
            "file_touch",
            "usage_occurrence",
            "usage_checkpoint",
            "source_file",
        ] {
            copy_table(&stage, &tx, table, false, control)?;
        }
        {
            let mut stmt = stage
                .prepare("SELECT key,value FROM index_state WHERE key LIKE 'codex_ps:%'")
                .map_err(|e| e.to_string())?;
            for row in stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?
            {
                let (key, value) = row.map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT INTO index_state(key,value) VALUES (?1,?2)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![key, value],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        let mut stmt = stage
            .prepare("SELECT path,session_id FROM source_file WHERE session_id IS NOT NULL")
            .map_err(|e| e.to_string())?;
        for row in stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
        {
            let (path, new_id) = row.map_err(|e| e.to_string())?;
            let legacy = &sources.iter().find(|s|s.path==path).ok_or("staged source missing from family")?.legacy_session;
            tx.execute("INSERT OR IGNORE INTO session_identity_alias(kind,legacy_session_id,execution_session_id,source_path)
                VALUES (?1,?2,?3,?4)",params![kind,legacy,new_id,path]).map_err(|e|e.to_string())?;
        }
        drop(stmt);
        for (kind, id) in &touched {
            control.check()?;
            index::recompute_session(&tx, kind, id, &prices)?;
            rollup::mark_session_dirty(&tx, kind, id)?;
        }
        tx.execute("INSERT INTO usage_repair_group(kind,session_id,signature,version,complete) VALUES (?1,?2,?3,?4,?5)
            ON CONFLICT(kind,session_id) DO UPDATE SET signature=excluded.signature,version=excluded.version,complete=excluded.complete",
            params![kind,sid,signature,VERSION,complete]).map_err(|e|e.to_string())?;
        tx.execute("DELETE FROM usage_repair_failure WHERE kind=?1 AND session_id=?2",params![kind,sid]).map_err(|e|e.to_string())?;
        control.pulse("repair-swap-commit")?;
        tx.commit().map_err(|e| e.to_string())?;
        report.groups_repaired += 1;
        if kind != KIND_CODEX && staged_ids.len() > 1 {
            report.sessions_resplit += 1;
        }
        if report.groups_repaired % 50 == 0 {
            eprintln!(
                "usage repair: {} families, {} sources",
                report.groups_repaired, report.files_read
            );
        }
    }
    Ok(())
}

fn run_inner(conn: &mut Connection, options: &RepairOptions, control: &Control<'_>, force_retry: bool,
    report: &mut RepairReport) -> Result<(),String> {
    repair_families(conn,options,control,force_retry,report)?;
    let prices=PriceTable::load(conn)?;
    let mut retried=BTreeSet::new();
    while !report.cancelled {
        control.check()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut touched = accounting::Touched::new();
        accounting::reconcile_codex_copies(&tx, &mut touched)?;
        // A later family swap or transitive copy reconciliation can invalidate
        // a source installed earlier in this invocation. Finish that recovery
        // here, before publishing completed rollups, rather than on next run.
        let retry:BTreeSet<String>=accounting::codex_suffix_repair_sources(&tx)?.into_iter()
            .chain(accounting::codex_orphan_repair_sources(&tx)?).collect();
        if !retry.is_empty() {
            if retried.len()>=16 || !retried.insert(retry) {
                return Err("Codex source consistency repair did not converge".into());
            }
            for (kind,id) in &touched {
                control.check()?;
                index::recompute_session(&tx,kind,id,&prices)?;
                rollup::mark_session_dirty(&tx,kind,id)?;
            }
            tx.commit().map_err(|e|e.to_string())?;
            report.consistency_retries+=1;
            control.pulse("repair-consistency-retry")?;
            repair_families(conn,options,control,false,report)?;
            continue;
        }
        accounting::reconcile_claude_legacy_copies(&tx, &mut touched)?;
        let checkpoint=|phase: &str|control.pulse(phase);
        report.proven_legacy_copies=super::legacy::reconcile_proven(&tx,&mut touched,&checkpoint)?;
        report.suspected_legacy_copies=super::legacy::classify_suspected(&tx,options,&mut touched,&checkpoint)?;
        for (kind, id) in &touched {
            control.check()?;
            index::recompute_session(&tx, kind, id, &prices)?;
            rollup::mark_session_dirty(&tx, kind, id)?;
        }
        if !rollup::version_matches(&tx)? {
            rollup::mark_all_dirty(&tx)?;
        }
        control.pulse("repair-rollup")?;
        rollup::rebuild_dirty_cancellable(&tx,&|phase|control.pulse(phase))?;
        tx.execute(
            "INSERT INTO index_state(key,value) VALUES ('usage_lineage_backfill_version',?1)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [VERSION.to_string()],
        )
        .map_err(|e| e.to_string())?;
        control.pulse("repair-final-commit")?;
        tx.commit().map_err(|e| e.to_string())?;
        break;
    }
    report.sessions_still_legacy=conn.query_row("SELECT COUNT(*) FROM session s WHERE EXISTS
        (SELECT 1 FROM turn t WHERE t.kind=s.kind AND t.session_id=s.session_id AND t.usage_state IN ('legacy','suspected_duplicate'))",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    Ok(())
}

fn read_turns(conn: &Connection, kind: &str, sid: &str) -> Result<Vec<TurnRow>, String> {
    let mut stmt=conn.prepare("SELECT request_id,execution_key,usage_state,ts,model,effort,service_tier,
        input_tokens,output_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,
        reasoning_tokens,duration_ms,tool_calls,tool_errors FROM turn WHERE kind=?1 AND session_id=?2 ORDER BY seq").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(params![kind, sid], |r| {
            Ok(TurnRow {
                dedup_key: r.get(0)?,
                execution_key: r.get(1)?,
                usage_state: r.get(2)?,
                ts: r.get(3)?,
                model: r.get(4)?,
                effort: r.get(5)?,
                service_tier: r.get(6)?,
                input_tokens: r.get(7)?,
                output_tokens: r.get(8)?,
                cache_read_tokens: r.get(9)?,
                cache_write_5m_tokens: r.get(10)?,
                cache_write_1h_tokens: r.get(11)?,
                reasoning_tokens: r.get(12)?,
                duration_ms: r.get(13)?,
                tool_calls: r.get(14)?,
                tool_errors: r.get(15)?,
                reported_cost_usd: None,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn copy_table(
    source: &Connection,
    target: &Connection,
    table: &str,
    preserve_metadata: bool,
    control: &Control<'_>,
) -> Result<(), String> {
    let columns: Vec<String> = {
        let mut stmt = source
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get(1))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let names = columns.join(",");
    let updates = columns
        .iter()
        .map(|c| {
            if preserve_metadata
                && [
                    "goal_key",
                    "goal_cluster",
                    "goal_summary",
                    "ai_title",
                    "first_prompt",
                ]
                .contains(&c.as_str())
            {
                format!("{c}=COALESCE({table}.{c},excluded.{c})")
            } else {
                format!("{c}=excluded.{c}")
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "INSERT INTO {table} ({names}) VALUES ({}) ON CONFLICT DO UPDATE SET {updates}",
        vec!["?"; columns.len()].join(",")
    );
    let mut insert = target.prepare_cached(&sql).map_err(|e| e.to_string())?;
    let mut stmt = source
        .prepare(&format!("SELECT {names} FROM {table}"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            (0..columns.len())
                .map(|i| r.get::<_, SqlValue>(i))
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        insert
            .execute(rusqlite::params_from_iter(row.map_err(|e| e.to_string())?))
            .map_err(|e| format!("copy {table}: {e}"))?;
        control.pulse("repair-swap-row")?;
    }
    Ok(())
}

fn stage_source(
    stage: &mut Connection,
    kind: &'static str,
    source: &Source,
    physical: &Path,
    control: &Control<'_>,
) -> Result<(), String> {
    let cancel=control.cancel;
    let metadata = std::fs::metadata(physical).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(physical).map_err(|e| e.to_string())?;
    let gzip = physical.extension().and_then(|v| v.to_str()) == Some("gz");
    let logical_archive =
        Path::new(&source.path).extension().and_then(|v| v.to_str()) == Some("gz");
    let limit = if logical_archive {
        u64::MAX
    } else {
        source.parsed_bytes.max(0) as u64
    };
    let reader: Box<dyn Read> = if gzip {
        Box::new(flate2::read::GzDecoder::new(file).take(limit))
    } else {
        Box::new(file.take(limit))
    };
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();
    let mut line = Vec::new();
    let mut offset = 0u64;
    let mut bytes = 0u64;
    let mut content_fp = index::fingerprint(&[]);
    let stem = Path::new(&source.path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .trim_end_matches(".gz")
        .trim_end_matches(".jsonl");
    let fallback = if kind == KIND_CODEX {
        parse_codex::session_id_from_filename(stem)
    } else {
        stem
    };
    let mut seed = parse_codex::CodexParseState::default();
    if kind == KIND_CODEX && parse_codex::is_rollout_uuid(fallback) {
        seed.session_id = Some(fallback.to_string());
        seed.session_locked = true;
        seed.session_behavior = parse_codex::SessionBehavior::CanonicalFilename;
    }
    let mut touched = accounting::Touched::new();
    let tx = stage.transaction().map_err(|e| e.to_string())?;
    let mut source_session = None;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled before family swap".into());
        }
        line.clear();
        let count = reader
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        let complete = count > 0 && line.ends_with(b"\n");
        if complete {
            bytes += count as u64;
            buffer.extend_from_slice(&line);
        }
        if buffer.len() >= BATCH_BYTES || !complete {
            if !buffer.is_empty() {
                let text =
                    std::str::from_utf8(&buffer).map_err(|_| "invalid UTF-8; family preserved")?;
                let mut data = if kind == KIND_CODEX {
                    let (data, usage) =
                        parse_codex::parse_chunk_with_end_state(text, fallback, seed.clone());
                    let meta = parse_codex::parse_state_from_text(text);
                    if meta.model.is_some() {
                        seed.model = meta.model;
                    }
                    if meta.effort.is_some() {
                        seed.effort = meta.effort;
                    }
                    if !seed.session_locked && meta.session_id.is_some() {
                        seed.session_id = meta.session_id;
                    }
                    seed.usage = usage;
                    data
                } else {
                    parse_claude::parse_chunk_from_source(text, fallback, Path::new(&source.path))
                };
                if data.parse_errors > 0 {
                    return Err("invalid JSON; family preserved".into());
                }
                for chunk in data.sessions.values_mut() {
                    chunk.kind = kind;
                    source_session.get_or_insert_with(|| chunk.session_id.clone());
                    index::apply_chunk(&tx, chunk, &mut touched)?;
                    accounting::record_occurrences(&tx, chunk, &source.path, "usage-v1", offset)?;
                }
                offset += text.lines().count() as u64;
                content_fp = index::extend_fingerprint(&content_fp, &buffer)
                    .ok_or("invalid rolling fingerprint")?;
                buffer.clear();
                control.pulse("repair-stage-batch")?;
            }
        }
        if !complete {
            break;
        }
    }
    if !logical_archive && bytes < source.parsed_bytes.max(0) as u64 {
        return Err("source is shorter than indexed prefix; family preserved".into());
    }
    let cursor = if logical_archive {
        metadata.len()
    } else {
        bytes
    };
    let logical_size = if gzip && !logical_archive {
        bytes
    } else {
        metadata.len()
    };
    tx.execute("INSERT INTO source_file(path,kind,size_bytes,mtime_ns,parsed_bytes,parsed_lines,session_id,last_indexed)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",params![source.path,kind,logical_size as i64,
            metadata.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_nanos() as i64).unwrap_or(0),
            cursor as i64,offset as i64,source_session,
            chrono::Utc::now().timestamp_millis()]).map_err(|e|e.to_string())?;
    if kind == KIND_CODEX {
        index::persist_codex_state(&tx, &source.path, cursor, &seed, Some(&content_fp))?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn recover_usage_prefix(
    path: &Path,
    bytes: u64,
    seed: &parse_codex::CodexParseState,
) -> Result<accounting::CodexUsageState, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file.take(bytes));
    let mut state = seed.clone();
    state.usage = Default::default();
    let mut line = String::new();
    let mut batch = String::new();
    loop {
        line.clear();
        let count = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        batch.push_str(&line);
        if batch.len() >= BATCH_BYTES || count == 0 {
            let (_, usage) = parse_codex::parse_chunk_with_end_state(
                &batch,
                state.session_id.as_deref().unwrap_or(""),
                state.clone(),
            );
            state.usage = usage;
            batch.clear();
        }
        if count == 0 {
            break;
        }
    }
    Ok(state.usage)
}

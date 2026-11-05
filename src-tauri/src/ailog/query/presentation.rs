use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLineage {
    pub parent_kind: Option<String>,
    pub parent_session_id: Option<String>,
    pub relationship_type: String,
    pub state: String,
}

impl Default for SessionLineage {
    fn default() -> Self {
        Self {
            parent_kind: None,
            parent_session_id: None,
            relationship_type: "unknown".into(),
            state: "legacy".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPresentation {
    pub depth: usize,
    pub children_count: usize,
    pub own_cost_usd: f64,
    pub group_cost_usd: f64,
    pub group_turns: i64,
    pub context_only: bool,
    pub parent_missing: bool,
    pub cycle: bool,
}

struct Node {
    lineage: SessionLineage,
    internal: bool,
    score: f64,
}

fn nodes(conn: &Connection) -> Result<BTreeMap<SessionKey, Node>, String> {
    let mut statement = conn.prepare("SELECT s.kind,s.session_id,s.parent_kind,s.parent_session_id,
        s.relationship_type,s.lineage_state,COALESCE(s.origin,'unknown')='ailog-internal',COALESCE(r.score,0)
        FROM session s LEFT JOIN rework r USING(kind,session_id)")
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(((row.get(0)?,row.get(1)?),Node {
        lineage: SessionLineage { parent_kind: row.get(2)?,parent_session_id: row.get(3)?,
            relationship_type: row.get(4)?,state: row.get(5)? },
        internal: row.get(6)?,score: row.get(7)?,
    }))).map_err(|error| error.to_string())?;
    rows.collect::<Result<_,_>>().map_err(|error| error.to_string())
}

fn scoped_nodes(conn: &Connection, requested: &[SessionKey]) -> Result<BTreeMap<SessionKey, Node>, String> {
    // Large periods are cheaper as one scan. A day filter should not scan the
    // entire index merely to find a handful of selected sessions' ancestors.
    if requested.len() >= 1000 { return nodes(conn); }
    let mut output = BTreeMap::new();
    for chunk in requested.chunks(200) {
        let placeholders = vec!["(?, ?)"; chunk.len()].join(",");
        let sql = format!(
            "WITH RECURSIVE requested(kind,session_id) AS (VALUES {placeholders}), \
             family(kind,session_id) AS ( \
               SELECT kind,session_id FROM requested UNION \
               SELECT s.parent_kind,s.parent_session_id FROM family f \
               JOIN session s USING(kind,session_id) \
               WHERE s.lineage_state='verified' AND s.parent_kind IS NOT NULL AND s.parent_session_id IS NOT NULL \
             ) SELECT s.kind,s.session_id,s.parent_kind,s.parent_session_id,s.relationship_type,s.lineage_state, \
               COALESCE(s.origin,'unknown')='ailog-internal',COALESCE(r.score,0) \
               FROM family f JOIN session s USING(kind,session_id) LEFT JOIN rework r USING(kind,session_id)"
        );
        let params: Vec<_> = chunk.iter().flat_map(|key| [SqlValue::Text(key.0.clone()),SqlValue::Text(key.1.clone())]).collect();
        let mut statement = conn.prepare(&sql).map_err(|e|e.to_string())?;
        let rows = statement.query_map(params_from_iter(params.iter()), |row| Ok(((row.get(0)?,row.get(1)?),Node {
            lineage: SessionLineage { parent_kind:row.get(2)?,parent_session_id:row.get(3)?,relationship_type:row.get(4)?,state:row.get(5)? },
            internal:row.get(6)?,score:row.get(7)?,
        }))).map_err(|e|e.to_string())?;
        for row in rows { let (key,node) = row.map_err(|e|e.to_string())?; output.insert(key,node); }
    }
    Ok(output)
}

pub(super) fn lineage(conn: &Connection, kind: &str, session_id: &str) -> Result<SessionLineage,String> {
    conn.query_row("SELECT parent_kind,parent_session_id,relationship_type,lineage_state
        FROM session WHERE kind=?1 AND session_id=?2",rusqlite::params![kind,session_id],|row| {
        Ok(SessionLineage { parent_kind:row.get(0)?,parent_session_id:row.get(1)?,
            relationship_type:row.get(2)?,state:row.get(3)? })
    }).map_err(|error|error.to_string())
}

fn parent(key: &SessionKey, nodes: &BTreeMap<SessionKey,Node>) -> Option<SessionKey> {
    let node = nodes.get(key)?;
    if node.lineage.state != "verified" { return None; }
    Some((node.lineage.parent_kind.clone()?,node.lineage.parent_session_id.clone()?))
}

fn path_to_root(key: &SessionKey, nodes: &BTreeMap<SessionKey,Node>, eligible: &BTreeMap<SessionKey,SessionSortAcc>)
    -> (Vec<SessionKey>,bool,bool) {
    let mut path = Vec::new();
    let mut positions = HashMap::new();
    let mut current = key.clone();
    loop {
        if let Some(&position) = positions.get(&current) {
            let root = path[position..].iter().min().cloned().unwrap();
            let stop = path.iter().position(|item| item == &root).unwrap();
            path.truncate(stop + 1);
            path.reverse();
            return (path,false,true);
        }
        positions.insert(current.clone(),path.len());
        path.push(current.clone());
        let Some(next) = parent(&current,nodes) else {
            path.reverse();
            return (path,false,false);
        };
        if !nodes.contains_key(&next) || (nodes[&next].internal && !eligible.contains_key(&next)) {
            path.reverse();
            return (path,true,false);
        }
        current = next;
    }
}

struct PreparedSessions {
    eligible: BTreeMap<SessionKey, SessionSortAcc>,
    models: BTreeMap<SessionKey, BTreeMap<String, i64>>,
    nodes: BTreeMap<SessionKey, Node>,
    paths: BTreeMap<SessionKey, (Vec<SessionKey>, bool, bool)>,
    groups: BTreeMap<SessionKey, Vec<SessionKey>>,
    scores: BTreeMap<SessionKey, (f64, i64, i64, f64)>,
}

fn prepare_sessions(conn: &Connection, source_rows: &[AggregateRow]) -> Result<(PreparedSessions, SessionPreparationTimings), String> {
    let aggregate_started = Instant::now();
    let mut eligible: BTreeMap<SessionKey,SessionSortAcc> = BTreeMap::new();
    let mut models: BTreeMap<SessionKey,BTreeMap<String,i64>> = BTreeMap::new();
    for row in source_rows {
        super::super::report_runtime::checkpoint()?;
        let key = (row.kind.clone(),row.session_id.clone());
        let entry = eligible.entry(key.clone()).or_default();
        entry.cost += row.cost;
        entry.turns += row.turns;
        entry.recent = entry.recent.max(row.last_ts);
        *models.entry(key).or_default().entry(range_model_key(row.model.as_deref())).or_default() += row.input + row.output;
    }

    let aggregate_us = aggregate_started.elapsed().as_micros().try_into().unwrap_or(u64::MAX);
    let node_started = Instant::now();
    let requested_keys: Vec<_> = eligible.keys().cloned().collect();
    let nodes = scoped_nodes(conn, &requested_keys)?;
    let node_sql_us = node_started.elapsed().as_micros().try_into().unwrap_or(u64::MAX);
    let path_started = Instant::now();

    let paths: BTreeMap<_,_> = eligible.keys().map(|key| (key.clone(),path_to_root(key,&nodes,&eligible))).collect();
    let mut groups: BTreeMap<SessionKey,Vec<SessionKey>> = BTreeMap::new();
    for (key,(path,_,_)) in &paths {
        groups.entry(path[0].clone()).or_default().push(key.clone());
    }

    let scores: BTreeMap<SessionKey, (f64, i64, i64, f64)> = groups.iter().map(|(key,members)| {
        let cost = members.iter().map(|member|eligible[member].cost).sum::<f64>();
        let turns = members.iter().map(|member|eligible[member].turns).sum::<i64>();
        let recent = members.iter().map(|member|eligible[member].recent).max().unwrap_or(0);
        let rework = members.iter().filter_map(|member|nodes.get(member)).map(|node|node.score).fold(0.0,f64::max);
        (key.clone(),(cost,turns,recent,rework))
    }).collect();
    let path_us = path_started.elapsed().as_micros().try_into().unwrap_or(u64::MAX);
    Ok((PreparedSessions { eligible, models, nodes, paths, groups, scores },
        SessionPreparationTimings { aggregate_us, node_sql_us, path_us }))
}

#[cfg(test)]
pub(super) fn session_page(conn: &Connection, source_rows: &[AggregateRow], expanded: bool, options: &SessionsOptions)
    -> Result<(Vec<SessionRow>, i64, u64), String> {
    let (prepared, preparation) = prepare_sessions(conn, source_rows)?;
    page_from_prepared(conn, &prepared, expanded, options, Some(preparation))
}

fn page_from_prepared(conn: &Connection, prepared: &PreparedSessions, expanded: bool, options: &SessionsOptions, preparation: Option<SessionPreparationTimings>)
    -> Result<(Vec<SessionRow>, i64, u64), String> {
    let PreparedSessions { eligible, models, nodes, paths, groups, scores } = prepared;
    let total = groups.len() as i64;
    let preparation_reused = preparation.is_none();
    let phase = preparation.unwrap_or_default();
    let aggregate_ms = phase.aggregate_us as f64 / 1000.0;
    let node_sql_ms = phase.node_sql_us as f64 / 1000.0;
    let path_ms = phase.path_us as f64 / 1000.0;
    let rank_started = Instant::now();
    let mut ranking: Vec<_> = scores.iter().map(|(key,score)| (key.clone(),*score)).collect();
    ranking.sort_by(|(left,first),(right,second)| {
        let order = match options.sort.as_str() {
            "turns" => second.1.cmp(&first.1),
            "recent" => second.2.cmp(&first.2),
            "rework" => second.3.total_cmp(&first.3),
            _ => second.0.total_cmp(&first.0),
        };
        order.then_with(||left.cmp(right))
    });
    let selected: Vec<_> = ranking.into_iter().map(|(key,_)|key)
        .skip(options.offset.max(0) as usize).take(options.limit.max(0) as usize).collect();
    let rank_ms = elapsed_ms(rank_started);
    let model_started = Instant::now();
    let group_models: BTreeMap<_,_> = selected.iter().map(|root| {
        let members = &groups[root];
        let mut combined = BTreeMap::new();
        for member in members {
            for (model,tokens) in models.get(member).into_iter().flatten() {
                *combined.entry(model.clone()).or_default() += tokens;
            }
        }
        (root.clone(),combined)
    }).collect();
    let model_ms = elapsed_ms(model_started);
    let assembly_started = Instant::now();
    let mut requested = Vec::new();
    let mut presentation = BTreeMap::new();
    for root in selected {
        let members = &groups[&root];
        let mut children: BTreeMap<SessionKey,BTreeSet<SessionKey>> = BTreeMap::new();
        let mut group_nodes = BTreeSet::new();
        let mut missing = false;
        let mut cycle = false;
        for member in members {
            let (path,orphan,cyclic) = &paths[member];
            missing |= orphan;
            cycle |= cyclic;
            group_nodes.extend(path.iter().cloned());
            for edge in path.windows(2) {
                children.entry(edge[0].clone()).or_default().insert(edge[1].clone());
            }
        }
        let mut stack = vec![(root.clone(),0)];
        let mut visited = BTreeSet::new();
        while let Some((key,depth)) = stack.pop() {
            if !visited.insert(key.clone()) { continue; }
            let own = eligible.get(&key);
            let group = scores[&root];
            presentation.insert(key.clone(),SessionPresentation {
                depth,children_count:if depth==0 {group_nodes.len().saturating_sub(1)} else {children.get(&key).map_or(0,BTreeSet::len)},
                own_cost_usd:own.map_or(0.0,|value|value.cost),
                group_cost_usd:if depth==0 {group.0} else {own.map_or(0.0,|value|value.cost)},
                group_turns:if depth==0 {group.1} else {own.map_or(0,|value|value.turns)},
                context_only:own.is_none(),parent_missing:missing,cycle,
            });
            requested.push(key.clone());
            if expanded {
                if let Some(next) = children.get(&key) {
                    stack.extend(next.iter().rev().map(|child|(child.clone(),depth+1)));
                }
            }
        }
    }
    let assembly_ms = elapsed_ms(assembly_started);
    let hydrate_started = Instant::now();
    let mut hydrated = BTreeMap::new();
    for chunk in requested.chunks(200) {
        let placeholders = vec!["(?, ?)";chunk.len()].join(",");
        let sql = format!("WITH requested(kind,session_id) AS (VALUES {placeholders})
            SELECT s.kind,s.session_id,s.ai_title,s.first_prompt,s.project_label,s.git_branch,s.origin,
                s.primary_model,s.model_count,s.is_sidechain,s.work_tags,s.started_at,s.ended_at,s.wall_ms,
                s.active_ms,s.turn_count,s.user_msg_count,s.compact_count,s.cost_usd,s.goal_summary,s.goal_cluster,
                COALESCE(r.score,0) FROM requested q JOIN session s USING(kind,session_id)
                LEFT JOIN rework r USING(kind,session_id)");
        let params = chunk.iter().flat_map(|key|[SqlValue::Text(key.0.clone()),SqlValue::Text(key.1.clone())]).collect::<Vec<_>>();
        let mut statement = conn.prepare(&sql).map_err(|error|error.to_string())?;
        let rows = statement.query_map(params_from_iter(params.iter()),|row| {
            let key: SessionKey = (row.get(0)?,row.get(1)?);
            Ok((key.clone(),SessionRow {
                kind:key.0.clone(),session_id:key.1.clone(),title:display_title(row.get(2)?,row.get(19)?,row.get(3)?),
                project_label:row.get(4)?,git_branch:row.get(5)?,origin:row.get(6)?,primary_model:row.get(7)?,model_count:row.get(8)?,
                range_models:Vec::new(),range_model_count:0,is_sidechain:row.get::<_,i64>(9)?!=0,
                lineage:nodes[&key].lineage.clone(),presentation:presentation.remove(&key),
                work_tags:parse_json_array(row.get::<_,Option<String>>(10)?.as_deref()),started_at:row.get(11)?,ended_at:row.get(12)?,
                wall_ms:row.get(13)?,active_ms:row.get(14)?,turn_count:row.get(15)?,user_msg_count:row.get(16)?,
                compact_count:row.get(17)?,cost_usd:row.get(18)?,goal_summary:row.get(19)?,goal_cluster:row.get(20)?,rework_score:row.get(21)?,
            }))
        }).map_err(|error|error.to_string())?;
        for row in rows {
            let (key,mut value) = row.map_err(|error|error.to_string())?;
            apply_range_models(&mut value,group_models.get(&key).or_else(||models.get(&key)));
            hydrated.insert(key,value);
        }
    }
    let hydrate_ms = elapsed_ms(hydrate_started);
    let phases = format!("preparation_reused={preparation_reused} aggregate_ms={aggregate_ms} node_sql_ms={node_sql_ms} path_ms={path_ms} rank_ms={rank_ms} model_ms={model_ms} assembly_ms={assembly_ms} hydrate_ms={hydrate_ms}");
    crate::diag::log(&format!("[ailog] sessions_build {phases}"));
    #[cfg(test)]
    if std::env::var_os("AILOG_PERF_DB").is_some() { println!("AILOG_G1_3_SESSION_BUILD={phases}"); }
    Ok((requested.into_iter().filter_map(|key|hydrated.remove(&key)).collect(),total,phase.node_sql_us / 1000 + hydrate_ms))
}


const SESSION_INDEX_MAX_BYTES: usize = 32 * 1024 * 1024;
type CachedSessionIndex = (String, String, usize, Arc<PreparedSessions>);

fn session_indices() -> &'static Mutex<Vec<CachedSessionIndex>> {
    static CACHE: OnceLock<Mutex<Vec<CachedSessionIndex>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn store_session_index(cache: &mut Vec<CachedSessionIndex>, entry: CachedSessionIndex) {
    cache.retain(|previous| previous.0 != entry.0);
    // Four periods is the hard cap. Keep one oversized current index so that
    // sorting a long period still reuses its aggregates; evict all other periods.
    while !cache.is_empty() && (cache.len() >= 4 || cache.iter().map(|previous| previous.2).sum::<usize>() + entry.2 > SESSION_INDEX_MAX_BYTES) {
        cache.remove(0);
    }
    cache.push(entry);
}

pub(super) fn cached_session_page(conn: &Connection, resolved: &ResolvedRange, filters: &Filters,
    options: &SessionsOptions, timings: &mut ReportTimings) -> Result<(Vec<SessionRow>, i64, u64), String> {
    let _snapshot = if conn.is_autocommit() { Some(conn.unchecked_transaction().map_err(|error| error.to_string())?) } else { None };
    let revision = conn.path().filter(|path| !path.is_empty()).and_then(|_| super::super::report_cache::fingerprint(conn));
    let key = format!("{}:{}:{}:{}", conn.path().unwrap_or_default(), resolved.from, resolved.to,
        serde_json::to_string(filters).map_err(|error| error.to_string())?);
    let cached = revision.as_ref().and_then(|revision| {
        let mut cache = session_indices().lock().unwrap_or_else(|error| error.into_inner());
        let index = cache.iter().position(|entry| entry.0 == key && &entry.1 == revision)?;
        let entry = cache.remove(index);
        let prepared = Arc::clone(&entry.3);
        cache.push(entry);
        Some(prepared)
    });
    let prepared = match cached {
        Some(prepared) => prepared,
        None => {
            let rows = match measured_hybrid_rows(conn, resolved, filters, timings, false, false)? {
                Some(rows) => rows,
                None => measured_raw_aggregate_span(conn, resolved.from, resolved.to, filters, timings)?,
            };
            let (prepared, preparation) = prepare_sessions(conn, &rows)?;
            timings.session_prepare = Some(preparation);
            let prepared = Arc::new(prepared);
            let bytes = prepared.nodes.len() * 256
                + prepared.paths.values().map(|(path, _, _)| path.iter().map(|key| key.0.len() + key.1.len() + std::mem::size_of::<SessionKey>()).sum::<usize>()).sum::<usize>()
                + prepared.models.values().map(|models| models.keys().map(|key| key.len() + 64).sum::<usize>()).sum::<usize>()
                + prepared.eligible.len() * 512;
            if let Some(revision) = revision {
                let mut cache = session_indices().lock().unwrap_or_else(|error| error.into_inner());
                store_session_index(&mut cache, (key, revision, bytes, Arc::clone(&prepared)));
            }
            prepared
        }
    };
    page_from_prepared(conn, &prepared, filters.include_sidechain, options, timings.session_prepare)
}


#[cfg(test)]
pub(super) fn session_page_reference(conn: &Connection, source_rows: &[AggregateRow], expanded: bool, options: &SessionsOptions)
    -> Result<(Vec<SessionRow>,i64),String> {
    let started = Instant::now();
    let mut eligible: BTreeMap<SessionKey,SessionSortAcc> = BTreeMap::new();
    let mut models: BTreeMap<SessionKey,BTreeMap<String,i64>> = BTreeMap::new();
    for row in source_rows {
        let key = (row.kind.clone(),row.session_id.clone());
        let entry = eligible.entry(key.clone()).or_default();
        entry.cost += row.cost;
        entry.turns += row.turns;
        entry.recent = entry.recent.max(row.last_ts);
        *models.entry(key).or_default().entry(range_model_key(row.model.as_deref())).or_default() += row.input + row.output;
    }
    let aggregate_ms = elapsed_ms(started);
    let node_started = Instant::now();
    let requested_keys: Vec<_> = eligible.keys().cloned().collect();
    let nodes = scoped_nodes(conn, &requested_keys)?;
    let node_sql_ms = elapsed_ms(node_started);
    let path_started = Instant::now();
    let paths: BTreeMap<_,_> = eligible.keys().map(|key| (key.clone(),path_to_root(key,&nodes,&eligible))).collect();
    let mut groups: BTreeMap<SessionKey,Vec<SessionKey>> = BTreeMap::new();
    for (key,(path,_,_)) in &paths {
        groups.entry(path[0].clone()).or_default().push(key.clone());
    }
    let total = groups.len() as i64;
    let group_models: BTreeMap<_,_> = groups.iter().map(|(root,members)| {
        let mut combined = BTreeMap::new();
        for member in members {
            for (model,tokens) in models.get(member).into_iter().flatten() {
                *combined.entry(model.clone()).or_default() += tokens;
            }
        }
        (root.clone(),combined)
    }).collect();
    let path_ms = elapsed_ms(path_started);
    let rank_started = Instant::now();
    let mut ranking: Vec<_> = groups.keys().cloned().collect();
    let scores: BTreeMap<_,_> = groups.iter().map(|(key,members)| {
        let cost = members.iter().map(|member|eligible[member].cost).sum::<f64>();
        let turns = members.iter().map(|member|eligible[member].turns).sum::<i64>();
        let recent = members.iter().map(|member|eligible[member].recent).max().unwrap_or(0);
        let rework = members.iter().filter_map(|member|nodes.get(member)).map(|node|node.score).fold(0.0,f64::max);
        (key.clone(),(cost,turns,recent,rework))
    }).collect();
    ranking.sort_by(|left,right| {
        let first = scores[left];
        let second = scores[right];
        let order = match options.sort.as_str() {
            "turns" => second.1.cmp(&first.1),
            "recent" => second.2.cmp(&first.2),
            "rework" => second.3.total_cmp(&first.3),
            _ => second.0.total_cmp(&first.0),
        };
        order.then_with(||left.cmp(right))
    });
    let rank_ms = elapsed_ms(rank_started);
    let assembly_started = Instant::now();
    let mut requested = Vec::new();
    let mut presentation = BTreeMap::new();
    for root in ranking.into_iter().skip(options.offset.max(0) as usize).take(options.limit.max(0) as usize) {
        let members = &groups[&root];
        let mut children: BTreeMap<SessionKey,BTreeSet<SessionKey>> = BTreeMap::new();
        let mut group_nodes = BTreeSet::new();
        let mut missing = false;
        let mut cycle = false;
        for member in members {
            let (path,orphan,cyclic) = &paths[member];
            missing |= orphan;
            cycle |= cyclic;
            group_nodes.extend(path.iter().cloned());
            for edge in path.windows(2) {
                children.entry(edge[0].clone()).or_default().insert(edge[1].clone());
            }
        }
        let mut stack = vec![(root.clone(),0)];
        let mut visited = BTreeSet::new();
        while let Some((key,depth)) = stack.pop() {
            if !visited.insert(key.clone()) { continue; }
            let own = eligible.get(&key);
            let group = scores[&root];
            presentation.insert(key.clone(),SessionPresentation {
                depth,children_count:if depth==0 {group_nodes.len().saturating_sub(1)} else {children.get(&key).map_or(0,BTreeSet::len)},
                own_cost_usd:own.map_or(0.0,|value|value.cost),
                group_cost_usd:if depth==0 {group.0} else {own.map_or(0.0,|value|value.cost)},
                group_turns:if depth==0 {group.1} else {own.map_or(0,|value|value.turns)},
                context_only:own.is_none(),parent_missing:missing,cycle,
            });
            requested.push(key.clone());
            if expanded {
                if let Some(next) = children.get(&key) {
                    stack.extend(next.iter().rev().map(|child|(child.clone(),depth+1)));
                }
            }
        }
    }
    let assembly_ms = elapsed_ms(assembly_started);
    let hydrate_started = Instant::now();
    let mut hydrated = BTreeMap::new();
    for chunk in requested.chunks(200) {
        let placeholders = vec!["(?, ?)";chunk.len()].join(",");
        let sql = format!("WITH requested(kind,session_id) AS (VALUES {placeholders})
            SELECT s.kind,s.session_id,s.ai_title,s.first_prompt,s.project_label,s.git_branch,s.origin,
                s.primary_model,s.model_count,s.is_sidechain,s.work_tags,s.started_at,s.ended_at,s.wall_ms,
                s.active_ms,s.turn_count,s.user_msg_count,s.compact_count,s.cost_usd,s.goal_summary,s.goal_cluster,
                COALESCE(r.score,0) FROM requested q JOIN session s USING(kind,session_id)
                LEFT JOIN rework r USING(kind,session_id)");
        let params = chunk.iter().flat_map(|key|[SqlValue::Text(key.0.clone()),SqlValue::Text(key.1.clone())]).collect::<Vec<_>>();
        let mut statement = conn.prepare(&sql).map_err(|error|error.to_string())?;
        let rows = statement.query_map(params_from_iter(params.iter()),|row| {
            let key: SessionKey = (row.get(0)?,row.get(1)?);
            Ok((key.clone(),SessionRow {
                kind:key.0.clone(),session_id:key.1.clone(),title:display_title(row.get(2)?,row.get(19)?,row.get(3)?),
                project_label:row.get(4)?,git_branch:row.get(5)?,origin:row.get(6)?,primary_model:row.get(7)?,model_count:row.get(8)?,
                range_models:Vec::new(),range_model_count:0,is_sidechain:row.get::<_,i64>(9)?!=0,
                lineage:nodes[&key].lineage.clone(),presentation:presentation.remove(&key),
                work_tags:parse_json_array(row.get::<_,Option<String>>(10)?.as_deref()),started_at:row.get(11)?,ended_at:row.get(12)?,
                wall_ms:row.get(13)?,active_ms:row.get(14)?,turn_count:row.get(15)?,user_msg_count:row.get(16)?,
                compact_count:row.get(17)?,cost_usd:row.get(18)?,goal_summary:row.get(19)?,goal_cluster:row.get(20)?,rework_score:row.get(21)?,
            }))
        }).map_err(|error|error.to_string())?;
        for row in rows {
            let (key,mut value) = row.map_err(|error|error.to_string())?;
            apply_range_models(&mut value,group_models.get(&key).or_else(||models.get(&key)));
            hydrated.insert(key,value);
        }
    }
    let hydrate_ms = elapsed_ms(hydrate_started);
    if std::env::var_os("AILOG_PERF_DB").is_some() {
        println!("AILOG_G1_3_SESSION_REFERENCE=aggregate_ms={aggregate_ms} node_sql_ms={node_sql_ms} path_ms={path_ms} rank_ms={rank_ms} assembly_ms={assembly_ms} hydrate_ms={hydrate_ms}");
    }
    Ok((requested.into_iter().filter_map(|key|hydrated.remove(&key)).collect(),total))
}


#[cfg(test)]
mod scoped_node_tests {
    use super::*;
    #[test]
    fn scoped_nodes_keep_ancestors_cycles_and_internal_flags_without_unrelated_sessions() {
        let conn = Connection::open_in_memory().unwrap();
        crate::ailog::schema::init(&conn).unwrap();
        crate::ailog::migrate::apply(&conn).unwrap();
        for id in ["child","parent","root","unrelated"] {
            conn.execute("INSERT INTO session(kind,session_id) VALUES ('claude',?1)",[id]).unwrap();
        }
        conn.execute("UPDATE session SET parent_kind='claude',parent_session_id='parent',lineage_state='verified' WHERE session_id='child'",[]).unwrap();
        conn.execute("UPDATE session SET parent_kind='claude',parent_session_id='root',lineage_state='verified' WHERE session_id='parent'",[]).unwrap();
        conn.execute("UPDATE session SET origin='ailog-internal' WHERE session_id='root'",[]).unwrap();
        let requested = vec![("claude".to_string(),"child".to_string())];
        let selected = scoped_nodes(&conn,&requested).unwrap();
        assert_eq!(selected.len(),3);
        assert!(selected[&("claude".into(),"root".into())].internal);
        assert!(!selected.contains_key(&("claude".into(),"unrelated".into())));
        conn.execute("UPDATE session SET parent_kind='claude',parent_session_id='child',lineage_state='verified' WHERE session_id='root'",[]).unwrap();
        assert_eq!(scoped_nodes(&conn,&requested).unwrap().len(),3);
        assert!(scoped_nodes(&conn,&[]).unwrap().is_empty());
        let large: Vec<_> = std::iter::repeat_with(|| requested[0].clone()).take(1000).collect();
        assert_eq!(scoped_nodes(&conn,&large).unwrap().len(),nodes(&conn).unwrap().len());
    }
    #[test]
    fn paged_assembly_preserves_all_sorts_offsets_lineage_and_range_models() {
        let conn=Connection::open_in_memory().unwrap();
        crate::ailog::schema::init(&conn).unwrap();
        crate::ailog::migrate::apply(&conn).unwrap();
        for index in 0..1003 {
            let id=format!("fake-{index:04}");
            conn.execute("INSERT INTO session(kind,session_id) VALUES ('claude',?1)",[&id]).unwrap();
            conn.execute("INSERT INTO rework(kind,session_id,score) VALUES ('claude',?1,?2)",rusqlite::params![id,(index%7) as f64]).unwrap();
            for seq in 0..2 {
                conn.execute("INSERT INTO turn(kind,session_id,seq,ts,model,input_tokens,cost_usd) VALUES ('claude',?1,?2,?3,?4,?5,?6)",
                    rusqlite::params![id,seq,index+1,format!("model-{seq}"),index+seq,(index%5) as f64]).unwrap();
            }
        }
        conn.execute("UPDATE session SET parent_kind='claude',parent_session_id='fake-0000',lineage_state='verified' WHERE session_id='fake-0001'",[]).unwrap();
        conn.execute("UPDATE session SET parent_kind='claude',parent_session_id='fake-0001',lineage_state='verified' WHERE session_id='fake-0000'",[]).unwrap();
        let rows=aggregate_raw_span(&conn,0,100000,&Filters::default()).unwrap();
        for sort in ["cost","turns","recent","rework"] {
            for offset in [0,2,1000] {
                for expanded in [false,true] {
                    let options=SessionsOptions { sort:sort.into(),offset,limit:5 };
                    let before=session_page_reference(&conn,&rows,expanded,&options).unwrap();
                    let after=session_page(&conn,&rows,expanded,&options).unwrap();
                    assert_eq!(serde_json::to_value(before).unwrap(),serde_json::to_value((after.0,after.1)).unwrap());
                }
            }
        }
    }

}

#[cfg(test)]
mod session_index_retention_tests {
    use super::*;

    #[test]
    fn retains_one_oversized_index_and_at_most_four_periods() {
        let prepared = Arc::new(PreparedSessions {
            eligible: BTreeMap::new(), models: BTreeMap::new(), nodes: BTreeMap::new(),
            paths: BTreeMap::new(), groups: BTreeMap::new(), scores: BTreeMap::new(),
        });
        let mut cache = Vec::new();
        for period in 0..6 {
            store_session_index(&mut cache, (period.to_string(), "revision".into(), 1, Arc::clone(&prepared)));
        }
        assert_eq!(cache.iter().map(|entry| entry.0.as_str()).collect::<Vec<_>>(), vec!["2", "3", "4", "5"]);
        store_session_index(&mut cache, ("all-time".into(), "revision".into(), SESSION_INDEX_MAX_BYTES + 1, Arc::clone(&prepared)));
        assert_eq!(cache.len(), 1);
        assert_eq!(cache[0].0, "all-time", "an oversized current period must remain reusable");
        store_session_index(&mut cache, ("new-day".into(), "revision".into(), 1, prepared));
        assert_eq!(cache.len(), 1);
        assert_eq!(cache[0].0, "new-day");
    }
}

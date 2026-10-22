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

pub(super) fn session_page(conn: &Connection, source_rows: &[AggregateRow], expanded: bool, options: &SessionsOptions)
    -> Result<(Vec<SessionRow>,i64),String> {
    let nodes = nodes(conn)?;
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
    Ok((requested.into_iter().filter_map(|key|hydrated.remove(&key)).collect(),total))
}

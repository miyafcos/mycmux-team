use rusqlite::{types::Value, Connection, ToSql};

use super::model::{HistoryError, Hit, SearchFilters};

pub(crate) fn run(
    connection: &Connection,
    query: &str,
    filters: &SearchFilters,
    limit: usize,
) -> Result<Vec<Hit>, HistoryError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let match_query = compile_match(query);
    if match_query.is_none()
        && filters.repo_id.is_none()
        && filters.branch.is_none()
        && filters.logical_session_id.is_none()
        && filters.near_timestamp.is_none()
    {
        return Ok(Vec::new());
    }

    let mut clauses = Vec::new();
    let mut values = Vec::<Value>::new();
    let mut joins = String::from(
        " FROM events e JOIN logical_sessions ls ON ls.logical_session_id=e.logical_session_id",
    );
    let score_column;
    if let Some(match_query) = match_query {
        joins.push_str(" JOIN events_fts ON events_fts.event_rowid=e.id");
        clauses.push("events_fts MATCH ?".to_string());
        values.push(Value::Text(match_query));
        score_column = "bm25(events_fts)";
    } else {
        score_column = "NULL";
    }
    if let Some(repo_id) = &filters.repo_id {
        clauses.push("e.repo_id=?".to_string());
        values.push(Value::Text(repo_id.clone()));
    }
    if let Some(branch) = &filters.branch {
        clauses.push("e.branch=?".to_string());
        values.push(Value::Text(branch.clone()));
    }
    if let Some(logical_session_id) = &filters.logical_session_id {
        clauses.push("ls.logical_session_id=?".to_string());
        values.push(Value::Text(logical_session_id.clone()));
    }

    let mut sql = format!(
        "SELECT e.event_id, ls.logical_session_id, e.timestamp, e.event_type, e.searchable_text, \
                e.repo_id, e.cwd, e.branch, {score_column} AS score{joins}"
    );
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY ");
    if score_column != "NULL" {
        sql.push_str("score ASC, ");
    }
    if let Some(near_timestamp) = filters.near_timestamp {
        sql.push_str("ABS(CAST(e.timestamp AS REAL)-CAST(? AS REAL)) ASC, ");
        values.push(Value::Integer(near_timestamp));
    }
    sql.push_str("e.timestamp DESC, e.event_id ASC LIMIT ?");
    values.push(Value::Integer(limit as i64));

    let params: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params.as_slice(), |row| {
        Ok(Hit {
            event_id: row.get(0)?,
            logical_session_id: row.get(1)?,
            timestamp: row.get(2)?,
            event_type: row.get(3)?,
            searchable_text: row.get(4)?,
            repo_id: row.get(5)?,
            cwd: row.get(6)?,
            branch: row.get(7)?,
            bm25_score: row.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(HistoryError::from)
}

pub(crate) fn compile_match(query: &str) -> Option<String> {
    let terms = query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .take(32)
        .map(|term| format!("\"{term}\""))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

use std::{collections::HashMap, fs, path::Path};

use super::{budget::Budget, is_link, safe_dir, ScanContext, ScanHit};
use crate::launcher_dirs::{
    model::Signal,
    paths::{folder_name, normalize_path, path_key},
    rules::{Rule, RuleKind},
};

pub fn scan(
    rule: &Rule,
    context: &ScanContext,
    budget: &mut Budget,
) -> Result<Vec<ScanHit>, String> {
    let RuleKind::SessionCwd { root, min_sessions } = &rule.kind else {
        unreachable!()
    };
    let path = &context.db_path;
    if !fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && !is_link(&meta)) {
        return Err(format!("ailog database not found: {}", path.display()));
    }
    let conn = crate::ailog::db::reader(path)?;
    let now = chrono::DateTime::<chrono::Utc>::from(context.now).timestamp_millis();
    let cutoff = now.saturating_sub(i64::from(rule.window_days) * 86_400_000);
    let mut query = conn
        .prepare(
            "SELECT cwd, COALESCE(started_at, ended_at) FROM session
        WHERE cwd IS NOT NULL AND is_sidechain = 0 AND user_msg_count > 0
        AND COALESCE(started_at, ended_at) >= ?1",
        )
        .map_err(|error| format!("session query: {error}"))?;
    let rows = query
        .query_map([cutoff], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| format!("session query: {error}"))?;
    let mut grouped: HashMap<String, (String, u32, i64)> = HashMap::new();
    let root_key = root.as_deref().map(path_key);
    for row in rows {
        if !budget.check() {
            break;
        }
        let (cwd, time) = row.map_err(|error| format!("session row: {error}"))?;
        if cwd.trim().is_empty() {
            continue;
        }
        let cwd = normalize_path(&cwd);
        let key = path_key(&cwd);
        if root_key.as_ref().is_some_and(|root| {
            key != *root && !key.starts_with(&format!("{}/", root.trim_end_matches('/')))
        }) {
            continue;
        }
        let entry = grouped.entry(key).or_insert((cwd, 0, time));
        entry.1 = entry.1.saturating_add(1);
        entry.2 = entry.2.max(time);
    }
    let mut hits = Vec::new();
    for (cwd, count, time) in grouped.into_values() {
        if !budget.check() {
            break;
        }
        if count < *min_sessions {
            continue;
        }
        if !budget.visit() {
            break;
        }
        if !safe_dir(Path::new(&cwd)) {
            continue;
        }
        let Some(time) = chrono::DateTime::from_timestamp_millis(time) else {
            continue;
        };
        hits.push(ScanHit {
            label: folder_name(&cwd),
            path: cwd,
            signal: Signal::Session,
            seen_at: time
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string(),
        });
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launcher_dirs::{rules::fixture, scan::context};

    #[test]
    fn counts_normalized_cwds_filters_rows_and_uses_end_only_when_start_missing() {
        let root = tempfile::tempdir().unwrap();
        let ctx = context(root.path());
        let conn = rusqlite::Connection::open(&ctx.db_path).unwrap();
        crate::ailog::schema::init(&conn).unwrap();
        let project = root.path().join("work/project");
        let outside = root.path().join("work-other/project");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let now = chrono::DateTime::<chrono::Utc>::from(ctx.now).timestamp_millis();
        let cwd = project.to_string_lossy().into_owned();
        for (id, path, start, end, side, messages) in [
            ("a", cwd.clone(), Some(now), None, 0, 1),
            ("b", format!("{cwd}/"), None, Some(now), 0, 1),
            ("side", cwd.clone(), Some(now), None, 1, 1),
            ("empty", cwd.clone(), Some(now), None, 0, 0),
            ("old", cwd.clone(), Some(0), Some(now), 0, 1),
            (
                "outside",
                outside.to_string_lossy().into(),
                Some(now),
                None,
                0,
                1,
            ),
            (
                "missing",
                root.path().join("work/missing").to_string_lossy().into(),
                Some(now),
                None,
                0,
                1,
            ),
        ] {
            conn.execute("INSERT INTO session(kind,session_id,cwd,started_at,ended_at,is_sidechain,user_msg_count) VALUES ('claude',?1,?2,?3,?4,?5,?6)",
                rusqlite::params![id, path, start, end, side, messages]).unwrap();
        }
        let mut rule = fixture("session-cwd");
        rule.kind = RuleKind::SessionCwd {
            root: Some(root.path().join("work").to_string_lossy().into()),
            min_sessions: 2,
        };
        let hits = scan(&rule, &ctx, &mut Budget::new()).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].label, "project");
        if let RuleKind::SessionCwd { min_sessions, .. } = &mut rule.kind {
            *min_sessions = 3;
        }
        assert!(scan(&rule, &ctx, &mut Budget::new()).unwrap().is_empty());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM session", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            7
        );
        assert_eq!(
            crate::ailog::db::reader(&ctx.db_path)
                .unwrap()
                .query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn query_failures_are_reported_as_rule_errors() {
        let root = tempfile::tempdir().unwrap();
        let ctx = context(root.path());
        let conn = crate::ailog::db::writer(&ctx.db_path).unwrap();
        conn.execute_batch("DROP TABLE session").unwrap();
        let error = scan(&fixture("session-cwd"), &ctx, &mut Budget::new()).unwrap_err();
        assert!(error.starts_with("session query:"));
    }
}

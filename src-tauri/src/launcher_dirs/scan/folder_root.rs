use std::{collections::HashMap, fs, path::Path, time::SystemTime};

use super::{budget::Budget, is_link, recent, safe_dir, ScanContext, ScanHit};
use crate::launcher_dirs::{
    model::Signal,
    rules::{representative_depth, Rule, RuleKind},
};

pub fn scan(
    rule: &Rule,
    context: &ScanContext,
    budget: &mut Budget,
) -> Result<Vec<ScanHit>, String> {
    let RuleKind::FolderRoot {
        root,
        depth,
        depth_overrides,
        max_depth,
        exclude,
        top_level_exclude,
    } = &rule.kind
    else {
        unreachable!()
    };
    let root = Path::new(root);
    if !safe_dir(root) {
        return Err(format!(
            "not a directory or linked root: {}",
            root.display()
        ));
    }
    let mut latest: HashMap<Vec<String>, (SystemTime, ScanHit)> = HashMap::new();
    if !budget.visit() {
        return Ok(Vec::new());
    }
    let entries =
        fs::read_dir(root).map_err(|error| format!("read {}: {error}", root.display()))?;
    let mut pending = vec![(entries, Vec::<String>::new())];
    while let Some((entries, rel)) = pending.last_mut() {
        if !budget.check() {
            break;
        }
        let entry = match entries.next() {
            Some(Ok(entry)) => entry,
            Some(Err(_)) => continue,
            None => {
                pending.pop();
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if exclude.matches(&name) || (rel.is_empty() && top_level_exclude.contains(&name)) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if is_link(&meta) {
            continue;
        }
        if meta.is_dir() && rel.len() < *max_depth as usize {
            if !budget.visit() {
                break;
            }
            let mut next = rel.clone();
            next.push(name);
            if let Ok(children) = fs::read_dir(entry.path()) {
                pending.push((children, next));
            }
        } else if meta.is_file() && !rel.is_empty() {
            let Ok(time) = meta.modified() else {
                continue;
            };
            if !recent(time, context, rule.window_days) {
                continue;
            }
            let count = representative_depth(&rel[0], *depth, depth_overrides).min(rel.len());
            let key = rel[..count].to_vec();
            if latest.get(&key).is_none_or(|(old, _)| *old < time) {
                let path = key
                    .iter()
                    .fold(root.to_path_buf(), |path, part| path.join(part));
                if safe_dir(&path) {
                    let hit = ScanHit::new(&path, key.join("/"), Signal::Folder, time);
                    latest.insert(key, (time, hit));
                }
            }
        }
    }
    // No filesystem work after the deadline: retain hits already validated.
    Ok(latest.into_values().map(|(_, hit)| hit).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launcher_dirs::{
        rules::{fixture, DepthOverride, Exclude},
        scan::{context, write_at},
    };
    use std::time::{Duration, Instant};

    #[test]
    fn groups_at_existing_depth_with_overrides_excludes_and_window() {
        let root = tempfile::tempdir().unwrap();
        let ctx = context(root.path());
        for name in [
            "client/project/deep/new.txt",
            "special/book/math/new.txt",
            "short/new.txt",
            "_noise/project/new.txt",
            "client/invoice/new.txt",
            "admin/project/new.txt",
            "client/project/deep/too/deep/ignored.txt",
        ] {
            write_at(&root.path().join(name), ctx.now);
        }
        write_at(
            &root.path().join("old/project/old.txt"),
            ctx.now - Duration::from_secs(30 * 86_400),
        );
        let mut rule = fixture("folder-root");
        rule.kind = RuleKind::FolderRoot {
            root: root.path().to_string_lossy().into(),
            depth: 2,
            depth_overrides: vec![DepthOverride {
                prefix: "special".into(),
                depth: 3,
            }],
            max_depth: 3,
            exclude: Exclude {
                prefixes: vec!["_".into()],
                substrings: vec!["invoice".into()],
                ..Default::default()
            },
            top_level_exclude: vec!["admin".into()],
        };
        let mut labels = scan(&rule, &ctx, &mut Budget::new())
            .unwrap()
            .into_iter()
            .map(|hit| {
                assert!(Path::new(&hit.path).is_dir());
                hit.label
            })
            .collect::<Vec<_>>();
        labels.sort();
        assert_eq!(labels, vec!["client/project", "short", "special/book/math"]);
        let mut expired = Budget::new();
        expired.deadline = Instant::now();
        assert!(scan(&rule, &ctx, &mut expired).unwrap().is_empty());
        assert!(expired.truncated);
        let mut full = Budget::new();
        full.visited = super::super::budget::MAX_DIRECTORIES;
        assert!(scan(&rule, &ctx, &mut full).unwrap().is_empty());
        assert!(full.truncated);
    }

    #[test]
    fn directory_limit_returns_the_branches_already_visited() {
        let root = tempfile::tempdir().unwrap();
        let ctx = context(root.path());
        for name in ["first/file.txt", "second/file.txt"] {
            write_at(&root.path().join(name), ctx.now);
        }
        let mut rule = fixture("folder-root");
        if let RuleKind::FolderRoot { root: path, .. } = &mut rule.kind {
            *path = root.path().to_string_lossy().into();
        }
        let mut budget = Budget::new();
        budget.visited = super::super::budget::MAX_DIRECTORIES - 2;
        let hits = scan(&rule, &ctx, &mut budget).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(budget.truncated);
    }

    #[cfg(windows)]
    #[test]
    fn junctions_are_not_followed_even_when_supplied_as_the_root() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        write_at(
            &target.path().join("client/project/file"),
            SystemTime::now(),
        );
        let link = root.path().join("linked");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(target.path())
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(!safe_dir(&link));
        assert!(!safe_dir(&link.join("client")));
        let mut rule = fixture("folder-root");
        if let RuleKind::FolderRoot { root: path, .. } = &mut rule.kind {
            *path = root.path().to_string_lossy().into();
        }
        assert!(scan(&rule, &context(root.path()), &mut Budget::new())
            .unwrap()
            .is_empty());
    }
}

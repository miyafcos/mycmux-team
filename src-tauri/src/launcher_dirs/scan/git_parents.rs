use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use super::{budget::Budget, existing_dir, is_link, recent, safe_dir, ScanContext, ScanHit};
use crate::launcher_dirs::{
    model::Signal,
    paths::{folder_name, path_key},
    rules::{Rule, RuleKind},
};

fn activity(repo: &Path, budget: &mut Budget) -> Option<SystemTime> {
    let dot = repo.join(".git");
    let meta = fs::symlink_metadata(&dot).ok()?;
    if is_link(&meta) {
        return None;
    }
    let gitdir = if meta.is_dir() {
        dot
    } else if meta.is_file() && meta.len() <= 65_536 {
        let pointer = fs::read_to_string(dot).ok()?;
        let target = pointer.trim().strip_prefix("gitdir:")?.trim();
        if target.is_empty() {
            return None;
        }
        let target = PathBuf::from(target);
        if target.is_absolute() {
            target
        } else {
            repo.join(target)
        }
    } else {
        return None;
    };
    if !existing_dir(&gitdir) {
        return None;
    }
    ["index", "HEAD", "FETCH_HEAD", "COMMIT_EDITMSG"]
        .into_iter()
        .filter_map(|name| {
            if !budget.check() {
                return None;
            }
            let meta = fs::symlink_metadata(gitdir.join(name)).ok()?;
            if !meta.is_file() || is_link(&meta) {
                return None;
            }
            meta.modified().ok()
        })
        .max()
}

pub fn scan(
    rule: &Rule,
    context: &ScanContext,
    budget: &mut Budget,
) -> Result<Vec<ScanHit>, String> {
    let RuleKind::GitParents { parents, exclude } = &rule.kind else {
        unreachable!()
    };
    // Validate every parent before collecting even partial results.
    for parent in parents {
        if !existing_dir(Path::new(parent)) {
            return Err(format!("not a directory: {parent}"));
        }
    }
    let mut hits = Vec::new();
    for parent in parents {
        let path = Path::new(parent);
        if !budget.visit() {
            break;
        }
        let entries = fs::read_dir(path).map_err(|error| format!("read {parent}: {error}"))?;
        for entry in entries {
            if !budget.check() {
                break;
            }
            let Ok(entry) = entry else {
                continue;
            };
            if !safe_dir(&entry.path()) {
                continue;
            }
            if !budget.visit() {
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if exclude.matches_git(&name) {
                continue;
            }
            let Some(time) = activity(&entry.path(), budget) else {
                continue;
            };
            if !recent(time, context, rule.window_days) {
                continue;
            }
            let label = if path_key(parent) == path_key(&context.home.to_string_lossy()) {
                name
            } else {
                format!("{}/{name}", folder_name(parent))
            };
            hits.push(ScanHit::new(&entry.path(), label, Signal::Git, time));
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launcher_dirs::{
        rules::{fixture, Exclude},
        scan::{context, finish_hits, write_at},
    };
    use std::time::Duration;

    #[test]
    fn missing_parent_errors_and_apply_preserves_existing_auto_rows() {
        use crate::launcher_dirs::{
            model::{LauncherDirEntry, LauncherDirsDoc, Source},
            rules::Mode,
            scan::{apply, run_all_at},
        };

        let root = tempfile::tempdir().unwrap();
        let ctx = context(root.path());
        write_at(&root.path().join("repo/.git/HEAD"), ctx.now);
        let missing = root.path().join("missing").to_string_lossy().into_owned();
        let mut rule = fixture("git-parents");
        rule.mode = Mode::Auto;
        if let RuleKind::GitParents { parents, .. } = &mut rule.kind {
            *parents = vec![root.path().to_string_lossy().into_owned(), missing.clone()];
        }
        assert_eq!(
            scan(&rule, &ctx, &mut Budget::new()).unwrap_err(),
            format!("not a directory: {missing}")
        );
        let mut entry = LauncherDirEntry::manual(
            "dev", "saved", &root.path().join("repo").to_string_lossy(),
        );
        entry.source = Source::Auto;
        entry.rule_id = Some(rule.id.clone());
        let mut doc = LauncherDirsDoc::default();
        doc.rules = vec![rule.to_value()];
        doc.entries = vec![entry.clone()];
        let outcome = run_all_at(&doc, &ctx);
        assert!(outcome.results[0].error.is_some());
        apply(&mut doc, &outcome, &[]);
        assert_eq!(doc.entries, vec![entry]);
    }

    #[test]
    fn normal_and_relative_worktree_activity_exclusions_window_and_max() {
        let root = tempfile::tempdir().unwrap();
        let ctx = context(root.path());
        for name in ["normal", "_hidden", "AppData", "RepoBACKUP"] {
            write_at(&root.path().join(name).join(".git/HEAD"), ctx.now);
        }
        write_at(
            &root.path().join("stale/.git/index"),
            ctx.now - Duration::from_secs(40 * 86_400),
        );
        write_at(
            &root.path().join("normal/.git/index"),
            ctx.now - Duration::from_secs(40 * 86_400),
        );
        write_at(
            &root.path().join("metadata/index"),
            ctx.now - Duration::from_secs(86_400),
        );
        fs::create_dir(root.path().join("worktree")).unwrap();
        fs::write(root.path().join("worktree/.git"), "gitdir: ../metadata\n").unwrap();
        write_at(&root.path().join("invalid/.git"), ctx.now);
        let mut rule = fixture("git-parents");
        rule.kind = RuleKind::GitParents {
            parents: vec![root.path().to_string_lossy().into()],
            exclude: Exclude {
                prefixes: vec!["_".into()],
                names: vec!["AppData".into()],
                substrings: vec!["backup".into()],
            },
        };
        let hits = finish_hits(scan(&rule, &ctx, &mut Budget::new()).unwrap(), 10);
        assert_eq!(
            hits.iter()
                .map(|hit| hit.label.as_str())
                .collect::<Vec<_>>(),
            vec!["normal", "worktree"]
        );
        assert_eq!(finish_hits(hits, 1)[0].label, "normal");
        let mut away = ctx;
        away.home = root.path().join("another-home");
        assert!(scan(&rule, &away, &mut Budget::new())
            .unwrap()
            .iter()
            .all(|hit| hit.label.contains('/')));
    }
}

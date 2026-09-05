use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
    time::SystemTime,
};

use super::{budget::Budget, is_link, recent, safe_dir, ScanContext, ScanHit};
use crate::launcher_dirs::{
    model::Signal,
    paths::{folder_name, path_key},
    rules::{representative_depth, DepthOverride, Rule, RuleKind},
};

pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const SELF_ECHO_MARKERS: [&str; 3] = ["launch-roots", "AUTO-", "launch-dirs"];

fn separator(c: char) -> bool {
    c == '/' || c == '\\'
}

fn mentions(
    line: &str,
    root_name: &str,
    depth: u32,
    overrides: &[DepthOverride],
    budget: &mut Budget,
) -> Vec<Vec<String>> {
    let mut found = Vec::new();
    if SELF_ECHO_MARKERS.iter().any(|marker| line.contains(marker)) {
        return found;
    }
    for (index, _) in line.match_indices(root_name) {
        if !budget.check() {
            break;
        }
        if index > 0
            && line[..index]
                .chars()
                .next_back()
                .is_some_and(|c| !separator(c) && c != '"' && !c.is_whitespace())
        {
            continue;
        }
        let mut rest = &line[index + root_name.len()..];
        if !rest.starts_with(separator) {
            continue;
        }
        let mut parts = Vec::new();
        let mut count = depth as usize;
        loop {
            if !budget.check() {
                break;
            }
            rest = rest.trim_start_matches(separator);
            let end = rest
                .find(|c: char| {
                    separator(c)
                        || matches!(
                            c,
                            '"' | '\n' | '\r' | '\t' | '|' | '<' | '>' | '*' | '?' | ':'
                        )
                })
                .unwrap_or(rest.len());
            let part = rest[..end].trim_end();
            if part.is_empty() || part.starts_with(['_', '.']) {
                break;
            }
            if parts.is_empty() {
                count = representative_depth(part, depth, overrides);
            }
            parts.push(part.to_string());
            if parts.len() == count {
                found.push(parts);
                break;
            }
            rest = &rest[end..];
            if !rest.starts_with(separator) {
                break;
            }
        }
    }
    found
}

pub fn scan(
    rule: &Rule,
    context: &ScanContext,
    budget: &mut Budget,
) -> Result<Vec<ScanHit>, String> {
    let RuleKind::SessionMentions {
        root,
        depth,
        depth_overrides,
        min_mentions,
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
    let root_name = folder_name(&root.to_string_lossy());
    let mut counts: HashMap<String, (Vec<String>, u32, SystemTime)> = HashMap::new();
    let mut oversized = false;
    for projects in &context.transcript_roots {
        if !budget.visit() {
            break;
        }
        if !safe_dir(projects) {
            continue;
        }
        let dirs = fs::read_dir(projects)
            .map_err(|error| format!("read {}: {error}", projects.display()))?;
        for dir in dirs {
            if !budget.check() {
                break;
            }
            let Ok(dir) = dir else {
                continue;
            };
            if !safe_dir(&dir.path()) {
                continue;
            }
            if !budget.visit() {
                break;
            }
            let Ok(files) = fs::read_dir(dir.path()) else {
                continue;
            };
            for file in files {
                if !budget.check() {
                    break;
                }
                let Ok(file) = file else {
                    continue;
                };
                if file
                    .path()
                    .extension()
                    .is_none_or(|extension| extension != "jsonl")
                {
                    continue;
                }
                let Ok(meta) = fs::symlink_metadata(file.path()) else {
                    continue;
                };
                if !meta.is_file() || is_link(&meta) {
                    continue;
                }
                let Ok(time) = meta.modified() else {
                    continue;
                };
                if !recent(time, context, rule.window_days) {
                    continue;
                }
                if meta.len() > MAX_FILE_BYTES {
                    oversized = true;
                    continue;
                }
                let file = fs::File::open(file.path())
                    .map_err(|error| format!("open transcript: {error}"))?;
                let mut reader = BufReader::new(file.take(MAX_FILE_BYTES));
                let mut line = Vec::new();
                while budget.check() {
                    line.clear();
                    if reader
                        .read_until(b'\n', &mut line)
                        .map_err(|error| format!("read transcript: {error}"))?
                        == 0
                    {
                        break;
                    }
                    for rel in mentions(
                        &String::from_utf8_lossy(&line),
                        &root_name,
                        *depth,
                        depth_overrides,
                        budget,
                    ) {
                        if !budget.check() {
                            break;
                        }
                        let path = root.join(rel.join("/"));
                        let key = path_key(&path.to_string_lossy());
                        if !counts.contains_key(&key) {
                            if !budget.visit() {
                                break;
                            }
                            if !safe_dir(&path) {
                                continue;
                            }
                        }
                        let entry = counts.entry(key).or_insert((rel, 0, time));
                        entry.1 = entry.1.saturating_add(1);
                        entry.2 = entry.2.max(time);
                    }
                }
            }
        }
    }
    let hits = counts
        .into_values()
        .filter_map(|(rel, count, time)| {
            let path = root.join(rel.join("/"));
            (count >= *min_mentions)
                .then(|| ScanHit::new(&path, rel.join("/"), Signal::Mention, time))
        })
        .collect();
    budget.truncated |= oversized;
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launcher_dirs::{
        rules::fixture,
        scan::{context, write_at},
    };
    use std::time::Duration;

    #[test]
    fn separators_counts_noise_echo_overrides_window_and_existing_dirs() {
        assert_eq!(MAX_FILE_BYTES, 52_428_800);
        let root = tempfile::tempdir().unwrap();
        let ctx = context(root.path());
        let work = root.path().join("work");
        for rel in [
            "client/project",
            "special/book/math",
            "rare/project",
            "_noise/project",
            "old/project",
        ] {
            fs::create_dir_all(work.join(rel)).unwrap();
        }
        let transcript = root.path().join("projects/session/log.jsonl");
        write_at(&transcript, ctx.now);
        fs::write(&transcript, concat!(
            "\"work/client/project\"\n", "\"work\\client\\project\"\n", "\"work\\\\client\\\\project\"\n",
            "\"work/special/book/math\" \"work/special/book/math\" \"work/special/book/math\"\n",
            "\"work/rare/project\"\n", "launch-roots work/rare/project\n", "AUTO-DEV work/rare/project\n",
            "launch-dirs work/rare/project\n", "work/_noise/project work/_noise/project work/_noise/project\n",
            "\"work/missing/project\" \"work/missing/project\" \"work/missing/project\"\n"
        )).unwrap();
        let old = root.path().join("projects/session/old.jsonl");
        write_at(&old, ctx.now);
        fs::write(
            &old,
            "\"work/old/project\" \"work/old/project\" \"work/old/project\"",
        )
        .unwrap();
        fs::File::options()
            .write(true)
            .open(old)
            .unwrap()
            .set_modified(ctx.now - Duration::from_secs(30 * 86_400))
            .unwrap();
        let mut rule = fixture("session-mentions");
        rule.kind = RuleKind::SessionMentions {
            root: work.to_string_lossy().into(),
            depth: 2,
            min_mentions: 3,
            depth_overrides: vec![DepthOverride {
                prefix: "special".into(),
                depth: 3,
            }],
        };
        fs::File::create(root.path().join("projects/session/oversized.jsonl"))
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        let mut budget = Budget::new();
        let mut labels = scan(&rule, &ctx, &mut budget)
            .unwrap()
            .into_iter()
            .map(|hit| hit.label)
            .collect::<Vec<_>>();
        labels.sort();
        assert_eq!(labels, vec!["client/project", "special/book/math"]);
        assert!(budget.truncated);
        assert!(mentions(
            "homework/client/project",
            "work",
            2,
            &[],
            &mut Budget::new()
        )
        .is_empty());
    }
}

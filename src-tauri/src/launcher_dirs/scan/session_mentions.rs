use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::SystemTime,
};

use super::{budget::Budget, existing_dir, is_link, recent, safe_dir, ScanContext, ScanHit};
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

fn hard_path_delimiter(c: char) -> bool {
    matches!(
        c,
        '"' | '\'' | '\u{60}' | '<' | '>' | '|' | '\t' | '(' | ')' | '[' | ']' | '=' | ',' | ';'
    )
}

fn collapse_separators(prefix: &str) -> String {
    let mut collapsed = String::with_capacity(prefix.len());
    let mut leading = true;
    for c in prefix.chars() {
        if separator(c) {
            if !collapsed.ends_with('/') || (leading && collapsed.len() < 2) {
                collapsed.push('/');
            }
        } else {
            collapsed.push(c);
            leading = false;
        }
    }
    collapsed
}

fn absolute_root_matches(
    prefix: &str,
    root_name: &str,
    root_key: &str,
    budget: &mut Budget,
) -> bool {
    // Cutting at the nearest hard delimiter commutes with the 600-char cap.
    let mut start = prefix.len();
    for (offset, c) in prefix.char_indices().rev().take(600) {
        if hard_path_delimiter(c) {
            start = offset + c.len_utf8();
            break;
        }
        start = offset;
    }
    let window = &prefix[start..];
    let starts = std::iter::once(0).chain(
        window.char_indices()
            .filter(|(_, c)| c.is_whitespace())
            .map(|(offset, c)| offset + c.len_utf8()),
    );
    for start in starts {
        if !budget.check() {
            return false;
        }
        let suffix = &window[start..];
        let mut candidate = collapse_separators(suffix);
        candidate.push_str(root_name);
        if path_key(&candidate) == root_key {
            return true;
        }
        // JSON-escaped Unix backslashes also encode a single local root slash.
        // A configured UNC root retains its double slash in the primary match.
        if !cfg!(windows)
            && root_key.starts_with('/')
            && !root_key.starts_with("//")
            && suffix.starts_with("\\\\")
            && candidate.starts_with("//")
            && path_key(&candidate[1..]) == root_key
        {
            return true;
        }
    }
    false
}

// Keep complete existing names, including spaces; only then trim trailing prose.
fn resolve_mention_prose(
    path: &Path,
    rel: &mut [String],
    budget: &mut Budget,
) -> Option<PathBuf> {
    let last = rel.last()?;
    for (end, c) in last.char_indices().rev() {
        if !c.is_whitespace() {
            continue;
        }
        let name = last[..end].trim_end();
        if name.is_empty() {
            continue;
        }
        if !budget.visit() {
            return None;
        }
        let candidate = path.with_file_name(name);
        if existing_dir(&candidate) {
            let end = name.len();
            rel.last_mut()?.truncate(end);
            return Some(candidate);
        }
    }
    None
}

#[derive(Debug, PartialEq, Eq)]
struct Mention {
    parts: Vec<String>,
    terminator: Option<char>,
}

fn mentions(
    line: &str,
    root_name: &str,
    root_key: &str,
    depth: u32,
    overrides: &[DepthOverride],
    budget: &mut Budget,
) -> Vec<Mention> {
    let mut found = Vec::new();
    if SELF_ECHO_MARKERS.iter().any(|marker| line.contains(marker)) {
        return found;
    }
    for (index, _) in line.match_indices(root_name) {
        if !budget.check() {
            break;
        }
        let prefix = &line[..index];
        if let Some(previous) = prefix.chars().next_back() {
            if separator(previous) {
                if !absolute_root_matches(prefix, root_name, root_key, budget) {
                    continue;
                }
            } else if !hard_path_delimiter(previous) && !previous.is_whitespace() {
                continue;
            }
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
                            '"' | '\'' | '\n' | '\r' | '\t' | '|' | '<' | '>' | '*' | '?' | ':'
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
                found.push(Mention {
                    parts,
                    terminator: rest[end..].chars().next(),
                });
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
    if !existing_dir(root) {
        return Err(format!(
            "not a directory: {}",
            root.display()
        ));
    }
    let root_name = folder_name(&root.to_string_lossy());
    let root_key = path_key(&root.to_string_lossy());
    let mut counts: HashMap<String, (Vec<String>, u32, SystemTime)> = HashMap::new();
    let mut oversized = false;
    for projects in &context.transcript_roots {
        if !budget.visit() {
            break;
        }
        if !existing_dir(projects) {
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
                    for Mention { parts: mut rel, terminator } in mentions(
                        &String::from_utf8_lossy(&line),
                        &root_name,
                        &root_key,
                        *depth,
                        depth_overrides,
                        budget,
                    ) {
                        if !budget.check() {
                            break;
                        }
                        let mut path = root.join(rel.join("/"));
                        let mut key = path_key(&path.to_string_lossy());
                        if !counts.contains_key(&key) {
                            if !budget.visit() {
                                break;
                            }
                            if !existing_dir(&path) {
                                // Only line-ended spans can include trailing prose.
                                if !matches!(terminator, None | Some('\n' | '\r')) {
                                    continue;
                                }
                                let Some(resolved) = resolve_mention_prose(&path, &mut rel, budget) else {
                                    continue;
                                };
                                path = resolved;
                                key = path_key(&path.to_string_lossy());
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
    fn absolute_mentions_require_the_full_root_and_relative_mentions_still_count() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Company Dropbox/work");
        fs::create_dir_all(root.join("client/project")).unwrap();
        let root_key = path_key(&root.to_string_lossy());
        let slash = root.to_string_lossy().replace('\\', "/");
        let escaped = slash.replace('/', "\\\\");
        for line in [
            format!("\"{slash}/client/project\""),
            format!("\"{escaped}\\\\client\\\\project\""),
            format!("see the folder {slash}/client/project\""),
            "\"work/client/project\"".into(),
            format!("\u{3000}{slash}/client/project\""),
        ] {
            assert_eq!(
                mentions(&line, "work", &root_key, 2, &[], &mut Budget::new()),
                vec![Mention {
                    parts: vec!["client".to_string(), "project".to_string()],
                    terminator: Some('"'),
                }],
                "{line}"
            );
        }
        for line in [
            "\"/Volumes/archive/Company Dropbox/work/client/project\"",
            "\"C:/elsewhere/work/client/project\"",
            "\"homework/client/project\"",
        ] {
            assert!(mentions(line, "work", &root_key, 2, &[], &mut Budget::new()).is_empty(), "{line}");
        }
    }

    #[test]
    fn spaced_roots_and_surrounding_prose_resolve_to_existing_directories() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = context(temp.path());
        let root = temp.path().join("Company Dropbox/work");
        for rel in [
            "client/project", "client with spaces/project", "client with spaces/project with spaces",
        ] {
            fs::create_dir_all(root.join(rel)).unwrap();
        }
        let slash = root.to_string_lossy().replace('\\', "/");
        let escaped = slash.replace('/', "\\\\");
        let transcript = temp.path().join("projects/session/log.jsonl");
        write_at(&transcript, ctx.now);
        let mut rule = fixture("session-mentions");
        rule.kind = RuleKind::SessionMentions {
            root: root.to_string_lossy().into(),
            depth: 2,
            depth_overrides: Vec::new(),
            min_mentions: 1,
        };
        #[cfg(windows)]
        let msys = Some(format!(
            "/{}/{}/client/project",
            slash[..1].to_ascii_lowercase(),
            &slash[3..],
        ));
        #[cfg(not(windows))]
        let msys: Option<String> = None;
        for line in [
            format!("\"{slash}/client/project\""),
            format!("\"{escaped}\\\\client\\\\project\""),
            format!("see the folder {slash}/client/project now"),
            format!("see\u{3000}the\u{3000}folder\u{3000}{slash}/client/project now"),
            "\"work/client/project\"".into(),
        ].into_iter().chain(msys) {
            fs::write(&transcript, &line).unwrap();
            let hits = scan(&rule, &ctx, &mut Budget::new()).unwrap();
            assert_eq!(hits.len(), 1, "{line}");
            assert_eq!(hits[0].label, "client/project", "{line}");
            assert_eq!(path_key(&hits[0].path), path_key(&format!("{slash}/client/project")));
        }
        for line in [
            "\"/Volumes/archive/Company Dropbox/work/client/project\"",
            "\"C:/elsewhere/work/client/project\"",
            "homework/client/project",
        ] {
            fs::write(&transcript, line).unwrap();
            assert!(scan(&rule, &ctx, &mut Budget::new()).unwrap().is_empty(), "{line}");
        }
        for suffix in ["", " now"] {
            fs::write(
                &transcript,
                format!("see the folder {slash}/client with spaces/project with spaces{suffix}"),
            ).unwrap();
            let hits = scan(&rule, &ctx, &mut Budget::new()).unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].label, "client with spaces/project with spaces");
        }
    }

    #[test]
    fn explicitly_delimited_missing_mentions_never_trim_to_shorter_directories() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = context(temp.path());
        let root = temp.path().join("Company Dropbox/work");
        fs::create_dir_all(root.join("client/project")).unwrap();
        let slash = root.to_string_lossy().replace('\\', "/");
        let transcript = temp.path().join("projects/session/log.jsonl");
        write_at(&transcript, ctx.now);
        let mut rule = fixture("session-mentions");
        rule.kind = RuleKind::SessionMentions {
            root: root.to_string_lossy().into(),
            depth: 2,
            depth_overrides: Vec::new(),
            min_mentions: 3,
        };
        for prefix in [slash.as_str(), "work"] {
            for (opening, ending) in [
                ("\"", "\""), ("'", "'"), ("", "|"), ("", "<"), ("", ">"),
                ("", "*"), ("", "?"), ("", ":"), ("", "\t"),
                ("", "/child"), ("", "\\child"),
            ] {
                let line = format!("{opening}{prefix}/client/project archive{ending}");
                fs::write(&transcript, format!("{line}\n{line}\n{line}")).unwrap();
                assert!(
                    scan(&rule, &ctx, &mut Budget::new()).unwrap().is_empty(),
                    "{line}"
                );
            }
        }
        for ending in ["", "\n", "\r", "\r\n"] {
            for (name, expected) in [("project now", 1), ("nothing here", 0)] {
                let line = format!("{slash}/client/{name}{ending}");
                fs::write(&transcript, format!("{line}\n{line}\n{line}")).unwrap();
                let hits = scan(&rule, &ctx, &mut Budget::new()).unwrap();
                assert_eq!(hits.len(), expected, "{line}");
                if expected == 1 {
                    assert_eq!(hits[0].label, "client/project");
                    assert_eq!(path_key(&hits[0].path), path_key(&format!("{slash}/client/project")));
                }
            }
        }
        fs::write(
            &transcript,
            format!(
                "{slash}/client/project\n{slash}/client/project\n\"{slash}/client/project archive\""
            ),
        ).unwrap();
        assert!(scan(&rule, &ctx, &mut Budget::new()).unwrap().is_empty());
    }

    #[test]
    fn prefix_windows_preserve_unc_and_cap_at_600_unicode_characters() {
        let root_key = path_key("//server/Company Dropbox/work");
        for prefix in [
            "see the folder //server/Company Dropbox/",
            r"see the folder \\\\server\\\\Company Dropbox\\\\",
        ] {
            assert!(absolute_root_matches(prefix, "work", &root_key, &mut Budget::new()));
        }
        assert!(!absolute_root_matches(
            "//other/Company Dropbox/", "work", &root_key, &mut Budget::new(),
        ));
        let spaced = "C:/Company\u{3000}Dropbox/";
        assert!(absolute_root_matches(
            &format!("look here {spaced}"), "work",
            &path_key(&format!("{spaced}work")), &mut Budget::new(),
        ));
        let within = format!("/{}/", "\u{65e5}".repeat(598));
        assert_eq!(within.chars().count(), 600);
        assert!(absolute_root_matches(
            &format!("{} {within}", "prose ".repeat(200)), "work",
            &path_key(&format!("{within}work")), &mut Budget::new(),
        ));
        let outside = format!("/{}/", "\u{65e5}".repeat(599));
        assert!(!absolute_root_matches(
            &outside, "work", &path_key(&format!("{outside}work")), &mut Budget::new(),
        ));
        for delimiter in ['"', '\'', '\u{60}', '<', '>', '|', '\t', '(', ')', '[', ']', '=', ',', ';'] {
            assert!(!absolute_root_matches(
                &format!("//server/{delimiter}Company Dropbox/"),
                "work", &root_key, &mut Budget::new(),
            ));
        }
    }

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
            &path_key(&work.to_string_lossy()),
            2,
            &[],
            &mut Budget::new()
        )
        .is_empty());
    }
}

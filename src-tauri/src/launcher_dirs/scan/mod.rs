pub mod budget;
pub mod folder_root;
pub mod git_parents;
pub mod session_cwd;
pub mod session_mentions;

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Instant, SystemTime},
};

use super::{
    model::{LauncherDirsDoc, Signal},
    paths::{normalize_path, path_key},
    rules::{Rule, RuleKind},
};
use budget::Budget;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanHit {
    pub path: String,
    pub label: String,
    pub signal: Signal,
    pub seen_at: String,
}

impl ScanHit {
    fn new(path: &Path, label: String, signal: Signal, time: SystemTime) -> Self {
        Self {
            path: normalize_path(&path.to_string_lossy()),
            label,
            signal,
            seen_at: chrono::DateTime::<chrono::Local>::from(time)
                .format("%Y-%m-%d")
                .to_string(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct RuleResult {
    pub rule_id: String,
    pub hits: Vec<ScanHit>,
    pub truncated: bool,
    pub error: Option<String>,
}

pub struct ScanOutcome {
    pub started_at: String,
    pub duration_ms: u64,
    pub results: Vec<RuleResult>,
    // A scan cannot apply obsolete results after another window edits its rule.
    pub rules: Vec<serde_json::Value>,
}

pub struct ScanContext {
    pub home: PathBuf,
    pub db_path: PathBuf,
    pub transcript_roots: Vec<PathBuf>,
    pub now: SystemTime,
}

pub fn run_all(doc: &LauncherDirsDoc) -> ScanOutcome {
    let home = dirs::home_dir().unwrap_or_default();
    let context = ScanContext {
        db_path: crate::ailog::db_path().unwrap_or_default(),
        transcript_roots: vec![
            home.join(".claude/projects"),
            home.join(".claude-codex/config/projects"),
        ],
        home,
        now: SystemTime::now(),
    };
    run_all_at(doc, &context)
}

pub fn run_all_at(doc: &LauncherDirsDoc, context: &ScanContext) -> ScanOutcome {
    let start = Instant::now();
    let mut outcome = ScanOutcome {
        started_at: super::model::now(),
        duration_ms: 0,
        results: Vec::new(),
        rules: doc.rules.clone(),
    };
    for rule in doc
        .rules
        .iter()
        .filter_map(Rule::from_value)
        .filter(|rule| rule.enabled)
    {
        let mut budget = Budget::new();
        let result = match &rule.kind {
            RuleKind::GitParents { .. } => git_parents::scan(&rule, context, &mut budget),
            RuleKind::FolderRoot { .. } => folder_root::scan(&rule, context, &mut budget),
            RuleKind::SessionCwd { .. } => session_cwd::scan(&rule, context, &mut budget),
            RuleKind::SessionMentions { .. } => session_mentions::scan(&rule, context, &mut budget),
        };
        let (hits, error) = match result {
            Ok(hits) => (finish_hits(hits, rule.max), None),
            Err(error) => (Vec::new(), Some(error)),
        };
        outcome.results.push(RuleResult {
            rule_id: rule.id,
            hits,
            truncated: budget.truncated,
            error,
        });
    }
    outcome.duration_ms = start.elapsed().as_millis() as u64;
    outcome
}

fn finish_hits(mut hits: Vec<ScanHit>, max: u32) -> Vec<ScanHit> {
    hits.sort_by(|a, b| b.seen_at.cmp(&a.seen_at).then_with(|| a.path.cmp(&b.path)));
    let mut keys = HashSet::new();
    hits.retain(|hit| !hit.label.trim().is_empty() && keys.insert(path_key(&hit.path)));
    hits.truncate(max as usize);
    hits
}

fn recent(time: SystemTime, context: &ScanContext, days: u32) -> bool {
    context
        .now
        .duration_since(time)
        .map_or(true, |age| age.as_secs() <= u64::from(days) * 86_400)
}

fn is_link(metadata: &fs::Metadata) -> bool {
    // Windows also classifies junctions as name-surrogate links. Cloud-file
    // reparse points are ordinary files/directories and must remain scannable.
    metadata.file_type().is_symlink()
}

// Check ancestors too: an explicitly supplied root can be inside a junction.
fn safe_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && !is_link(&meta))
        && path
            .ancestors()
            .filter(|path| !path.as_os_str().is_empty())
            .all(|path| fs::symlink_metadata(path).is_ok_and(|meta| !is_link(&meta)))
}

pub fn remove_orphans(doc: &mut LauncherDirsDoc) {
    let ids: HashSet<_> = doc
        .rules
        .iter()
        .filter_map(|value| value.get("id").and_then(serde_json::Value::as_str))
        .collect();
    doc.entries.retain(|entry| {
        entry.source == super::model::Source::Manual
            || entry.rule_id.as_deref().is_some_and(|id| {
                matches!(
                    id,
                    super::strings::LEGACY_DEV_RULE_ID | super::strings::LEGACY_ANKEN_RULE_ID
                ) || ids.contains(id)
            })
    });
}

fn available_rules(doc: &LauncherDirsDoc, outcome: &ScanOutcome) -> Vec<Rule> {
    doc.rules
        .iter()
        .filter(|value| outcome.rules.contains(value))
        .filter_map(Rule::from_value)
        .filter(|rule| rule.enabled)
        .collect()
}

pub fn apply(doc: &mut LauncherDirsDoc, outcome: &ScanOutcome, mru: &[String]) {
    use super::{
        model::{Candidate, CandidateSource, LastScan, LauncherDirEntry, ScanStats, Source},
        rules::Mode,
    };
    use std::collections::{BTreeMap, HashMap};

    remove_orphans(doc);
    let rules = available_rules(doc, outcome);
    let successful_auto: HashSet<_> = rules
        .iter()
        .filter(|rule| {
            rule.mode == Mode::Auto
                && outcome
                    .results
                    .iter()
                    .any(|result| result.rule_id == rule.id && result.error.is_none())
        })
        .map(|rule| rule.section.as_str())
        .collect();
    doc.entries.retain(|entry| {
        !(entry.source == Source::Auto
            && successful_auto.contains(entry.section.as_str())
            && matches!(
                entry.rule_id.as_deref(),
                Some(super::strings::LEGACY_DEV_RULE_ID | super::strings::LEGACY_ANKEN_RULE_ID)
            ))
    });
    let ignored: HashSet<_> = doc
        .ignored_paths
        .iter()
        .map(|path| path_key(path))
        .collect();
    let mut results = BTreeMap::new();
    for result in &outcome.results {
        let Some(rule) = rules.iter().find(|rule| rule.id == result.rule_id) else {
            continue;
        };
        results.insert(
            rule.id.clone(),
            ScanStats {
                count: result.hits.len(),
                truncated: result.truncated,
                error: result.error.clone(),
            },
        );
        if rule.mode != Mode::Auto || result.error.is_some() {
            continue;
        }
        let owns = |entry: &LauncherDirEntry| {
            entry.source == Source::Auto && entry.rule_id.as_deref() == Some(rule.id.as_str())
        };
        let blocked: HashSet<_> = doc
            .entries
            .iter()
            .filter(|entry| !owns(entry))
            .map(|entry| path_key(&entry.path))
            .chain(ignored.iter().cloned())
            .collect();
        let mut desired: HashMap<_, _> = result
            .hits
            .iter()
            .filter(|hit| !blocked.contains(&path_key(&hit.path)))
            .map(|hit| (path_key(&hit.path), hit))
            .collect();
        doc.entries.retain_mut(|entry| {
            if !owns(entry) {
                return true;
            }
            let Some(hit) = desired.remove(&path_key(&entry.path)) else {
                return false;
            };
            entry.section = rule.section.clone();
            entry.path = normalize_path(&hit.path);
            entry.label = hit.label.clone();
            entry.signal = Some(hit.signal.clone());
            entry.seen_at = Some(hit.seen_at.clone());
            true
        });
        for hit in &result.hits {
            if desired.remove(&path_key(&hit.path)).is_none() {
                continue;
            }
            let mut entry = LauncherDirEntry::manual(&rule.section, &hit.label, &hit.path);
            entry.source = Source::Auto;
            entry.rule_id = Some(rule.id.clone());
            entry.signal = Some(hit.signal.clone());
            entry.seen_at = Some(hit.seen_at.clone());
            doc.entries.push(entry);
        }
    }
    let blocked: HashSet<_> = doc
        .entries
        .iter()
        .map(|entry| path_key(&entry.path))
        .chain(ignored)
        .collect();
    let mut candidates: BTreeMap<String, Candidate> = BTreeMap::new();
    let priority = |candidate: &Candidate| {
        if candidate.source == CandidateSource::Mru {
            0
        } else {
            match candidate.signal {
                Signal::Mention => 4,
                Signal::Session => 3,
                Signal::Git => 2,
                Signal::Folder => 1,
            }
        }
    };
    let mut add = |candidate: Candidate| {
        let key = path_key(&candidate.path);
        if blocked.contains(&key) || candidate.label.trim().is_empty() {
            return;
        }
        if candidates.get(&key).is_none_or(|old| {
            (priority(&candidate), &candidate.seen_at) > (priority(old), &old.seen_at)
        }) {
            candidates.insert(key, candidate);
        }
    };
    for result in &outcome.results {
        let Some(rule) = rules.iter().find(|rule| rule.id == result.rule_id) else {
            continue;
        };
        if result.error.is_some()
            || (rule.mode != Mode::Suggest && !matches!(rule.kind, RuleKind::SessionCwd { .. }))
        {
            continue;
        }
        for hit in &result.hits {
            add(Candidate {
                path: normalize_path(&hit.path),
                label: hit.label.clone(),
                section: rule.section.clone(),
                signal: hit.signal.clone(),
                seen_at: Some(hit.seen_at.clone()),
                rule_id: Some(rule.id.clone()),
                source: CandidateSource::Rule,
            });
        }
    }
    for path in mru {
        if path.trim().is_empty() {
            continue;
        }
        add(Candidate {
            path: normalize_path(path),
            label: super::paths::folder_name(path),
            section: "dev".into(),
            signal: Signal::Session,
            seen_at: None,
            rule_id: None,
            source: CandidateSource::Mru,
        });
    }
    let mut candidates: Vec<_> = candidates.into_values().collect();
    candidates.sort_by(|a, b| {
        b.seen_at
            .cmp(&a.seen_at)
            .then_with(|| path_key(&a.path).cmp(&path_key(&b.path)))
    });
    let more = candidates.len().saturating_sub(30);
    candidates.truncate(30);
    let last_scan = LastScan {
        at: outcome.started_at.clone(),
        duration_ms: outcome.duration_ms,
        results,
        candidates,
        more,
    };
    doc.last_scan = Some(serde_json::to_value(last_scan).expect("scan serialization"));
}

// Mutations and external imports must remove candidates that just became entries.
pub fn prune_candidates(doc: &mut LauncherDirsDoc) {
    let Some(mut scan) = doc.scan_data() else {
        return;
    };
    let blocked: HashSet<_> = doc
        .entries
        .iter()
        .map(|entry| path_key(&entry.path))
        .chain(doc.ignored_paths.iter().map(|path| path_key(path)))
        .collect();
    let ids: HashSet<_> = doc
        .rules
        .iter()
        .filter_map(Rule::from_value)
        .filter(|rule| rule.enabled)
        .map(|rule| rule.id)
        .collect();
    scan.candidates.retain(|candidate| {
        !blocked.contains(&path_key(&candidate.path))
            && candidate.rule_id.as_ref().is_none_or(|id| ids.contains(id))
    });
    doc.last_scan = Some(serde_json::to_value(scan).expect("scan serialization"));
}

#[cfg(test)]
fn context(root: &Path) -> ScanContext {
    ScanContext {
        home: root.to_path_buf(),
        db_path: root.join("ailog.db"),
        transcript_roots: vec![root.join("projects")],
        now: SystemTime::now(),
    }
}

#[cfg(test)]
fn write_at(path: &Path, time: SystemTime) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, "test").unwrap();
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(time)
        .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launcher_dirs::{
        model::{CandidateSource, LauncherDirEntry, Source},
        rules::{fixture, Mode},
    };

    fn hit(path: &str, signal: Signal) -> ScanHit {
        ScanHit {
            path: path.into(),
            label: format!("New {}", super::super::paths::folder_name(path)),
            signal,
            seen_at: "2026-09-05".into(),
        }
    }

    fn automatic(path: &str, rule_id: &str) -> LauncherDirEntry {
        let mut entry = LauncherDirEntry::manual("dev", "Old", path);
        entry.source = Source::Auto;
        entry.rule_id = Some(rule_id.into());
        entry
    }

    fn outcome(doc: &LauncherDirsDoc, results: Vec<RuleResult>) -> ScanOutcome {
        ScanOutcome {
            started_at: "2026-09-05T12:00:00+09:00".into(),
            duration_ms: 42,
            results,
            rules: doc.rules.clone(),
        }
    }

    fn result(id: &str, hits: Vec<ScanHit>) -> RuleResult {
        RuleResult {
            rule_id: id.into(),
            hits,
            error: None,
            truncated: false,
        }
    }

    #[test]
    fn auto_replaces_own_rows_keeps_identity_and_protects_manual_ignored_and_other_rules() {
        let mut doc = LauncherDirsDoc::default();
        let mut rule = fixture("git-parents");
        rule.mode = Mode::Auto;
        rule.section = "anken".into();
        let mut other = rule.clone();
        other.id = "other".into();
        doc.rules = vec![
            rule.to_value(),
            other.to_value(),
            serde_json::json!({"id":"future","type":"new"}),
        ];
        let kept = automatic("C:/keep", "r1");
        let pinned = LauncherDirEntry::manual("dev", "Pinned", "C:/manual");
        let foreign = automatic("C:/other", "other");
        doc.entries = vec![
            kept.clone(),
            automatic("C:/stale", "r1"),
            pinned.clone(),
            foreign.clone(),
            automatic("C:/orphan", "deleted"),
            automatic("C:/future", "future"),
        ];
        doc.ignored_paths = vec!["C:/ignored".into()];
        let scan = outcome(
            &doc,
            vec![result(
                "r1",
                ["C:/keep", "C:/manual", "C:/other", "C:/ignored", "C:/new"]
                    .into_iter()
                    .map(|path| hit(path, Signal::Git))
                    .collect(),
            )],
        );
        apply(&mut doc, &scan, &[]);
        assert_eq!(doc.entries.len(), 5);
        let updated = doc
            .entries
            .iter()
            .find(|entry| entry.id == kept.id)
            .unwrap();
        assert_eq!(updated.added_at, kept.added_at);
        assert_eq!(
            (&updated.label, &updated.section),
            (&"New keep".to_string(), &"anken".to_string())
        );
        assert_eq!(updated.seen_at.as_deref(), Some("2026-09-05"));
        assert!(doc.entries.contains(&pinned));
        assert!(doc.entries.contains(&foreign));
        assert_eq!(doc.entries.last().unwrap().path, "C:/new");
        assert_eq!(doc.rules[2]["type"], "new");
    }

    #[test]
    fn legacy_is_replaced_only_after_successful_auto_and_errors_preserve_existing_entries() {
        let mut doc = LauncherDirsDoc::default();
        let mut rule = fixture("git-parents");
        doc.rules = vec![rule.to_value()];
        doc.entries = vec![automatic(
            "C:/legacy",
            super::super::strings::LEGACY_DEV_RULE_ID,
        )];
        let mut scan = outcome(
            &doc,
            vec![result("r1", vec![hit("C:/legacy", Signal::Git)])],
        );
        apply(&mut doc, &scan, &[]);
        assert_eq!(doc.entries[0].rule_id.as_deref(), Some("legacy-dev"));
        rule.mode = Mode::Auto;
        doc.rules[0] = rule.to_value();
        scan.rules = doc.rules.clone();
        scan.results[0].error = Some("offline".into());
        apply(&mut doc, &scan, &[]);
        assert_eq!(doc.entries[0].rule_id.as_deref(), Some("legacy-dev"));
        scan.results[0].error = None;
        apply(&mut doc, &scan, &[]);
        assert_eq!(doc.entries[0].rule_id.as_deref(), Some("r1"));
        scan.results[0].hits.clear();
        scan.results[0].error = Some("failed".into());
        apply(&mut doc, &scan, &[]);
        assert_eq!(doc.entries.len(), 1);
        scan.results[0].error = None;
        apply(&mut doc, &scan, &[]);
        assert!(doc.entries.is_empty());
    }

    #[test]
    fn candidates_merge_by_strength_then_date_filter_registered_and_cap_with_more() {
        let mut doc = LauncherDirsDoc::default();
        let mut results = Vec::new();
        for (id, signal) in [
            ("folder", Signal::Folder),
            ("git", Signal::Git),
            ("session", Signal::Session),
            ("mention", Signal::Mention),
        ] {
            let mut rule = fixture("session-cwd");
            rule.id = id.into();
            doc.rules.push(rule.to_value());
            results.push(result(id, vec![hit("C:/shared", signal)]));
        }
        results[3].hits[0].seen_at = "2026-08-01".into();
        results[0]
            .hits
            .extend((0..32).map(|i| hit(&format!("C:/item{i:02}"), Signal::Folder)));
        doc.entries
            .push(LauncherDirEntry::manual("dev", "Registered", "C:/item00"));
        doc.ignored_paths.push("C:/item01".into());
        let scan = outcome(&doc, results);
        apply(&mut doc, &scan, &["C:/shared".into(), "C:/mru".into()]);
        let data = doc.scan_data().unwrap();
        assert_eq!((data.candidates.len(), data.more), (30, 2));
        assert!(data
            .candidates
            .iter()
            .all(|candidate| !matches!(candidate.path.as_str(), "C:/item00" | "C:/item01")));
        let mut smaller = scan;
        smaller.results[0].hits.truncate(1);
        apply(&mut doc, &smaller, &["C:/shared".into(), "C:/mru".into()]);
        let data = doc.scan_data().unwrap();
        assert_eq!(data.candidates[0].signal, Signal::Mention);
        assert_eq!(data.candidates[0].seen_at.as_deref(), Some("2026-08-01"));
        assert_eq!(data.candidates[1].source, CandidateSource::Mru);
        assert_eq!(data.candidates[1].seen_at, None);
        assert_eq!(data.candidates[1].rule_id, None);
    }

    #[test]
    fn changed_or_deleted_rules_cannot_apply_stale_results() {
        let mut doc = LauncherDirsDoc::default();
        let mut rule = fixture("git-parents");
        rule.mode = Mode::Auto;
        doc.rules = vec![rule.to_value()];
        let scan = outcome(&doc, vec![result("r1", vec![hit("C:/late", Signal::Git)])]);
        doc.set_rule_mode("r1", "suggest").unwrap();
        apply(&mut doc, &scan, &[]);
        assert!(doc.entries.is_empty());
        assert!(doc.scan_data().unwrap().candidates.is_empty());
        doc.delete_rule("r1");
        apply(&mut doc, &scan, &[]);
        assert!(doc.entries.is_empty());
        assert!(doc.scan_data().unwrap().results.is_empty());
    }

    #[test]
    fn rule_mutations_validate_paths_preserve_unknowns_and_register_labels_as_manual() {
        let root = tempfile::tempdir().unwrap();
        let mut doc = LauncherDirsDoc::default();
        let mut rule = fixture("folder-root").to_value();
        rule["id"] = serde_json::json!("");
        rule["mode"] = serde_json::json!("auto");
        rule["root"] = serde_json::json!(root.path().to_string_lossy());
        doc.rules
            .push(serde_json::json!({"id":"unknown","type":"future","keep":42}));
        doc.upsert_rule(&rule).unwrap();
        let id = doc.rules[1]["id"].as_str().unwrap().to_string();
        assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 4);
        doc.entries = vec![
            automatic("C:/auto", &id),
            LauncherDirEntry::manual("dev", "Pinned", "C:/pinned"),
        ];
        doc.set_rule_enabled(&id, false).unwrap();
        assert_eq!(doc.entries.len(), 2);
        doc.set_rule_enabled(&id, true).unwrap();
        doc.set_rule_mode(&id, "suggest").unwrap();
        assert_eq!(doc.entries.len(), 1);
        assert!(doc.set_rule_mode(&id, "wrong").is_err());
        assert!(doc.set_rule_enabled("unknown", true).is_err());
        let path = root.path().to_string_lossy().into_owned();
        let scan = outcome(&doc, vec![result(&id, vec![hit(&path, Signal::Folder)])]);
        apply(&mut doc, &scan, &[]);
        doc.register_candidate("anken", &path).unwrap();
        prune_candidates(&mut doc);
        assert_eq!(doc.entries[1].source, Source::Manual);
        assert_eq!(doc.entries[1].label, hit(&path, Signal::Folder).label);
        assert!(doc.scan_data().unwrap().candidates.is_empty());
        doc.entries.push(automatic("C:/orphan", "deleted"));
        doc.delete_rule(&id);
        assert_eq!(doc.entries.len(), 2);
        assert_eq!(
            doc.rules,
            vec![serde_json::json!({"id":"unknown","type":"future","keep":42})]
        );
        rule["root"] = serde_json::json!(root.path().join("missing").to_string_lossy());
        assert!(doc
            .upsert_rule(&rule)
            .unwrap_err()
            .starts_with("not a directory:"));
    }

    #[test]
    fn errors_are_isolated_and_disabled_unknown_rules_are_skipped() {
        let root = tempfile::tempdir().unwrap();
        let context = context(root.path());
        let mut missing = super::super::rules::fixture("session-cwd");
        missing.kind = RuleKind::SessionCwd {
            root: None,
            min_sessions: 1,
        };
        let mut git = super::super::rules::fixture("git-parents");
        git.id = "git".into();
        git.kind = RuleKind::GitParents {
            parents: vec![root.path().to_string_lossy().into()],
            exclude: Default::default(),
        };
        write_at(&root.path().join("repo/.git/index"), context.now);
        let mut disabled = git.clone();
        disabled.id = "disabled".into();
        disabled.enabled = false;
        let mut doc = LauncherDirsDoc::default();
        doc.rules = vec![
            missing.to_value(),
            git.to_value(),
            disabled.to_value(),
            serde_json::json!({"type":"future"}),
        ];
        let result = run_all_at(&doc, &context);
        assert_eq!(result.results.len(), 2);
        assert!(result.results[0].error.is_some());
        assert_eq!(result.results[1].hits.len(), 1);
        assert!(!context.db_path.exists());
    }

    #[test]
    fn finalization_deduplicates_orders_and_limits_hits() {
        let hit = |path: &str, label: &str, day: &str| ScanHit {
            path: path.into(),
            label: label.into(),
            signal: Signal::Git,
            seen_at: day.into(),
        };
        let result = finish_hits(
            vec![
                hit("C:/old", "old", "2026-01-01"),
                hit("C:/new/", "new", "2026-09-01"),
                hit("C:/new", "new", "2026-08-01"),
                hit("C:/empty", " ", "2026-09-02"),
            ],
            1,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].label, "new");
    }
}

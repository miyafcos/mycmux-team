use super::{chunk, message_text, records, valid_session, Evidence, TitleRequest};
use std::path::{Path, PathBuf};
fn find(root: &Path, suffix: &str, depth: usize) -> Option<PathBuf> {
    if !crate::agent_home_roots::record_path_allowed(root) { return None; }
    let mut entries: Vec<_> = std::fs::read_dir(root).ok()?.flatten().collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    for entry in entries {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() || !crate::agent_home_roots::record_path_allowed(&entry.path()) {
            continue;
        }
        if kind.is_file() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("rollout-") && name.ends_with(suffix) {
                return Some(entry.path());
            }
        } else if kind.is_dir() && depth < 3 {
            if let Some(path) = find(&entry.path(), suffix, depth + 1) {
                return Some(path);
            }
        }
    }
    None
}
pub(super) fn locate_result(request: &TitleRequest) -> Result<Option<PathBuf>, String> {
    let Some(session) = request.agent_session_id.as_deref().filter(|id| valid_session(id)) else { return Ok(None); };
    let roots = if request.tab_id.is_empty() { crate::agent_home_roots::all(crate::cli_accounts::CliProvider::Codex) }
        else { crate::agent_home_roots::for_tab(crate::cli_accounts::CliProvider::Codex, &request.tab_id)? };
    locate_in_roots(&roots, session)
}
pub(super) fn locate_in_roots(roots: &[crate::agent_home_roots::RecordRoot], session: &str) -> Result<Option<PathBuf>, String> {
    crate::agent_home_roots::find_unique_with_global(roots, crate::cli_accounts::CliProvider::Codex, session,
        |root| find(root, &format!("-{session}.jsonl"), 0).into_iter().collect(),
        |_, _| false).map(|found| found.map(|(_,path)|path))
}
pub(super) fn locate(request: &TitleRequest) -> Option<PathBuf> { locate_result(request).ok().flatten() }
pub(super) fn read(path: &Path) -> Evidence {
    let head = chunk(path, 4 * 1024 * 1024, false).unwrap_or_default();
    let prompt = records(&head)
        .filter(|r| r["type"] == "response_item" && r["payload"]["role"] == "user")
        .filter_map(|r| message_text(&r["payload"]))
        .find(|s| !s.starts_with("# AGENTS.md") && !s.starts_with('<'));
    Evidence {
        title: None,
        prompt,
    }
}

#[cfg(test)]
mod account_home_agent_titles_tests {
    use super::*;
    use crate::{agent_home_roots::{self,Origin,RecordRoot},cli_accounts::{account_homes,CliProvider}};
    #[test]
    fn tab_title_evidence_uses_only_its_home_even_for_identical_ids_and_cwd() {
        let dir=tempfile::tempdir().unwrap();let id="11111111-1111-4111-8111-111111111111";
        for (name,text) in [("global","global prompt"),("A","home A prompt"),("B","home B prompt")] {
            let root=dir.path().join(name).join("sessions");std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join(format!("rollout-{id}.jsonl")),format!("{}\n{}\n",serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":"/same/cwd"}}),serde_json::json!({"type":"response_item","payload":{"role":"user","content":[{"text":text}]}}))).unwrap();
        }
        let global=vec![RecordRoot {origin:Origin::Global,path:dir.path().join("global/sessions")}];
        let roots=agent_home_roots::select_session_roots(CliProvider::Codex,global.clone(),true,||Ok(Some(account_homes::test_context(CliProvider::Codex,dir.path().join("A"))))).unwrap();
        assert_eq!(read(&locate_in_roots(&roots,id).unwrap().unwrap()).prompt.as_deref(),Some("home A prompt"));
        assert_eq!(read(&locate_in_roots(&global,id).unwrap().unwrap()).prompt.as_deref(),Some("global prompt"));
        let all=[global,roots].concat();assert_eq!(locate_in_roots(&all,id).unwrap_err(),agent_home_roots::AMBIGUOUS);
    }
}

#[cfg(all(test, unix))]
mod fix2b1_link_tests {
    use super::*;
    use crate::agent_home_roots::link_tests::{Fixture,LinkMode,MODES,ID,PROMPT};
    #[test]
    fn fix2b1_agent_titles_global_links_keep_the_legacy_file_type_walk() {
        for mode in MODES {
            let f=Fixture::new(mode);let found=locate_in_roots(&[f.root],ID).unwrap();
            assert_eq!(found.is_some(),mode!=LinkMode::Nested,"{mode:?}");
            if let Some(path)=found {assert_eq!(read(&path).prompt.as_deref(),Some(PROMPT));}
        }
    }
}

#[cfg(test)]
mod fixr_r05_title_tests {
    use super::*;
    use crate::agent_home_roots::{Origin, RecordRoot};
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    fn put(path: &Path, prompt: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("{}\n", serde_json::json!({"type":"response_item","payload":{"role":"user","content":[{"text":prompt}]}}))).unwrap();
    }
    #[test]
    fn fixr_r05_global_titles_keep_base_reverse_walk_and_archive_fallback() {
        for scenario in ["sessions-and-archive", "two-sessions", "mirrored-then-archived"] {
            let dir = tempfile::tempdir().unwrap();
            let roots: Vec<_> = ["sessions", "archived_sessions"].iter().map(|name| RecordRoot {
                origin: Origin::Global, path: dir.path().join(".codex").join(name),
            }).collect();
            let first = roots[0].path.join(format!("2026/11/12/rollout-z-{ID}.jsonl"));
            put(&first, "base reverse-order winner");
            let expected = match scenario {
                "sessions-and-archive" => {
                    put(&roots[1].path.join(format!("rollout-zz-{ID}.jsonl")), "archive duplicate");
                    first.clone()
                }
                "two-sessions" => {
                    put(&roots[0].path.join(format!("2026/11/12/rollout-a-{ID}.jsonl")), "other duplicate");
                    first.clone()
                }
                _ => {
                    let archived = roots[1].path.join(format!("2026/11/12/rollout-z-{ID}.jsonl"));
                    std::fs::create_dir_all(archived.parent().unwrap()).unwrap();
                    put(&dir.path().join(format!("mirror/codex/rollout-z-{ID}.jsonl")), "mirror is outside title roots");
                    std::fs::rename(&first, &archived).unwrap();
                    archived
                }
            };
            assert_eq!(locate_in_roots(&roots, ID).unwrap(), Some(expected.clone()), "{scenario}");
            assert_eq!(read(&expected).prompt.as_deref(), Some("base reverse-order winner"));
        }
    }
}

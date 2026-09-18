//! The session index behind 続きから (launcher) and Ctrl+P.
//!
//! Built in-process from the vendored `crsm-core` crate (see
//! `crates/crsm-core/VENDOR.md`) rather than by running the `crsm` CLI. A macOS
//! GUI app inherits launchd's minimal PATH, so the binary was never found no
//! matter where it was installed, and both lists were permanently empty there.

use crsm_core::cache::cache_path;
use crsm_core::path_norm::home_dir;
use crsm_core::sessions::CACHE_FRESH_TTL_SECS;
use crsm_core::{
    create_handoff_file, list_all_sessions, rank_sessions, AgentKind, HandoffRequest, ListOptions,
    SessionEntry,
};
use serde_json::Value;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

/// What the palette asks for when it does not say; kept here so a caller that
/// omits `limit` gets the same page as before.
const DEFAULT_LIST_LIMIT: usize = 200;
const DEFAULT_RECENT_TURNS: usize = 20;

const CACHE_FRESH_TTL: Duration = Duration::from_secs(CACHE_FRESH_TTL_SECS as u64);

/// Held while a rescan is running. crsm-core's own detached-child refresh is
/// compiled out here, so mycmux decides when to rebuild the cache — and a
/// rescan walks every transcript, which is pointless to do twice at once.
static REFRESH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct RefreshSlot;

impl Drop for RefreshSlot {
    fn drop(&mut self) {
        REFRESH_IN_FLIGHT.store(false, Ordering::Release);
    }
}

/// `Some` when the caller took the single refresh slot, `None` while another
/// rescan still holds it. Dropping the guard hands the slot back, including
/// when the rescan panics.
fn claim_refresh_slot() -> Option<RefreshSlot> {
    REFRESH_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| RefreshSlot)
}

/// How long ago the cache was written, or `None` when there is no cache to
/// serve — the next list call then scans in the foreground and writes one, so
/// there is nothing to refresh behind it.
fn cache_age(now: SystemTime) -> Option<Duration> {
    let home = home_dir()?;
    let modified = cache_path(&home).metadata().ok()?.modified().ok()?;
    now.duration_since(modified).ok()
}

fn cache_is_stale(age: Option<Duration>) -> bool {
    age.is_some_and(|age| age >= CACHE_FRESH_TTL)
}

/// Rebuild the cache on the blocking pool so the *next* call is fresh. The
/// caller has already been handed the stale list: a rescan takes seconds and
/// the list is a shortcut, not a source of truth.
fn spawn_cache_refresh() {
    let Some(slot) = claim_refresh_slot() else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        if let Err(error) = list_all_sessions(&ListOptions {
            refresh: true,
            use_cache: true,
        }) {
            eprintln!("[crsm] background session refresh failed: {error}");
        }
    });
}

/// The same order `crsm list` applies: drop what nobody typed into, then either
/// rank against the query or take the most recent. `--all` has no caller here,
/// so headless and handoff sessions stay hidden.
fn select_sessions(
    mut sessions: Vec<SessionEntry>,
    query: Option<&str>,
    limit: usize,
) -> Vec<SessionEntry> {
    sessions.retain(|entry| entry.has_user_messages);
    match query {
        Some(query) => rank_sessions(&sessions, query, limit),
        None => sessions.into_iter().take(limit).collect(),
    }
}

fn list_sessions_blocking(
    query: Option<String>,
    limit: usize,
    refresh: bool,
) -> Result<Value, String> {
    let sessions = list_all_sessions(&ListOptions {
        refresh,
        use_cache: true,
    })
    .map_err(|error| error.to_string())?;
    serde_json::to_value(select_sessions(sessions, query.as_deref(), limit))
        .map_err(|error| format!("serialize crsm sessions: {error}"))
}

/// crsm's own spelling, the one the CLI accepts for `--from` / `--target`.
/// "grok" reaches here from the palette's kind union and has no transcript
/// format, so it comes back named in the error rather than silently ignored.
fn parse_agent_kind(value: &str) -> Result<AgentKind, String> {
    AgentKind::from_str(value.trim())
}

#[tauri::command]
pub async fn crsm_list_sessions(
    query: Option<String>,
    limit: Option<usize>,
    refresh: Option<bool>,
) -> Result<Value, String> {
    let refresh = refresh.unwrap_or(false);
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT);
    let query = query.filter(|value| !value.trim().is_empty());
    let sessions = crate::util::task::run_blocking("crsm list", move || {
        list_sessions_blocking(query, limit, refresh)
    })
    .await?;
    // Checked after the answer is in hand: a foreground scan (no cache yet, or
    // refresh asked for) has just written a fresh one, and then there is
    // nothing to do.
    if !refresh && cache_is_stale(cache_age(SystemTime::now())) {
        spawn_cache_refresh();
    }
    Ok(sessions)
}

#[tauri::command]
pub async fn crsm_create_handoff(
    session_id: String,
    from_kind: Option<String>,
    target_kind: String,
    recent_turns: Option<usize>,
) -> Result<Value, String> {
    let from_kind = match from_kind.filter(|value| !value.trim().is_empty()) {
        Some(value) => Some(parse_agent_kind(&value)?),
        None => None,
    };
    let target_kind = parse_agent_kind(&target_kind)?;
    let recent_turns = recent_turns.unwrap_or(DEFAULT_RECENT_TURNS);
    crate::util::task::run_blocking("crsm handoff", move || {
        let result = create_handoff_file(&HandoffRequest {
            session_id,
            from_kind,
            target_kind,
            recent_turns,
        })
        .map_err(|error| error.to_string())?;
        serde_json::to_value(result).map_err(|error| format!("serialize crsm handoff: {error}"))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration as ChronoDuration, Utc};
    use std::path::PathBuf;

    fn entry(id: &str, cwd: &str, minutes_ago: i64, has_user_messages: bool) -> SessionEntry {
        SessionEntry {
            kind: AgentKind::Claude,
            id: id.to_string(),
            cwd: cwd.to_string(),
            label: format!("{id} opening prompt"),
            preview: String::new(),
            last_activity: Utc::now() - ChronoDuration::minutes(minutes_ago),
            started_at: None,
            source: "test".to_string(),
            source_path: PathBuf::from("test.jsonl"),
            transcript_path: None,
            summary_file: None,
            files_modified: Vec::new(),
            incomplete_tasks: Vec::new(),
            has_user_messages,
        }
    }

    fn ids(entries: &[SessionEntry]) -> Vec<String> {
        entries.iter().map(|entry| entry.id.clone()).collect()
    }

    #[test]
    fn sessions_nobody_typed_into_stay_out_of_the_list() {
        let sessions = vec![
            entry("typed", "C:/work/alpha", 1, true),
            entry("headless", "C:/work/bravo", 2, false),
        ];
        assert_eq!(ids(&select_sessions(sessions, None, 10)), ["typed"]);
    }

    #[test]
    fn a_query_ranks_instead_of_taking_the_most_recent() {
        let sessions = vec![
            entry("alpha", "C:/work/alpha", 1, true),
            entry("bravo", "C:/work/bravo", 2, true),
            entry("charlie", "C:/work/charlie", 3, true),
        ];
        // Without ranking this would answer alpha (the newest); the query has to
        // reach rank_sessions for bravo to win and the rest to drop out.
        assert_eq!(ids(&select_sessions(sessions, Some("bravo"), 10)), ["bravo"]);
    }

    #[test]
    fn an_empty_list_takes_the_newest_up_to_the_limit() {
        let sessions = vec![
            entry("alpha", "C:/work/alpha", 1, true),
            entry("bravo", "C:/work/bravo", 2, true),
            entry("charlie", "C:/work/charlie", 3, true),
        ];
        assert_eq!(
            ids(&select_sessions(sessions, None, 2)),
            ["alpha", "bravo"]
        );
    }

    /// The frontend reads these field names straight off the command's reply
    /// (`CrsmSessionEntry` in src/lib/ipc.ts), and they are what `crsm list
    /// --json` prints.
    #[test]
    fn entries_serialise_with_the_cli_field_names() {
        let value = serde_json::to_value(vec![entry("alpha", "C:/work/alpha", 1, true)])
            .expect("serialize entries");
        let first = value[0].as_object().expect("entry object");
        let mut keys = first.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "cwd",
                "files_modified",
                "has_user_messages",
                "id",
                "incomplete_tasks",
                "kind",
                "label",
                "last_activity",
                "preview",
                "source",
                "source_path",
                "started_at",
                "summary_file",
                "transcript_path",
            ]
        );
        assert_eq!(first["kind"], serde_json::json!("claude"));
        assert!(first["last_activity"].is_string());
    }

    /// Same contract on the handoff side: `CrsmHandoffResult` in src/lib/ipc.ts
    /// reads these names, and they are what `crsm handoff --json` prints.
    /// crsm-core's own smoke test covers the file this result points at.
    #[test]
    fn handoff_results_serialise_with_the_cli_field_names() {
        let value = serde_json::to_value(crsm_core::HandoffResult {
            path: PathBuf::from("C:/Users/test/.crsm/handoff/20260917T000000Z-claude-to-codex.md"),
            bootstrap_prompt: "Handoff from previous session.".to_string(),
            from_kind: AgentKind::Claude,
            target_kind: AgentKind::Codex,
            from_session_id: "session-a".to_string(),
            cwd: "C:/work/alpha".to_string(),
        })
        .expect("serialize handoff result");
        let result = value.as_object().expect("handoff object");
        let mut keys = result.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "bootstrap_prompt",
                "cwd",
                "from_kind",
                "from_session_id",
                "path",
                "target_kind",
            ]
        );
        assert_eq!(result["from_kind"], serde_json::json!("claude"));
        assert_eq!(result["target_kind"], serde_json::json!("codex"));
    }

    #[test]
    fn a_fresh_cache_is_not_rescanned() {
        assert!(!cache_is_stale(Some(Duration::from_secs(0))));
        assert!(!cache_is_stale(Some(CACHE_FRESH_TTL - Duration::from_secs(1))));
        // No cache file: the next list call builds one in the foreground, so a
        // background rescan on top of it would be wasted work.
        assert!(!cache_is_stale(None));
        assert!(cache_is_stale(Some(CACHE_FRESH_TTL)));
        assert!(cache_is_stale(Some(CACHE_FRESH_TTL + Duration::from_secs(30))));
    }

    #[test]
    fn only_one_background_refresh_runs_at_a_time() {
        let first = claim_refresh_slot().expect("first caller takes the slot");
        assert!(
            claim_refresh_slot().is_none(),
            "a second rescan must not start while the first holds the slot"
        );
        drop(first);
        assert!(
            claim_refresh_slot().is_some(),
            "the slot is free again once the rescan finishes"
        );
    }

    #[test]
    fn agent_kinds_use_the_cli_spelling() {
        assert_eq!(parse_agent_kind("claude"), Ok(AgentKind::Claude));
        assert_eq!(parse_agent_kind("codex"), Ok(AgentKind::Codex));
        assert_eq!(parse_agent_kind(" claude-codex "), Ok(AgentKind::ClaudeCodex));
        assert_eq!(
            parse_agent_kind("grok"),
            Err("unknown agent kind: grok".to_string())
        );
    }
}

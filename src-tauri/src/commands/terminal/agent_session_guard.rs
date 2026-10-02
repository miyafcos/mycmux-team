use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::pty::monitor::session_id_from_args;

use super::{command_leaf, sanitize_launch_env};

const CONFLICT_PREFIX: &str = "AGENT_SESSION_ALREADY_RUNNING:";

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct Conversation {
    pub kind: String,
    pub agent_session_id: String,
}

impl Conversation {
    pub fn new(kind: &str, agent_session_id: &str) -> Option<Self> {
        let kind = kind.to_ascii_lowercase();
        if !crate::commands::session_mapping::is_agent_session_kind(&kind)
            || agent_session_id.trim().is_empty()
        {
            return None;
        }
        Some(Self {
            kind,
            agent_session_id: agent_session_id.to_string(),
        })
    }
}

/// Pure extraction; use exactly the same env sanitization and argv parser as launch.
pub(super) fn requested_conversation(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Option<Conversation> {
    if env
        .get("MYCMUX_RESUME_FORK")
        .is_some_and(|value| value == "1")
        || args
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("--fork-session"))
    {
        return None;
    }
    let mut sanitized = env.clone();
    sanitize_launch_env(&mut sanitized);
    if let Some(kind) = sanitized.get("MYCMUX_RESUME") {
        if let Some(id) = sanitized.get("MYCMUX_SESSION_ID") {
            if let Some(request) = Conversation::new(kind, id) {
                return Some(request);
            }
        }
    }
    // Lowercase before stripping extensions, including Windows .EXE/.CMD leaves.
    let lower_command = command.to_ascii_lowercase();
    let leaf = command_leaf(&lower_command);
    if !crate::commands::session_mapping::is_agent_session_kind(leaf) {
        return None;
    }
    let id = session_id_from_args(args, leaf == "codex")?;
    let kind = sanitized
        .get("MYCMUX_AGENT_KIND")
        .map(String::as_str)
        .unwrap_or(leaf);
    Conversation::new(kind, &id)
}

pub(super) struct Owner {
    pub session_id: String,
    pub conversation: Conversation,
    pub is_running: bool,
}

pub(super) fn metadata_conversation(
    kind: Option<&str>,
    agent_id: Option<&str>,
    claude_id: Option<&str>,
) -> Option<Conversation> {
    match kind {
        Some(kind) => {
            let id = agent_id.filter(|id| !id.trim().is_empty()).or_else(|| {
                if kind.eq_ignore_ascii_case("claude") {
                    claude_id
                } else {
                    None
                }
            })?;
            Conversation::new(kind, id)
        }
        None => Conversation::new("claude", claude_id?),
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Conflict {
    kind: String,
    agent_session_id: String,
    owner_session_id: String,
}

type ClaimTable = Mutex<HashMap<Conversation, String>>;
static LAUNCH_CLAIMS: OnceLock<ClaimTable> = OnceLock::new();

/// Pure decision over a PTY snapshot and the claims held by pending creates.
fn find_conflict(
    request: &Conversation,
    requester: &str,
    owners: &[Owner],
    claims: &HashMap<Conversation, String>,
) -> Option<Conflict> {
    let owner = owners
        .iter()
        .find(|owner| {
            owner.is_running && owner.session_id != requester && owner.conversation == *request
        })
        .map(|owner| &owner.session_id)
        .or_else(|| claims.get(request).filter(|id| id.as_str() != requester))?;
    Some(Conflict {
        kind: request.kind.clone(),
        agent_session_id: request.agent_session_id.clone(),
        owner_session_id: owner.clone(),
    })
}

/// The table lock covers the live-owner check and claim insertion together.
/// The RAII claim survives all launch work and is released on every return path.
pub(super) struct LaunchClaim<'a> {
    table: &'a ClaimTable,
    conversation: Conversation,
    owns_claim: bool,
}

impl LaunchClaim<'static> {
    pub fn acquire(
        request: Conversation,
        requester: &str,
        owners: impl FnOnce() -> Vec<Owner>,
    ) -> Result<Self, String> {
        acquire_claim(
            LAUNCH_CLAIMS.get_or_init(|| Mutex::new(HashMap::new())),
            request,
            requester,
            owners,
        )
    }
}

fn acquire_claim<'a>(
    table: &'a ClaimTable,
    request: Conversation,
    requester: &str,
    owners: impl FnOnce() -> Vec<Owner>,
) -> Result<LaunchClaim<'a>, String> {
    let mut claims = table
        .lock()
        .map_err(|error| format!("Failed to lock launch claims: {error}"))?;
    if let Some(conflict) = find_conflict(&request, requester, &owners(), &claims) {
        return Err(format!(
            "{CONFLICT_PREFIX}{}",
            serde_json::to_string(&conflict).unwrap()
        ));
    }
    let owns_claim = !claims.contains_key(&request);
    if owns_claim {
        claims.insert(request.clone(), requester.to_string());
    }
    Ok(LaunchClaim {
        table,
        conversation: request,
        owns_claim,
    })
}

impl Drop for LaunchClaim<'_> {
    fn drop(&mut self) {
        if self.owns_claim {
            self.table
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.conversation);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT_ID: &str = "11111111-2222-3333-4444-555555555555";

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn resume_env(kind: &str) -> HashMap<String, String> {
        HashMap::from([
            ("MYCMUX_RESUME".to_string(), kind.to_string()),
            ("MYCMUX_SESSION_ID".to_string(), AGENT_ID.to_string()),
        ])
    }

    fn request(kind: &str) -> Conversation {
        Conversation::new(kind, AGENT_ID).unwrap()
    }

    #[test]
    fn extracts_only_legitimate_resume_env_and_excludes_env_forks() {
        for kind in ["claude", "codex", "grok", "claude-codex"] {
            let mut env = resume_env(kind);
            assert_eq!(
                requested_conversation("bash", &[], &env),
                Some(request(kind))
            );
            env.insert("MYCMUX_RESUME_FORK".to_string(), "1".to_string());
            assert_eq!(requested_conversation("bash", &[], &env), None);
        }
        let mut env = resume_env("1");
        assert_eq!(requested_conversation("bash", &[], &env), None);
        env.insert("MYCMUX_RESUME".to_string(), "claude".to_string());
        env.insert("MYCMUX_SESSION_ID".to_string(), "  ".to_string());
        assert_eq!(requested_conversation("bash", &[], &env), None);
        env.remove("MYCMUX_SESSION_ID");
        assert_eq!(requested_conversation("bash", &[], &env), None);
        assert_eq!(requested_conversation("codex", &[], &HashMap::new()), None);
    }

    #[test]
    fn reuses_argv_parser_for_agent_leaves_and_excludes_all_fork_args() {
        for (command, kind) in [
            (r"C:\tools\CLAUDE.EXE", "claude"),
            ("/bin/CODEX", "codex"),
            ("grok.cmd", "grok"),
            ("claude-codex", "claude-codex"),
        ] {
            let argv = args(&["--resume", AGENT_ID]);
            assert_eq!(
                requested_conversation(command, &argv, &HashMap::new()),
                Some(request(kind))
            );
            let mut fork = argv;
            fork.extend(args(&["--session-id", AGENT_ID, "--fork-session"]));
            assert_eq!(
                requested_conversation(command, &fork, &HashMap::new()),
                None
            );
        }
        let positional = args(&["resume", AGENT_ID]);
        assert_eq!(
            requested_conversation("codex", &positional, &HashMap::new()),
            Some(request("codex"))
        );
        assert_eq!(
            requested_conversation("claude", &positional, &HashMap::new()),
            None
        );
        assert_eq!(
            requested_conversation("bash", &args(&["--resume", AGENT_ID]), &HashMap::new()),
            None
        );
        assert_eq!(
            requested_conversation("codex", &args(&["resume", "--last"]), &HashMap::new()),
            None
        );
        assert_eq!(
            requested_conversation(
                "claude",
                &args(&["--session-id", AGENT_ID]),
                &HashMap::new()
            ),
            Some(request("claude"))
        );
    }

    #[test]
    fn env_identity_has_priority_and_agent_kind_can_distinguish_hybrid() {
        assert_eq!(
            requested_conversation(
                "codex",
                &args(&["resume", AGENT_ID]),
                &resume_env("claude-codex")
            ),
            Some(request("claude-codex"))
        );
        let mut env = resume_env("claude-codex");
        env.remove("MYCMUX_RESUME");
        env.insert("MYCMUX_AGENT_KIND".to_string(), "claude-codex".to_string());
        assert_eq!(
            requested_conversation("claude", &args(&["--resume", AGENT_ID]), &env),
            Some(request("claude-codex"))
        );
    }

    #[test]
    fn owners_must_be_live_other_ptys_with_the_same_kind_and_id() {
        let mut owner = Owner {
            session_id: "owner".to_string(),
            conversation: request("CoDeX"),
            is_running: true,
        };
        let claims = HashMap::new();
        assert_eq!(
            find_conflict(
                &request("codex"),
                "requester",
                std::slice::from_ref(&owner),
                &claims
            )
            .unwrap()
            .owner_session_id,
            "owner"
        );
        assert!(find_conflict(
            &request("codex"),
            "owner",
            std::slice::from_ref(&owner),
            &claims
        )
        .is_none());
        assert!(find_conflict(
            &request("claude"),
            "requester",
            std::slice::from_ref(&owner),
            &claims
        )
        .is_none());
        owner.conversation = request("claude-codex");
        assert!(find_conflict(
            &request("claude"),
            "requester",
            std::slice::from_ref(&owner),
            &claims
        )
        .is_none());
        owner.conversation = Conversation::new("codex", "another-id").unwrap();
        assert!(find_conflict(
            &request("codex"),
            "requester",
            std::slice::from_ref(&owner),
            &claims
        )
        .is_none());
        owner.conversation = request("codex");
        owner.is_running = false;
        assert!(find_conflict(&request("codex"), "requester", &[owner], &claims).is_none());
        assert!(find_conflict(&request("codex"), "requester", &[], &claims).is_none());
    }

    #[test]
    fn launch_claim_blocks_second_create_and_preserves_own_id_reattach() {
        let table = Mutex::new(HashMap::new());
        let first = acquire_claim(&table, request("codex"), "first", Vec::new).unwrap();
        let error = acquire_claim(&table, request("CODEX"), "second", Vec::new)
            .err()
            .unwrap();
        assert_eq!(error, format!("{CONFLICT_PREFIX}{{\"kind\":\"codex\",\"agentSessionId\":\"{AGENT_ID}\",\"ownerSessionId\":\"first\"}}"));
        drop(acquire_claim(&table, request("codex"), "first", Vec::new).unwrap());
        assert_eq!(table.lock().unwrap().len(), 1);
        drop(first);
        assert!(table.lock().unwrap().is_empty());
        assert!(acquire_claim(&table, request("codex"), "second", Vec::new).is_ok());
    }

    #[test]
    fn metadata_uses_tagged_ids_and_only_claude_has_the_legacy_fallback() {
        assert_eq!(
            metadata_conversation(Some("CODEX"), Some(AGENT_ID), Some("stale-claude")),
            Some(request("codex"))
        );
        assert_eq!(
            metadata_conversation(Some("CLAUDE"), None, Some(AGENT_ID)),
            Some(request("claude"))
        );
        assert_eq!(
            metadata_conversation(None, None, Some(AGENT_ID)),
            Some(request("claude"))
        );
        assert_eq!(
            metadata_conversation(Some("claude"), Some(""), Some(AGENT_ID)),
            Some(request("claude"))
        );
        assert_eq!(
            metadata_conversation(Some("claude-codex"), None, Some(AGENT_ID)),
            None
        );
        assert_eq!(
            metadata_conversation(Some("codex"), None, Some(AGENT_ID)),
            None
        );
        assert_eq!(metadata_conversation(None, Some(AGENT_ID), None), None);
    }

    #[test]
    fn a_second_thread_cannot_claim_the_pending_conversation() {
        let table = Mutex::new(HashMap::new());
        let first = acquire_claim(&table, request("grok"), "first", Vec::new).unwrap();
        std::thread::scope(|scope| {
            let second =
                scope.spawn(|| acquire_claim(&table, request("grok"), "second", Vec::new).err());
            assert!(second.join().unwrap().unwrap().starts_with(CONFLICT_PREFIX));
        });
        drop(first);
        assert!(acquire_claim(&table, request("grok"), "second", Vec::new).is_ok());
    }

    #[test]
    fn launch_claim_is_released_when_launch_returns_an_error() {
        fn failed_launch(table: &ClaimTable) -> Result<(), String> {
            let _claim = acquire_claim(table, request("claude"), "first", Vec::new)?;
            Err("spawn failed".to_string())
        }
        let table = Mutex::new(HashMap::new());
        assert_eq!(failed_launch(&table), Err("spawn failed".to_string()));
        assert!(table.lock().unwrap().is_empty());
        assert!(acquire_claim(&table, request("claude"), "next", Vec::new).is_ok());
    }
}

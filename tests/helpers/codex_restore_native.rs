// Common red/green assertions. Only the cfg(test) adapters in terminal.rs bind
// these to the base launch policy or the restored production launch policy.
mod pinned_argv { include!("narrow_hook_source_base.rs"); }
const ID: &str = "11111111-2222-4333-8444-555555555555";

#[test]
fn n3_missing_id_reason_and_consumed_reason_wake_reach_the_restore_entry() {
    assert!(restore_entry("bash", &[], &HashMap::new(), Some("saved-codex-pane")),
        "a kind-only saved Codex tab must not silently start an ordinary shell");
    let env = HashMap::from([("MYCMUX_RESUME".into(), "codex".into()), ("MYCMUX_SESSION_ID".into(), ID.into())]);
    assert!(restore_entry("codex", &["resume".into(), ID.into()], &env, None),
        "dormancy wake still carries exact A after the runtime reason is consumed");
}

#[test]
fn n3_direct_exact_restore_wraps_the_same_bounded_policy_as_the_launcher() {
    let mut args = vec!["resume".into(), "--no-alt-screen".into(), ID.into()];
    let command = restore_wrapper("codex", &mut args);
    assert!(matches!(command.as_str(), "/bin/bash" | "powershell.exe"));
    let script = args.last().unwrap();
    assert!(script.contains("__mycmux_restore_codex") || script.contains("Invoke-MycmuxCodexRestore"),
        "direct restoration must execute the real bounded fallback/report helper");
    assert!(script.contains("Previous conversation could not be restored; starting a new session."));
    assert!(!script.contains("--last"));
    assert!(script.contains("fresh-completed") && script.contains("fresh-failed"));
}

#[test]
fn n3_stale_reason_does_not_dispatch_an_ordinary_provider_or_handoff() {
    for provider in ["claude", "claude-codex", "grok"] {
        assert!(!restore_entry(provider, &[], &HashMap::new(), Some("saved-codex-pane")));
        let env = HashMap::from([("MYCMUX_RESUME".into(), provider.into()), ("MYCMUX_SESSION_ID".into(), ID.into())]);
        assert!(!restore_entry("bash", &[], &env, Some("saved-codex-pane")));
    }
    let env = HashMap::from([("MYCMUX_HANDOFF".into(), "codex".into())]);
    assert!(!restore_entry("bash", &[], &env, Some("saved-codex-pane")));
}

#[test]
fn n3_5133_argv_rows_match_the_pinned_base_for_four_providers() {
    let tokens = ["exec", "e", "resume", "--", "--help", "-p", "--model", "--print", "--exec", "value"];
    let mut corpus = Vec::new();
    for exe in ["codex", "C:/bin/CODEX.EXE", "node"] {
        let mut level = vec![vec![exe.to_string()]];
        for _ in 0..4 {
            corpus.extend(level.clone());
            level = level.iter().flat_map(|row| tokens.iter().map(move |token| {
                let mut next = row.clone(); next.push((*token).into()); next
            })).collect();
        }
    }
    // Exact eighteen-option list from the pinned classifier, whose complete
    // bytes are checked by the separate persistence/identity audit.
    for option in ["-p", "--profile", "-c", "--config", "-m", "--model", "-s", "--sandbox",
        "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "--local-provider",
        "--enable", "--disable", "-i", "--image"] {
        for value in tokens { for mode in tokens {
            corpus.push(vec!["codex".into(), option.into(), value.into(), mode.into()]);
        } }
    }
    assert_eq!(corpus.len(), 5133);
    for kind in ["claude", "claude-codex", "grok", "codex"] { for row in &corpus {
        assert_eq!(crate::agent_state::is_noninteractive_agent(kind, row), pinned_argv::is_noninteractive_agent(kind, row), "{kind} {row:?}");
    } }
    println!("argv parity: {} rows x 4 providers", corpus.len());
}

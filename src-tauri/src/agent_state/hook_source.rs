//! Source attribution for a capability inherited by agent descendants.
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use crate::pty::manager::SessionManager;
use crate::pty::monitor::agent_kind_from_process;
use crate::livebrief::intervene::is_descendant_with;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum HookSource {
    OwnAgent { pid: u32, started_at: u64 },
    Child,
    Unverified,
}

#[derive(Clone)]
struct ProcessRow {
    parent: Option<Pid>, started_at: u64, kind: Option<String>, shell: bool, wrapper: bool, job: bool,
}

fn classify_source_with(sender: u32, root: u32, provider: &str, mut lookup: impl FnMut(Pid) -> Option<ProcessRow>) -> HookSource {
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let valid = is_descendant_with(Pid::from_u32(sender), Pid::from_u32(root), |pid| {
        let row = lookup(pid)?;
        if seen.insert(pid) { chain.push((pid, row.clone())); }
        Some((row.parent, row.started_at))
    });
    if !valid { return HookSource::Unverified; }
    let Some(index) = chain.iter().position(|(_, row)| row.kind.is_some()) else { return HookSource::Unverified; };
    let (pid, agent) = &chain[index];
    let matches_provider = |kind: &str| kind == provider || (kind == "claude-codex" && provider == "claude");
    if !matches_provider(agent.kind.as_deref().unwrap()) { return HookSource::Child; }
    if agent.job { return HookSource::Child; }
    for (_, ancestor) in &chain[index + 1..] {
        if let Some(kind) = &ancestor.kind {
            if !ancestor.wrapper || !matches_provider(kind) { return HookSource::Child; }
        } else if !ancestor.shell { return HookSource::Child; }
    }
    HookSource::OwnAgent { pid: pid.as_u32(), started_at: agent.started_at }
}

// Provider CLI flags have different meanings: Codex -p selects a profile.
// Codex's primary CLI declares exec with the visible alias e.
pub(crate) fn is_noninteractive_agent(kind: &str, args: &[String]) -> bool {
    match kind {
        "claude" | "claude-codex" => args.iter().any(|arg| matches!(arg.as_str(), "-p" | "--print")),
        "codex" => {
            let executable = args.first().map(|arg| arg.to_ascii_lowercase());
            let leaf = executable.as_deref().map(|arg| arg.rsplit(['/', '\\']).next().unwrap_or(arg).trim_end_matches(".exe"));
            let mut index = if matches!(leaf, Some("node" | "bun")) { 2 } else { 1 };
            while let Some(arg) = args.get(index) {
                if arg == "--" { return false; }
                if matches!(arg.as_str(), "-p" | "--profile" | "-c" | "--config" | "-m" | "--model"
                    | "-s" | "--sandbox" | "-a" | "--ask-for-approval" | "-C" | "--cd" | "--add-dir"
                    | "--local-provider" | "--enable" | "--disable" | "-i" | "--image") {
                    index += 2;
                } else if arg.starts_with('-') {
                    index += 1;
                } else {
                    return matches!(arg.as_str(), "exec" | "e");
                }
            }
            false
        }
        // Preserve the existing Grok (and other provider) policy.
        _ => args.iter().any(|arg| matches!(arg.as_str(), "-p" | "--print" | "--exec")),
    }
}

pub(super) fn classify_source(manager: &SessionManager, pty: &str, provider: &str, sender: u32) -> HookSource {
    if !manager.is_running(pty) { return HookSource::Unverified; }
    let Some(root) = manager.get(pty).and_then(|session| session.process_id()) else { return HookSource::Unverified; };
    let mut system = System::new();
    classify_source_with(sender, root, provider, |pid| {
        if system.process(pid).is_none() {
            system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true,
                ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet));
        }
        let process = system.process(pid)?;
        let name = process.name().to_string_lossy().to_ascii_lowercase();
        let name = name.strip_suffix(".exe").unwrap_or(&name);
        let kind = agent_kind_from_process(&system, pid).map(|kind| kind.display_kind().to_string());
        let args = process.cmd().iter().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>();
        let job = is_noninteractive_agent(kind.as_deref().unwrap_or(""), &args);
        Some(ProcessRow {
            parent: process.parent(), started_at: process.start_time(), kind,
            shell: matches!(name, "bash" | "sh" | "zsh" | "fish" | "pwsh" | "powershell" | "cmd" | "dash" | "ksh"),
            wrapper: matches!(name, "node" | "bun"),
            job,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(parent: Option<u32>, started_at: u64, kind: Option<&str>, shell: bool) -> ProcessRow {
        ProcessRow { parent: parent.map(Pid::from_u32), started_at, kind: kind.map(str::to_string), shell, wrapper: false, job: false }
    }
    fn classify(rows: &[(u32, ProcessRow)], sender: u32, root: u32, provider: &str) -> HookSource {
        classify_source_with(sender, root, provider, |pid| rows.iter().find(|(id, _)| *id == pid.as_u32()).map(|(_, row)| row.clone()))
    }
    #[test]
    fn si_t2_main_helper_and_mod_helper_pass_for_all_providers() {
        for provider in ["claude", "codex", "grok"] {
            let rows = [(1, row(None, 10, None, true)), (2, row(Some(1), 20, Some(provider), false)),
                (3, row(Some(2), 30, None, false)), (4, row(Some(3), 40, None, true))];
            assert_eq!(classify(&rows, 3, 1, provider), HookSource::OwnAgent { pid: 2, started_at: 20 });
            assert_eq!(classify(&rows, 4, 1, provider), HookSource::OwnAgent { pid: 2, started_at: 20 });
        }
    }
    #[test]
    fn si_t2_child_jobs_and_server_jobs_never_become_the_pane_agent() {
        let rows = [(1, row(None, 10, None, true)), (2, row(Some(1), 20, Some("claude"), false)),
            (3, row(Some(2), 30, Some("claude"), false)), (4, row(Some(3), 40, None, false))];
        assert_eq!(classify(&rows, 4, 1, "claude"), HookSource::Child);
        let rows = [(1, row(None, 10, None, true)), (2, row(Some(1), 20, None, false)),
            (3, row(Some(2), 30, Some("claude"), false)), (4, row(Some(3), 40, None, false))];
        assert_eq!(classify(&rows, 4, 1, "claude"), HookSource::Child);
    }
    #[test]
    fn si_t2_recycled_newer_parent_missing_process_and_cycles_are_unverified() {
        for rows in [
            vec![(1, row(None, 50, None, true)), (2, row(Some(1), 20, Some("claude"), false)), (3, row(Some(2), 30, None, false))],
            vec![(2, row(Some(1), 20, Some("claude"), false)), (3, row(Some(2), 30, None, false))],
            vec![(2, row(Some(3), 20, Some("claude"), false)), (3, row(Some(2), 20, None, false))],
        ] { assert_eq!(classify(&rows, 3, 1, "claude"), HookSource::Unverified); }
    }
}

#[cfg(test)]
mod f4_tests {
    use super::*;

    fn source(kind: &str, args: &[&str]) -> HookSource {
        let argv = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        let rows = [
            (1, ProcessRow { parent: None, started_at: 10, kind: None, shell: true, wrapper: false, job: false }),
            (2, ProcessRow { parent: Some(Pid::from_u32(1)), started_at: 20, kind: Some(kind.into()), shell: false, wrapper: false, job: is_noninteractive_agent(kind, &argv) }),
            (3, ProcessRow { parent: Some(Pid::from_u32(2)), started_at: 30, kind: None, shell: false, wrapper: false, job: false }),
        ];
        classify_source_with(3, 1, kind, |pid| rows.iter().find(|(id, _)| *id == pid.as_u32()).map(|(_, row)| row.clone()))
    }

    #[test]
    fn f4_codex_profile_own_hook_is_not_a_child() {
        assert_eq!(source("codex", &["codex", "-p", "sample-profile"]), HookSource::OwnAgent { pid: 2, started_at: 20 });
    }
    #[test]
    fn f4_codex_exec_and_e_hooks_are_children() {
        for subcommand in ["exec", "e"] {
            assert_eq!(source("codex", &["codex", subcommand, "sample prompt"]), HookSource::Child);
        }
    }
    #[test]
    fn f4_claude_print_hooks_are_children() {
        for option in ["-p", "--print"] {
            assert_eq!(source("claude", &["claude", option, "sample prompt"]), HookSource::Child);
        }
    }
    #[test]
    fn f4_codex_profile_value_and_prompt_do_not_become_subcommands() {
        for args in [vec!["codex", "-p", "exec"], vec!["codex", "--model", "e"], vec!["codex", "resume", "exec"], vec!["codex", "--", "exec"]] {
            assert_eq!(source("codex", &args), HookSource::OwnAgent { pid: 2, started_at: 20 });
        }
    }
}

#[cfg(test)]
mod f4_job_options_tests {
    use super::*;
    #[test]
    fn f4_codex_exec_after_profile_and_npm_prefix_is_noninteractive() {
        for args in [vec!["codex", "-p", "sample-profile", "exec", "prompt"], vec!["node", "C:/fixture/codex/bin/codex.js", "-c", "sample=true", "e", "prompt"], vec!["C:/fixture/NODE.EXE", "C:/fixture/codex.js", "-p", "sample-profile", "exec", "prompt"]] {
            assert!(is_noninteractive_agent("codex", &args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>()));
        }
    }
    #[test]
    fn f4_grok_job_flags_keep_existing_policy() {
        for flag in ["-p", "--print", "--exec"] {
            assert!(is_noninteractive_agent("grok", &["grok".into(), flag.into()]));
        }
    }
}

#[cfg(test)]
mod f4_launcher_ancestry_tests {
    use super::*;
    #[test]
    fn f4_launcher_keeps_own_hook_ancestry_attached_to_the_pane() {
        // The observed Windows env.exe route lost its Bash parent. Check the
        // transport invariant, then the measured replacement's process chain.
        let launcher = include_str!("../launcher.sh");
        let body = launcher.split("__mycmux_with_hook_cap() {").nth(1).unwrap()
            .split("__mycmux_codex_with_pane() {").next().unwrap();
        assert!(!body.lines().any(|line| line.trim_start().starts_with("env ")),
            "MSYS env must not detach the Windows shim from its pane");
        let rows = [
            (1, ProcessRow { parent: None, started_at: 10, kind: None, shell: true, wrapper: false, job: false }),
            (2, ProcessRow { parent: Some(Pid::from_u32(1)), started_at: 20, kind: None, shell: true, wrapper: false, job: false }),
            (3, ProcessRow { parent: Some(Pid::from_u32(2)), started_at: 30, kind: Some("claude".into()), shell: false, wrapper: false, job: false }),
            (4, ProcessRow { parent: Some(Pid::from_u32(3)), started_at: 40, kind: None, shell: false, wrapper: false, job: false }),
        ];
        let lookup = |pid: Pid| rows.iter().find(|(id, _)| *id == pid.as_u32()).map(|(_, row)| row.clone());
        assert_eq!(classify_source_with(4, 1, "claude", lookup), HookSource::OwnAgent { pid: 3, started_at: 30 });
        // Missing ancestors must remain unverified; do not widen source trust.
        assert_eq!(classify_source_with(4, 9, "claude", lookup), HookSource::Unverified);
    }
}

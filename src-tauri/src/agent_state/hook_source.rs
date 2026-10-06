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
        Some(ProcessRow {
            parent: process.parent(), started_at: process.start_time(), kind,
            shell: matches!(name, "bash" | "sh" | "zsh" | "fish" | "pwsh" | "powershell" | "cmd" | "dash" | "ksh"),
            wrapper: matches!(name, "node" | "bun"),
            job: process.cmd().iter().any(|arg| matches!(arg.to_str(), Some("-p" | "--print" | "--exec"))),
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

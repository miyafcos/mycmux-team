use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::sync::Arc;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::State;

use crate::pty::manager::SessionManager;
use crate::AppState;

const PANE_ENV_PREFIX: &[u8] = b"MYCMUX_PANE_SESSION_ID=";
const REDACTED: &str = "[redacted]";
type ProcessRow = (u32, Option<u32>, Option<String>);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneLeftoverProcess {
    pid: u32,
    parent_pid: Option<u32>,
    name: String,
    started_at: u64,
    memory_bytes: u64,
    command: String,
    pane_session_id: String,
    pane_running: bool,
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "apikey",
        "token",
        "secret",
        "password",
        "bearer",
        "authorization",
    ]
    .iter()
    .any(|part| key.contains(part))
}

#[cfg(test)]
fn command_tokens(command: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start = None;
    let mut quote = None;
    for (offset, character) in command.char_indices() {
        if character.is_whitespace() && quote.is_none() {
            if let Some(begin) = start.take() {
                tokens.push(&command[begin..offset]);
            }
        } else {
            start.get_or_insert(offset);
            if character == '\'' || character == '"' {
                if quote == Some(character) {
                    quote = None;
                } else if quote.is_none() {
                    quote = Some(character);
                }
            }
        }
    }
    if let Some(begin) = start {
        tokens.push(&command[begin..]);
    }
    tokens
}

fn long_secret(token: &str) -> bool {
    let value = token.trim_matches(['\'', '"']);
    value.chars().count() >= 32
        && !value.contains(['\\', '/'])
        && uuid::Uuid::parse_str(value).is_err()
}

fn redact_tokens<'a>(tokens: impl IntoIterator<Item = &'a str>) -> String {
    let mut hide_next = false;
    let tokens: Vec<String> = tokens
        .into_iter()
        .map(|token| {
            let value = token.trim_matches(['\'', '"']);
            if hide_next {
                hide_next = value.eq_ignore_ascii_case("bearer");
                return REDACTED.to_string();
            }
            if let Some((key, value)) = token.split_once('=') {
                if sensitive_key(key) {
                    let value = value.trim_matches(['\'', '"']);
                    hide_next = value.is_empty() || value.eq_ignore_ascii_case("bearer");
                    return format!("{key}={REDACTED}");
                }
            } else if let Some((key, _)) =
                token.split_once(':').filter(|(key, _)| sensitive_key(key))
            {
                return format!("{key}:{REDACTED}");
            } else if sensitive_key(value) {
                if value.contains(char::is_whitespace) {
                    // Shell commands and HTTP headers can be one argv entry.
                    // Hide the whole entry rather than leaking an embedded value.
                    return REDACTED.to_string();
                }
                hide_next = true;
            }
            if long_secret(token) {
                REDACTED.to_string()
            } else {
                token.to_string()
            }
        })
        .collect();
    let result = tokens.join(" ");
    if result.chars().count() > 300 {
        result
            .chars()
            .take(299)
            .chain(std::iter::once('…'))
            .collect()
    } else {
        result
    }
}

#[cfg(test)]
fn redact_command(command: &str) -> String {
    redact_tokens(command_tokens(command))
}

fn redact_arguments(arguments: &[OsString]) -> String {
    let arguments: Vec<_> = arguments.iter().map(|arg| arg.to_string_lossy()).collect();
    // Preserve the OS argument boundaries: whitespace and quotes in a secret
    // value must not let its tail escape redaction.
    redact_tokens(arguments.iter().map(|arg| arg.as_ref()))
}

fn pane_id_from_environment(environment: &[OsString]) -> Option<String> {
    environment.iter().find_map(|entry| {
        // Inspect the ASCII key in place. Do not convert or copy other values.
        let value = entry.as_encoded_bytes().strip_prefix(PANE_ENV_PREFIX)?;
        let value = std::str::from_utf8(value).ok()?.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn child_index(rows: &[ProcessRow]) -> HashMap<u32, Vec<u32>> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, parent, _) in rows {
        if let Some(parent) = parent {
            children.entry(*parent).or_default().push(*pid);
        }
    }
    children
}

fn descendants(children: &HashMap<u32, Vec<u32>>, roots: &[u32]) -> HashSet<u32> {
    let mut pending = roots.to_vec();
    let mut seen = HashSet::new();
    while let Some(pid) = pending.pop() {
        if seen.insert(pid) {
            if let Some(next) = children.get(&pid) {
                pending.extend(next);
            }
        }
    }
    seen
}

fn group_leftover_pids(
    rows: &[ProcessRow],
    running_pty_pids: &[u32],
    mycmux_pid: u32,
) -> BTreeMap<String, Vec<u32>> {
    let normal = descendants(&child_index(rows), running_pty_pids);
    let mut groups: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for (pid, _, pane_id) in rows {
        if *pid == mycmux_pid || normal.contains(pid) {
            continue;
        }
        if let Some(pane_id) = pane_id.as_ref().filter(|id| !id.is_empty()) {
            groups.entry(pane_id.clone()).or_default().push(*pid);
        }
    }
    for pids in groups.values_mut() {
        pids.sort_unstable();
    }
    groups
}

fn running_pty_pids(manager: &SessionManager) -> Vec<u32> {
    manager
        .iter_pids()
        .into_iter()
        .filter(|(id, _)| manager.is_running(id))
        .filter_map(|(_, pid)| pid)
        .collect()
}

fn live_parent(system: &System, process: &sysinfo::Process) -> Option<Pid> {
    process.parent().filter(|parent| {
        // A newer process with the old parent's PID is not this parent.
        system
            .process(*parent)
            .is_some_and(|parent| parent.start_time() <= process.start_time())
    })
}

fn process_rows(system: &System) -> Vec<ProcessRow> {
    system
        .processes()
        .iter()
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                live_parent(system, process).map(|pid| pid.as_u32()),
                None,
            )
        })
        .collect()
}

fn probe_pane_identity(pid: Pid) -> Option<(u64, Option<String>)> {
    // A process-local System bounds the lifetime of the entire environment to
    // this probe. Only the pane id escapes; the rest is dropped on return.
    let mut probe = System::new();
    probe.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_environ(UpdateKind::Always),
    );
    let process = probe.process(pid)?;
    Some((
        process.start_time(),
        pane_id_from_environment(process.environ()),
    ))
}

fn probe_pane_process(pid: Pid) -> Option<PaneLeftoverProcess> {
    // Command and environment share sysinfo's per-process OS parameter read.
    // Raw values stay inside this probe; only a redacted row can escape it.
    let mut probe = System::new();
    probe.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing()
            .with_environ(UpdateKind::Always)
            .with_cmd(UpdateKind::Always)
            .with_memory(),
    );
    let process = probe.process(pid)?;
    let pane_session_id = pane_id_from_environment(process.environ())?;
    Some(PaneLeftoverProcess {
        pid: pid.as_u32(),
        parent_pid: None,
        name: process.name().to_string_lossy().into_owned(),
        started_at: process.start_time(),
        memory_bytes: process.memory(),
        command: redact_arguments(process.cmd()),
        pane_session_id,
        pane_running: false,
    })
}

fn scan_leftovers(manager: &SessionManager) -> Vec<PaneLeftoverProcess> {
    let mut system = System::new();
    // The shared snapshot needs only identities and parents, never raw commands
    // or environments. Each eligible process gets one combined local probe.
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let mut rows = process_rows(&system);
    let mycmux_pid = std::process::id();
    let normal = descendants(&child_index(&rows), &running_pty_pids(manager));
    let start_times: HashMap<_, _> = system
        .processes()
        .iter()
        .map(|(pid, process)| (pid.as_u32(), process.start_time()))
        .collect();
    let mut found: Vec<Option<PaneLeftoverProcess>> = (0..rows.len()).map(|_| None).collect();
    // Single-pid sysinfo refreshes take an OS snapshot on Windows. Bound the
    // number of short-lived probes to eight; no machine-wide env is retained.
    let chunk_size = rows.len().div_ceil(8).max(1);
    std::thread::scope(|scope| {
        for (chunk, results) in rows
            .chunks_mut(chunk_size)
            .zip(found.chunks_mut(chunk_size))
        {
            let normal = &normal;
            let start_times = &start_times;
            scope.spawn(move || {
                for ((pid, _, pane_id), result) in chunk.iter_mut().zip(results) {
                    if *pid == mycmux_pid || normal.contains(pid) {
                        continue;
                    }
                    if let Some(process) = probe_pane_process(Pid::from_u32(*pid)) {
                        if start_times.get(pid) == Some(&process.started_at) {
                            *pane_id = Some(process.pane_session_id.clone());
                            *result = Some(process);
                        }
                    }
                }
            });
        }
    });
    // Recheck running PTYs after the scan so a newly started PTY is excluded.
    let groups = group_leftover_pids(&rows, &running_pty_pids(manager), mycmux_pid);
    let mut by_pid: HashMap<_, _> = found
        .into_iter()
        .flatten()
        .map(|process| (process.pid, process))
        .collect();
    let mut result = Vec::new();
    for (pane_session_id, pids) in groups {
        let pane_running = manager.is_running(&pane_session_id);
        for pid in pids {
            if let Some(mut process) = by_pid.remove(&pid) {
                process.parent_pid = system
                    .process(Pid::from_u32(pid))
                    .and_then(|child| live_parent(&system, child))
                    .map(|pid| pid.as_u32());
                process.pane_running = pane_running;
                result.push(process);
            }
        }
    }
    result
}

#[tauri::command(async)]
pub async fn list_pane_leftover_processes(
    state: State<'_, AppState>,
) -> Result<Vec<PaneLeftoverProcess>, String> {
    let manager = Arc::clone(&state.session_manager);
    tokio::task::spawn_blocking(move || scan_leftovers(&manager))
        .await
        .map_err(|_| "プロセスの一覧を取得できませんでした。".to_string())
}

fn stop_guard(
    expected_start: u64,
    identity: Option<(u64, Option<&str>)>,
    protected: bool,
) -> Result<(), String> {
    let Some((started_at, pane_id)) = identity else {
        return Err("このプロセスはすでに終了しています。".to_string());
    };
    if started_at != expected_start {
        return Err("プロセスが入れ替わったため停止しません。再読み込みしてください。".to_string());
    }
    if pane_id.is_none_or(|id| id.trim().is_empty()) {
        return Err("ペインから起動されたプロセスと確認できないため停止しません。".to_string());
    }
    if protected {
        return Err(
            "mycmux 本体または動作中のペインにつながるプロセスは停止できません。".to_string(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PlannedProcess {
    pid: u32,
    started_at: u64,
}

fn build_stop_plan(
    rows: &[(u32, Option<u32>, u64)],
    root: u32,
    expected_start: u64,
) -> Vec<PlannedProcess> {
    let starts: HashMap<_, _> = rows.iter().map(|(pid, _, start)| (*pid, *start)).collect();
    let mut children: HashMap<u32, Vec<PlannedProcess>> = HashMap::new();
    for (pid, parent, start) in rows {
        if let Some(parent) = parent.filter(|parent| {
            // The same live-parent rule used by the protection check.
            starts
                .get(parent)
                .is_some_and(|parent_start| parent_start <= start)
        }) {
            children.entry(parent).or_default().push(PlannedProcess {
                pid: *pid,
                started_at: *start,
            });
        }
    }
    for children in children.values_mut() {
        children.sort_unstable_by_key(|process| process.pid);
    }
    let mut plan = vec![PlannedProcess {
        pid: root,
        started_at: expected_start,
    }];
    let mut seen = HashSet::from([root]);
    let mut offset = 0;
    while offset < plan.len() {
        if let Some(children) = children.get(&plan[offset].pid) {
            for child in children {
                if seen.insert(child.pid) {
                    plan.push(*child);
                }
            }
        }
        offset += 1;
    }
    plan
}

fn checked_stop_snapshot(
    pid: u32,
    started_at: u64,
    manager: &SessionManager,
) -> Result<(System, Vec<PlannedProcess>), String> {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let rows: Vec<_> = system
        .processes()
        .iter()
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                process.parent().map(|parent| parent.as_u32()),
                process.start_time(),
            )
        })
        .collect();
    let plan = build_stop_plan(&rows, pid, started_at);
    let children = child_index(&process_rows(&system));
    let pty_pids = running_pty_pids(manager);
    let normal = descendants(&children, &pty_pids);
    let target_tree: HashSet<_> = plan.iter().map(|process| process.pid).collect();
    let protected = pid == 0
        || normal.contains(&pid)
        || target_tree.contains(&std::process::id())
        || pty_pids.iter().any(|pid| target_tree.contains(pid));
    // Read again immediately before stopping; no environment stays in system.
    let identity = probe_pane_identity(Pid::from_u32(pid));
    stop_guard(
        started_at,
        identity.as_ref().map(|(start, id)| (*start, id.as_deref())),
        protected,
    )?;
    // A PID changed during the snapshot/probe gap cannot inherit the old tree.
    if system
        .process(Pid::from_u32(pid))
        .map(|process| process.start_time())
        != Some(started_at)
    {
        return Err("プロセスが入れ替わったため停止しません。再読み込みしてください。".to_string());
    }
    Ok((system, plan))
}

fn stop_result(failures: &[u32]) -> Result<(), String> {
    if failures.is_empty() {
        Ok(())
    } else {
        let pids = failures
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        Err(format!(
            "{} 件のプロセスを止められませんでした (PID {pids})。",
            failures.len()
        ))
    }
}

#[cfg(windows)]
mod windows_stop {
    use super::{stop_result, PlannedProcess};
    use std::time::{Duration, Instant};
    use windows::core::HRESULT;
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_OBJECT_0,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    pub(super) struct ProcessHandle(HANDLE);

    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    impl ProcessHandle {
        pub(super) fn wait(&self, timeout_ms: u32) -> bool {
            unsafe { WaitForSingleObject(self.0, timeout_ms) == WAIT_OBJECT_0 }
        }
    }

    pub(super) fn open_planned(process: PlannedProcess) -> Result<Option<ProcessHandle>, ()> {
        let handle = match unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                process.pid,
            )
        } {
            Ok(handle) => ProcessHandle(handle),
            // Windows reports this when the PID no longer exists.
            Err(error) if error.code() == HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) => {
                return Ok(None);
            }
            Err(_) => return Err(()),
        };
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) }
            .map_err(|_| ())?;
        let filetime_u64 =
            (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        // Match sysinfo 0.38.4's compute_start exactly (whole Unix seconds).
        let started_at = filetime_u64 / 10_000_000 - 11_644_473_600;
        if started_at != process.started_at {
            return Ok(None);
        }
        Ok(Some(handle))
    }

    impl ProcessHandle {
        pub(super) fn terminate(&self) -> Result<(), ()> {
            unsafe { TerminateProcess(self.0, 1) }.map_err(|_| ())
        }
    }

    pub(super) fn stop_process(process: PlannedProcess) -> Result<Option<ProcessHandle>, ()> {
        let Some(handle) = open_planned(process)? else {
            return Ok(None);
        };
        if handle.wait(0) {
            return Ok(None);
        }
        handle.terminate()?;
        Ok(Some(handle))
    }

    pub(super) fn stop_tree(plan: &[PlannedProcess]) -> Result<(), String> {
        let mut terminated = Vec::new();
        let mut failures = Vec::new();
        // Root first prevents it from starting more children while we stop the plan.
        for process in plan {
            match stop_process(*process) {
                Ok(Some(handle)) => terminated.push((process.pid, handle)),
                Ok(None) => {}
                Err(()) => failures.push(process.pid),
            }
        }
        // One shared wait budget, rather than three seconds for every process.
        let deadline = Instant::now() + Duration::from_secs(3);
        for (pid, handle) in terminated {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if !handle.wait(remaining.as_millis().min(u128::from(u32::MAX)) as u32) {
                failures.push(pid);
            }
        }
        stop_result(&failures)
    }
}

#[cfg(not(windows))]
fn stop_tree(plan: &[PlannedProcess], system: &System) -> Result<(), String> {
    let mut failures = Vec::new();
    for planned in plan.iter().rev() {
        if let Some(process) = system.process(Pid::from_u32(planned.pid)) {
            if process.start_time() == planned.started_at && !process.kill() {
                failures.push(planned.pid);
            }
        }
    }
    stop_result(&failures)
}

#[tauri::command(async)]
pub async fn stop_pane_leftover_process(
    pid: u32,
    started_at: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = Arc::clone(&state.session_manager);
    tokio::task::spawn_blocking(move || {
        let (system, plan) = checked_stop_snapshot(pid, started_at, &manager)?;
        #[cfg(windows)]
        {
            drop(system);
            windows_stop::stop_tree(&plan)
        }
        #[cfg(not(windows))]
        {
            stop_tree(&plan, &system)
        }
    })
    .await
    .map_err(|_| "停止前の確認に失敗しました。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_long_tokens_but_preserves_paths_and_uuids() {
        let command = format!(
            "python {} C:\\a\\{} /tmp/{} 00112233-4455-6677-8899-aabbccddeeff",
            "x".repeat(32),
            "y".repeat(40),
            "z".repeat(40)
        );
        let result = redact_command(&command);
        assert!(result.starts_with("python [redacted] C:\\a\\"));
        assert!(result.contains(&format!("/tmp/{}", "z".repeat(40))));
        assert!(result.ends_with("00112233-4455-6677-8899-aabbccddeeff"));
        assert_eq!(redact_command(&"x".repeat(31)), "x".repeat(31));
    }

    #[test]
    fn redacts_sensitive_flags_keys_and_quoted_values() {
        for key in [
            "api-key",
            "API_KEY",
            "token",
            "secret",
            "password",
            "bearer",
            "authorization",
            "access-token",
        ] {
            assert_eq!(
                redact_command(&format!("app --{key} tiny --safe ok")),
                format!("app --{key} [redacted] --safe ok")
            );
            assert_eq!(
                redact_command(&format!("app {key}=tiny")),
                format!("app {key}=[redacted]")
            );
        }
        assert_eq!(
            redact_command("app --password \"two words\" --name fine"),
            "app --password [redacted] --name fine"
        );
        assert_eq!(
            redact_command("app --token /tmp/secret --secret 00112233-4455-6677-8899-aabbccddeeff"),
            "app --token [redacted] --secret [redacted]"
        );
        assert_eq!(
            redact_command("app --Authorization Bearer tiny --safe ok"),
            "app --Authorization [redacted] [redacted] --safe ok"
        );
        assert_eq!(
            redact_command("app Authorization=Bearer tiny"),
            "app Authorization=[redacted] [redacted]"
        );
    }

    #[test]
    fn shell_arguments_and_authorization_headers_do_not_leak_embedded_secrets() {
        let arguments = [
            "app",
            "-c",
            "node /tmp/script --token tiny",
            "--header",
            "Authorization: Bearer tiny",
            "Authorization:tiny",
        ]
        .map(OsString::from);
        let result = redact_arguments(&arguments);
        assert!(!result.contains("tiny"));
        assert_eq!(
            result,
            "app -c [redacted] --header Authorization:[redacted] Authorization:[redacted]"
        );
    }

    #[test]
    fn redaction_precedes_unicode_safe_truncation() {
        let command = format!("app --token hidden /tmp/{}", "あ".repeat(400));
        let result = redact_command(&command);
        assert_eq!(result.chars().count(), 300);
        assert!(!result.contains("hidden"));
        assert!(result.ends_with('…'));
    }

    #[test]
    fn argument_boundaries_do_not_leak_quoted_or_whitespace_secrets() {
        let arguments = [
            "app",
            "--password",
            "two \"quoted\" words",
            "API_KEY=short value",
            "--safe",
            "ok",
        ]
        .map(OsString::from);
        assert_eq!(
            redact_arguments(&arguments),
            "app --password [redacted] API_KEY=[redacted] --safe ok"
        );
    }

    #[test]
    fn only_the_pane_variable_is_extracted() {
        let environment = [
            OsString::from("TOKEN=not-returned"),
            OsString::from("MYCMUX_PANE_SESSION_ID=pane-1"),
            OsString::from("MYCMUX_SESSION_ID=not-the-pane"),
        ];
        assert_eq!(
            pane_id_from_environment(&environment),
            Some("pane-1".to_string())
        );
        assert_eq!(
            pane_id_from_environment(&[OsString::from("MYCMUX_PANE_SESSION_ID=")]),
            None
        );
    }

    #[test]
    fn groups_detached_processes_and_excludes_every_running_pty_tree() {
        let rows = vec![
            (1, None, Some("inherited".into())),
            (10, Some(1), Some("live-a".into())),
            (11, Some(10), None),
            (12, Some(11), Some("live-a".into())),
            (20, Some(1), Some("live-b".into())),
            (21, Some(20), Some("live-b".into())),
            (31, Some(999), Some("closed".into())),
            (30, Some(31), Some("closed".into())),
            (40, None, Some("live-a".into())),
            (50, None, None),
        ];
        let groups = group_leftover_pids(&rows, &[10, 20], 1);
        assert_eq!(
            groups,
            BTreeMap::from([("closed".into(), vec![30, 31]), ("live-a".into(), vec![40])])
        );
        assert!(group_leftover_pids(&rows[..1], &[], 1).is_empty());
    }

    #[test]
    fn graph_walk_handles_cycles_and_700_processes() {
        let mut rows: Vec<ProcessRow> = (1..=700)
            .map(|pid| (pid, Some(pid - 1), Some("pane".into())))
            .collect();
        rows[0].1 = Some(700);
        assert!(group_leftover_pids(&rows, &[1], 999).is_empty());
        assert_eq!(group_leftover_pids(&rows, &[], 999)["pane"].len(), 700);
    }

    #[test]
    fn stop_guard_refuses_absence_pid_reuse_missing_environment_and_protected_trees() {
        assert!(stop_guard(100, None, false).unwrap_err().contains("終了"));
        assert!(stop_guard(100, Some((101, Some("pane"))), false)
            .unwrap_err()
            .contains("入れ替"));
        for pane_id in [None, Some(""), Some(" ")] {
            assert!(stop_guard(100, Some((100, pane_id)), false)
                .unwrap_err()
                .contains("確認"));
        }
        assert!(stop_guard(100, Some((100, Some("pane"))), true)
            .unwrap_err()
            .contains("mycmux"));
        assert_eq!(stop_guard(100, Some((100, Some("pane"))), false), Ok(()));
    }

    #[test]
    fn stop_plan_is_root_first_breadth_first_and_leaves_unrelated_rows_alone() {
        let rows = [
            (50, Some(30), 150),
            (30, Some(10), 130),
            (40, Some(20), 140),
            (20, Some(10), 120),
            (10, None, 100),
            (99, None, 90),
            (98, Some(99), 95),
        ];
        assert_eq!(
            build_stop_plan(&rows, 10, 101),
            vec![
                PlannedProcess {
                    pid: 10,
                    started_at: 101
                },
                PlannedProcess {
                    pid: 20,
                    started_at: 120
                },
                PlannedProcess {
                    pid: 30,
                    started_at: 130
                },
                PlannedProcess {
                    pid: 40,
                    started_at: 140
                },
                PlannedProcess {
                    pid: 50,
                    started_at: 150
                },
            ]
        );
        assert_eq!(rows[5], (99, None, 90));
        assert_eq!(rows[6], (98, Some(99), 95));
    }

    #[test]
    fn stop_plan_handles_cycles_once() {
        let rows = [
            (10, Some(30), 100),
            (20, Some(10), 100),
            (30, Some(20), 100),
        ];
        let plan = build_stop_plan(&rows, 10, 100);
        assert_eq!(
            plan.iter().map(|process| process.pid).collect::<Vec<_>>(),
            [10, 20, 30]
        );
        assert_eq!(build_stop_plan(&[(10, Some(10), 100)], 10, 100).len(), 1);
    }

    #[test]
    fn stop_plan_excludes_children_of_a_reused_parent_pid() {
        let rows = [
            (10, None, 200),
            (20, Some(10), 100),
            (21, Some(20), 110),
            (30, Some(10), 201),
            (40, Some(999), 300),
        ];
        assert_eq!(
            build_stop_plan(&rows, 10, 200)
                .iter()
                .map(|process| process.pid)
                .collect::<Vec<_>>(),
            [10, 30]
        );
        assert_eq!(
            build_stop_plan(&[], 10, 200),
            [PlannedProcess {
                pid: 10,
                started_at: 200
            }]
        );
    }

    #[test]
    fn stop_failures_are_one_short_sentence() {
        assert_eq!(stop_result(&[]), Ok(()));
        assert_eq!(
            stop_result(&[123, 456]).unwrap_err(),
            "2 件のプロセスを止められませんでした (PID 123, 456)。"
        );
    }

    #[cfg(windows)]
    mod windows_tests {
        use super::*;
        use std::os::windows::process::CommandExt;
        use std::process::{Child, Command, Stdio};
        use std::time::{Duration, Instant};
        use windows_stop::ProcessHandle;

        struct TestChildren {
            root: Child,
            pane_id: String,
            ping: Option<ProcessHandle>,
        }

        impl TestChildren {
            fn spawn(program: &str, args: &[&str]) -> Self {
                let pane_id = format!("c2-test-{}", uuid::Uuid::new_v4());
                let root = Command::new(program)
                    .args(args)
                    .env("MYCMUX_PANE_SESSION_ID", &pane_id)
                    .creation_flags(crate::util::process::CREATE_NO_WINDOW)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("spawn the test's own child");
                Self {
                    root,
                    pane_id,
                    ping: None,
                }
            }

            fn capture_own_ping(&mut self, root_start: u64) -> Option<u32> {
                let mut system = System::new();
                system.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing(),
                );
                for (pid, process) in system.processes() {
                    if process.parent().map(|pid| pid.as_u32()) != Some(self.root.id())
                        || process.start_time() < root_start
                        || !process
                            .name()
                            .to_string_lossy()
                            .eq_ignore_ascii_case("ping.exe")
                    {
                        continue;
                    }
                    // The Child pins our cmd PID; the unique inherited pane id and
                    // creation time establish that this ping was started by it.
                    if probe_pane_identity(*pid)
                        != Some((process.start_time(), Some(self.pane_id.clone())))
                    {
                        continue;
                    }
                    if let Ok(Some(handle)) = windows_stop::open_planned(PlannedProcess {
                        pid: pid.as_u32(),
                        started_at: process.start_time(),
                    }) {
                        self.ping = Some(handle);
                        return Some(pid.as_u32());
                    }
                }
                None
            }
        }

        impl Drop for TestChildren {
            fn drop(&mut self) {
                let root_start = child_start(self.root.id());
                // Use the owned Child handle; stopping cmd first prevents a late spawn.
                let _ = self.root.kill();
                let _ = self.root.wait();
                if self.ping.is_none() {
                    // The owned Child still pins cmd's PID after wait. Even when
                    // sysinfo could not read cmd, the unique tag identifies its ping.
                    self.capture_own_ping(root_start.unwrap_or(0));
                }
                if let Some(ping) = self.ping.as_ref() {
                    if !ping.wait(0) {
                        let _ = ping.terminate();
                    }
                    ping.wait(3_000);
                }
            }
        }

        fn child_start(pid: u32) -> Option<u64> {
            let mut system = System::new();
            system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
                true,
                ProcessRefreshKind::nothing(),
            );
            system
                .process(Pid::from_u32(pid))
                .map(|process| process.start_time())
        }

        #[test]
        fn windows_stop_skips_reused_pid_and_stops_own_child() {
            let mut children = TestChildren::spawn("ping.exe", &["-n", "30", "127.0.0.1"]);
            let pid = children.root.id();
            let started_at = child_start(pid).expect("read the test child's sysinfo start time");
            assert!(windows_stop::stop_process(PlannedProcess {
                pid,
                started_at: started_at + 1
            })
            .expect("skip a mismatched start time")
            .is_none());
            assert!(children
                .root
                .try_wait()
                .expect("poll the owned child")
                .is_none());
            let before = Instant::now();
            let handle = windows_stop::stop_process(PlannedProcess { pid, started_at })
                .expect("stop the owned child")
                .expect("the child was running");
            assert!(
                handle.wait(3_000),
                "the owned child did not exit in three seconds"
            );
            assert!(before.elapsed() < Duration::from_secs(3));
            assert!(children
                .root
                .try_wait()
                .expect("poll the owned child")
                .is_some());
        }

        #[test]
        fn windows_stop_stops_exact_checked_cmd_and_ping_tree() {
            let mut children =
                TestChildren::spawn("cmd.exe", &["/d", "/c", "ping -n 30 127.0.0.1 >nul"]);
            let pid = children.root.id();
            let started_at = child_start(pid).expect("read the test child's sysinfo start time");
            let deadline = Instant::now() + Duration::from_secs(3);
            let ping_pid = loop {
                if let Some(pid) = children.capture_own_ping(started_at) {
                    break pid;
                }
                assert!(
                    Instant::now() < deadline,
                    "the owned cmd did not start ping"
                );
                std::thread::sleep(Duration::from_millis(20));
            };
            let (system, plan) = checked_stop_snapshot(pid, started_at, &SessionManager::new())
                .expect("validate only the test's own tree");
            // CREATE_NO_WINDOW gives cmd its own conhost.exe, so the tree is cmd,
            // ping and that conhost: every member after cmd is cmd's direct child.
            assert_eq!(plan[0].pid, pid);
            assert!(plan.iter().any(|process| process.pid == ping_pid));
            assert!(
                plan.len() <= 3,
                "unexpected members in the own tree: {plan:?}"
            );
            assert!(plan[1..].iter().all(|planned| system
                .process(Pid::from_u32(planned.pid))
                .is_some_and(|process| process.parent() == Some(Pid::from_u32(pid))
                    && ["ping.exe", "conhost.exe"]
                        .iter()
                        .any(|name| process.name().to_string_lossy().eq_ignore_ascii_case(name)))));
            drop(system);
            let before = Instant::now();
            windows_stop::stop_tree(&plan).expect("stop the owned tree");
            assert!(children
                .root
                .try_wait()
                .expect("poll the owned cmd")
                .is_some());
            assert!(children
                .ping
                .as_ref()
                .expect("hold the owned ping handle")
                .wait(0));
            assert!(before.elapsed() < Duration::from_secs(3));
        }
    }

    #[test]
    #[ignore = "read-only live scan timing; prints counts and elapsed time only"]
    fn live_scan_timing() {
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let count = system.processes().len();
        let start = std::time::Instant::now();
        let rows = scan_leftovers(&SessionManager::new());
        println!(
            "Live scan: {count} processes, {} pane-tagged rows, {} ms",
            rows.len(),
            start.elapsed().as_millis()
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(3));
    }
}

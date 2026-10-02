from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_pane_leftover_commands_are_async_registered_and_have_typed_ipc() -> None:
    source = read("src-tauri/src/commands/pane_leftovers.rs")
    assert "pub mod pane_leftovers;" in read("src-tauri/src/commands/mod.rs")
    for command in ("list_pane_leftover_processes", "stop_pane_leftover_process"):
        assert re.search(rf"#\[tauri::command\(async\)\]\s+pub async fn {command}\(", source)
        assert f"commands::pane_leftovers::{command}," in read("src-tauri/src/lib.rs")
        assert f'"{command}"' in read("src/lib/paneLeftovers.ts")
    assert "spawn_blocking" in source
    assert "taskkill" not in source
    windows_stop = source[source.index("mod windows_stop {"):source.index("#[cfg(not(windows))]")]
    assert windows_stop.index("GetProcessTimes(") < windows_stop.index("TerminateProcess(")
    for right in ("PROCESS_TERMINATE", "PROCESS_QUERY_LIMITED_INFORMATION", "PROCESS_SYNCHRONIZE"):
        assert right in windows_stop
    assert "WaitForSingleObject" in windows_stop
    assert "Duration::from_secs(3)" in windows_stop
    command = source[source.index("pub async fn stop_pane_leftover_process("):source.index("#[cfg(test)]\nmod tests")]
    assert command.index("spawn_blocking") < command.index("checked_stop_snapshot") < command.index("windows_stop::stop_tree") < command.index(".await")


def test_process_list_is_separate_from_the_existing_sweep_and_only_on_demand() -> None:
    panel = read("src/components/layout/TabSweepPanel.tsx")
    assert panel.index("<PaneLeftoverProcesses active={open && !closing} />") > panel.index("{rows.map(")
    section = read("src/components/layout/PaneLeftoverProcesses.tsx")
    notifications = read("src/lib/paneLeftoverNotifications.ts")
    assert "setInterval" not in section
    assert "setInterval" not in notifications
    assert "if (active) void refresh()" in section
    assert "10_000" in notifications
    dormancy = read("src/hooks/useAgentDormancy.ts")
    assert "await killSession(target.sessionId)" in dormancy
    assert "pushClosed" not in dormancy
    assert "scheduleClosedPaneLeftoverCheck" not in dormancy


def test_other_environment_values_do_not_escape_a_process_local_probe() -> None:
    source = read("src-tauri/src/commands/pane_leftovers.rs")
    probe = source[source.index("fn probe_pane_identity("):source.index("fn scan_leftovers(")]
    assert "let mut probe = System::new()" in probe
    assert "ProcessesToUpdate::Some(&[pid])" in probe
    assert "pane_id_from_environment(process.environ())" in probe
    scan = source[source.index("fn scan_leftovers("):source.index("#[tauri::command(async)]")]
    assert "with_environ" not in scan
    assert "probe_pane_process" in scan
    assert "std::env::vars" not in source
    assert "dbg!(" not in source

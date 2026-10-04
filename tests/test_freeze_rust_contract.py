"""Freeze diagnostics must cover every app-owned WebView creation path."""

import re
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
WATCHDOG = ROOT / "src-tauri/src/watchdog.rs"
LIB = ROOT / "src-tauri/src/lib.rs"


def function_body(source: str, name: str) -> str:
    match = re.search(rf"\bfn\s+{name}(?:<[^>{{}}]+>)?\s*\(", source)
    assert match, name
    start = source.index("{", match.end())
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f"unterminated {name}")


@pytest.mark.parametrize(
    "relative,name,creation,registration",
    [
        ("src-tauri/src/commands/window.rs", "spawn_child_window", "builder.build()",
         "crate::watchdog::register_process_failed(window.as_ref());"),
        ("src-tauri/src/commands/webpane.rs", "webpane_create", ".add_child(",
         "crate::watchdog::register_process_failed(&webview);"),
    ],
)
def test_new_child_windows_and_web_panes_register_process_failed(
    relative: str, name: str, creation: str, registration: str,
) -> None:
    body = function_body((ROOT / relative).read_text(encoding="utf-8"), name)
    assert body.count(registration) == 1
    assert body.index(creation) < body.index(registration)
    assert re.search(rf"#\[cfg\(windows\)\]\s*{re.escape(registration)}", body)


def test_setup_registers_main_webview_and_starts_the_watchdog() -> None:
    setup = LIB.read_text(encoding="utf-8").split(".setup(", 1)[1].split(".on_window_event(", 1)[0]
    assert "watchdog::start(app_handle.clone());" in setup
    assert re.search(
        r'if let Some\(main_window\) = app.get_webview_window\("main"\) \{\s*'
        r'#\[cfg\(windows\)\]\s*watchdog::register_process_failed\(main_window.as_ref\(\)\);',
        setup,
    )


def test_process_failed_registration_only_enqueues_recovery_and_uses_the_existing_native_webview() -> None:
    source = WATCHDOG.read_text(encoding="utf-8")
    assert re.search(r"#\[cfg\(windows\)\]\s*pub\(crate\) fn register_process_failed", source)
    body = function_body(source, "register_process_failed")
    for required in (".with_webview(", "ProcessFailedEventHandler::create", ".add_ProcessFailed(",
                     "ProcessFailedKind(", "ExitCode(", "window=", "webview=", "log_with_memory(",
                     "queue_renderer_failure("):
        assert required in body
    for forbidden in (".reload(", ".navigate(", ".build(", ".recv(", "std::fs", "diag::log("):
        assert forbidden not in body


def test_renderer_heartbeat_keeps_the_shared_name_schema_and_async_contract() -> None:
    source = WATCHDOG.read_text(encoding="utf-8")
    assert re.search(
        r"#\[tauri::command\]\s*pub async fn report_renderer_heartbeat\(caller: tauri::Webview, heartbeat: RendererHeartbeat\)"
        r"\s*-> Result<\(\), String>", source,
    )
    fields = re.search(
        r'#\[serde\(rename_all = "camelCase"\)\]\s*pub struct RendererHeartbeat \{([^}]+)\}', source,
    )
    assert fields
    actual = dict(re.findall(r"pub (\w+): ([^,]+),", fields.group(1)))
    assert actual == {"heap_used_mib": "Option<f64>", "long_tasks": "u32",
                      "max_long_task_ms": "f64", "xterm_count": "u32", "pending_invokes": "u32",
                      "visibility": "String", "focus": "bool"}
    assert "watchdog::report_renderer_heartbeat," in LIB.read_text(encoding="utf-8")


def test_kill_session_registration_times_the_whole_existing_command_on_the_same_executor() -> None:
    source = WATCHDOG.read_text(encoding="utf-8")
    assert re.search(r"#\[tauri::command\]\s*pub async fn measured_kill_session\(", source)
    body = function_body(source, "measured_kill_session")
    call = "crate::commands::terminal::kill_session(state, session_id.clone())"
    assert body.index("Instant::now()") < body.index(call) < body.index("start.elapsed()")
    assert call + ".await" in body
    assert "spawn_blocking" not in body
    assert "use measured_kill_session as kill_session;" in source
    assert "use __cmd__measured_kill_session as __cmd__kill_session;" in source
    assert "watchdog::kill_session," in LIB.read_text(encoding="utf-8")


def test_main_thread_probe_only_stamps_and_diagnostic_queue_is_bounded() -> None:
    source = WATCHDOG.read_text(encoding="utf-8")
    assert "mpsc::sync_channel(128)" in source
    assert "queue.try_send(line)" in source
    assert re.search(r"run_on_main_thread\(move \|\| callback_stamp.complete\(\)\)", source)
    assert "GlobalMemoryStatusEx" in source


def test_watchdog_start_failure_logs_from_the_blocking_pool() -> None:
    source = WATCHDOG.read_text(encoding="utf-8")
    assert re.search(
        r'tauri::async_runtime::spawn_blocking\(move \|\| \{\s*'
        r'crate::diag::warn\("watchdog", &format!\("failed to start: \{error\}"\)\);\s*\}\);',
        source,
    )

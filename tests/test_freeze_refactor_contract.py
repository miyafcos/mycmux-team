"""Freeze refactor boundaries; behavioral races are covered by Rust state tests."""

from pathlib import Path
from test_freeze_rust_contract import function_body

ROOT = Path(__file__).resolve().parents[1]


def text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_kill_does_not_wait_for_hook_reply_and_teardown_uses_the_blocking_pool() -> None:
    body = function_body(text("src-tauri/src/commands/terminal.rs"), "kill_session")
    assert "queue_session_drain(&session_id)" in body
    assert ".drain_session(" not in body
    assert body.index("queue_session_drain") < body.index('run_blocking("kill_session"') < body.index("manager.kill(")
    assert "}).await" in body
    queue = function_body(text("src-tauri/src/agent_state/hook.rs"), "queue_session_drain")
    assert ".try_send(" in queue
    assert ".recv" not in queue


def test_shutdown_callback_only_waits_with_a_fixed_budget_and_offloads_io() -> None:
    body = function_body(text("src-tauri/src/commands/window.rs"), "handle_app_run_event")
    start = body.index("move |deadline| {") + len("move |deadline| ")
    depth = 0
    for end in range(start, len(body)):
        if body[end] == "{":
            depth += 1
        elif body[end] == "}":
            depth -= 1
            if depth == 0:
                break
    worker = body[start:end + 1]
    callback = body[:start] + body[end + 1:]
    for operation in ["fill_in_unsaved_workspaces", "flush_all_scrollbacks", ".kill_all()", ".revoke_all()"]:
        assert operation in worker
        assert operation not in callback
    shutdown = text("src-tauri/src/shutdown.rs")
    assert "Duration::from_secs(3)" in shutdown
    assert ".recv_timeout(" in shutdown and "saturating_duration_since" in shutdown
    assert ".join(" not in shutdown
    storage = function_body(text("src-tauri/src/db/storage.rs"), "update_for_shutdown")
    assert "Duration::from_millis(100)" in storage
    assert "acquire_with_timeout(" in storage
    assert "update_for_shutdown(" in function_body(text("src-tauri/src/commands/quit.rs"), "fill_in_unsaved_workspaces")


def test_recovery_runs_on_watchdog_thread_with_bounded_attempts_and_no_pty_destruction() -> None:
    source = text("src-tauri/src/watchdog.rs")
    recovery = function_body(source, "recover_renderers")
    assert "webview.reload()" in recovery
    assert "renderer reload" in recovery and "renderer recovery give up" in recovery
    for forbidden in ["kill_session", "kill_all", "session_manager", "std::fs", ".build("]:
        assert forbidden not in recovery
    start = function_body(source, "start")
    assert start.index('.name("mycmux-watchdog"') < start.index("recover_renderers(")
    assert "const RELOAD_WINDOW_MS: u64 = 600_000;" in source
    assert "const RELOAD_SPACING_MS: u64 = 60_000;" in source
    assert "const MAX_RELOADS: usize = 3;" in source
    assert "failure_receiver.try_iter()" in start


def test_reserved_tearout_view_registers_existing_watchdog_without_other_changes() -> None:
    source = text("src-tauri/src/tearout/mod.rs")
    warm = function_body(source, "tearout_warm")
    registration = "crate::watchdog::register_process_failed(window.as_ref());"
    assert warm.count(registration) == 1
    assert warm.index(".build()") < warm.index(registration)


def test_webview_creation_timing_covers_main_child_and_panes_without_logging_on_ui_thread() -> None:
    source = text("src-tauri/src/lib.rs")
    assert source.index("watchdog::begin_main_webview_creation();") < source.index("application.run(")
    assert source.index("watchdog::start(app_handle.clone());") < source.index("watchdog::main_webview_created();")
    for path, name, creation in [
        ("src-tauri/src/commands/window.rs", "spawn_child_window", "builder.build()"),
        ("src-tauri/src/commands/webpane.rs", "webpane_create", ".add_child("),
    ]:
        body = function_body(text(path), name)
        assert body.index("creation_start =") < body.index(creation) < body.index("record_webview_creation(")
    record = function_body(text("src-tauri/src/watchdog.rs"), "record_webview_creation")
    assert "log_with_memory(" in record and "diag::log(" not in record


def test_mapping_ipc_reads_only_through_its_blocking_worker() -> None:
    source = text("src-tauri/src/commands/session_mapping.rs")
    body = function_body(source, "read_agent_session_mappings")
    assert 'run_blocking_value("read_agent_session_mappings", move || {' in body
    assert "mapping_read_worker::read_agent_session_mappings(session_ids)" in body
    assert "}).await" in body
    worker = source.split("mod mapping_read_worker {", 1)[1].split("#[cfg(test)]", 1)[0]
    assert "pub fn read_agent_session_mappings(" in worker
    assert "agent_mappings_for_ids(session_ids)" in worker

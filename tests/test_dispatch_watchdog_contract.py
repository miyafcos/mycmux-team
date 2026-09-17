from __future__ import annotations

import re
from pathlib import Path

from test_command_sync_contract import SYNC_ALLOWLIST


REPO_ROOT = Path(__file__).resolve().parents[1]


def read(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def test_watchdog_command_is_async_and_exposed() -> None:
    command = read("src-tauri/src/commands/dispatch.rs")
    lib_rs = read("src-tauri/src/lib.rs")
    ipc = read("src/lib/ipc.ts")

    assert re.search(r"#\[tauri::command\]\s+pub async fn dispatch_claim_watchdog", command)
    assert "commands::dispatch::dispatch_claim_watchdog" in lib_rs
    assert 'invoke<boolean>("dispatch_claim_watchdog", { ttlMs })' in ipc
    assert not any(name.startswith("dispatch_") for name in SYNC_ALLOWLIST)


def test_watchdog_is_notification_only() -> None:
    store = read("src/stores/dispatchWatchdogStore.ts")
    for forbidden in [
        "pane.send_text",
        "pane.close_tab",
        "writeToSession",
        "dispatch_run_gate",
        "dispatch_write_verdict",
    ]:
        assert forbidden not in store


def test_finished_ledger_statuses_match_between_rust_and_typescript() -> None:
    # Both sides mirror INACTIVE_STATUSES in session-dispatch's
    # dispatch_ledger.py. When they drifted to closed/abandoned only, 96
    # finished rows raised watch toasts (2026-09-17).
    expected = {"closed", "done-verified-closed", "abandoned", "fallback-inline", "lost"}
    rust = read("src-tauri/src/dispatch/ledger.rs")
    store = read("src/stores/dispatchWatchdogStore.ts")
    command = read("src-tauri/src/commands/dispatch.rs")

    rust_match = re.search(r"pub const INACTIVE_STATUSES: \[&str; \d+\] = \[([^\]]*)\];", rust)
    ts_match = re.search(r"INACTIVE_DISPATCH_STATUSES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)", store)
    assert rust_match and ts_match
    assert set(re.findall(r'"([^"]+)"', rust_match.group(1))) == expected
    assert set(re.findall(r'"([^"]+)"', ts_match.group(1))) == expected
    assert "ledger::is_inactive_status(" in command
    assert '"closed" | "abandoned"' not in command


def test_watchdog_follows_window_role() -> None:
    app = read("src/App.tsx")
    expected = """useEffect(() => {
    if (!ready || !hasRole) return;
    return connectDispatchWatchdog();
  }, [ready, hasRole]);"""
    assert expected in app

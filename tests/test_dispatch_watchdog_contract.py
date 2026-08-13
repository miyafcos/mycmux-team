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


def test_watchdog_is_main_window_only() -> None:
    app = read("src/App.tsx")
    expected = """useEffect(() => {
    if (!ready || !isMain) return;
    return connectDispatchWatchdog();
  }, [ready, isMain]);"""
    assert expected in app

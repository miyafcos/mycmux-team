"""Keep window ownership and blocking IPC wired to the production entrypoints."""

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_livebrief_window_ownership_uses_injected_window_and_global_destroy_event():
    livebrief = (ROOT / "src-tauri/src/livebrief/mod.rs").read_text(encoding="utf-8")
    for action in ("subscribe", "unsubscribe"):
        command = re.search(
            rf"pub async fn {action}_live_briefs\((.*?)\n\}}",
            livebrief,
            re.S,
        ).group(1)
        assert "window: tauri::Window" in command
        assert f"state.livebrief_service.{action}(window.label())" in command
    app = (ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    handler = app.split(".on_window_event(|window, event|", 1)[1].split(
        ".run(tauri::generate_context!())", 1
    )[0]
    assert "tauri::WindowEvent::Destroyed" in handler
    assert "window.try_state::<AppState>()" in handler
    assert "state.livebrief_service.unsubscribe(window.label())" in handler


def test_livebrief_read_commands_delegate_to_the_tested_blocking_pool_paths():
    source = (ROOT / "src-tauri/src/livebrief/mod.rs").read_text(encoding="utf-8")
    for command, helper in (
        ("get_live_briefs", "snapshots_on_blocking_pool"),
        ("get_live_events", "events_on_blocking_pool"),
    ):
        body = re.search(rf"pub async fn {command}\((.*?)\n\}}", source, re.S).group(1)
        assert f"{helper}(state.livebrief_service.clone()" in body
        assert ".await" in body
        helper_body = re.search(rf"async fn {helper}\((.*?)\n\}}", source, re.S).group(1)
        assert f'run_blocking("{command}", move ||' in helper_body

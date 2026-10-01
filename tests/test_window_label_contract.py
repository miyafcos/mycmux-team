"""Window labels and lifecycle decisions must include multi-webview windows."""

from __future__ import annotations

import re
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
WINDOW_SOURCES = (
    "src-tauri/src/commands/window.rs",
    "src-tauri/src/commands/window_registry.rs",
    "src-tauri/src/window_registry.rs",
)


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


@pytest.mark.parametrize("relative_path", WINDOW_SOURCES)
def test_window_lifecycle_enumerates_all_os_windows(relative_path: str) -> None:
    source = read_repo_text(relative_path)
    # Preserve string literals while removing line and block comments.
    code = re.sub(
        r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*.*?\*/',
        lambda match: match.group(0) if match.group(0).startswith('"') else "",
        source,
        flags=re.S,
    )
    assert not re.search(r"\.\s*webview_windows\s*\(", code), (
        f"{relative_path}: webview_windows() omits OS windows hosting web panes; "
        "enumerate all window labels instead"
    )


def test_all_four_window_decisions_share_the_os_window_label_list() -> None:
    window = read_repo_text(WINDOW_SOURCES[0])
    registry_commands = read_repo_text(WINDOW_SOURCES[1])
    helper = window.split("fn all_window_labels(", 1)[1].split("\n}", 1)[0]
    assert "app.windows().keys().cloned().collect()" in helper
    resolver = window.split("pub fn resolve_child_window_label(", 1)[1].split("\n}", 1)[0]
    lifecycle = window.split("pub fn handle_app_run_event(", 1)[1].split("\n}", 1)[0]
    quit_app = window.split("pub fn quit_app(", 1)[1].split("\n}", 1)[0]
    rescue = registry_commands.split("pub fn reclaim_destroyed_window(", 1)[1]
    for body in (resolver, lifecycle, quit_app, rescue):
        assert "all_window_labels(" in body

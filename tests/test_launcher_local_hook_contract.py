from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_bundled_launchers_keep_local_hook_escape_hatch() -> None:
    launcher_sh = read_repo_text("src-tauri/src/launcher.sh")
    launcher_ps1 = read_repo_text("src-tauri/src/launcher.ps1")

    assert_contains(
        launcher_sh,
        "launcher.local.sh",
        "src-tauri/src/launcher.sh",
    )
    assert_contains(
        launcher_ps1,
        "launcher.local.ps1",
        "src-tauri/src/launcher.ps1",
    )

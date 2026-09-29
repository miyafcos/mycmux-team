from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_scrollback_store_stays_tauri_and_launcher_independent() -> None:
    source = (
        REPO_ROOT / "src-tauri/src/pty/scrollback_store.rs"
    ).read_text(encoding="utf-8")
    forbidden = ("CommandBuilder", "cmd.env", "MYCMUX_", "use tauri")
    offenders = [token for token in forbidden if token in source]

    assert not offenders, (
        "scrollback_store.rs must remain a std + crc-only persistence module; "
        f"forbidden dependencies: {', '.join(offenders)}"
    )


def test_discard_session_scrollback_is_async_and_calls_remove() -> None:
    source = (
        REPO_ROOT / "src-tauri/src/commands/terminal.rs"
    ).read_text(encoding="utf-8")
    assert "pub async fn discard_session_scrollback(" in source
    assert "scrollback_store::remove(dir, &session_id)" in source

    lib = (REPO_ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    assert "commands::terminal::discard_session_scrollback" in lib

    ipc = (REPO_ROOT / "src/lib/ipc.ts").read_text(encoding="utf-8")
    assert 'invoke<void>("discard_session_scrollback"' in ipc

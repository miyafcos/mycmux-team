from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUST_SRC_ROOT = REPO_ROOT / "src-tauri" / "src"

SYNC_ALLOWLIST = {
    "write_to_session",
    "ack_frontend_data",
    "set_frontend_visible",
    "get_pty_metadata_snapshot",
    "socket_response",
    "claim_leader",
    "reveal_main_window",
    # Multi-window Phase 3a: the body only allocates a label and posts the
    # WebviewWindowBuilder to the main thread (mirrors reveal_main_window).
    # It must stay sync — a #[tauri::command(async)] variant would build the
    # window off the main thread, which tao forbids on Windows/macOS.
    "open_child_window",
    # Multi-window Phase 3b: same shape as open_child_window — in-memory
    # registry bookkeeping plus a WebviewWindowBuilder posted to the main
    # thread. The window must be built there, so this cannot go async either.
    "open_workspace_window",
    "quit_app",
    # Test-profile mode: a OnceLock read plus a String clone (same class as
    # get_pty_metadata_snapshot) — legitimately cheap and sync.
    "get_test_profile",
}

BLOCKING_BODY_TOKENS = [
    "std::fs",
    "read_dir",
    "read_to_string",
    "canonicalize",
    "::metadata(",
    "Command::new",
    "sysinfo",
    "rusqlite",
    "std::thread::sleep",
    "ZipArchive",
    "quick_xml",
    "spawn_blocking",
]

COMMAND_ATTR_RE = re.compile(r"#\s*\[\s*tauri::command(?:\((?P<args>[^\]]*)\))?\s*\]")
FN_RE = re.compile(r"(?m)^\s*pub\s+(?P<async>async\s+)?fn\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(")


@dataclass(frozen=True)
class TauriCommand:
    name: str
    path: Path
    line: int
    is_async: bool
    has_async_attribute: bool
    is_async_fn: bool
    body: str


def read_repo_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def function_body(text: str, fn_start: int, search_end: int) -> str:
    brace_start = text.find("{", fn_start, search_end)
    assert brace_start != -1, (
        f"could not find function body starting near line {line_number(text, fn_start)}"
    )

    depth = 0
    for offset in range(brace_start, len(text)):
        char = text[offset]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[brace_start : offset + 1]

    raise AssertionError(f"unterminated function body near line {line_number(text, fn_start)}")


def commands_from_text(path: Path, text: str) -> list[TauriCommand]:
    commands: list[TauriCommand] = []
    attrs = list(COMMAND_ATTR_RE.finditer(text))
    for index, attr in enumerate(attrs):
        next_attr_start = attrs[index + 1].start() if index + 1 < len(attrs) else len(text)
        fn = FN_RE.search(text, attr.end(), next_attr_start)
        assert fn is not None, (
            f"{path}:{line_number(text, attr.start())}: "
            "found #[tauri::command] without a following public function"
        )
        args = attr.group("args") or ""
        has_async_attribute = "async" in {part.strip() for part in args.split(",")}
        is_async_fn = bool(fn.group("async"))
        commands.append(TauriCommand(
            name=fn.group("name"), path=path, line=line_number(text, fn.start()),
            is_async=has_async_attribute or is_async_fn,
            has_async_attribute=has_async_attribute, is_async_fn=is_async_fn,
            body=function_body(text, fn.start(), next_attr_start),
        ))
    return commands


def iter_tauri_commands() -> list[TauriCommand]:
    return [command for path in sorted(RUST_SRC_ROOT.rglob("*.rs"))
            for command in commands_from_text(path, read_repo_text(path))]


def blocking_attribute_sync_commands(commands: list[TauriCommand]) -> list[TauriCommand]:
    return [command for command in commands
            if command.has_async_attribute and not command.is_async_fn
            and any(token in command.body for token in BLOCKING_BODY_TOKENS)]


def test_async_attribute_cannot_hide_a_blocking_synchronous_function() -> None:
    offenders = blocking_attribute_sync_commands(iter_tauri_commands())
    assert not offenders, "; ".join(
        f"{command.path.relative_to(REPO_ROOT)}:{command.line} {command.name}: "
        "move blocking work into run_blocking and use async fn"
        for command in offenders
    )


def test_all_async_attribute_commands_are_real_async_functions() -> None:
    commands = iter_tauri_commands()
    offenders = [command.name for command in commands
                 if command.has_async_attribute and not command.is_async_fn]
    assert not offenders, offenders


def test_blocking_attribute_scanner_distinguishes_attributes_from_async_functions() -> None:
    for token in ["std::fs::read", "sysinfo::System", "Command::new", "rusqlite::Connection"]:
        source = f"#[tauri::command(async)]\npub fn bad() {{ {token}(); }}\n"
        source += f"#[tauri::command]\npub async fn good() {{ {token}(); }}\n"
        source += "#[tauri::command(async)]\npub fn cheap() { 1 }\n"
        commands = commands_from_text(Path("fixture.rs"), source)
        assert [command.name for command in blocking_attribute_sync_commands(commands)] == ["bad"]
        assert [command.is_async_fn for command in commands] == [False, True, False]


def test_sync_tauri_commands_are_allowlisted_and_cheap() -> None:
    commands = iter_tauri_commands()
    sync_commands = {command.name for command in commands if not command.is_async}
    unexpected_sync = sync_commands - SYNC_ALLOWLIST
    stale_allowlist = SYNC_ALLOWLIST - sync_commands

    assert not unexpected_sync, (
        "Sync #[tauri::command] functions must be consciously allowlisted or moved to "
        "an async fn with blocking work offloaded. Unexpected sync commands: "
        + ", ".join(sorted(unexpected_sync))
    )
    assert not stale_allowlist, (
        "SYNC_ALLOWLIST contains commands that are no longer sync. Remove stale entries: "
        + ", ".join(sorted(stale_allowlist))
    )

    offenders: list[str] = []
    for command in commands:
        if command.is_async or command.name not in SYNC_ALLOWLIST:
            continue
        hits = [token for token in BLOCKING_BODY_TOKENS if token in command.body]
        if hits:
            location = f"{command.path.relative_to(REPO_ROOT)}:{command.line}"
            offenders.append(f"{location} {command.name} contains {', '.join(hits)}")

    assert not offenders, (
        "Allowlisted sync #[tauri::command] functions must stay cheap. Use "
        "an async fn with run_blocking for blocking work, or extend the allowlist consciously "
        "with a narrow justification. Offenders: "
        + "; ".join(offenders)
    )

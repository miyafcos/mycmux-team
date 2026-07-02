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
    "get_window_count",
    "reveal_main_window",
    "quit_app",
    "watch_root",
    "unwatch_root",
    "set_buddy_enabled",
    "is_buddy_enabled",
}

BLOCKING_BODY_TOKENS = [
    "std::fs",
    "read_dir",
    "read_to_string",
    "canonicalize",
    "::metadata(",
    "Command::new",
    "sysinfo",
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


def iter_tauri_commands() -> list[TauriCommand]:
    commands: list[TauriCommand] = []
    for path in sorted(RUST_SRC_ROOT.rglob("*.rs")):
        text = read_repo_text(path)
        attrs = list(COMMAND_ATTR_RE.finditer(text))
        for index, attr in enumerate(attrs):
            next_attr_start = attrs[index + 1].start() if index + 1 < len(attrs) else len(text)
            fn = FN_RE.search(text, attr.end(), next_attr_start)
            assert fn is not None, (
                f"{path.relative_to(REPO_ROOT)}:{line_number(text, attr.start())}: "
                "found #[tauri::command] without a following public function"
            )

            args = attr.group("args") or ""
            is_async = "async" in {part.strip() for part in args.split(",")} or bool(fn.group("async"))
            commands.append(
                TauriCommand(
                    name=fn.group("name"),
                    path=path,
                    line=line_number(text, fn.start()),
                    is_async=is_async,
                    body=function_body(text, fn.start(), next_attr_start),
                )
            )
    return commands


def test_sync_tauri_commands_are_allowlisted_and_cheap() -> None:
    commands = iter_tauri_commands()
    sync_commands = {command.name for command in commands if not command.is_async}
    unexpected_sync = sync_commands - SYNC_ALLOWLIST
    stale_allowlist = SYNC_ALLOWLIST - sync_commands

    assert not unexpected_sync, (
        "Sync #[tauri::command] functions must be consciously allowlisted or moved to "
        "#[tauri::command(async)]. Unexpected sync commands: "
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
        "#[tauri::command(async)] for blocking work, or extend the allowlist consciously "
        "with a narrow justification. Offenders: "
        + "; ".join(offenders)
    )

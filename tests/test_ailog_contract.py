"""Contract tests for the AI log analytics command surface.

Two things must stay true for the module to remain safe to call from the UI:

1. Every `ailog_*` command is `#[tauri::command(async)]`. Each one opens SQLite
   and reads from disk, so a sync variant would block the main thread — and
   would force an entry into `test_command_sync_contract.py`'s allowlist, which
   this module is designed never to need.
2. Every command is registered in `lib.rs`'s `invoke_handler`. A command that
   compiles but is not wired up fails only at runtime, from the frontend.
"""

from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUST_SRC_ROOT = REPO_ROOT / "src-tauri" / "src"
AILOG_COMMANDS = RUST_SRC_ROOT / "commands" / "ailog.rs"
AILOG_MODULE = RUST_SRC_ROOT / "ailog"
LIB_RS = RUST_SRC_ROOT / "lib.rs"

COMMAND_ATTR_RE = re.compile(r"#\s*\[\s*tauri::command(?:\((?P<args>[^\]]*)\))?\s*\]")
FN_RE = re.compile(r"(?m)^\s*pub\s+(?P<async>async\s+)?fn\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(")

# Every command named in the F1 spec, plus the argument-shape sanity checks.
EXPECTED_COMMANDS = {
    "ailog_index_start",
    "ailog_index_cancel",
    "ailog_index_status",
    "ailog_summarize_start",
    "ailog_summarize_cancel",
    "ailog_summarize_status",
    "ailog_digest_get",
    "ailog_digest_generate",
    "ailog_dashboard",
    "ailog_overview",
    "ailog_series",
    "ailog_breakdown",
    "ailog_sessions",
    "ailog_session_detail",
    "ailog_session_transcript",
    "ailog_session_summarize",
    "ailog_models",
    "ailog_efficiency",
    "ailog_rule_check",
    "ailog_findings",
    "ailog_rework_rankings",
    "ailog_usage_rhythm",
    "ailog_get_prices",
    "ailog_set_price",
}


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def iter_ailog_commands() -> list[tuple[str, bool]]:
    """Return `(name, is_async)` for every `#[tauri::command]` in ailog.rs."""
    text = read(AILOG_COMMANDS)
    attrs = list(COMMAND_ATTR_RE.finditer(text))
    commands: list[tuple[str, bool]] = []
    for index, attr in enumerate(attrs):
        next_start = attrs[index + 1].start() if index + 1 < len(attrs) else len(text)
        fn = FN_RE.search(text, attr.end(), next_start)
        assert fn is not None, (
            f"commands/ailog.rs: #[tauri::command] at offset {attr.start()} "
            "is not followed by a public function"
        )
        args = attr.group("args") or ""
        is_async = "async" in {part.strip() for part in args.split(",")} or bool(fn.group("async"))
        commands.append((fn.group("name"), is_async))
    return commands


def test_every_ailog_command_is_async() -> None:
    commands = iter_ailog_commands()
    assert commands, "no #[tauri::command] found in commands/ailog.rs"

    sync_commands = sorted(name for name, is_async in commands if not is_async)
    assert not sync_commands, (
        "ailog commands must be #[tauri::command(async)] — they all open SQLite and "
        "read from disk. Sync offenders: " + ", ".join(sync_commands)
    )


def test_expected_commands_exist() -> None:
    found = {name for name, _ in iter_ailog_commands()}
    missing = EXPECTED_COMMANDS - found
    assert not missing, "missing ailog commands: " + ", ".join(sorted(missing))


def test_every_ailog_command_is_registered_in_the_invoke_handler() -> None:
    lib_text = read(LIB_RS)
    handler_start = lib_text.find("invoke_handler(tauri::generate_handler![")
    assert handler_start != -1, "lib.rs has no invoke_handler"
    handler_end = lib_text.find("])", handler_start)
    assert handler_end != -1, "lib.rs invoke_handler is not terminated"
    handler = lib_text[handler_start:handler_end]

    unregistered = [
        name
        for name, _ in iter_ailog_commands()
        if f"commands::ailog::{name}" not in handler
    ]
    assert not unregistered, (
        "ailog commands defined but not registered in lib.rs invoke_handler: "
        + ", ".join(sorted(unregistered))
    )


def test_module_is_declared() -> None:
    assert "pub mod ailog;" in read(LIB_RS), "lib.rs must declare `pub mod ailog;`"
    assert "pub mod ailog;" in read(RUST_SRC_ROOT / "commands" / "mod.rs"), (
        "commands/mod.rs must declare `pub mod ailog;`"
    )


def test_module_files_exist() -> None:
    """The spec's file layout is part of the contract, not an accident."""
    expected = [
        "mod.rs",
        "schema.rs",
        "index.rs",
        "parse_claude.rs",
        "parse_codex.rs",
        "metrics.rs",
        "price.rs",
        "query.rs",
        "summarize.rs",
        "digest.rs",
    ]
    missing = [name for name in expected if not (AILOG_MODULE / name).is_file()]
    assert not missing, "missing ailog module files: " + ", ".join(missing)


def test_costs_are_labelled_as_estimates() -> None:
    """Every aggregation response must carry the price provenance.

    The operator is on flat-rate plans, so a bare dollar figure would be read
    as a bill. `price_source` plus `price_coverage` tells the UI how much of
    the token volume has a known metered-equivalent cost.
    """
    query_text = read(AILOG_MODULE / "query.rs")
    for field in ("price_source", "price_coverage", "cost_note"):
        assert f"pub {field}:" in query_text, f"query.rs must expose `{field}`"


def test_legacy_unpriced_banner_text_is_absent_from_source() -> None:
    """The zero-configuration policy must not leave a reachable old warning."""
    source_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (REPO_ROOT / "src").rglob("*.*")
        if path.is_file() and path.suffix in {".ts", ".tsx", ".css"}
    )
    for legacy in ("公表料率が登録されていない", "単価未設定:", "$0 で計上"):
        assert legacy not in source_text, f"legacy price warning remains in src/: {legacy}"


def test_unknown_models_are_never_priced_by_substitution() -> None:
    """`price.rs` must not fall back to a neighbouring model's rate."""
    price_text = read(AILOG_MODULE / "price.rs")
    assert "fn cost_for_turn" in price_text
    # The `None` price arm has to return an empty split rather than a default
    # rate; catching this here keeps a later "helpful" refactor honest.
    assert "let Some(price) = price else {" in price_text, (
        "cost_for_turn must return a zero split for an unpriced model"
    )
    assert "return CostSplit::default();" in price_text


def test_summarizer_cancellation_tracks_every_parallel_child() -> None:
    """A two-worker pass must drain a shared child registry, not one slot."""
    text = read(AILOG_COMMANDS)
    summary_text = read(AILOG_MODULE / "summarize.rs")
    assert "children: summarize::ChildRegistry" in text
    assert "std::mem::take(&mut *state\n        .children" in text
    assert "for (_, child) in children" in text
    assert "let worker_children = children.clone();" in summary_text
    assert "let local_child" not in summary_text

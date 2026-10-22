from pathlib import Path
import re

import pytest


ROOT = Path(__file__).resolve().parents[1]
RUST_ROOT = ROOT / "src-tauri" / "src"
MODEL_IDS = (
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "gpt-6-astra",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-fable-5",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
)


def allowed_model_path(path: Path) -> bool:
    relative = path.relative_to(RUST_ROOT).as_posix()
    return relative in {"ai/mod.rs", "ai/tests.rs", "ailog/price.rs"} or relative.startswith("ailog/tests/")


def test_ai_models_are_centralized() -> None:
    for path in RUST_ROOT.rglob("*.rs"):
        source = path.read_text(encoding="utf-8")
        for model in MODEL_IDS:
            if model in source:
                assert allowed_model_path(path), f"{path}: hardcoded model {model}"


def test_ai_command_building_is_centralized() -> None:
    for path in RUST_ROOT.rglob("*.rs"):
        source = path.read_text(encoding="utf-8")
        relative = path.relative_to(RUST_ROOT).as_posix()
        is_ai_module = relative.startswith("ai/")
        for token in ('"--model"', "codex_program", '"codex.cmd"', 'prepare_spawn_command("claude"'):
            # PTY launch/restore forwards the user's saved model; it does not
            # select a model for the application's internal AI calls.
            is_saved_pty_model = relative == "commands/terminal.rs" and token == '"--model"'
            # Hook attribution parses provider argv and skips option values;
            # it does not construct an AI command or select a model.
            is_provider_argv_parse = relative == "agent_state/hook_source.rs" and token == '"--model"'
            # Like hook attribution, exact restore parses provider argv and
            # skips option values (also covered by its parser test vectors).
            # This parser does not construct an AI command or select a model. Limit
            # this exception to this file and this single option token.
            is_codex_restore_argv_parse = relative == "commands/terminal/codex_restore.rs" and token == '"--model"'
            assert token not in source or is_ai_module or is_saved_pty_model or is_provider_argv_parse or is_codex_restore_argv_parse, f"{path}: centralized AI command token {token}"


def sql_model_literals(source: str) -> list[str]:
    allowed_identity_literals = {"claude-codex", "claude-uuid:*", "claude-exec:*"}
    return [value for value in re.findall(r"'((?:gpt-|claude-)[^'\r\n]*)'", source)
            if value not in allowed_identity_literals]


def test_sql_model_literals_are_forbidden() -> None:
    for path in RUST_ROOT.rglob("*.rs"):
        source = path.read_text(encoding="utf-8")
        if allowed_model_path(path):
            continue
        assert not sql_model_literals(source), f"{path}: SQL model literal"


@pytest.mark.parametrize("model", MODEL_IDS)
def test_sql_model_detector_still_rejects_models(model: str) -> None:
    assert sql_model_literals(f"WHERE model='{model}'") == [model]


def test_sql_model_detector_distinguishes_exact_usage_identity_literals() -> None:
    assert not sql_model_literals("kind='claude-codex' AND execution_key GLOB 'claude-exec:*'")
    assert sql_model_literals("model='claude-unknown' OR model='gpt-future'") == ["claude-unknown", "gpt-future"]

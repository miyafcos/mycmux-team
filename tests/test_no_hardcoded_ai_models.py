from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUST_ROOT = ROOT / "src-tauri" / "src"
MODEL_IDS = (
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
            assert token not in source or is_ai_module, f"{path}: centralized AI command token {token}"


def test_sql_model_literals_are_forbidden() -> None:
    for path in RUST_ROOT.rglob("*.rs"):
        source = path.read_text(encoding="utf-8")
        if allowed_model_path(path):
            continue
        assert "'gpt-" not in source, f"{path}: SQL model literal"
        assert "'claude-" not in source, f"{path}: SQL model literal"

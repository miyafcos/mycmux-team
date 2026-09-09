from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN = ("claude", "codex", "grok", "agy", "antigravity", "hermes", "agentkind")
TARGETS = ("src/lib/promptShape.ts", "src/lib/stallVerdict.ts")


def test_stall_path_remains_agent_kind_independent() -> None:
    for relative_path in TARGETS:
        contents = (REPO_ROOT / relative_path).read_text(encoding="utf-8").casefold()
        for forbidden in FORBIDDEN:
            assert forbidden not in contents, f"{relative_path} contains forbidden token {forbidden!r}"

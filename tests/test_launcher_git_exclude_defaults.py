"""Keep the default exclusions of new git-parents rules identical in Rust and TypeScript.

Requirements section 5.1 lists them once; `rules.rs::seed_defaults` (first-run ledger) and
`launcherDirsModel.ts::ruleForm` (new-rule form in the settings tab) each carry a copy.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("MYCMUX_CONTRACT_ROOT") or Path(__file__).resolve().parents[1])
RULES_RS = ROOT / "src-tauri" / "src" / "launcher_dirs" / "rules.rs"
MODEL_TS = ROOT / "src" / "lib" / "launcherDirsModel.ts"

EXPECTED = {
    "PREFIXES": ["_", ".", "~$"],
    "NAMES": ["AppData", "Dropbox", "OneDrive"],
    "SUBSTRINGS": ["backup"],
}
STRING = r'"((?:[^"\\]|\\.)*)"'


def rust_list(name: str) -> list[str]:
    source = RULES_RS.read_text(encoding="utf-8")
    pattern = r"pub const DEFAULT_GIT_EXCLUDE_" + name + r": \[&str; \d+\] = \[(?P<body>[^\]]*)\];"
    match = re.search(pattern, source)
    assert match is not None, f"missing Rust constant DEFAULT_GIT_EXCLUDE_{name}"
    return re.findall(STRING, match.group("body"))


def ts_list(name: str) -> list[str]:
    source = MODEL_TS.read_text(encoding="utf-8")
    pattern = r"export const DEFAULT_GIT_EXCLUDE_" + name + r" = \[(?P<body>[^\]]*)\];"
    match = re.search(pattern, source)
    assert match is not None, f"missing TypeScript constant DEFAULT_GIT_EXCLUDE_{name}"
    return re.findall(STRING, match.group("body"))


def test_git_exclude_defaults_match_the_requirements_in_rust_and_typescript() -> None:
    for name, expected in EXPECTED.items():
        assert rust_list(name) == expected, name
        assert ts_list(name) == expected, name

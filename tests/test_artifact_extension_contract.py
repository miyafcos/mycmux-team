"""The two halves of the previewable-extension list have to agree.

The backend refuses anything outside `is_previewable_artifact`, and the front
end decides whether a path in terminal output is underlined at all from
`ARTIFACT_EXTENSION_PATTERN`. When they drift, a link looks clickable and then
fails on the click, which is how a whole class of "nothing happened" reports
used to start.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RUST_SOURCE = REPO_ROOT / "src-tauri/src/commands/artifact/mod.rs"
TS_SOURCE = REPO_ROOT / "src/lib/artifactSourceKind.ts"

# Files that are not documents. If one of these ever starts matching, the
# pattern has been widened past what the backend will actually open.
NOT_PREVIEWABLE = ["zip", "csv", "json", "png", "jpg", "svg", "mp4", "exe", "rs", "ts"]


def previewable_extensions_from_rust() -> list[str]:
    source = RUST_SOURCE.read_text(encoding="utf-8")
    start = source.index("fn is_previewable_artifact")
    end = source.index("fn artifact_source_kind", start)
    return re.findall(r'Some\("([a-z0-9]+)"\)', source[start:end])


def extension_pattern_from_typescript() -> str:
    source = TS_SOURCE.read_text(encoding="utf-8")
    match = re.search(r"ARTIFACT_EXTENSION_PATTERN = String\.raw`([^`]+)`", source)
    assert match, "ARTIFACT_EXTENSION_PATTERN not found in " + str(TS_SOURCE)
    return match.group(1)


def test_every_previewable_extension_is_detected_in_the_terminal() -> None:
    extensions = previewable_extensions_from_rust()
    assert len(extensions) >= 30, extensions
    pattern = re.compile(f"^(?:{extension_pattern_from_typescript()})$", re.IGNORECASE)
    missing = [extension for extension in extensions if not pattern.match(extension)]
    assert not missing, f"the terminal will not offer these: {missing}"


def test_the_terminal_does_not_offer_what_the_backend_refuses() -> None:
    pattern = re.compile(f"^(?:{extension_pattern_from_typescript()})$", re.IGNORECASE)
    offered = [extension for extension in NOT_PREVIEWABLE if pattern.match(extension)]
    assert not offered, f"clicking these would fail: {offered}"


def test_plain_text_is_previewable_on_both_sides() -> None:
    # The reason this contract exists: .txt was clickable-looking for a long
    # time and opened nothing.
    extensions = previewable_extensions_from_rust()
    for extension in ("txt", "text", "log"):
        assert extension in extensions, extension


def test_the_kind_table_lives_in_one_module() -> None:
    # Both stores and the link provider used to carry their own copy.
    for relative in ("src/stores/workspaceLayoutStore.ts", "src/stores/dashboardViewStore.ts"):
        source = (REPO_ROOT / relative).read_text(encoding="utf-8")
        assert "lib/artifactSourceKind" in source, relative
        assert "xltx?|xltm" not in source, f"{relative} still spells the table out"

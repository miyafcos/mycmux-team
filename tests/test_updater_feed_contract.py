"""Contract test for the Tauri updater feed normalization.

Codifies the invariant that used to live only in a human's memory (and caused
the 0.9.x dual-install split-brain): the plain "windows-x86_64" platform key
in latest.json must always carry the same signature/url as the
"windows-x86_64-nsis" entry. scripts/normalize-updater-feed.ps1 is the single
place that enforces this for both the master and lite updater feeds; this
test exercises it directly against a fixture shaped like a real (pre-mirror)
tauri-action latest.json. No network access is used -- everything is local.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
NORMALIZE_SCRIPT = REPO_ROOT / "scripts" / "normalize-updater-feed.ps1"
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "latest_raw_prenormalize.json"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32", reason="normalize-updater-feed.ps1 requires Windows PowerShell"
)


def run_normalize(input_path: Path, output_path: Path) -> None:
    result = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            str(NORMALIZE_SCRIPT),
            "-InputPath",
            str(input_path),
            "-OutputPath",
            str(output_path),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"normalize-updater-feed.ps1 failed (exit {result.returncode}):\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )


def test_fixture_reflects_the_real_bug_shape_before_normalization() -> None:
    """Sanity check that the fixture is not already normalized: otherwise the
    contract test below would pass vacuously."""
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    plain = raw["platforms"]["windows-x86_64"]
    nsis = raw["platforms"]["windows-x86_64-nsis"]
    assert plain != nsis, (
        "fixture must start in the pre-normalization (buggy) shape, where the "
        "plain windows-x86_64 key does not yet match windows-x86_64-nsis"
    )


def test_normalize_updater_feed_makes_plain_key_match_nsis_entry(tmp_path: Path) -> None:
    output_path = tmp_path / "latest.normalized.json"
    run_normalize(FIXTURE, output_path)

    normalized = json.loads(output_path.read_text(encoding="utf-8"))
    platforms = normalized["platforms"]

    assert platforms["windows-x86_64"]["signature"] == platforms["windows-x86_64-nsis"]["signature"]
    assert platforms["windows-x86_64"]["url"] == platforms["windows-x86_64-nsis"]["url"]

    # The normalization must not silently repoint the fallback key at the MSI.
    assert platforms["windows-x86_64"]["url"] != platforms["windows-x86_64-msi"]["url"]


def test_normalize_updater_feed_leaves_other_platform_entries_untouched(tmp_path: Path) -> None:
    output_path = tmp_path / "latest.normalized.json"
    run_normalize(FIXTURE, output_path)

    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    normalized = json.loads(output_path.read_text(encoding="utf-8"))

    assert normalized["version"] == raw["version"]
    assert normalized["platforms"]["windows-x86_64-nsis"] == raw["platforms"]["windows-x86_64-nsis"]
    assert normalized["platforms"]["windows-x86_64-msi"] == raw["platforms"]["windows-x86_64-msi"]


def test_normalize_updater_feed_fails_closed_without_nsis_entry(tmp_path: Path) -> None:
    broken = tmp_path / "latest.no-nsis.json"
    broken.write_text(
        json.dumps(
            {
                "version": "0.9.5",
                "platforms": {
                    "windows-x86_64-msi": {"signature": "sig", "url": "https://example.invalid/x.msi"}
                },
            }
        ),
        encoding="utf-8",
    )
    output_path = tmp_path / "latest.normalized.json"

    result = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            str(NORMALIZE_SCRIPT),
            "-InputPath",
            str(broken),
            "-OutputPath",
            str(output_path),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0, "normalize script must fail closed when the nsis entry is missing"
    assert "windows-x86_64-nsis" in result.stderr

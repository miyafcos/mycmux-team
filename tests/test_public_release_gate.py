"""The committed tree passes the private release gate before any release step.

Every release runs this suite before it tags, so a private word committed to a
public-bound file stops the release here rather than at the mirror push, when
the tag and the updater feed would already be out. The public mirror carries
no policy directory, so there the check is skipped.
"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "scripts" / "public_export"


@pytest.mark.skipif(not (POLICY / "release_gate.txt").is_file(),
                    reason="private release policy is not part of this checkout")
def test_head_export_passes_the_release_gate():
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "public_export.py"), "--rev", "HEAD", "--check"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=600,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"},
    )
    # Locations are redacted; `python scripts/public_export.py --rev HEAD --check`
    # prints the same list locally.
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.startswith("release gate PASS ")

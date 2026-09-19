"""The release script must not read anything two sessions share.

One repository is worked by more than one session at a time. The local `master`
branch is shared between them, so anything the release reads from it is
whatever the other session happened to commit -- not what is being released.
Both holes below were live on 2026-09-19: the main tree carried an unreleased
v0.77.0 while v0.76.1 shipped from a detached worktree.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts/release-local.ps1"


def script() -> str:
    return SCRIPT.read_text(encoding="utf-8")


def test_the_worktree_guard_asks_about_the_published_branch() -> None:
    text = script()
    assert "--is-ancestor origin/master HEAD" in text, (
        "the guard must measure against origin/master; the local master is shared"
    )
    assert "--is-ancestor master HEAD" not in text.replace("--is-ancestor origin/master HEAD", ""), (
        "no path may still ask about the local master"
    )
    # It has to be current before it is asked.
    fetch = text.index('"fetch", "origin", "master"')
    ancestor = text.index("--is-ancestor origin/master HEAD")
    assert fetch < ancestor, "origin/master is fetched before it is used as the floor"


def test_the_public_mirror_exports_the_thing_being_released() -> None:
    text = script()
    assert '"--rev", $tag, "--tree-object"' in text, (
        "the mirror must export the tag, not a branch another session can move"
    )
    assert '"--rev", "master"' not in text, "no path may still export the local master"


def test_the_suites_run_under_both_collations() -> None:
    text = script()
    # Once bare, so a hole in the environment operators actually run is seen,
    # and once pinned, so a hole that only shows off UTF-8 is seen too.
    assert len(re.findall(r'"-m", "pytest", "tests/"', text)) == 2, (
        "the suite runs exactly twice: once bare, once pinned"
    )
    pinned = text.index('$env:LC_ALL = "C"')
    bare = text.index('(inherited locale)')
    assert bare < pinned, "the bare run comes first, so a real failure is seen before a portability one"
    assert "$previousLcAll" in text, "the pin must be undone afterwards"
    restore = text.index("$env:LC_ALL = $previousLcAll")
    assert "finally" in text[max(0, restore - 200):restore], (
        "the locale must be restored even when the run fails"
    )


def test_the_reasons_are_written_down_where_the_code_is() -> None:
    # These three are the kind that read as pointless tidying to whoever comes
    # next, so each one says what it is standing in the way of.
    text = script()
    for needle in ("origin/master", "U+212A", "v0.77.0"):
        assert needle in text, f"the comment explaining {needle} is gone"

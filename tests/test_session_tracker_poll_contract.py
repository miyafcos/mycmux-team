"""Contract for the launcher's pane -> agent-session tracker.

The tracker guesses which freshly written log belongs to the pane it just
launched. Two properties have to hold together:

* it must keep waiting long enough for a human to finish choosing in the
  ``--resume`` picker (the old fixed 4s wait expired first, so no mapping was
  ever written and the pane's chat column stayed empty), and
* it must stay bounded, and it must never map a pane onto a session it cannot
  prove belongs to it -- zero or several candidates yield nothing.

The decision logic lives in an embedded python block and a bash polling loop
inside ``src-tauri/src/launcher.sh``; both are extracted here and driven
directly. Everything runs against temporary directories: the tracker only ever
reads the real ``~/.mycmux/pane-sessions``, and these tests never point at it.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
LAUNCHER_SH = REPO_ROOT / "src-tauri" / "src" / "launcher.sh"
SESSION = "11111111-2222-3333-4444-555555555555"
OTHER_SESSION = "99999999-8888-7777-6666-555555555555"


def launcher_text() -> str:
    return LAUNCHER_SH.read_text(encoding="utf-8")


def extract_single_unclaimed_python() -> str:
    """The `exactly one unclaimed candidate` decision, as a runnable script."""
    text = launcher_text()
    marker = text.index('MYCMUX_TRACK_DIR="$dir"')
    body = re.search(r"<<'PY'.*?\n(.*?)\nPY\n", text[marker:], re.DOTALL)
    assert body, "the tracker's python block moved; update this test"
    return body.group(1)


def extract_shell_function(name: str) -> str:
    text = launcher_text()
    body = re.search(rf"^{re.escape(name)}\(\) \{{\n.*?\n\}}\n", text, re.DOTALL | re.MULTILINE)
    assert body, f"{name} moved; update this test"
    return body.group(0)


def write_claude_log(project_dir: Path, session_id: str, cwd: Path) -> Path:
    path = project_dir / f"{session_id}.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"type": "last-prompt"}),
                json.dumps({"type": "user", "cwd": str(cwd), "sessionId": session_id}),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    return path


def run_tracker_decision(
    project_dir: Path,
    launch_cwd: Path,
    runtime_dir: Path,
    since: float,
    pane_id: str = "pane-under-test",
) -> str:
    env = dict(os.environ)
    env.update(
        {
            "PYTHONIOENCODING": "utf-8",
            "MYCMUX_TRACK_DIR": str(project_dir),
            "MYCMUX_TRACK_PATTERN": "*.jsonl",
            "MYCMUX_TRACK_SINCE": str(since),
            "MYCMUX_TRACK_DEPTH": "1",
            "MYCMUX_TRACK_PANE_ID": pane_id,
            "MYCMUX_TRACK_KIND": "claude",
            "MYCMUX_TRACK_CWD": str(launch_cwd),
            "MYCMUX_TRACK_RUNTIME_DIR": str(runtime_dir),
        }
    )
    completed = subprocess.run(
        [sys.executable, "-c", extract_single_unclaimed_python()],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return completed.stdout.strip()


@pytest.fixture()
def tracker_dirs(tmp_path: Path) -> tuple[Path, Path, Path]:
    project_dir = tmp_path / "projects" / "C--work"
    project_dir.mkdir(parents=True)
    runtime_dir = tmp_path / "runtime"
    (runtime_dir / "pane-sessions").mkdir(parents=True)
    launch_cwd = tmp_path / "work"
    launch_cwd.mkdir()
    return project_dir, launch_cwd, runtime_dir


def test_tracker_maps_a_single_unclaimed_session(tracker_dirs) -> None:
    project_dir, launch_cwd, runtime_dir = tracker_dirs
    write_claude_log(project_dir, SESSION, launch_cwd)

    assert (
        run_tracker_decision(project_dir, launch_cwd, runtime_dir, time.time() - 60) == SESSION
    )


def test_tracker_writes_nothing_when_two_candidates_match(tracker_dirs) -> None:
    project_dir, launch_cwd, runtime_dir = tracker_dirs
    write_claude_log(project_dir, SESSION, launch_cwd)
    write_claude_log(project_dir, OTHER_SESSION, launch_cwd)

    assert run_tracker_decision(project_dir, launch_cwd, runtime_dir, time.time() - 60) == ""


def test_tracker_skips_a_session_another_pane_already_claims(tracker_dirs) -> None:
    project_dir, launch_cwd, runtime_dir = tracker_dirs
    write_claude_log(project_dir, SESSION, launch_cwd)
    write_claude_log(project_dir, OTHER_SESSION, launch_cwd)
    (runtime_dir / "pane-sessions" / "another-pane.txt").write_text(
        f"claude:{OTHER_SESSION}\n", encoding="utf-8"
    )

    assert (
        run_tracker_decision(project_dir, launch_cwd, runtime_dir, time.time() - 60) == SESSION
    )


def test_tracker_ignores_logs_that_predate_the_launch(tracker_dirs) -> None:
    project_dir, launch_cwd, runtime_dir = tracker_dirs
    write_claude_log(project_dir, SESSION, launch_cwd)

    assert run_tracker_decision(project_dir, launch_cwd, runtime_dir, time.time() + 60) == ""


def test_tracker_ignores_logs_recorded_for_another_directory(tracker_dirs) -> None:
    project_dir, launch_cwd, runtime_dir = tracker_dirs
    write_claude_log(project_dir, SESSION, launch_cwd.parent / "elsewhere")

    assert run_tracker_decision(project_dir, launch_cwd, runtime_dir, time.time() - 60) == ""


def test_launcher_tracking_uses_a_bounded_poll_not_a_fixed_wait() -> None:
    text = launcher_text()
    poll = extract_shell_function("__poll_single_unclaimed_session")

    # The fixed wait that expired before the picker was answered is gone.
    assert "\n  sleep 4\n" not in text
    # The loop is bounded in both directions: an interval it sleeps on, and a
    # timeout it gives up at. Neither may become an unbounded wait.
    assert "__MYCMUX_TRACK_INTERVAL:-" in poll
    assert "__MYCMUX_TRACK_TIMEOUT:-" in poll
    assert '-ge "$timeout"' in poll
    assert "return 1" in poll
    # The launcher inherits the pane environment, so a junk override must not be
    # able to turn the bound test into an error and the loop into a hang.
    assert "*[!0-9]*) interval=2" in poll
    assert "*[!0-9]*) timeout=120" in poll
    # Trackers still run in the background, so a slow poll cannot delay a launch.
    for tracker in ("__track_claude_session", "__track_claude_codex_session", "__track_codex_session"):
        assert re.search(rf"{tracker} \"\$[A-Za-z_]+\" &", text), tracker


def find_bash() -> str | None:
    """A bash that can actually run a script.

    `bash` on PATH is System32\\bash.exe on this platform -- the WSL shim, which
    fails with `execvpe(/bin/bash)` when WSL has no distribution installed. Try
    the Git for Windows shells first and smoke-test whichever one is found.
    """
    candidates = [
        os.environ.get("MYCMUX_TEST_BASH"),
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        shutil.which("bash"),
    ]
    for candidate in candidates:
        if not candidate or not Path(candidate).exists():
            continue
        try:
            probe = subprocess.run(
                [candidate, "-c", "echo mycmux-bash-ok"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
            )
        except OSError:
            continue
        if probe.returncode == 0 and "mycmux-bash-ok" in probe.stdout:
            return candidate
    return None


BASH = find_bash()


def run_poll_loop(
    tmp_path: Path,
    hit_at: int,
    timeout_seconds: int,
    interval: str = "1",
    timeout_override: str | None = None,
) -> tuple[str, float]:
    counter = tmp_path / "stub-calls"
    script = tmp_path / "poll.sh"
    script.write_text(
        "\n".join(
            [
                "set -u",
                # Stand-in for the real candidate scan: report nothing until the
                # picker has been answered, i.e. from the Nth poll onwards.
                "__single_unclaimed_session_since() {",
                '  local n',
                f'  n=$(cat "{counter.as_posix()}" 2>/dev/null || echo 0)',
                "  n=$((n + 1))",
                f'  printf %s "$n" > "{counter.as_posix()}"',
                '  if [ "$n" -ge "$STUB_HIT_AT" ]; then',
                f'    printf "%s\\n" "{SESSION}"',
                "  fi",
                "}",
                extract_shell_function("__poll_single_unclaimed_session"),
                'if out=$(__poll_single_unclaimed_session dir "*.jsonl" 0 1 pane claude cwd); then',
                '  printf "OK:%s\\n" "$out"',
                "else",
                '  printf "GAVE_UP\\n"',
                "fi",
                "",
            ]
        ),
        encoding="utf-8",
        newline="\n",
    )
    env = dict(os.environ)
    env.update(
        {
            "STUB_HIT_AT": str(hit_at),
            "__MYCMUX_TRACK_INTERVAL": interval,
            "__MYCMUX_TRACK_TIMEOUT": timeout_override
            if timeout_override is not None
            else str(timeout_seconds),
        }
    )
    started = time.monotonic()
    completed = subprocess.run(
        [BASH, str(script)],
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    return completed.stdout.strip(), time.monotonic() - started


needs_bash = pytest.mark.skipif(BASH is None, reason="no usable bash found")


@needs_bash
def test_poll_finds_a_session_that_appears_after_the_old_four_second_window(tmp_path: Path) -> None:
    # The picker is answered on the 5th poll, i.e. past the 4s the old fixed
    # wait allowed. The mapping must still be written.
    output, elapsed = run_poll_loop(tmp_path, hit_at=5, timeout_seconds=30)

    assert output == f"OK:{SESSION}"
    assert elapsed > 4


@needs_bash
def test_poll_gives_up_at_the_bound(tmp_path: Path) -> None:
    # Nothing ever appears (the picker was abandoned): the tracker gives up
    # instead of waiting forever, and writes no mapping.
    output, elapsed = run_poll_loop(tmp_path, hit_at=10_000, timeout_seconds=3)

    assert output == "GAVE_UP"
    assert elapsed < 30


@needs_bash
def test_poll_stays_bounded_when_the_environment_supplies_junk(tmp_path: Path) -> None:
    # An inherited `__MYCMUX_TRACK_TIMEOUT=forever` must fall back to a number
    # rather than making the bound test error out and the loop spin.
    output, elapsed = run_poll_loop(
        tmp_path,
        hit_at=2,
        timeout_seconds=3,
        interval="not-a-number",
        timeout_override="forever",
    )

    assert output == f"OK:{SESSION}"
    assert elapsed < 30

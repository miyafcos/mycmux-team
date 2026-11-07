"""Acceptance and edge cases for the read-only seat_watch CLI."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

import pytest

import seat_watch as watch


@pytest.fixture
def tmp_path():
    """Keep every new-test mutation inside a tempfile-managed directory."""
    with tempfile.TemporaryDirectory(dir=str(watch.fs_path(tempfile.gettempdir())),
                                     prefix="seat_watch_test_") as directory:
        yield Path(directory)


def write(path: Path, content: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(content)
    actual = path.read_text(encoding="utf-8")
    assert actual == content and "\ufffd" not in actual


def seat(root: Path, name: str = "席 one", content: str | None = "## old\n") -> Path:
    path = root / name
    path.mkdir()
    if content is not None:
        write(path / "DONE.md", content)
    return path


def fingerprint(root: Path) -> dict:
    return {str(p.relative_to(root)): (p.stat().st_size, hashlib.sha256(p.read_bytes()).hexdigest())
            for p in root.rglob("*") if p.is_file()}


def run(args: list[str], capsys) -> tuple[int, str, str]:
    code = watch.main(args)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def threaded_wait(path: Path, action, monkeypatch, capsys, *extra: str):
    ready = threading.Event()
    errors = []
    original = watch.snapshot

    def snapshot(*args, **kwargs):
        result = original(*args, **kwargs)
        ready.set()
        return result

    def worker():
        try:
            assert ready.wait(5), "initial snapshot was not taken"
            action()
        except BaseException as error:
            errors.append(error)

    monkeypatch.setattr(watch, "snapshot", snapshot)
    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    try:
        result = run(["wait", "--seat", str(path), "--poll-sec", "0.2",
                      "--timeout-min", "0.1", *extra], capsys)
    finally:
        thread.join(3)
    assert not thread.is_alive()
    assert not errors
    return result


def test_status_two_seats_and_last_heading(tmp_path, capsys):
    content = "# title\n## first\nbody_should_not_be_printed\n### ignored\n ## ignored\n## 最後の見出し\n"
    first = seat(tmp_path, content=content)
    second = seat(tmp_path, "席 two", None)
    before = fingerprint(tmp_path)
    code, out, err = run(["status", "--seat", str(first), "--seat", str(second)], capsys)
    rows = out.splitlines()
    assert code == 0 and not err and len(rows) == 2
    assert f"{first.name} DONE=YES" in rows[0]
    assert f"bytes={(first / 'DONE.md').stat().st_size}" in rows[0]
    assert "headings=2 latest=最後の見出し" in rows[0]
    assert "mtime=" in rows[0] and "age=" in rows[0]
    assert f"{second.name} DONE=NO mtime=- age=- bytes=0 headings=0 latest=-" == rows[1]
    assert "body_should_not_be_printed" not in out
    assert fingerprint(tmp_path) == before


def test_latest_marker_precedes_last_and_is_limited_to_60(tmp_path, capsys):
    heading = "先頭 (これが最新) " + "長" * 90
    path = seat(tmp_path, content=f"## {heading}\n## older\n## last\n")
    code, out, err = run(["status", "--seat", str(path), "--json"], capsys)
    row = json.loads(out)["seats"][0]
    assert code == 0 and not err
    assert row["latest_heading"] == heading[:60]
    assert row["heading_count"] == 3


def test_utf8_bom_and_invalid_bytes_are_supported(tmp_path, capsys):
    path = seat(tmp_path, content=None)
    (path / "DONE.md").write_bytes(b"\xef\xbb\xbf## first\n## broken \xff\n")
    code, out, err = run(["status", "--seat", str(path), "--json"], capsys)
    row = json.loads(out)["seats"][0]
    assert code == 0 and not err
    assert row["heading_count"] == 2 and row["latest_heading"] == "broken \ufffd"


@pytest.mark.parametrize("command", ["status", "wait"])
def test_missing_seat_is_one_error_and_reads_nothing(tmp_path, monkeypatch, capsys, command):
    path = seat(tmp_path)

    def forbidden(*args, **kwargs):
        pytest.fail("missing seats must be rejected before reading DONE/state/globs")

    monkeypatch.setattr(watch, "snapshot", forbidden)
    monkeypatch.setattr(watch, "load_state", forbidden)
    monkeypatch.setattr(watch.glob, "iglob", forbidden)
    code, out, err = run([command, "--seat", str(path), "--seat", str(tmp_path / "missing"),
                          "--watch", str(tmp_path / "*"), "--state", str(tmp_path / "state.json")], capsys)
    assert code == 2 and out == "" and len(err.splitlines()) == 1
    assert "missing" in err and "does not exist" in err


def test_slug_uses_dispatch_root(tmp_path, monkeypatch, capsys):
    path = seat(tmp_path, "sample-slug")
    monkeypatch.setattr(watch, "DISPATCH_ROOT", tmp_path)
    code, out, err = run(["status", "--seat", path.name], capsys)
    assert code == 0 and not err and out.startswith("sample-slug DONE=YES")


def test_status_json_matches_text_fields_and_stays_on_one_line(tmp_path, capsys):
    path = seat(tmp_path, content="## 見出し\n")
    ready = tmp_path / "日本語 ready files"
    ready.mkdir()
    file = ready / "新しい_ready.json"
    write(file, "{}")
    args = ["status", "--seat", str(path), "--watch", str(ready / "*_ready.json")]
    code, out, err = run([*args, "--json"], capsys)
    data = json.loads(out)
    assert code == 0 and not err and len(out.splitlines()) == 1
    assert data["seats"][0]["latest_heading"] == "見出し"
    assert data["watches"][0]["count"] == 1
    assert data["watches"][0]["latest_file"] == file.name
    _, table, _ = run(args, capsys)
    assert len(table.splitlines()) == 2
    assert "latest=見出し" in table and f"latest={file.name}" in table


def test_watch_counts_only_files_and_uses_newest_time(tmp_path, capsys):
    path = seat(tmp_path)
    old = tmp_path / "old_ready.json"
    new = tmp_path / "new_ready.json"
    write(old, "{}")
    write(new, "{}")
    (tmp_path / "directory_ready.json").mkdir()
    epoch = 1_750_000_000
    os.utime(old, (epoch, epoch))
    os.utime(new, (epoch + 600, epoch + 600))
    code, out, err = run(["status", "--seat", str(path),
                          "--watch", str(tmp_path / "*_ready.json"), "--json"], capsys)
    row = json.loads(out)["watches"][0]
    assert code == 0 and not err and row["count"] == 2
    assert row["latest_file"] == new.name
    assert row["mtime"] == watch.datetime.fromtimestamp(epoch + 600).strftime("%m/%d %H:%M")


def test_empty_glob_has_one_status_row(tmp_path, capsys):
    path = seat(tmp_path)
    code, out, err = run(["status", "--seat", str(path), "--watch", str(tmp_path / "none_*")], capsys)
    assert code == 0 and not err and len(out.splitlines()) == 2
    assert "count=0 mtime=- latest=-" in out


def test_state_second_status_has_no_stars_even_when_age_changes(tmp_path, monkeypatch, capsys):
    path = seat(tmp_path)
    state = tmp_path / "state 日本語.json"
    args = ["status", "--seat", str(path), "--watch", str(tmp_path / "*_ready.json"), "--state", str(state)]
    code, out, err = run(args, capsys)
    assert code == 0 and not err and all(line.startswith("* ") for line in out.splitlines())
    epoch = time.time()
    monkeypatch.setattr(watch.time, "time", lambda: epoch + 600)
    code, out, err = run(args, capsys)
    assert code == 0 and not err and "*" not in out.splitlines()[0][:2]
    assert all(not line.startswith("*") for line in out.splitlines())
    data = json.loads(state.read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert next(iter(data["seats"].values()))["headings"] == ["old"]


def test_status_marks_mtime_only_change(tmp_path, capsys):
    path = seat(tmp_path)
    state = tmp_path / "state.json"
    args = ["status", "--seat", str(path), "--state", str(state)]
    run(args, capsys)
    done = path / "DONE.md"
    info = done.stat()
    os.utime(done, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))
    code, out, err = run(args, capsys)
    assert code == 0 and not err and out.startswith("* ")


def test_wait_append_by_thread_reports_only_new_heading_and_buffers_output(tmp_path, monkeypatch, capsys):
    path = seat(tmp_path)
    buffered = []
    sleep = watch.time.sleep

    def checked_sleep(duration):
        buffered.append(capsys.readouterr())
        sleep(duration)

    monkeypatch.setattr(watch.time, "sleep", checked_sleep)

    def append():
        with (path / "DONE.md").open("a", encoding="utf-8") as handle:
            handle.write("## 追加した見出し\n")

    code, out, err = threaded_wait(path, append, monkeypatch, capsys)
    assert code == 0 and not err and out.splitlines()[0] == "CHANGED"
    assert "追加した見出し" in out and "old" not in out
    assert buffered and all(not capture.out and not capture.err for capture in buffered)


def test_wait_timeout_fraction_is_clamped_to_timeout_not_poll(tmp_path, capsys):
    path = seat(tmp_path)
    before = fingerprint(path)
    start = time.monotonic()
    code, out, err = run(["wait", "--seat", str(path), "--timeout-min", "0.01"], capsys)
    elapsed = time.monotonic() - start
    assert code == 3 and not err and out.splitlines()[0] == "TIMEOUT"
    assert len(out.splitlines()) == 2 and "DONE=YES" in out
    assert 0.55 <= elapsed < 3
    assert fingerprint(path) == before


@pytest.mark.parametrize("operation", ["add", "update", "disappear"])
def test_wait_watch_japanese_spaces_add_update_and_disappearance(tmp_path, monkeypatch, capsys, operation):
    path = seat(tmp_path)
    ready = tmp_path / "日本語 と 空白"
    ready.mkdir()
    file = ready / "完成_ready.json"
    if operation != "add":
        write(file, "{}")

    def change():
        if operation == "add":
            write(file, "{}")
        elif operation == "update":
            info = file.stat()
            os.utime(file, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))
        else:
            file.rename(ready / "completed.retired")

    code, out, err = threaded_wait(path, change, monkeypatch, capsys, "--watch", str(ready / "*_ready.json"))
    assert code == 0 and not err and out.splitlines()[0] == "CHANGED"
    marker = {"add": "+", "update": "~", "disappear": "-"}[operation]
    assert marker + file.name in out


@pytest.mark.parametrize("operation", ["appear", "mtime", "size", "disappear"])
def test_wait_done_metadata_changes(tmp_path, monkeypatch, capsys, operation):
    path = seat(tmp_path, content=None if operation == "appear" else "## old\n")
    done = path / "DONE.md"

    def change():
        if operation == "appear":
            write(done, "## 新規\n")
        elif operation == "mtime":
            info = done.stat()
            os.utime(done, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))
        elif operation == "size":
            info = done.stat()
            write(done, "## old\nbody\n")
            os.utime(done, ns=(info.st_atime_ns, info.st_mtime_ns))
        else:
            done.rename(path / "DONE.previous")

    code, out, err = threaded_wait(path, change, monkeypatch, capsys)
    assert code == 0 and not err and out.splitlines()[0] == "CHANGED"
    assert ("DONE=NO" if operation == "disappear" else "DONE=YES") in out


def test_wait_saved_state_immediate_change_then_waits_again(tmp_path, monkeypatch, capsys):
    path = seat(tmp_path)
    state = tmp_path / "state.json"
    args = ["wait", "--seat", str(path), "--state", str(state)]
    code, out, err = run([*args, "--timeout-min", "0"], capsys)
    assert code == 3 and out.startswith("TIMEOUT") and not err
    write(path / "DONE.md", "## old\n## newly added\n")
    sleep = watch.time.sleep
    monkeypatch.setattr(watch.time, "sleep", lambda _: pytest.fail("saved change should return immediately"))
    code, out, err = run(args, capsys)
    assert code == 0 and not err and out.startswith("CHANGED")
    assert "newly added" in out and "old" not in out
    monkeypatch.setattr(watch.time, "sleep", sleep)
    start = time.monotonic()
    code, out, err = run([*args, "--timeout-min", "0.01", "--poll-sec", "0.2"], capsys)
    assert code == 3 and not err and out.startswith("TIMEOUT")
    assert time.monotonic() - start >= 0.55


def test_prepended_and_duplicate_new_headings_are_found(tmp_path, capsys):
    path = seat(tmp_path, content="## repeated\n## older\n")
    state = tmp_path / "state.json"
    run(["status", "--seat", str(path), "--state", str(state)], capsys)
    write(path / "DONE.md", "## 先頭 (これが最新)\n## repeated\n## older\n## repeated\n")
    code, out, err = run(["wait", "--seat", str(path), "--state", str(state), "--timeout-min", "0.05"], capsys)
    assert code == 0 and not err and "先頭 (これが最新)" in out
    assert out.count("repeated") == 1 and "older" not in out


def test_wait_caps_headings_and_changed_glob_files(tmp_path, capsys):
    path = seat(tmp_path)
    ready = tmp_path / "ready files"
    ready.mkdir()
    state = tmp_path / "state.json"
    args = ["--seat", str(path), "--watch", str(ready / "*_ready.json"), "--state", str(state)]
    run(["status", *args], capsys)
    headings = [f"new_heading_{i}_" + "長" * 80 for i in range(8)]
    write(path / "DONE.md", "## old\n" + "".join(f"## {h}\n" for h in headings))
    for index in range(25):
        write(ready / f"new_file_{index:02d}_ready.json", "{}")
    code, out, err = run(["wait", *args, "--timeout-min", "0.05"], capsys)
    assert code == 0 and not err and len(out.splitlines()) == 3
    for heading in headings[:5]:
        assert heading[:60] in out and heading[:61] not in out
    assert "new_heading_5_" not in out
    assert out.count("new_file_") == 20 and "(+5 more)" in out


def test_readonly_status_and_timeout_preserve_names_sizes_and_sha256(tmp_path, capsys):
    first = seat(tmp_path, "一つ目", "## one\nbody\n")
    second = seat(tmp_path, "二つ目", None)
    sub = first / "sub"
    sub.mkdir()
    write(sub / "unchanged 日本語.txt", "そのまま\n")
    ready = tmp_path / "ready files"
    ready.mkdir()
    write(ready / "一_ready.json", "{}")
    before = {str(p): fingerprint(p) for p in (first, second, ready)}
    state = tmp_path / "state.json"
    args = ["--seat", str(first), "--seat", str(second),
            "--watch", str(ready / "*_ready.json"), "--state", str(state)]
    assert run(["status", *args], capsys)[0] == 0
    assert run(["wait", *args, "--timeout-min", "0"], capsys)[0] == 3
    assert before == {str(p): fingerprint(p) for p in (first, second, ready)}


def test_over_one_megabyte_done_uses_line_iteration(tmp_path, monkeypatch, capsys):
    path = seat(tmp_path, content=None)
    done = path / "DONE.md"
    with done.open("w", encoding="utf-8", newline="") as handle:
        handle.write("## 第一 (これが最新)\n")
        for _ in range(700):
            handle.write("x" * 2048 + "\n")
        handle.write("## 最後\n")
    assert done.stat().st_size > 1024 * 1024
    original = Path.open

    class LineOnly:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            self.handle.__enter__()
            return self

        def __exit__(self, *args):
            return self.handle.__exit__(*args)

        def __iter__(self):
            return iter(self.handle)

        def read(self, *args):
            pytest.fail("DONE.md must not be read wholesale")

        def readlines(self, *args):
            pytest.fail("DONE.md must be iterated line by line")

    def open_lines(p, *args, **kwargs):
        handle = original(p, *args, **kwargs)
        return LineOnly(handle) if p.name == "DONE.md" else handle

    monkeypatch.setattr(Path, "open", open_lines)
    code, out, err = run(["status", "--seat", str(path)], capsys)
    assert code == 0 and not err and "headings=2 latest=第一 (これが最新)" in out
    assert len(out) < 300


def test_long_windows_paths_japanese_spaces_and_state(tmp_path, capsys):
    parent = tmp_path
    for index in range(8):
        parent = parent / (f"long_segment_{index}_" + "日本語 " * 8)
    parent = watch.fs_path(parent)
    parent.mkdir(parents=True)
    path = seat(parent)
    ready = parent / "ready 日本語"
    ready.mkdir()
    write(ready / "完成_ready.json", "{}")
    state = parent / "state.json"
    assert len(watch.display_path(path)) > 260
    code, out, err = run(["status", "--seat", watch.display_path(path),
                          "--watch", watch.display_path(ready / "*_ready.json"),
                          "--state", watch.display_path(state)], capsys)
    assert code == 0 and not err and "count=1" in out and "完成_ready.json" in out
    assert "\\\\?\\" not in out and state.is_file()


@pytest.mark.parametrize("name", ["DONE.md", "new_state.json", "sub/state.json"])
def test_state_cannot_write_inside_a_watched_seat(tmp_path, capsys, name):
    path = seat(tmp_path)
    before = fingerprint(path)
    code, out, err = run(["status", "--seat", str(path), "--state", str(path / name)], capsys)
    assert code == 2 and not out and len(err.splitlines()) == 1
    assert "outside watched seat" in err and fingerprint(path) == before


def test_state_cannot_overwrite_a_watched_file(tmp_path, capsys):
    path = seat(tmp_path)
    file = tmp_path / "existing_ready.json"
    write(file, "{}")
    before = file.read_bytes()
    code, out, err = run(["status", "--seat", str(path), "--watch", str(tmp_path / "*_ready.json"),
                          "--state", str(file)], capsys)
    assert code == 2 and not out and "watched file" in err
    assert file.read_bytes() == before


def test_state_replacement_is_atomic_and_failure_keeps_previous(tmp_path, monkeypatch, capsys):
    path = seat(tmp_path)
    state = tmp_path / "state.json"
    args = ["status", "--seat", str(path), "--state", str(state)]
    assert run(args, capsys)[0] == 0
    original_bytes = state.read_bytes()
    observed = []
    original = watch.os.replace

    def replace(source, destination):
        assert Path(source).is_file()
        assert json.loads(Path(source).read_text(encoding="utf-8"))["version"] == 1
        assert watch.fs_path(Path(source).parent.parent) == watch.fs_path(state.parent)
        assert watch.fs_path(destination) == watch.fs_path(state)
        observed.append(True)
        original(source, destination)

    monkeypatch.setattr(watch.os, "replace", replace)
    assert run(args, capsys)[0] == 0 and observed

    def failed_replace(*args):
        raise OSError("simulated replace failure")

    monkeypatch.setattr(watch.os, "replace", failed_replace)
    code, out, err = run(args, capsys)
    assert code == 2 and not out and "simulated replace failure" in err
    assert state.read_bytes() == original_bytes
    assert not list(tmp_path.glob(".seat-watch-*"))


@pytest.mark.parametrize("content", ["{", "[]", "{}", '{"version":1,"seats":{"x":null},"watches":{}}',
                                     '{"version":1,"seats":{},"watches":{"x":[]}}'])
def test_invalid_state_is_one_error_and_is_preserved(tmp_path, capsys, content):
    path = seat(tmp_path)
    state = tmp_path / "state.json"
    write(state, content)
    code, out, err = run(["status", "--seat", str(path), "--state", str(state)], capsys)
    assert code == 2 and not out and len(err.splitlines()) == 1
    assert state.read_text(encoding="utf-8") == content


@pytest.mark.parametrize("flag,value", [("--timeout-min", "-1"), ("--timeout-min", "nan"),
                                       ("--timeout-min", "inf"), ("--poll-sec", "0"),
                                       ("--poll-sec", "-1"), ("--poll-sec", "nan")])
def test_invalid_wait_intervals_are_one_error(tmp_path, capsys, flag, value):
    path = seat(tmp_path)
    code, out, err = run(["wait", "--seat", str(path), flag, value], capsys)
    assert code == 2 and not out and len(err.splitlines()) == 1


@pytest.mark.parametrize("command,expected", [("status", 0), ("wait", 3)])
def test_real_cli_exit_codes(tmp_path, command, expected):
    path = seat(tmp_path)
    args = [sys.executable, "-X", "utf8", str(Path(watch.__file__)),
            command, "--seat", str(path)]
    if command == "wait":
        args += ["--timeout-min", "0"]
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                            env=env, timeout=5)
    assert result.returncode == expected and not result.stderr
    assert "DONE=YES" in result.stdout


def test_real_cli_missing_seat_exits_two(tmp_path):
    result = subprocess.run([sys.executable, "-X", "utf8", str(Path(watch.__file__)),
                             "status", "--seat", str(tmp_path / "missing")],
                            capture_output=True, text=True, encoding="utf-8", timeout=5,
                            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    assert result.returncode == 2 and not result.stdout
    assert len(result.stderr.splitlines()) == 1


@pytest.mark.parametrize("recursive", [False, True])
def test_new_state_cannot_match_watch_glob(tmp_path, capsys, recursive):
    path = seat(tmp_path)
    directory = tmp_path / "ready 日本語"
    directory.mkdir()
    state = directory / "new_ready.json"
    pattern = tmp_path / "**" / "*_ready.json" if recursive else directory / "*_ready.json"
    code, out, err = run(["status", "--seat", str(path), "--watch", str(pattern),
                          "--state", str(state)], capsys)
    assert code == 2 and not out and "watched files/globs" in err
    assert not state.exists()


def test_glob_star_does_not_match_state_in_other_subdirectory(tmp_path, capsys):
    path = seat(tmp_path)
    ready = tmp_path / "ready"
    ready.mkdir()
    sub = ready / "unwatched sub"
    sub.mkdir()
    state = sub / "state.json"
    args = ["--seat", str(path), "--watch", str(ready / "*.json"), "--state", str(state)]
    assert run(["status", *args], capsys)[0] == 0
    assert run(["wait", *args, "--timeout-min", "0"], capsys)[0] == 3


def test_hidden_state_is_not_matched_by_recursive_glob(tmp_path, capsys):
    path = seat(tmp_path)
    state = tmp_path / ".hidden_state.json"
    args = ["--seat", str(path), "--watch", str(tmp_path / "**" / "*.json"), "--state", str(state)]
    assert run(["status", *args], capsys)[0] == 0
    assert run(["wait", *args, "--timeout-min", "0"], capsys)[0] == 3

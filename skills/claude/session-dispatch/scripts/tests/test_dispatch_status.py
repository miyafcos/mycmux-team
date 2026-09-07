"""dispatch_status の契約テスト (B2): 子セッション同定・cwd 最新 jsonl 代用の廃止."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path

import pytest

import dispatch_ledger
import dispatch_status

CWD = "C:/tmp/anken"


@pytest.fixture()
def projects(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "projects"
    directory = root / dispatch_status.slugify_cwd(CWD)
    directory.mkdir(parents=True)
    monkeypatch.setattr(dispatch_status, "PROJECTS", root)
    return directory


def make_ledger(tmp_path: Path, **overrides: object) -> Path:
    record = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "slug": "260813-foo",
        "dir": str(tmp_path / "dispatch-dir"),
        "cwd": CWD,
        "tab_session_id": "pty-tab-1",
        "status": "open",
    }
    record.update(overrides)
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text(json.dumps(record) + "\n", encoding="utf-8")
    return ledger


def only(ledger: Path) -> dispatch_ledger.Dispatch:
    (dispatch,) = dispatch_ledger.load_dispatches(ledger)
    return dispatch


def touch_log(directory: Path, name: str, age_min: float = 0.0) -> Path:
    path = directory / f"{name}.jsonl"
    path.write_text("{}\n", encoding="utf-8")
    if age_min:
        stamp = time.time() - age_min * 60.0
        os.utime(path, (stamp, stamp))
    return path


def test_newest_log_in_cwd_is_not_used_as_a_substitute(tmp_path: Path, projects: Path) -> None:
    """spawn 時刻に対応する子ログが無いとき、cwd 内の他人のログを拾わない."""
    touch_log(projects, "someone-elses-session")
    ledger = make_ledger(tmp_path, ts="2020-01-01T00:00:00")
    activity = dispatch_status.dispatch_activity(only(ledger), ledger=ledger)
    assert activity.state == dispatch_status.STATE_UNKNOWN
    assert activity.log_name == ""
    assert ledger.read_text(encoding="utf-8").count("\n") == 1  # pin 行を書かない


def test_ambiguous_candidates_stay_unknown(tmp_path: Path, projects: Path) -> None:
    touch_log(projects, "child-a")
    touch_log(projects, "child-b")
    ledger = make_ledger(tmp_path)
    activity = dispatch_status.dispatch_activity(only(ledger), ledger=ledger)
    assert activity.state == dispatch_status.STATE_UNKNOWN
    assert activity.reason.startswith("ambiguous")


def test_tab_id_wins_over_other_logs(tmp_path: Path, projects: Path) -> None:
    """Spec A 適用後は tab id = 子の claude session id。"""
    touch_log(projects, "child-a")
    touch_log(projects, "tab-uuid")
    ledger = make_ledger(tmp_path, tab_id="tab-uuid")
    activity = dispatch_status.dispatch_activity(only(ledger), ledger=ledger)
    assert activity.state == dispatch_status.STATE_RUNNING
    assert activity.log_name == "tab-uuid.jsonl"
    assert activity.reason == "tab_id"


def test_single_candidate_is_pinned_once(tmp_path: Path, projects: Path) -> None:
    touch_log(projects, "child-a")
    ledger = make_ledger(tmp_path)
    first = dispatch_status.dispatch_activity(only(ledger), ledger=ledger)
    assert first.reason == "pinned"
    assert first.log_name == "child-a.jsonl"

    pin_rows = [
        json.loads(line)
        for line in ledger.read_text(encoding="utf-8").splitlines()
        if "claude_session_id" in line
    ]
    assert len(pin_rows) == 1
    assert pin_rows[0]["claude_session_id"] == "child-a"
    assert pin_rows[0]["tab_session_id"] == "pty-tab-1"

    # 2本目が現れても pin は動かない (初回固定)
    touch_log(projects, "child-b")
    second = dispatch_status.dispatch_activity(only(ledger), ledger=ledger)
    assert second.log_name == "child-a.jsonl"
    assert second.reason == "ledger"
    assert ledger.read_text(encoding="utf-8").count("claude_session_id") == 1


def test_activity_reads_the_pinned_log_not_the_newest(tmp_path: Path, projects: Path) -> None:
    touch_log(projects, "child-a", age_min=30.0)
    touch_log(projects, "unrelated-busy-session")
    spawn_ts = datetime.fromtimestamp(time.time() - 3600).isoformat(timespec="seconds")
    ledger = make_ledger(tmp_path, claude_session_id="child-a", ts=spawn_ts)
    activity = dispatch_status.dispatch_activity(only(ledger), ledger=ledger)
    assert activity.state == "STALL"
    assert activity.log_name == "child-a.jsonl"
    assert 25.0 < activity.age_min < 35.0
    assert activity.label().startswith("STALL(")


def test_missing_pinned_log_is_no_log(tmp_path: Path, projects: Path) -> None:
    ledger = make_ledger(tmp_path, claude_session_id="child-a")
    activity = dispatch_status.dispatch_activity(only(ledger), ledger=ledger)
    assert activity.state == dispatch_status.STATE_NO_LOG


def test_closed_dispatch_is_never_pinned(tmp_path: Path, projects: Path) -> None:
    touch_log(projects, "child-a")
    ledger = make_ledger(tmp_path, status="done-verified-closed")
    dispatch = only(ledger)
    assert dispatch_status.live_state(dispatch, ledger=ledger) == "CLOSED"
    assert "claude_session_id" not in ledger.read_text(encoding="utf-8")


def test_no_pin_flag_keeps_the_ledger_untouched(tmp_path: Path, projects: Path) -> None:
    touch_log(projects, "child-a")
    ledger = make_ledger(tmp_path)
    activity = dispatch_status.dispatch_activity(only(ledger), pin=False, ledger=ledger)
    assert activity.log_name == "child-a.jsonl"
    assert "claude_session_id" not in ledger.read_text(encoding="utf-8")


def test_done_marker_shows_needs_review(tmp_path: Path, projects: Path) -> None:
    dispatch_dir = tmp_path / "dispatch-dir"
    dispatch_dir.mkdir()
    (dispatch_dir / "DONE.md").write_text("done\n", encoding="utf-8")
    ledger = make_ledger(tmp_path)
    assert dispatch_status.live_state(only(ledger), ledger=ledger) == "DONE(要検収)"


def test_main_runs_over_a_mixed_ledger(tmp_path: Path, projects: Path, capsys) -> None:
    ledger = make_ledger(tmp_path)
    with ledger.open("a", encoding="utf-8") as stream:
        stream.write(
            json.dumps(
                {
                    "ts": "2026-08-05T10:00:00",
                    "slug": "260805-bar",
                    "tabSessionId": "pty-tab-2",
                    "cwd": CWD,
                    "status": "closed",
                }
            )
            + "\n"
        )
    assert dispatch_status.main(["--all", "--no-pin", "--ledger", str(ledger)]) == 0
    out = capsys.readouterr().out
    assert "260813-foo" in out
    assert "260805-bar" in out
    assert "CLOSED" in out

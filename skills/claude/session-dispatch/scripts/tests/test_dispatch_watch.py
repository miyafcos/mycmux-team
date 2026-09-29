"""dispatch_watch の契約テスト (B3): close-tab の fail-closed 化."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import dispatch_watch


def write_ledger(path: Path, records: list[dict]) -> Path:
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )
    return path


def base_record(**overrides: object) -> dict:
    record = {
        "ts": "2026-08-13T10:00:00",
        "slug": "260813-foo",
        "dir": "d",
        "cwd": "c",
        "tab_session_id": "tab-new",
        "status": "open",
    }
    record.update(overrides)
    return record


def test_select_refuses_a_closed_dispatch(tmp_path: Path) -> None:
    ledger = write_ledger(
        tmp_path / "ledger.jsonl",
        [base_record(), base_record(ts="2026-08-13T11:00:00", status="done-verified-closed")],
    )
    dispatch, error = dispatch_watch.select_dispatch(ledger, "260813-foo")
    assert dispatch is None
    assert "already closed" in error


def test_select_never_inherits_an_old_dispatch_tab(tmp_path: Path) -> None:
    """別日の同名 slug の tab_session_id を引き継がない (誤 close-tab の経路)."""
    ledger = write_ledger(
        tmp_path / "ledger.jsonl",
        [
            base_record(ts="2026-08-01T10:00:00", tab_session_id="tab-old"),
            {"ts": "2026-08-01T12:00:00", "slug": "260813-foo", "status": "closed"},
            base_record(tab_session_id="tab-new", dir=None),
        ],
    )
    dispatch, error = dispatch_watch.select_dispatch(ledger, "260813-foo")
    assert error == ""
    assert dispatch is not None
    assert dispatch.tab_session_id == "tab-new"
    # 旧レコードの dir がマージで生き残らない
    assert dispatch.get("dir") is None


def test_select_refuses_ambiguous_active_dispatches(tmp_path: Path) -> None:
    ledger = write_ledger(
        tmp_path / "ledger.jsonl",
        [
            base_record(ts="2026-08-13T10:00:00", tab_session_id="tab-a"),
            base_record(ts="2026-08-13T10:30:00", tab_session_id="tab-b"),
        ],
    )
    dispatch, error = dispatch_watch.select_dispatch(ledger, "260813-foo")
    assert dispatch is None
    assert "multiple active dispatches" in error
    picked, error = dispatch_watch.select_dispatch(
        ledger, "260813-foo", "2026-08-13T10:30:00"
    )
    assert error == ""
    assert picked is not None and picked.tab_session_id == "tab-b"


def test_main_refuses_closed_dispatch_without_touching_the_tab(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    ledger = write_ledger(tmp_path / "ledger.jsonl", [base_record(status="closed")])
    monkeypatch.setenv("DISPATCH_LEDGER", str(ledger))
    calls: list[str] = []
    monkeypatch.setattr(dispatch_watch, "close_tab", lambda sid: calls.append(sid))
    assert dispatch_watch.main(["--slug", "260813-foo"]) == 3
    assert calls == []
    assert "CONFIG-ERROR" in capsys.readouterr().out


def test_main_requires_a_tab_session_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    ledger = write_ledger(
        tmp_path / "ledger.jsonl",
        [{"ts": "2026-08-13T10:00:00", "slug": "260813-foo", "dir": "d", "cwd": "c", "status": "open"}],
    )
    monkeypatch.setenv("DISPATCH_LEDGER", str(ledger))
    assert dispatch_watch.main(["--slug", "260813-foo"]) == 3
    assert "tab_session_id" in capsys.readouterr().out


@pytest.mark.parametrize("close_error", [None, "simulated close failure", ""])
def test_done_with_passing_gate_closes_only_this_dispatch_tab(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys, close_error
) -> None:
    dispatch_dir = tmp_path / "260813-foo"
    dispatch_dir.mkdir()
    cwd = tmp_path / "work"
    cwd.mkdir()
    (dispatch_dir / "spec.md").write_text(
        "## 自動検収 (machine gate)\n\nauto_close: true\n\n```verify\necho ok\n```\n",
        encoding="utf-8",
    )
    (dispatch_dir / "DONE.md").write_text("done\n", encoding="utf-8")
    ledger = write_ledger(
        tmp_path / "ledger.jsonl",
        [
            base_record(ts="2026-08-01T10:00:00", tab_session_id="tab-old", dir=str(dispatch_dir), cwd=str(cwd)),
            {"ts": "2026-08-01T12:00:00", "slug": "260813-foo", "status": "closed"},
            base_record(tab_session_id="tab-new", dir=str(dispatch_dir), cwd=str(cwd)),
        ],
    )
    monkeypatch.setenv("DISPATCH_LEDGER", str(ledger))
    closed: list[str] = []
    monkeypatch.setattr(
        dispatch_watch, "close_tab", lambda sid: (closed.append(sid), close_error)[1]
    )
    monkeypatch.setattr(
        dispatch_watch,
        "run_gate",
        lambda gate, cwd_path: [dispatch_watch.CommandResult("echo ok", 0, "")],
    )
    assert dispatch_watch.main(["--slug", "260813-foo"]) == (1 if close_error is not None else 0)
    assert closed == ["tab-new"]
    output = capsys.readouterr().out
    assert ("DONE-VERIFIED-CLOSE-FAILED" if close_error is not None else "DONE-VERIFIED-CLOSED") in output
    if close_error is not None:
        assert "DONE-VERIFIED-CLOSED" not in output

    rows = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines()]
    last = rows[-1]
    assert last["status"] == ("close_failed" if close_error is not None else "closed")
    if close_error is not None:
        assert last["close_error"] == close_error
    assert last["verify"] == "auto-pass"
    assert last["tab_session_id"] == "tab-new"
    assert last["spawn_ts"] == "2026-08-13T10:00:00"
    assert (dispatch_dir / "VERDICT.md").is_file()


@pytest.mark.parametrize("exists", [False, True])
def test_template_path_gate_is_fail_closed(tmp_path, exists):
    template = Path(__file__).resolve().parents[2] / "references" / "spec-template.md"
    command = dispatch_watch.parse_gate(template).commands[0]
    target = tmp_path / "artifact.txt"
    if exists:
        target.write_text("ready\n", encoding="utf-8")
    command = command.replace("<成果物のフルパス>", str(target))
    result = dispatch_watch.run_gate(dispatch_watch.Gate([command]), tmp_path)
    assert result[0].passed is exists

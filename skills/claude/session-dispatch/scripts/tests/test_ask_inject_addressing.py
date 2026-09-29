"""A card about someone else's child must not print in every session.

The queue is one file and the only delivery filter was "am I myself a dispatch
child", so every mothership printed every pending card. Where the ledger records
who dispatched the child, the card now goes only there; where it does not, the
old broadcast stands so that a real stall is never dropped.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import ModuleType

import pytest

from test_ask_inject import load_hook, write_ledger  # noqa: F401  (shared helpers)


@pytest.fixture()
def hook() -> ModuleType:
    return load_hook()


def write_queue(hook: ModuleType, tmp_path: Path, subject_session: str) -> None:
    hook.QUEUE_PATH = tmp_path / "queue.jsonl"
    hook.QUEUE_PATH.write_text(
        json.dumps({
            "kind": "ask",
            "status": "pending",
            "ask_state": "pending",
            "id": "ask-1",
            "question": "どちらにしますか",
            "session_id": subject_session,
        }) + "\n",
        encoding="utf-8",
    )


def test_card_reaches_the_session_that_dispatched_the_child(
    hook: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    write_ledger(hook, tmp_path, [{
        "ts": "t", "slug": "260910-run", "tab_session_id": "child-pane",
        "status": "closed", "parent_session": "aaaa-1111",
    }])
    write_queue(hook, tmp_path, "child-pane")
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "pty-x-y-aaaa-1111")
    assert hook.main() == 0
    assert "ask-1" in capsys.readouterr().out


def test_card_does_not_reach_an_unrelated_session(
    hook: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    write_ledger(hook, tmp_path, [{
        "ts": "t", "slug": "260910-run", "tab_session_id": "child-pane",
        "status": "closed", "parent_session": "aaaa-1111",
    }])
    write_queue(hook, tmp_path, "child-pane")
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "pty-x-y-bbbb-2222")
    assert hook.main() == 0
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize("key", ["parent_session_id", "parent_session", "parent"])
def test_all_three_parent_spellings_are_read(
    hook: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys, key: str
) -> None:
    write_ledger(hook, tmp_path, [{
        "ts": "t", "slug": "260910-run", "tab_session_id": "child-pane",
        "status": "closed", key: "aaaa-1111",
    }])
    write_queue(hook, tmp_path, "child-pane")
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "pty-x-y-bbbb-2222")
    assert hook.main() == 0
    assert capsys.readouterr().out == ""


def test_unrecorded_parent_still_broadcasts(
    hook: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    # 210 of 237 dispatches record no parent at all. Those cards must keep
    # reaching someone rather than falling into a hole.
    write_ledger(hook, tmp_path, [{
        "ts": "t", "slug": "260910-run", "tab_session_id": "child-pane", "status": "closed",
    }])
    write_queue(hook, tmp_path, "child-pane")
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "pty-x-y-bbbb-2222")
    assert hook.main() == 0
    assert "ask-1" in capsys.readouterr().out


def test_card_without_a_subject_still_broadcasts(
    hook: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    write_ledger(hook, tmp_path, [])
    hook.QUEUE_PATH = tmp_path / "queue.jsonl"
    hook.QUEUE_PATH.write_text(
        json.dumps({
            "kind": "ask", "status": "pending", "ask_state": "pending",
            "id": "ask-1", "question": "どちらにしますか",
        }) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "pty-x-y-bbbb-2222")
    assert hook.main() == 0
    assert "ask-1" in capsys.readouterr().out

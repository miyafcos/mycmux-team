"""A card whose answer may not have reached the child is put in front of the parent.

answer-ask leaves such a card "answering" with delivery_outcome "unknown" and
never resends it; the parent looks at the child's input line and picks
--mark-delivered or --resend. The hook must show both commands.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import ModuleType

import pytest

from test_ask_inject import load_hook


@pytest.fixture()
def hook(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    module = load_hook()
    module.LEDGER_PATH = tmp_path / "ledger.jsonl"
    module.UNDELIVERED_PATH = tmp_path / "guard" / "undelivered.jsonl"
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "mothership-pane")
    return module


def card(card_id: str, ts: str, **extra) -> dict:
    return {
        "kind": "ask",
        "status": "pending",
        "ask_state": "pending",
        "id": card_id,
        "ts": ts,
        "question": "どちらにしますか",
        **extra,
    }


def write_queue(hook: ModuleType, tmp_path: Path, rows: list[dict]) -> None:
    hook.QUEUE_PATH = tmp_path / "queue.jsonl"
    hook.QUEUE_PATH.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8"
    )


def test_unknown_delivery_shows_both_commands_first(hook, tmp_path, capsys) -> None:
    write_queue(
        hook,
        tmp_path,
        [
            card("ask-old", "2026-09-25T09:00:00+09:00"),
            card(
                "ask-unknown",
                "2026-09-25T10:00:00+09:00",
                ask_state="answering",
                delivery_outcome="unknown",
                delivery_detail="text written, Enter refused: session_revision",
                answered_text="続ける",
            ),
        ],
    )
    assert hook.main() == 0
    out = capsys.readouterr().out
    assert out.index("[ask-unknown]") < out.index("[ask-old]")
    assert "届いたか不明" in out
    assert "text written, Enter refused: session_revision" in out
    assert "続ける" in out
    assert "answer-ask ask-unknown --mark-delivered" in out
    assert "answer-ask ask-unknown --resend" in out
    assert "answer-ask ask-old --mark-delivered" not in out


def test_card_still_being_sent_has_no_recovery_commands(hook, tmp_path, capsys) -> None:
    write_queue(
        hook,
        tmp_path,
        [card("ask-busy", "2026-09-25T10:00:00+09:00", ask_state="answering")],
    )
    assert hook.main() == 0
    out = capsys.readouterr().out
    assert "[ask-busy]" in out
    assert "--mark-delivered" not in out

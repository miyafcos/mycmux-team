"""ask-inject.py の契約テスト (B4): クローズ集合判定の fail-closed 化."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

import dispatch_ledger

HOOK_PATH = Path.home() / ".claude" / "scripts" / "ask-inject.py"


def load_hook() -> ModuleType:
    spec = importlib.util.spec_from_file_location("ask_inject_under_test", HOOK_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def hook() -> ModuleType:
    return load_hook()


def write_ledger(hook: ModuleType, tmp_path: Path, records: list[dict]) -> Path:
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )
    hook.LEDGER_PATH = ledger
    return ledger


def test_closed_status_set_matches_the_ledger_module(hook: ModuleType) -> None:
    assert set(hook.CLOSED_DISPATCH_STATUSES) == set(dispatch_ledger.CLOSED_STATUSES)


@pytest.mark.parametrize("status", ["open", "running", "done", "in-review", ""])
def test_non_closed_statuses_are_children(hook: ModuleType, tmp_path: Path, status: str) -> None:
    """語彙が増えても黙って fail-open しない (旧: status == "open" のみ)."""
    write_ledger(
        hook,
        tmp_path,
        [{"ts": "t", "slug": "260813-foo", "tab_session_id": "pane-1", "status": status}],
    )
    assert hook.is_dispatch_child("pane-1") is True


@pytest.mark.parametrize(
    "status", ["closed", "done-verified-closed", "abandoned", "fallback-inline"]
)
def test_closed_statuses_are_not_children(
    hook: ModuleType, tmp_path: Path, status: str
) -> None:
    write_ledger(
        hook,
        tmp_path,
        [
            {"ts": "t1", "slug": "260813-foo", "tab_session_id": "pane-1", "status": "open"},
            {"ts": "t2", "slug": "260813-foo", "tab_session_id": "pane-1", "status": status},
        ],
    )
    assert hook.is_dispatch_child("pane-1") is False


def test_camel_case_session_key_is_recognised(hook: ModuleType, tmp_path: Path) -> None:
    write_ledger(
        hook,
        tmp_path,
        [{"ts": "t", "slug": "260813-foo", "tabSessionId": "pane-1", "status": "running"}],
    )
    assert hook.is_dispatch_child("pane-1") is True


def test_other_dispatch_status_does_not_leak(hook: ModuleType, tmp_path: Path) -> None:
    """同じ slug の別 dispatch (別タブ) の closed が、生きているタブを開放しない."""
    write_ledger(
        hook,
        tmp_path,
        [
            {"ts": "t1", "slug": "260813-foo", "tab_session_id": "pane-old", "status": "open"},
            {"ts": "t2", "slug": "260813-foo", "tab_session_id": "pane-old", "status": "closed"},
            {"ts": "t3", "slug": "260813-foo", "tabSessionId": "pane-new", "status": "running"},
        ],
    )
    assert hook.is_dispatch_child("pane-old") is False
    assert hook.is_dispatch_child("pane-new") is True


def test_unknown_pane_is_not_a_child(hook: ModuleType, tmp_path: Path) -> None:
    write_ledger(
        hook,
        tmp_path,
        [{"ts": "t", "slug": "260813-foo", "tab_session_id": "pane-1", "status": "open"}],
    )
    assert hook.is_dispatch_child("mothership-pane") is False
    assert hook.is_dispatch_child("") is False


def test_missing_ledger_is_not_a_child(hook: ModuleType, tmp_path: Path) -> None:
    hook.LEDGER_PATH = tmp_path / "absent.jsonl"
    assert hook.is_dispatch_child("pane-1") is False


def test_child_session_sees_no_cards(
    hook: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    write_ledger(
        hook,
        tmp_path,
        [{"ts": "t", "slug": "260813-foo", "tab_session_id": "pane-1", "status": "running"}],
    )
    queue = tmp_path / "queue.jsonl"
    queue.write_text(
        json.dumps(
            {
                "kind": "ask",
                "status": "pending",
                "ask_state": "pending",
                "id": "ask-1",
                "question": "どちらにしますか",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    hook.QUEUE_PATH = queue
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "pane-1")
    assert hook.main() == 0
    assert capsys.readouterr().out == ""

    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "mothership-pane")
    assert hook.main() == 0
    assert "ask-1" in capsys.readouterr().out

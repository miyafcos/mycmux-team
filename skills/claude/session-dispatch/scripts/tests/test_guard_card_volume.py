"""The guard must not raise a card for a tab that finished, or for a tab it does not own.

Both shapes were the bulk of the card volume on 2026-09-10: of the 109 cards the
guard had ever queued, 76 were tab_gone and 31 named an unowned "manual-" tab.
Every one of them was later withdrawn as not blocking.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import dispatch_guard  # noqa: E402
import guard_actions  # noqa: E402


class StubDispatch(dict):
    """Minimal stand-in for a ledger row: attribute access plus dict lookups."""

    slug = "260910-run"
    spawn_ts = "2026-09-10T14:47:00"


@pytest.fixture()
def actions(tmp_path, monkeypatch):
    act = guard_actions.Actions(bridge=None, root=tmp_path, ledger_path=tmp_path / "ledger.jsonl")
    act.session = "pty-abc-def-0123456789ab"
    monkeypatch.setattr(guard_actions.ledger, "update_record", lambda *a, **k: None)
    return act


# --- completion markers -------------------------------------------------

def test_done_marker_accepts_the_plain_name(tmp_path):
    (tmp_path / "DONE.md").write_text("done", encoding="utf-8")
    assert dispatch_guard.has_done_marker(tmp_path) is True


def test_done_marker_accepts_per_lane_names(tmp_path):
    # A fan-out run writes one marker per lane and no plain DONE.md at all.
    for name in ("DONE_01.md", "DONE_02.md", "DONE_99.md"):
        (tmp_path / name).write_text("done", encoding="utf-8")
    assert dispatch_guard.has_done_marker(tmp_path) is True


def test_done_marker_absent_when_nothing_finished(tmp_path):
    (tmp_path / "00_spec.md").write_text("spec", encoding="utf-8")
    assert dispatch_guard.has_done_marker(tmp_path) is False


def test_done_marker_survives_a_missing_folder(tmp_path):
    assert dispatch_guard.has_done_marker(tmp_path / "not-there") is False


# --- a finished tab is not an incident ----------------------------------

def test_finished_tab_raises_no_card(actions):
    actions.dispatch = StubDispatch()
    result = actions.mark_lost("260910-run", "guard:reconcile", done_exists=True)
    assert result == {"escalated": False, "completed": True}
    assert actions.alert_queue == []


def test_unfinished_tab_still_raises_a_card(actions):
    actions.dispatch = StubDispatch()
    actions.mark_lost("260910-run", "guard:reconcile", done_exists=False)
    assert [row["cls"] for row in actions.alert_queue] == ["tab_gone"]


# --- an unowned tab is not a stalled child ------------------------------

def test_unowned_tab_raises_no_card(actions):
    actions.dispatch = None
    result = actions.escalate(actions.session, "human_draft_idle", "Unowned draft")
    assert result == {"escalated": False, "unowned": True}
    assert actions.alert_queue == []


def test_unowned_tab_still_leaves_evidence(actions, tmp_path):
    actions.dispatch = None
    actions.escalate(actions.session, "human_draft_idle", "Unowned draft")
    rows = guard_actions.json_rows(tmp_path / "escalations.jsonl")
    assert [(row["cls"], row["carded"], row["skip_reason"]) for row in rows] == [
        ("human_draft_idle", False, "unowned_tab")
    ]


def test_owned_tab_is_unaffected(actions):
    actions.dispatch = StubDispatch()
    actions.escalate(actions.session, "human_draft_idle", "Real stall")
    assert [row["cls"] for row in actions.alert_queue] == ["human_draft_idle"]


def test_unowned_tab_still_reports_a_blocker(actions):
    # Suppression covers only what the operator can already see. A tab that is
    # not logged in blocks everything and must reach a human whoever opened it.
    actions.dispatch = None
    actions.escalate(actions.session, "login_required", "Not logged in")
    assert [row["cls"] for row in actions.alert_queue] == ["login_required"]


def test_a_tab_marked_lost_can_still_be_re_reported(actions, tmp_path):
    # A lost row drops out of the live dispatch set, so self.dispatch is None on
    # the next cycle. The tab is still a child and keeps its 30 minute cadence.
    (tmp_path / "ledger.jsonl").write_text(
        '{"slug": "260910-run", "status": "lost", "tab_session_id": "%s"}\n' % actions.session,
        encoding="utf-8")
    actions.dispatch = None
    actions.escalate(actions.session, "unclassified_idle", "No live prompt")
    assert [row["cls"] for row in actions.alert_queue] == ["unclassified_idle"]

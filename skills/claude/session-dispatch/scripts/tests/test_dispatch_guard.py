import copy
import importlib.util
import json
from pathlib import Path
import pytest
import dispatch_guard as dg
import dispatch_ledger as ledger
import dispatch_send
import dispatch_watch
from dispatch_status import Activity
from guard_actions import (Actions, observe_delivery, register_pending, pending_by_session,
                           resolve_pending, json_rows)
from guard_classify import Observation, classify, current_input_line

class FakeBridge:
    def __init__(self, lines=None):
        self.lines = lines or [">"]
        self.writes = []
        self.tabs = [{"session_id": "s", "agent_kind": "claude"}]
        self.state = {"session_id": "s", "input_revision": 2, "view": {
            "session_id": "s", "session_epoch": 10, "session_revision": 20,
            "lifecycle": "alive", "health": "fresh", "activity": "idle",
            "attention": {"kind": "input", "attention_id": "a"}}}
        self.mutate_on_status = None
        self.submit = False

    def list_tabs(self):
        return {"sessions": self.tabs}
    def status(self, session):
        if self.mutate_on_status:
            self.mutate_on_status(self)
        return copy.deepcopy(self.state)
    def read(self, session, lines=40):
        return {"lines": self.lines}
    def request(self, command, args):
        assert command == "pane.send_text"
        assert args["expectedSessionEpoch"] == self.state["view"]["session_epoch"]
        assert args["expectedSessionRevision"] == self.state["view"]["session_revision"]
        assert args["expectedAttentionId"] == self.state["view"]["attention"]["attention_id"]
        assert args["expectedInputRevision"] == self.state["input_revision"]
        assert args["enter"] is False
        self.writes.append(args)
        self.state["input_revision"] += 1
        if self.submit:
            self.lines = [">"]
            self.state["view"]["session_revision"] += 1
            self.state["view"]["activity"] = "streaming"
        return {"ok": True, "confirmed": True}

def setup(tmp_path, bridge, now=lambda: 1000, scope="all"):
    path = tmp_path / "ledger.jsonl"
    ledger.append_record(path, {"slug": "260908-test", "status": "open", "tab_session_id": "s",
                               "cwd": str(tmp_path), "dir": str(tmp_path)})
    alerts = []
    actions = Actions(bridge, root=tmp_path, ledger_path=path, input_scope=scope,
                      alert=lambda c: alerts.append(c) or {"enqueue_exit": 0}, now=now)
    guard = dg.Guard(bridge, root=tmp_path, ledger_path=path, actions=actions, now=now, asks=lambda: set())
    return guard, actions, path, alerts

def test_union_of_manual_tabs_and_active_ledger(tmp_path):
    bridge = FakeBridge()
    bridge.tabs += [{"session_id": "manual", "agent_kind": "codex"},
                    {"session_id": "shell", "agent_kind": "shell"}]
    guard, _, _, _ = setup(tmp_path, bridge)
    assert set(guard.cycle()["targets"]) == {"s", "manual"}

def test_absent_tab_two_cycles_lost_and_not_closed(tmp_path):
    bridge = FakeBridge()
    bridge.tabs = []
    guard, _, path, alerts = setup(tmp_path, bridge)
    guard.cycle()
    dispatch = ledger.load_dispatches(path)[0]
    assert dispatch.status == "lost" and not dispatch.closed
    assert len(alerts) == 0 and not bridge.writes
    assert "s" not in guard.cycle()["targets"]

def test_inventory_failure_not_mistaken_for_missing_tab(tmp_path):
    bridge = FakeBridge()
    guard, _, path, _ = setup(tmp_path, bridge)
    bridge.list_tabs = lambda: (_ for _ in ()).throw(RuntimeError("offline"))
    with pytest.raises(RuntimeError):
        guard.cycle()
    assert ledger.load_dispatches(path)[0].status == "open"

def test_login_block_and_alert_dedup_persist_restart(tmp_path):
    bridge = FakeBridge(["Not logged in", "/login"])
    guard, actions, path, alerts = setup(tmp_path, bridge)
    guard.cycle()
    guard.cycle()
    assert ledger.load_dispatches(path)[0].status == "blocked"
    assert len(alerts) == 1 and not bridge.writes
    guard = dg.Guard(bridge, root=tmp_path, ledger_path=path, actions=actions,
                     now=lambda: 1001, asks=lambda: set())
    guard.cycle()
    assert len(alerts) == 1

def test_startup_keys_have_four_expectations_and_retry_cap(tmp_path):
    bridge = FakeBridge(["2 new MCP servers found", "Select any you wish to enable.", "Enable selected"])
    guard, _, _, alerts = setup(tmp_path, bridge)
    for _ in range(4):
        guard.cycle()
    assert [r["key"] for r in bridge.writes] == ["enter"] * 3
    assert len(alerts) == 1

def test_acceptance_scope_suppresses_noncanary_input(tmp_path):
    bridge = FakeBridge(["2 new MCP servers found", "Select any you wish to enable.", "Enable selected"])
    guard, _, path, _ = setup(tmp_path, bridge, scope="canary")
    guard.cycle()
    assert not bridge.writes
    ledger.update_record(path, slug="260908-test", tab_session_id="s", guard_canary=True)
    guard.cycle()
    assert len(bridge.writes) == 1

def test_manual_ask_never_becomes_child_from_audit(tmp_path):
    """A manual tab leaves no trace in the ledger at all.

    This used to be satisfied by writing a YYMMDD-guard-manual row with
    status fallback-inline. That row was itself the problem: 6,829 of 7,687
    ledger rows on 2026-09-09 were these, and because ask-inject.py and
    dispatch-child-guard.py read "is this a dispatch child" as the last status
    seen for a pane session id, such a row could mask a live child. The guard
    trail belongs in guard.log.
    """
    bridge = FakeBridge(["Not logged in"])
    guard, actions, path, _ = setup(tmp_path, bridge)
    bridge.tabs = [{"session_id": "manual", "agent_kind": "claude"}]
    before = len(ledger.load_dispatches(path))
    guard.cycle()
    assert not [d for d in ledger.load_dispatches(path) if d.tab_session_id == "manual"]
    assert len(ledger.load_dispatches(path)) == before
    assert any(row.get("session_id") == "manual"
               for row in list(json_rows(tmp_path / "guard.log")))
    guard.cycle()
    assert guard.state["targets"]["manual"]["slug"] is None

def test_unowned_input_and_revision_interference_no_write(tmp_path):
    bridge = FakeBridge(["> hello"])
    guard, _, _, _ = setup(tmp_path, bridge)
    guard.cycle()
    guard.state["targets"]["s"]["idle_since"] = 0
    register_pending("s", "hello", root=tmp_path, input_revision_after=1, session_epoch=10)
    guard.cycle()
    assert not bridge.writes
    assert guard.state["targets"]["s"]["verdict"]["cls"] == "human_draft"

def test_machine_draft_single_enter_and_durable_resolution(tmp_path):
    clock = [1000]
    bridge = FakeBridge(["> hello"])
    bridge.submit = True
    guard, _, _, _ = setup(tmp_path, bridge, now=lambda: clock[0])
    register_pending("s", "hello", root=tmp_path, input_revision_after=2, session_epoch=10)
    guard.cycle()
    clock[0] += 61
    guard.cycle()
    assert len(bridge.writes) == 1 and bridge.writes[0]["key"] == "enter"
    assert pending_by_session(tmp_path) == {}
    guard.cycle()
    assert len(bridge.writes) == 1

def test_stale_action_screen_refuses_before_write(tmp_path):
    bridge = FakeBridge(["> machine"])
    guard, actions, path, _ = setup(tmp_path, bridge)
    obs = Observation(screen_lines=list(bridge.lines), state_view={**bridge.state["view"], "input_revision": 2})
    actions.expected_observation = obs
    actions.session = "s"
    bridge.lines = ["> changed by person"]
    with pytest.raises(RuntimeError):
        actions.press_key("s", "enter")
    assert not bridge.writes

def test_delivery_needs_empty_input_plus_state_or_transcript():
    bridge = FakeBridge([">"])
    before = copy.deepcopy(bridge.state)
    assert not observe_delivery(bridge, "s", before, timeout=0)["delivered_confirmed"]
    assert observe_delivery(bridge, "s", before, timeout=0,
        transcript_mtime=lambda: 20, before_mtime=10)["delivered_confirmed"]
    bridge.state["view"]["session_revision"] += 1
    assert observe_delivery(bridge, "s", before, timeout=0)["delivered_confirmed"]
    bridge.lines = ["> human draft"]
    assert not observe_delivery(bridge, "s", before, timeout=0)["delivered_confirmed"]
    bridge.lines = ["Working"]
    assert not observe_delivery(bridge, "s", before, timeout=0)["delivered_confirmed"]

def test_changed_epoch_never_confirms_delivery():
    bridge = FakeBridge()
    before = copy.deepcopy(bridge.state)
    bridge.state["view"]["session_epoch"] += 1
    assert not observe_delivery(bridge, "s", before, timeout=0)["delivered_confirmed"]

def test_pending_resolution_does_not_remove_newer_send(tmp_path):
    one = register_pending("s", "one", root=tmp_path)
    two = register_pending("s", "two", root=tmp_path)
    resolve_pending(tmp_path, one, "late_old_result")
    assert pending_by_session(tmp_path)["s"]["id"] == two["id"]

def test_singleton_and_stale_pid(tmp_path):
    lock = dg.Singleton(tmp_path)
    assert lock.acquire()
    other = dg.Singleton(tmp_path)
    try:
        assert dg.held(tmp_path)
        assert not other.acquire()
        assert dg.doctor(tmp_path)["alive"]
    finally:
        lock.close()
    assert not dg.held(tmp_path)
    assert not dg.doctor(tmp_path)["alive"]
    assert other.acquire()
    other.close()

def test_ledger_lost_and_blocked_vocabulary_and_send_refusal(tmp_path):
    assert ledger.CLOSED_STATUSES == {"closed", "done-verified-closed", "abandoned", "fallback-inline"}
    assert "blocked" in ledger.ACTIVE_STATUSES and "lost" in ledger.INACTIVE_STATUSES
    path = tmp_path / "ledger.jsonl"
    ledger.append_record(path, {"slug": "260908-test", "status": "lost", "tab_session_id": "s"})
    with pytest.raises(RuntimeError):
        dispatch_send.resolve_session_id(path, "260908-test", None)
    assert dispatch_watch.select_dispatch(path, "260908-test")[0] is None

@pytest.mark.parametrize("legacy,expected", [(False, "TIMEOUT"), (True, "STALL")])
def test_watcher_handoff_continues_to_timeout(tmp_path, monkeypatch, capsys, legacy, expected):
    path = tmp_path / "ledger.jsonl"
    ledger.append_record(path, {"slug": "260908-test", "status": "open", "tab_session_id": "s",
                               "cwd": str(tmp_path), "dir": str(tmp_path)})
    (tmp_path / "spec.md").write_text("# test", encoding="utf-8")
    monkeypatch.setenv("DISPATCH_LEDGER", str(path))
    ticks = iter([0, 1, 2, 601, 602])
    monkeypatch.setattr(dispatch_watch.time, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(dispatch_watch.time, "sleep", lambda s: None)
    monkeypatch.setattr(dispatch_watch, "dispatch_activity", lambda *a, **kw: Activity("STALL", "x", 60))
    calls = []
    monkeypatch.setattr(dispatch_watch, "ensure_guard", lambda: calls.append(1))
    args = ["--slug", "260908-test", "--timeout-min", "10"] + (["--legacy-stall-exit"] if legacy else [])
    assert dispatch_watch.main(args) == 2
    assert expected in capsys.readouterr().out
    assert calls == ([] if legacy else [1])
    events = [r["event"] for r in json_rows(path) if "event" in r]
    assert events.count("stall-handed-to-guard") == (0 if legacy else 1)


def test_seen_alive_disappearance_alerts_after_two_missing_cycles(tmp_path):
    bridge = FakeBridge()
    guard, _, path, alerts = setup(tmp_path, bridge)
    guard.cycle()
    bridge.tabs = []
    guard.cycle()
    assert ledger.load_dispatches(path)[0].status == "open"
    guard.cycle()
    assert ledger.load_dispatches(path)[0].status == "lost"
    assert len(alerts) == 1
    assert "s" in guard.state["initial_alive_sessions"]

def test_reconcile_seventy_one_rows_is_silent(tmp_path):
    bridge = FakeBridge()
    bridge.tabs = []
    guard, _, path, alerts = setup(tmp_path, bridge)
    for i in range(70):
        ledger.append_record(path, {"slug": "260908-old-" + str(i), "status": "open",
                                  "tab_session_id": "old-" + str(i)})
    state = guard.cycle()
    assert all(d.status == "lost" for d in ledger.load_dispatches(path))
    assert not alerts and state["alerts"]["cards"] == 0
    assert not list(json_rows(tmp_path / "escalations.jsonl"))

def test_batch_many_events_exactly_one_card_and_thirty_minute_dedup(tmp_path):
    bridge = FakeBridge(["Not logged in"])
    bridge.tabs = [{"session_id": "s" + str(i), "agent_kind": "claude"} for i in range(5)]
    guard, _, _, alerts = setup(tmp_path, bridge)
    state = guard.cycle()
    assert len(alerts) == 1 and state["alerts"]["cards"] == 1
    assert state["alerts"]["events"] == 5
    assert "login_required" in alerts[0]["question"] and "manual-s0" in alerts[0]["question"]
    assert "guard/escalations.jsonl" in alerts[0]["detail"]
    assert len(alerts[0]["detail"].splitlines()) <= 3
    guard.cycle()
    assert len(alerts) == 1

def test_dry_run_is_record_only_even_for_missing_or_login(tmp_path):
    bridge = FakeBridge(["Not logged in"])
    guard, _, path, alerts = setup(tmp_path, bridge)
    guard.dry_run = True
    before = path.read_bytes()
    state = guard.cycle()
    assert not bridge.writes and not alerts and path.read_bytes() == before
    assert state["alerts"]["cards"] == 0
    bridge.tabs = []
    guard.cycle()
    guard.cycle()
    assert path.read_bytes() == before

def test_readable_lock_and_stale_heartbeat_takeover(tmp_path):
    import time
    from guard_actions import atomic_json
    lock = dg.Singleton(tmp_path)
    assert lock.acquire()
    metadata = json.loads((tmp_path / "guard.lock").read_text(encoding="utf-8"))
    assert metadata["pid"] > 0 and metadata["started_at"]
    atomic_json(tmp_path / "state.json", {"lease_token": metadata["token"],
                                        "cycle_epoch": time.time() - 31})
    assert not dg.held(tmp_path)
    replacement = dg.Singleton(tmp_path)
    try:
        assert replacement.acquire()
        assert not lock.owns()
    finally:
        lock.close()
        replacement.close()

def test_decode_transcript_path_before_canary_comparison():
    from dispatch_canary import first_user
    assert first_user([{"type": "user", "message": {"content": "Read C:\\\\foo\\\\spec.md"}}],
                      "C:\\\\foo\\\\spec.md")
    assert first_user([{"type": "user", "message": {"content": [{"type": "text",
                       "text": "Read C:/foo/spec.md"}]}}], "C:/foo/spec.md")

def test_transcript_end_turn_then_new_user_clears_idle_evidence(tmp_path):
    from dispatch_guard import transcript_observation
    path = tmp_path / "child.jsonl"
    path.write_text(json.dumps({"type": "assistant", "message": {"stop_reason": "end_turn"}}) + "\n",
                    encoding="utf-8")
    assert transcript_observation(path)[1]
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"type": "user", "message": {"content": "next turn"}}) + "\n")
    assert not transcript_observation(path)[1]


def test_corrupted_claude_draft_clears_and_bracket_pastes_with_four_guards(tmp_path, monkeypatch):
    import guard_actions
    monkeypatch.setattr(guard_actions.time, "sleep", lambda s: None)
    bridge = FakeBridge(["> hello[13;2u world"])
    original = bridge.request
    def request(command, args):
        result = original(command, args)
        if args.get("text") == "\x15":
            bridge.lines = [">"]
        elif args.get("text", "").startswith("\x1b[200~"):
            bridge.lines = ["> hello world"]
        elif args.get("key") == "enter":
            bridge.lines = [">"]
            bridge.state["view"]["session_revision"] += 1
        return result
    bridge.request = request
    clock = [1000]
    guard, _, _, _ = setup(tmp_path, bridge, now=lambda: clock[0])
    register_pending("s", "hello world", root=tmp_path, input_revision_after=2, session_epoch=10)
    guard.cycle()
    clock[0] += 61
    guard.cycle()
    assert [r.get("text") for r in bridge.writes] == ["\x15", "\x1b[200~hello world\x1b[201~", ""]
    assert bridge.writes[-1]["key"] == "enter"
    assert not pending_by_session(tmp_path)

def test_corrupt_draft_human_interference_after_clear_never_repasted(tmp_path, monkeypatch):
    import guard_actions
    monkeypatch.setattr(guard_actions.time, "sleep", lambda s: None)
    bridge = FakeBridge(["> hello[13;2u world"])
    original = bridge.request
    def request(command, args):
        result = original(command, args)
        bridge.state["input_revision"] += 1
        bridge.lines = ["> human"]
        return result
    bridge.request = request
    clock = [1000]
    guard, _, _, _ = setup(tmp_path, bridge, now=lambda: clock[0])
    register_pending("s", "hello world", root=tmp_path, input_revision_after=2, session_epoch=10)
    guard.cycle()
    clock[0] += 61
    guard.cycle()
    assert len(bridge.writes) == 1 and bridge.writes[0]["text"] == "\x15"

def test_once_dry_run_never_sends(tmp_path, monkeypatch, capsys):
    from types import SimpleNamespace
    bridge = FakeBridge(["2 new MCP servers found", "Select any you wish to enable.", "Enable selected"])
    _, _, path, _ = setup(tmp_path, bridge)
    monkeypatch.setenv("DISPATCH_GUARD_DIR", str(tmp_path))
    monkeypatch.setenv("DISPATCH_LEDGER", str(path))
    monkeypatch.setattr(dg, "load_agent_cli", lambda: SimpleNamespace(send_request=bridge.request))
    monkeypatch.setattr(dg, "load_bridge", lambda: SimpleNamespace(Bridge=lambda req: bridge))
    assert dg.main(["once", "--session", "s", "--dry-run"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["dry_run"] and result["alerts"]["cards"] == 0
    assert not bridge.writes

def test_dead_pty_is_classified_even_when_strict_status_is_unavailable(tmp_path):
    bridge = FakeBridge()
    bridge.tabs[0]["lifecycle"] = "exited"
    bridge.status = lambda sid: (_ for _ in ()).throw(RuntimeError("input revision unavailable"))
    guard, _, path, alerts = setup(tmp_path, bridge)
    state = guard.cycle()
    assert state["targets"]["s"]["verdict"]["cls"] == "pty_dead"
    assert ledger.load_dispatches(path)[0].status == "lost"
    assert len(alerts) == 1

@pytest.mark.parametrize("cls,lines", [
    ("login_required", ["Not logged in"]),
    ("tab_gone", None),
])
def test_guard_cards_satisfy_the_real_ops_entry_gate(tmp_path, cls, lines):
    """Bind the card the guard actually builds to the validator that judges it.

    The two lived apart until 2026-09-09: the guard's question carried a 句点 and
    ops_common rejected every one of them on question_sentences, silently, 51
    times. Import the real validator rather than restating its rules here, so a
    change on either side fails this test instead of the delivery path.
    """
    spec = importlib.util.spec_from_file_location(
        "ops_common", Path.home() / ".claude" / "ops" / "ops_common.py")
    ops = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ops)

    captured = []
    bridge = FakeBridge(lines) if lines else FakeBridge()
    if lines is None:
        bridge.tabs[0]["lifecycle"] = "exited"
        bridge.status = lambda sid: (_ for _ in ()).throw(RuntimeError("unavailable"))
    guard, actions, _, _ = setup(tmp_path, bridge)
    actions.alert = lambda card: captured.append(card) or {"enqueue_exit": 0}
    guard.cycle()

    assert captured, "the guard raised no card for " + cls
    for card in captured:
        ops.validate_ask_card(
            card["question"], card["detail"], card["options"],
            card["recommendation_reason"], card["blocking_reason"],
            card["decision_class"])

def test_append_only_files_have_a_ceiling(tmp_path):
    """No file this skill writes may grow without bound."""
    from guard_actions import MAX_LOG_BYTES, append_json, rotate_if_large
    log = tmp_path / "guard.log"
    log.write_bytes(b"x" * MAX_LOG_BYTES)
    append_json(log, {"event": "guard:cycle"})
    assert log.stat().st_size < MAX_LOG_BYTES
    assert (tmp_path / "guard.log.1").stat().st_size == MAX_LOG_BYTES
    # Below the ceiling nothing is moved.
    rotate_if_large(log)
    assert len(list(json_rows(log))) == 1

def test_rejected_escalation_is_spooled_instead_of_lost(tmp_path):
    """A card the ops entry gate refuses must stay visible.

    On 2026-09-08/09 the guard shelled out to ops_common enqueue, captured
    exit 2 into the audit trail, and moved on. 51 escalations vanished that way
    over 17 hours; nothing distinguished "never raised" from "raised and
    refused". The spool is what ask-inject reads to tell the two apart.
    """
    bridge = FakeBridge(["Not logged in"])
    guard, actions, _, alerts = setup(tmp_path, bridge)
    actions.alert = lambda card: alerts.append(card) or {
        "enqueue_exit": 2,
        "output": "ask validation failed [question_sentences]: ...",
    }
    guard.cycle()

    spooled = list(json_rows(tmp_path / "undelivered.jsonl"))
    assert len(spooled) == 1
    assert spooled[0]["cls"] == "login_required"
    assert spooled[0]["enqueue_exit"] == 2
    assert spooled[0]["card"]["question"]
    assert "question_sentences" in spooled[0]["output"]

def test_accepted_escalation_leaves_no_spool_row(tmp_path):
    bridge = FakeBridge(["Not logged in"])
    guard, _, _, alerts = setup(tmp_path, bridge)
    guard.cycle()
    assert len(alerts) == 1
    assert not (tmp_path / "undelivered.jsonl").exists()

def test_dead_pty_settles_and_does_not_re_act_on_the_next_cycle(tmp_path):
    """The whole point of the terminal gate: repeating a verdict must be free.

    Regression for 2026-09-09, when one dead-but-listed tab was re-judged every
    15 s for 4 h 21 min. mark_lost had already moved the ledger row, and
    Actions.escalate deduplicated the card, but audit() still wrote two rows per
    cycle -- 782 repeats for the worst single session. The old pty_dead test ran
    one cycle only, so nothing caught it.
    """
    bridge = FakeBridge()
    bridge.tabs[0]["lifecycle"] = "exited"
    bridge.status = lambda sid: (_ for _ in ()).throw(RuntimeError("input revision unavailable"))
    guard, _, path, alerts = setup(tmp_path, bridge)

    first = guard.cycle()
    assert first["targets"]["s"]["verdict"]["cls"] == "pty_dead"
    assert ledger.load_dispatches(path)[0].status == "lost"
    assert len(alerts) == 1
    rows_after_first = len(ledger.load_dispatches(path))
    log_after_first = len(list(json_rows(tmp_path / "guard.log")))

    second = guard.cycle()
    assert second["targets"]["s"]["verdict"]["cls"] == "pty_dead"
    assert second["targets"]["s"]["result"] == {"action": "mark_lost", "suppressed": "terminal"}
    assert len(alerts) == 1
    assert len(ledger.load_dispatches(path)) == rows_after_first
    # Only the per-cycle guard:cycle row may be added; no action / action-result pair.
    added = list(json_rows(tmp_path / "guard.log"))[log_after_first:]
    assert [row.get("event") for row in added] == ["guard:cycle"]

def test_terminal_gate_expires_so_a_still_stuck_tab_is_reported_again(tmp_path):
    """Settled is not silence forever: re-report on the documented 30 min cadence."""
    clock = {"t": 1000}
    bridge = FakeBridge()
    bridge.tabs[0]["lifecycle"] = "exited"
    bridge.status = lambda sid: (_ for _ in ()).throw(RuntimeError("input revision unavailable"))
    guard, _, _, alerts = setup(tmp_path, bridge, now=lambda: clock["t"])
    guard.cycle()
    assert len(alerts) == 1
    clock["t"] += dg.TERMINAL_TTL_SEC - 1
    guard.cycle()
    assert len(alerts) == 1
    clock["t"] += 2
    guard.cycle()
    assert len(alerts) == 2

def test_terminal_marker_is_dropped_when_the_session_epoch_changes(tmp_path):
    """A new epoch is a new life; the old verdict must not silence it."""
    bridge = FakeBridge(["Not logged in"])
    guard, _, _, alerts = setup(tmp_path, bridge)
    guard.cycle()
    assert guard.state["targets"]["s"]["verdict"]["cls"] == "login_required"
    assert len(alerts) == 1
    guard.cycle()
    assert len(alerts) == 1
    assert guard.state["targets"]["s"]["result"] == {"action": "block", "suppressed": "terminal"}
    bridge.state["view"]["session_epoch"] += 1
    third = guard.cycle()
    assert third["targets"]["s"]["result"] != {"action": "block", "suppressed": "terminal"}

def test_pending_delivery_confirms_exact_child_transcript_growth_when_state_does_not_change(tmp_path, monkeypatch):
    log = tmp_path / "child.jsonl"
    log.write_text("{}", encoding="utf-8")
    bridge = FakeBridge(["> hello"])
    original = bridge.request
    def request(command, args):
        result = original(command, args)
        bridge.lines = [">"]
        import os
        stat = log.stat()
        os.utime(log, (stat.st_atime, stat.st_mtime + 2))
        return result
    bridge.request = request
    monkeypatch.setattr(dg, "transcript_path", lambda *a, **kw: log)
    clock = [1000]
    guard, _, _, _ = setup(tmp_path, bridge, now=lambda: clock[0])
    register_pending("s", "hello", root=tmp_path, input_revision_after=2, session_epoch=10)
    guard.cycle()
    clock[0] += 61
    state = guard.cycle()
    assert state["targets"]["s"]["result"]["delivered_confirmed"]
    assert not state["targets"]["s"]["result"]["state_transition"]
    assert state["targets"]["s"]["result"]["transcript_growth"]
    assert len(bridge.writes) == 1

def test_permission_denies_with_one_digit_then_sends_required_instruction(tmp_path):
    from guard_actions import DENY_TEXT
    bridge = FakeBridge(["Do you want to proceed?", "\u276f 1. Yes",
                         "  2. Yes, and don't ask again",
                         "  3. No, and tell Claude what to do differently"])
    original = bridge.request
    def request(command, args):
        result = original(command, args)
        bridge.lines = [">"]
        return result
    bridge.request = request
    guard, actions, _, _ = setup(tmp_path, bridge)
    instructions = []
    actions.send_text = lambda sid, text: instructions.append(text) or {"result": "observed_delivered"}
    guard.cycle()
    assert len(bridge.writes) == 1 and bridge.writes[0]["text"] == "3"
    assert not bridge.writes[0].get("key") and bridge.writes[0]["enter"] is False
    assert instructions == [DENY_TEXT]

def test_single_ask_answers_first_option_with_no_enter(tmp_path):
    fixture = Path(__file__).parent / "fixtures" / "screens" / "ask_single.txt"
    bridge = FakeBridge(fixture.read_text(encoding="utf-8").splitlines())
    guard, _, _, _ = setup(tmp_path, bridge)
    guard.cycle()
    assert len(bridge.writes) == 1 and bridge.writes[0]["text"] == "1"
    assert not bridge.writes[0].get("key") and bridge.writes[0]["enter"] is False

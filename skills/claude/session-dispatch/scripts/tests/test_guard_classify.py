from dataclasses import replace
from pathlib import Path
import pytest
from guard_classify import Observation, classify, current_input_line, input_body

FIXTURES = Path(__file__).parent / "fixtures" / "screens"

def observation(name="empty", **changes):
    lines = (FIXTURES / (name + ".txt")).read_text(encoding="utf-8").splitlines()
    obs = Observation(state_view={"lifecycle": "alive", "health": "fresh", "activity": "idle",
        "input_revision": 3, "session_epoch": 9, "attention": {"kind": "input", "attention_id": "a"}},
        screen_lines=lines, input_line=current_input_line(lines), idle_since_s=181,
        transcript_age_s=300, is_dispatch_child=True)
    return replace(obs, **changes)

@pytest.mark.parametrize("fixture,expected", [
    ("startup_mcp", "startup_dialog"), ("trust", "startup_dialog"),
    ("auto_start", "startup_dialog"), ("whats_new", "startup_dialog"),
    ("ask_single", "ask_dialog"), ("ask_tabbed", "ask_dialog"),
    ("ask_review", "ask_dialog"), ("ask_multi", "ask_dialog"),
    ("permission", "permission_prompt"), ("login", "login_required"),
    ("unknown", "unknown"), ("empty", "idle_no_done")])
def test_recorded_screens(fixture, expected):
    assert classify(observation(fixture)).cls == expected

def test_normal_recording():
    obs = observation("normal_working")
    obs.state_view["activity"] = "streaming"
    obs.state_view["attention"]["kind"] = "none"
    assert classify(obs).cls == "ok_working"

@pytest.mark.parametrize("owned,expected", [(True, "draft_unsent"), (False, "human_draft")])
def test_corruption_requires_machine_provenance(owned, expected):
    pending = {"text": "hello world", "origin": "dispatch_send",
               "input_revision_after": 3, "session_epoch": 9} if owned else None
    verdict = classify(observation("draft_corrupt", pending_send=pending))
    assert verdict.cls == expected
    assert verdict.action == ("deliver_pending" if owned else "none")

@pytest.mark.parametrize("changed", [{"input_revision_after": 4}, {"session_epoch": 8},
                                    {"origin": "human"}, {"text": "different"}])
def test_human_edit_or_reused_epoch_never_sent(changed):
    pending = dict(text="hello world", origin="dispatch_send", input_revision_after=3, session_epoch=9, **{})
    pending.update(changed)
    assert classify(observation("draft_corrupt", pending_send=pending)).action == "none"

@pytest.mark.parametrize("fixture", ["ask_single", "permission"])
def test_manual_dialog_alert_only(fixture):
    assert classify(observation(fixture, is_dispatch_child=False)).action == "escalate"

@pytest.mark.parametrize("fixture,cls,limit", [
    ("startup_mcp", "startup_dialog", 3), ("permission", "permission_prompt", 3),
    ("empty", "idle_no_done", 2)])
def test_retry_bound(fixture, cls, limit):
    assert classify(observation(fixture, counters={cls: limit})).action == "escalate"

def test_unowned_idle_alert_and_active_draft_not_submitted():
    obs = observation("draft_corrupt", idle_since_s=600)
    assert classify(obs).params["escalation"] == "human_draft_idle"
    # Genuinely streaming (attention none, no end_turn): a draft is never touched.
    obs.state_view["activity"] = "streaming"
    obs.state_view["attention"]["kind"] = "none"
    assert classify(obs).cls == "ok_working"


def test_hook_waiting_beats_streaming_activity():
    """Real idle Claude tabs report activity=streaming while attention=input (2026-09-08
    実測: 数学 監視 tab, attention input, activity streaming). The hook's waiting signal
    must let drafts and idle children be classified even without a transcript end_turn."""
    human = observation("human_draft", idle_since_s=600, is_dispatch_child=False)
    human.state_view["activity"] = "streaming"
    verdict = classify(human)
    assert verdict.cls == "human_draft"
    assert verdict.action == "escalate"
    assert verdict.params["escalation"] == "human_draft_idle"
    owned = observation("draft_corrupt", pending_send={"text": "hello world", "origin": "dispatch_send",
                        "input_revision_after": 3, "session_epoch": 9})
    owned.state_view["activity"] = "streaming"
    assert classify(owned).action == "deliver_pending"
    idle_child = observation("empty")
    idle_child.state_view["activity"] = "streaming"
    assert classify(idle_child).cls == "idle_no_done"

def test_missing_two_cycles_and_dead():
    assert classify(Observation(present=False, counters={"missing": 1})).action == "none"
    assert classify(Observation(present=False, counters={"missing": 2})).action == "mark_lost"
    assert classify(Observation(state_view={"lifecycle": "exited"})).action == "mark_lost"

@pytest.mark.parametrize("kind", ["rate_limited", "error"])
def test_rate_error_grace(kind):
    obs = observation()
    obs.state_view["attention"]["kind"] = kind
    assert classify(obs).action == "none"
    assert classify(replace(obs, idle_since_s=1800)).action == "escalate"

def test_idle_done_pending_ask_and_manual_are_not_nudged():
    for changes in ({"done_exists": True}, {"pending_ask": True}, {"is_dispatch_child": False}):
        assert classify(observation(**changes)).cls == "ok_waiting"
    assert classify(observation(counters={"idle_no_done_age_s": 50})).action == "none"

def test_ambiguous_structure_and_historical_output_not_operated():
    assert classify(observation("malformed_ask")).action == "none"
    assert classify(observation("permission_unparsed")).action == "escalate"
    obs = observation("login")
    obs.screen_lines += [">", "\u2500" * 20]
    obs.input_line = current_input_line(obs.screen_lines)
    assert classify(obs).cls == "idle_no_done"

def test_footer_is_not_a_draft():
    assert input_body(current_input_line([">", "\u2500" * 20, "auto mode on"])) == ""

def test_stale_streaming_with_exact_transcript_end_turn_can_deliver_owned_draft():
    obs = observation("draft_corrupt", pending_send={"text": "hello world", "origin": "canary",
        "input_revision_after": 3, "session_epoch": 9}, turn_ended=True)
    obs.state_view["activity"] = "streaming"
    assert classify(obs).action == "deliver_pending"
    # Without end_turn the hook's attention=input still proves the tab is waiting.
    obs.turn_ended = False
    assert classify(obs).action == "deliver_pending"
    # Neither end_turn nor attention=input: streaming means working, never deliver.
    obs.state_view["attention"]["kind"] = "none"
    assert classify(obs).cls == "ok_working"

def test_real_claude_nbsp_input_uses_bridge_parser_after_normalization():
    obs = observation("claude_nbsp_draft", pending_send={
        "text": "CANARY_DRAFT: write DONE.md containing CANARY_DRAFT now, then finish.",
        "origin": "canary", "input_revision_after": 3, "session_epoch": 9})
    assert input_body(obs.input_line).startswith("CANARY_DRAFT")
    assert classify(obs).cls == "draft_unsent"

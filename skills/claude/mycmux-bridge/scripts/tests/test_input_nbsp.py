from pathlib import Path
import importlib.util
from copy import deepcopy
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "mycmux_bridge.py"
spec = importlib.util.spec_from_file_location("nbsp_test_bridge", SCRIPT)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

@pytest.mark.parametrize("prompt,kind", [("\u276f", "Claude Code"), (">", "Claude Code"), ("\u203a", "Codex")])
@pytest.mark.parametrize("separator", [" ", "\xa0", "\t"])
def test_input_prompt_whitespace(prompt, kind, separator):
    lines = ["history", "\u2500" * 20, prompt + separator + "sample body",
             "\u2500" * 20, "-- INSERT --"]
    found = bridge.current_input_line(lines)
    assert found is not None and found[:2] == (3, kind)
    assert found[2].startswith("sample body")
    assert bridge.draft_visible(lines, "sample body")

@pytest.mark.parametrize("prompt", ["\u276f", "\u203a"])
@pytest.mark.parametrize("separator", [" ", "\xa0"])
def test_history_and_try_placeholder_are_not_a_staged_draft(prompt, separator):
    lines = ["history: sample body", "\u2500" * 20, prompt + separator + 'Try "an example"',
             "\u2500" * 20, "-- INSERT --", "sample body"]
    assert bridge.current_input_line(lines) is not None
    assert not bridge.draft_visible(lines, "sample body")

@pytest.mark.parametrize("separator", [" ", "\xa0"])
@pytest.mark.parametrize("residue", [False, True])
def test_send_uses_the_input_area_with_nbsp_and_insert_footer(separator, residue):
    state = {"session_id": "pty-sample", "input_revision": 4, "ui_state": "idle",
             "view": {"session_id": "pty-sample", "session_epoch": 2,
                      "session_revision": 8, "lifecycle": "alive", "health": "fresh",
                      "activity": "idle", "attention": {"kind": "none", "attention_id": None}}}
    body = ""
    submitted = False
    writes = []
    def request(cmd, args):
        nonlocal body, submitted
        if cmd == "pane.list_all":
            return {"panes": [{"id": "pane-sample", "workspaceId": "ws-sample", "tabs": [{"id": "tab-sample", "sessionId": "pty-sample", "type": "terminal"}]}]}
        if cmd == "session.state_view":
            return {"sessions": [deepcopy(state)]}
        if cmd == "pane.read":
            visible = body if not submitted or residue else ""
            hint = visible or 'Try "an example"'
            return {"sessionId": "pty-sample", "lines": [
                "history: sample body" + (" processed" if submitted else ""),
                "\u2500" * 20, "\u276f" + separator + hint, "\u2500" * 20, "-- INSERT --"]}
        assert cmd == "pane.send_text"
        writes.append(deepcopy(args))
        assert args["expectedInputRevision"] == state["input_revision"]
        state["input_revision"] += 1
        if args.get("key") == "enter":
            submitted = True
            state["view"]["session_revision"] += 1
            state["view"]["activity"] = "streaming"
            return {"ok": True, "confirmed": True}
        body = args["text"]
        return {"unverified": True}
    client = bridge.Bridge(request, sleep=lambda _: None, observations=2, poll_seconds=0)
    result = client.send("sample body", session_id="pty-sample")
    assert [p.get("key") for p in writes] == [None, "enter"]
    assert result["result"] == ("residue_remains" if residue else "observed_delivered")
    assert "input line" in result["detail"] or "Claude Code" in result["detail"]

def test_bridge_preserves_stale_draft_no_write_receipt():
    state = {"session_id": "pty-stale", "input_revision": 4,
             "view": {"session_id": "pty-stale", "session_epoch": 2,
                      "session_revision": 8, "lifecycle": "alive", "health": "fresh",
                      "attention": {"kind": "none", "attention_id": None}}}
    typed = False
    def request(cmd, args):
        nonlocal typed
        if cmd == "pane.list_all":
            return {"panes": [{"id": "pane-sample", "workspaceId": "ws-sample", "tabs": [{"id": "tab-stale", "sessionId": "pty-stale", "type": "terminal"}]}]}
        if cmd == "session.state_view":
            return {"sessions": [deepcopy(state)]}
        if cmd == "pane.read":
            return {"sessionId": "pty-stale", "lines": ["> " + ("hello" if typed else "")]}
        assert cmd == "pane.send_text"
        if args.get("key") == "enter":
            return {"sent": False, "reason": "stale_staged_draft", "textWritten": False, "enterWritten": False}
        typed = True
        state["input_revision"] += 1
        return {"unverified": True}
    client = bridge.Bridge(request, sleep=lambda _: None, observations=2, poll_seconds=0)
    result = client.send("hello", session_id="pty-stale")
    assert result["enter_sent"] is False
    assert result["write_reason"] == "stale_staged_draft"
    assert result["textWritten"] is False and result["enterWritten"] is False

"""dispatch_send の契約テスト (B5): 鮮度ガードの期待値組み立て."""

from __future__ import annotations

import json
from copy import deepcopy
from types import SimpleNamespace
from pathlib import Path

import pytest

import dispatch_send

STATE_VIEW = {
    "sessions": [
        {
            "session_id": "pty-tab-1",
            "ui_state": "waiting",
            "input_revision": 5,
            "view": {
                "session_id": "pty-tab-1",
                "session_epoch": 1786548298595,
                "session_revision": 265,
                "lifecycle": "alive",
                "health": "fresh",
                "activity": "idle",
                "attention": {"attention_id": "pty-tab-1:1786548298595:2:1", "kind": "input"},
            },
        }
    ]
}


def write_ledger(tmp_path: Path, records: list[dict]) -> Path:
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )
    return ledger


def test_expectations_come_from_state_view() -> None:
    expectations = dispatch_send.build_expectations(STATE_VIEW, "pty-tab-1")
    assert expectations == {
        "expect_epoch": 1786548298595,
        "expect_revision": 265,
        "expect_attention_id": "pty-tab-1:1786548298595:2:1",
        "expect_input_revision": 5,
    }


def test_attention_guard_is_always_present() -> None:
    assert dispatch_send.build_expectations(STATE_VIEW, "pty-tab-1", include_attention=True) == (
        dispatch_send.build_expectations(STATE_VIEW, "pty-tab-1")
    )


def test_unknown_session_refuses_to_send() -> None:
    with pytest.raises(RuntimeError):
        dispatch_send.build_expectations({"sessions": []}, "pty-tab-1")
    with pytest.raises(RuntimeError):
        dispatch_send.build_expectations(None, "pty-tab-1")


def test_missing_epoch_refuses_to_send() -> None:
    view = {"sessions": [{"session_id": "s", "view": {"session_epoch": None, "session_revision": 1}}]}
    with pytest.raises(RuntimeError):
        dispatch_send.build_expectations(view, "s")


def test_argv_carries_every_guard() -> None:
    expectations = dispatch_send.build_expectations(
        STATE_VIEW, "pty-tab-1", include_attention=True
    )
    argv = dispatch_send.build_send_argv("pty-tab-1", "こんにちは", enter=True, expectations=expectations)
    assert argv[2] == "send"
    assert "--enter" in argv
    assert argv[argv.index("--expect-epoch") + 1] == "1786548298595"
    assert argv[argv.index("--expect-revision") + 1] == "265"
    assert argv[argv.index("--expect-attention-id") + 1] == "pty-tab-1:1786548298595:2:1"


def test_resolve_refuses_closed_and_ambiguous(tmp_path: Path) -> None:
    closed = write_ledger(
        tmp_path,
        [{"ts": "2026-08-13T10:00:00", "slug": "260813-foo", "tab_session_id": "t1", "status": "closed"}],
    )
    with pytest.raises(RuntimeError, match="クローズ済み"):
        dispatch_send.resolve_session_id(closed, "260813-foo", None)

    ambiguous = write_ledger(
        tmp_path,
        [
            {"ts": "2026-08-13T10:00:00", "slug": "260813-foo", "tab_session_id": "t1", "status": "open"},
            {"ts": "2026-08-13T11:00:00", "slug": "260813-foo", "tab_session_id": "t2", "status": "open"},
        ],
    )
    with pytest.raises(RuntimeError, match="複数"):
        dispatch_send.resolve_session_id(ambiguous, "260813-foo", None)
    assert (
        dispatch_send.resolve_session_id(ambiguous, "260813-foo", "2026-08-13T11:00:00") == "t2"
    )


def test_resolve_reports_missing_slug(tmp_path: Path) -> None:
    ledger = write_ledger(tmp_path, [])
    with pytest.raises(RuntimeError, match="slug"):
        dispatch_send.resolve_session_id(ledger, "260813-foo", None)


@pytest.mark.parametrize("field", ["session_epoch", "session_revision", "input_revision"])
@pytest.mark.parametrize("value", [None, -1, True, False])
def test_invalid_expectation_refuses(field, value) -> None:
    state = deepcopy(STATE_VIEW)
    entry = state["sessions"][0]
    container = entry if field == "input_revision" else entry["view"]
    container[field] = value
    with pytest.raises(RuntimeError):
        dispatch_send.build_expectations(state, "pty-tab-1")


def test_no_attention_is_json_null_and_argv_includes_input_revision() -> None:
    state = deepcopy(STATE_VIEW)
    state["sessions"][0]["view"]["attention"] = {"kind": "none", "attention_id": None}
    expectations = dispatch_send.build_expectations(state, "pty-tab-1")
    assert json.loads(json.dumps(expectations))["expect_attention_id"] is None
    argv = dispatch_send.build_send_argv("pty-tab-1", "hello", enter=True, expectations=expectations)
    assert argv[argv.index("--expect-attention-id") + 1] == "null"
    assert argv[argv.index("--expect-input-revision") + 1] == "5"


class MockPty:
    """Canonical state and guarded writes; no sockets or subprocess sends."""
    def __init__(self, *, interference=None):
        self.entry = deepcopy(STATE_VIEW["sessions"][0])
        self.entry["view"]["attention"] = {"kind": "none", "attention_id": None}
        self.interference = interference
        self.calls = []
        self.writes = []
        self.text = ""
        self.submitted = False
        self.states_after_text = 0
        self.reads = 0
        self.draft_reads = 0

    def __call__(self, cmd, args):
        self.calls.append((cmd, deepcopy(args)))
        if cmd == "pane.list_all":
            return {"panes": [{
                "id": "pane-1", "workspaceId": "ws-1",
                "tabs": [{"id": "tab-1", "sessionId": "pty-tab-1", "type": "terminal"}],
            }]}
        if cmd == "session.state_view":
            self.reads += 1
            if self.reads == 2 and self.interference == "old_epoch":
                self.entry["view"]["session_epoch"] += 1
            if self.text and not self.submitted:
                self.states_after_text += 1
                if (self.interference == "after_text" and self.states_after_text == 1
                        or self.interference == "before_enter" and self.states_after_text == 3):
                    self.entry["input_revision"] += 1
            return {"sessions": [deepcopy(self.entry)]}
        if cmd == "pane.read":
            lines = ["processing", "PS>"] if self.submitted else ["PS> " + self.text]
            if self.text and not self.submitted:
                self.draft_reads += 1
                if self.interference == "last_gap" and self.draft_reads == 3:
                    self.entry["input_revision"] += 1
            return {"sessionId": "pty-tab-1", "lines": lines}
        assert cmd == "pane.send_text"
        expected = {
            "expectedSessionEpoch": self.entry["view"]["session_epoch"],
            "expectedSessionRevision": self.entry["view"]["session_revision"],
            "expectedAttentionId": self.entry["view"]["attention"]["attention_id"],
            "expectedInputRevision": self.entry["input_revision"],
        }
        assert set(expected) <= set(args)
        if any(args[key] != value for key, value in expected.items()):
            return {"sent": False, "reason": "input_revision"}
        self.writes.append(deepcopy(args))
        self.entry["input_revision"] += 1
        if args.get("key") == "enter":
            self.submitted = True
            self.entry["view"]["session_revision"] += 1
            self.entry["view"]["activity"] = "running_silent"
            self.entry["view"]["attention"] = {"kind": "none", "attention_id": None}
            return {"ok": True, "confirmed": True}
        self.text = args["text"]
        return {"sessionId": "pty-tab-1", "queuedBytes": len(self.text.encode("utf-8")), "unverified": True}


@pytest.fixture()
def install_transport(monkeypatch):
    original_confirm = dispatch_send.confirm_delivery
    monkeypatch.setattr(dispatch_send, "confirm_delivery",
                        lambda *a, **kw: original_confirm(*a, timeout=0, **kw))
    monkeypatch.setattr(dispatch_send, "ensure_guard", lambda: {"alive": True})
    monkeypatch.setattr(dispatch_send, "handoff_pending", lambda *a, **kw: {})
    module = dispatch_send.load_bridge()
    bridge_class = module.Bridge
    monkeypatch.setattr(module, "Bridge", lambda request: bridge_class(
        request, sleep=lambda _seconds: None, observations=2, poll_seconds=0,
    ))
    def install(transport):
        monkeypatch.setattr(dispatch_send, "load_agent_cli", lambda: SimpleNamespace(send_request=transport))
        return transport
    return install


@pytest.mark.parametrize("extra", [[], ["--enter"]])
def test_main_delivers_body_then_exactly_one_enter(install_transport, capsys, extra):
    transport = install_transport(MockPty())
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello", *extra]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["result"] == "observed_delivered"
    assert result["ok"] is True and result["confirmed"] is True
    assert result["enter_sent"] is True
    assert "warning" not in result
    assert [write.get("key") for write in transport.writes] == [None, "enter"]
    assert [write["expectedInputRevision"] for write in transport.writes] == [5, 6]
    assert all(write["expectedAttentionId"] is None and write["enter"] is False for write in transport.writes)


@pytest.mark.parametrize("interference", ["after_text", "before_enter", "last_gap"])
def test_external_input_never_applies_enter(install_transport, capsys, interference):
    transport = install_transport(MockPty(interference=interference))
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["result"] != "observed_delivered"
    assert result["enter_sent"] is False
    assert [write.get("key") for write in transport.writes] == [None]
    requests = [args for cmd, args in transport.calls if cmd == "pane.send_text"]
    assert len(requests) == (2 if interference == "last_gap" else 1)
    if interference == "last_gap":
        assert requests[-1]["expectedInputRevision"] == 6


@pytest.mark.parametrize("lifecycle", ["closed", "exited"])
def test_direct_closed_session_never_writes(install_transport, lifecycle):
    transport = MockPty()
    transport.entry["view"]["lifecycle"] = lifecycle
    install_transport(transport)
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 3
    assert transport.writes == []


def test_old_epoch_refuses_before_any_input(install_transport):
    transport = install_transport(MockPty(interference="old_epoch"))
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 3
    assert transport.writes == []


@pytest.mark.parametrize("mode", ["--show", "--dry-run"])
def test_preview_preserves_state_expectations_and_never_sends(install_transport, capsys, mode):
    transport = install_transport(MockPty())
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello", mode]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["enter_sent"] is False
    assert not any(cmd == "pane.send_text" for cmd, _ in transport.calls)
    if mode == "--dry-run":
        assert result["state"]["input_revision"] == 5
        assert result["request"]["text"] == "hello"
        assert result["expectations"] == {
            "expectedSessionEpoch": 1786548298595,
            "expectedAttentionId": None,
            "expectedSessionRevision": 265,
            "expectedInputRevision": 5,
        }
    else:
        assert result["expect_input_revision"] == 5


def test_explicit_empty_enter_is_one_guarded_key(install_transport, capsys):
    transport = install_transport(MockPty())
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "", "--enter"]) == 0
    assert json.loads(capsys.readouterr().out)["result"] == "observed_delivered"
    assert len(transport.writes) == 1
    assert transport.writes[0]["key"] == "enter"
    assert transport.writes[0]["expectedInputRevision"] == 5


def test_attention_opt_in_keeps_exact_id_until_submit(install_transport, capsys):
    transport = MockPty()
    transport.entry["view"]["attention"] = {"kind": "input", "attention_id": "ask-1"}
    install_transport(transport)
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello", "--expect-attention"]) == 0
    assert json.loads(capsys.readouterr().out)["result"] == "observed_delivered"
    assert all(write["expectedAttentionId"] == "ask-1" for write in transport.writes)


def test_main_reports_ambiguous_slug_without_contacting_mycmux(tmp_path, monkeypatch, capsys):
    ledger = write_ledger(tmp_path, [
        {"slug": "260907-new", "ts": "t1", "tab_session_id": "a", "status": "open"},
        {"slug": "260907-new", "ts": "t2", "tab_session_id": "b", "status": "open"},
    ])
    def unexpected():
        raise AssertionError("ambiguous ledger must not contact mycmux")
    monkeypatch.setattr(dispatch_send, "load_agent_cli", unexpected)
    assert dispatch_send.main([
        "--slug", "260907-new", "--ledger", str(ledger), "--text", "hello",
    ]) == 3
    assert "--spawn-ts" in capsys.readouterr().err


@pytest.mark.parametrize(
    "post_screen",
    [
        ["› hello", "• response", "› Ask Codex to do anything", "... · Ready"],
        ["PS> hello", "output", "PS>"],
    ],
)
def test_main_reports_delivery_despite_transcript_echo(install_transport, capsys, post_screen):
    pty = MockPty()

    def transport(cmd, args):
        result = pty(cmd, args)
        if cmd == "pane.read" and pty.submitted:
            result["lines"] = post_screen
        return result

    install_transport(transport)
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["result"] == "observed_delivered"
    assert result["enter_sent"] is True
    assert result["ok"] is True and result["confirmed"] is True
    assert "warning" not in result
    assert [write.get("key") for write in pty.writes] == [None, "enter"]


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        ("residue", "residue_remains"),
        ("verification_error", "verification_unavailable"),
        ("lost_reply", "write_failed"),
    ],
)
def test_main_returns_zero_and_warning_after_enter_even_when_uncertain(install_transport, capsys, mode, expected):
    pty = MockPty()

    def transport(cmd, args):
        if mode == "verification_error" and pty.submitted and cmd == "session.state_view":
            raise RuntimeError("state unavailable")
        result = pty(cmd, args)
        if mode == "residue" and pty.submitted and cmd == "pane.read":
            result["lines"] = ["PS> hello"]
        if mode == "lost_reply" and cmd == "pane.send_text" and args.get("key") == "enter":
            raise OSError("response lost")
        return result

    install_transport(transport)
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["result"] == expected
    assert result["enter_sent"] is True
    assert result["ok"] is False and result["confirmed"] is False
    assert "Do not resend automatically" in result["warning"]
    assert [write.get("key") for write in pty.writes] == [None, "enter"]


def test_main_draft_not_observed_is_nonzero_and_enter_not_sent(install_transport, capsys):
    pty = MockPty()

    def transport(cmd, args):
        result = pty(cmd, args)
        if cmd == "pane.read":
            result["lines"] = ["previous: hello", "PS>"]
        return result

    install_transport(transport)
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["result"] == "draft_not_observed"
    assert result["enter_sent"] is False
    assert [write.get("key") for write in pty.writes] == [None]


@pytest.mark.parametrize("mode", ["closed", "no_text"])
def test_main_refusal_has_json_enter_not_sent(install_transport, capsys, mode):
    pty = MockPty()
    if mode == "closed":
        pty.entry["view"]["lifecycle"] = "closed"
    install_transport(pty)
    args = ["--session", "pty-tab-1"] + (["--text", "hello"] if mode == "closed" else [])
    assert dispatch_send.main(args) == (3 if mode == "closed" else 2)
    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert result["enter_sent"] is False
    assert result["ok"] is False and result["confirmed"] is False
    assert "SEND-REFUSED:" in captured.err
    assert pty.writes == []


def test_unconfirmed_send_records_owned_revision_and_added_fields(install_transport, monkeypatch, capsys):
    pty = MockPty()
    def transport(cmd, args):
        result = pty(cmd, args)
        if cmd == "pane.read" and pty.submitted:
            result["lines"] = ["PS> hello"]
        return result
    install_transport(transport)
    pending = []
    monkeypatch.setattr(dispatch_send, "handoff_pending", lambda *a, **kw: pending.append((a, kw)))
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["guard_pending"] is True and result["delivered_confirmed"] is False
    assert pending[0][1]["input_revision_after"] == 7
    assert pending[0][1]["session_epoch"] == pty.entry["view"]["session_epoch"]
    assert [write.get("key") for write in pty.writes] == [None, "enter"]

def test_external_edit_handoff_keeps_machine_revision_not_human_revision(install_transport, monkeypatch, capsys):
    pty = install_transport(MockPty(interference="after_text"))
    pending = []
    monkeypatch.setattr(dispatch_send, "handoff_pending", lambda *a, **kw: pending.append((a, kw)))
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["enter_sent"] is False
    assert pending[0][1]["input_revision_after"] == 6
    assert pty.entry["input_revision"] == 7


def test_text_to_a_finished_child_expects_its_current_done_id(install_transport, capsys):
    transport = MockPty()
    transport.entry["view"]["attention"] = {"kind": "done", "attention_id": "pty-tab-1:done:7"}
    install_transport(transport)
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 0
    assert json.loads(capsys.readouterr().out)["result"] == "observed_delivered"
    assert [write.get("key") for write in transport.writes] == [None, "enter"]
    assert all(write["expectedAttentionId"] == "pty-tab-1:done:7" for write in transport.writes)


@pytest.mark.parametrize("kind", ["approval", "input", "error", "rate_limited"])
def test_text_is_not_sent_into_another_prompt(install_transport, capsys, kind):
    transport = MockPty()
    transport.entry["view"]["attention"] = {"kind": kind, "attention_id": "prompt-1"}
    install_transport(transport)
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 3
    captured = capsys.readouterr()
    assert json.loads(captured.out)["enter_sent"] is False
    assert f"target attention is {kind}" in captured.err
    assert not any(cmd == "pane.send_text" for cmd, _ in transport.calls)


class RecoveryPty(MockPty):
    def __init__(self, mode):
        super().__init__()
        self.mode = mode
        self.hidden_reads = 0
        self.refused = False
        self.clear_count = 0

    def __call__(self, cmd, args):
        if cmd == "pane.read" and self.mode == "claude_hint":
            body = self.text if not self.submitted else ""
            return {"sessionId": "pty-tab-1", "lines": ["\u2500" * 20,
                "\u276f\xa0" + (body or 'Try "an example"'), "\u2500" * 20, "-- INSERT --"]}
        if cmd == "pane.read" and self.text and not self.submitted:
            self.hidden_reads += 1
            if self.mode in {"enter_only", "stale_retry", "foreign", "duplicate", "unknown_enter", "unknown_text"} and self.hidden_reads <= 2:
                return {"sessionId": "pty-tab-1", "lines": ["PS>"]}
            if self.mode == "foreign":
                return {"sessionId": "pty-tab-1", "lines": ["PS> other input"]}
            if self.mode == "duplicate":
                return {"sessionId": "pty-tab-1", "lines": ["PS> " + self.text * 2]}
        if cmd == "pane.send_text":
            if args.get("key") == "enter" and self.mode == "unknown_enter":
                raise OSError("reply lost after Enter")
            if args.get("key") == "enter" and self.mode in {"stale", "stale_retry", "claude_hint", "legacy", "not_empty", "clear_race", "unknown_combined", "unknown_clear"} and not self.refused:
                self.refused = True
                self.entry["input_revision"] += 1
                return {"sent": False, "reason": "session_revision" if self.mode == "legacy" else "stale_staged_draft",
                        "textWritten": False, "enterWritten": False}
            if args.get("key") == "ctrl-c":
                self.clear_count += 1
                if self.mode == "unknown_clear":
                    raise OSError("clear outcome unknown")
                assert args["expectedInputRevision"] == self.entry["input_revision"]
                self.writes.append(deepcopy(args))
                self.entry["input_revision"] += 2 if self.mode == "clear_race" else 1
                if self.mode != "not_empty":
                    self.text = ""
                return {"ok": False, "confirmed": False, "enterWritten": True}
            if args.get("enter") is True:
                if self.mode == "unknown_combined":
                    raise OSError("reply lost after combined send")
                assert self.text == ""
                assert args["expectedInputRevision"] == self.entry["input_revision"]
                self.writes.append(deepcopy(args))
                self.entry["input_revision"] += 2
                self.entry["view"]["session_revision"] += 1
                self.entry["view"]["activity"] = "running_silent"
                self.text = args["text"]
                self.submitted = True
                return {"ok": True, "confirmed": True, "enterWritten": True}
        response = super().__call__(cmd, args)
        if cmd == "pane.send_text" and args.get("text") and self.mode == "unknown_text":
            raise OSError("text reply lost")
        return response


@pytest.mark.parametrize("mode", ["enter_only", "stale", "stale_retry", "claude_hint"])
def test_dead_guard_finishes_in_the_request(install_transport, monkeypatch, capsys, mode):
    pty = install_transport(RecoveryPty(mode))
    monkeypatch.setattr(dispatch_send, "ensure_guard", lambda: {"alive": False})
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["enter_sent"] is True and pty.submitted
    assert result.get("enterWritten") is not False
    if mode in {"stale", "claude_hint"}:
        assert result["initial_rejection"] == {"write_reason": "stale_staged_draft",
                                                "textWritten": False, "enterWritten": False}
        assert "write_reason" not in result
    assert result["guard_pending"] is False
    assert len([p for p in pty.writes if p.get("text")]) == (1 if mode == "enter_only" else 2)
    assert pty.clear_count == (0 if mode == "enter_only" else 1)
    assert result["recovery"] == ("enter_only" if mode == "enter_only" else "combined")


@pytest.mark.parametrize("mode", ["foreign", "duplicate", "legacy", "not_empty", "clear_race", "unknown_clear", "unknown_text"])
def test_dead_guard_refuses_foreign_input_and_legacy_refusals(install_transport, monkeypatch, capsys, mode):
    pty = install_transport(RecoveryPty(mode))
    monkeypatch.setattr(dispatch_send, "ensure_guard", lambda: {"alive": False})
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["enter_sent"] is False and not pty.submitted
    assert result["guard_pending"] is False
    assert len([p for p in pty.writes if p.get("text")]) == 1
    assert "guard owns" not in result["warning"]
    assert result["recovery"] == "stopped"


@pytest.mark.parametrize("mode", ["unknown_enter", "unknown_combined"])
def test_dead_guard_never_repeats_an_unknown_submit(install_transport, monkeypatch, capsys, mode):
    pty = install_transport(RecoveryPty(mode))
    monkeypatch.setattr(dispatch_send, "ensure_guard", lambda: {"alive": False})
    assert dispatch_send.main(["--session", "pty-tab-1", "--text", "hello"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["enter_sent"] is True
    assert pty.clear_count <= 1
    assert len([p for p in pty.writes if p.get("text")]) == 1
    assert result["confirmed"] is False



RECOVERY_BODY = "Read the sample specification and preserve every completed artifact. " * 4
RECOVERY_MULTILINE = "Read the sample specification.\nPreserve completed artifacts.\nWrite the requested result."


CODEX_0165_STATUS = "Context 3% used \u00b7 sample-model \u00b7 ~\\work\\sample"


class RecoveryScreenPty(RecoveryPty):
    """Synthetic wrapped/paste/Codex screens; all writes stay in this transport."""
    def __init__(self, screen, empty_screen="codex-empty"):
        super().__init__("")
        self.screen = screen
        self.empty_screen = empty_screen

    def __call__(self, command, args):
        if command != "pane.read":
            return super().__call__(command, args)
        body = self.text if not self.submitted else ""
        if not body and self.empty_screen == "codex-0165":
            lines = ["\u203a Ask Codex to do anything", CODEX_0165_STATUS, "? for shortcuts"]
        elif not body:
            hint = {"codex-empty": "", "codex-try": 'Try "a sample task"',
                    "codex-example": "Ask Codex to do anything"}[self.empty_screen]
            lines = ["\u203a " + hint, "", "? for shortcuts", "sample-model \u00b7 100% context left"]
        elif self.screen == "wrapped":
            rows = [body[i:i + 37] for i in range(0, len(body), 37)]
            lines = ["\u2500" * 40, "\u276f\xa0" + rows[0],
                     *("  " + row for row in rows[1:]), "\u2500" * 40, "-- INSERT --"]
        elif self.screen == "multiline":
            rows = body.splitlines()
            lines = ["\u276f " + rows[0], *("  " + row for row in rows[1:]),
                     "\u2500" * 40, "-- INSERT --"]
        elif self.screen == "paste":
            lines = ["\u276f\xa0[Pasted text #1 +42 lines]", "\u2500" * 40, "-- INSERT --"]
        elif self.screen == "two-pastes":
            lines = ["\u276f [Pasted text #1 +42 lines]", "  [Pasted text #2 +42 lines]", "\u2500" * 40]
        elif self.screen == "foreign":
            lines = ["\u203a unrelated input", "? for shortcuts", "sample-model \u00b7 100% context left"]
        elif self.screen == "duplicate":
            lines = ["\u203a " + body * 2, "? for shortcuts", "sample-model \u00b7 100% context left"]
        elif self.screen == "codex-0165":
            # 0.165.0 with a status_line starting at context-used: the status row sits right under the input.
            rows = [body[i:i + 53] for i in range(0, len(body), 53)]
            lines = ["\u203a " + rows[0], *("  " + row for row in rows[1:]), CODEX_0165_STATUS, "? for shortcuts"]
        else:
            assert self.screen == "codex"
            rows = [body[i:i + 53] for i in range(0, len(body), 53)]
            lines = ["\u203a " + rows[0], *("  " + row for row in rows[1:]),
                     "", "? for shortcuts", "sample-model \u00b7 100% context left"]
        return {"sessionId": "pty-tab-1", "lines": lines}


def recover_screen(screen, *, stale=False, empty_screen="codex-empty", extra_input=0):
    module = dispatch_send.load_bridge()
    pty = RecoveryScreenPty(screen, empty_screen)
    writes = []

    def request(command, args):
        response = pty(command, args)
        if command == "pane.send_text":
            writes.append({"payload": deepcopy(args), "response": deepcopy(response)})
        return response

    bridge = module.Bridge(request)
    initial = bridge.status("pty-tab-1")
    body = RECOVERY_MULTILINE if screen == "multiline" else RECOVERY_BODY
    # Create the post-text state, then (for stale) one competing input revision.
    pty.text = body
    pty.entry["input_revision"] += 1 + int(stale) + extra_input
    if stale:
        writes.append({"payload": {"key": "enter"}, "response": {
            "sent": False, "reason": "stale_staged_draft", "textWritten": False, "enterWritten": False}})
    result = dispatch_send.recover_dead_guard(bridge, module, "pty-tab-1", body, initial, "none", writes)
    return pty, result


@pytest.mark.parametrize("screen", ["wrapped", "multiline", "paste", "codex"])
def test_dead_guard_screen_enter_only_finishes(install_transport, screen):
    pty, result = recover_screen(screen)
    assert result["enter_sent"] is True and result["recovery"] == "enter_only"
    assert pty.submitted and pty.clear_count == 0
    assert [write.get("key") for write in pty.writes] == ["enter"]
    assert not any(write.get("text") for write in pty.writes)


@pytest.mark.parametrize("screen", ["wrapped", "multiline", "codex"])
@pytest.mark.parametrize("empty_screen", ["codex-empty", "codex-try", "codex-example"])
def test_dead_guard_screen_stale_compact_match_finishes(install_transport, screen, empty_screen):
    pty, result = recover_screen(screen, stale=True, empty_screen=empty_screen)
    assert result["enter_sent"] is True and result["recovery"] == "combined"
    assert pty.submitted and pty.clear_count == 1
    assert [write.get("key") for write in pty.writes] == ["ctrl-c", None]
    combined = pty.writes[-1]
    assert combined["enter"] is True
    assert combined["text"] == (RECOVERY_MULTILINE if screen == "multiline" else RECOVERY_BODY)


@pytest.mark.parametrize("stale", [False, True])
def test_dead_guard_codex_0165_status_row_is_not_part_of_the_draft(install_transport, stale):
    pty, result = recover_screen("codex-0165", stale=stale, empty_screen="codex-0165")
    assert result["enter_sent"] is True
    assert result["recovery"] == ("combined" if stale else "enter_only")
    assert pty.submitted and pty.clear_count == int(stale)
    assert [write.get("key") for write in pty.writes] == (["ctrl-c", None] if stale else ["enter"])
    if stale:
        assert pty.writes[-1]["enter"] is True and pty.writes[-1]["text"] == RECOVERY_BODY


def test_dead_guard_screen_stale_paste_stops_without_writing(install_transport):
    pty, result = recover_screen("paste", stale=True)
    assert result["enter_sent"] is False and result["recovery"] == "stopped"
    assert not pty.submitted and pty.clear_count == 0 and pty.writes == []


@pytest.mark.parametrize("screen", ["foreign", "duplicate", "two-pastes"])
@pytest.mark.parametrize("stale", [False, True])
def test_dead_guard_screen_ambiguous_input_stops_without_writing(install_transport, screen, stale):
    pty, result = recover_screen(screen, stale=stale)
    assert result["enter_sent"] is False and result["recovery"] == "stopped"
    assert not pty.submitted and pty.clear_count == 0 and pty.writes == []


def test_dead_guard_screen_changed_revision_stops_without_writing(install_transport):
    pty, result = recover_screen("paste", extra_input=1)
    assert result["enter_sent"] is False and result["recovery"] == "stopped"
    assert pty.clear_count == 0 and pty.writes == []


@pytest.mark.parametrize("hint", ["", 'Try "a sample task"', "Ask Codex to do anything"])
def test_dead_guard_screen_codex_empty_input_excludes_footer(install_transport, hint):
    module = dispatch_send.load_bridge()
    lines = ["\u203a " + hint, "", "? for shortcuts", "sample-model \u00b7 100% context left"]
    assert dispatch_send.recovery_input_body(module, lines) == ""
    assert dispatch_send.recovery_input_empty(module, lines) is True

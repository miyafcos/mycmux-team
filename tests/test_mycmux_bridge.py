from __future__ import annotations

from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
from typing import Any
import unicodedata

import pytest


BRIDGE_SCRIPT = (
    Path(__file__).parents[1] / "skills" / "claude" / "mycmux-bridge" / "scripts" / "mycmux_bridge.py"
)

spec = importlib.util.spec_from_file_location("mycmux_bridge", BRIDGE_SCRIPT)
assert spec is not None and spec.loader is not None
bridge_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_module)

Bridge = bridge_module.Bridge
BridgeError = bridge_module.BridgeError
scan_ask_question = bridge_module.scan_ask_question
ask_fingerprint = bridge_module._support.ask_fingerprint

SESSION_ID = "pty-session-a"
OTHER_SESSION_ID = "pty-session-b"


def pane_list_all(*, duplicate_label: bool = False) -> dict[str, Any]:
    tabs = [
        {
            "id": "tab-a",
            "sessionId": SESSION_ID,
            "label": "worker",
            "agentId": "claude-codex",
            "agentKind": "claude-codex",
            "agentSessionId": "agent-a",
            "claudeSessionId": "claude-a",
            "type": "terminal",
        }
    ]
    if duplicate_label:
        tabs.append(
            {
                "id": "tab-b",
                "sessionId": OTHER_SESSION_ID,
                "label": "worker",
                "agentId": "codex",
                "agentKind": "codex",
                "agentSessionId": "agent-b",
                "type": "terminal",
            }
        )
    return {
        "activeWorkspaceId": "workspace-a",
        "panes": [
            {
                "workspaceId": "workspace-a",
                "workspaceName": "Main",
                "id": "pane-a",
                "label": "Agents",
                "tabs": tabs,
            }
        ],
    }


def state_entry(
    *,
    session_id: str = SESSION_ID,
    epoch: int = 7,
    revision: int = 11,
    input_revision: int = 5,
    lifecycle: str = "alive",
    activity: str = "idle",
    attention: str = "none",
    attention_id: str | None = None,
    health: str = "fresh",
) -> dict[str, Any]:
    return {
        "session_id": session_id,
        "input_revision": input_revision,
        "view": {
            "session_id": session_id,
            "session_epoch": epoch,
            "session_revision": revision,
            "lifecycle": lifecycle,
            "activity": activity,
            "attention": {"kind": attention, "attention_id": attention_id},
            "health": health,
        },
        "ui_state": "waiting" if attention != "none" else activity,
    }


def state_response(**kwargs: Any) -> dict[str, Any]:
    return {"sessions": [state_entry(**kwargs)]}


class ScriptedTransport:
    def __init__(
        self,
        *,
        states: list[dict[str, Any]] | None = None,
        screens: list[list[str]] | None = None,
        duplicate_label: bool = False,
    ) -> None:
        self.states = states or [state_response()]
        self.auto_input_revision = states is None
        self.screens = screens or [["ready"]]
        self.duplicate_label = duplicate_label
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.state_index = 0
        self.screen_index = 0

    def __call__(self, cmd: str, args: dict[str, Any]) -> Any:
        self.calls.append((cmd, deepcopy(args)))
        if cmd == "pane.list_all":
            return pane_list_all(duplicate_label=self.duplicate_label)
        if cmd == "session.state_view":
            value = self.states[min(self.state_index, len(self.states) - 1)]
            self.state_index += 1
            result = deepcopy(value)
            if self.auto_input_revision:
                result["sessions"][0]["input_revision"] += len(send_calls(self))
            return result
        if cmd == "pane.read":
            value = self.screens[min(self.screen_index, len(self.screens) - 1)]
            self.screen_index += 1
            return {"sessionId": args["sessionId"], "lines": deepcopy(value)}
        if cmd == "pane.send_text":
            if args.get("key"):
                return {"ok": True, "confirmed": True, "sent": True}
            return {"sent": True, "unverified": True}
        raise AssertionError(f"unexpected command: {cmd}")


def make_bridge(transport: ScriptedTransport, *, observations: int = 2) -> Bridge:
    return Bridge(
        transport,
        sleep=lambda _seconds: None,
        observations=observations,
        poll_seconds=0,
    )


def send_calls(transport: ScriptedTransport) -> list[dict[str, Any]]:
    return [args for cmd, args in transport.calls if cmd == "pane.send_text"]


def test_list_normalizes_all_tabs_with_canonical_status() -> None:
    transport = ScriptedTransport(
        states=[
            {
                "sessions": [
                    state_entry(),
                    state_entry(
                        session_id=OTHER_SESSION_ID,
                        lifecycle="exited",
                        activity="unknown",
                        health="stale",
                    ),
                ]
            }
        ],
        duplicate_label=True,
    )

    result = make_bridge(transport).list_tabs()

    assert result["source"] == "mycmux"
    assert [item["session_id"] for item in result["sessions"]] == [
        SESSION_ID,
        OTHER_SESSION_ID,
    ]
    first = result["sessions"][0]
    assert first == {
        "source": "mycmux",
        "workspace": {"id": "workspace-a", "name": "Main"},
        "pane": {"id": "pane-a", "label": "Agents"},
        "tab": {"id": "tab-a", "type": "terminal"},
        "session_id": SESSION_ID,
        "label": "worker",
        "agent_kind": "claude-codex",
        "agent_id": "claude-codex",
        "agent_session_id": "agent-a",
        "claude_session_id": "claude-a",
        "lifecycle": "alive",
        "activity": "idle",
        "attention": "none",
        "attention_id": None,
        "health": "fresh",
        "input_revision": 5,
        "send_status": "candidate",
        "send_reason": "",
        "ui_state": "idle",
    }


def test_read_requires_exact_pty_session_and_caps_snapshot() -> None:
    lines = [f"line-{index}" for index in range(400)]
    transport = ScriptedTransport(screens=[lines])

    result = make_bridge(transport).read(SESSION_ID, 999)

    assert result["lines"] == lines
    assert result["metadata"] == {
        "kind": "logical_screen_snapshot",
        "transcript": False,
        "max_lines": 400,
    }
    pane_read = next(args for cmd, args in transport.calls if cmd == "pane.read")
    assert pane_read["lines"] == 400
    with pytest.raises(BridgeError, match="exactly once"):
        make_bridge(transport).read("pane-a")


def test_target_resolution_uses_control_label_not_display_name() -> None:
    class NamedTransport(ScriptedTransport):
        def __call__(self, command: str, args: dict[str, Any]) -> dict[str, Any]:
            if command == "pane.list_all":
                result = pane_list_all()
                result["panes"][0]["tabs"][0]["display_name"] = "toolx review"
                return result
            return super().__call__(command, args)

    bridge = make_bridge(NamedTransport())
    assert bridge.resolve_target(session_id=None, target="worker") == SESSION_ID
    with pytest.raises(BridgeError, match="matched 0"):
        bridge.resolve_target(session_id=None, target="toolx review")


def test_target_resolution_rejects_zero_and_duplicate_labels() -> None:
    bridge = make_bridge(ScriptedTransport())
    with pytest.raises(BridgeError, match="matched 0"):
        bridge.resolve_target(session_id=None, target="missing")

    duplicate = make_bridge(ScriptedTransport(duplicate_label=True))
    with pytest.raises(BridgeError, match="matched 2"):
        duplicate.resolve_target(session_id=None, target="worker")


def test_send_rejects_stale_unknown_and_degraded_without_writes() -> None:
    for entry in (
        state_response(lifecycle="exited"),
        state_response(lifecycle="unknown"),
        state_response(health="degraded"),
    ):
        transport = ScriptedTransport(states=[entry])
        with pytest.raises(BridgeError):
            make_bridge(transport).send("hello", session_id=SESSION_ID)
        assert send_calls(transport) == []


def test_send_text_draft_enter_once_residue_clears_and_state_transitions() -> None:
    text = "bridge delivery probe"
    transport = ScriptedTransport(
        states=[
            state_response(revision=10, input_revision=5),
            state_response(revision=10, input_revision=5),
            state_response(revision=10, input_revision=6),
            state_response(revision=10, input_revision=6),
            state_response(revision=10, input_revision=6),
            state_response(revision=10, input_revision=6),
            state_response(revision=11, input_revision=7, activity="running_silent"),
        ],
        screens=[
            ["prompt>"],
            ["prompt>"],
            [f"prompt> {text}"],
            [f"prompt> {text}"],
            [f"prompt> {text}"],
            ["processing"],
        ],
    )

    result = make_bridge(transport).send(text, session_id=SESSION_ID)

    assert result["result"] == "observed_delivered"
    writes = send_calls(transport)
    assert [write.get("key") for write in writes] == [None, "enter"]
    assert writes[0]["text"] == text
    assert writes[0]["enter"] is False
    assert writes[1]["text"] == ""
    assert writes[1]["enter"] is False
    assert writes[0]["expectedAttentionId"] is None
    assert writes[1]["expectedAttentionId"] is None
    assert writes[0]["expectedInputRevision"] == 5
    assert writes[1]["expectedInputRevision"] == 6


def test_send_binds_enter_revision_to_its_own_text_write() -> None:
    text = "bridge revision probe"
    transport = ScriptedTransport(
        states=[
            state_response(revision=10, input_revision=5),
            state_response(revision=10, input_revision=5),
            state_response(revision=10, input_revision=6),
            state_response(revision=10, input_revision=6),
            state_response(revision=10, input_revision=99),
            state_response(revision=10, input_revision=99),
        ],
        screens=[
            ["prompt>"],
            ["prompt>"],
            [f"prompt> {text}"],
            [f"prompt> {text}"],
            [f"prompt> {text}"],
        ],
    )

    result = make_bridge(transport).send(text, session_id=SESSION_ID)

    assert result["result"] == "prompt_changed"
    writes = send_calls(transport)
    assert [write.get("key") for write in writes] == [None]


@pytest.mark.parametrize(
    ("screens", "expected"),
    [
        ([["prompt>"], ["prompt>"], ["prompt>"], ["prompt>"]], "draft_not_observed"),
        ([["prompt>"], ["prompt>"], ["unrelated output"], ["unrelated output"]], "screen_changed_ambiguously"),
    ],
)
def test_send_never_enters_when_draft_is_not_stably_visible(
    screens: list[list[str]], expected: str
) -> None:
    transport = ScriptedTransport(screens=screens)

    result = make_bridge(transport).send("hello", session_id=SESSION_ID)

    assert result["result"] == expected
    assert [write.get("key") for write in send_calls(transport)] == [None]


def test_send_does_not_treat_existing_output_as_a_new_draft() -> None:
    transport = ScriptedTransport(
        screens=[
            ["previous: hello", "PS>"],
            ["previous: hello", "PS>"],
            ["previous: hello", "PS>"],
            ["previous: hello", "PS>"],
        ]
    )

    result = make_bridge(transport).send("hello", session_id=SESSION_ID)

    assert result["result"] == "draft_not_observed"
    assert result["enter_sent"] is False
    assert [write.get("key") for write in send_calls(transport)] == [None]


def test_send_refuses_prompt_change_before_enter_without_extra_key() -> None:
    text = "hello"
    transport = ScriptedTransport(
        screens=[
            ["prompt>"],
            ["prompt>"],
            [f"prompt> {text}"],
            [f"prompt> {text}"],
            ["different screen"],
        ]
    )

    result = make_bridge(transport).send(text, session_id=SESSION_ID)

    assert result["result"] == "prompt_changed"
    assert [write.get("key") for write in send_calls(transport)] == [None]


def test_send_classifies_residue_without_second_enter() -> None:
    text = "hello"
    transport = ScriptedTransport(
        states=[
            state_response(revision=10, input_revision=5),
            state_response(revision=10, input_revision=5),
            state_response(revision=10, input_revision=6),
            state_response(revision=10, input_revision=6),
            state_response(revision=10, input_revision=6),
            state_response(revision=10, input_revision=7),
            state_response(revision=11, input_revision=7, activity="running_silent"),
            state_response(revision=11, input_revision=7, activity="running_silent"),
        ],
        screens=[
            ["PS>"],
            ["PS>"],
            [f"PS> {text}"],
            [f"PS> {text}"],
            [f"PS> {text}"],
            [f"PS> {text}"],
            [f"PS> {text}"],
        ],
    )

    result = make_bridge(transport).send(text, session_id=SESSION_ID)

    assert result["result"] == "residue_remains"
    assert result["enter_sent"] is True
    assert [write.get("key") for write in send_calls(transport)] == [None, "enter"]


def test_send_rejects_epoch_change_after_enter() -> None:
    text = "hello"
    transport = ScriptedTransport(
        states=[
            *[state_response(epoch=7, revision=10, input_revision=5 + (index >= 2) + (index >= 5))
              for index in range(5)],
            *[state_response(epoch=8, revision=11, input_revision=7) for _ in range(2)],
        ],
        screens=[
            ["prompt>"],
            ["prompt>"],
            [f"prompt> {text}"],
            [f"prompt> {text}"],
            [f"prompt> {text}"],
            ["processing"],
        ],
    )

    result = make_bridge(transport).send(text, session_id=SESSION_ID)

    assert result["result"] == "verification_unavailable"
    assert result["enter_sent"] is True
    assert [write.get("key") for write in send_calls(transport)] == [None, "enter"]


SINGLE_ASK = [
    "────────────────────────",
    "☐ Fruit",
    "Pick a fruit",
    "❯ 1. Apple",
    "2. Banana",
    "3. Type something.",
    "────────────────────────",
    "4. Chat about this",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
]
TABBED_FIRST = [
    "────────────────────────",
    "☐  ☐ Colour  ☐ Size  ✔ Submit  ▶",
    "Pick a colour",
    "❯ 1. Red",
    "2. Green",
    "3. Type something.",
    "────────────────────────",
    "4. Chat about this",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
]
TABBED_SECOND = [
    "────────────────────────",
    "☐  ☑ Colour  ☐ Size  ✔ Submit  ▶",
    "Pick a size",
    "❯ 1. Small",
    "2. Large",
    "3. Type something.",
    "────────────────────────",
    "4. Chat about this",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
]
REVIEW = [
    "────────────────────────",
    "☐  ☑ Colour  ☑ Size  ✔ Submit  ▶",
    "Review your answers",
    "● Pick a colour",
    "→ Green",
    "● Pick a size",
    "→ Large",
    "Ready to submit your answers?",
    "❯ 1. Submit answers",
    "2. Cancel",
]
REVIEW_MULTI = [
    "────────────────────────",
    "☐  ☑ Toppings  ✔ Submit  ▶",
    "Review your answers",
    "● Pick toppings",
    "→ Cheese, Onion",
    "Ready to submit your answers?",
    "❯ 1. Submit answers",
    "2. Cancel",
]
MULTI_START = [
    "────────────────────────",
    "☐  ☐ Toppings  ✔ Submit  ▶",
    "Pick toppings",
    "❯ 1. [ ] Cheese",
    "2. [ ] Bacon",
    "3. [ ] Onion",
    "4. [ ] Type something",
    "Submit",
    "────────────────────────",
    "5. Chat about this",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
]
MULTI_TOGGLED_1 = [line.replace("1. [ ] Cheese", "1. [✔] Cheese") for line in MULTI_START]
MULTI_TOGGLED_3 = [line.replace("3. [ ] Onion", "3. [✔] Onion") for line in MULTI_TOGGLED_1]
MULTI_DOWN_1 = [line.replace("❯ 1. [✔]", "1. [✔]").replace("2. [ ]", "❯ 2. [ ]") for line in MULTI_TOGGLED_3]
MULTI_DOWN_2 = [line.replace("❯ 2. [ ]", "2. [ ]").replace("3. [✔]", "❯ 3. [✔]") for line in MULTI_DOWN_1]
MULTI_DOWN_3 = [line.replace("❯ 3. [✔]", "3. [✔]").replace("4. [ ]", "❯ 4. [ ]") for line in MULTI_DOWN_2]
MULTI_DOWN_4 = [
    "4. [ ] Type something"
    if line == "❯ 4. [ ] Type something"
    else "❯ Submit"
    if line == "Submit"
    else line
    for line in MULTI_DOWN_3
]


class AskTransport(ScriptedTransport):
    def __init__(
        self,
        screens: list[list[str]],
        *,
        attention: str = "input",
        states: list[dict[str, Any]] | None = None,
        close_after_writes: int | None = None,
    ) -> None:
        super().__init__(
            states=states or [state_response(attention=attention, attention_id="ask-a")],
            screens=screens,
        )
        self.close_after_writes = close_after_writes

    def __call__(self, cmd: str, args: dict[str, Any]) -> Any:
        if (
            cmd == "session.state_view"
            and self.close_after_writes is not None
            and len(send_calls(self)) >= self.close_after_writes
        ):
            self.calls.append((cmd, deepcopy(args)))
            return state_response(revision=12)
        return super().__call__(cmd, args)


def test_ask_parser_rejects_unstructured_screen() -> None:
    assert scan_ask_question(["ordinary shell output"]) is None


def test_ask_parser_accepts_measured_symbols_and_spaced_tab_labels() -> None:
    screen = [
        "────────────────────────",
        "☐  ☐ Output format  ☐ Density  ✔ Submit  ▶",
        "Choose output format",
        "❯ 1. Markdown",
        "2. Plain text",
        "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ]

    parsed = scan_ask_question(screen)

    assert parsed is not None
    assert parsed["kind"] == "tabbed"
    assert [tab["label"] for tab in parsed["tabs"]] == ["Output format", "Density"]


def test_ask_parser_joins_wrapped_question_and_rejects_stale_footer() -> None:
    wrapped = [
        "────────────────────────",
        "☐ Fixture",
        "Which deployment target should",
        "we use for production?",
        "❯ 1. Linux",
        "2. Windows",
        "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ]
    parsed = scan_ask_question(wrapped)
    assert parsed is not None
    assert parsed["question"] == "Which deployment target should we use for production?"
    assert scan_ask_question([*wrapped, "answer accepted", "$ "]) is None


def test_ask_parser_does_not_treat_numbered_question_as_an_option() -> None:
    screen = [
        "────────────────────────",
        "☐ Fixture",
        "1. Which layout do you prefer?",
        "❯ 1. Compact",
        "2. Roomy",
        "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ]

    parsed = scan_ask_question(screen)

    assert parsed is not None
    assert parsed["question"] == "1. Which layout do you prefer?"
    assert [option["label"] for option in parsed["options"]] == ["Compact", "Roomy"]


def test_state_schema_requires_non_negative_input_revision() -> None:
    invalid = state_response()
    del invalid["sessions"][0]["input_revision"]
    with pytest.raises(BridgeError, match="input revision"):
        make_bridge(ScriptedTransport(states=[invalid])).status(SESSION_ID)


def test_strict_state_accepts_null_input_revision_but_send_stays_unavailable() -> None:
    state = state_response(input_revision=None, lifecycle="alive")
    transport = ScriptedTransport(states=[state])
    assert make_bridge(transport).status(SESSION_ID)["input_revision"] is None
    with pytest.raises(BridgeError, match="input revision") as error:
        make_bridge(transport).send("hello", session_id=SESSION_ID)
    assert error.value.kind == "verification_unavailable"
    assert not send_calls(transport)


def test_strict_state_rejects_string_input_revision() -> None:
    with pytest.raises(BridgeError, match="input revision"):
        make_bridge(ScriptedTransport(states=[state_response(input_revision="0")])).status(SESSION_ID)


def test_answer_ask_single_uses_one_digit_and_zero_enter_keys() -> None:
    transport = AskTransport(
        [SINGLE_ASK, SINGLE_ASK, ["done"], ["done"]],
        states=[
            state_response(attention="input", attention_id="ask-a", revision=10),
            state_response(attention="input", attention_id="ask-a", revision=10),
            state_response(attention="input", attention_id="ask-a", revision=11),
            state_response(attention="input", attention_id="ask-a", revision=11),
        ],
    )

    result = make_bridge(transport).answer_ask(SESSION_ID, {"Pick a fruit": 2})

    assert result["result"] == "observed_delivered"
    writes = send_calls(transport)
    assert [(write["text"], write.get("key"), write["enter"]) for write in writes] == [
        ("2", None, False)
    ]
    assert writes[0]["expectedInputRevision"] == 5


def test_answer_ask_keeps_screen_bound_input_revision_when_reobservation_advances() -> None:
    transport = AskTransport(
        [SINGLE_ASK, SINGLE_ASK, ["done"], ["done"]],
        states=[
            state_response(attention="input", attention_id="ask-a", revision=10, input_revision=5),
            state_response(attention="input", attention_id="ask-a", revision=10, input_revision=6),
            state_response(attention="input", attention_id="ask-a", revision=11, input_revision=6),
            state_response(attention="input", attention_id="ask-a", revision=11, input_revision=6),
        ],
    )

    result = make_bridge(transport).answer_ask(SESSION_ID, {"Pick a fruit": 2})

    assert result["result"] == "observed_delivered"
    assert send_calls(transport)[0]["expectedInputRevision"] == 5


def test_answer_ask_advances_input_revision_after_each_accepted_write() -> None:
    transport = AskTransport(
        [
            TABBED_FIRST,
            TABBED_FIRST,
            TABBED_SECOND,
            TABBED_SECOND,
            REVIEW,
            REVIEW,
            ["done"],
            ["done"],
        ],
        states=[
            *[
                state_response(
                    attention="input",
                    attention_id="ask-a",
                    revision=10,
                    input_revision=5 + min(index, 2),
                )
                for index in range(6)
            ],
            *[
                state_response(
                    attention="input",
                    attention_id="ask-a",
                    revision=11,
                    input_revision=7,
                )
                for _ in range(6)
            ],
        ],
    )

    result = make_bridge(transport).answer_ask(
        SESSION_ID,
        {"Pick a colour": 2, "Pick a size": 2},
    )

    assert result["result"] == "observed_delivered"
    assert [write["expectedInputRevision"] for write in send_calls(transport)] == [5, 6, 7]


def test_answer_ask_accepts_approval_attention() -> None:
    transport = AskTransport(
        [SINGLE_ASK, SINGLE_ASK, ["done"], ["done"]],
        attention="approval",
        states=[
            state_response(attention="approval", attention_id="ask-a", revision=10),
            state_response(attention="approval", attention_id="ask-a", revision=10),
            state_response(attention="approval", attention_id="ask-a", revision=11),
            state_response(attention="approval", attention_id="ask-a", revision=11),
        ],
    )

    result = make_bridge(transport).answer_ask(SESSION_ID, {"Pick a fruit": 2})

    assert result["result"] == "observed_delivered"
    assert [write["text"] for write in send_calls(transport)] == ["2"]


def test_answer_ask_multiple_questions_uses_digits_only() -> None:
    transport = AskTransport(
        [
            TABBED_FIRST,
            TABBED_FIRST,
            TABBED_SECOND,
            TABBED_SECOND,
            REVIEW,
            REVIEW,
            ["done"],
            ["done"],
        ],
        states=[
            *[state_response(attention="input", attention_id="ask-a", revision=10) for _ in range(6)],
            *[state_response(attention="input", attention_id="ask-a", revision=11) for _ in range(6)],
        ],
    )

    result = make_bridge(transport).answer_ask(
        SESSION_ID,
        {"Pick a colour": 2, "Pick a size": 2},
    )

    assert result["result"] == "observed_delivered"
    writes = send_calls(transport)
    assert [(write["text"], write.get("key"), write["enter"]) for write in writes] == [
        ("2", None, False),
        ("2", None, False),
        ("1", None, False),
    ]


def test_answer_ask_never_resends_a_digit_while_screen_is_stale() -> None:
    transport = AskTransport([TABBED_FIRST] * 8)

    with pytest.raises(BridgeError, match="did not advance"):
        make_bridge(transport, observations=5).answer_ask(
            SESSION_ID,
            {"Pick a colour": 2, "Pick a size": 2},
        )

    assert [write["text"] for write in send_calls(transport)] == ["2"]


def test_answer_ask_rejects_mismatched_review_without_submission() -> None:
    wrong_review = [line.replace("Green", "Red") for line in REVIEW]
    transport = AskTransport(
        [
            TABBED_FIRST,
            TABBED_FIRST,
            TABBED_SECOND,
            TABBED_SECOND,
            wrong_review,
        ]
    )

    with pytest.raises(BridgeError, match="review answers do not match"):
        make_bridge(transport).answer_ask(
            SESSION_ID,
            {"Pick a colour": 2, "Pick a size": 2},
        )

    assert [write["text"] for write in send_calls(transport)] == ["2", "2"]


def test_answer_ask_multiselect_uses_toggle_down_enter_review_sequence() -> None:
    transport = AskTransport(
        [
            MULTI_START,
            MULTI_START,
            MULTI_START,
            MULTI_TOGGLED_1,
            MULTI_TOGGLED_1,
            MULTI_TOGGLED_1,
            MULTI_TOGGLED_3,
            MULTI_TOGGLED_3,
            MULTI_TOGGLED_3,
            MULTI_DOWN_1,
            MULTI_DOWN_1,
            MULTI_DOWN_1,
            MULTI_DOWN_2,
            MULTI_DOWN_2,
            MULTI_DOWN_2,
            MULTI_DOWN_3,
            MULTI_DOWN_3,
            MULTI_DOWN_3,
            MULTI_DOWN_4,
            MULTI_DOWN_4,
            MULTI_DOWN_4,
            REVIEW_MULTI,
            REVIEW_MULTI,
            # After the review digit the seat drops to attention "none"; the
            # bridge then reads the screen and accepts closure only once the
            # question has left it, so the next reads must not show the review.
            ["done"],
            ["done"],
        ],
        states=[state_response(attention="input", attention_id="ask-a", revision=10)],
        close_after_writes=8,
    )

    result = make_bridge(transport).answer_ask(
        SESSION_ID,
        {"Pick toppings": [1, 3]},
    )

    assert result["result"] == "observed_delivered"
    writes = send_calls(transport)
    assert [(write["text"], write.get("key"), write["enter"]) for write in writes] == [
        ("1", None, False),
        ("3", None, False),
        ("", "down", False),
        ("", "down", False),
        ("", "down", False),
        ("", "down", False),
        ("", "enter", False),
        ("1", None, False),
    ]


def test_answer_ask_multiselect_unchecks_unrequested_preselected_options() -> None:
    preselected = [line.replace("2. [ ] Bacon", "2. [✔] Bacon") for line in MULTI_START]
    unselected = [line.replace("2. [✔] Bacon", "2. [ ] Bacon") for line in preselected]
    transport = AskTransport(
        [
            preselected,
            preselected,
            preselected,
            unselected,
            unselected,
            unselected,
            MULTI_TOGGLED_1,
            MULTI_TOGGLED_1,
            MULTI_TOGGLED_1,
            MULTI_TOGGLED_3,
            MULTI_TOGGLED_3,
            MULTI_TOGGLED_3,
            MULTI_DOWN_1,
            MULTI_DOWN_1,
            MULTI_DOWN_1,
            MULTI_DOWN_2,
            MULTI_DOWN_2,
            MULTI_DOWN_2,
            MULTI_DOWN_3,
            MULTI_DOWN_3,
            MULTI_DOWN_3,
            MULTI_DOWN_4,
            MULTI_DOWN_4,
            MULTI_DOWN_4,
            REVIEW_MULTI,
            REVIEW_MULTI,
            REVIEW_MULTI,
            ["done"],
            ["done"],
        ],
        states=[state_response(attention="input", attention_id="ask-a", revision=10)],
        close_after_writes=9,
    )

    result = make_bridge(transport).answer_ask(
        SESSION_ID,
        {"Pick toppings": [1, 3]},
    )

    assert result["result"] == "observed_delivered"
    assert [write["text"] for write in send_calls(transport)[:3]] == ["2", "1", "3"]


def test_answer_ask_does_not_send_when_screen_is_unstructured() -> None:
    transport = AskTransport([["ordinary shell output"]])

    with pytest.raises(BridgeError, match="could not be parsed"):
        make_bridge(transport).answer_ask(SESSION_ID, {"Pick a fruit": 1})

    assert send_calls(transport) == []


def test_token_never_appears_in_stdout_stderr_or_exception(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    secret = "super-secret-socket-token"

    class ExplodingBridge:
        def __init__(self, _request: Any) -> None:
            raise RuntimeError(f"socket rejected token={secret}")

    fake_cli = type("FakeCli", (), {"send_request": lambda *_args: None})
    monkeypatch.setattr(bridge_module, "resolve_agent_cli", lambda: Path("C:/repo"))
    monkeypatch.setattr(bridge_module, "load_agent_cli", lambda _repo: fake_cli)
    monkeypatch.setattr(bridge_module, "Bridge", ExplodingBridge)

    assert bridge_module.main(["list"]) == 1
    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err
    assert "mycmux request failed" in captured.err

    error = BridgeError("verification_unavailable", "source checkout missing")
    assert secret not in str(error)


def test_list_keeps_live_and_exited_null_rows_and_ignores_unregistered_null():
    transport = ScriptedTransport(states=[{"sessions": [
        state_entry(),
        state_entry(session_id=OTHER_SESSION_ID, lifecycle="exited", input_revision=None),
        state_entry(session_id="unregistered-exited", lifecycle="exited", input_revision=None),
    ]}], duplicate_label=True)
    result = make_bridge(transport).list_tabs()
    assert "result" not in result
    live, exited = result["sessions"]
    assert live["input_revision"] == 5
    assert live["send_status"] == "candidate"
    assert exited["input_revision"] is None
    assert exited["send_status"] == "not_applicable"
    assert not send_calls(transport)


@pytest.mark.parametrize("value", [None, -1, True, False])
def test_invalid_input_revision_is_displayed_but_never_sent(value):
    transport = ScriptedTransport(states=[state_response(input_revision=value)])
    result = make_bridge(transport).list_tabs()
    assert result["sessions"][0]["input_revision"] is value
    assert result["sessions"][0]["send_status"] == "unavailable"
    with pytest.raises(BridgeError, match="input revision"):
        make_bridge(transport).send("hello", session_id=SESSION_ID)
    assert not send_calls(transport)


@pytest.mark.parametrize("field", ["session_epoch", "session_revision"])
@pytest.mark.parametrize("value", [None, -1, True, False])
def test_invalid_canonical_expectations_never_write(field, value):
    state = state_response()
    state["sessions"][0]["view"][field] = value
    transport = ScriptedTransport(states=[state])
    bridge = make_bridge(transport)
    assert bridge.list_tabs()["sessions"][0]["send_status"] == "unavailable"
    result = bridge.send("hello", session_id=SESSION_ID)
    assert result["result"] != "observed_delivered"
    assert not send_calls(transport)


@pytest.mark.parametrize("tab_type", ["launcher", "web", "declared"])
def test_non_pty_tabs_are_listed_but_never_send_candidates(tab_type):
    registry = pane_list_all()
    registry["panes"][0]["tabs"].append({
        "id": "launcher-tab", "sessionId": "launcher-session",
        "type": tab_type, "label": "worker",
    })
    transport = ScriptedTransport(states=[{"sessions": [
        state_entry(),
        state_entry(session_id="launcher-session", input_revision=None),
    ]}])
    def request(cmd, args):
        if cmd == "pane.list_all":
            return deepcopy(registry)
        return transport(cmd, args)
    bridge = Bridge(request, sleep=lambda _seconds: None)
    rows = bridge.list_tabs()["sessions"]
    assert rows[1]["send_status"] == "not_applicable"
    assert rows[1]["input_revision"] is None
    assert bridge.resolve_target(session_id=None, target="worker") == SESSION_ID
    with pytest.raises(BridgeError):
        bridge.send("hello", session_id="launcher-session")
    assert not send_calls(transport)


@pytest.mark.parametrize("change", ["epoch", "input_revision"])
def test_pre_text_reobservation_does_not_adopt_changed_target(change):
    after = {"epoch": 8} if change == "epoch" else {"input_revision": 6}
    transport = ScriptedTransport(states=[state_response(), state_response(**after)])
    result = make_bridge(transport).send("hello", session_id=SESSION_ID)
    assert result["result"] in {"stale_target", "prompt_changed"}
    assert not send_calls(transport)


@pytest.mark.parametrize(
    ("prompt", "after", "kind"),
    [
        ("› ", ["› hello", "• response", "› Ask Codex to do anything", "... · Ready"], "Codex"),
        ("PS> ", ["PS> hello", "output", "PS>"], "PowerShell"),
        ("PS C:\\Users\\miyaz\\_work> ",
         ["PS C:\\Users\\miyaz\\_work> hello", "output", "PS C:\\Users\\miyaz\\_work>"], "PowerShell"),
        ("> ", ["> hello", "response", "> "], "Claude Code"),
        ("❯ ", ["❯ hello", "response", "❯ "], "Claude Code"),
        ("C:\\work> ", ["C:\\work> hello", "output", "C:\\work>"], "cmd"),
        ("user@host:~/work$ ", ["user@host:~/work$ hello", "output", "user@host:~/work$"], "shell"),
    ],
)
def test_send_ignores_echo_above_the_last_input_line(prompt, after, kind):
    draft = [prompt + "hello"]
    transport = ScriptedTransport(screens=[[prompt], [prompt], draft, draft, draft, after])

    result = make_bridge(transport).send("hello", session_id=SESSION_ID)

    assert result["result"] == "observed_delivered"
    assert result["enter_sent"] is True
    assert f"last {kind} input line 3: body absent" in result["detail"]
    assert "canonical state unchanged" in result["detail"]
    assert [write.get("key") for write in send_calls(transport)] == [None, "enter"]


@pytest.mark.parametrize("prompt", ["› ", "> ", "PS> "])
def test_send_reports_residue_in_current_input_and_never_repeats_enter(prompt):
    draft = [prompt + "hello"]
    transport = ScriptedTransport(screens=[[prompt], [prompt], draft, draft, draft, draft])

    result = make_bridge(transport).send("hello", session_id=SESSION_ID)

    assert result["result"] == "residue_remains"
    assert result["enter_sent"] is True
    assert "input line 1: body remains" in result["detail"]
    assert [write.get("key") for write in send_calls(transport)] == [None, "enter"]


@pytest.mark.parametrize("new_history", [False, True])
def test_send_never_enters_when_text_is_only_output_and_not_in_input(new_history):
    before = ["previous: hello", "PS>"]
    after = ["previous: hello", "new output: hello", "PS>"] if new_history else before
    transport = ScriptedTransport(screens=[before, before, after, after])

    result = make_bridge(transport).send("hello", session_id=SESSION_ID)

    assert result["result"] == "draft_not_observed"
    assert result["enter_sent"] is False
    assert [write.get("key") for write in send_calls(transport)] == [None]


@pytest.mark.parametrize(
    ("after", "expected", "fingerprint"),
    [
        (["output: hello"], "observed_delivered", "changed"),
        (["composer: hello"], "residue_remains", "unchanged"),
    ],
)
def test_send_uses_fingerprint_if_input_line_cannot_be_identified(after, expected, fingerprint):
    draft = ["composer: hello"]
    transport = ScriptedTransport(screens=[["composer:"], ["composer:"], draft, draft, draft, after])

    result = make_bridge(transport).send("hello", session_id=SESSION_ID)

    assert result["result"] == expected
    assert result["enter_sent"] is True
    assert f"input line not identified; post-Enter fingerprint {fingerprint}" in result["detail"]
    assert [write.get("key") for write in send_calls(transport)] == [None, "enter"]


@pytest.mark.parametrize("cleared", [False, True])
def test_send_preserves_wrapped_input_detection(cleared):
    draft = ["› line one", "  line two", "... · Ready"]
    after = [*draft, "• response", "› Ask Codex to do anything"] if cleared else draft
    transport = ScriptedTransport(screens=[["› "], ["› "], draft, draft, draft, after])

    result = make_bridge(transport).send("line one\nline two", session_id=SESSION_ID)

    assert result["result"] == ("observed_delivered" if cleared else "residue_remains")
    assert result["enter_sent"] is True
    assert [write.get("key") for write in send_calls(transport)] == [None, "enter"]


@pytest.mark.parametrize(
    ("reply", "expected", "enter_sent"),
    [
        ({"sent": False, "reason": "input_revision"}, "write_failed", False),
        ({"ok": False, "confirmed": False, "attempts": 1}, "observed_delivered", True),
        (None, "observed_delivered", True),
        (RuntimeError("transport disconnected"), "write_failed", True),
        (OSError("response lost"), "write_failed", True),
    ],
)
def test_send_distinguishes_rejected_enter_from_missing_confirmation(reply, expected, enter_sent):
    class EnterReplyTransport(ScriptedTransport):
        def __call__(self, cmd, args):
            result = super().__call__(cmd, args)
            if cmd == "pane.send_text" and args.get("key") == "enter":
                if isinstance(reply, BaseException):
                    raise reply
                return reply
            return result

    draft = ["PS> hello"]
    transport = EnterReplyTransport(screens=[["PS>"], ["PS>"], draft, draft, draft, ["PS>"]])

    result = make_bridge(transport).send("hello", session_id=SESSION_ID)

    assert result["result"] == expected
    assert result["enter_sent"] is enter_sent
    assert [write.get("key") for write in send_calls(transport)] == [None, "enter"]


def test_send_cli_refusal_json_reports_enter_not_sent(monkeypatch, capsys):
    transport = ScriptedTransport(states=[state_response(lifecycle="closed")])
    fake_cli = type("FakeCli", (), {"send_request": transport})
    monkeypatch.setattr(bridge_module, "resolve_agent_cli", lambda: Path("C:/repo"))
    monkeypatch.setattr(bridge_module, "load_agent_cli", lambda _repo: fake_cli)

    assert bridge_module.main(["send", "--session", SESSION_ID, "--text", "hello"]) == 1

    result = json.loads(capsys.readouterr().err)
    assert result["enter_sent"] is False
    assert send_calls(transport) == []


@pytest.mark.parametrize(
    ("text", "prompt", "after"),
    [
        ("Ready", "› ", ["› Ready", "• response", "› Ask Codex to do anything", "... · Ready"]),
        ("hello", "PS> ", ["PS>", "hello"]),
    ],
)
def test_send_does_not_treat_footer_or_output_below_input_as_residue(text, prompt, after):
    draft = [prompt + text]
    transport = ScriptedTransport(screens=[[prompt], [prompt], draft, draft, draft, after])

    result = make_bridge(transport).send(text, session_id=SESSION_ID)

    assert result["result"] == "observed_delivered"
    assert result["enter_sent"] is True
    assert [write.get("key") for write in send_calls(transport)] == [None, "enter"]


def test_send_does_not_treat_output_below_empty_input_as_a_new_draft():
    transport = ScriptedTransport(screens=[["PS>"], ["PS>"], ["PS>", "hello"], ["PS>", "hello"]])

    result = make_bridge(transport).send("hello", session_id=SESSION_ID)

    assert result["result"] == "draft_not_observed"
    assert result["enter_sent"] is False
    assert [write.get("key") for write in send_calls(transport)] == [None]


# Captured Claude Code long-draft fixture from the D2 dispatch (2026-09-25).
LONG_DRAFT_TEXT = "CANARY (live test of the new answer-ask; not a real decision, the card is not shown to the owner). Please do exactly this: 1) Enqueue ONE ask card per ask-card-contract.md from this pane (your MYCMUX_PANE_SESSION_ID), question 'CANARY: which word should you echo back?', options A=alpha and B=beta, recommended A, decision class scope_change, blocking reason 'canary test of answer-ask delivery'. 2) End your turn and wait. 3) When an answer arrives, reply with exactly one line: CANARY-RECEIVED followed by the first 40 characters of the answer. Do nothing else: no files, no other commands."
LONG_DRAFT_SCREEN = "\u306e\u30b3\u30fc\u30c9\u3092\u8aad\u3093\u3067\u3044\u305f\u306e\u3067\u3001\u4f5c\u696d\u30c4\u30ea\u30fc\u306e\u30b3\u30fc\u30c9\u3092\u8aad\u3080\u3088\u3046\u306b\u5909\u3048\u307e\u3057\u305f\u3002\nDONE.md:\nC:\\Users\\miyaz\\.claude\\dispatch\\260925-mycmux-stage1-d4\\DONE.md\n\u5916\u306e\u30b9\u30af\u30ea\u30d7\u30c8 3 \u672c\u306e\u76f4\u3057\u6848\uff08\u76f4\u3057\u305f\u5199\u3057\u3068\u5dee\u5206\uff09:\nC:\\Users\\miyaz\\AppData\\Local\\Temp\\claude\\C--Users-miyaz--work-mycmux-stage1-26\n0925-claude-wt\\5b447efd-66bc-4d5c-a5bf-5e6b15a0fd3c\\scratchpad\\ext\\\n\u273b Saut\xe9ed for 27m 21s \xb7 done 6:24\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\u276f not shown to the owner). Please do exactly this: 1) Enqueue ONE ask card per\nask-card-contract.md from this pane (your MYCMUX_PANE_SESSION_ID), question\n'CANARY: which word should you echo back?', options A=alpha and B=beta,\nrecommended A, decision class scope_change, blocking reason 'canary test of\nanswer-ask delivery'. 2) End your turn and wait. 3) When an answer arrives,\nreply with exactly one line: CANARY-RECEIVED followed by the first 40\ncharacters of the answer. Do nothing else: no files, no other commands.\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nOpus 5.5 (1M context) (high) \u2502 ~\\_work\\mycmux_stage1_260925\\claude_wt \u2502 CTX\u2026\n5h 50%! (4h5m) \u2502 sess 27m (05:57\u301c) \u2502 sid 5b447 fd".splitlines()


def long_draft_states():
    return [
        state_response(revision=10, input_revision=5),
        state_response(revision=10, input_revision=5),
        state_response(revision=10, input_revision=6),
        state_response(revision=10, input_revision=6),
        state_response(revision=10, input_revision=6),
        state_response(revision=10, input_revision=6),
        state_response(revision=11, input_revision=7, activity="running_silent"),
    ]


@pytest.mark.parametrize("draft_screen", [
    LONG_DRAFT_SCREEN,
    ["\u276f [Pasted Content 1026 chars]", "\u2500" * 50],
    ["\u276f [Pasted text #1 +12 lines]", "\u2500" * 50],
])
def test_long_draft_or_paste_marker_reaches_one_enter(draft_screen):
    transport = ScriptedTransport(
        states=long_draft_states(),
        screens=[["\u276f"], ["\u276f"], draft_screen, draft_screen, draft_screen, ["processing"]],
    )
    result = make_bridge(transport).send(LONG_DRAFT_TEXT, session_id=SESSION_ID)
    assert result["result"] == "observed_delivered"
    assert [write.get("key") for write in send_calls(transport)] == [None, "enter"]


@pytest.mark.parametrize("draft_screen", [
    ["\u276f " + LONG_DRAFT_TEXT[-100:-1] + "X", "\u2500" * 50],
    ["\u276f " + LONG_DRAFT_TEXT[-39:], "\u2500" * 50],
])
def test_long_draft_rejects_wrong_or_too_short_visible_tail(draft_screen):
    transport = ScriptedTransport(
        screens=[["\u276f"], ["\u276f"], draft_screen, draft_screen],
    )
    result = make_bridge(transport).send(LONG_DRAFT_TEXT, session_id=SESSION_ID)
    assert result["enter_sent"] is False
    assert [write.get("key") for write in send_calls(transport)] == [None]


def test_long_draft_refuses_input_revision_skipping_a_write():
    transport = ScriptedTransport(
        states=long_draft_states()[:2] + [state_response(revision=10, input_revision=7)] * 4,
        screens=[["\u276f"], ["\u276f"], LONG_DRAFT_SCREEN, LONG_DRAFT_SCREEN],
    )
    result = make_bridge(transport).send(LONG_DRAFT_TEXT, session_id=SESSION_ID)
    assert result["result"] == "prompt_changed"
    assert [write.get("key") for write in send_calls(transport)] == [None]


def test_ask_parser_footer_wrapped_inside_chord_p_a05() -> None:
    screen = SINGLE_ASK[:-1] + [
        "Enter to select · ↑/↓ to", "navigate · Esc to cancel",
    ]
    parsed = scan_ask_question(screen)
    assert parsed is not None
    assert parsed["kind"] == "single"
    assert parsed["question"] == "Pick a fruit"
    assert [option["label"] for option in parsed["options"]] == [
        "Apple", "Banana", "Type something.", "Chat about this",
    ]


def test_ask_parser_wrapped_tab_bar_p_a09() -> None:
    screen = [TABBED_FIRST[0], "☐  ☐ Colour  ☐ Size", "✔ Submit  ▶", *TABBED_FIRST[2:]]
    parsed = scan_ask_question(screen)
    assert parsed is not None
    assert parsed["kind"] == "tabbed"
    assert parsed["question"] == "Pick a colour"
    assert [tab["label"] for tab in parsed["tabs"]] == ["Colour", "Size"]
    assert [tab["label"] for tab in parsed["tabs"] if tab["active"]] == ["Colour"]


def test_ask_parser_review_with_blank_before_options_p_a12() -> None:
    screen = REVIEW[:8] + [""] + REVIEW[8:]
    parsed = scan_ask_question(screen)
    assert parsed is not None
    assert parsed["kind"] == "review"
    assert parsed["question"] == "Ready to submit your answers?"
    assert [option["label"] for option in parsed["options"]] == ["Submit answers", "Cancel"]


def test_ask_parser_blank_review_guard_presses_submit_p_a12b() -> None:
    screen = REVIEW[:8] + [""] + REVIEW[8:]
    parsed = scan_ask_question(screen)
    assert parsed is not None
    # This is the guard's answer_ask choice, as exercised by probe P-A12b:
    # review -> 1; other dialogs -> first role=option (which must not be Cancel).
    digit = 1 if parsed["kind"] == "review" else next(
        option["index"] for option in parsed["options"] if option["role"] == "option"
    )
    assert digit == 1
    assert next(option["label"] for option in parsed["options"] if option["index"] == digit) == "Submit answers"


def test_ask_parser_question_ending_with_arrow_p_a13b() -> None:
    screen = [SINGLE_ASK[0], SINGLE_ASK[1], "Pick one →", *SINGLE_ASK[3:]]
    parsed = scan_ask_question(screen)
    assert parsed is not None
    assert parsed["kind"] == "single"
    assert parsed["question"] == "Pick one →"
    assert parsed["tabs"] == []


def test_answer_ask_free_text_cursor_never_writes_p_b01() -> None:
    screen = [SINGLE_ASK[0], SINGLE_ASK[1], SINGLE_ASK[2],
              "1. Apple", "2. Banana", "❯ 3. Type something.", *SINGLE_ASK[6:]]
    transport = AskTransport([screen, screen, ["done"], ["done"]])
    with pytest.raises(BridgeError) as error:
        make_bridge(transport).answer_ask(SESSION_ID, {"Pick a fruit": 1})
    assert error.value.kind == "verification_unavailable"
    assert send_calls(transport) == []



# Additional AskUserQuestion regression coverage.
# Synthetic wrapped question; no transcript or dispatch body.
RESUME_ASK = [
    '  Ran 2 checks',
    '',
    '──────────────────────────────────────────',
    ' ☐ Resume task',
    '',
    'A sample renderer wrapped this question',
    'across several display rows.',
    '',
    '❯ 1. Continue',
    '     Continue the synthetic task.',
    '  2. Pause',
    '     Keep the existing sample output.',
    '  3. Type something.',
    '──────────────────────────────────────────',
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
]


LEGACY_PREVIEW_ASK = [
    "─" * 80,
    "☐ Layout",
    "Pick a layout",
    f"{'❯ 1. Compact':<30}    ┌────────────────┐",
    f"{'layout ✔':<30}    │ Sample panel   │",
    "└────────────────┘",
    "2. Roomy",
    "3. Type something.",
    "─" * 80,
    "4. Chat about this",
    "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · ctrl+g to edit in code · Esc to cancel",
]


PREVIEW_ASK = [
    "─" * 80,
    "☐  ☐ Layout  ☐ Density  ✔ Submit  ▶",
    "Pick a layout",
    f"{'❯ 1. Compact':<30}    ┌────────────────┐",
    f"{'layout ✔':<30}    │ Sample panel   │",
    "└────────────────┘",
    "2. Roomy",
    "Notes: sample note",
    "─" * 80,
    "  Chat about this",
    # Two questions with a notes input: Tab switches questions and ctrl+g edits notes.
    "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · ctrl+g to edit in VS Code · Esc to cancel",
]


SINGLE_TYPING = [
    line.removeprefix("❯ ").replace("3. Type something.", "❯ 3. Type something.")
    for line in SINGLE_ASK
]


TABBED_TYPING = [
    line.removeprefix("❯ ").replace("3. Type something.", "❯ 3. Type something.")
    for line in TABBED_FIRST
]


MULTI_TYPING = [
    line.removeprefix("❯ ").replace("4. [ ] Type something", "❯ 4. [ ] Type something")
    for line in MULTI_START
]


def wrap_ansi_rows(text: str, width: int) -> list[str]:
    """Plain-text wrap-ansi port for pane.read: trim=False, hard=True, wordWrap=True.

    Symbols assume one cell; footer text was verified against wrap-ansi 9.0.2.
    """
    assert width > 0

    def cell_width(character: str) -> int:
        if unicodedata.category(character) in {"Mn", "Me", "Cf"}:
            return 0
        return 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1

    rows: list[str] = []
    for line in text.split("\n"):
        wrapped = [""]
        used = 0
        for index, word in enumerate(line.split(" ")):
            if index:
                if used >= width:
                    wrapped.append("")
                    used = 0
                # trim:false preserves this space, including after an exactly full row.
                wrapped[-1] += " "
                used += 1
            word_width = sum(cell_width(character) for character in word)
            if word_width > width:
                here = 1 + (word_width - (width - used) - 1) // width
                fresh = (word_width - 1) // width
                if fresh < here:
                    wrapped.append("")
                    used = 0
                for character in word:
                    cells = cell_width(character)
                    if used + cells > width:
                        wrapped.append("")
                        used = 0
                    wrapped[-1] += character
                    used += cells
            else:
                if used + word_width > width and used and word_width:
                    wrapped.append("")
                    used = 0
                wrapped[-1] += word
                used += word_width
        rows.extend(wrapped)
    return rows


def wrap_ask_chrome(screen: list[str], width: int, *, wrap_tabs: bool = False) -> list[str]:
    """Wrap footer text like Ink; wrap_tabs is an unverified model, not a UI capture.

    Claude Code 2.1.319 truncates tab labels instead of word-wrapping the bar.
    The optional tab model exercises tolerant parsing only.
    """
    rows: list[str] = []
    for line in screen:
        if line.startswith(("Enter to select", "-- ")) or wrap_tabs and "✔ Submit" in line:
            rows.extend(wrap_ansi_rows(line, width))
        else:
            rows.append(line)
    return rows


@pytest.mark.parametrize(
    ("text", "width", "rows"),
    [
        (
            SINGLE_ASK[-1], 24,
            ["Enter to select · ↑/↓ to", " navigate · Esc to ", "cancel"],
        ),
        (SINGLE_ASK[-1], 42, ["Enter to select · ↑/↓ to navigate · Esc to", " cancel"]),
        ("Enter to select · 日本語の説明", 24, ["Enter to select · ", "日本語の説明"]),
        ("Enter to select · " + "界" * 13, 24, ["Enter to select · " + "界" * 3, "界" * 10]),
    ],
    ids=["leading-and-trailing-space", "exact-width-leading-space", "cjk-width", "hard-cjk-word"],
)
def test_wrap_ask_chrome_matches_ink_trim_false_hard(text: str, width: int, rows: list[str]) -> None:
    assert wrap_ask_chrome([text], width) == rows


def test_ask_parser_accepts_42_column_resume_reproduction() -> None:
    expected = scan_ask_question(RESUME_ASK)
    assert expected is not None
    assert expected["kind"] == "single"
    assert expected["header"] == "Resume task"
    assert len(expected["options"]) == 4
    wrapped = [
        *RESUME_ASK[:-1],
        "Enter to select · ↑/↓ to navigate · Esc to",
        "cancel",
    ]

    assert scan_ask_question(wrapped) == expected


@pytest.mark.parametrize("width", range(24, 81))
@pytest.mark.parametrize(
    "screen", [SINGLE_ASK, TABBED_FIRST, TABBED_SECOND], ids=["single", "first-tab", "second-tab"]
)
def test_ask_parser_accepts_word_wrapped_footers(screen: list[str], width: int) -> None:
    expected = scan_ask_question(screen)
    assert expected is not None

    parsed = scan_ask_question(wrap_ask_chrome(screen, width))

    assert parsed == expected
    assert ask_fingerprint(parsed) == ask_fingerprint(expected)


@pytest.mark.parametrize("width", range(24, 81))
@pytest.mark.parametrize(
    "screen", [TABBED_FIRST, TABBED_SECOND, REVIEW, MULTI_START],
    ids=["first-tab", "second-tab", "review", "multiselect"],
)
def test_ask_parser_accepts_unverified_wrapped_tab_bar_model(screen: list[str], width: int) -> None:
    """Unverified wrapping model; 2.1.319 truncates labels in its actual tab bar."""
    expected = scan_ask_question(screen)
    assert expected is not None
    # Keep the footer on one line to isolate tab-bar parsing from footer parsing.
    wrapped = wrap_ask_chrome(screen[:-1], width, wrap_tabs=True) + screen[-1:]

    parsed = scan_ask_question(wrapped)

    assert parsed == expected
    assert ask_fingerprint(parsed) == ask_fingerprint(expected)


@pytest.mark.parametrize(
    ("bar", "wrapped_bar"),
    [
        (
            "←  ☐ Topic  ☐ Scope  ✔ Submit  →",
            ["←  ☐ Topic  ☐ Scope", "✔ Submit  →"],
        ),
        (
            "☐  ☐ Output format  ☐ Density  ✔ Submit  ▶",
            ["☐  ☐ Output format", "☐ Density  ✔ Submit  ▶"],
        ),
        (
            "☐  ☑ Output format  ☐ Density  ✔ Submit  ▶",
            ["☐  ☑ Output", "format  ☐ Density", "✔ Submit  ▶"],
        ),
    ],
    ids=["submit-on-second-row", "tab-on-second-row", "label-on-three-rows"],
)
def test_ask_parser_joins_unverified_tab_bar_row_models(bar: str, wrapped_bar: list[str]) -> None:
    """These row splits are unverified models, not measured 2.1.319 rendering."""
    screen = [TABBED_FIRST[0], bar, *TABBED_FIRST[2:]]
    expected = scan_ask_question(screen)
    assert expected is not None
    wrapped = [screen[0], *wrapped_bar, *screen[2:]]

    assert scan_ask_question(wrapped) == expected


@pytest.mark.parametrize("arrow", ["→", "▶"])
def test_ask_parser_does_not_join_question_text_as_a_tab_bar(arrow: str) -> None:
    screen = [
        SINGLE_ASK[0],
        "☐ Direction",
        f"Which way {arrow}",
        "should we go?",
        *SINGLE_ASK[3:],
    ]

    parsed = scan_ask_question(screen)

    assert parsed is not None
    assert parsed["kind"] == "single"
    assert parsed["tabs"] == []
    assert parsed["header"] == "Direction"
    assert parsed["question"] == f"Which way {arrow} should we go?"


def test_ask_parser_rejects_blank_rows_inside_wrapped_footer() -> None:
    screen = [
        *SINGLE_ASK[:-1],
        "  Enter to select · ↑/↓ to navigate · Esc to  \r",
        "",
        "   ",
        "  cancel\r",
        "",
        "  ",
    ]

    assert scan_ask_question(screen) is None


@pytest.mark.parametrize("width", [24, 30, 42, 80])
def test_ask_parser_allows_only_blank_rows_after_complete_footer(width: int) -> None:
    screen = wrap_ask_chrome(SINGLE_ASK, width)

    assert scan_ask_question([*screen, "", "  ", "\r"]) == scan_ask_question(SINGLE_ASK)
    assert scan_ask_question([*screen, "", "· Esc to cancel"]) is None


@pytest.mark.parametrize(
    "question_rows", [["Which way ✔ Submit →", "should we go?"], ["Which way", "✔ Submit →", "should we go?"]],
    ids=["arrow-row", "submit-row"],
)
def test_ask_parser_keeps_single_header_separate_from_tab_like_question(question_rows: list[str]) -> None:
    screen = [SINGLE_ASK[0], "☐ Direction", *question_rows, *SINGLE_ASK[3:]]

    parsed = scan_ask_question(screen)

    assert parsed is not None
    assert parsed["kind"] == "single"
    assert parsed["tabs"] == []
    assert parsed["header"] == "Direction"
    assert parsed["question"] == " ".join(question_rows)


@pytest.mark.parametrize("unverified_wrap_model", [False, True], ids=["one-line", "unverified-wrap-model"])
def test_ask_parser_accepts_left_arrow_tab_bar_and_unverified_wrap_model(unverified_wrap_model: bool) -> None:
    """The multiline variant is an unverified model of tolerant bar parsing."""
    bar = "←  ☐ Colour  ☐ Size  ✔ Submit  →"
    screen = [TABBED_FIRST[0], bar, *TABBED_FIRST[2:]]
    expected = scan_ask_question(TABBED_FIRST)
    assert expected is not None
    if unverified_wrap_model:
        screen = [screen[0], "←  ☐ Colour  ☐ Size", "✔ Submit  →", *screen[2:]]

    assert scan_ask_question(screen) == expected


@pytest.mark.parametrize("editor", [None, "VS Code", "Notepad"], ids=["no-editor", "vs-code", "notepad"])
@pytest.mark.parametrize("mode", ["INSERT", "VISUAL", "VISUAL LINE"])
@pytest.mark.parametrize("width", [None, 24, 30, 42], ids=["one-line", "24", "30", "42"])
@pytest.mark.parametrize(
    ("screen", "navigation"),
    [(SINGLE_TYPING, "↑/↓ to navigate"), (MULTI_DOWN_3, "↑/↓ to navigate"), (TABBED_TYPING, "Tab/Arrow keys to navigate")],
    ids=["single", "multiselect", "tabbed"],
)
def test_ask_parser_accepts_vim_footer_without_esc(
    screen: list[str], navigation: str, width: int | None, mode: str, editor: str | None,
) -> None:
    expected = scan_ask_question(screen)
    assert expected is not None
    typed = [*screen[:-1], f"-- {mode} -- · Enter to select · {navigation}"]
    if editor is not None:
        typed[-1] += f" · ctrl+g to edit in {editor}"
    wrapped = typed if width is None else wrap_ask_chrome(typed, width)

    parsed = scan_ask_question(wrapped)

    assert parsed == expected
    assert ask_fingerprint(parsed) == ask_fingerprint(expected)
    assert scan_ask_question([*wrapped, "answer accepted"]) is None


def test_ask_parser_rejects_two_vim_mode_markers_in_footer() -> None:
    screen = [*SINGLE_TYPING[:-1], "-- INSERT -- · -- VISUAL -- · Enter to select · ↑/↓ to navigate"]

    assert scan_ask_question(screen) is None




@pytest.mark.parametrize(
    "screen",
    [
        [*SINGLE_ASK[:-1], "-- INSERT -- · ↑/↓ to navigate"],
        [*TABBED_FIRST, "", "-- INSERT -- · Esc to cancel"],
        [*TABBED_FIRST, "", "-- INSERT -- · ↑/↓ to navigate"],
    ],
    ids=["missing-enter", "stale-vim-esc-below-blank", "stale-vim-navigation-below-blank"],
)
def test_ask_parser_rejects_vim_footer_without_enter_to_select(screen: list[str]) -> None:
    assert scan_ask_question(screen) is None


@pytest.mark.parametrize("editor", ["VS Code", "Devin Desktop", "Sublime Text", "IntelliJ IDEA", "Android Studio"])
@pytest.mark.parametrize("width", [None, 42], ids=["one-line", "42"])
def test_ask_parser_accepts_spaced_editor_display_names(editor: str, width: int | None) -> None:
    screen = [*SINGLE_ASK[:-1], f"{SINGLE_ASK[-1]} · ctrl+g to edit in {editor}"]
    wrapped = screen if width is None else wrap_ask_chrome(screen, width)

    assert scan_ask_question(wrapped) == scan_ask_question(SINGLE_ASK)
    assert scan_ask_question([*wrapped, "answer accepted"]) is None
    assert scan_ask_question([*wrapped[:-1], wrapped[-1] + " answer accepted"]) is None


@pytest.mark.parametrize("review", [REVIEW, REVIEW_MULTI], ids=["tabbed", "multiselect"])
@pytest.mark.parametrize("gap", [[""], ["", "  ", "\r"]], ids=["margin-row", "blank-rows"])
def test_ask_parser_reads_review_with_blank_rows_before_options(review: list[str], gap: list[str]) -> None:
    first_option = next(index for index, line in enumerate(review) if line.startswith("❯"))
    screen = [*review[:first_option], *gap, *review[first_option:]]
    expected = scan_ask_question(review)
    assert expected is not None
    assert expected["kind"] == "review"

    parsed = scan_ask_question(screen)

    assert parsed == expected
    assert ask_fingerprint(parsed) == ask_fingerprint(expected)


@pytest.mark.parametrize("width", [24, 42, 80])
@pytest.mark.parametrize("tail", [["answer accepted"], ["$ "], ["· unrelated output"]])
def test_ask_parser_rejects_stale_text_after_wrapped_footer(width: int, tail: list[str]) -> None:
    assert scan_ask_question([*wrap_ask_chrome(SINGLE_ASK, width), *tail]) is None


@pytest.mark.parametrize("inline", [False, True])
@pytest.mark.parametrize("tail", ["answer accepted", "$", "· unrelated output"])
def test_ask_parser_rejects_stale_text_after_editor_chord(inline: bool, tail: str) -> None:
    footer = SINGLE_ASK[-1] + " · ctrl+g to edit in code"
    screen = [*SINGLE_ASK[:-1], footer]
    assert scan_ask_question(screen) == scan_ask_question(SINGLE_ASK)
    stale = [*screen[:-1], f"{footer} {tail}"] if inline else [*screen, tail]

    assert scan_ask_question(stale) is None


def test_ask_parser_preserves_preview_layout() -> None:
    parsed = scan_ask_question(LEGACY_PREVIEW_ASK)

    assert parsed == {
        "kind": "single",
        "multi_select": False,
        "tabs": [],
        "question": "Pick a layout",
        "options": [
            {"index": 1, "label": "Compact layout", "current": True, "role": "option"},
            {"index": 2, "label": "Roomy", "current": False, "role": "option"},
            {"index": 3, "label": "Type something.", "current": False, "role": "typeSomething"},
            {"index": 4, "label": "Chat about this", "current": False, "role": "chatAbout"},
        ],
        "layout": "preview",
        "header": "Layout",
    }


def test_ask_parser_reads_two_question_preview_with_notes_input() -> None:
    parsed = scan_ask_question(PREVIEW_ASK)

    assert parsed == {
        "kind": "tabbed",
        "multi_select": False,
        "tabs": [
            {"label": "Layout", "answered": False, "active": True},
            {"label": "Density", "answered": False, "active": False},
        ],
        "question": "Pick a layout",
        "options": [
            {"index": 1, "label": "Compact layout", "current": True, "role": "option"},
            {"index": 2, "label": "Roomy", "current": False, "role": "option"},
        ],
        "layout": "preview",
        "header": "Layout",
    }


@pytest.mark.parametrize("width", range(24, 81))
def test_ask_parser_preserves_preview_with_wrapped_footer(width: int) -> None:
    # Only the footer wraps; the preview's 30-cell column and right frame stay wide.
    expected = scan_ask_question(PREVIEW_ASK)
    assert expected is not None

    assert scan_ask_question(wrap_ask_chrome(PREVIEW_ASK, width)) == expected


@pytest.mark.parametrize(
    ("screen", "fingerprint"),
    [
        (SINGLE_ASK, "3ca60a8b164a54c240e33b3edc13928dcf9f0ae148efdbb0948d528257af0bec"),
        (RESUME_ASK, "6080ddec0ae3328a974c8ad6ddb0e29a749bfdcd496e77c742081116d1ac2eb7"),
        (TABBED_FIRST, "763ece861cffea785e4343bd45183a1f8802af727899c3632cc8f527018fc218"),
        (TABBED_SECOND, "1e2a06b09001d6cb89e9190d7cd23da3319a99bacb78846dda5da1b3fadb3b74"),
        (REVIEW, "6ab29afb82a426e89eaf32cfb322d1f41011a09f73ad01302f971563767948ff"),
        (MULTI_START, "bbe17085f5c9db7380f5fef54627a16b9a534f5d5eda8b47e086187a2d949d64"),
        (LEGACY_PREVIEW_ASK, "31cf23500d0c80682b2274fcd80b26683d3ebb35b94c39068f95a2dc8a18c233"),
    ],
    ids=["single", "resume", "first-tab", "second-tab", "review", "multiselect", "preview"],
)
def test_ask_parser_preserves_starting_commit_fingerprints(screen: list[str], fingerprint: str) -> None:
    # Original parser hashes; resume uses a synthetic fixture checked before import.
    parsed = scan_ask_question(screen)

    assert parsed is not None
    assert ask_fingerprint(parsed) == fingerprint


def test_ask_parser_rejects_footerless_effort_confirmation() -> None:
    screen = ["Change effort level?", "❯ 1. Yes, switch to high", "2. No, go back"]

    assert scan_ask_question(screen) is None


@pytest.mark.parametrize("screen", [SINGLE_ASK, TABBED_FIRST, PREVIEW_ASK], ids=["single", "tabbed", "preview"])
def test_ask_parser_rejects_question_scrolled_above_pane(screen: list[str]) -> None:
    assert scan_ask_question(screen[3:]) is None


@pytest.mark.parametrize("width", range(24, 81))
def test_answer_ask_single_accepts_wrapped_footer(width: int) -> None:
    screen = wrap_ask_chrome(SINGLE_ASK, width)
    transport = AskTransport([screen, screen, ["done"], ["done"]], close_after_writes=1)

    result = make_bridge(transport).answer_ask(SESSION_ID, {"Pick a fruit": 2})

    assert result["result"] == "observed_delivered"
    writes = send_calls(transport)
    assert [(write["text"], write.get("key"), write["enter"]) for write in writes] == [
        ("2", None, False)
    ]
    assert writes[0]["expectedInputRevision"] == 5


@pytest.mark.parametrize("width", range(24, 81))
def test_answer_ask_multiple_accepts_wrapped_footer_and_unverified_tab_model(width: int) -> None:
    """The tab-row wrapping is an unverified model, not 2.1.319's truncating UI."""
    first = wrap_ask_chrome(TABBED_FIRST, width, wrap_tabs=True)
    second = wrap_ask_chrome(TABBED_SECOND, width, wrap_tabs=True)
    review = wrap_ask_chrome(REVIEW, width, wrap_tabs=True)
    transport = AskTransport(
        [first, first, second, second, review, review, ["done"], ["done"]],
        states=[state_response(attention="input", attention_id="ask-a", revision=10)],
        close_after_writes=3,
    )

    result = make_bridge(transport).answer_ask(SESSION_ID, {"Pick a colour": 2, "Pick a size": 2})

    assert result["result"] == "observed_delivered"
    writes = send_calls(transport)
    assert [(write["text"], write.get("key"), write["enter"]) for write in writes] == [
        ("2", None, False),
        ("2", None, False),
        ("1", None, False),
    ]
    assert [write["expectedInputRevision"] for write in writes] == [5, 6, 7]


@pytest.mark.parametrize("vim_insert", [False, True], ids=["normal-footer", "vim-insert"])
@pytest.mark.parametrize(
    ("screen", "answers"),
    [(SINGLE_TYPING, {"Pick a fruit": 2}), (MULTI_TYPING, {"Pick toppings": [1]})],
    ids=["single", "multiselect"],
)
def test_answer_ask_refuses_digits_on_free_text_row(
    screen: list[str], answers: dict[str, Any], vim_insert: bool,
) -> None:
    if vim_insert:
        screen = wrap_ask_chrome(
            [*screen[:-1], "-- INSERT -- · Enter to select · ↑/↓ to navigate · ctrl+g to edit in VS Code"], 30,
        )
    transport = AskTransport([screen])

    with pytest.raises(BridgeError) as error:
        make_bridge(transport).answer_ask(SESSION_ID, answers)

    assert send_calls(transport) == []
    assert error.value.kind == "verification_unavailable"
    assert str(error.value) == "cursor is on the free-text row"

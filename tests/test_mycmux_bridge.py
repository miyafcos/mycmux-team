from __future__ import annotations

from copy import deepcopy
import importlib.util
import io
from pathlib import Path
from typing import Any

import pytest


BRIDGE_SCRIPT = (
    Path.home() / ".claude" / "skills" / "mycmux-bridge" / "scripts" / "mycmux_bridge.py"
)

# The bridge lives in the Claude skill directory, not in this repository, so a
# clean checkout (CI, another machine) has nothing to import. Skip the module
# instead of failing collection for everyone who has not installed the skill.
if not BRIDGE_SCRIPT.is_file():
    pytest.skip(
        f"mycmux-bridge skill not installed at {BRIDGE_SCRIPT}",
        allow_module_level=True,
    )

spec = importlib.util.spec_from_file_location("mycmux_bridge", BRIDGE_SCRIPT)
assert spec is not None and spec.loader is not None
bridge_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_module)

Bridge = bridge_module.Bridge
BridgeError = bridge_module.BridgeError
scan_ask_question = bridge_module.scan_ask_question

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
            return deepcopy(value)
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

    assert result["result"] == "residue_remains"
    writes = send_calls(transport)
    assert [write.get("key") for write in writes] == [None, "enter"]
    assert writes[1]["expectedInputRevision"] == 6


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
            ["previous: hello", "prompt>"],
            ["previous: hello", "prompt>"],
            ["previous: hello", "prompt>"],
            ["previous: hello", "prompt>"],
        ]
    )

    result = make_bridge(transport).send("hello", session_id=SESSION_ID)

    assert result["result"] == "draft_not_observed"
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
            state_response(revision=10),
            state_response(revision=10),
            state_response(revision=10),
            state_response(revision=10),
            state_response(revision=10),
            state_response(revision=10),
            state_response(revision=11, activity="running_silent"),
            state_response(revision=11, activity="running_silent"),
        ],
        screens=[
            ["prompt>"],
            ["prompt>"],
            [f"prompt> {text}"],
            [f"prompt> {text}"],
            [f"prompt> {text}"],
            [f"prompt> {text}"],
            [f"prompt> {text}"],
        ],
    )

    result = make_bridge(transport).send(text, session_id=SESSION_ID)

    assert result["result"] == "residue_remains"
    assert [write.get("key") for write in send_calls(transport)] == [None, "enter"]


def test_send_rejects_epoch_change_after_enter() -> None:
    text = "hello"
    transport = ScriptedTransport(
        states=[
            *[state_response(epoch=7, revision=10) for _ in range(6)],
            *[state_response(epoch=8, revision=11) for _ in range(2)],
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
            REVIEW_MULTI,
            REVIEW_MULTI,
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
    monkeypatch.setattr(bridge_module, "resolve_repo", lambda _explicit=None: Path("C:/repo"))
    monkeypatch.setattr(bridge_module, "load_agent_cli", lambda _repo: fake_cli)
    monkeypatch.setattr(bridge_module, "Bridge", ExplodingBridge)

    assert bridge_module.main(["list"]) == 1
    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err
    assert "mycmux request failed" in captured.err

    error = BridgeError("verification_unavailable", "source checkout missing")
    assert secret not in str(error)

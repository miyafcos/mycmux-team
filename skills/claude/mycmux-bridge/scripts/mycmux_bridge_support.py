from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any, Callable, Sequence

DEFAULT_OBSERVATIONS = 5
DEFAULT_POLL_SECONDS = 0.2
AGENT_KINDS = ("claude", "codex", "claude-codex", "grok", "shell")
RESULT_KINDS = {
    "observed_delivered",
    "stale_target",
    "prompt_changed",
    "draft_not_observed",
    "residue_remains",
    "screen_changed_ambiguously",
    "verification_unavailable",
    "write_failed",
}


class BridgeError(RuntimeError):
    """A fail-closed bridge error with a stable result classification."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


class BridgeBase:
    def __init__(
        self,
        request: Callable[[str, dict[str, Any]], Any],
        *,
        sleep: Callable[[float], None] = time.sleep,
        observations: int = DEFAULT_OBSERVATIONS,
        poll_seconds: float = DEFAULT_POLL_SECONDS,
    ) -> None:
        self.request = request
        self.sleep = sleep
        self.observations = max(1, observations)
        self.poll_seconds = max(0.0, poll_seconds)
        self._ask_input_revisions: dict[str, int] = {}
    def answer_ask(self, session_id: str, answers: dict[str, Any]) -> dict[str, Any]:
        try:
            return self._answer_ask(session_id, answers)
        finally:
            self._ask_input_revisions.pop(session_id, None)
    def _answer_ask(self, session_id: str, answers: dict[str, Any]) -> dict[str, Any]:
        self._exact_registry_entry(session_id)
        if not isinstance(answers, dict) or not answers:
            raise BridgeError("prompt_changed", "answers must be a non-empty JSON object")
        answered: dict[str, list[str]] = {}
        state, _, ask = self._observe_ask(session_id)
        self._ask_input_revisions[session_id] = self._input_revision(state)
        steps = 0
        max_steps = max(8, len(answers) * 12)
        while steps < max_steps:
            prompt_hash = ask_fingerprint(ask)
            if ask["kind"] == "review":
                if not review_matches_answers(ask, answered, answers):
                    raise BridgeError("prompt_changed", "review answers do not match the requested answers")
                self._send_ask_digit(session_id, "1", state, prompt_hash)
                _, _, after_submit = self._await_ask_change(
                    session_id,
                    state,
                    prompt_hash,
                    "review submission",
                    allow_close=True,
                )
                if after_submit is not None:
                    raise BridgeError("verification_unavailable", "review submission did not close")
                return self._result("observed_delivered", session_id, "AskUserQuestion submitted")
            question = ask["question"]
            if question not in answers:
                raise BridgeError("prompt_changed", f"no answer supplied for on-screen question: {question}")
            answer = answers[question]
            if ask["multi_select"]:
                choices = answer if isinstance(answer, list) else [answer]
                selected = self._validate_choices(ask, choices)
                desired = set(selected)
                current = ask
                toggle_indices = [
                    option["index"]
                    for option in current["options"]
                    if option.get("role") == "option"
                    and isinstance(option.get("index"), int)
                    and bool(option.get("checked")) != (option["index"] in desired)
                ]
                toggle_indices.sort(key=lambda index: index in desired)
                for index in toggle_indices:
                    expected_checked = index in desired
                    if bool(option_by_index(current, index).get("checked")) == expected_checked:
                        continue
                    current_state = self._status_entry(session_id)
                    current_hash = ask_fingerprint(current)
                    self._send_ask_digit(session_id, str(index), current_state, current_hash)
                    state, _, current = self._await_ask_change(
                        session_id,
                        current_state,
                        current_hash,
                        "multiSelect toggle",
                    )
                    if option_by_index(current, index).get("checked") != expected_checked:
                        raise BridgeError("verification_unavailable", "multiSelect toggle was not observed")
                    steps += 1
                checked = {
                    option["index"]
                    for option in current["options"]
                    if option.get("role") == "option" and option.get("checked") is True
                }
                if checked != desired:
                    raise BridgeError("prompt_changed", "multiSelect choices do not match the request")
                answered[question] = [option_by_index(current, index)["label"] for index in selected]
                state, ask = self._move_to_submit_and_enter(session_id, current)
                steps += 1
                continue
            choice = self._validate_choices(ask, [answer])[0]
            answered[question] = [option_by_index(ask, choice)["label"]]
            self._send_ask_digit(session_id, str(choice), state, prompt_hash)
            steps += 1
            state, _, ask = self._await_ask_change(
                session_id,
                state,
                prompt_hash,
                "single-choice response",
                allow_close=ask["kind"] == "single",
            )
            if ask is None:
                return self._result("observed_delivered", session_id, "single AskUserQuestion resolved")
        raise BridgeError("verification_unavailable", "AskUserQuestion sequence exceeded the safety bound")
    def _move_to_submit_and_enter(
        self,
        session_id: str,
        ask: dict[str, Any],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        options = ask["options"]
        current_positions = [index for index, option in enumerate(options) if option["current"]]
        submit_positions = [index for index, option in enumerate(options) if option["role"] == "submit"]
        if len(current_positions) != 1 or len(submit_positions) != 1:
            raise BridgeError("prompt_changed", "multiSelect cursor or Submit row is ambiguous")
        moves = submit_positions[0] - current_positions[0]
        if moves < 0:
            raise BridgeError("prompt_changed", "multiSelect Submit row is above the cursor")
        current = ask
        state = self._status_entry(session_id)
        for _ in range(moves):
            current_hash = ask_fingerprint(current)
            self._send_ask_key(session_id, "down", state, current_hash)
            state, _, advanced = self._await_ask_change(
                session_id,
                state,
                current_hash,
                "multiSelect cursor movement",
            )
            if advanced is None or cursor_position(advanced) != cursor_position(current) + 1:
                raise BridgeError("verification_unavailable", "multiSelect cursor movement was not observed")
            current = advanced
        current_hash = ask_fingerprint(current)
        self._send_ask_key(session_id, "enter", state, current_hash)
        state, _, review = self._await_ask_change(
            session_id,
            state,
            current_hash,
            "multiSelect review",
        )
        if review is None or review["kind"] != "review":
            raise BridgeError("verification_unavailable", "multiSelect review screen was not observed")
        return state, review
    def _await_ask_change(
        self,
        session_id: str,
        before_state: dict[str, Any],
        previous_hash: str,
        action: str,
        *,
        allow_close: bool = False,
    ) -> tuple[dict[str, Any], list[str], dict[str, Any] | None]:
        closed_state: dict[str, Any] | None = None
        for _ in range(self.observations):
            try:
                observed = self._observe_ask(session_id)
            except BridgeError:
                if allow_close:
                    try:
                        state = self._status_entry(session_id)
                        self._ensure_same_session(before_state, state)
                    except BridgeError:
                        self.sleep(self.poll_seconds)
                        continue
                    if state_transition_signature(state) != state_transition_signature(before_state):
                        closed_state = state
                self.sleep(self.poll_seconds)
                continue
            if ask_fingerprint(observed[2]) != previous_hash:
                return observed
            self.sleep(self.poll_seconds)
        if allow_close and closed_state is not None:
            return closed_state, [], None
        raise BridgeError("verification_unavailable", f"{action} did not advance")
    def _send_ask_digit(
        self,
        session_id: str,
        digit: str,
        state: dict[str, Any],
        expected_prompt_hash: str,
    ) -> None:
        if len(digit.encode("ascii", errors="ignore")) != 1 or digit not in "123456789":
            raise BridgeError("prompt_changed", "AskUserQuestion choice must be one digit")
        latest_state, _, latest_ask = self._observe_ask(session_id)
        self._ensure_same_target(state, latest_state)
        if ask_fingerprint(latest_ask) != expected_prompt_hash:
            raise BridgeError("prompt_changed", "AskUserQuestion prompt changed before response")
        expected_input_revision = self._ask_input_revision(session_id)
        result = self.request(
            "pane.send_text",
            self._send_args(
                session_id,
                text=digit,
                state=latest_state,
                require_attention=True,
                expected_input_revision=expected_input_revision,
            ),
        )
        if not accepted_write(result):
            raise BridgeError("write_failed", "AskUserQuestion digit write was rejected")
        self._ask_input_revisions[session_id] = expected_input_revision + 1
    def _send_ask_key(
        self,
        session_id: str,
        key: str,
        state: dict[str, Any],
        expected_prompt_hash: str,
    ) -> None:
        latest_state, _, latest_ask = self._observe_ask(session_id)
        self._ensure_same_target(state, latest_state)
        if ask_fingerprint(latest_ask) != expected_prompt_hash:
            raise BridgeError("prompt_changed", "AskUserQuestion prompt changed before key response")
        expected_input_revision = self._ask_input_revision(session_id)
        result = self.request(
            "pane.send_text",
            self._send_args(
                session_id,
                text="",
                key=key,
                state=latest_state,
                require_attention=True,
                expected_input_revision=expected_input_revision,
            ),
        )
        if not confirmed_key_write(result):
            raise BridgeError("write_failed", f"AskUserQuestion {key} write was not confirmed")
        self._ask_input_revisions[session_id] = expected_input_revision + 1
    def _observe_ask(self, session_id: str) -> tuple[dict[str, Any], list[str], dict[str, Any]]:
        state = self._status_entry(session_id)
        view = state.get("view")
        attention = view.get("attention") if isinstance(view, dict) else None
        expected_attention = attention.get("kind") if isinstance(attention, dict) else None
        if expected_attention not in {"input", "approval"}:
            raise BridgeError("stale_target", "target attention is not an AskUserQuestion")
        self._ensure_sendable(state, expected_attention)
        screen = self.read(session_id)["lines"]
        ask = scan_ask_question(screen)
        if ask is None:
            raise BridgeError("verification_unavailable", "AskUserQuestion screen could not be parsed")
        return state, screen, ask
    def _validate_choices(self, ask: dict[str, Any], choices: list[Any]) -> list[int]:
        if not choices:
            raise BridgeError("prompt_changed", "at least one AskUserQuestion choice is required")
        available = {
            option["index"]
            for option in ask["options"]
            if option["role"] == "option" and isinstance(option["index"], int)
        }
        normalized: list[int] = []
        for choice in choices:
            if not isinstance(choice, int) or choice not in available or not 1 <= choice <= 9:
                raise BridgeError("prompt_changed", f"invalid AskUserQuestion choice: {choice}")
            if choice not in normalized:
                normalized.append(choice)
        return normalized
    def _registry(self) -> list[dict[str, Any]]:
        result = self.request("pane.list_all", {})
        if not isinstance(result, dict) or not isinstance(result.get("panes"), list):
            raise BridgeError("verification_unavailable", "pane.list_all returned an invalid schema")
        entries: list[dict[str, Any]] = []
        seen_sessions: set[str] = set()
        for pane in result["panes"]:
            if not isinstance(pane, dict) or not isinstance(pane.get("tabs"), list):
                raise BridgeError("verification_unavailable", "pane.list_all returned an invalid pane")
            pane_id = pane.get("id")
            workspace_id = pane.get("workspaceId")
            if not isinstance(pane_id, str) or not isinstance(workspace_id, str):
                raise BridgeError("verification_unavailable", "pane.list_all omitted pane identities")
            for tab in pane["tabs"]:
                if not isinstance(tab, dict):
                    raise BridgeError("verification_unavailable", "pane.list_all returned an invalid tab")
                session_id = tab.get("sessionId")
                tab_id = tab.get("id")
                if not isinstance(session_id, str) or not session_id or not isinstance(tab_id, str):
                    raise BridgeError("verification_unavailable", "pane.list_all omitted PTY session identity")
                if session_id in seen_sessions:
                    raise BridgeError("stale_target", f"duplicate PTY session in pane.list_all: {session_id}")
                seen_sessions.add(session_id)
                agent_kind = infer_agent_kind(tab)
                selectors = {
                    value
                    for value in (
                        tab.get("label"),
                        pane.get("label"),
                        tab.get("agentId"),
                        agent_kind,
                        tab.get("agentSessionId"),
                        tab.get("claudeSessionId"),
                    )
                    if isinstance(value, str) and value
                }
                entries.append(
                    {
                        "workspace_id": workspace_id,
                        "workspace_name": pane.get("workspaceName"),
                        "pane_id": pane_id,
                        "pane_label": pane.get("label"),
                        "tab_id": tab_id,
                        "tab_type": tab.get("type", "terminal"),
                        "session_id": session_id,
                        "label": tab.get("label"),
                        "agent_kind": agent_kind,
                        "agent_id": tab.get("agentId"),
                        "agent_session_id": tab.get("agentSessionId"),
                        "claude_session_id": tab.get("claudeSessionId"),
                        "tab_lifecycle": tab.get("lifecycle", "unknown"),
                        "selectors": selectors,
                    }
                )
        return entries
    def _exact_registry_entry(self, session_id: str) -> dict[str, Any]:
        matches = [item for item in self._registry() if item["session_id"] == session_id]
        if len(matches) != 1:
            raise BridgeError("stale_target", f"PTY session must exist exactly once: {session_id}")
        if matches[0]["tab_type"] != "terminal":
            raise BridgeError("stale_target", "target tab is not a PTY terminal")
        return matches[0]
    def _status_entry(self, session_id: str) -> dict[str, Any]:
        state = self.request("session.state_view", {"session_id": session_id})
        mapping = self._state_map(state)
        if set(mapping) != {session_id}:
            raise BridgeError("stale_target", f"canonical state did not return exactly one session: {session_id}")
        return mapping[session_id]
    def _state_map(self, result: Any, *, strict: bool = True) -> dict[str, dict[str, Any]]:
        if not isinstance(result, dict) or not isinstance(result.get("sessions"), list):
            raise BridgeError("verification_unavailable", "session.state_view returned an invalid schema")
        mapping: dict[str, dict[str, Any]] = {}
        for entry in result["sessions"]:
            if not isinstance(entry, dict):
                raise BridgeError("verification_unavailable", "session.state_view returned an invalid entry")
            session_id = entry.get("session_id")
            view = entry.get("view")
            if not isinstance(session_id, str) or not isinstance(view, dict):
                raise BridgeError("verification_unavailable", "session.state_view omitted session identity")
            if strict:
                self._input_revision(entry)
            if view.get("session_id") != session_id or session_id in mapping:
                raise BridgeError("stale_target", "session.state_view returned mismatched or duplicate identity")
            mapping[session_id] = entry
        return mapping
    @staticmethod
    def _input_revision(state: dict[str, Any]) -> int:
        value = state.get("input_revision")
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise BridgeError("verification_unavailable", "canonical input revision is unavailable")
        return value
    def _ensure_input_revision(self, state: dict[str, Any], expected: int) -> None:
        if self._input_revision(state) != expected:
            raise BridgeError("prompt_changed", "input revision changed outside this send")
    def _ask_input_revision(self, session_id: str) -> int:
        value = self._ask_input_revisions.get(session_id)
        if value is None:
            raise BridgeError("verification_unavailable", "AskUserQuestion input revision is unavailable")
        return value
    def _ensure_sendable(self, state: dict[str, Any], expected_attention: str) -> None:
        view = state.get("view")
        if not isinstance(view, dict):
            raise BridgeError("verification_unavailable", "canonical state omitted view")
        if view.get("lifecycle") != "alive" or view.get("health") != "fresh":
            raise BridgeError("stale_target", "target is not alive and fresh")
        attention = view.get("attention")
        if not isinstance(attention, dict) or attention.get("kind") != expected_attention:
            raise BridgeError("stale_target", f"target attention is not {expected_attention}")
    def _ensure_same_session(self, before: dict[str, Any], after: dict[str, Any]) -> None:
        before_view = before.get("view") or {}
        after_view = after.get("view") or {}
        if before_view.get("session_epoch") != after_view.get("session_epoch"):
            raise BridgeError("stale_target", "session epoch changed")

    def _ensure_same_target(self, before: dict[str, Any], after: dict[str, Any]) -> None:
        self._ensure_same_session(before, after)
        before_view = before.get("view") or {}
        after_view = after.get("view") or {}
        before_attention = before_view.get("attention") or {}
        after_attention = after_view.get("attention") or {}
        if before_attention.get("attention_id") != after_attention.get("attention_id"):
            raise BridgeError("stale_target", "attention id changed")
    def _send_args(
        self,
        session_id: str,
        *,
        text: str,
        state: dict[str, Any],
        key: str | None = None,
        require_attention: bool = False,
        expected_input_revision: int | None = None,
    ) -> dict[str, Any]:
        view = state["view"]
        attention = view.get("attention") or {}
        args: dict[str, Any] = {"sessionId": session_id, "text": text, "enter": False}
        if key is not None:
            args["key"] = key
        epoch = view.get("session_epoch")
        revision = view.get("session_revision")
        if any(type(value) is not int or value < 0 for value in (epoch, revision)):
            raise BridgeError("verification_unavailable", "canonical send expectations are unavailable")
        input_revision = (
            self._input_revision(state)
            if expected_input_revision is None
            else expected_input_revision
        )
        if (
            not isinstance(input_revision, int)
            or isinstance(input_revision, bool)
            or input_revision < 0
        ):
            raise BridgeError("verification_unavailable", "canonical input revision is unavailable")
        args["expectedSessionEpoch"] = epoch
        args["expectedSessionRevision"] = revision
        args["expectedInputRevision"] = input_revision
        if not isinstance(attention, dict) or "attention_id" not in attention:
            raise BridgeError("verification_unavailable", "canonical attention id is unavailable")
        attention_id = attention["attention_id"]
        if require_attention and (not isinstance(attention_id, str) or not attention_id):
            raise BridgeError("verification_unavailable", "AskUserQuestion attention id is unavailable")
        if attention_id is not None and (not isinstance(attention_id, str) or not attention_id):
            raise BridgeError("verification_unavailable", "canonical attention id is invalid")
        args["expectedAttentionId"] = attention_id or None
        return args
    @staticmethod
    def _result(kind: str, session_id: str, detail: str) -> dict[str, Any]:
        if kind not in RESULT_KINDS:
            kind = "verification_unavailable"
        return {"source": "mycmux", "session_id": session_id, "result": kind, "detail": detail}
def infer_agent_kind(tab: dict[str, Any]) -> str:
    values = [tab.get("agentKind"), tab.get("declaredTarget"), tab.get("agentId"), tab.get("lastProcess")]
    combined = " ".join(value.lower() for value in values if isinstance(value, str))
    if "claude-codex" in combined:
        return "claude-codex"
    if "grok" in combined:
        return "grok"
    if "codex" in combined:
        return "codex"
    if "claude" in combined:
        return "claude"
    return "shell"
def screen_fingerprint(lines: Sequence[str]) -> str:
    normalized = "\n".join(line.rstrip("\r\n ") for line in lines)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
def ask_fingerprint(ask: dict[str, Any]) -> str:
    raw = json.dumps(ask, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
INPUT_LINE_PATTERNS = (
    ("Codex", re.compile(r"^\s*›(?:[ \t]+(.*))?$")),
    ("Claude Code", re.compile(r"^\s*[>❯](?:[ \t]+(.*))?$")),
    ("PowerShell", re.compile(r"^\s*PS(?: [^>\r\n]*)?>[ \t]*(.*)$")),
    ("cmd", re.compile(r"^\s*[A-Za-z]:[\\/][^>\r\n]*>[ \t]*(.*)$")),
    ("shell", re.compile(r"^\s*(?:[\w.-]+@[\w.-]+(?::[^$#\r\n]*)?)?[$#](?:[ \t]+(.*))?$")),
)

def current_input_line(lines: Sequence[str]) -> tuple[int, str, str] | None:
    """Locate the last recognizable prompt; retain wrapped input below it."""
    for index in range(len(lines) - 1, -1, -1):
        for kind, pattern in INPUT_LINE_PATTERNS:
            match = pattern.match(lines[index].rstrip("\r\n"))
            if match:
                body = "\n".join([match.group(1) or "", *lines[index + 1:]])
                return index + 1, kind, body
    return None

def draft_visible(
    lines: Sequence[str],
    text: str,
    *,
    baseline: Sequence[str] | None = None,
) -> bool:
    compact_text = re.sub(r"\s+", "", text)
    if not compact_text:
        return False

    def occurrences(screen: Sequence[str]) -> int:
        input_line = current_input_line(screen)
        area = input_line[2] if input_line is not None else "\n".join(screen)
        compact_area = re.sub(r"\s+", "", area)
        if input_line is None:
            return compact_area.count(compact_text)
        # A wrapped body must start on the input line, not in a footer/output below it.
        first_line_length = len(re.sub(r"\s+", "", area.partition("\n")[0]))
        return sum(match.start() < first_line_length
                   for match in re.finditer(re.escape(compact_text), compact_area))

    count = occurrences(lines)
    return count > (occurrences(baseline) if baseline is not None else 0)

def accepted_write(result: Any) -> bool:
    return isinstance(result, dict) and result.get("sent") is not False and result.get("ok") is not False
def confirmed_key_write(result: Any) -> bool:
    return isinstance(result, dict) and result.get("ok") is True and result.get("confirmed") is True
def state_transition_signature(state: dict[str, Any]) -> tuple[Any, ...]:
    view = state.get("view") or {}
    attention = view.get("attention") or {}
    return (
        view.get("session_revision"),
        view.get("activity"),
        attention.get("kind"),
        attention.get("attention_id"),
    )
def option_by_index(ask: dict[str, Any], index: int) -> dict[str, Any]:
    matches = [option for option in ask["options"] if option["index"] == index]
    if len(matches) != 1:
        raise BridgeError("prompt_changed", f"AskUserQuestion option is ambiguous: {index}")
    return matches[0]
def normalized_answer(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().rstrip(".")
def review_matches_answers(
    ask: dict[str, Any],
    answered: dict[str, list[str]],
    requested: dict[str, Any],
) -> bool:
    review = ask.get("review_answers")
    if not isinstance(review, dict) or set(review) != set(requested) or set(answered) != set(requested):
        return False
    for question, expected_labels in answered.items():
        actual = review.get(question)
        if not isinstance(actual, str):
            return False
        actual_labels = [normalized_answer(part) for part in actual.split(",") if part.strip()]
        if set(actual_labels) != {normalized_answer(label) for label in expected_labels}:
            return False
    return True
def cursor_position(ask: dict[str, Any]) -> int:
    positions = [index for index, option in enumerate(ask["options"]) if option["current"]]
    if len(positions) != 1:
        raise BridgeError("prompt_changed", "AskUserQuestion cursor is ambiguous")
    return positions[0]
SEPARATOR = re.compile(r"^─{4,}\s*$")
TAB_BAR = re.compile(r"^\s*(?:←\s+)?(?:[☐☑☒]\s{2,})?(.*?)\s+(?:→|▶)\s*$")
TAB_TOKEN = re.compile(r"([☐☑☒])\s+(.+?)(?=\s+[☐☑☒]\s+|\s+✔\s+Submit|$)|✔\s+Submit")
SIMPLE_HEADER = re.compile(r"^\s*☐\s+(.+)$")
NUMBERED = re.compile(r"^(\d+)\.\s+(?:\[([ ✔])\]\s+)?(.+)$")
FOOTER = re.compile(r"Enter to select")
READY = re.compile(r"^Ready to submit your answers\?\s*$")
def scan_ask_question(lines: Sequence[str]) -> dict[str, Any] | None:
    normalized = [line.rstrip("\r ") for line in lines]
    footer_index = max((i for i, line in enumerate(normalized) if FOOTER.search(line)), default=-1)
    if footer_index >= 0 and any(line.strip() for line in normalized[footer_index + 1 :]):
        return None
    bound = footer_index if footer_index >= 0 else len(normalized)
    hits: list[tuple[int, dict[str, Any]]] = []
    for index, line in enumerate(normalized[:bound]):
        parsed = parse_ask_option(line)
        if parsed is not None:
            hits.append((index, parsed))
    if not hits:
        return None
    cluster_start = len(hits) - 1
    for index in range(len(hits) - 2, -1, -1):
        left = hits[index][1].get("index")
        right = hits[index + 1][1].get("index")
        between = normalized[hits[index][0] + 1 : hits[index + 1][0]]
        if (
            any(FOOTER.search(line) or READY.match(line) or SIMPLE_HEADER.match(line) for line in between)
            or isinstance(left, int) and isinstance(right, int) and left >= right
        ):
            break
        cluster_start = index
    cluster = hits[cluster_start:]
    if not any(option["index"] is not None for _, option in cluster):
        return None
    if sum(bool(option["current"]) for _, option in cluster) != 1:
        return None
    current_offset = next(index for index, (_, option) in enumerate(cluster) if option["current"])
    if current_offset > 0:
        previous_index = cluster[current_offset - 1][1].get("index")
        current_index = cluster[current_offset][1].get("index")
        if isinstance(previous_index, int) and isinstance(current_index, int) and previous_index >= current_index:
            cluster = cluster[current_offset:]
    first_option_index = cluster[0][0]
    open_separator = max(
        (i for i in range(first_option_index) if SEPARATOR.match(normalized[i])),
        default=-1,
    )
    prefix = normalized[open_separator + 1 : first_option_index]
    tabs: list[dict[str, Any]] = []
    tab_offset = -1
    header_offset = -1
    for offset, line in enumerate(prefix):
        match = TAB_BAR.match(line)
        if match:
            tokens = list(TAB_TOKEN.finditer(match.group(1)))
            if not tokens or TAB_TOKEN.sub("", match.group(1)).strip():
                return None
            tabs = [
                {
                    "label": token.group(2).strip(),
                    "answered": token.group(1) in {"☑", "☒"},
                    "active": False,
                }
                for token in tokens
                if token.group(2) and token.group(2).strip() != "Submit"
            ]
            tab_offset = offset
            continue
        if SIMPLE_HEADER.match(line):
            header_offset = offset
    ready_index = first_option_index - 1
    is_review = ready_index >= 0 and READY.match(normalized[ready_index]) is not None
    if is_review:
        question = normalized[ready_index]
        kind = "review"
    else:
        content_start = max(tab_offset, header_offset) + 1
        question_lines = [line.strip() for line in prefix[content_start:] if line.strip()]
        if not question_lines:
            return None
        question = " ".join(question_lines)
        if tabs:
            kind = "tabbed"
        else:
            footer_text = " ".join(normalized[footer_index : footer_index + 2])
            if footer_index < 0 or "↑/↓ to navigate" not in footer_text:
                return None
            kind = "single"
    if tabs and kind != "review":
        lower = question.lower()
        matching = [tab for tab in tabs if tab["label"].lower() in lower]
        active_label = matching[0]["label"] if len(matching) == 1 else next(
            (tab["label"] for tab in tabs if not tab["answered"]), None
        )
        for tab in tabs:
            tab["active"] = tab["label"] == active_label
    options: list[dict[str, Any]] = []
    for position, (line_index, parsed) in enumerate(cluster):
        end = cluster[position + 1][0] if position + 1 < len(cluster) else bound
        description = " ".join(
            line.strip()
            for line in normalized[line_index + 1 : end]
            if line.strip() and not SEPARATOR.match(line)
        )
        parsed["role"] = ask_role(parsed["label"])
        if description:
            parsed["description"] = description
        options.append(parsed)
    result: dict[str, Any] = {
        "kind": kind,
        "multi_select": any("checked" in option for option in options),
        "tabs": [] if kind == "single" else tabs,
        "question": question,
        "options": options,
    }
    if kind == "review":
        review_answers = parse_review_answers(normalized[open_separator + 1 : ready_index])
        if not review_answers:
            return None
        result["review_answers"] = review_answers
    elif tabs:
        result["header"] = next((tab["label"] for tab in tabs if tab["active"]), None)
    else:
        header_match = next((SIMPLE_HEADER.match(line) for line in prefix if SIMPLE_HEADER.match(line)), None)
        if header_match:
            result["header"] = header_match.group(1).strip()
    return result

def parse_review_answers(lines: Sequence[str]) -> dict[str, str]:
    answers: dict[str, str] = {}
    pending: str | None = None
    for line in lines:
        stripped = line.strip()
        inline = re.match(r"^[▪●]\s*(.+?)\s*→\s*(?:☑\s*)?(.+)$", stripped)
        if inline:
            answers[inline.group(1).strip()] = inline.group(2).strip()
            pending = None
            continue
        question = re.match(r"^[▪●]\s*(.+)$", stripped)
        if question:
            pending = question.group(1).strip()
            continue
        value = re.match(r"^→\s*(?:☑\s*)?(.+)$", stripped)
        if pending and value:
            answers[pending] = value.group(1).strip()
            pending = None
    return answers
def parse_ask_option(line: str) -> dict[str, Any] | None:
    stripped = line.lstrip()
    current = stripped.startswith("❯")
    if current:
        stripped = stripped[1:].lstrip()
    elif stripped.startswith(("▪", "●", "→")):
        return None
    match = NUMBERED.match(stripped)
    if match:
        result: dict[str, Any] = {
            "index": int(match.group(1)),
            "label": match.group(3).rstrip(),
            "current": current,
        }
        if match.group(2) is not None:
            result["checked"] = match.group(2) == "✔"
        return result
    if stripped == "Submit":
        return {"index": None, "label": "Submit", "current": current}
    return None
def ask_role(label: str) -> str:
    normalized = label.lower().rstrip(".")
    if normalized == "type something":
        return "typeSomething"
    if normalized == "chat about this":
        return "chatAbout"
    if normalized in {"submit", "submit answers"}:
        return "submit"
    return "option"

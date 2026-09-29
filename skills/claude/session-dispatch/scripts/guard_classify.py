"""Pure screen/state classification for the dispatch guard."""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from typing import Any
from dispatch_send import load_bridge

support = load_bridge()._support
def current_input_line(lines):
    # Claude renders NBSP after the prompt glyph; reuse the bridge parser after normalization.
    return support.current_input_line([line.replace("\u00a0", " ") for line in lines])
scan_ask_question = support.scan_ask_question
screen_fingerprint = support.screen_fingerprint
INPUT_LINE_PATTERNS = support.INPUT_LINE_PATTERNS
CORRUPTION = re.compile(r"(?:\x1b)?\[\d+;\d+u")
MCP = re.compile(r"\b\d+ new MCP servers found\b", re.I)
LOGIN = re.compile(
    r"^\s*(?:[>\u276f]\s*)?(?:Not logged in\b|/?login(?:\s|$)|Paste (?:the )?code\b|"
    r"Sign in\b|Log in\b|Press Enter to open\b|Authentication (?:required|failed)\b|"
    r"OAuth (?:required|login|authentication)\b)", re.I)
DENIAL = re.compile(r"^\s*(?:\u276f\s*)?(\d)\.\s*(No,?\s+and tell Claude what to do differently|No)\b", re.I)
PLACEHOLDER = re.compile(r'^(?:Try "|Ask Codex to do anything|Find and fix a bug|Implement \{feature\})', re.I)
FOOTER = re.compile(r"^\s*(?:[\u2500\u2501\u2550]{3,}|-- INSERT --|.*\u00b7 Ready$|.*\u00b7 \d+% context left$|\? for shortcuts)")

def input_body(value):
    """Trim terminal chrome from the bridge parser's wrapped input area."""
    if value is None:
        return None
    body = []
    for line in value[2].splitlines():
        if FOOTER.search(line):
            break
        body.append(line)
    text = "\n".join(body).strip()
    return "" if PLACEHOLDER.match(text) else text

def compact(text):
    return re.sub(r"\s+", "", CORRUPTION.sub("", text or ""))

def pending_matches(body, pending, input_revision=None, epoch=None):
    if not body or not pending or pending.get("origin") not in {"dispatch_send", "canary", "guard"}:
        return False
    expected = compact(pending.get("text", ""))[:40]
    if not expected or not compact(body).startswith(expected):
        return False
    for actual, key in ((input_revision, "input_revision_after"), (epoch, "session_epoch")):
        if pending.get(key) is not None and actual is not None and pending[key] != actual:
            return False
    return True

@dataclass
class Observation:
    agent_kind: str = "claude"
    is_dispatch_child: bool = False
    slug: str | None = None
    state_view: dict[str, Any] = field(default_factory=dict)
    screen_lines: list[str] = field(default_factory=list)
    input_line: Any = None
    transcript_age_s: float | None = None
    done_exists: bool = False
    pending_send: dict | None = None
    idle_since_s: float = 0
    counters: dict = field(default_factory=dict)
    present: bool = True
    pending_ask: bool = False
    screen_changed: bool = False
    unchanged_s: float = 0
    turn_ended: bool = False

@dataclass
class Verdict:
    cls: str
    action: str
    reason: str
    evidence: list[str] = field(default_factory=list)
    params: dict = field(default_factory=dict)

def classify(obs: Observation) -> Verdict:
    view = obs.state_view
    attention = view.get("attention", {}).get("kind")
    lines = obs.screen_lines[-40:]
    screen = "\n".join(lines)
    idle = obs.idle_since_s
    parsed_input = obs.input_line if obs.input_line is not None else current_input_line(lines)
    body = input_body(parsed_input)
    def verdict(cls, action="none", reason="", **params):
        evidence = lines[-12:]
        if cls in {"human_draft", "unknown", "ok_working", "ok_waiting"}:
            evidence = []
        elif cls == "login_required":
            evidence = ["Authentication prompt detected; credentials and codes withheld"]
        elif cls == "permission_prompt":
            evidence = [line for line in lines if DENIAL.match(line) or
                        re.match(r"^\s*(?:\u276f\s*)?\d\.\s*Yes", line)]
        return Verdict(cls, action, reason or cls, evidence, params)
    def limited(cls, action, limit, escalation, **params):
        if obs.counters.get(cls, 0) >= limit:
            return verdict(cls, "escalate", escalation, escalation=escalation)
        return verdict(cls, action, **params)
    if not obs.present:
        return verdict("tab_gone", "mark_lost" if obs.counters.get("missing", 0) >= 2 else "none", "guard:reconcile")
    if view.get("lifecycle") not in {None, "alive"}:
        return verdict("pty_dead", "mark_lost", "PTY lifecycle is not alive")
    # A live empty composer after old dialog output makes that output historical.
    panel = screen if parsed_input is None or body != "" else "\n".join(lines[parsed_input[0]:])
    if MCP.search(panel) and "Select any you wish to enable" in panel and "Enable selected" in panel:
        return limited("startup_dialog", "press_key", 3, "startup_stuck", key="enter")
    if ("Do you trust the files in this folder" in panel and
            re.search(r"^\s*\u276f\s*(?:1\.\s*)?Yes", panel, re.M)):
        return limited("startup_dialog", "press_key", 3, "startup_stuck", key="enter")
    if ("auto mode" in panel.lower() and "paused" not in panel.lower() and
            re.search(r"\[y/n\]|\(y/n\)", panel, re.I)):
        return limited("startup_dialog", "answer_digit", 3, "startup_stuck", digit="y")
    if "What's new" in panel and re.search(r"Press (?:Enter|enter) to continue", panel):
        return limited("startup_dialog", "press_key", 3, "startup_stuck", key="enter")
    if any(LOGIN.search(line) for line in panel.splitlines()):
        return verdict("login_required", "block", "Authentication requires a person")
    permission = ("Do you want to proceed?" in panel or
                  ("auto mode" in panel.lower() and "paused" in panel.lower()))
    ask = scan_ask_question(lines)
    if ask and not permission and not any(DENIAL.match(line) for line in lines):
        return verdict("ask_dialog", "answer_ask" if obs.is_dispatch_child else "escalate",
                       "Structured AskUserQuestion", ask=ask)
    if permission:
        denial = [DENIAL.match(line) for line in lines if DENIAL.match(line)]
        if not obs.is_dispatch_child:
            return verdict("permission_prompt", "escalate", "Manual tab requires owner")
        if len(denial) != 1:
            return verdict("permission_prompt", "escalate", "Denial option cannot be parsed")
        return limited("permission_prompt", "deny_permission", 3, "permission_loop", digit=denial[0].group(1))
    if attention in {"rate_limited", "error"}:
        return verdict(attention, "escalate" if idle >= 1800 else "none")
    # mycmux reports activity=streaming for an idle Claude tab too (the status line keeps
    # repainting), so "streaming" alone cannot mean working. The hook's attention=input
    # means Claude is waiting for a person; treat that like a transcript end_turn.
    waiting = attention == "input"
    if view.get("activity") == "streaming" and not obs.turn_ended and not waiting:
        return verdict("ok_working")
    if body:
        if pending_matches(body, obs.pending_send, view.get("input_revision"), view.get("session_epoch")):
            if idle > 60:
                return limited("draft_unsent", "deliver_pending", 2, "delivery_failed",
                               corrupted=bool(CORRUPTION.search(body)))
            return verdict("draft_unsent", reason="Machine draft is not yet idle for 60 seconds")
        return verdict("human_draft", "escalate" if idle >= 600 else "none",
                       "Unowned or externally edited draft", escalation="human_draft_idle")
    if attention == "input" and body == "":
        if obs.done_exists or obs.pending_ask or not obs.is_dispatch_child:
            return verdict("ok_waiting")
        if idle > 180 and (obs.transcript_age_s is None or obs.transcript_age_s > 180):
            if obs.counters.get("idle_no_done_age_s", 600) < 600:
                return verdict("idle_no_done", reason="Ten minute reminder cooldown")
            return limited("idle_no_done", "nudge", 2, "silent_blocker")
        return verdict("ok_waiting", reason="Within idle grace")
    if attention == "none" and obs.screen_changed:
        return verdict("ok_working")
    return verdict("unknown", "escalate" if obs.unchanged_s >= 1800 else "none",
                   "No safely parsed live prompt", escalation="unclassified_idle")

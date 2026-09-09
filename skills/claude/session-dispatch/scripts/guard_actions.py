"""Guard side effects, optimistic input guards, durable audit and local alerts."""
from __future__ import annotations
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from dataclasses import asdict

import dispatch_ledger as ledger
from dispatch_send import load_bridge, load_agent_cli, build_expectations
from guard_classify import (classify, current_input_line, input_body, pending_matches,
                           screen_fingerprint, scan_ask_question)

DEFAULT_ROOT = Path.home() / ".claude" / "dispatch" / "guard"
#: Escalations the ops entry gate refused. Written so a rejected card is
#: visible instead of silently gone; read by ~/.claude/scripts/ask-inject.py.
UNDELIVERED_NAME = "undelivered.jsonl"
#: Ceiling for any append-only file this module writes. 8 MiB is about two
#: days of the pre-fix guard.log; after the terminal gate it is months.
MAX_LOG_BYTES = 8 * 1024 * 1024
OPS = Path.home() / ".claude" / "ops" / "ops_common.py"
DENY_TEXT = "\u3053\u306e\u64cd\u4f5c\u306f\u6bcd\u8266\u306e\u627f\u8a8d\u304c\u8981\u308b\u3002\u4ee3\u66ff\u624b\u6bb5\u3067\u7d9a\u884c\u3057\u3001\u7121\u7406\u306a\u3089 DONE.md \u306e\u672a\u89e3\u6c7a\u30fb\u8981\u5224\u65ad\u306b\u66f8\u3051"
NUDGE_TEXT = "\u7d9a\u884c\u305b\u3088\u3002\u5b8c\u4e86\u306a\u3089 DONE.md\u3001\u5224\u65ad\u304c\u8981\u308b\u306a\u3089 ask \u30ab\u30fc\u30c9\u3002\u9ed9\u3063\u3066\u6b62\u307e\u308b\u306e\u306f\u5951\u7d04\u9055\u53cd"

def root_path():
    return Path(os.environ.get("DISPATCH_GUARD_DIR", str(DEFAULT_ROOT)))

def stamp():
    return datetime.now(timezone.utc).isoformat()

def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default

def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + "." + str(os.getpid()) + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    assert "\ufffd" not in tmp.read_text(encoding="utf-8")
    os.replace(tmp, path)

def rotate_if_large(path, limit=MAX_LOG_BYTES):
    """Roll a log over instead of letting it grow without bound.

    Nothing in this skill capped any file it wrote: on 2026-09-09 guard.log
    had reached 3.4 MB in a day and ledger.jsonl 4.8 MB. One generation is
    enough here -- the point is a ceiling, not history.
    """
    path = Path(path)
    try:
        if path.exists() and path.stat().st_size >= limit:
            os.replace(path, path.with_name(path.name + ".1"))
    except OSError:
        pass


def append_json_capped(path, data, keep=50):
    """Append, then keep only the newest `keep` rows.

    For files whose reader only wants the tail. once_requests.jsonl is read
    in full about twice a second by the supervisor wait loop, which only
    looks at the last row, and nothing ever trimmed it.
    """
    append_json(path, data)
    path = Path(path)
    try:
        rows = list(json_rows(path))
        if len(rows) > keep:
            tmp = path.with_name(path.name + "." + str(os.getpid()) + ".tmp")
            body = "".join(json.dumps(row, ensure_ascii=False) + chr(10) for row in rows[-keep:])
            tmp.write_text(body, encoding="utf-8", newline=chr(10))
            os.replace(tmp, path)
    except (OSError, ValueError):
        pass


def append_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    rotate_if_large(path)
    raw = (json.dumps(data, ensure_ascii=False) + "\n").encode("utf-8")
    assert b"\xef\xbf\xbd" not in raw
    # One append write; readers ignore an incomplete trailing line.
    fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)

def json_rows(path):
    try:
        with Path(path).open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                    if isinstance(row, dict):
                        yield row
                except ValueError:
                    continue
    except FileNotFoundError:
        return

def register_pending(session_id, text, *, slug=None, input_revision_after=None,
                     session_epoch=None, origin="dispatch_send", root=None, **extra):
    row = dict(id=uuid.uuid4().hex, session_id=session_id, slug=slug, text=text,
               ts=stamp(), created_at=time.time(), input_revision_after=input_revision_after,
               session_epoch=session_epoch, origin=origin, **extra)
    append_json((root or root_path()) / "pending_sends.jsonl", row)
    return row

def pending_by_session(root):
    entries = {}
    for row in json_rows(Path(root) / "pending_sends.jsonl"):
        if not row.get("session_id"):
            continue
        if row.get("resolved_id"):
            previous = entries.get(row["session_id"])
            if previous and previous.get("id") == row["resolved_id"]:
                entries.pop(row["session_id"], None)
        elif row.get("text"):
            entries[row["session_id"]] = row
    return entries

def resolve_pending(root, pending, reason):
    append_json(Path(root) / "pending_sends.jsonl", {
        "session_id": pending["session_id"], "resolved_id": pending["id"],
        "ts": stamp(), "reason": reason})

def observe_delivery(bridge, session, baseline, *, transcript_mtime=None,
                     before_mtime=None, timeout=20, sleep=time.sleep, clock=time.monotonic):
    start = clock()
    initial = load_bridge().state_transition_signature(baseline)
    epoch = baseline.get("view", {}).get("session_epoch")
    last = {"delivered_confirmed": False, "reason": "No empty composer and transition observed"}
    while True:
        try:
            state = bridge.status(session)
            if state["view"].get("session_epoch") != epoch:
                return {"delivered_confirmed": False, "reason": "Session epoch changed"}
            lines = bridge.read(session, lines=40)["lines"]
            empty = input_body(current_input_line(lines)) == ""
            transition = load_bridge().state_transition_signature(state) != initial
            mtime = transcript_mtime() if transcript_mtime else None
            growth = mtime is not None and (before_mtime is None or mtime > before_mtime)
            last = {"delivered_confirmed": empty and (transition or growth),
                    "input_empty": empty, "state_transition": transition, "transcript_growth": growth,
                    "input_revision_after": state.get("input_revision"),
                    "session_epoch": state["view"].get("session_epoch")}
            if last["delivered_confirmed"]:
                return last
        except (RuntimeError, OSError, KeyError):
            pass
        if clock() - start >= timeout:
            return last
        sleep(min(0.5, max(0, timeout - (clock() - start))))

def hidden_kwargs():
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

def toast(cls):
    # Text is XML escaped by using a fixed safe class identifier only.
    safe = "".join(c for c in cls if c.isalnum() or c in "_-")
    code = r"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Dispatch guard</text><text>CLASS needs attention</text></binding></visual></toast>')
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DispatchGuard').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
""".replace("CLASS", safe)
    try:
        return subprocess.run(["powershell", "-NoProfile", "-EncodedCommand",
            base64.b64encode(code.encode("utf-16-le")).decode("ascii")],
            capture_output=True, timeout=5, **hidden_kwargs()).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False

class Actions:
    def __init__(self, bridge, *, root=None, ledger_path=ledger.DEFAULT_LEDGER,
                 input_scope="all", alert=None, now=time.time):
        self.bridge = bridge
        self.root = Path(root or root_path())
        self.ledger_path = Path(ledger_path)
        self.input_scope = input_scope
        self.alert = alert
        self.now = now
        self.dispatch = None
        self.session = None
        self.expected_observation = None
        self.lease_check = lambda: True
        self.alert_queue = []

    def begin_cycle(self):
        self.alert_queue = []

    def audit(self, event, **details):
        """Guard trail goes to guard.log only.

        It used to be mirrored into the dispatch ledger, which made the guard
        feed the file it re-parses every cycle: 6,829 of 7,687 rows on
        2026-09-09 were guard audit rows. Worse than the size, the mirrored
        rows changed what the ledger says about a session -- both
        ask-inject.py and dispatch-child-guard.py decide "is this a dispatch
        child" from the last status seen for a pane session id, so a
        fallback-inline audit row could make a live child read as not-a-child.
        State transitions still go to the ledger; they are written explicitly
        by mark_lost and by the reconcile branch in dispatch_guard.py.
        """
        row = dict(ts=stamp(), at=self.now(), session_id=self.session,
                   slug=self.dispatch.slug if self.dispatch else None, event=event, **details)
        append_json(self.root / "guard.log", row)
        return row

    def allowed(self):
        return self.lease_check() and (self.input_scope == "all" or bool(self.dispatch and self.dispatch.get("guard_canary")))

    def validate_screen(self, session):
        state = self.bridge.status(session)
        lines = self.bridge.read(session, lines=40)["lines"]
        if self.expected_observation is not None:
            old = self.expected_observation
            if (old.state_view.get("session_epoch") != state["view"].get("session_epoch")
                or old.state_view.get("input_revision") != state.get("input_revision")
                or old.state_view.get("session_revision") != state["view"].get("session_revision")
                or old.state_view.get("attention", {}).get("attention_id") != state["view"].get("attention", {}).get("attention_id")
                or screen_fingerprint(old.screen_lines) != screen_fingerprint(lines)):
                raise RuntimeError("Screen, epoch or input changed before action")
        return state, lines

    def guarded_write(self, session, *, key=None, text="", expected_state=None):
        if not self.allowed():
            raise RuntimeError("Input disabled outside acceptance canaries")
        state = self.bridge.status(session)
        if expected_state is not None:
            for name in ("session_epoch", "session_revision"):
                if state["view"].get(name) != expected_state["view"].get(name):
                    raise RuntimeError("Canonical state changed before write")
            if state.get("input_revision") != expected_state.get("input_revision"):
                raise RuntimeError("Input changed before write")
            if state["view"].get("attention") != expected_state["view"].get("attention"):
                raise RuntimeError("Attention changed before write")
        exp = build_expectations({"sessions": [state]}, session)
        args = {"sessionId": session, "text": text, "enter": False,
                "expectedSessionEpoch": exp["expect_epoch"],
                "expectedAttentionId": exp["expect_attention_id"],
                "expectedSessionRevision": exp["expect_revision"],
                "expectedInputRevision": exp["expect_input_revision"]}
        if key:
            args["key"] = key
        self.audit("guard:input-request", kind="key" if key else "text",
                   key=key, text=text, expectations=exp)
        result = self.bridge.request("pane.send_text", args)
        self.audit("guard:input-result", result=result)
        return result

    def press_key(self, session, key):
        state, _ = self.validate_screen(session)
        return self.guarded_write(session, key=key, expected_state=state)

    def answer_digit(self, session, n):
        if str(n) not in list("123456789y"):
            raise ValueError("Expected one digit or startup y")
        state, _ = self.validate_screen(session)
        return self.guarded_write(session, text=str(n), expected_state=state)

    def audited_bridge(self):
        original = self.bridge.request
        writes = []
        def request(cmd, args):
            if cmd == "pane.send_text":
                if not self.allowed():
                    raise RuntimeError("Input disabled outside acceptance canaries")
                # Bridge supplies all four on every constituent write, including multiSelect.
                assert all(k in args for k in ("expectedSessionEpoch", "expectedAttentionId",
                           "expectedSessionRevision", "expectedInputRevision"))
                self.audit("guard:input-request", kind="key" if args.get("key") else "text",
                           key=args.get("key"), text=args.get("text"), expectations=args)
                attempt = {"payload": dict(args)}
                writes.append(attempt)
                result = original(cmd, args)
                attempt["response"] = result
                self.audit("guard:input-result", result=result)
                return result
            return original(cmd, args)
        bridge = load_bridge().Bridge(request)
        bridge.guard_writes = writes
        return bridge

    def send_text(self, session, text):
        state, lines = self.validate_screen(session)
        if input_body(current_input_line(lines)) != "":
            raise RuntimeError("No empty, identifiable input area")
        bridge = self.audited_bridge()
        result = bridge.send(text, session_id=session, expected_state=state,
            expected_attention=state["view"]["attention"]["kind"])
        owned = [w for w in bridge.guard_writes if w["payload"].get("text") and
                 w.get("response", {}).get("sent") is not False and
                 w.get("response", {}).get("ok") is not False]
        if owned and result.get("result") != "observed_delivered":
            last = bridge.guard_writes[-1]
            revision = last["payload"]["expectedInputRevision"] + (
                0 if last.get("response", {}).get("sent") is False else 1)
            register_pending(session, text, slug=self.dispatch.slug if self.dispatch else None,
                origin="guard", root=self.root, input_revision_after=revision,
                session_epoch=state["view"]["session_epoch"], baseline=state)
            result["guard_pending"] = True
        return result

    def escalate(self, session, cls, detail):
        previous = [r for r in json_rows(self.root / "escalations.jsonl")
                    if r.get("session_id") == session and r.get("cls") == cls]
        if previous and self.now() - previous[-1].get("at", 0) < 1800:
            return {"escalated": False, "deduplicated": True}
        row = dict(ts=stamp(), at=self.now(), session_id=session, cls=cls,
                   slug=self.dispatch.slug if self.dispatch else "manual-" + session[-8:],
                   detail=detail, dispatch=self.dispatch)
        # Reserve each event durably; the cycle has exactly one grouped card.
        append_json(self.root / "escalations.jsonl", {k: v for k, v in row.items() if k != "dispatch"})
        self.alert_queue.append(row)
        return {"escalation_queued": True}

    def flush_escalations(self):
        queue, self.alert_queue = self.alert_queue, []
        if not queue:
            return {"cards": 0, "events": 0}
        if not self.lease_check():
            return {"cards": 0, "events": len(queue), "suppressed": "lease_changed"}
        first = queue[0]
        cls = first["cls"]
        summary = ", ".join(f"{row['slug']} ({row['cls']})" for row in queue[:3])
        if len(queue) > 3:
            summary += f"; 他 {len(queue) - 3} 件は guard/escalations.jsonl"
        evidence = first["detail"].replace("\n", " ")[:36]
        detail = f"{len(queue)} 件: " + summary + f" / {evidence}"
        # ops_common の ask 検証は「。？? の合計 <= 1 かつ末尾が疑問符」。句点を挟むと
        # question_sentences で弾かれて enqueue exit=2 になる (2026-09-08 に 52 件全滅)。
        question = f"{first['slug'][:32]} の {cls} をどうしますか？"
        labels = (["台帳を lost にする", "放置"] if cls in {"tab_gone", "pty_dead"} else
                  ["認証を確認する", "保留する"] if cls == "login_required" else
                  ["入力内容を確認", "書きかけを保持"] if cls == "human_draft_idle" else
                  ["停滞箇所を確認", "保留する"])
        card = {
            "title": "guard: " + cls + (f" +{len(queue)-1}" if len(queue) > 1 else ""),
            "question": question[:120], "detail": detail,
            "options": [{"label": label, "recommended": i == 0} for i, label in enumerate(labels)],
            "recommendation_reason": "自動回復ができない状態のため",
            "blocking_reason": "人の判断が必要なため",
            "decision_class": "owner_judgment"}
        path = None
        if self.alert is not None:
            result = self.alert(card)
        else:
            path = self.root / ("card-" + uuid.uuid4().hex + ".json")
            atomic_json(path, card)
            try:
                proc = subprocess.run([sys.executable, "-X", "utf8", str(OPS), "enqueue",
                    "--kind", "ask", "--source", "guard:" + cls, "--session-id", first["session_id"],
                     "--dispatch-slug", first["slug"] if first["dispatch"] else "-", "--card-file", str(path)],
                    capture_output=True, text=True, encoding="utf-8", timeout=10, **hidden_kwargs())
                result = {"enqueue_exit": proc.returncode, "output": (proc.stdout + proc.stderr)[-1000:],
                          "toast": toast(cls)}
            except (OSError, subprocess.TimeoutExpired):
                result = {"enqueue_exit": None, "error": "Local alert invocation unavailable",
                          "toast": toast(cls)}
        if result.get("enqueue_exit") == 0:
            if path is not None:
                path.unlink(missing_ok=True)
        else:
            # A rejected card used to be dropped here: the exit code went into the
            # audit trail and nothing read it. Between 2026-09-08 11:07 and
            # 2026-09-09 04:03 that lost 51 escalations to one validator rule, so
            # no stall reached a human at all. Spool it instead; ask-inject
            # surfaces the spool at the start of the next mothership turn.
            append_json(self.root / UNDELIVERED_NAME, {
                "ts": stamp(), "at": self.now(), "cls": cls,
                "session_id": first["session_id"], "slug": first["slug"],
                "enqueue_exit": result.get("enqueue_exit"),
                "output": result.get("output") or result.get("error"),
                "card_file": str(path) if path else None, "card": card})
        previous_session, previous_dispatch = self.session, self.dispatch
        self.session, self.dispatch = first["session_id"], first["dispatch"]
        self.audit("guard:escalate-batch", cls=cls, events=len(queue), card=card, result=result)
        self.session, self.dispatch = previous_session, previous_dispatch
        return {"cards": 1, "events": len(queue), "result": result}

    def mark_lost(self, slug, reason):
        if self.dispatch:
            ledger.update_record(self.ledger_path, slug=slug, spawn_ts=self.dispatch.spawn_ts,
                tab_session_id=self.session, status="lost", event="guard:reconcile", reason=reason)
        return self.escalate(self.session, "tab_gone", reason)

    def execute(self, session, verdict, obs, dispatch=None):
        self.session, self.dispatch, self.expected_observation = session, dispatch, obs
        action = verdict.action
        if action == "none":
            return {"action": "none"}
        input_actions = {"press_key", "answer_digit", "answer_ask", "deny_permission", "deliver_pending", "nudge", "permission_instruction"}
        if action in input_actions and not self.allowed():
            return {"action": action, "suppressed": "acceptance_canaries_only"}
        self.audit("guard:action", verdict=asdict(verdict))
        try:
            if action == "press_key":
                result = self.press_key(session, verdict.params["key"])
            elif action == "answer_digit":
                result = self.answer_digit(session, verdict.params["digit"])
            elif action == "answer_ask":
                _, lines = self.validate_screen(session)
                ask = scan_ask_question(lines)
                if not ask:
                    raise RuntimeError("Question no longer parses")
                if ask["kind"] == "review":
                    result = self.answer_digit(session, 1)
                else:
                    option = next(o for o in ask["options"] if o["role"] == "option")
                    self.audit("guard:ask-choice", question=ask["question"], selected=option["label"])
                    if ask["multi_select"]:
                        result = self.audited_bridge().answer_ask(session, {ask["question"]: [option["index"]]})
                    else:
                        result = self.answer_digit(session, option["index"])
            elif action == "deny_permission":
                result = self.answer_digit(session, verdict.params["digit"])
                self.expected_observation = None
                # Only send the instruction after observing the denial's empty input area.
                for _ in range(10):
                    lines = self.bridge.read(session, lines=40)["lines"]
                    if input_body(current_input_line(lines)) == "" and "Do you want to proceed?" not in "\n".join(lines[-8:]):
                        result = {"denial": result, "instruction": self.send_text(session, DENY_TEXT)}
                        break
                    time.sleep(0.2)
                else:
                    result = {"denial": result, "instruction": "Input not observed; no text sent", "instruction_pending": True}
            elif action == "deliver_pending":
                state, lines = self.validate_screen(session)
                pending = obs.pending_send
                from dispatch_guard import transcript_path
                log_path = transcript_path(dispatch, {"agent_kind": obs.agent_kind})
                def transcript_mtime():
                    return log_path.stat().st_mtime if log_path and log_path.is_file() else None
                before_mtime = transcript_mtime()
                if not pending_matches(input_body(current_input_line(lines)), pending,
                                       state.get("input_revision"), state["view"].get("session_epoch")):
                    raise RuntimeError("Machine draft provenance changed")
                if verdict.params["corrupted"]:
                    result = self.guarded_write(session, text="\x15", expected_state=state)
                    self.expected_observation = None
                    time.sleep(0.2)
                    after_clear = self.bridge.status(session)
                    if (after_clear.get("input_revision") != state["input_revision"] + 1 or
                            after_clear["view"].get("session_epoch") != state["view"].get("session_epoch")):
                        raise RuntimeError("External input after clearing; no re-paste")
                    cleared = self.bridge.read(session, lines=40)["lines"]
                    if input_body(current_input_line(cleared)) != "":
                        raise RuntimeError("Ctrl-U did not clear the known machine draft")
                    if obs.agent_kind == "claude":
                        result = self.guarded_write(session,
                            text="\x1b[200~" + pending["text"] + "\x1b[201~", expected_state=after_clear)
                        time.sleep(0.2)
                        pasted = self.bridge.status(session)
                        pasted_lines = self.bridge.read(session, lines=40)["lines"]
                        if (pasted.get("input_revision") != after_clear["input_revision"] + 1 or
                                pasted["view"].get("session_epoch") != after_clear["view"].get("session_epoch") or
                                not pending_matches(input_body(current_input_line(pasted_lines)),
                                                    dict(pending, input_revision_after=None))):
                            raise RuntimeError("Re-paste did not stabilize as the owned draft")
                        state = pasted
                        result = self.guarded_write(session, key="enter", expected_state=state)
                    else:
                        result = self.send_text(session, pending["text"])
                else:
                    result = self.guarded_write(session, key="enter", expected_state=state)
                observed = observe_delivery(self.bridge, session, state,
                    transcript_mtime=transcript_mtime, before_mtime=before_mtime)
                if observed["delivered_confirmed"]:
                    resolve_pending(self.root, pending, "delivered_confirmed")
                else:
                    updated = dict(pending, **{k: observed[k] for k in
                        ("input_revision_after", "session_epoch") if k in observed})
                    append_json(self.root / "pending_sends.jsonl", updated)
                result = {"write": result, **observed}
            elif action == "permission_instruction":
                result = self.send_text(session, DENY_TEXT)
            elif action == "nudge":
                result = self.send_text(session, NUDGE_TEXT)
            elif action == "mark_lost":
                result = self.mark_lost(obs.slug, verdict.reason)
            else:
                if action == "block" and dispatch and dispatch.status != "blocked":
                    ledger.update_record(self.ledger_path, slug=dispatch.slug,
                        spawn_ts=dispatch.spawn_ts, tab_session_id=session,
                        status="blocked", event="guard:auth-blocked")
                result = self.escalate(session, verdict.params.get("escalation", verdict.cls), verdict.reason)
        except (RuntimeError, OSError, ValueError, KeyError, StopIteration) as exc:
            result = {"observed": False, "error": type(exc).__name__ + ": " + str(exc)[:200]}
        self.audit("guard:action-result", action=action, result=result)
        return result

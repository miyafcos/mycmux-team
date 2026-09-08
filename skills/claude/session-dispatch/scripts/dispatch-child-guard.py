"""PreToolUse hook: a dispatch child session must never block on a human dialog.

Denies AskUserQuestion / EnterPlanMode / ExitPlanMode when the current session is
a dispatch child (its pane session id is on an active row of the dispatch ledger).
The child is told to pick the recommended option itself, record the assumption in
DONE.md, and to use the ask-card contract only for genuinely blocking decisions.

Who is a child is decided from the ledger alone (same closed set as
dispatch_ledger; rows without a status count as a child, fail-closed, exactly like
ask-inject.py). Here the failure direction is the opposite on purpose: any error
=> allow (exit 0). A wrong deny in the mothership would block the person's own
question; a missed deny in a child is caught by the always-on dispatch guard, which
answers the dialog from the screen.

settings.json wiring (hooks.PreToolUse):
  {"matcher": "AskUserQuestion|EnterPlanMode|ExitPlanMode",
   "hooks": [{"type": "command", "timeout": 5,
              "command": "python -X utf8 <this file>"}]}

Contract: exit 2 + stderr message = deny (Claude Code shows the message to the
model). exit 0 = allow. Never prints to stdout. `DISPATCH_LEDGER` overrides the
ledger path (tests).
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
DEFAULT_LEDGER = Path.home() / ".claude" / "dispatch" / "ledger.jsonl"
LOG_PATH = Path.home() / ".claude" / "dispatch" / "guard" / "child-guard.jsonl"
BLOCKED_TOOLS = frozenset({"AskUserQuestion", "EnterPlanMode", "ExitPlanMode"})
# Ledger keys that carry a child's pane session id (snake and camel spellings).
CHILD_SESSION_KEYS = ("tab_session_id", "tabSessionId")

try:  # single source of truth when the skill is installed as a whole
    sys.path.insert(0, str(SCRIPTS_DIR))
    from dispatch_ledger import INACTIVE_STATUSES as _INACTIVE  # type: ignore
    INACTIVE_STATUSES = frozenset(_INACTIVE)
except Exception:  # pragma: no cover - hook must never fail on import
    INACTIVE_STATUSES = frozenset(
        {"closed", "done-verified-closed", "abandoned", "fallback-inline", "lost"}
    )

DENY_MESSAGE = (
    "[dispatch-child-guard] この dispatch 子セッションでは {tool} を使えません (母艦の機械ガード)。\n"
    "可逆な判断は推奨案を自分で選んで続行し、DONE.md の「未解決・要判断」に"
    "「仮定: <選んだ案> (理由)」を残す。\n"
    "作業が本当に進められない (external_commit / requirement_conflict / scope_change / "
    "irreversible / owner_judgment / permission_safety) ときだけ、"
    "references/ask-card-contract.md の型で判断カードを enqueue して待機する。\n"
    "黙って止まるのは契約違反。plan モードも不要 — spec の境界内で直接実装する。"
)


def ledger_path() -> Path:
    override = os.environ.get("DISPATCH_LEDGER")
    return Path(override).expanduser() if override else DEFAULT_LEDGER


def load_jsonl(path: Path) -> list[dict]:
    records: list[dict] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict):
                    records.append(record)
    except OSError:
        return []
    return records


def record_session_ids(record: dict) -> set[str]:
    ids: set[str] = set()
    for key in CHILD_SESSION_KEYS:
        value = record.get(key)
        if isinstance(value, str) and value:
            ids.add(value)
    return ids


def latest_status_for_session(records: list[dict], pane_session_id: str) -> str | None:
    """Last status on rows naming this exact pane session id; None if never seen.

    Grouping is per session id, never per slug: a same-named dispatch from another
    day must not decide this tab's status. A known id whose rows carry no status
    counts as a child (fail-closed, same rule as ask-inject.py).
    """
    status: str | None = None
    seen = False
    for record in records:
        if pane_session_id not in record_session_ids(record):
            continue
        seen = True
        value = record.get("status")
        if isinstance(value, str) and value:
            status = value
    if not seen:
        return None
    return status or ""


def is_dispatch_child(pane_session_id: str, path: Path | None = None) -> bool:
    if not pane_session_id:
        return False
    status = latest_status_for_session(load_jsonl(path or ledger_path()), pane_session_id)
    if status is None:
        return False
    return status not in INACTIVE_STATUSES


def decide(tool_name: str, pane_session_id: str, path: Path | None = None) -> tuple[int, str]:
    """Return (exit_code, message). 2 = deny, 0 = allow."""
    if tool_name not in BLOCKED_TOOLS:
        return 0, ""
    if not pane_session_id:
        return 0, ""
    if not is_dispatch_child(pane_session_id, path):
        return 0, ""
    return 2, DENY_MESSAGE.format(tool=tool_name)


def log_event(decision: str, tool_name: str, pane_session_id: str, payload: dict[str, Any]) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "decision": decision,
            "tool": tool_name,
            "pane_session_id": pane_session_id,
            "claude_session_id": payload.get("session_id"),
            "cwd": payload.get("cwd"),
        }
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    if "--self-test" in argv:
        return self_test()
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
        tool_name = str(payload.get("tool_name") or "")
        pane_session_id = os.environ.get("MYCMUX_PANE_SESSION_ID", "")
        code, message = decide(tool_name, pane_session_id)
    except Exception:
        return 0  # fail-open: never block a person's own dialog because of a guard bug
    if code == 2:
        log_event("deny", tool_name, pane_session_id, payload)
        print(message, file=sys.stderr)
    return code


def self_test() -> int:
    import tempfile

    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        ledger = Path(tmp) / "ledger.jsonl"
        rows = [
            {"slug": "260908-open", "status": "open", "tab_session_id": "pty-open"},
            {"slug": "260908-closed", "status": "closed", "tab_session_id": "pty-closed"},
            {"slug": "260908-lost", "status": "lost", "tab_session_id": "pty-lost"},
            {"slug": "260908-nostatus", "tab_session_id": "pty-nostatus"},
        ]
        ledger.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
        cases = [
            ("child open + AskUserQuestion", "AskUserQuestion", "pty-open", 2),
            ("child open + ExitPlanMode", "ExitPlanMode", "pty-open", 2),
            ("child open + EnterPlanMode", "EnterPlanMode", "pty-open", 2),
            ("child open + Bash (not guarded)", "Bash", "pty-open", 0),
            ("closed dispatch", "AskUserQuestion", "pty-closed", 0),
            ("lost dispatch (tab gone)", "AskUserQuestion", "pty-lost", 0),
            ("row without status (fail-closed => child)", "AskUserQuestion", "pty-nostatus", 2),
            ("unknown session (mothership)", "AskUserQuestion", "pty-unknown", 0),
            ("no pane session id", "AskUserQuestion", "", 0),
        ]
        for name, tool, sid, expected in cases:
            code, _ = decide(tool, sid, ledger)
            ok = code == expected
            failures += 0 if ok else 1
            print(f"{'PASS' if ok else 'FAIL'}  {name}  exit={code} (expected {expected})")
    print(f"self-test: {'ALL PASS' if failures == 0 else f'{failures} FAIL'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

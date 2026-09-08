"""dispatch-child-guard.py の契約テスト: 子セッションでは AskUserQuestion / plan モードを deny する."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

GUARD_PATH = Path(__file__).resolve().parent.parent / "dispatch-child-guard.py"


def load_guard() -> ModuleType:
    spec = importlib.util.spec_from_file_location("dispatch_child_guard_under_test", GUARD_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def guard() -> ModuleType:
    return load_guard()


@pytest.fixture()
def ledger(tmp_path: Path) -> Path:
    rows = [
        {"slug": "260908-open", "status": "open", "tab_session_id": "pty-open"},
        {"slug": "260908-running", "status": "running", "tab_session_id": "pty-running"},
        {"slug": "260908-blocked", "status": "blocked", "tab_session_id": "pty-blocked"},
        {"slug": "260908-closed", "status": "closed", "tab_session_id": "pty-closed"},
        {"slug": "260908-lost", "status": "lost", "tab_session_id": "pty-lost"},
        {"slug": "260908-abandoned", "status": "abandoned", "tab_session_id": "pty-abandoned"},
        {"slug": "260908-nostatus", "tab_session_id": "pty-nostatus"},
    ]
    path = tmp_path / "ledger.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


@pytest.mark.parametrize("tool", ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"])
@pytest.mark.parametrize("session", ["pty-open", "pty-running", "pty-blocked", "pty-nostatus"])
def test_active_child_is_denied(guard: ModuleType, ledger: Path, tool: str, session: str) -> None:
    code, message = guard.decide(tool, session, ledger)
    assert code == 2
    assert tool in message
    assert "ask-card-contract" in message


@pytest.mark.parametrize("session", ["pty-closed", "pty-lost", "pty-abandoned", "pty-mothership", ""])
def test_non_child_is_allowed(guard: ModuleType, ledger: Path, session: str) -> None:
    code, message = guard.decide("AskUserQuestion", session, ledger)
    assert code == 0
    assert message == ""


def test_other_tools_are_never_touched(guard: ModuleType, ledger: Path) -> None:
    for tool in ("Bash", "Edit", "Agent", "Skill", ""):
        assert guard.decide(tool, "pty-open", ledger) == (0, "")


def test_missing_ledger_allows(guard: ModuleType, tmp_path: Path) -> None:
    assert guard.decide("AskUserQuestion", "pty-open", tmp_path / "missing.jsonl") == (0, "")


def test_inactive_set_matches_ledger_module(guard: ModuleType) -> None:
    import dispatch_ledger

    assert guard.INACTIVE_STATUSES == dispatch_ledger.INACTIVE_STATUSES


def run_hook(ledger: Path, session: str, tool: str = "AskUserQuestion") -> subprocess.CompletedProcess:
    env = dict(os.environ, MYCMUX_PANE_SESSION_ID=session, DISPATCH_LEDGER=str(ledger))
    payload = json.dumps({"tool_name": tool, "tool_input": {"questions": []}})
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(GUARD_PATH)],
        input=payload.encode("utf-8"),
        capture_output=True,
        env=env,
        timeout=30,
    )


def test_cli_denies_child_via_stdin_and_env(ledger: Path) -> None:
    """End-to-end: the hook process reads the payload from stdin and the pane id from env."""
    proc = run_hook(ledger, "pty-open")
    assert proc.returncode == 2, proc.stderr.decode("utf-8", "replace")
    assert "AskUserQuestion" in proc.stderr.decode("utf-8", "replace")
    assert proc.stdout == b""

    proc = run_hook(ledger, "pty-closed")
    assert proc.returncode == 0
    assert proc.stdout == b""


def test_self_test_passes() -> None:
    proc = subprocess.run(
        [sys.executable, "-X", "utf8", str(GUARD_PATH), "--self-test"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "ALL PASS" in proc.stdout

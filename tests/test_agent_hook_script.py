from __future__ import annotations

import json
import os
import select
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
HOOK_SCRIPT = REPO_ROOT / "src-tauri" / "hooks" / "mycmux_hook.py"


def run_hook(
    runtime: Path,
    stdin: str,
    *,
    cap: str | None,
    event_kind: str = "turn_ended",
    provider: str = "codex",
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["MYCMUX_RUNTIME_DIR"] = str(runtime)
    if cap is None:
        env.pop("MYCMUX_HOOK_CAP", None)
    else:
        env["MYCMUX_HOOK_CAP"] = cap
    return subprocess.run(
        [
            sys.executable,
            str(HOOK_SCRIPT),
            "--provider",
            provider,
            "--event-kind",
            event_kind,
        ],
        input=stdin,
        env=env,
        capture_output=True,
        text=True,
        timeout=2,
        check=False,
    )


def assert_silent_success(result: subprocess.CompletedProcess[str], cap: str | None) -> None:
    assert result.returncode == 0
    assert result.stdout == ""
    assert result.stderr == ""
    if cap is not None:
        assert cap not in result.stdout
        assert cap not in result.stderr


def test_missing_capability_is_a_silent_noop(tmp_path: Path) -> None:
    assert_silent_success(run_hook(tmp_path, "not even json", cap=None), None)


def test_malformed_input_is_a_silent_noop(tmp_path: Path) -> None:
    assert_silent_success(run_hook(tmp_path, "not json", cap="secret-cap"), "secret-cap")


def test_refused_connection_is_fast_and_silent(tmp_path: Path) -> None:
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    listener.close()
    (tmp_path / "mycmux.port").write_text(str(port), encoding="utf-8")
    started = time.monotonic()
    result = run_hook(tmp_path, '{"session_id":"session-a"}', cap="secret-cap")
    elapsed = time.monotonic() - started
    assert_silent_success(result, "secret-cap")
    assert elapsed < 1.0


@pytest.mark.parametrize(("provider", "event_kind", "extra", "wire_kind"), [
    ("codex", "turn_ended", {}, "turn_ended"),
    *[("claude", "attention_required", {"notification_type": kind}, "attention_required") for kind in (
        "permission_prompt", "elicitation_dialog", "elicitation_url_dialog",
        "agent_needs_input", "future_notification", None,
    )],
    ("claude", "attention_required", {"hook_event_name": "PermissionRequest"}, "attention_required"),
    ("claude", "pre_tool_use", {"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion"}, "attention_required"),
    *[("claude", "pre_tool_use", {"hook_event_name": "PreToolUse", "tool_name": tool}, "turn_active") for tool in (
        "Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit",
        "WebFetch", "WebSearch", "Agent", "Skill",
    )],
    ("claude", "turn_active", {"hook_event_name": "PostToolUse", "tool_name": "AskUserQuestion"}, "turn_active"),
    ("claude", "turn_ended", {"notification_type": "idle_prompt"}, "turn_ended"),
])
def test_health_then_observe_reaches_the_socket(
    tmp_path: Path, provider: str, event_kind: str, extra: dict[str, object], wire_kind: str,
) -> None:
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(2)
    (tmp_path / "mycmux.port").write_text(
        str(listener.getsockname()[1]), encoding="utf-8"
    )
    requests: list[dict[str, object]] = []
    error: list[BaseException] = []

    def serve() -> None:
        try:
            connection, _ = listener.accept()
            with connection, connection.makefile("rwb") as stream:
                for index in (1, 2):
                    request = json.loads(stream.readline())
                    requests.append(request)
                    result = (
                        {"protocol_major": 1, "protocol_minor": 0}
                        if index == 1
                        else {"accepted": True}
                    )
                    stream.write(
                        json.dumps(
                            {"id": index, "ok": True, "result": result},
                            separators=(",", ":"),
                        ).encode("utf-8")
                        + b"\n"
                    )
                    stream.flush()
        except BaseException as exc:
            error.append(exc)

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    result = run_hook(
        tmp_path,
        json.dumps({"session_id": "session-a", "turn_id": "turn-a", "event_id": "event-a", **extra}),
        cap="secret-cap",
        provider=provider,
        event_kind=event_kind,
    )
    thread.join(timeout=3)
    listener.close()
    assert not error
    assert not thread.is_alive()
    assert_silent_success(result, "secret-cap")
    assert [request["cmd"] for request in requests] == ["hook.health", "hook.observe"]
    assert requests[0]["hook_cap"] == "secret-cap"
    assert requests[1]["body"] == {
        "event_kind": wire_kind,
        "provider_session_id": "session-a",
        "provider_turn_id": "turn-a",
        "source_event_id": "event-a",
        "provider": provider,
    }


@pytest.mark.parametrize(("event_kind", "extra"), [
    *[("attention_required", {"notification_type": kind}) for kind in (
        "idle_prompt", "auth_success", "elicitation_complete", "elicitation_response",
        "agent_completed", "quota_auto_resume_fired", "quota_auto_resume_stale",
        "quota_auto_resume_disabled",
    )],
    *[("pre_tool_use", {"hook_event_name": "PreToolUse", "tool_name": tool}) for tool in (
        "Read", "UnknownTool", "", None, ["Bash"],
    )],
    ("pre_tool_use", {"hook_event_name": "PreToolUse"}),
])
def test_filtered_events_do_not_connect(
    tmp_path: Path, event_kind: str, extra: dict[str, object],
) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        (tmp_path / "mycmux.port").write_text(str(listener.getsockname()[1]), encoding="utf-8")
        result = run_hook(
            tmp_path,
            json.dumps({"session_id": "session-a", **extra}),
            cap="secret-cap",
            event_kind=event_kind,
            provider="claude",
        )
        assert_silent_success(result, "secret-cap")
        assert not select.select([listener], [], [], 0)[0], "filtered hook opened a socket"

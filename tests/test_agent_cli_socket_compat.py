from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).parents[1]
CLI_SCRIPT = REPO_ROOT / "scripts" / "mycmux_agent_cli.py"


def _serve_one_request(
    listener: socket.socket,
    reply: bytes,
    received: list[bytes],
    errors: list[BaseException],
) -> threading.Thread:
    """Accept one CLI connection, record its request line, answer with `reply`."""

    def serve() -> None:
        try:
            connection, _ = listener.accept()
            with connection:
                request = bytearray()
                while b"\n" not in request:
                    chunk = connection.recv(4096)
                    if not chunk:
                        raise AssertionError("CLI closed before request newline")
                    request.extend(chunk)
                received.append(bytes(request))
                connection.sendall(reply)
        except BaseException as error:  # pragma: no cover - re-raised by caller
            errors.append(error)
        finally:
            listener.close()

    server = threading.Thread(target=serve, daemon=True)
    server.start()
    return server


def _run_cli(tmp_path: Path, argv: list[str]) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    # A real mycmux pane injects MYCMUX_RUNTIME_DIR; without stripping it the
    # CLI under test would talk to the live app socket instead of the fake
    # server behind the tmp_path HOME.
    env.pop("MYCMUX_RUNTIME_DIR", None)
    env["HOME"] = str(tmp_path)
    env["USERPROFILE"] = str(tmp_path)
    env["PYTHONUTF8"] = "1"
    return subprocess.run(
        [sys.executable, str(CLI_SCRIPT), *argv],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=10,
        check=False,
    )


def _run_with_replies(
    tmp_path: Path, argv: list[str], replies: list[dict[str, object]],
) -> tuple[subprocess.CompletedProcess[str], list[dict[str, object]]]:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(len(replies))
    listener.settimeout(5)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(str(listener.getsockname()[1]), encoding="utf-8")
    requests: list[dict[str, object]] = []
    errors: list[BaseException] = []

    def serve() -> None:
        try:
            for reply in replies:
                connection, _ = listener.accept()
                with connection:
                    request = bytearray()
                    while b"\n" not in request:
                        chunk = connection.recv(4096)
                        if not chunk:
                            raise AssertionError("CLI closed before request newline")
                        request.extend(chunk)
                    requests.append(json.loads(request))
                    connection.sendall((json.dumps(reply) + "\n").encode("utf-8"))
        except BaseException as error:
            errors.append(error)
        finally:
            listener.close()

    server = threading.Thread(target=serve, daemon=True)
    server.start()
    result = _run_cli(tmp_path, argv)
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]
    return result, requests


def test_version_queries_system_version_once(tmp_path: Path) -> None:
    version = {"app_version": "0.79.1", "capabilities": ["state_view.input_revision_nullable"]}
    result, requests = _run_with_replies(
        tmp_path, ["version"], [{"id": 0, "result": version, "error": None}],
    )
    assert result.returncode == 0
    assert requests == [{"cmd": "system.version", "args": {}}]
    assert json.loads(result.stdout) == version


def test_hooks_status_requires_capability_then_reads_only(tmp_path: Path) -> None:
    snapshot = {"version": 2, "providers": [{"provider": "grok", "enabled": True,
                "state": "needs-repair", "reason": "duplicate"}]}
    result, requests = _run_with_replies(tmp_path, ["hooks-status"], [
        {"id": 0, "result": {"capabilities": ["agent.hooks.status"]}, "error": None},
        {"id": 1, "result": snapshot, "error": None},
    ])
    assert result.returncode == 0
    assert requests == [{"cmd": "system.version", "args": {}},
                        {"cmd": "agent.hooks.status", "args": {}}]
    assert json.loads(result.stdout) == snapshot


@pytest.mark.parametrize("reply", [
    {"result": {"capabilities": []}, "error": None},
    {"result": None, "error": "Unknown socket command: system.version"},
    {"result": None, "error": "Frontend not ready"},
])
def test_hooks_status_does_not_reach_an_unsupported_exe(tmp_path: Path, reply: dict) -> None:
    result, requests = _run_with_replies(tmp_path, ["hooks-status"], [{"id": 0, **reply}])
    assert result.returncode == 1
    assert requests == [{"cmd": "system.version", "args": {}}]


def test_hook_socket_status_is_backend_read_only() -> None:
    source = (REPO_ROOT / "src-tauri/src/socket.rs").read_text(encoding="utf-8")
    branch = source.split('if cmd == "agent.hooks.status" {', 1)[1].split('if cmd == "session.state_view"', 1)[0]
    assert "agent_hooks_status().await" in branch
    assert "agent_hooks_set" not in branch and "reconcile" not in branch
    assert "continue;" in branch
    assert '"agent.hooks.set"' not in source.split("#[cfg(test)]", 1)[0]


def test_status_all_preflights_nullable_revision_then_reads_all(tmp_path: Path) -> None:
    state = {"sessions": [{
        "session_id": "closed", "input_revision": None, "ui_state": "done",
        "view": {
            "session_id": "closed", "session_epoch": 1, "session_revision": 2,
            "lifecycle": "exited", "activity": "idle",
            "attention": {"kind": "none", "attention_id": None}, "health": "fresh",
        },
    }]}
    result, requests = _run_with_replies(tmp_path, ["status"], [
        {"id": 0, "result": {"capabilities": ["state_view.input_revision_nullable"]}, "error": None},
        {"id": 1, "result": state, "error": None},
    ])
    assert result.returncode == 0
    assert requests == [
        {"cmd": "system.version", "args": {}},
        {"cmd": "session.state_view", "args": {}},
    ]
    assert json.loads(result.stdout) == state


@pytest.mark.parametrize(("version_reply", "message"), [
    ({"result": {"capabilities": []}, "error": None}, "lacks required capabilities"),
    ({"result": None, "error": "Unknown socket command: system.version"}, "predates capability reporting"),
    ({"result": None, "error": "Frontend not ready"}, "capability support is unknown"),
])
def test_status_all_stops_before_state_request_when_capability_is_unavailable(
    tmp_path: Path, version_reply: dict[str, object], message: str,
) -> None:
    result, requests = _run_with_replies(tmp_path, ["status"], [{"id": 0, **version_reply}])
    assert result.returncode == 1
    assert requests == [{"cmd": "system.version", "args": {}}]
    assert result.stdout == ""
    assert message in result.stderr
    if message == "capability support is unknown":
        assert "lacks required capabilities" not in result.stderr


def test_prompt_spawn_with_model_requires_all_modes_capability(tmp_path: Path) -> None:
    argv = ["spawn-tab", "--anchor-session", "session-a", "--target", "claude",
            "--prompt-file", str(tmp_path / "prompt.md"), "--model", "opus"]
    result, requests = _run_with_replies(tmp_path, argv, [
        {"id": 0, "result": {"capabilities": []}, "error": None},
    ])
    assert result.returncode == 1
    assert requests == [{"cmd": "system.version", "args": {}}]
    assert "spawn.launch_spec.all_modes" in result.stderr


def test_plain_spawn_with_model_uses_one_connection(tmp_path: Path) -> None:
    argv = ["spawn-tab", "--anchor-session", "session-a", "--target", "claude", "--model", "opus"]
    result, requests = _run_with_replies(tmp_path, argv, [
        {"id": 0, "result": {"sessionId": "new"}, "error": None},
    ])
    assert result.returncode == 0
    assert len(requests) == 1 and requests[0]["cmd"] == "pane.spawn_tab"
    assert requests[0]["args"]["model"] == "opus"


def test_real_cli_sends_the_socket_token_when_mycmux_published_one(
    tmp_path: Path,
) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(
        str(listener.getsockname()[1]), encoding="utf-8"
    )
    token = "b" * 64
    # Trailing newline: the CLI must strip whatever the writer left behind.
    (port_dir / "mycmux.token").write_text(token + "\n", encoding="utf-8")
    received: list[bytes] = []
    errors: list[BaseException] = []
    server = _serve_one_request(
        listener, b'{"id":7,"result":{"ok":true},"error":null}\n', received, errors
    )

    result = _run_cli(tmp_path, ["workspaces"])
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert received == [
        b'{"cmd": "workspace.list", "args": {}, "token": "' + token.encode() + b'"}\n'
    ]
    assert result.returncode == 0
    assert result.stdout == json.dumps({"ok": True}) + "\n"
    assert result.stderr == ""


def test_real_cli_prefers_the_injected_runtime_directory(tmp_path: Path) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    runtime = tmp_path / "runtime-test"
    runtime.mkdir()
    (runtime / "mycmux.port").write_text(str(listener.getsockname()[1]), encoding="utf-8")
    received: list[bytes] = []
    errors: list[BaseException] = []
    server = _serve_one_request(listener, b'{"id":7,"result":{"ok":true},"error":null}\n', received, errors)

    env = os.environ.copy()
    env.update({"HOME": str(tmp_path), "USERPROFILE": str(tmp_path), "MYCMUX_RUNTIME_DIR": str(runtime), "PYTHONUTF8": "1"})
    result = subprocess.run([sys.executable, str(CLI_SCRIPT), "workspaces"], cwd=REPO_ROOT, env=env, text=True, encoding="utf-8", capture_output=True, timeout=10, check=False)
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]
    assert result.returncode == 0


def test_real_cli_reports_an_unauthorized_rejection_with_the_token_path(
    tmp_path: Path,
) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(
        str(listener.getsockname()[1]), encoding="utf-8"
    )
    received: list[bytes] = []
    errors: list[BaseException] = []
    server = _serve_one_request(
        listener, b'{"ok":false,"error":"unauthorized"}\n', received, errors
    )

    result = _run_cli(tmp_path, ["workspaces"])
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    # No token file: the request still goes out, and the rejection is actionable.
    assert received == [b'{"cmd": "workspace.list", "args": {}}\n']
    assert result.returncode == 1
    assert result.stdout == ""
    assert "unauthorized" in result.stderr
    assert "mycmux.token" in result.stderr
    assert "MYCMUX_SOCKET_AUTH=off" in result.stderr


def test_real_cli_preserves_legacy_one_shot_wire_format(tmp_path: Path) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(
        str(listener.getsockname()[1]), encoding="utf-8"
    )
    received: list[bytes] = []
    errors: list[BaseException] = []

    def serve() -> None:
        try:
            connection, _ = listener.accept()
            with connection:
                request = bytearray()
                while b"\n" not in request:
                    chunk = connection.recv(4096)
                    if not chunk:
                        raise AssertionError("CLI closed before request newline")
                    request.extend(chunk)
                received.append(bytes(request))
                connection.sendall(
                    b'{"id":7,"result":{"ok":true},"error":null}\n'
                )
        except BaseException as error:  # pragma: no cover - re-raised below
            errors.append(error)
        finally:
            listener.close()

    server = threading.Thread(target=serve, daemon=True)
    server.start()
    env = os.environ.copy()
    # A real mycmux pane injects MYCMUX_RUNTIME_DIR; without stripping it the
    # CLI under test would talk to the live app socket instead of the fake
    # server behind the tmp_path HOME.
    env.pop("MYCMUX_RUNTIME_DIR", None)
    env["HOME"] = str(tmp_path)
    env["USERPROFILE"] = str(tmp_path)
    env["PYTHONUTF8"] = "1"
    result = subprocess.run(
        [sys.executable, str(CLI_SCRIPT), "workspaces"],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=10,
        check=False,
    )
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert received == [b'{"cmd": "workspace.list", "args": {}}\n']
    assert result.returncode == 0
    assert result.stdout == json.dumps({"ok": True}) + "\n"
    assert result.stderr == ""


def test_real_cli_status_uses_authenticated_state_view_wire_format(
    tmp_path: Path,
) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(
        str(listener.getsockname()[1]), encoding="utf-8"
    )
    token = "status-token"
    (port_dir / "mycmux.token").write_text(token, encoding="utf-8")
    session_id = "session-status"
    response = {
        "id": 8,
        "result": {
            "sessions": [
                {
                    "session_id": session_id,
                    "input_revision": 5,
                    "view": {
                        "session_id": session_id,
                        "session_epoch": 7,
                        "session_revision": 11,
                        "lifecycle": "alive",
                        "activity": "idle",
                        "attention": {"attention_id": None, "kind": "none"},
                        "health": "fresh",
                    },
                    "ui_state": "idle",
                }
            ]
        },
        "error": None,
    }
    received: list[bytes] = []
    errors: list[BaseException] = []
    server = _serve_one_request(
        listener,
        (json.dumps(response) + "\n").encode("utf-8"),
        received,
        errors,
    )

    result = _run_cli(tmp_path, ["status", "--session", session_id])
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert json.loads(received[0]) == {
        "cmd": "session.state_view",
        "args": {"session_id": session_id},
        "token": token,
    }
    assert result.returncode == 0
    assert json.loads(result.stdout) == response["result"]
    assert result.stderr == ""


def test_real_cli_status_rejects_invalid_state_schema(tmp_path: Path) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(
        str(listener.getsockname()[1]), encoding="utf-8"
    )
    received: list[bytes] = []
    errors: list[BaseException] = []
    server = _serve_one_request(
        listener,
        b'{"id":8,"result":{"sessions":"bad"},"error":null}\n',
        received,
        errors,
    )

    result = _run_cli(tmp_path, ["status", "--session", "invalid-schema"])
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert result.returncode == 1
    assert result.stdout == ""
    assert "invalid session.state_view schema" in result.stderr


def test_real_cli_send_without_expectations_preserves_legacy_args(
    tmp_path: Path,
) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(
        str(listener.getsockname()[1]), encoding="utf-8"
    )
    received: list[bytes] = []
    errors: list[BaseException] = []

    def serve() -> None:
        try:
            connection, _ = listener.accept()
            with connection:
                request = bytearray()
                while b"\n" not in request:
                    chunk = connection.recv(4096)
                    if not chunk:
                        raise AssertionError("CLI closed before request newline")
                    request.extend(chunk)
                received.append(bytes(request))
                connection.sendall(
                    b'{"id":9,"result":{"sessionId":"session-a","bytes":4},"error":null}\n'
                )
        except BaseException as error:  # pragma: no cover - re-raised below
            errors.append(error)
        finally:
            listener.close()

    server = threading.Thread(target=serve, daemon=True)
    server.start()
    env = os.environ.copy()
    # A real mycmux pane injects MYCMUX_RUNTIME_DIR; without stripping it the
    # CLI under test would talk to the live app socket instead of the fake
    # server behind the tmp_path HOME.
    env.pop("MYCMUX_RUNTIME_DIR", None)
    env["HOME"] = str(tmp_path)
    env["USERPROFILE"] = str(tmp_path)
    env["PYTHONUTF8"] = "1"
    result = subprocess.run(
        [
            sys.executable,
            str(CLI_SCRIPT),
            "send",
            "--session",
            "session-a",
            "--text",
            "yes",
            "--enter",
        ],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=10,
        check=False,
    )
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert received == [
        b'{"cmd": "pane.send_text", "args": {"sessionId": "session-a", "text": "yes", "enter": true}}\n'
    ]
    assert result.returncode == 1
    assert json.loads(result.stdout) == {
        "sessionId": "session-a",
        "bytes": 4,
        "ok": False,
        "confirmed": False,
        "reason": "confirmation_unavailable",
    }
    assert result.stderr == ""


def test_real_cli_warns_for_an_unverified_text_only_send(tmp_path: Path) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(str(listener.getsockname()[1]), encoding="utf-8")
    received: list[bytes] = []
    errors: list[BaseException] = []
    reply = b'{"id":9,"result":{"sessionId":"session-a","queuedBytes":3,"unverified":true},"error":null}\n'
    server = _serve_one_request(listener, reply, received, errors)

    result = _run_cli(tmp_path, ["send", "--session", "session-a", "--text", "yes"])
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert received == [
        b'{"cmd": "pane.send_text", "args": {"sessionId": "session-a", "text": "yes", "enter": false}}\n'
    ]
    assert result.returncode == 0
    assert json.loads(result.stdout)["unverified"] is True
    assert "without delivery verification" in result.stderr


def test_real_cli_key_sends_semantic_key_and_requires_confirmation(tmp_path: Path) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(str(listener.getsockname()[1]), encoding="utf-8")
    received: list[bytes] = []
    errors: list[BaseException] = []
    reply = b'{"id":9,"result":{"sessionId":"session-a","ok":true,"confirmed":true,"attempts":1},"error":null}\n'
    server = _serve_one_request(listener, reply, received, errors)

    result = _run_cli(tmp_path, ["send", "--session", "session-a", "--key", "up"])
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert received == [
        b'{"cmd": "pane.send_text", "args": {"sessionId": "session-a", "text": "", "enter": false, "key": "up"}}\n'
    ]
    assert result.returncode == 0
    assert json.loads(result.stdout)["confirmed"] is True


@pytest.mark.parametrize(
    "server_result",
    [None, {}, {"ok": True, "confirmed": False}],
)
def test_real_cli_send_enter_fails_closed_without_confirmation(
    tmp_path: Path,
    server_result: object,
) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(
        str(listener.getsockname()[1]), encoding="utf-8"
    )
    received: list[bytes] = []
    errors: list[BaseException] = []
    reply = json.dumps({"id": 10, "result": server_result, "error": None}).encode() + b"\n"
    server = _serve_one_request(listener, reply, received, errors)

    result = _run_cli(
        tmp_path,
        ["send", "--session", "session-a", "--text", "yes", "--enter"],
    )
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert result.returncode == 1
    parsed = json.loads(result.stdout)
    assert parsed["ok"] is False
    assert parsed["confirmed"] is False
    assert parsed["reason"] == "confirmation_unavailable"
    assert result.stderr == ""


def test_real_cli_warns_when_enter_was_written_but_unconfirmed(tmp_path: Path) -> None:
    result, requests = _run_with_replies(tmp_path, [
        "send", "--session", "session-a", "--text", "yes", "--enter",
    ], [{"id": 0, "result": {"ok": False, "confirmed": False,
                             "enterWritten": True, "attempts": 1, "outcome": "unknown",
                             "reason": "submit_unconfirmed"}, "error": None}])
    assert result.returncode == 1
    assert requests[0]["cmd"] == "pane.send_text"
    assert "Enter written, acceptance not observed; do not resend" in result.stderr


def test_real_cli_send_enter_accepts_only_explicit_confirmation(tmp_path: Path) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(
        str(listener.getsockname()[1]), encoding="utf-8"
    )
    received: list[bytes] = []
    errors: list[BaseException] = []
    confirmed = {
        "sessionId": "session-a",
        "bytes": 4,
        "ok": True,
        "confirmed": True,
        "attempts": 1,
    }
    reply = json.dumps({"id": 11, "result": confirmed, "error": None}).encode() + b"\n"
    server = _serve_one_request(listener, reply, received, errors)

    result = _run_cli(
        tmp_path,
        ["send", "--session", "session-a", "--text", "yes", "--enter"],
    )
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert result.returncode == 0
    assert json.loads(result.stdout) == confirmed
    assert result.stderr == ""


@pytest.mark.parametrize(
    "failure",
    [
        {
            "sessionId": "session-a",
            "bytes": 4,
            "ok": False,
            "confirmed": False,
            "attempts": 3,
            "reason": "submit_unconfirmed",
        },
        {
            "sent": False,
            "reason": "attention_id",
            "current": {"session_id": "session-a"},
        },
    ],
)
def test_real_cli_send_returns_nonzero_for_structured_failure(
    tmp_path: Path,
    failure: dict[str, object],
) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_dir = tmp_path / ".mycmux"
    port_dir.mkdir()
    (port_dir / "mycmux.port").write_text(
        str(listener.getsockname()[1]), encoding="utf-8"
    )
    received: list[bytes] = []
    errors: list[BaseException] = []
    reply = json.dumps({"id": 10, "result": failure, "error": None}).encode() + b"\n"
    server = _serve_one_request(listener, reply, received, errors)

    result = _run_cli(
        tmp_path,
        ["send", "--session", "session-a", "--text", "yes", "--enter"],
    )
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert result.returncode == 1
    assert json.loads(result.stdout) == failure
    assert result.stderr == ""



def _canonical_state(session_id: str = "running", lifecycle: str = "alive") -> dict:
    return {"server_epoch": "epoch", "sessions": [{
        "session_id": session_id, "input_revision": 0, "ui_state": "idle",
        "view": {
            "session_id": session_id, "session_epoch": 1, "session_revision": 2,
            "lifecycle": lifecycle, "activity": "idle",
            "attention": {"kind": "none", "attention_id": None}, "health": "fresh",
        },
    }]}


def _pane_list(tabs: list[dict]) -> dict:
    return {"panes": [{"workspaceId": "background", "workspaceName": "Other window",
                       "tabs": tabs}]}


def _reply(result: object) -> dict:
    return {"id": 0, "result": result, "error": None}


@pytest.mark.parametrize("tab_type", ["terminal", None])
def test_status_finds_restored_tab_without_a_canonical_record(tmp_path: Path, tab_type: str | None) -> None:
    restored = {"sessionId": "restored", "id": "saved-tab", "label": "Lane B",
                "agentKind": "codex", "agentSessionId": "conversation"}
    if tab_type is not None:
        restored["type"] = tab_type
    result, requests = _run_with_replies(tmp_path, ["status", "--session", "restored"], [
        _reply({"sessions": []}), _reply(_pane_list([restored])),
    ])
    assert result.returncode == 0
    assert requests == [{"cmd": "session.state_view", "args": {"session_id": "restored"}},
                        {"cmd": "pane.list_all", "args": {}}]
    assert json.loads(result.stdout) == {"sessions": [], "not_started": [{
        "session_id": "restored", "tab_id": "saved-tab", "workspace_id": "background",
        "workspace_name": "Other window", "label": "Lane B", "agent_kind": "codex",
        "agent_session_id": "conversation",
    }]}
    assert result.stderr == (
        "session restored has a pane but no PTY yet (restored, not started); "
        "use start-tab --session restored to start it in place\n"
    )


def test_status_not_started_omits_unknown_fields_and_keeps_legacy_identity(tmp_path: Path) -> None:
    panes = {"panes": [{"tabs": [{"type": "terminal", "sessionId": "restored",
                                  "label": None, "agentKind": None,
                                  "claudeSessionId": "legacy-conversation"}]}]}
    result, _ = _run_with_replies(tmp_path, ["status", "--session", "restored"], [
        _reply({"sessions": []}), _reply(panes),
    ])
    assert result.returncode == 0
    assert json.loads(result.stdout) == {"sessions": [], "not_started": [{
        "session_id": "restored", "agent_session_id": "legacy-conversation",
    }]}


@pytest.mark.parametrize("tabs", [[], [{"sessionId": "other", "type": "terminal"}],
                                  [{"sessionId": "gone", "type": "web"}],
                                  [{"sessionId": "gone", "type": "launcher"}]])
def test_status_missing_from_both_sources_keeps_error_exit_and_adds_suffix(tmp_path: Path, tabs: list[dict]) -> None:
    result, requests = _run_with_replies(tmp_path, ["status", "--session", "gone"], [
        _reply({"sessions": []}), _reply(_pane_list(tabs)),
    ])
    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr == "session.state_view did not return exactly one session: gone (no pane and no PTY)\n"
    assert requests[-1] == {"cmd": "pane.list_all", "args": {}}


def test_status_include_not_started_appends_only_tabs_without_canonical_records(tmp_path: Path) -> None:
    state = _canonical_state("running")
    state["sessions"].extend(_canonical_state("exited", "exited")["sessions"])
    panes = _pane_list([
        {"sessionId": "running", "id": "running-tab", "type": "terminal"},
        {"sessionId": "exited", "id": "exited-tab", "type": "terminal"},
        {"sessionId": "restored", "id": "restored-tab", "type": "terminal"},
        {"sessionId": "web", "id": "web-tab", "type": "web"},
        {"sessionId": "launcher", "type": "launcher"},
        {"sessionId": "browser", "type": "browser"},
    ])
    panes["panes"].append({"workspaceId": "second-window", "workspaceName": "Second window",
                           "tabs": [{"sessionId": "second-restored", "type": "terminal"}]})
    result, requests = _run_with_replies(tmp_path, ["status", "--include-not-started"], [
        _reply({"capabilities": ["state_view.input_revision_nullable"]}), _reply(state), _reply(panes),
    ])
    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == {**state, "not_started": [
        {"session_id": "restored", "tab_id": "restored-tab", "workspace_id": "background",
         "workspace_name": "Other window"},
        {"session_id": "second-restored", "workspace_id": "second-window", "workspace_name": "Second window"},
    ]}
    assert requests == [{"cmd": "system.version", "args": {}},
                        {"cmd": "session.state_view", "args": {}},
                        {"cmd": "pane.list_all", "args": {}}]


@pytest.mark.parametrize("argv", [["status"], ["status", "--session", "running"]])
@pytest.mark.parametrize("lifecycle", ["alive", "exited", "orphaned", "unknown"])
def test_status_existing_output_is_byte_for_byte_unchanged(tmp_path: Path, argv: list[str], lifecycle: str) -> None:
    state = _canonical_state(lifecycle=lifecycle)
    replies = [_reply(state)]
    if argv == ["status"]:
        replies.insert(0, _reply({"capabilities": ["state_view.input_revision_nullable"]}))
    result, requests = _run_with_replies(tmp_path, argv, replies)
    assert result.returncode == 0
    assert result.stderr == ""
    assert result.stdout == json.dumps(state, ensure_ascii=False) + "\n"
    assert all(request["cmd"] != "pane.list_all" for request in requests)


@pytest.mark.parametrize("failure", ["bad_lifecycle", "duplicate", "bad_schema"])
def test_status_rejects_invalid_canonical_data_before_consulting_panes(tmp_path: Path, failure: str) -> None:
    state = _canonical_state()
    if failure == "bad_lifecycle":
        state["sessions"][0]["view"]["lifecycle"] = "not_started"
    elif failure == "duplicate":
        state["sessions"].append(state["sessions"][0])
    else:
        state = {"sessions": None}
    result, requests = _run_with_replies(tmp_path, ["status", "--session", "restored"], [_reply(state)])
    assert result.returncode == 1
    assert result.stdout == ""
    assert len(requests) == 1 and requests[0]["cmd"] == "session.state_view"
    assert "no pane and no PTY" not in result.stderr


def test_status_does_not_call_a_failed_pane_query_a_gone_session(tmp_path: Path) -> None:
    result, _ = _run_with_replies(tmp_path, ["status", "--session", "restored"], [
        _reply({"sessions": []}), {"id": 1, "result": None, "error": "Frontend not ready"},
    ])
    assert result.returncode == 1
    assert result.stderr == "Frontend not ready\n"
    assert result.stdout == ""


def test_start_tab_cli_maps_the_session_and_prints_the_socket_result(tmp_path: Path) -> None:
    started = {"started": True, "sessionId": "restored"}
    result, requests = _run_with_replies(tmp_path, ["start-tab", "--session", "restored"], [_reply(started)])
    assert result.returncode == 0
    assert requests == [{"cmd": "pane.start_tab", "args": {"sessionId": "restored"}}]
    assert result.stdout == json.dumps(started) + "\n"
    assert result.stderr == ""


def test_start_tab_cli_requires_session_argument(tmp_path: Path) -> None:
    result = _run_cli(tmp_path, ["start-tab"])
    assert result.returncode == 2
    assert "--session" in result.stderr


def test_start_tab_cli_preserves_already_running_result(tmp_path: Path) -> None:
    running = {"started": False, "reason": "already_running", "sessionId": "restored"}
    result, _ = _run_with_replies(tmp_path, ["start-tab", "--session", "restored"], [_reply(running)])
    assert result.returncode == 0
    assert json.loads(result.stdout) == running


def test_start_tab_cli_preserves_backend_conflict_text(tmp_path: Path) -> None:
    error = 'AGENT_SESSION_ALREADY_RUNNING:{"kind":"codex","agentSessionId":"conversation","ownerSessionId":"owner"}'
    result, _ = _run_with_replies(tmp_path, ["start-tab", "--session", "restored"], [
        {"id": 0, "result": None, "error": error},
    ])
    assert result.returncode == 1
    assert result.stderr == error + "\n"
    assert result.stdout == ""

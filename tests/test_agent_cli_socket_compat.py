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

    result = _run_cli(tmp_path, ["status"])
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

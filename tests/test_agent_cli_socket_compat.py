from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path


REPO_ROOT = Path(__file__).parents[1]
CLI_SCRIPT = REPO_ROOT / "scripts" / "mycmux_agent_cli.py"


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
    assert result.returncode == 0
    assert result.stdout == json.dumps({"sessionId": "session-a", "bytes": 4}) + "\n"
    assert result.stderr == ""

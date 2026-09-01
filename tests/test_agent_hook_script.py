from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HOOK_SCRIPT = REPO_ROOT / "src-tauri" / "hooks" / "mycmux_hook.py"


def run_hook(
    runtime: Path,
    stdin: str,
    *,
    cap: str | None,
    event_kind: str = "turn_ended",
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
            "codex",
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


def test_health_then_observe_reaches_the_socket(tmp_path: Path) -> None:
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
        '{"session_id":"session-a","turn_id":"turn-a","event_id":"event-a"}',
        cap="secret-cap",
    )
    thread.join(timeout=3)
    listener.close()
    assert not error
    assert not thread.is_alive()
    assert_silent_success(result, "secret-cap")
    assert [request["cmd"] for request in requests] == ["hook.health", "hook.observe"]
    assert requests[0]["hook_cap"] == "secret-cap"
    assert requests[1]["body"] == {
        "event_kind": "turn_ended",
        "provider_session_id": "session-a",
        "provider_turn_id": "turn-a",
        "source_event_id": "event-a",
        "provider": "codex",
    }

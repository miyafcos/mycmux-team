from __future__ import annotations

import importlib.util
import io
import json
import socket
import sys
import threading
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "status_feed_probe.py"
SPEC = importlib.util.spec_from_file_location("status_feed_probe", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
status_feed_probe = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = status_feed_probe
SPEC.loader.exec_module(status_feed_probe)


def _line(payload: dict[str, Any]) -> bytes:
    return (json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n").encode()


def _read_json_line(connection: socket.socket) -> dict[str, Any]:
    data = bytearray()
    while b"\n" not in data:
        chunk = connection.recv(4096)
        if not chunk:
            raise AssertionError("client closed before sending a full request")
        data.extend(chunk)
    return json.loads(bytes(data).split(b"\n", 1)[0])


def _session(revision: int, state: str) -> dict[str, Any]:
    return {
        "session_id": "session-a",
        "session_revision": revision,
        "status": {"ui_state": state},
    }


def test_probe_detects_gap_requests_snapshot_and_converges(tmp_path: Path) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_file = tmp_path / "mycmux.port"
    port_file.write_text(str(listener.getsockname()[1]), encoding="utf-8")
    requests: list[dict[str, Any]] = []
    errors: list[BaseException] = []

    def serve() -> None:
        try:
            connection, _ = listener.accept()
            with connection:
                requests.append(_read_json_line(connection))
                frames = [
                    {
                        "v": 2,
                        "kind": "response",
                        "id": 1,
                        "result": {"subscribed": True},
                        "error": None,
                    },
                    {
                        "v": 2,
                        "kind": "event",
                        "event": "status.snapshot",
                        "server_epoch": "epoch-a",
                        "seq": 1,
                        "sessions": [_session(1, "idle")],
                    },
                    {
                        "v": 2,
                        "kind": "event",
                        "event": "status.changed",
                        "server_epoch": "epoch-a",
                        "seq": 2,
                        "session_id": "session-a",
                        "session_revision": 2,
                        "status": {"ui_state": "working"},
                    },
                    {
                        "v": 2,
                        "kind": "event",
                        "event": "status.changed",
                        "server_epoch": "epoch-a",
                        "seq": 4,
                        "session_id": "session-a",
                        "session_revision": 4,
                        "status": {"ui_state": "done"},
                    },
                ]
                connection.sendall(b"".join(_line(frame) for frame in frames))
                requests.append(_read_json_line(connection))
                connection.sendall(
                    _line(
                        {
                            "v": 2,
                            "kind": "response",
                            "id": 2,
                            "result": {
                                "server_epoch": "epoch-a",
                                "seq": 4,
                                "sessions": [_session(4, "done")],
                            },
                            "error": None,
                        }
                    )
                )
        except BaseException as error:  # pragma: no cover - re-raised below
            errors.append(error)
        finally:
            listener.close()

    server = threading.Thread(target=serve, daemon=True)
    server.start()
    output = io.StringIO()
    tracker = status_feed_probe.FeedTracker()

    assert (
        status_feed_probe.run_probe(
            timeout=2,
            port_file=port_file,
            output=output,
            tracker=tracker,
        )
        == 0
    )
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert requests == [
        {"v": 2, "id": 1, "cmd": "status.subscribe", "args": {}},
        {"v": 2, "id": 2, "cmd": "status.snapshot", "args": {}},
    ]
    assert tracker.synced
    assert tracker.server_epoch == "epoch-a"
    assert tracker.last_seq == 4
    assert tracker.sessions["session-a"]["session_revision"] == 4
    assert len(output.getvalue().splitlines()) == 5


def test_probe_authenticates_every_frame_when_a_token_file_exists(
    tmp_path: Path,
) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port_file = tmp_path / "mycmux.port"
    port_file.write_text(str(listener.getsockname()[1]), encoding="utf-8")
    token = "c" * 64
    # The token is discovered next to the port file, trailing newline and all.
    (tmp_path / "mycmux.token").write_text(token + "\n", encoding="utf-8")
    requests: list[dict[str, Any]] = []
    errors: list[BaseException] = []

    def serve() -> None:
        try:
            connection, _ = listener.accept()
            with connection:
                requests.append(_read_json_line(connection))
                connection.sendall(
                    b"".join(
                        _line(frame)
                        for frame in [
                            {
                                "v": 2,
                                "kind": "response",
                                "id": 1,
                                "result": {"subscribed": True},
                                "error": None,
                            },
                            {
                                "v": 2,
                                "kind": "event",
                                "event": "status.resync_required",
                                "server_epoch": "epoch-a",
                                "seq": 3,
                                "reason": "queue_overflow",
                            },
                        ]
                    )
                )
                requests.append(_read_json_line(connection))
        except BaseException as error:  # pragma: no cover - re-raised below
            errors.append(error)
        finally:
            listener.close()

    server = threading.Thread(target=serve, daemon=True)
    server.start()
    output = io.StringIO()

    assert (
        status_feed_probe.run_probe(
            timeout=2,
            port_file=port_file,
            output=output,
            tracker=status_feed_probe.FeedTracker(),
        )
        == 0
    )
    server.join(timeout=3)
    assert not server.is_alive()
    if errors:
        raise errors[0]

    assert requests == [
        {"v": 2, "id": 1, "cmd": "status.subscribe", "args": {}, "token": token},
        {"v": 2, "id": 2, "cmd": "status.snapshot", "args": {}, "token": token},
    ]


def test_tracker_requests_snapshot_on_epoch_change() -> None:
    tracker = status_feed_probe.FeedTracker()
    tracker.observe(
        {
            "v": 2,
            "kind": "event",
            "event": "status.snapshot",
            "server_epoch": "epoch-a",
            "seq": 8,
            "sessions": [],
        }
    )

    assert tracker.observe(
        {
            "v": 2,
            "kind": "event",
            "event": "status.changed",
            "server_epoch": "epoch-b",
            "seq": 1,
            "session_id": "session-a",
            "session_revision": 1,
            "status": {},
        }
    )
    assert not tracker.synced
    assert tracker.snapshot_pending


def test_tracker_recovers_after_resync_required() -> None:
    tracker = status_feed_probe.FeedTracker()
    tracker.observe(
        {
            "v": 2,
            "kind": "event",
            "event": "status.snapshot",
            "server_epoch": "epoch-a",
            "seq": 3,
            "sessions": [_session(1, "idle")],
        }
    )
    assert tracker.observe(
        {
            "v": 2,
            "kind": "event",
            "event": "status.resync_required",
            "server_epoch": "epoch-a",
            "seq": 9,
            "reason": "queue_overflow",
        }
    )
    tracker.observe(
        {
            "v": 2,
            "kind": "response",
            "id": 2,
            "result": {
                "server_epoch": "epoch-a",
                "seq": 9,
                "sessions": [_session(5, "done")],
            },
            "error": None,
        }
    )
    assert tracker.synced
    assert tracker.last_seq == 9
    assert tracker.sessions["session-a"]["session_revision"] == 5


def test_subscribe_frame_is_ascii_ndjson() -> None:
    frame = status_feed_probe.build_subscribe_frame()
    assert frame.endswith(b"\n")
    assert frame.isascii()
    assert json.loads(frame) == {
        "v": 2,
        "id": 1,
        "cmd": "status.subscribe",
        "args": {},
    }

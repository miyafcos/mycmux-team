#!/usr/bin/env python
"""Print and validate mycmux status-feed frames as newline-delimited JSON."""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO


DEFAULT_PORT_FILE = Path.home() / ".mycmux" / "mycmux.port"
TOKEN_FILE_NAME = "mycmux.token"
PROTOCOL_VERSION = 2


def encode_request(request_id: int, command: str, token: str | None = None) -> bytes:
    payload: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "id": request_id,
        "cmd": command,
        "args": {},
    }
    if token is not None:
        payload["token"] = token
    return (json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def build_subscribe_frame(token: str | None = None) -> bytes:
    return encode_request(1, "status.subscribe", token)


def read_port(port_file: Path) -> int:
    raw = port_file.read_text(encoding="utf-8").strip()
    port = int(raw)
    if not 1 <= port <= 65535:
        raise ValueError(f"invalid port in {port_file}: {port}")
    return port


def read_token(token_file: Path) -> str | None:
    """Read the socket token mycmux writes next to the port file.

    A missing file means the running mycmux predates socket auth or was started
    with ``MYCMUX_SOCKET_AUTH=off``; frames then go out unauthenticated exactly
    as before.
    """
    try:
        token = token_file.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


@dataclass
class FeedTracker:
    server_epoch: str | None = None
    last_seq: int | None = None
    sessions: dict[str, dict[str, Any]] = field(default_factory=dict)
    synced: bool = False
    snapshot_pending: bool = False

    def _apply_snapshot(self, payload: dict[str, Any]) -> None:
        server_epoch = payload.get("server_epoch")
        seq = payload.get("seq")
        sessions = payload.get("sessions")
        if not isinstance(server_epoch, str) or not server_epoch:
            raise ValueError("status snapshot has no valid server_epoch")
        if not isinstance(seq, int) or seq < 0:
            raise ValueError("status snapshot has no valid seq")
        if not isinstance(sessions, list):
            raise ValueError("status snapshot has no sessions array")

        indexed: dict[str, dict[str, Any]] = {}
        for session in sessions:
            if not isinstance(session, dict):
                raise ValueError("status snapshot session must be an object")
            session_id = session.get("session_id")
            revision = session.get("session_revision")
            if not isinstance(session_id, str) or not isinstance(revision, int):
                raise ValueError("status snapshot session identity is invalid")
            indexed[session_id] = session

        self.server_epoch = server_epoch
        self.last_seq = seq
        self.sessions = indexed
        self.synced = True
        self.snapshot_pending = False

    def observe(self, frame: dict[str, Any]) -> bool:
        if frame.get("v") != PROTOCOL_VERSION:
            raise ValueError("unexpected status protocol version")
        kind = frame.get("kind")
        if kind == "response":
            if frame.get("error") is not None:
                raise ValueError(f"status feed error: {frame['error']}")
            result = frame.get("result")
            if isinstance(result, dict) and {
                "server_epoch",
                "seq",
                "sessions",
            }.issubset(result):
                self._apply_snapshot(result)
            return False
        if kind != "event":
            raise ValueError("status feed frame kind must be response or event")

        event = frame.get("event")
        if event == "status.snapshot":
            self._apply_snapshot(frame)
            return False
        if event == "status.resync_required":
            self.synced = False
            self.snapshot_pending = True
            return True
        if event != "status.changed":
            raise ValueError(f"unknown status feed event: {event}")

        epoch = frame.get("server_epoch")
        seq = frame.get("seq")
        session_id = frame.get("session_id")
        revision = frame.get("session_revision")
        status = frame.get("status")
        valid_delta = (
            self.synced
            and epoch == self.server_epoch
            and isinstance(seq, int)
            and self.last_seq is not None
            and seq == self.last_seq + 1
            and isinstance(session_id, str)
            and isinstance(revision, int)
            and isinstance(status, dict)
        )
        if not valid_delta:
            self.synced = False
            if not self.snapshot_pending:
                self.snapshot_pending = True
                return True
            return False

        current = self.sessions.get(session_id)
        if current is not None and revision <= current.get("session_revision", -1):
            self.synced = False
            if not self.snapshot_pending:
                self.snapshot_pending = True
                return True
            return False

        self.sessions[session_id] = {
            "session_id": session_id,
            "session_revision": revision,
            "status": status,
        }
        self.last_seq = seq
        return False


def run_probe(
    *,
    timeout: float,
    port_file: Path = DEFAULT_PORT_FILE,
    token_file: Path | None = None,
    output: TextIO = sys.stdout,
    tracker: FeedTracker | None = None,
) -> int:
    if timeout <= 0:
        raise ValueError("--timeout must be greater than zero")

    port = read_port(port_file)
    # The token lives next to the port file, so a --port-file override keeps
    # both discovery files pointing at the same mycmux instance.
    token = read_token(
        token_file if token_file is not None else port_file.with_name(TOKEN_FILE_NAME)
    )
    deadline = time.monotonic() + timeout
    buffer = bytearray()
    state = tracker or FeedTracker()
    next_request_id = 2

    with socket.create_connection(("127.0.0.1", port), timeout=min(timeout, 5.0)) as conn:
        conn.sendall(build_subscribe_frame(token))
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            conn.settimeout(min(remaining, 0.5))
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                break
            buffer.extend(chunk)
            while True:
                newline = buffer.find(b"\n")
                if newline < 0:
                    break
                raw = bytes(buffer[:newline])
                del buffer[: newline + 1]
                if not raw.strip():
                    continue
                try:
                    line = raw.decode("utf-8")
                    frame = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ValueError(f"invalid status feed JSON: {error}") from error
                if not isinstance(frame, dict):
                    raise ValueError("status feed frame must be an object")
                output.write(line + "\n")
                output.flush()
                if state.observe(frame):
                    conn.sendall(
                        encode_request(next_request_id, "status.snapshot", token)
                    )
                    next_request_id += 1
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="total seconds to receive frames before exiting (default: 30)",
    )
    parser.add_argument(
        "--port-file",
        type=Path,
        default=DEFAULT_PORT_FILE,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--token-file",
        type=Path,
        default=None,
        help=argparse.SUPPRESS,
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run_probe(
            timeout=args.timeout,
            port_file=args.port_file,
            token_file=args.token_file,
        )
    except (OSError, UnicodeError, ValueError) as error:
        print(f"status feed probe failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

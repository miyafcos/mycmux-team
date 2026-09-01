"""Best-effort lifecycle hook bridge for mycmux-managed agent hooks."""

from __future__ import annotations

import hashlib
import json
import os
import socket
import sys
import time
from pathlib import Path
from typing import Any


DEADLINE_SECONDS = 0.5
MAX_INPUT_BYTES = 1024 * 1024
MAX_REPLY_BYTES = 64 * 1024


def _argument(name: str) -> str | None:
    try:
        index = sys.argv.index(name)
        return sys.argv[index + 1]
    except (ValueError, IndexError):
        return None


def _runtime_dir() -> Path:
    configured = os.environ.get("MYCMUX_RUNTIME_DIR")
    if configured:
        return Path(configured)
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME")
    return Path(home or ".") / ".mycmux"


def _first_text(payload: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _identity(payload: dict[str, Any], provider: str, event_kind: str) -> dict[str, str] | None:
    provider_session_id = _first_text(
        payload,
        "session_id",
        "sessionId",
        "thread_id",
        "threadId",
        "conversation_id",
        "conversationId",
    )
    if provider_session_id is None:
        return None
    canonical = json.dumps(
        {"provider": provider, "event_kind": event_kind, "payload": payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()
    provider_turn_id = _first_text(
        payload,
        "turn_id",
        "turnId",
        "provider_turn_id",
        "tool_use_id",
        "toolUseId",
    ) or f"hook:{digest}"
    source_event_id = _first_text(
        payload,
        "source_event_id",
        "event_id",
        "eventId",
        "hook_event_id",
        "hookEventId",
    ) or f"hook:{digest}"
    return {
        "event_kind": event_kind,
        "provider_session_id": provider_session_id,
        "provider_turn_id": provider_turn_id,
        "source_event_id": source_event_id,
        "provider": provider,
    }


def _exchange(stream: socket.socket, request: dict[str, Any], deadline: float) -> dict[str, Any] | None:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return None
    stream.settimeout(remaining)
    stream.sendall(json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n")
    reply = bytearray()
    while b"\n" not in reply and len(reply) <= MAX_REPLY_BYTES:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        stream.settimeout(remaining)
        chunk = stream.recv(4096)
        if not chunk:
            return None
        reply.extend(chunk)
    if len(reply) > MAX_REPLY_BYTES:
        return None
    parsed = json.loads(bytes(reply).split(b"\n", 1)[0])
    return parsed if isinstance(parsed, dict) else None


def _run() -> None:
    deadline = time.monotonic() + DEADLINE_SECONDS
    hook_cap = os.environ.get("MYCMUX_HOOK_CAP")
    if not hook_cap:
        return
    provider = _argument("--provider")
    event_kind = _argument("--event-kind")
    if provider not in {"claude", "codex", "grok"} or event_kind not in {
        "turn_active",
        "attention_required",
        "turn_ended",
        "process_exited",
        "session_terminated",
        "failed",
        "cancelled",
        "rate_limited",
    }:
        return
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        return
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        return
    body = _identity(payload, provider, event_kind)
    if body is None:
        return
    port_text = (_runtime_dir() / "mycmux.port").read_text(encoding="utf-8").strip()
    port = int(port_text)
    if not 1 <= port <= 65535:
        return
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return
    with socket.create_connection(("127.0.0.1", port), timeout=remaining) as stream:
        health = _exchange(
            stream,
            {"id": 1, "hook_cap": hook_cap, "cmd": "hook.health", "body": {}},
            deadline,
        )
        if not health or not health.get("ok"):
            return
        result = health.get("result")
        if not isinstance(result, dict) or result.get("protocol_major") != 1:
            return
        _exchange(
            stream,
            {"id": 2, "hook_cap": hook_cap, "cmd": "hook.observe", "body": body},
            deadline,
        )


def main() -> int:
    try:
        _run()
    except BaseException:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

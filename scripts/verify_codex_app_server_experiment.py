"""One authorized live Codex 0.160.0 stdio round trip. No pane or auth access.

Records only IDs, event names, selected settings and the probe's reply; never account data.
The native CLI and its existing settings/authentication are reused without overrides.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
import uuid

PINNED_VERSION = "0.160.0"
MAX_FRAME_BYTES = 512 * 1024
REPLY = "MYCMUX_O2_OK"
PROMPT = "Protocol connectivity verification only. Do not use tools, read files, create agents, or change anything. Reply with exactly MYCMUX_O2_OK."


def native_codex() -> Path:
    if os.name != "nt":
        import shutil
        found = shutil.which("codex")
        if found:
            return Path(found)
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        root = Path(directory)
        suffix = Path("vendor/x86_64-pc-windows-msvc/bin/codex.exe")
        for candidate in (
            root / "codex.exe",
            root / "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64" / suffix,
            root / "node_modules/@openai/codex-win32-x64" / suffix,
            root / "node_modules/@openai/codex" / suffix,
        ):
            if candidate.is_file():
                return candidate
    raise RuntimeError("native Codex executable not found")


def child_environment() -> dict[str, str]:
    return {key: value for key, value in os.environ.items()
            if not key.upper().startswith(("MYCMUX_", "__CMUX_"))}


def initialize_params() -> dict:
    return {"clientInfo": {"name": "mycmux_openai_probe", "title": "mycmux Codex experiment", "version": "0.1.0"},
            "capabilities": {"experimentalApi": True}}


def thread_start_params(cwd: str) -> dict:
    return {"cwd": cwd, "ephemeral": True}


def turn_start_params(thread: str, text: str, operation: str) -> dict:
    return {"threadId": thread, "clientUserMessageId": operation, "input": [{"type": "text", "text": text}]}


def run_probe(executable: Path, cwd: Path, output: Path) -> dict:
    events: list[dict] = []
    result = {"version": 1, "cliVersion": PINNED_VERSION, "startedAt": datetime.now(timezone.utc).isoformat(),
              "operationId": str(uuid.uuid4()), "events": events, "success": False}
    process = None

    def record(direction: str, message: dict) -> None:
        params = message.get("params") or {}
        turn = params.get("turn") or {}
        event = {"at": datetime.now(timezone.utc).isoformat(), "direction": direction,
                 "id": message.get("id"), "method": message.get("method"),
                 "threadId": params.get("threadId"), "turnId": params.get("turnId") or turn.get("id")}
        if "result" in message:
            event["accepted"] = True
            response = message["result"] or {}
            event["threadId"] = (response.get("thread") or {}).get("id")
            event["turnId"] = (response.get("turn") or {}).get("id")
        if "error" in message:
            event["errorCode"] = message["error"].get("code")
        if "status" in turn:
            event["status"] = turn["status"]
        events.append(event)

    try:
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        env = child_environment()
        version = subprocess.run([str(executable), "--version"], capture_output=True, env=env,
                                 timeout=10, creationflags=flags, check=True).stdout.decode("utf-8").strip()
        if version != f"codex-cli {PINNED_VERSION}":
            raise RuntimeError("unsupported CLI version")
        process = subprocess.Popen([str(executable), "app-server", "--listen", "stdio://"],
                                   cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, creationflags=flags)
        inbox: queue.Queue = queue.Queue(maxsize=256)

        def read_stdout() -> None:
            try:
                while True:
                    raw = process.stdout.readline(MAX_FRAME_BYTES + 1)
                    if not raw:
                        inbox.put(None, timeout=1)
                        return
                    if len(raw) > MAX_FRAME_BYTES or not raw.endswith(b"\n"):
                        raise RuntimeError("oversized or incomplete JSON frame")
                    inbox.put(json.loads(raw), timeout=1)
            except Exception:
                try:
                    inbox.put({"probeError": "stdout reader failed"}, timeout=1)
                except queue.Full:
                    pass

        threading.Thread(target=read_stdout, daemon=True).start()

        def send(message: dict) -> None:
            record("send", message)
            process.stdin.write((json.dumps(message, ensure_ascii=True) + "\n").encode("ascii"))
            process.stdin.flush()

        pending_events: list[dict] = []

        def receive(deadline: float) -> dict:
            message = inbox.get(timeout=max(0.01, deadline - time.monotonic()))
            if message is None or "probeError" in message:
                raise RuntimeError("app-server connection lost")
            record("receive", message)
            if "method" in message and "id" in message:
                send({"id": message["id"], "error": {"code": -32601, "message": "unsupported by mycmux one-turn experiment"}})
            return message

        def request(request_id: str, method: str, params: dict) -> dict:
            send({"id": request_id, "method": method, "params": params})
            deadline = time.monotonic() + 30
            while True:
                message = receive(deadline)
                if message.get("id") == request_id and "method" not in message:
                    if "error" in message:
                        raise RuntimeError(f"request rejected: {method} code {message['error'].get('code')}")
                    return message["result"]
                if "method" in message and "id" not in message:
                    pending_events.append(message)

        initialized = request("initialize", "initialize", initialize_params())
        import re
        if PINNED_VERSION not in re.split(r"[^a-zA-Z0-9.-]", initialized.get("userAgent", "")):
            raise RuntimeError("unsupported initialize version")
        result["userAgent"] = initialized["userAgent"]
        send({"method": "initialized", "params": {}})
        requested = thread_start_params(str(cwd))
        thread = request("thread:start", "thread/start", requested)
        result["threadId"] = thread["thread"]["id"]
        result["configuration"] = {"requested": requested,
                                   "effective": {"model": thread.get("model"), "effort": thread.get("reasoningEffort"),
                                                 "serviceTier": thread.get("serviceTier"), "cwd": thread.get("cwd")}}
        request_id = "send:" + result["operationId"]
        result["requestId"] = request_id
        turn = request(request_id, "turn/start", turn_start_params(result["threadId"], PROMPT, result["operationId"]))
        result["turnId"] = turn["turn"]["id"]
        result["accepted"] = True
        pending = pending_events
        pending_events = []
        deadline = time.monotonic() + 240
        reply = ""
        started = completed = False
        tools = []
        while not completed:
            message = pending.pop(0) if pending else receive(deadline)
            params = message.get("params") or {}
            if params.get("threadId") != result["threadId"]:
                continue
            event_turn = params.get("turnId") or (params.get("turn") or {}).get("id")
            if event_turn != result["turnId"]:
                continue
            method = message.get("method")
            if method == "turn/started":
                started = True
            elif method == "item/agentMessage/delta":
                reply += params.get("delta", "")
                if len(reply.encode("utf-8")) > 64 * 1024:
                    raise RuntimeError("reply exceeds experiment limit")
            elif method in ("item/started", "item/completed"):
                kind = (params.get("item") or {}).get("type")
                # Fail conservatively on every non-conversation/unknown item. The
                # pinned schema calls collaboration `collabAgentToolCall`.
                if kind not in ("userMessage", "agentMessage", "reasoning", "plan"):
                    tools.append(kind or "unknown")
            elif method == "thread/tokenUsage/updated":
                result["tokenUsage"] = params.get("tokenUsage")
            elif method == "turn/completed":
                result["turnStatus"] = params["turn"]["status"]
                completed = True
        result.update({"started": started, "completed": completed, "reply": reply,
                       "toolItems": tools, "success": started and result["turnStatus"] == "completed"
                       and reply.strip() == REPLY and not tools})
    except Exception as error:
        result["failure"] = str(error)
    finally:
        if process is not None:
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=10)
            result["ownedProcessExit"] = process.returncode
        result["finishedAt"] = datetime.now(timezone.utc).isoformat()
        output.parent.mkdir(parents=True, exist_ok=True)
        encoded = json.dumps(result, ensure_ascii=True, indent=2) + "\n"
        output.write_text(encoded, encoding="utf-8", newline="\n")
        assert output.read_text(encoding="utf-8") == encoded and "\ufffd" not in encoded
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--executable", type=Path)
    parser.add_argument("--out", type=Path, default=Path("tmp/s5-openai/live-roundtrip.json"))
    args = parser.parse_args()
    cwd = args.cwd.resolve()
    if not cwd.is_dir():
        parser.error("cwd must exist")
    result = run_probe(args.executable or native_codex(), cwd, args.out)
    print(json.dumps({key: value for key, value in result.items() if key not in ("events", "tokenUsage")}, ensure_ascii=True))
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

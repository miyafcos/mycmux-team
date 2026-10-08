"""Manage the detached Windows mycmux Control stdio MCP tunnel.

The owner creates the tunnel and key; secure_mcp_tunnel.ps1 Init creates the
profile. This launcher never reads or prints a key value. The tunnel client
owns the stdio MCP server, so one detached process supervises the whole stack.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from uuid import uuid4


HERE = Path(__file__).resolve().parent
DEFAULT_STATE_DIR = Path(
    os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
) / "mycmux-control"
PROFILE_NAME = "mycmux-control"
CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200


class StackFailure(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def paths(ns: argparse.Namespace) -> dict[str, Path]:
    root = Path(ns.state_dir).expanduser().resolve()
    return {
        "root": root,
        "runtime": root / "runtime",
        "state": root / "runtime" / "stack.json",
        "logs": root / "logs",
        "key": Path(ns.key_file).expanduser().resolve() if ns.key_file else root / "control-plane.key",
        "profiles": Path(ns.profile_dir).expanduser().resolve() if ns.profile_dir else root / "profiles",
        "client": Path(ns.tunnel_client).expanduser().resolve() if ns.tunnel_client else root / "bin" / "v0.0.12" / "tunnel-client.exe",
    }


def process_identity(pid: int) -> str | None:
    """Creation time prevents stopping a different process after PID reuse."""
    if os.name != "nt":
        raise StackFailure("The detached stack launcher supports Windows only.")
    if pid <= 0:
        return None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetExitCodeProcess.restype = wintypes.BOOL
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        exit_code = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)) or exit_code.value != 259:
            return None
        created, exited, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(
            handle, ctypes.byref(created), ctypes.byref(exited),
            ctypes.byref(kernel_time), ctypes.byref(user_time),
        ):
            return None
        return f"{created.dwHighDateTime:08x}{created.dwLowDateTime:08x}"
    finally:
        kernel.CloseHandle(handle)


def load_runtime(p: dict[str, Path]) -> dict:
    if not p["state"].is_file():
        return {}
    try:
        state = json.loads(p["state"].read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StackFailure("Runtime state is unreadable; preserve it for inspection.") from exc
    if (
        not isinstance(state, dict)
        or not isinstance(state.get("pid"), int) or isinstance(state["pid"], bool) or state["pid"] <= 0
        or not isinstance(state.get("identity"), str)
        or re.fullmatch(r"[0-9a-f]{16}", state["identity"]) is None
        or not isinstance(state.get("healthUrlFile"), str)
        or re.fullmatch(r"health-url-[0-9a-f]{32}\.txt", state["healthUrlFile"]) is None
    ):
        raise StackFailure("Runtime state is invalid; preserve it for inspection.")
    return state


def save_runtime(p: dict[str, Path], state: dict) -> None:
    payload = json.dumps(state, indent=2, ensure_ascii=True) + "\n"
    temporary = p["runtime"] / "stack.json.tmp"
    temporary.write_text(payload, encoding="utf-8", newline="\n")
    os.replace(temporary, p["state"])


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def health_base(value: str) -> str:
    """Allow only an exact loopback HTTP origin; reject redirects and proxies."""
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise StackFailure("Health URL is not a loopback HTTP origin.") from exc
    if (
        parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
        or port is None or not 1 <= port <= 65535
        or parsed.netloc != f"127.0.0.1:{port}"
        or parsed.path not in ("", "/") or parsed.query or parsed.fragment
    ):
        raise StackFailure("Health URL is not a loopback HTTP origin.")
    return f"http://127.0.0.1:{port}"


def http_status(base: str, endpoint: str) -> int:
    origin = health_base(base)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(f"{origin}/{endpoint}", timeout=1.0) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except (OSError, urllib.error.URLError):
        return 0


def status_info(p: dict[str, Path], state: dict | None = None) -> dict:
    current = load_runtime(p) if state is None else state
    pid = current.get("pid", 0)
    alive = bool(
        current and current.get("state") != "stopped"
        and process_identity(pid) == current["identity"]
    )
    base = ""
    healthz = readyz = 0
    if alive:
        health_file = p["runtime"] / current["healthUrlFile"]
        if health_file.is_file():
            # Never follow a runtime symlink out to an unrelated local file.
            if health_file.resolve().parent != p["runtime"].resolve():
                raise StackFailure("Health URL file is outside the managed runtime directory.")
            base = health_base(health_file.read_text(encoding="utf-8").strip())
            healthz = http_status(base, "healthz")
            readyz = http_status(base, "readyz")
    return {
        "pid": pid, "alive": alive, "healthBase": base,
        "healthz": healthz, "readyz": readyz,
        "state": current.get("state", "not_started"),
        "profile": current.get("profile", ""),
    }


def spawn(command: list[str], log_path: Path) -> int:
    child_env = os.environ.copy()
    for name in list(child_env):
        upper = name.upper()
        if upper in {"CONTROL_PLANE_API_KEY", "OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "CLOUDFLARED_TUNNEL_TOKEN"} or upper.endswith(
            ("_API_KEY", "_ACCESS_TOKEN", "_AUTH_TOKEN", "_SECRET", "_PASSWORD")
        ):
            child_env.pop(name, None)
    child_env["PYTHONDONTWRITEBYTECODE"] = "1"
    with log_path.open("ab") as output:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
            cwd=str(HERE), env=child_env, close_fds=True,
            creationflags=CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
        )
    return process.pid


def cmd_start(ns: argparse.Namespace) -> int:
    p = paths(ns)
    # Check metadata only, before creating runtime directories or starting anything.
    if not p["key"].is_file():
        raise StackFailure(
            f"Runtime key file missing: {p['key']}. Ask the owner to save a Tunnels Read+Use "
            "key there with owner-only permissions. Do not pass its value on the command line."
        )
    if not any((p["profiles"] / f"{ns.profile}{suffix}").is_file() for suffix in (".yaml", ".yml")):
        raise StackFailure("Profile missing. Run secure_mcp_tunnel.ps1 -Mode Init with the owner's tunnel ID first.")
    if not p["client"].is_file():
        raise StackFailure("Tunnel client missing. Ask the owner to supply the official tunnel-client executable.")
    if os.name != "nt":
        raise StackFailure("The detached stack launcher supports Windows only.")
    existing = load_runtime(p)
    if existing and existing.get("state") != "stopped" and process_identity(existing["pid"]) == existing["identity"]:
        info = status_info(p, existing)
        print(json.dumps({"alreadyRunning": True, **info}))
        return 0 if info["readyz"] == 200 else 3

    p["runtime"].mkdir(parents=True, exist_ok=True)
    p["logs"].mkdir(parents=True, exist_ok=True)
    run_id = uuid4().hex
    health_file = f"health-url-{run_id}.txt"
    command = [
        str(p["client"]), "run", "--profile", ns.profile, "--profile-dir", str(p["profiles"]),
        "--control-plane.api-key", "file:" + str(p["key"]),
        "--health.listen-addr", "127.0.0.1:0",
        "--health.url-file", str(p["runtime"] / health_file),
        "--pid.file", str(p["runtime"] / "tunnel-client.pid"),
        "--mcp.max-concurrent-requests", "1",
        "--allow-remote-ui=false", "--open-web-ui=false",
        "--log.http-raw-unsafe=false", "--harpoon.capture-payloads=false",
        "--log.format", "json", "--log.file", str(p["logs"] / f"tunnel-client-{run_id}.jsonl"),
    ]
    pid = spawn(command, p["logs"] / f"tunnel-client-{run_id}.stdout.log")
    identity = process_identity(pid)
    if identity is None:
        raise StackFailure("The detached tunnel client exited before runtime identity could be recorded.")
    state = {
        "pid": pid, "identity": identity, "profile": ns.profile,
        "healthUrlFile": health_file, "startedAt": utc_now(), "state": "starting",
    }
    save_runtime(p, state)
    deadline = time.monotonic() + ns.timeout
    while True:
        info = status_info(p, state)
        if info["healthz"] == 200 and info["readyz"] == 200:
            state["state"] = "ready"
            save_runtime(p, state)
            print(json.dumps({**info, "state": "ready"}))
            return 0
        if not info["alive"] or time.monotonic() >= deadline:
            print(json.dumps({**info, "guidance": "Preserve runtime/logs; use status or stop for this managed stack."}))
            return 3
        time.sleep(0.25)


def cmd_status(ns: argparse.Namespace) -> int:
    info = status_info(paths(ns))
    print(json.dumps(info))
    return 0 if info["alive"] and info["healthz"] == 200 and info["readyz"] == 200 else 1


def cmd_stop(ns: argparse.Namespace) -> int:
    p = paths(ns)
    state = load_runtime(p)
    if not state:
        print(json.dumps({"stopped": False, "alive": False}))
        return 0
    alive = state.get("state") != "stopped" and process_identity(state["pid"]) == state["identity"]
    if alive:
        result = subprocess.run(
            ["taskkill", "/PID", str(state["pid"]), "/T", "/F"],
            capture_output=True, check=False, timeout=10,
        )
        if result.returncode != 0 and process_identity(state["pid"]) == state["identity"]:
            raise StackFailure("The managed stack could not be stopped; runtime state and logs were preserved.")
        if process_identity(state["pid"]) == state["identity"]:
            raise StackFailure("The managed stack is still alive; runtime state and logs were preserved.")
    state["state"] = "stopped"
    state["stoppedAt"] = utc_now()
    save_runtime(p, state)
    # Retain PID files, health URL files, and logs. Future starts use a fresh URL file.
    print(json.dumps({"stopped": bool(alive), "alive": False, "pid": state["pid"]}))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subparsers = parser.add_subparsers(dest="command", required=True)
    for action in ("start", "status", "stop"):
        sub = subparsers.add_parser(action)
        sub.add_argument("--state-dir", default=str(DEFAULT_STATE_DIR))
        sub.add_argument("--key-file")
        sub.add_argument("--profile-dir")
        sub.add_argument("--tunnel-client")
        sub.add_argument("--profile", default=PROFILE_NAME)
        sub.add_argument("--timeout", type=float, default=15.0)
    ns = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9._-]+", ns.profile) or not 0 < ns.timeout <= 60:
        parser.error("Use a safe profile name and a timeout greater than 0 and at most 60 seconds.")
    try:
        return {"start": cmd_start, "status": cmd_status, "stop": cmd_stop}[ns.command](ns)
    except StackFailure as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"Stack operation failed ({type(exc).__name__}); preserve runtime and logs.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

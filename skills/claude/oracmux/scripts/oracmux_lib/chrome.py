"""OracleChrome (off-screen Chrome, CDP 9222) lifecycle and oracle session state.

The Chrome is owned by ~/.oracle/oracle-chrome.ps1 (`up|show|hide|status|down`).
oracmux never launches its own browser: headless Chrome is rejected by
Cloudflare and a second visible Chrome would fight over the profile.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import urlopen

from . import paths


def cdp_version(endpoint: str, timeout: float = 5.0) -> tuple[bool, str, str]:
    """(reachable, browser label or error, browser WebSocket endpoint)."""
    try:
        with urlopen(endpoint.rstrip("/") + "/json/version", timeout=timeout) as response:
            if response.getcode() != 200:
                return False, f"HTTP {response.getcode()}", ""
            data = json.loads(response.read().decode("utf-8", errors="replace"))
            return True, str(data.get("Browser", "chrome")), str(data.get("webSocketDebuggerUrl", ""))
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
        return False, str(exc), ""


def cdp_ws_alive(ws_url: str, timeout: float = 5.0) -> tuple[bool, str]:
    """Does the browser's debugger socket actually accept a connection?

    `/json/version` is plain HTTP and answers even when the target it advertises
    is gone, so it cannot tell a healthy Chrome from a stale one. oracle then
    attaches, gets `Unexpected server response: 404` on the WebSocket upgrade and
    dies about a minute in — which is how 2026-09-10 was spent. One handshake
    here turns that into an instant, nameable precondition.

    No Origin header is sent: Chrome answers 403 to a DevTools upgrade that
    carries one (measured 2026-09-10), so adding it would report a false death.
    """
    parsed = urlparse(ws_url)
    host, port, path = parsed.hostname, parsed.port, parsed.path or "/"
    if not host or not port:
        return False, f"unusable webSocketDebuggerUrl: {ws_url!r}"
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    try:
        with socket.create_connection((host, port), timeout=timeout) as connection:
            connection.settimeout(timeout)
            connection.sendall(request.encode("ascii"))
            status = connection.recv(256).split(b"\r\n", 1)[0].decode("latin-1", errors="replace")
    except OSError as exc:
        return False, str(exc)
    if " 101 " in status:
        return True, status
    return False, status.strip() or "no response to the WebSocket upgrade"


def cdp_alive(endpoint: str, timeout: float = 5.0) -> tuple[bool, str]:
    """Alive means attachable: HTTP answers *and* the debugger socket connects."""
    reachable, detail, ws_url = cdp_version(endpoint, timeout)
    if not reachable:
        return False, detail
    if not ws_url:
        return False, f"{detail} but /json/version advertised no webSocketDebuggerUrl"
    ws_ok, ws_detail = cdp_ws_alive(ws_url, timeout)
    if ws_ok:
        return True, detail
    return False, f"{detail} answers HTTP but its debugger socket is dead ({ws_detail})"


def oracle_chrome(action: str) -> tuple[int, str]:
    if action not in ("up", "show", "hide", "status", "down"):
        raise ValueError(f"unknown oracle-chrome action: {action}")
    script = paths.oracle_chrome_ps1()
    if not script.is_file():
        return 127, f"oracle-chrome.ps1 not found: {script}"
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), action],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    output = (completed.stdout or "") + (completed.stderr or "")
    return completed.returncode, output.strip()


def ensure_up(endpoint: str) -> str:
    alive, detail = cdp_alive(endpoint)
    if alive:
        return f"already up ({detail})"
    reachable, _, _ = cdp_version(endpoint)
    code, output = oracle_chrome("up")
    alive, detail = cdp_alive(endpoint)
    if alive:
        return f"started: {output}"
    if reachable:
        # `oracle-chrome up` is a no-op while /json/version answers, so a stale
        # target survives it. Never restart Chrome from here: an oracle session
        # may be mid-answer in that very browser.
        raise RuntimeError(
            f"OracleChrome answers on {endpoint} but its debugger socket is dead ({detail}), and "
            "`oracle-chrome up` cannot repair that. oracle would attach and die with a bare 404. "
            "Check for a running oracle session first (`oracle status`); once nothing is running, "
            "restart it with `oracle-chrome down` then `oracle-chrome up`. "
            "Or use --via pane, which needs no Chrome at all."
        )
    raise RuntimeError(f"oracle-chrome up failed (rc={code}): {output or detail}")


def show() -> str:
    return oracle_chrome("show")[1]


def _pid_alive(pid: int) -> bool:
    try:
        import psutil  # type: ignore

        return psutil.pid_exists(pid)
    except ImportError:  # pragma: no cover - psutil is installed here; keep a fallback
        completed = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return str(pid) in (completed.stdout or "")


def running_oracle_sessions(hours: float = 12.0, sessions_dir: Path | None = None, now: datetime | None = None) -> list[dict[str, Any]]:
    """oracle sessions whose meta says running and whose controller process is alive.

    A `running` record with a dead controller is a zombie (killed CLI); it is
    reported separately so the caller can quarantine it, never treated as busy.
    """
    root = sessions_dir or paths.oracle_sessions_dir()
    if not root.is_dir():
        return []
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(hours=hours)
    found: list[dict[str, Any]] = []
    for meta_path in root.glob("*/meta.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(meta, dict) or meta.get("status") != "running":
            continue
        created = str(meta.get("createdAt", ""))
        try:
            created_at = datetime.fromisoformat(created.replace("Z", "+00:00"))
        except ValueError:
            created_at = cutoff
        if created_at < cutoff:
            continue
        pid = ((meta.get("browser") or {}).get("runtime") or {}).get("controllerPid")
        alive = _pid_alive(int(pid)) if isinstance(pid, int) else False
        found.append(
            {
                "id": meta.get("id", meta_path.parent.name),
                "createdAt": created,
                "controllerPid": pid,
                "alive": alive,
                "zombie": not alive,
                "promptPreview": str(meta.get("promptPreview", ""))[:80],
            }
        )
    return found


def busy_sessions(hours: float = 12.0) -> list[dict[str, Any]]:
    return [item for item in running_oracle_sessions(hours) if item["alive"]]

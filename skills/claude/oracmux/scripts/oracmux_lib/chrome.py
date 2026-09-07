"""OracleChrome (off-screen Chrome, CDP 9222) lifecycle and oracle session state.

The Chrome is owned by ~/.oracle/oracle-chrome.ps1 (`up|show|hide|status|down`).
oracmux never launches its own browser: headless Chrome is rejected by
Cloudflare and a second visible Chrome would fight over the profile.
"""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from . import paths


def cdp_alive(endpoint: str, timeout: float = 5.0) -> tuple[bool, str]:
    try:
        with urlopen(endpoint.rstrip("/") + "/json/version", timeout=timeout) as response:
            if response.getcode() == 200:
                data = json.loads(response.read().decode("utf-8", errors="replace"))
                return True, str(data.get("Browser", "chrome"))
            return False, f"HTTP {response.getcode()}"
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
        return False, str(exc)


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
    code, output = oracle_chrome("up")
    alive, detail = cdp_alive(endpoint)
    if not alive:
        raise RuntimeError(f"oracle-chrome up failed (rc={code}): {output or detail}")
    return f"started: {output}"


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

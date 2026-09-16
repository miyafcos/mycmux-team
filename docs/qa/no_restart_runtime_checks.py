from __future__ import annotations

import json
import os
import socket
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

RUN_ID = "RUN-20260625-011500-NORESTART-RUNTIME"
REPO = Path(r"C:\Users\miyaz\cmux-for-linux-dev-master")
LOG_DIR = REPO / "docs" / "qa" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_PATH = LOG_DIR / "validation-20260625-011500-no-restart-runtime.log"

lines: list[str] = []
failures: list[str] = []

def emit(message: str) -> None:
    lines.append(message)


def check(name: str, condition: bool, detail: str) -> None:
    status = "PASS" if condition else "FAIL"
    emit(f"[{status}] {name}: {detail}")
    if not condition:
        failures.append(f"{name}: {detail}")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def inspect_data(path: Path) -> None:
    if not path.exists():
        check(f"persistent data exists {path.parent.name}", False, str(path))
        return
    try:
        data = json.loads(read_text(path))
    except Exception as exc:
        check(f"persistent data JSON parse {path.parent.name}", False, repr(exc))
        return
    keys = set(data.keys())
    required = {"schema_version", "workspaces", "settings", "active_workspace_id", "active_pane_id", "active_tab_id", "pinned_roots"}
    check(f"persistent data required keys {path.parent.name}", required.issubset(keys), f"keys={sorted(keys)}")
    workspaces = data.get("workspaces") or []
    check(f"persistent data workspace list {path.parent.name}", isinstance(workspaces, list), f"workspace_count={len(workspaces) if isinstance(workspaces, list) else 'not-list'}")
    valid_workspace_shape = True
    total_panes = 0
    total_tabs = 0
    if isinstance(workspaces, list):
        for workspace in workspaces:
            panes = workspace.get("panes") or [] if isinstance(workspace, dict) else []
            if not isinstance(workspace, dict) or not workspace.get("id") or not workspace.get("name") or not isinstance(panes, list):
                valid_workspace_shape = False
                break
            total_panes += len(panes)
            for pane in panes:
                tabs = pane.get("tabs") or [] if isinstance(pane, dict) else []
                if not isinstance(pane, dict) or not (pane.get("id") or pane.get("pane_id")) or not isinstance(tabs, list):
                    valid_workspace_shape = False
                    break
                total_tabs += len(tabs)
    check(f"persistent data workspace shape {path.parent.name}", valid_workspace_shape, f"workspaces={len(workspaces)}, panes={total_panes}, tabs={total_tabs}")
    settings = data.get("settings") or {}
    check(f"persistent settings object {path.parent.name}", isinstance(settings, dict), f"settings_keys={sorted(settings.keys()) if isinstance(settings, dict) else 'not-object'}")
    pinned = data.get("pinned_roots") or []
    check(f"persistent pinned roots list {path.parent.name}", isinstance(pinned, list), f"pinned_roots_count={len(pinned) if isinstance(pinned, list) else 'not-list'}")


def tcp_connect(host: str, port: int, timeout: float = 1.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError as exc:
        emit(f"[INFO] tcp connect {host}:{port}: {exc}")
        return False


def http_status(url: str, timeout: float = 2.0) -> tuple[int | None, str]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "mycmux-qa-no-restart/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            content_type = response.headers.get("content-type", "")
            body = response.read(160).decode("utf-8", errors="replace")
            return response.status, f"content_type={content_type}; body_prefix={body[:80]!r}"
    except urllib.error.HTTPError as exc:
        content_type = exc.headers.get("content-type", "") if exc.headers else ""
        body = exc.read(160).decode("utf-8", errors="replace")
        return exc.code, f"content_type={content_type}; body_prefix={body[:80]!r}"
    except Exception as exc:
        return None, repr(exc)


def read_port(path: Path) -> int | None:
    try:
        raw = read_text(path).strip()
        return int(raw)
    except Exception as exc:
        emit(f"[INFO] could not read port file {path}: {exc!r}")
        return None


def main() -> int:
    emit(f"run_id={RUN_ID}")
    emit(f"timestamp={datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    emit("constraint=no mycmux restart, quit, install, replacement, or competing app launch")
    emit("secret_hygiene=token values and raw persistent data are not printed")

    process_seen = False
    try:
        import subprocess
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Get-Process mycmux,mycmux-lite -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        emit(f"process_probe_exit={result.returncode}")
        emit(f"process_probe_json={result.stdout.strip()[:500]}")
        process_seen = "mycmux" in result.stdout.lower()
    except Exception as exc:
        emit(f"[INFO] process probe failed: {exc!r}")
    check("active mycmux-family process observed", process_seen, "Get-Process mycmux,mycmux-lite returned at least one entry")

    appdata = Path(os.environ.get("APPDATA", r"C:\Users\miyaz\AppData\Roaming"))
    inspect_data(appdata / "com.miyazaki.mycmux" / "data.json")
    inspect_data(appdata / "com.miyazaki.mycmux-lite" / "data.json")

    home = Path.home()
    socket_port = read_port(home / ".mycmux" / "mycmux.port")
    remote_port = read_port(home / ".mycmux" / "remote.port")
    check("socket port file present", isinstance(socket_port, int), f"port={socket_port}")
    check("remote port file present", isinstance(remote_port, int), f"port={remote_port}")
    if socket_port:
        check("socket listener accepts localhost TCP", tcp_connect("127.0.0.1", socket_port), f"127.0.0.1:{socket_port} connect/open-close only; no command sent")
    if remote_port:
        status, detail = http_status(f"http://127.0.0.1:{remote_port}/")
        check("remote static client GET /", status == 200 and "text/html" in detail, f"status={status}; {detail}")
        status, detail = http_status(f"http://127.0.0.1:{remote_port}/api/state")
        check("remote API rejects missing token", status == 401 and "Unauthorized" in detail, f"status={status}; {detail}")

    src_checks = [
        ("remote UI token suffix only", REPO / "src" / "components" / "layout" / "SettingsMenu.tsx", ["token_suffix", "rotateRemoteToken", "connected_clients", "remoteInfo.url"]),
        ("socket frontend listener bridge", REPO / "src" / "components" / "layout" / "SocketListener.tsx", ["listen<SocketRequestPayload>", "socket-request", "sendSocketResponse", "handleSocketCommand"]),
        ("titlebar non-close controls", REPO / "src" / "components" / "layout" / "TitleBar.tsx", ["New Workspace", "Toggle Sidebar", "Notifications", "Settings"]),
        ("setup wizard controls", REPO / "src" / "components" / "setup" / "WorkspaceSetup.tsx", ["My Workspace", "GridPicker", "AgentSlotList", "onLaunch"]),
        ("theme settings persistable fields", REPO / "src" / "stores" / "themeStore.ts", ["fontFamily", "fontSize", "themeTweaks", "background"]),
    ]
    for name, path, needles in src_checks:
        try:
            text = read_text(path)
            missing = [needle for needle in needles if needle not in text]
            check(name, not missing, f"file={path}; missing={missing or 'none'}")
        except Exception as exc:
            check(name, False, f"file={path}; error={exc!r}")

    emit(f"failures={len(failures)}")
    if failures:
        for failure in failures:
            emit(f"failure={failure}")
    LOG_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(LOG_PATH)
    print(f"failures={len(failures)}")
    return 1 if failures else 0

if __name__ == "__main__":
    raise SystemExit(main())

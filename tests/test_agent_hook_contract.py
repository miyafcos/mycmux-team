from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
LAUNCHER_SH = REPO_ROOT / "src-tauri" / "src" / "launcher.sh"
LAUNCHER_PS1 = REPO_ROOT / "src-tauri" / "src" / "launcher.ps1"


class CapabilityServer:
    def __init__(self, runtime_dir: Path, count: int = 2) -> None:
        self.runtime_dir = runtime_dir
        self.count = count
        self.requests: list[dict[str, object]] = []
        self.error: BaseException | None = None
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen()
        self.listener.settimeout(5)
        self.port = self.listener.getsockname()[1]
        runtime_dir.mkdir(parents=True)
        (runtime_dir / "mycmux.port").write_text(str(self.port), encoding="utf-8")
        (runtime_dir / "mycmux.token").write_text("broad-test-token", encoding="utf-8")
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def __enter__(self) -> "CapabilityServer":
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.thread.join(timeout=6)
        self.listener.close()
        assert not self.thread.is_alive(), "capability test server did not finish"
        if self.error is not None:
            raise self.error

    def _serve(self) -> None:
        try:
            for index in range(1, self.count + 1):
                connection, _ = self.listener.accept()
                with connection:
                    connection.settimeout(2)
                    frame = b""
                    while b"\n" not in frame:
                        chunk = connection.recv(4096)
                        if not chunk:
                            break
                        frame += chunk
                    request = json.loads(frame.split(b"\n", 1)[0])
                    self.requests.append(request)
                    response = {
                        "id": index,
                        "result": {
                            "hook_cap": f"capability-{index}",
                            "protocol_major": 1,
                            "protocol_minor": 0,
                        },
                        "error": None,
                    }
                    connection.sendall(json.dumps(response).encode("utf-8") + b"\n")
        except BaseException as error:  # surfaced on the test thread
            self.error = error


def launcher_environment(tmp_path: Path, runtime_dir: Path, capture: Path) -> dict[str, str]:
    home = tmp_path / "home"
    bin_dir = home / "bin"
    bin_dir.mkdir(parents=True)
    fake = bin_dir / "claude.cmd"
    fake.write_text(
        "@echo off\r\necho %MYCMUX_HOOK_CAP%>>\"%MYCMUX_CAPTURE%\"\r\n",
        encoding="utf-8",
    )
    appdata = tmp_path / "appdata"
    appdata.mkdir()
    env = os.environ.copy()
    env.update(
        {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "APPDATA": str(appdata),
            "MYCMUX_RUNTIME_DIR": str(runtime_dir),
            "MYCMUX_PANE_SESSION_ID": "terminal-test",
            "MYCMUX_HOOK_WRAPPERS_ONLY": "1",
            "MYCMUX_CAPTURE": str(capture),
        }
    )
    return env


def git_bash_path() -> str | None:
    candidates = [
        Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe",
        Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/usr/bin/bash.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/Git/bin/bash.exe",
    ]
    return next((str(path) for path in candidates if path.is_file()), None)


def assert_two_launches(server: CapabilityServer, capture: Path) -> None:
    assert capture.read_text(encoding="utf-8").splitlines() == [
        "capability-1",
        "capability-2",
    ]
    assert [request["cmd"] for request in server.requests] == [
        "launch.issue_hook_cap",
        "launch.issue_hook_cap",
    ]
    for request in server.requests:
        assert request["token"] == "broad-test-token"
        assert request["args"] == {
            "terminal_session_id": "terminal-test",
            "provider": "claude",
        }


def test_bash_two_launches_in_one_shell_receive_fresh_capabilities(tmp_path: Path) -> None:
    bash = git_bash_path()
    if bash is None:
        pytest.skip("bash is unavailable")
    runtime = tmp_path / "runtime-bash"
    capture = tmp_path / "bash-caps.txt"
    env = launcher_environment(tmp_path / "bash", runtime, capture)
    env["MYCMUX_LAUNCHER_PATH"] = LAUNCHER_SH.as_posix()
    with CapabilityServer(runtime) as server:
        subprocess.run(
            [bash, "-c", 'source "$MYCMUX_LAUNCHER_PATH"; claude; claude'],
            env=env,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    assert_two_launches(server, capture)


def test_powershell_two_launches_in_one_shell_receive_fresh_capabilities(
    tmp_path: Path,
) -> None:
    powershell = shutil.which("powershell")
    if powershell is None:
        pytest.skip("Windows PowerShell is unavailable")
    runtime = tmp_path / "runtime-powershell"
    capture = tmp_path / "powershell-caps.txt"
    env = launcher_environment(tmp_path / "powershell", runtime, capture)
    env["MYCMUX_LAUNCHER_PATH"] = str(LAUNCHER_PS1)
    with CapabilityServer(runtime) as server:
        subprocess.run(
            [
                powershell,
                "-NoLogo",
                "-NoProfile",
                "-Command",
                ". $env:MYCMUX_LAUNCHER_PATH; claude; claude",
            ],
            env=env,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    assert_two_launches(server, capture)


def test_hook_identity_and_log_contracts_are_fixed_in_source() -> None:
    model = (REPO_ROOT / "src-tauri/src/agent_state/model.rs").read_text(encoding="utf-8")
    hook = (REPO_ROOT / "src-tauri/src/agent_state/hook.rs").read_text(encoding="utf-8")
    socket_rs = (REPO_ROOT / "src-tauri/src/socket.rs").read_text(encoding="utf-8")
    wire = (REPO_ROOT / "docs/plans/2026-08-30-agent-hook-wire-v1.md").read_text(
        encoding="utf-8"
    )

    launch_slot = model[model.index("pub(crate) struct LaunchSlot") :]
    launch_slot = launch_slot[: launch_slot.index("}")]
    assert "terminal_session_id" in launch_slot
    assert "pane_id" not in launch_slot
    assert 'current_launch: HashMap<(TerminalSessionId, Provider), LaunchId>' in hook
    assert 'match command {\n            "hook.health"' in hook
    assert '"hook.observe" => self.observe' in hook
    assert "classify_and_strip_credentials" in socket_rs
    assert 'command.starts_with("hook.")' in socket_rs
    assert "unauthorized" in wire
    assert "stale_launch" in wire
    assert "wrong_provider" in wire
    assert "queue_dropped" in wire
    assert "too_large" in wire
    assert "malformed" in wire

    for line in (hook + "\n" + socket_rs).splitlines():
        if "diag_" in line or "eprintln!" in line or "println!" in line:
            assert "hook_cap" not in line.lower()


def test_terminal_session_id_generation_lifetime_and_reuse_contract() -> None:
    constants = (REPO_ROOT / "src/lib/constants.ts").read_text(encoding="utf-8")
    layout_store = (REPO_ROOT / "src/stores/workspaceLayoutStore.ts").read_text(
        encoding="utf-8"
    )
    manager = (REPO_ROOT / "src-tauri/src/pty/manager.rs").read_text(
        encoding="utf-8"
    )

    assert "`${SESSION_ID_PREFIX}-${workspaceId}-${paneId}`" in constants
    assert "const tabId = options?.id ?? uuid();" in layout_store
    assert "makeSessionId(workspaceId, `${paneId}-${tabId}`)" in layout_store
    assert "if let Some(session) = sessions.get(&session_id)" in manager
    assert "sessions.insert(session_id, session);" in manager
    assert "existing_session_reattaches_without_spawning" in manager
    assert "missing_session_spawns_once_and_is_inserted" in manager

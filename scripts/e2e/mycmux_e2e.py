"""Drive a test build of mycmux through its socket (see src-tauri/src/e2e.rs).

The app under test is an `--features e2e` build whose frontend was bundled with
VITE_E2E=1, started with `--profile <name>` so it keeps its own runtime and
data directories. Nothing here touches the operator's live instance.

Stdlib only, so it runs with the system python3 on a Mac reached over SSH.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

SOCKET_TIMEOUT_SECONDS = 30.0


class E2eError(RuntimeError):
    pass


class App:
    """One test instance, addressed by its profile name."""

    def __init__(self, profile: str, bundle: Path | None = None):
        self.profile = profile
        self.bundle = bundle
        self.runtime_dir = Path.home() / f".mycmux-{profile}"

    # ── process ────────────────────────────────────────────────────────────
    @property
    def binary(self) -> Path:
        if self.bundle is None:
            raise E2eError("no app bundle given")
        return self.bundle / "Contents" / "MacOS" / "mycmux"

    def pids(self) -> list[int]:
        """Processes running this bundle's binary with this profile."""
        out = subprocess.run(
            ["pgrep", "-f", f"{self.binary} --profile {self.profile}"],
            capture_output=True,
            text=True,
        ).stdout
        return [int(line) for line in out.split() if line.strip()]

    def launch(self, *, background: bool = True, wait_seconds: float = 30.0) -> float:
        """Start the bundle through LaunchServices; return seconds until the socket answered."""
        if self.pids():
            raise E2eError(f"profile {self.profile} is already running: {self.pids()}")
        for stale in ("mycmux.port", "mycmux.token"):
            try:
                (self.runtime_dir / stale).unlink()
            except FileNotFoundError:
                pass
        args = ["open", "-n"]
        if background:
            args.append("-g")
        args += ["-a", str(self.bundle), "--args", "--profile", self.profile]
        started = time.monotonic()
        subprocess.run(args, check=True)
        self.wait_until(lambda: self._socket_ready(), wait_seconds, "socket to answer")
        return time.monotonic() - started

    def _socket_ready(self) -> bool:
        try:
            self.call("workspace.list", {}, timeout=3.0)
            return True
        except (E2eError, OSError):
            return False

    def wait_exit(self, timeout: float = 20.0) -> float:
        started = time.monotonic()
        self.wait_until(lambda: not self.pids(), timeout, "process to exit")
        return time.monotonic() - started

    def kill(self) -> None:
        for pid in self.pids():
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass

    # ── socket ─────────────────────────────────────────────────────────────
    def call(self, cmd: str, args: dict[str, Any] | None = None, timeout: float = SOCKET_TIMEOUT_SECONDS) -> Any:
        try:
            port = int((self.runtime_dir / "mycmux.port").read_text().strip())
            token = (self.runtime_dir / "mycmux.token").read_text().strip()
        except (OSError, ValueError) as exc:
            raise E2eError(f"no socket for profile {self.profile}: {exc}") from exc
        payload = {"cmd": cmd, "args": args or {}, "token": token}
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as conn:
            conn.settimeout(timeout)
            conn.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
            with conn.makefile("rb") as reader:
                line = reader.readline()
        if not line:
            raise E2eError(f"{cmd}: socket closed without a reply")
        reply = json.loads(line.decode("utf-8"))
        if reply.get("error") is not None:
            raise E2eError(f"{cmd}: {reply['error']}")
        return reply.get("result")

    # ── e2e commands ───────────────────────────────────────────────────────
    def windows(self) -> list[dict[str, Any]]:
        return self.call("e2e.windows")

    def window(self, label: str) -> dict[str, Any] | None:
        return next((row for row in self.windows() if row["label"] == label), None)

    def eval(self, script: str, label: str = "main", timeout_ms: int = 10_000) -> Any:
        return self.call("e2e.eval", {"label": label, "script": script, "timeout_ms": timeout_ms})

    def window_action(self, label: str, action: str) -> Any:
        return self.call("e2e.window", {"label": label, "action": action})

    def menu_key(self, key: str, modifiers: list[str], defer_ms: int = 0) -> Any:
        return self.call("e2e.menu_key", {"key": key, "modifiers": modifiers, "defer_ms": defer_ms})

    def terminate(self, defer_ms: int = 200) -> Any:
        return self.call("e2e.terminate", {"defer_ms": defer_ms})

    def dialogs(self) -> list[dict[str, Any]]:
        return self.call("e2e.dialog", {})["dialogs"]

    def click_dialog(self, title: str) -> Any:
        return self.call("e2e.dialog", {"click": title})

    def snapshot(self, path: Path, label: str = "main") -> Any:
        return self.call("e2e.snapshot", {"label": label, "path": str(path)})

    # ── app state helpers ──────────────────────────────────────────────────
    def workspaces(self, label: str = "main") -> list[dict[str, Any]]:
        return self.eval(
            """
            const s = window.__mycmuxE2E.stores.workspaceList.getState();
            return s.workspaces.map((w) => ({
              id: w.id, name: w.name,
              panes: w.panes.map((p) => ({
                id: p.id,
                tabs: p.tabs.map((t) => ({ id: t.id, type: t.type, sessionId: t.sessionId, label: t.label ?? null })),
              })),
            }));
            """,
            label=label,
        )

    def data_json(self) -> dict[str, Any]:
        path = (
            Path.home()
            / "Library/Application Support/com.miyazaki.mycmux.e2e/profiles"
            / self.profile
            / "data.json"
        )
        return json.loads(path.read_text(encoding="utf-8"))

    # ── waiting ────────────────────────────────────────────────────────────
    @staticmethod
    def wait_until(predicate: Callable[[], Any], timeout: float, what: str, interval: float = 0.05) -> Any:
        deadline = time.monotonic() + timeout
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                value = predicate()
                if value:
                    return value
            except Exception as exc:  # noqa: BLE001 - keep polling, report the last one
                last_error = exc
            time.sleep(interval)
        detail = f" (last error: {last_error})" if last_error else ""
        raise E2eError(f"timed out after {timeout:.1f}s waiting for {what}{detail}")


def log(event: str, **fields: Any) -> None:
    print(json.dumps({"t": round(time.time(), 3), "event": event, **fields}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    # Ad-hoc: python3 mycmux_e2e.py <profile> <cmd> '<json args>'
    profile, cmd = sys.argv[1], sys.argv[2]
    args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    print(json.dumps(App(profile).call(cmd, args), ensure_ascii=False, indent=1))

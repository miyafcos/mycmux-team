#!/usr/bin/env python3
"""Verify web automation on an already running mycmux test instance.

Have the parent operator start the test build with its isolated runtime directory,
then run:
    python scripts/verify_web_automation.py --runtime-dir <test-runtime-dir>

The directory must be the test instance's MYCMUX_RUNTIME_DIR and contain its
mycmux.port and mycmux.token. This script exports MYCMUX_RUNTIME_DIR only to CLI
children and clears the inherited pane anchor, so it cannot select a production
pane accidentally. It serves the fixture on 127.0.0.1, opens a background tab,
and never sends web.focus or starts/replaces the application.
Windows requires screenshot and all trusted checks; unsupported results fail.
Non-Windows may use --skip-screenshot and skips trusted checks. --keep-tab leaves
the test tab for inspection.
"""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import threading
import time
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "web-automation" / "index.html"
CLI = ROOT / "scripts" / "mycmux_agent_cli.py"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *args: Any) -> None:
        pass


def require(condition: Any, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def screenshot_result(action: Callable[[], Any], *, windows: bool, skip: bool) -> tuple[str, str]:
    if skip:
        return ("FAIL", "--skip-screenshot is not allowed on Windows") if windows else ("SKIP", "requested by --skip-screenshot")
    try:
        action()
        return "PASS", "PNG and dimensions"
    except Exception as error:
        message = str(error).replace("\n", " ")
        return ("SKIP" if not windows and "not supported" in message.lower() else "FAIL"), message


def trusted_checks(cli: Callable[..., Any], state: Callable[[], dict[str, Any]], fixture: Path) -> list[tuple[str, Callable[[], None]]]:
    expected_files = [{"name": fixture.name, "size": fixture.stat().st_size}]

    def click() -> None:
        before = state()
        cli("web-click", "--selector", "#counter", "--trusted")
        after = state()
        require(after["counter"] == before["counter"] + 1, "trusted click did not increment once")
        require(after["clicks"][len(before["clicks"]):] == [{"isTrusted": True}], "trusted click was not trusted")

    def upload() -> None:
        cli("web-eval", "--script", "document.getElementById('file-input').value = ''; window.__state.files = [];")
        result = cli("web-upload", "--selector", "#file-input", "--file", str(fixture), "--trusted")
        require(result["files"] == expected_files and state()["files"] == expected_files, "trusted upload name/size mismatch")

    def key() -> None:
        nodes = cli("web-find", "--selector", "#text-input")["nodes"]
        require(nodes and nodes[0].get("ref"), "no input ref for trusted key")
        before = len(state()["keys"])
        cli("web-key", "--ref", nodes[0]["ref"], "--key", "Enter", "--trusted")
        keys = state()["keys"][before:]
        require(any(item["key"] == "Enter" and item["isTrusted"] is True for item in keys), "trusted Enter was not recorded")

    def type_text() -> None:
        text = "Trusted input \u65e5\u672c\u8a9e \U0001f600"
        cli("web-type", "--selector", "#text-input", "--text", text, "--trusted")
        require(state()["text"] == text, "trusted input value mismatch")

    return [("trusted click", click), ("trusted upload", upload), ("trusted key", key), ("trusted type", type_text)]


def run_trusted_checks(cli: Callable[..., Any], state: Callable[[], dict[str, Any]], fixture: Path,
                       step: Callable[[str, Callable[[], Any]], Any], *, windows: bool) -> None:
    for name, action in trusted_checks(cli, state, fixture):
        if windows:
            step(name, action)
        else:
            print(f"SKIP {name}: non-Windows platform", flush=True)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Verify an already running test instance without taking focus.")
    parser.add_argument("--runtime-dir", type=Path, required=True)
    parser.add_argument("--keep-tab", action="store_true")
    parser.add_argument("--skip-screenshot", action="store_true")
    args = parser.parse_args()
    runtime = args.runtime_dir.expanduser().resolve()
    if not (runtime / "mycmux.port").is_file() or not (runtime / "mycmux.token").is_file():
        print("FAIL runtime: test runtime must contain mycmux.port and mycmux.token")
        return 1
    env = os.environ.copy()
    env["MYCMUX_RUNTIME_DIR"] = str(runtime)
    env["PYTHONIOENCODING"] = "utf-8"
    env.pop("MYCMUX_PANE_SESSION_ID", None)
    failures = 0
    tab_id: str | None = None

    def cli(*argv: str, target: bool = True) -> Any:
        command = [sys.executable, str(CLI), *argv]
        if target:
            require(tab_id, "no test tab")
            command += ["--tab", str(tab_id)]
        result = subprocess.run(command, env=env, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=40)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"CLI exit {result.returncode}")
        return json.loads(result.stdout)

    def step(name: str, action: Callable[[], Any]) -> Any:
        nonlocal failures
        try:
            value = action()
            print(f"PASS {name}", flush=True)
            return value
        except Exception as error:
            failures += 1
            print(f"FAIL {name}: {str(error).replace(chr(10), ' ')}", flush=True)
            return None

    def state() -> dict[str, Any]:
        return cli("web-eval", "--script", "return window.__state")["value"]

    def wait_load() -> None:
        result = cli("web-wait", "--state", "load")
        require(result["ready"], "load timed out")
        require(result["url"].startswith("http://127.0.0.1:"), "loaded URL is not the fixture")

    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(FIXTURE.parent)))
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/index.html"
    try:
        opened = step("open background browser", lambda: cli(
            "web-open", "--preset", "browser", "--url", url, "--background", target=False))
        if not isinstance(opened, dict) or not isinstance(opened.get("tabId"), str):
            return 1
        tab_id = opened["tabId"]
        step("background flag", lambda: require(opened.get("background") is True, "open was not background"))
        step("wait load", wait_load)

        refs: dict[str, str] = {}

        def snapshot() -> None:
            result = cli("web-snapshot", "--mode", "ax")
            for role, name in (("button", "Count"), ("textbox", "Text input"), ("link", "Fixture link")):
                match = next((n for n in result["nodes"] if n["role"] == role and n["name"] == name), None)
                require(match and match.get("ref"), f"missing ref for {role}: {name}")
                refs[name] = match["ref"]
        step("snapshot AX refs", snapshot)

        def click_counter() -> None:
            require("Count" in refs, "snapshot did not supply counter ref")
            cli("web-click", "--ref", refs["Count"])
            current = state()
            require(current["counter"] == 1, "counter did not increment exactly once")
            require(current["clicks"] == [{"isTrusted": False}], "JS click was not recorded as untrusted")
        step("click counter ref", click_counter)

        def type_text() -> None:
            text = "Web input \u65e5\u672c\u8a9e \U0001f600"
            cli("web-type", "--selector", "#text-input", "--text", text)
            require(state()["text"] == text, "input value mismatch")
        step("type input", type_text)

        def type_editable() -> None:
            cli("web-type", "--selector", "#editable", "--text", "Editable fixture")
            current = state()
            require(current["editable"] == "Editable fixture", "contenteditable mismatch")
            for kind in ("beforeinput", "input"):
                require(any(event["id"] == "editable" and event["kind"] == kind for event in current["inputs"]), f"missing editable {kind}")
        step("type contenteditable", type_editable)

        def enter() -> None:
            cli("web-key", "--key", "Enter")
            require(any(item["key"] == "Enter" for item in state()["keys"]), "Enter was not recorded")
        step("key Enter", enter)

        def scroll() -> None:
            result = cli("web-scroll", "--selector", "#scroller", "--delta-y", "200")
            require(result["scrollY"] > 0, "container did not scroll")
        step("scroll container", scroll)

        expected_files = [{"name": FIXTURE.name, "size": FIXTURE.stat().st_size}]

        def upload(drop: bool) -> None:
            selector = "#dropzone" if drop else "#file-input"
            options = ["web-upload", "--selector", selector, "--file", str(FIXTURE)]
            if drop:
                options.append("--drop")
            result = cli(*options)
            require(result["files"] == expected_files, "upload response name/size mismatch")
            current = state()
            require(current["drops" if drop else "files"] == expected_files, "page file name/size mismatch")
            if drop:
                require(current["dragEvents"] == ["dragenter", "dragover", "drop"], "drop event order mismatch")
        step("upload file input", lambda: upload(False))
        step("upload drop", lambda: upload(True))

        def find() -> None:
            result = cli("web-find", "--text", "Count", "--role", "button", "--exact")
            require(len(result["nodes"]) == 1 and result["nodes"][0]["ref"], "find result mismatch")
        step("find text", find)
        step("eval recorded state", lambda: require(state()["counter"] == 1 and state()["files"] == expected_files, "state mismatch"))
        run_trusted_checks(cli, state, FIXTURE, step, windows=sys.platform == "win32")

        def dialogs() -> None:
            cli("web-click", "--selector", "#alert-button")
            result = cli("web-dialogs")
            require(any(d["kind"] == "alert" and d["message"] == "Fixture alert" for d in result["dialogs"]), "alert was not recorded")
        step("dialogs alert", dialogs)
        step("navigate reload", lambda: require(cli("web-navigate", "--reload")["accepted"], "reload rejected"))
        step("wait reload", wait_load)
        step("click download", lambda: cli("web-click", "--selector", "#download-link"))

        def downloads() -> None:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                result = cli("web-downloads")
                for item in result["downloads"]:
                    if item["success"] and item["path"] and Path(item["path"]).is_file():
                        return
                time.sleep(0.25)
            raise RuntimeError("no successful download with an existing path")
        step("downloads success and path", downloads)

        def screenshot() -> None:
            result = cli("web-screenshot")
            path = Path(result["path"])
            require(path.is_file(), "screenshot file is missing")
            with path.open("rb") as stream:
                header = stream.read(24)
            require(header[:8] == b"\x89PNG\r\n\x1a\n" and header[12:16] == b"IHDR", "screenshot is not PNG")
            width, height = struct.unpack(">II", header[16:24])
            require(width > 0 and height > 0 and result["width"] > 0 and result["height"] > 0, "screenshot dimensions are empty")
        status, message = screenshot_result(screenshot, windows=sys.platform == "win32", skip=args.skip_screenshot)
        print(f"{status} screenshot: {message}", flush=True)
        if status == "FAIL":
            failures += 1
    finally:
        if tab_id:
            if args.keep_tab:
                print(f"SKIP close: --keep-tab {tab_id}", flush=True)
            else:
                step("close test tab", lambda: require(cli("web-close")["closed"], "close rejected"))
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

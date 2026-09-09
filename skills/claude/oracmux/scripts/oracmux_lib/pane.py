"""mycmux Web pane wrapper (web-open / web-list / web-read / web-push / web-close
through mycmux_agent_cli.py).

The pane is both the human's window and, since the `web.read` / background
tab work (feat/web-read, 2026-09-07), the engine oracmux talks to: a consult
opens a background Web tab in the caller's pane, pushes the brief with
submit, and polls `web.read` until the answer settles. No Chrome, no CDP.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import paths

MAX_TEXT_BYTES = 256 * 1024  # WEB_PANE_MAX_TEXT_BYTES in src-tauri/src/commands/webpane.rs
# web.upload reads every file into the page; the app rejects the batch above this
# (WEB_PANE_UPLOAD_LIMIT in src-tauri/src/commands/webpane.rs, 2026-09-09).
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
NO_MATCH_MARKERS = ("found no matching web tab",)
NOT_READY_MARKERS = ("web pane does not exist", "was not found", "timed out waiting for the composer", "has no known preset", "timed out waiting for the reader")
HOST_ERROR_MARKER = "composer host:"
# Identity providers a service redirects to when the pane is signed out
# (WEB_PANE_AUTH_HOSTS in src-tauri/src/commands/webpane.rs).
AUTH_HOSTS = ("accounts.google.com", "accounts.youtube.com", "appleid.apple.com", "login.microsoftonline.com", "login.live.com", "auth.openai.com", "auth0.openai.com", "x.com", "twitter.com")


class PaneError(RuntimeError):
    pass


class PaneUnavailable(PaneError):
    """mycmux socket unreachable (not running, wrong runtime dir, bad token)."""


def cli_path(cli: Path | None = None) -> str:
    return str(cli or paths.mycmux_cli())


def anchor_session() -> str | None:
    return os.environ.get("MYCMUX_PANE_SESSION_ID") or None


def build_list_command(cli: Path | None = None) -> list[str]:
    return [sys.executable, cli_path(cli), "web-list"]


def build_open_command(preset: str, *, url: str | None = None, background: bool = True, anchor: str | None = None, cli: Path | None = None) -> list[str]:
    command = [sys.executable, cli_path(cli), "web-open", "--preset", preset]
    if url:
        command.extend(["--url", url])
    if background:
        command.append("--background")
    if anchor:
        command.extend(["--anchor-session", anchor])
    return command


def build_read_command(*, tab: str | None = None, preset: str | None = None, cli: Path | None = None) -> list[str]:
    command = [sys.executable, cli_path(cli), "web-read"]
    if tab:
        command.extend(["--tab", tab])
    elif preset:
        command.extend(["--preset", preset])
    return command


def build_push_command(
    preset: str,
    text_file: Path,
    *,
    send: bool = False,
    tab: str | None = None,
    cli: Path | None = None,
) -> list[str]:
    command = [sys.executable, cli_path(cli), "web-push", "--text-file", str(text_file)]
    if tab:
        command.extend(["--tab", tab])
    else:
        command.extend(["--preset", preset])
    if send:
        command.append("--send")
    return command


def build_close_command(tab: str, cli: Path | None = None) -> list[str]:
    return [sys.executable, cli_path(cli), "web-close", "--tab", tab]


def build_eval_command(tab: str, script_file: Path, cli: Path | None = None) -> list[str]:
    return [sys.executable, cli_path(cli), "web-eval", "--tab", tab, "--script-file", str(script_file)]


def build_click_command(tab: str, selector: str, cli: Path | None = None) -> list[str]:
    return [sys.executable, cli_path(cli), "web-click", "--tab", tab, "--selector", selector]


def build_upload_command(tab: str, selector: str, files: list[Path], cli: Path | None = None) -> list[str]:
    command = [sys.executable, cli_path(cli), "web-upload", "--tab", tab, "--selector", selector]
    for path in files:
        command.extend(["--file", str(path)])
    return command


def check_upload_size(files: list[Path]) -> int:
    """The app rejects the whole batch above the limit, so fail before the round trip."""
    total = 0
    for path in files:
        try:
            total += path.stat().st_size
        except OSError as exc:
            raise ValueError(f"cannot read upload {path}: {exc}") from exc
    if total > MAX_UPLOAD_BYTES:
        raise ValueError(f"uploads total {total} bytes; the web pane accepts at most {MAX_UPLOAD_BYTES}")
    return total


def check_text_size(text: str) -> int:
    size = len(text.encode("utf-8"))
    if size > MAX_TEXT_BYTES:
        raise ValueError(f"brief is {size} bytes; the web pane accepts at most {MAX_TEXT_BYTES} bytes")
    return size


def _run(command: list[str], timeout: float = 90.0) -> Any:
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=dict(os.environ, PYTHONIOENCODING="utf-8"),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise PaneUnavailable(f"mycmux CLI could not run: {exc}") from exc
    output = (completed.stdout or "").strip()
    if completed.returncode != 0:
        message = (completed.stderr or output or f"exit {completed.returncode}").strip()[-600:]
        lowered = message.lower()
        if "socket request failed" in lowered or "cannot read mycmux port" in lowered or "unauthorized" in lowered:
            raise PaneUnavailable(message)
        raise PaneError(message)
    if not output:
        return None
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        return {"raw": output}


def web_list() -> list[dict[str, Any]]:
    result = _run(build_list_command())
    return result if isinstance(result, list) else []


def web_open(preset: str, *, url: str | None = None, background: bool = True, anchor: str | None = None) -> dict[str, Any]:
    result = _run(build_open_command(preset, url=url, background=background, anchor=anchor))
    if not isinstance(result, dict) or not isinstance(result.get("tabId"), str):
        raise PaneError(f"web-open returned no tabId: {result!r}")
    return result


def web_read(*, tab: str | None = None, preset: str | None = None) -> dict[str, Any]:
    result = _run(build_read_command(tab=tab, preset=preset))
    if not isinstance(result, dict):
        raise PaneError(f"web-read returned no object: {result!r}")
    return result


def web_push(*, preset: str, text_file: Path, send: bool = False, tab: str | None = None) -> Any:
    return _run(build_push_command(preset, text_file, send=send, tab=tab))


def web_close(tab: str) -> Any:
    return _run(build_close_command(tab))


def web_eval(tab: str, script: str) -> Any:
    """Run an async JS body in the pane and return its `value`. The script goes
    through a temp file so no shell quoting touches it."""
    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", newline="\n", delete=False) as handle:
        handle.write(script)
        script_file = Path(handle.name)
    try:
        result = _run(build_eval_command(tab, script_file))
    finally:
        script_file.unlink(missing_ok=True)
    return result.get("value") if isinstance(result, dict) else None


def web_click(tab: str, selector: str) -> Any:
    return _run(build_click_command(tab, selector))


def web_upload(tab: str, selector: str, files: list[Path]) -> Any:
    check_upload_size(files)
    return _run(build_upload_command(tab, selector, files), timeout=180.0)


def host_of_error(message: str) -> str | None:
    """`web pane is not on an allowed X composer host: <host>` -> host ("" while
    the hidden webview has not navigated yet); None for other errors."""
    if HOST_ERROR_MARKER not in message:
        return None
    return message.split(HOST_ERROR_MARKER, 1)[1].strip().strip(")")


def is_signed_out_host(message: str) -> bool:
    host = host_of_error(message)
    return bool(host) and any(host == auth or host.endswith("." + auth) for auth in AUTH_HOSTS)


def is_not_ready(message: str) -> bool:
    lowered = message.lower()
    if any(marker in lowered for marker in NOT_READY_MARKERS):
        return True
    host = host_of_error(message)
    # about:blank right after creation, or a redirect still in flight
    return host is not None and not is_signed_out_host(message)


def is_no_match(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in NO_MATCH_MARKERS)


def push(preset: str, text_file: Path, *, send: bool = False, tab: str | None = None) -> Any:
    """Human-facing push (the `push` command): needs a mycmux terminal so the
    tab lands next to the caller."""
    if not paths.in_mycmux():
        raise RuntimeError("push needs a mycmux terminal (MYCMUX_TERM_PROGRAM=mycmux); use `ask` or `oracle` elsewhere")
    return web_push(preset=preset, text_file=text_file, send=send, tab=tab)

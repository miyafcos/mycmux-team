"""steipete/oracle CLI wrapper — the ChatGPT lane.

Why keep oracle for ChatGPT instead of the CDP driver: oracle owns the
battle-tested ChatGPT specifics (model-selection evidence, session store,
duplicate-prompt guard, real file uploads, follow-ups, Deep Research toggle).
The CDP driver is the fallback when oracle hangs, and the only path for
Gemini / Grok.

Invocation goes through `node <oracle-cli.js>` — not `oracle.cmd` — so argv is
passed verbatim (cmd.exe mangles % and &) and the console code page never
touches the prompt. All paths are made absolute before they reach argv, so
the child's working directory is irrelevant (audit F-08).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import paths

INSTRUCTION = (
    "Read the attached brief.md first. It holds the question, context, constraints, "
    "the output contract and the inlined files. Answer exactly as the output contract "
    "in brief.md specifies (it states the language and the shape of the answer)."
)
REATTACH_RE = re.compile(r"oracle session\s+([A-Za-z0-9._-]+)")
EVIDENCE_RE = re.compile(r"Model selection evidence:\s*(.+)")
CONVERSATION_RE = re.compile(r"https://chatgpt\.com/c/[0-9A-Za-z:_-]+")

STATUS_OK = "ok"
STATUS_FAILED = "failed"
STATUS_TIMEOUT = "timeout"
STATUS_BUSY = "busy"
STATUS_NEEDS_HUMAN = "needs_human"
STATUS_PRECONDITION = "precondition"

# Substrings oracle prints for conditions oracmux must not treat as a UI failure.
BUSY_MARKERS = ("already running", "is already running", "Duplicate prompt")
HUMAN_MARKERS = ("manual login", "not signed in", "sign in", "log in", "login required", "captcha", "challenge", "Weekly limit", "Add credits")
TIMEOUT_MARKERS = ("did not appear", "timed out", "before timeout", "Timeout")
PRECONDITION_MARKERS = ("Could not connect", "connection refused", "ECONNREFUSED", "No Chrome", "DevTools", "attach")

POLL_SEC = 5.0
PROGRESS_EVERY_SEC = 30.0


@dataclass
class OracleResult:
    status: str
    returncode: int | None
    session_slug: str = ""
    evidence: str = ""
    conversation_url: str = ""
    stdout_tail: str = ""
    error: str = ""
    command: list[str] = field(default_factory=list)


def node_executable() -> str:
    found = shutil.which("node")
    if found:
        return found
    candidate = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "node.exe"
    return str(candidate)


def build_command(
    brief_path: Path,
    out_path: Path,
    slug: str,
    *,
    uploads: list[Path] | tuple[Path, ...] = (),
    research: bool = False,
    timeout: str = "auto",
    model: str | None = None,
    node: str | None = None,
    cli_js: Path | None = None,
) -> list[str]:
    command = [
        node or node_executable(),
        str((cli_js or paths.oracle_cli_js())),
        "--engine",
        "browser",
        "-p",
        INSTRUCTION,
        "-f",
        str(Path(brief_path).resolve()),
    ]
    for upload in uploads:
        command.extend(["-f", str(Path(upload).resolve())])
    # brief.md alone is pasted inline (the reliable path); real uploads only
    # when the caller attached binaries such as PDFs.
    command.extend(["--browser-attachments", "always" if uploads else "never"])
    command.extend(["--write-output", str(Path(out_path).resolve()), "--slug", slug, "--no-notify", "--timeout", timeout])
    if research:
        command.extend(["--browser-research", "deep"])
    if model:
        command.extend(["-m", model])
    return command


def parse_output(stdout: str) -> dict[str, str]:
    info: dict[str, str] = {"session_slug": "", "evidence": "", "conversation_url": ""}
    match = REATTACH_RE.search(stdout)
    if match:
        info["session_slug"] = match.group(1)
    match = EVIDENCE_RE.search(stdout)
    if match:
        info["evidence"] = match.group(1).strip()
    match = CONVERSATION_RE.search(stdout)
    if match:
        info["conversation_url"] = match.group(0)
    return info


def classify(stdout: str, returncode: int | None, timed_out: bool) -> tuple[str, str]:
    """Map oracle's outcome onto oracmux statuses (audit F-11)."""
    lowered = stdout.casefold()
    if timed_out:
        return STATUS_TIMEOUT, "oracle did not finish in time; do not re-run, reattach or collect"
    if returncode == 0:
        return STATUS_OK, ""
    if any(marker.casefold() in lowered for marker in BUSY_MARKERS):
        return STATUS_BUSY, "oracle refused: the same prompt is already running (zombie session? quarantine ~/.oracle/sessions/<slug>)"
    if any(marker.casefold() in lowered for marker in HUMAN_MARKERS):
        return STATUS_NEEDS_HUMAN, "oracle reports a login / captcha / usage-limit condition"
    if any(marker.casefold() in lowered for marker in TIMEOUT_MARKERS):
        return STATUS_TIMEOUT, "oracle gave up waiting for ChatGPT (prompt or answer did not appear)"
    if any(marker.casefold() in lowered for marker in PRECONDITION_MARKERS):
        return STATUS_PRECONDITION, "oracle could not reach Chrome (CDP attach failed)"
    return STATUS_FAILED, f"oracle exited {returncode}"


def run(
    command: list[str],
    timeout_sec: float,
    log: Callable[[str], None],
    *,
    log_path: Path | None = None,
    progress: Callable[[float, int], None] | None = None,
) -> OracleResult:
    """Run oracle to completion, streaming its output to `log_path` (so a hung
    child never deadlocks on a full pipe), reporting elapsed seconds and the
    output file size through `progress` every PROGRESS_EVERY_SEC (audit F-56).
    On timeout the child is killed; the caller reattaches or collects."""
    log("oracle: " + subprocess.list2cmdline(command[:6]) + " ...")
    env = dict(os.environ)
    env.pop("OPENAI_API_KEY", None)  # an API key silently flips oracle into the paid API engine
    env["PYTHONIOENCODING"] = "utf-8"
    sink_path = log_path or Path(os.environ.get("TEMP", ".")) / f"oracmux-oracle-{os.getpid()}.log"
    started = time.monotonic()
    timed_out = False
    try:
        with sink_path.open("wb") as sink:
            process = subprocess.Popen(command, stdout=sink, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env)
            last_report = started
            while True:
                code = process.poll()
                if code is not None:
                    break
                now = time.monotonic()
                if now - started >= timeout_sec:
                    timed_out = True
                    process.kill()
                    process.wait(timeout=30)
                    break
                if progress and now - last_report >= PROGRESS_EVERY_SEC:
                    try:
                        size = sink_path.stat().st_size
                    except OSError:
                        size = 0
                    progress(now - started, size)
                    last_report = now
                time.sleep(POLL_SEC)
    except OSError as exc:
        return OracleResult(status=STATUS_PRECONDITION, returncode=None, error=f"oracle could not start: {exc}", command=command)
    try:
        stdout = sink_path.read_bytes().decode("utf-8", errors="replace")
    except OSError:
        stdout = ""
    info = parse_output(stdout)
    returncode = None if timed_out else process.returncode
    status, error = classify(stdout, returncode, timed_out)
    return OracleResult(
        status=status,
        returncode=returncode,
        stdout_tail=stdout[-1500:],
        error=error,
        command=command,
        **info,
    )


def session_meta(slug: str) -> dict[str, object]:
    path = paths.oracle_sessions_dir() / slug / "meta.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def session_conversation_url(slug: str) -> str:
    meta = session_meta(slug)
    browser = meta.get("browser") if isinstance(meta.get("browser"), dict) else {}
    for section in ("harvest", "runtime"):
        part = browser.get(section) if isinstance(browser, dict) else None
        if isinstance(part, dict):
            for key in ("url", "tabUrl"):
                value = part.get(key)
                if isinstance(value, str):
                    match = CONVERSATION_RE.search(value)
                    if match:
                        return match.group(0)
    return ""
